import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { guard, textResult } from './common.js';

const DEVICE_ARG = z
  .string()
  .optional()
  .describe('Device serial from list_devices; optional when exactly one device is connected.');

/** adb forward spec prefixes, see `adb forward --help`. */
const PORT_SPEC = /^(tcp|localabstract|localreserved|localfilesystem|dev|jdwp|vsock|acceptfd)(:|$)/;

function assertPortSpec(value: string, name: string): void {
  if (!PORT_SPEC.test(value)) {
    throw new Error(
      `${name}="${value}" is not a valid adb port spec. Use a spec such as "tcp:8080", "localabstract:name", "jdwp:1234" or "dev:/dev/block/…".`,
    );
  }
}

export function registerForwardTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'forward_port',
    {
      title: 'Forward a host port to the device',
      description:
        'Create a port forward from the host to the device (`adb forward`), e.g. local "tcp:8080" to remote "tcp:8080". Use it to reach a device-side server (app HTTP server, debug port) from host-only test tooling.',
      inputSchema: {
        local: z.string().min(1).describe('Host-side spec, e.g. "tcp:8080".'),
        remote: z.string().min(1).describe('Device-side spec, e.g. "tcp:8080" or "localabstract:webview_devtools_remote".'),
        no_rebind: z.boolean().optional().describe('Pass --no-rebind to fail instead of replacing an existing forward (default false).'),
        device: DEVICE_ARG,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      await guard(async () => {
        assertPortSpec(args.local, 'local');
        assertPortSpec(args.remote, 'remote');
        const serial = await ctx.devices.resolve(args.device);
        const argv = ['forward'];
        if (args.no_rebind) argv.push('--no-rebind');
        argv.push(args.local, args.remote);
        const result = await ctx.runner.runChecked(argv, { serial, operation: 'forward_port' });
        const detail = result.stdout.trim();
        return textResult(
          `Forwarded ${args.local} -> ${args.remote} on ${serial}.${detail ? `\n${detail}` : ''}`,
        );
      }),
  );

  server.registerTool(
    'remove_forward',
    {
      title: 'Remove a port forward',
      description: 'Remove a port forward created with forward_port (`adb forward --remove <local>`).',
      inputSchema: {
        local: z.string().min(1).describe('Host-side spec previously forwarded, e.g. "tcp:8080".'),
        device: DEVICE_ARG,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      await guard(async () => {
        assertPortSpec(args.local, 'local');
        const serial = await ctx.devices.resolve(args.device);
        await ctx.runner.runChecked(['forward', '--remove', args.local], {
          serial,
          operation: 'remove_forward',
        });
        return textResult(`Removed forward ${args.local} on ${serial}.`);
      }),
  );
}
