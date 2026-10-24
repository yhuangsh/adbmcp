import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { AdbError, mapAdbFailure } from '../adb/errors.js';
import type { ServerContext } from '../context.js';
import { guard, textResult } from './common.js';

/** Hostname or IPv4 address (no port), as shown in the Wireless debugging settings. */
const HOST_PATTERN = '[A-Za-z0-9][A-Za-z0-9.-]*';
const HOST = new RegExp(`^${HOST_PATTERN}$`);
/** `adb connect` / `adb disconnect` targets: hostname or IPv4 plus a TCP port. */
const HOST_PORT = new RegExp(`^(${HOST_PATTERN}):(\\d{1,5})$`);

/**
 * adb reports `connect` failures such as "failed to connect ...: Connection
 * refused" with exit code 0, so the output has to be inspected too.
 */
const CONNECT_FAILURE =
  /(?:failed|unable|cannot)\s+to\s+connect|connection refused|unknown host|no route to host/i;

/** adb pair also prints failure prose on exit 0, e.g. "Failed to pair to …". */
const PAIR_FAILURE = /(?:failed|unable)\s+to\s+pair|\berror\b/i;

/**
 * `adb disconnect <addr>` prints "error: no such device '<addr>'" when the
 * target is not an active TCP/IP transport. Keep the sniff narrow: success
 * output is only "disconnected <addr>" or "disconnected everything".
 */
const DISCONNECT_FAILURE = /no such device\b/i;

function assertHost(value: string): void {
  if (!HOST.test(value.trim())) {
    throw new Error(
      `host="${value}" is not a valid hostname or IPv4 address. Use the address shown under Settings > Developer options > Wireless debugging, e.g. "192.168.1.42".`,
    );
  }
}

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
  'Android 11+ Wireless debugging requires pairing first: get the code from Wireless debugging > "Pair device with pairing code" and call wireless_pair, then connect to the port shown on the main Wireless debugging screen (the pairing port and the connect port are different). On Android 10 and below, enable adb over TCP with "adb tcpip 5555" and connect to port 5555.';

/** Pairing code shown by Android: six digits, optionally with one hyphen, e.g. "123-456". */
const PAIR_CODE = /^\d{3}-?\d{3}$/;

/** Strip the optional hyphen so adb receives the six digits. */
function assertPairingCode(value: string): string {
  const code = value.trim();
  if (!PAIR_CODE.test(code)) {
    throw new Error(
      `code="${value}" is not a valid pairing code. Android shows a six-digit code (an optional single hyphen is fine, e.g. "123-456") next to "Pair device with pairing code" in the Wireless debugging settings.`,
    );
  }
  return code.replace('-', '');
}

export function registerWirelessTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'connect',
    {
      title: 'Connect to a device over TCP/IP',
      description:
        'Connect adb to a device over TCP/IP (`adb connect <host>:<port>`), e.g. "192.168.1.42:5555"; a successful connect adds the device to list_devices. Not device-scoped: the address selects the device, and no serial exists until the connection is established. IPv6 literals (e.g. "[::1]:5555") and a bare host without :port are not accepted; specify host:port explicitly. On Android 10+ enable Wireless debugging on the device first; on Android 11+ that also needs a one-time pairing first — call wireless_pair with the code from the Wireless debugging screen, then connect to the port shown there (the pairing port and this connect port are different).',
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
        const result = await ctx.runner.run(
          address !== undefined ? ['disconnect', address] : ['disconnect'],
          {
            operation: 'disconnect',
            timeoutMs: ctx.config.limits.defaultTimeoutMs,
            maxBytes: ctx.config.limits.maxOutputBytes,
          },
        );
        const combined = `${result.stdout}\n${result.stderr}`.trim();
        // Some adb builds exit 0 for a failed address-targeted disconnect, so
        // sniff the prose before treating the command as successful.
        if (address !== undefined && DISCONNECT_FAILURE.test(combined)) {
          throw new AdbError({
            cause: 'COMMAND_FAILED',
            message: `adb disconnect ${address} failed: ${combined.split('\n')[0] ?? combined}`,
            hint: 'That address is not an active TCP/IP connection. Check list_devices for connected serials, verify host:port, or omit the address to disconnect every TCP/IP device.',
            stderr: result.stderr,
            exitCode: result.exitCode,
          });
        }
        if (result.exitCode !== 0) {
          throw mapAdbFailure(result, { operation: 'disconnect' });
        }
        const output = result.stdout.trim();
        if (output.length > 0) return textResult(output);
        return textResult(
          address !== undefined ? `Disconnected ${address}.` : 'Disconnected all TCP/IP devices.',
        );
      }),
  );

  server.registerTool(
    'wireless_pair',
    {
      title: 'Pair a device for wireless debugging',
      description:
        'Pair with an Android 11+ device for wireless debugging (`adb pair <host>:<pair_port> <code>`), using the pairing code from Settings > Developer options > Wireless debugging > "Pair device with pairing code". This is step one of a two-step flow: after "Successfully paired", call connect with the same host and the port shown on the main Wireless debugging screen — the temporary pairing port above is not that connect port. Pairing codes expire after a couple of minutes, so ask the user for a fresh code if this fails.',
      inputSchema: {
        host: z
          .string()
          .min(1)
          .describe('Hostname or IP shown in the Wireless debugging settings, e.g. "192.168.1.42" (no port).'),
        pair_port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .describe('Pairing port shown on the Wireless debugging pairing dialog — different from the port used by connect.'),
        code: z
          .string()
          .min(1)
          .describe('Six-digit pairing code from the pairing dialog; an optional single hyphen is accepted, e.g. "123-456".'),
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
        assertHost(args.host);
        const code = assertPairingCode(args.code);
        const target = `${args.host.trim()}:${args.pair_port}`;
        const result = await ctx.runner.run(['pair', target, code], {
          operation: 'wireless_pair',
          timeoutMs: ctx.config.limits.defaultTimeoutMs,
          maxBytes: ctx.config.limits.maxOutputBytes,
        });
        const output = `${result.stdout}\n${result.stderr}`.trim();
        if (result.exitCode !== 0) {
          throw mapAdbFailure(result, { operation: 'wireless_pair' });
        }
        if (PAIR_FAILURE.test(output)) {
          throw new AdbError({
            cause: 'COMMAND_FAILED',
            message: `adb pair ${target} failed: ${output.split('\n')[0] ?? output}`,
            hint: 'Pairing codes expire after a couple of minutes and the pairing port is temporary: reopen Wireless debugging > "Pair device with pairing code" for a fresh code and port, make sure both devices are on the same network, then retry. Pairing is not the same as connecting — call connect with the device\'s main debug port afterwards.',
            stderr: result.stderr,
            exitCode: result.exitCode,
          });
        }
        return textResult(output.length > 0 ? output : `Paired with ${target}.`);
      }),
  );
}
