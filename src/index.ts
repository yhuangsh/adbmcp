#!/usr/bin/env node
/**
 * adbmcp entrypoint. stdio remains the default transport: the client launches the
 * server as a subprocess (design §5). `--http` opts into Streamable HTTP on /mcp for
 * shared-device-host deployments; the bin entry and stdio behavior are unchanged.
 *
 * stdout carries MCP protocol traffic only in stdio mode; diagnostics go to stderr.
 */
import { parseArgs } from 'node:util';

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import type { HttpConfigOverrides } from './http.js';
import { createContext, createServer, readVersion } from './server.js';

interface CliOptions {
  http: boolean;
  overrides: HttpConfigOverrides;
}

function parsePortFlag(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`--port must be an integer between 0 and 65535, received "${value}".`);
  }
  return parsed;
}

function parseCli(argv: string[] = process.argv.slice(2)): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      http: { type: 'boolean', default: false },
      port: { type: 'string' },
      host: { type: 'string' },
    },
    strict: true,
    allowPositionals: true, // unknown positionals are ignored; unknown flags still fail fast
  });
  const overrides: HttpConfigOverrides = {};
  if (values.port !== undefined) overrides.port = parsePortFlag(values.port);
  if (values.host !== undefined) overrides.host = values.host;
  return { http: values.http, overrides };
}

async function runHttp(ctx: ReturnType<typeof createContext>, overrides: HttpConfigOverrides): Promise<void> {
  // Load the HTTP transport (and its SDK dependencies) only when --http is used.
  const { resolveHttpConfig, startHttpServer } = await import('./http.js');
  const config = resolveHttpConfig(process.env, overrides);
  const http = await startHttpServer(ctx, config);
  const shutdown = (signal: string): void => {
    process.stderr.write(`adbmcp: received ${signal}, closing HTTP sessions and logcat streams.\n`);
    void http.close().finally(() => {
      ctx.streams.closeAll();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.stderr.write(
    `adbmcp ${readVersion()} HTTP transport on ${http.url}, auth: ${
      config.token !== null ? 'token' : 'none (loopback only)'
    }.\n`,
  );
}

async function main(): Promise<void> {
  const cli = parseCli();
  const ctx = createContext();
  if (cli.http) {
    await runHttp(ctx, cli.overrides);
    return;
  }

  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  const shutdown = (signal: string): void => {
    process.stderr.write(`adbmcp: received ${signal}, stopping logcat streams and exiting.\n`);
    ctx.streams.closeAll();
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await server.connect(transport);
  process.stderr.write(
    `adbmcp ${readVersion()} ready (adb: ${ctx.config.adbPath}, allowed devices: ${
      ctx.config.allowedDevices?.join(', ') ?? 'all'
    }).\n`,
  );
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `adbmcp failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
