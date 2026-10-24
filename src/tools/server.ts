import type { McpServer } from '@modelcontextprotocol/server';

import { formatDeviceList } from '../devices.js';
import type { ServerContext } from '../context.js';
import { guard, textResult } from './common.js';

/**
 * `adb_server_restart` — explicit recovery tool for the shared adb server
 * (design §4.1, §8): adbmcp never restarts or kills the server on its own.
 */
export function registerServerTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'adb_server_restart',
    {
      title: 'Restart the adb server',
      description:
        'Recover from adb server version conflicts by running `adb kill-server` followed by `adb start-server`, then report the device list. Affects the shared adb server on this host (Android Studio and other tools use it too), so call it only when adb reports a server/version problem or a device is stuck.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async () =>
      await guard(async () => {
        const kill = await ctx.runner.runChecked(['kill-server'], {
          operation: 'adb_server_restart',
          timeoutMs: ctx.config.limits.defaultTimeoutMs,
        });
        const start = await ctx.runner.run(['start-server'], {
          operation: 'adb_server_restart',
          timeoutMs: 60_000,
        });
        const details = [kill.stdout, kill.stderr, start.stdout, start.stderr]
          .map((text) => text.trim())
          .filter((text) => text.length > 0)
          .join('\n');
        const status = start.exitCode === 0 ? 'adb server restarted.' : `adb start-server exited with ${start.exitCode}.`;

        let devices: string;
        try {
          devices = formatDeviceList(await ctx.devices.list(), ctx.config.allowedDevices);
        } catch (error) {
          devices = `Device list unavailable after restart: ${error instanceof Error ? error.message : String(error)}`;
        }
        return textResult([status, details, devices].filter((line) => line.length > 0).join('\n\n'));
      }),
  );
}
