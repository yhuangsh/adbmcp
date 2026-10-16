import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { AdbError, mapAdbFailure } from '../adb/errors.js';
import type { ServerContext } from '../context.js';
import { guard, textResult } from './common.js';

/** `adb connect` / `adb disconnect` targets: hostname or IPv4 plus a TCP port. */
const HOST_PORT = /^([A-Za-z0-9][A-Za-z0-9.-]*):(\d{1,5})$/;

/**
 * adb reports `connect` failures such as "failed to connect ...: Connection
 * refused" with exit code 0, so the output has to be inspected too.
 */
const CONNECT_FAILURE =
  /(?:failed|unable|cannot)\s+to\s+connect|connection refused|unknown host|no route to host/i;

function assertHostPort(value: string): void {
  const match = HOST_PORT.exec(value.trim());
  const port = match ? Number.parseInt(match[2] ?? '', 10) : Number.NaN;
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `address="${value}" is not a valid "host:port" target. Use the address shown under Settings > Developer options > Wireless debugging, e.g. "192.168.1.42:5555".`,
    );
  }
}

const PAIRING_HINT =
  'Android 11+ Wireless debugging requires pairing first (Wireless pairing > Pair device with pairing code); wireless_pair is planned but not shipped yet. On Android 10 and below, enable adb over TCP with "adb tcpip 5555" and connect to port 5555.';

export function registerWirelessTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'connect',
    {
      title: 'Connect to a device over TCP/IP',
      description:
        'Connect adb to a device over TCP/IP (`adb connect <host>:<port>`), e.g. "192.168.1.42:5555"; a successful connect adds the device to list_devices. Not device-scoped: the address selects the device, and no serial exists until the connection is established. On Android 10+ enable Wireless debugging on the device first; Android 11+ wireless debugging also requires a pairing step, so that flow needs wireless_pair (planned, not yet shipped).',
      inputSchema: {
        address: z
          .string()
          .min(1)
          .describe('Device TCP address as "host:port", e.g. "192.168.1.42:5555" (the port is shown in the Wireless debugging settings).'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      await guard(async () => {
        assertHostPort(args.address);
        const address = args.address.trim();
        const result = await ctx.runner.run(['connect', address], {
          operation: 'connect',
          timeoutMs: ctx.config.limits.defaultTimeoutMs,
          maxBytes: ctx.config.limits.maxOutputBytes,
        });
        const output = `${result.stdout}\n${result.stderr}`.trim();
        if (result.exitCode !== 0) {
          throw mapAdbFailure(result, { operation: 'connect' });
        }
        if (CONNECT_FAILURE.test(output)) {
          throw new AdbError({
            cause: 'COMMAND_FAILED',
            message: `adb connect ${address} failed: ${output.split('\n')[0] ?? output}`,
            hint: PAIRING_HINT,
            stderr: result.stderr,
            exitCode: result.exitCode,
          });
        }
        return textResult(output.length > 0 ? output : `Connected to ${address}.`);
      }),
  );

  server.registerTool(
    'disconnect',
    {
      title: 'Disconnect TCP/IP devices',
      description:
        'Disconnect one TCP/IP-connected device (`adb disconnect <host>:<port>`) or, when address is omitted, every TCP/IP-connected device (`adb disconnect`). USB connections are unaffected. Not device-scoped: for a TCP/IP device the address itself is the serial.',
      inputSchema: {
        address: z
          .string()
          .min(1)
          .optional()
          .describe('TCP address "host:port" to disconnect; omit to disconnect every TCP/IP device.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      await guard(async () => {
        if (args.address !== undefined) assertHostPort(args.address);
        const address = args.address?.trim();
        const result = await ctx.runner.runChecked(
          address !== undefined ? ['disconnect', address] : ['disconnect'],
          {
            operation: 'disconnect',
            timeoutMs: ctx.config.limits.defaultTimeoutMs,
            maxBytes: ctx.config.limits.maxOutputBytes,
          },
        );
        const output = result.stdout.trim();
        if (output.length > 0) return textResult(output);
        return textResult(
          address !== undefined ? `Disconnected ${address}.` : 'Disconnected all TCP/IP devices.',
        );
      }),
  );
}
