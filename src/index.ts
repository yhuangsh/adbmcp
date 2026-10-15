#!/usr/bin/env node
/**
 * adbmcp entrypoint: serves the tool/resource/prompt layers over stdio
 * (design §5 — stdio is the only MVP transport).
 *
 * stdout carries MCP protocol traffic only; diagnostics go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createContext, createServer, readVersion } from './server.js';

async function main(): Promise<void> {
  const ctx = createContext();
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
