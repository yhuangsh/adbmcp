import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { ServerContext } from '../context.js';
import { formatDeviceList } from '../devices.js';

/** Live device list as a resource, so clients can refresh device state cheaply (design §4.1). */
export function registerDeviceResource(server: McpServer, ctx: ServerContext): void {
  server.registerResource(
    'devices',
    'adb://devices',
    {
      title: 'Connected Android devices',
      description:
        'Live list of devices/emulators known to adb (serial, state, model, transport id), including whether ADBMCP_ALLOWED_DEVICES permits each serial. Re-read to refresh: device state is never cached.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const entries = await ctx.devices.list();
      const payload = {
        devices: entries.map((entry) => ({
          serial: entry.serial,
          state: entry.state,
          model: entry.model ?? null,
          product: entry.product ?? null,
          device: entry.device ?? null,
          transport_id: entry.transportId ?? null,
          allowed: entry.allowed,
        })),
        allowed_devices: ctx.config.allowedDevices,
        summary: formatDeviceList(entries, ctx.config.allowedDevices).split('\n').at(-1) ?? '',
      };
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    },
  );
}
