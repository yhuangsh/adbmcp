import { request as httpRequest } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertHttpBindAllowed,
  buildAllowedHosts,
  MAX_HTTP_BODY_BYTES,
  resolveHttpConfig,
  startHttpServer,
  type HttpServerHandle,
  type HttpTransportConfig,
} from '../src/http.js';
import {
  createHarness,
  devicesHandler,
  ONE_DEVICE_LONG,
  type TestHarness,
} from './helpers/fakes.js';

interface RpcBody {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface RpcOutcome {
  status: number;
  sessionId: string | null;
  body: RpcBody;
}

const servers: HttpServerHandle[] = [];
let nextRequestId = 1;

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

function makeHarness(): TestHarness {
  return createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) });
}

async function start(
  harness: TestHarness = makeHarness(),
  config: Partial<HttpTransportConfig> = {},
): Promise<HttpServerHandle> {
  const server = await startHttpServer(harness.ctx, {
    host: '127.0.0.1',
    port: 0,
    token: null,
    allowedHosts: null,
    ...config,
  });
  servers.push(server);
  return server;
}

async function readRpcResponse(response: Response): Promise<RpcOutcome> {
  const sessionId = response.headers.get('mcp-session-id');
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  let body: RpcBody;
  if (contentType.includes('text/event-stream')) {
    const data = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line.length > 0);
    body = JSON.parse(data.at(-1) ?? '{}') as RpcBody;
  } else {
    body = text.length > 0 ? (JSON.parse(text) as RpcBody) : {};
  }
  return { status: response.status, sessionId, body };
}

function initializeMessage(): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: nextRequestId++,
    method: 'initialize',
    params: {
      // Pinned to the 2025-era revision: this suite asserts stateful HTTP sessions
      // (Mcp-Session-Id, DELETE semantics); adopting 2026-07-28 is a separate work order.
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'adbmcp-http-test', version: '1.0.0' },
    },
  };
}

async function postRpc(
  url: string,
  message: Record<string, unknown>,
  options: { sessionId?: string; token?: string } = {},
): Promise<RpcOutcome> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(options.sessionId !== undefined ? { 'Mcp-Session-Id': options.sessionId } : {}),
      ...(options.token !== undefined ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify(message),
  });
  return await readRpcResponse(response);
}

async function initialize(url: string, token?: string): Promise<{ sessionId: string; body: RpcBody }> {
  const outcome = await postRpc(url, initializeMessage(), token !== undefined ? { token } : {});
  expect(outcome.status).toBe(200);
  expect(outcome.sessionId).toBeTruthy();
  return { sessionId: outcome.sessionId as string, body: outcome.body };
}

async function callTool(
  url: string,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  token?: string,
): Promise<RpcOutcome> {
  return await postRpc(
    url,
    { jsonrpc: '2.0', id: nextRequestId++, method: 'tools/call', params: { name, arguments: args } },
    { sessionId, ...(token !== undefined ? { token } : {}) },
  );
}

function toolsOf(outcome: RpcOutcome): unknown[] {
  return (outcome.body.result as { tools?: unknown[] } | undefined)?.tools ?? [];
}

function textOf(outcome: RpcOutcome): string {
  const content = (outcome.body.result as { content?: Array<{ type: string; text?: string }> } | undefined)
    ?.content ?? [];
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

/** POST with an explicit Host header, which fetch/undici does not allow overriding. */
function rawPostWithHost(url: string, host: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          Host: host,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

describe('HTTP transport sessions', () => {
  it('initializes a session, lists 35 tools and calls list_devices over HTTP', async () => {
    const harness = makeHarness();
    const server = await start(harness);

    const first = await initialize(server.url);
    expect((first.body.result as { serverInfo?: { name?: string } }).serverInfo?.name).toBe('adbmcp');

    const tools = await postRpc(server.url, { jsonrpc: '2.0', id: nextRequestId++, method: 'tools/list', params: {} }, { sessionId: first.sessionId });
    expect(tools.status).toBe(200);
    expect(toolsOf(tools)).toHaveLength(35);

    const devices = await callTool(server.url, first.sessionId, 'list_devices', {});
    expect(devices.status).toBe(200);
    expect(textOf(devices)).toContain('emulator-5554');
    expect(harness.runner.commands()).toContain('devices -l');
  });

  it('creates distinct sessions and rejects a session id after DELETE', async () => {
    const server = await start();
    const first = await initialize(server.url);
    const second = await initialize(server.url);
    expect(first.sessionId).not.toBe(second.sessionId);

    // Both sessions register the full tool surface against the same context.
    for (const sessionId of [first.sessionId, second.sessionId]) {
      const tools = await postRpc(
        server.url,
        { jsonrpc: '2.0', id: nextRequestId++, method: 'tools/list', params: {} },
        { sessionId },
      );
      expect(toolsOf(tools)).toHaveLength(35);
    }

    const deleted = await fetch(server.url, {
      method: 'DELETE',
      headers: { 'Mcp-Session-Id': first.sessionId },
    });
    expect(deleted.status).toBe(200);

    const stale = await postRpc(
      server.url,
      { jsonrpc: '2.0', id: nextRequestId++, method: 'tools/list', params: {} },
      { sessionId: first.sessionId },
    );
    expect(stale.status).toBe(404);
    expect(stale.body.error).toMatchObject({ code: -32001, message: 'Session not found' });

    const stillAlive = await postRpc(
      server.url,
      { jsonrpc: '2.0', id: nextRequestId++, method: 'tools/list', params: {} },
      { sessionId: second.sessionId },
    );
    expect(stillAlive.status).toBe(200);
    expect(toolsOf(stillAlive)).toHaveLength(35);
  });

  it('shares device and stream context across sessions (one device host)', async () => {
    const harness = makeHarness();
    const server = await start(harness);
    const first = await initialize(server.url);
    const second = await initialize(server.url);

    const started = await callTool(server.url, first.sessionId, 'start_logcat_stream', {});
    const startedBody = JSON.parse(textOf(started)) as { stream_id: string };
    expect(startedBody.stream_id).toBeTruthy();

    harness.streamSpawner.last.emitStdout('shared-context-line\n');
    const read = await callTool(server.url, second.sessionId, 'read_logcat_stream', {
      stream_id: startedBody.stream_id,
    });
    expect(textOf(read)).toContain('shared-context-line');

    const stopped = await callTool(server.url, second.sessionId, 'stop_logcat_stream', {
      stream_id: startedBody.stream_id,
    });
    expect(textOf(stopped)).toContain(`Stream ${startedBody.stream_id} stopped`);
  });

  it('ends an open GET SSE stream when the server closes', async () => {
    const server = await start();
    const { sessionId } = await initialize(server.url);
    const controller = new AbortController();
    const stream = await fetch(server.url, {
      headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': sessionId },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    const body = stream.text();

    await server.close();
    await expect(body).resolves.toBeTypeOf('string');
    controller.abort();
  });
});

describe('HTTP transport security', () => {
  it('requires the bearer token before any SDK handling when configured', async () => {
    const server = await start(makeHarness(), { token: 's3cret' });

    const missing = await postRpc(server.url, initializeMessage());
    expect(missing.status).toBe(401);
    expect(missing.sessionId).toBeNull();
    expect(missing.body.error?.code).toBe(-32001);

    const wrong = await postRpc(server.url, initializeMessage(), { token: 'wrong' });
    expect(wrong.status).toBe(401);

    const good = await initialize(server.url, 's3cret');

    const deleteWithoutToken = await fetch(server.url, {
      method: 'DELETE',
      headers: { 'Mcp-Session-Id': good.sessionId },
    });
    expect(deleteWithoutToken.status).toBe(401);

    const deleteWithToken = await fetch(server.url, {
      method: 'DELETE',
      headers: { 'Mcp-Session-Id': good.sessionId, Authorization: 'Bearer s3cret' },
    });
    expect(deleteWithToken.status).toBe(200);
  });

  it('refuses to bind a non-loopback host without a token', () => {
    expect(() => assertHttpBindAllowed({ host: '0.0.0.0', token: null })).toThrow(/ADBMCP_HTTP_TOKEN/);
    expect(() => assertHttpBindAllowed({ host: '192.168.1.10', token: null })).toThrow(/non-loopback/);
    expect(() => assertHttpBindAllowed({ host: '127.0.0.1', token: null })).not.toThrow();
    expect(() => assertHttpBindAllowed({ host: 'localhost', token: null })).not.toThrow();
    expect(() => assertHttpBindAllowed({ host: '0.0.0.0', token: 'secret' })).not.toThrow();
  });

  it('resolves env values and lets CLI flags override them', () => {
    expect(resolveHttpConfig({})).toEqual({
      host: '127.0.0.1',
      port: 3331,
      token: null,
      allowedHosts: null,
    });
    expect(() => resolveHttpConfig({ ADBMCP_HTTP_PORT: 'not-a-port' })).toThrow(/ADBMCP_HTTP_PORT/);

    const fromEnv = resolveHttpConfig({
      ADBMCP_HTTP_PORT: '4444',
      ADBMCP_HTTP_HOST: '0.0.0.0',
      ADBMCP_HTTP_TOKEN: 'secret',
      ADBMCP_HTTP_ALLOWED_HOSTS: 'mcp.example:4444, localhost:4444',
    });
    expect(fromEnv).toEqual({
      host: '0.0.0.0',
      port: 4444,
      token: 'secret',
      allowedHosts: ['mcp.example:4444', 'localhost:4444'],
    });

    const overridden = resolveHttpConfig(
      { ADBMCP_HTTP_PORT: '4444', ADBMCP_HTTP_HOST: '0.0.0.0' },
      { port: 0, host: '127.0.0.1' },
    );
    expect(overridden.host).toBe('127.0.0.1');
    expect(overridden.port).toBe(0);
    expect(overridden.token).toBeNull();
  });

  it('derives the DNS-rebinding Host allowlist and honors the env override', () => {
    const config = resolveHttpConfig({}, { host: '127.0.0.1', port: 3331 });
    const allowed = buildAllowedHosts(config, 3331);
    expect(allowed).toContain('127.0.0.1:3331');
    expect(allowed).toContain('localhost:3331');
    expect(allowed).toContain('[::1]:3331');

    expect(buildAllowedHosts({ ...config, allowedHosts: ['mcp.example:443'] }, 3331)).toEqual([
      'mcp.example:443',
    ]);
  });

  it('rejects an unexpected Host header (DNS rebinding protection)', async () => {
    const server = await start();
    const status = await rawPostWithHost(server.url, 'evil.example', JSON.stringify(initializeMessage()));
    expect(status).toBe(403);
  });

  it('rejects unknown paths, unsupported methods and oversized bodies', async () => {
    const server = await start();

    const wrongPath = await fetch(server.url.replace('/mcp', '/not-mcp'));
    expect(wrongPath.status).toBe(404);

    const wrongMethod = await fetch(server.url, { method: 'PUT' });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET, POST, DELETE');

    // The SDK owns Accept/Content-Type negotiation; the node:http layer only caps size.
    const nonJson = await fetch(server.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(initializeMessage()),
    });
    expect(nonJson.status).toBe(415);

    const oversized = await fetch(server.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: 'x'.repeat(MAX_HTTP_BODY_BYTES + 1),
    });
    expect(oversized.status).toBe(413);
  });
});
