import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { quoteForDeviceShell } from '../util/shell.js';
import { guard, textResult } from './common.js';

const DEVICE_ARG = z
  .string()
  .optional()
  .describe('Device serial from list_devices; optional when exactly one device is connected.');

/** Curated services: a bare `dumpsys` dumps everything, these four answer the common questions. */
const DUMPSYS_SERVICES = ['battery', 'activity', 'window', 'connectivity'] as const;

/**
 * `dumpsys activity` (and friends) can emit megabytes. Cap tighter than the
 * generic output budget; the runner keeps head+tail and marks the dropped bytes.
 */
export const DUMPSYS_MAX_BYTES = 64 * 1024;

export function registerDumpsysTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'dumpsys_query',
    {
      title: 'Query a dumpsys service',
      description:
        'Read a curated Android system service dump (`dumpsys <service> [args...]`): "battery" for charge/level, "activity" for tasks and activities, "window" for windows and display state, "connectivity" for network state. Output can be huge — "activity" especially — so it is capped (64 KB maximum) with a head+tail truncation marker where bytes were dropped; pass extra_args to narrow it (e.g. "activities" or "windows"). Other dumpsys services are intentionally not exposed; use shell for those.',
      inputSchema: {
        service: z
          .enum(DUMPSYS_SERVICES)
          .describe('Curated service to dump: "battery", "activity", "window" or "connectivity".'),
        extra_args: z
          .string()
          .optional()
          .describe('Optional arguments appended after the service, e.g. "activities com.example.app" or "windows"; token-split on whitespace and quoted for the device shell.'),
        device: DEVICE_ARG,
        timeout_ms: z.number().int().positive().optional().describe('Timeout in milliseconds (default 30000).'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      await guard(async () => {
        const serial = await ctx.devices.resolve(args.device);
        const tokens = args.extra_args?.trim() ? args.extra_args.trim().split(/\s+/) : [];
        const command = ['dumpsys', args.service, ...tokens].map(quoteForDeviceShell).join(' ');
        const result = await ctx.runner.runChecked(['shell', command], {
          serial,
          operation: 'dumpsys_query',
          timeoutMs: args.timeout_ms ?? ctx.config.limits.defaultTimeoutMs,
          maxBytes: Math.min(ctx.config.limits.maxOutputBytes, DUMPSYS_MAX_BYTES),
        });
        const body = result.stdout.trimEnd();
        return textResult(body.length > 0 ? body : `dumpsys ${args.service} on ${serial} returned no output.`);
      }),
  );
}
