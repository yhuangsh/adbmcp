import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { guard } from './common.js';

/** Screenshots are binary; allow a generous cap but still bound memory. */
export const SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024;

export function registerScreenshotTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'screenshot',
    {
      title: 'Capture a screenshot',
      description:
        'Capture the current screen of one device (`exec-out screencap -p`) and return it as a PNG image. Follow up with get_ui_hierarchy when you need element coordinates instead of pixels.',
      inputSchema: {
        device: z
          .string()
          .optional()
          .describe('Device serial from list_devices; optional when exactly one device is connected.'),
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
        const result = await ctx.runner.runBinary(['exec-out', 'screencap', '-p'], {
          serial,
          operation: 'screenshot',
          timeoutMs: ctx.config.limits.defaultTimeoutMs,
          maxBytes: SCREENSHOT_MAX_BYTES,
        });
        if (result.stdout.byteLength === 0) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `[COMMAND_FAILED] screencap on ${serial} returned no data. The device may be locked, in a secure window, or still booting — check list_devices and try again.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'image' as const,
              data: result.stdout.toString('base64'),
              mimeType: 'image/png',
            },
          ],
        };
      }),
  );
}
