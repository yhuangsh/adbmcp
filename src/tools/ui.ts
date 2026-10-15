import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { capText, guard, textResult } from './common.js';

/** Dump target on the device; reused between calls so nothing accumulates. */
export const UI_DUMP_PATH = '/sdcard/window_dump.xml';

export function registerUiTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'get_ui_hierarchy',
    {
      title: 'Get the UI hierarchy',
      description:
        'Dump the current view hierarchy of one device as uiautomator XML (`uiautomator dump`), including bounds, resource ids, text and clickability. Use it to find stable selectors before driving the UI through shell (input tap/text).',
      inputSchema: {
        device: z
          .string()
          .optional()
          .describe('Device serial from list_devices; optional when exactly one device is connected.'),
        timeout_ms: z.number().int().positive().optional().describe('Timeout in milliseconds for the dump (default 30000).'),
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
        const timeoutMs = args.timeout_ms ?? ctx.config.limits.defaultTimeoutMs;
        await ctx.runner.runChecked(['shell', 'uiautomator', 'dump', UI_DUMP_PATH], {
          serial,
          operation: 'get_ui_hierarchy',
          timeoutMs,
          maxBytes: ctx.config.limits.maxOutputBytes,
        });
        // exec-out avoids the CRLF translation that `shell cat` introduces.
        const result = await ctx.runner.runChecked(['exec-out', 'cat', UI_DUMP_PATH], {
          serial,
          operation: 'get_ui_hierarchy',
          timeoutMs,
          maxBytes: ctx.config.limits.maxOutputBytes,
        });
        const xml = result.stdout.trim();
        if (xml.length === 0) {
          return textResult(
            `uiautomator produced an empty hierarchy on ${serial}. The screen may be off, animating, or showing a secure window — wake and retry.`,
          );
        }
        return textResult(capText(xml, ctx.config.limits.maxOutputBytes));
      }),
  );
}
