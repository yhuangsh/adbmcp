/**
 * Optional Streamable HTTP transport (design §5, v0.5.0).
 *
 * Stateful mode: every MCP session gets its own McpServer + StreamableHTTPServerTransport,
 * while all sessions share one ServerContext (config, runner, device manager, stream
 * registry). This is the shared-device-host / emulator-farm model: many agents connect
 * to one device host and one ADBMCP_ALLOWED_DEVICES allowlist.
 *
 * Concurrency: AdbRunner spawns one subprocess per call, so overlapping calls from
 * different sessions are safe. StreamRegistry ids increment in a single-threaded event
 * loop and its stream map is shared deliberately: a stream started in one session can be
 * read or stopped from another. Sessions are therefore the same trust domain, not a
 * security boundary between agents — use the bearer token and device allowlist for that.
 *
 * stdio remains the default transport; this module is only loaded when --http is set.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { isInitializeRequest, type McpServer } from '@modelcontextprotocol/server';

import type { ServerContext } from './context.js';
import { createServer as createMcpServer } from './server.js';

export const DEFAULT_HTTP_PORT = 3331;
export const DEFAULT_HTTP_HOST = '127.0.0.1';
/** POST bodies larger than this are rejected with 413 before JSON parsing. */
export const MAX_HTTP_BODY_BYTES = 1024 * 1024;

export const MCP_HTTP_PATH = '/mcp';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export interface HttpTransportConfig {
  host: string;
  port: number;
  /** Bearer token from ADBMCP_HTTP_TOKEN; null disables auth (loopback binds only). */
  token: string | null;
  /**
   * ADBMCP_HTTP_ALLOWED_HOSTS override: exact Host header values (host[:port]).
   * Null derives the allowlist from the bound host + loopback forms.
   */
  allowedHosts: string[] | null;
}

export interface HttpConfigOverrides {
  host?: string;
  port?: number;
}

export interface HttpServerHandle {
  /** e.g. http://127.0.0.1:3331/mcp, using the real port when port 0 was requested. */
  readonly url: string;
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

function parsePort(value: string, source: string): number {
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`${source} must be an integer between 0 and 65535, received "${value}".`);
  }
  return parsed;
}

function parseHostList(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : null;
}

/** Flags override environment variables; defaults are loopback-only. */
export function resolveHttpConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: HttpConfigOverrides = {},
): HttpTransportConfig {
  const envPort = env['ADBMCP_HTTP_PORT'];
  const port =
    overrides.port !== undefined
      ? parsePort(String(overrides.port), '--port')
      : envPort === undefined || envPort.trim() === ''
        ? DEFAULT_HTTP_PORT
        : parsePort(envPort, 'ADBMCP_HTTP_PORT');
  const envHost = env['ADBMCP_HTTP_HOST'];
  const host = overrides.host ?? (envHost !== undefined && envHost.trim() !== '' ? envHost.trim() : DEFAULT_HTTP_HOST);
  const rawToken = env['ADBMCP_HTTP_TOKEN'];
  const token = rawToken !== undefined && rawToken.trim() !== '' ? rawToken.trim() : null;
  return { host, port, token, allowedHosts: parseHostList(env['ADBMCP_HTTP_ALLOWED_HOSTS']) };
}

function bareHost(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** Host header / URL form: IPv6 literals are bracketed. */
function hostHeaderName(host: string): string {
  const bare = bareHost(host);
  return bare.includes(':') ? `[${bare}]` : bare;
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(bareHost(host).toLowerCase());
}

/**
 * Binding a non-loopback interface without a token would expose device control to the
 * network. Refuse at startup instead of silently accepting the risk.
 */
export function assertHttpBindAllowed(config: Pick<HttpTransportConfig, 'host' | 'token'>): void {
  if (config.token !== null) return;
  if (isLoopbackHost(config.host)) return;
  throw new Error(
    `Refusing to bind the HTTP transport to non-loopback host "${config.host}" without authentication. ` +
      'Set ADBMCP_HTTP_TOKEN to a secret and send it as "Authorization: Bearer <token>", ' +
      'or bind the default 127.0.0.1.',
  );
}

/**
 * Host header values accepted by DNS-rebinding protection. The override replaces the
 * derived list; otherwise allow the bound host plus loopback aliases on the actual port.
 */
export function buildAllowedHosts(config: HttpTransportConfig, port: number): string[] {
  if (config.allowedHosts !== null && config.allowedHosts.length > 0) return [...config.allowedHosts];
  const allowed = new Set<string>();
  for (const host of [config.host, 'localhost', '127.0.0.1', '::1']) {
    const name = hostHeaderName(host);
    allowed.add(`${name}:${port}`);
    allowed.add(name);
  }
  return [...allowed];
}

class BodyTooLargeError extends Error {}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function tokensEqual(provided: string, expected: string): boolean {
  // Hash first so timingSafeEqual always gets equal-length inputs (it throws otherwise).
  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

function isAuthorized(req: IncomingMessage, token: string | null): boolean {
  if (token === null) return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match !== null && tokensEqual(match[1] ?? '', token);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declaredLength = req.headers['content-length'];
  if (declaredLength !== undefined) {
    const declared = Number(declaredLength);
    if (Number.isFinite(declared) && declared > limit) {
      return Promise.reject(new BodyTooLargeError());
    }
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.byteLength;
      if (total > limit) {
        settled = true;
        reject(new BodyTooLargeError());
        return; // keep draining so the 413 response can be written
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    req.on('aborted', () => {
      if (settled) return;
      settled = true;
      reject(new Error('Request aborted'));
    });
  });
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

interface HttpSession {
  transport: NodeStreamableHTTPServerTransport;
  server: McpServer;
}

function readPath(req: IncomingMessage): string | null {
  try {
    return new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    return null;
  }
}

/**
 * Start the HTTP server. Resolves after the socket is listening, so tests can request
 * port 0 and smoke scripts can print the real port.
 */
export async function startHttpServer(
  ctx: ServerContext,
  config: HttpTransportConfig,
): Promise<HttpServerHandle> {
  assertHttpBindAllowed(config);

  const sessions = new Map<string, HttpSession>();
  let allowedHosts: string[] = [];
  let closePromise: Promise<void> | null = null;

  const httpServer: Server = createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`adbmcp: HTTP request failed: ${detail}\n`);
      try {
        if (!res.headersSent) {
          sendJsonRpcError(res, 500, -32603, 'Internal server error');
        } else {
          res.destroy();
        }
      } catch {
        res.destroy();
      }
    });
  });

  const createSession = (): HttpSession => {
    const server = createMcpServer(ctx);
    let transport!: NodeStreamableHTTPServerTransport;
    transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, server });
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
      },
      // enableDnsRebindingProtection/allowedHosts are deprecated in SDK v2 but still
      // enforced; swapping them for hostHeaderValidation middleware ships with the
      // 2026-07-28 protocol-adoption work order, not this package migration.
      enableDnsRebindingProtection: true,
      allowedHosts,
      maxRequestBodySize: MAX_HTTP_BODY_BYTES,
    });
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId !== undefined && sessions.get(sessionId)?.transport === transport) {
        sessions.delete(sessionId);
      }
    };
    transport.onerror = (error) => {
      process.stderr.write(`adbmcp: HTTP transport error: ${error.message}\n`);
    };
    return { transport, server };
  };

  async function readJsonBody(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<{ value: unknown } | undefined> {
    let body: Buffer;
    try {
      body = await readBody(req, MAX_HTTP_BODY_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        req.resume();
        sendJsonRpcError(res, 413, -32000, `Request body exceeds ${MAX_HTTP_BODY_BYTES} bytes`, {
          Connection: 'close',
        });
        return undefined;
      }
      throw error;
    }
    try {
      return { value: JSON.parse(body.toString('utf8')) as unknown };
    } catch {
      sendJsonRpcError(res, 400, -32700, 'Parse error: Invalid JSON');
      return undefined;
    }
  }

  async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = headerValue(req, 'mcp-session-id');
    const existing = sessionId !== undefined ? sessions.get(sessionId) : undefined;
    if (sessionId !== undefined && existing === undefined) {
      req.resume();
      sendJsonRpcError(res, 404, -32001, 'Session not found');
      return;
    }

    const parsedBody = await readJsonBody(req, res);
    if (parsedBody === undefined) return;

    if (existing !== undefined) {
      await existing.transport.handleRequest(req, res, parsedBody.value);
      return;
    }

    // No session header: only an initialize request may create one (SDK stateful shape).
    if (!isInitializeRequest(parsedBody.value)) {
      sendJsonRpcError(res, 400, -32000, 'Bad Request: No valid session ID provided');
      return;
    }

    const session = createSession();
    try {
      await session.server.connect(session.transport);
      await session.transport.handleRequest(req, res, parsedBody.value);
    } finally {
      if (session.transport.sessionId === undefined) {
        // Rejected initialize (bad headers/host): don't leak a server for a session
        // that was never established.
        await session.server.close().catch(() => undefined);
      }
    }
  }

  async function handleGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = headerValue(req, 'mcp-session-id');
    if (sessionId === undefined) {
      sendJsonRpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required');
      return;
    }
    const session = sessions.get(sessionId);
    if (session === undefined) {
      sendJsonRpcError(res, 404, -32001, 'Session not found');
      return;
    }
    await session.transport.handleRequest(req, res);
  }

  async function handleDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = headerValue(req, 'mcp-session-id');
    if (sessionId === undefined) {
      sendJsonRpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required');
      return;
    }
    const session = sessions.get(sessionId);
    if (session === undefined) {
      sendJsonRpcError(res, 404, -32001, 'Session not found');
      return;
    }
    await session.transport.handleRequest(req, res);
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (readPath(req) !== MCP_HTTP_PATH) {
      sendJsonRpcError(res, 404, -32000, 'Not Found');
      return;
    }
    if (!isAuthorized(req, config.token)) {
      sendJsonRpcError(res, 401, -32001, 'Unauthorized: a valid bearer token is required', {
        'WWW-Authenticate': 'Bearer realm="adbmcp"',
      });
      return;
    }
    switch (req.method) {
      case 'POST':
        await handlePost(req, res);
        break;
      case 'GET':
        await handleGet(req, res);
        break;
      case 'DELETE':
        await handleDelete(req, res);
        break;
      default:
        sendJsonRpcError(res, 405, -32000, `Method ${req.method ?? 'unknown'} not allowed`, {
          Allow: 'GET, POST, DELETE',
        });
    }
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const actualPort = address !== null && typeof address === 'object' ? address.port : config.port;
  allowedHosts = buildAllowedHosts(config, actualPort);
  const url = `http://${hostHeaderName(config.host)}:${actualPort}${MCP_HTTP_PATH}`;

  return {
    url,
    host: config.host,
    port: actualPort,
    close(): Promise<void> {
      if (closePromise !== null) return closePromise;
      closePromise = (async () => {
        const serverClosed = new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
        });
        const transports = [...sessions.values()].map(({ transport }) => transport.close());
        sessions.clear();
        await Promise.allSettled(transports);
        // SSE streams were just closed; drop idle keep-alive sockets so close() resolves.
        httpServer.closeIdleConnections?.();
        await serverClosed;
      })();
      return closePromise;
    },
  };
}
