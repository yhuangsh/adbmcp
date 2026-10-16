import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { capText, guard, textResult } from './common.js';

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

interface ForwardEntry {
  serial: string;
  local: string;
  remote: string;
}

interface ReverseEntry {
  serial: string;
  remote: string;
  local: string;
}

/** Lines of `adb forward --list` / `adb reverse --list` split into tokens. */
function specListLines(stdout: string): string[][] {
  return stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((tokens) => tokens[0] !== undefined && tokens[0] !== '' && tokens[1] !== undefined);
}

/**
 * Parse `adb forward --list` output: "<serial> <local> <remote>" per line. The
 * call is scoped with -s, so the resolved serial is authoritative when a line
 * omits the serial (2-token form on some adb versions).
 */
function parseForwardList(stdout: string, serial: string): ForwardEntry[] {
  const entries: ForwardEntry[] = [];
  for (const tokens of specListLines(stdout)) {
    const offset = tokens.length >= 3 ? 1 : 0;
    const local = tokens[offset];
    const remote = tokens[offset + 1];
    if (local === undefined || remote === undefined) continue;
    entries.push({ serial, local, remote });
  }
  return entries;
}

/**
 * Parse `adb reverse --list` output: "<remote> <local>" per line after the
 * leading column (adb prints the transport name there, e.g. "UsbFfs", not the
 * serial), so entries report the resolved serial.
 */
function parseReverseList(stdout: string, serial: string): ReverseEntry[] {
  const entries: ReverseEntry[] = [];
  for (const tokens of specListLines(stdout)) {
    const offset = tokens.length >= 3 ? 1 : 0;
    const remote = tokens[offset];
    const local = tokens[offset + 1];
    if (remote === undefined || local === undefined) continue;
    entries.push({ serial, remote, local });
  }
  return entries;
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

  server.registerTool(
    'reverse_port',
    {
      title: 'Reverse a device port to the host',
      description:
        'Create a reverse socket connection (`adb reverse`): the device listens on the remote spec and connections are forwarded to the local spec on the host machine. Use it to let device-side code (app under test, on-device scripts) reach a server running on your machine.',
      inputSchema: {
        remote: z.string().min(1).describe('Device-side listen spec, e.g. "tcp:8080".'),
        local: z.string().min(1).describe('Host-side target spec, e.g. "tcp:8080".'),
        no_rebind: z.boolean().optional().describe('Pass --no-rebind to fail instead of replacing an existing reverse (default false).'),
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
        assertPortSpec(args.remote, 'remote');
        assertPortSpec(args.local, 'local');
        const serial = await ctx.devices.resolve(args.device);
        const argv = ['reverse'];
        if (args.no_rebind) argv.push('--no-rebind');
        argv.push(args.remote, args.local);
        const result = await ctx.runner.runChecked(argv, { serial, operation: 'reverse_port' });
        const detail = result.stdout.trim();
        return textResult(
          `Reversed ${args.remote} -> ${args.local} on ${serial}.${detail ? `\n${detail}` : ''}`,
        );
      }),
  );

  server.registerTool(
    'remove_reverse',
    {
      title: 'Remove a reverse port forward',
      description: 'Remove a reverse socket connection created with reverse_port (`adb reverse --remove <remote>`).',
      inputSchema: {
        remote: z.string().min(1).describe('Device-side spec previously passed to reverse_port, e.g. "tcp:8080".'),
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
        assertPortSpec(args.remote, 'remote');
        const serial = await ctx.devices.resolve(args.device);
        await ctx.runner.runChecked(['reverse', '--remove', args.remote], {
          serial,
          operation: 'remove_reverse',
        });
        return textResult(`Removed reverse ${args.remote} on ${serial}.`);
      }),
  );

  server.registerTool(
    'list_forwards',
    {
      title: 'List port forwards',
      description:
        'List the forward socket connections of one device (`adb forward --list`) as a JSON array of {serial, local, remote} objects (empty array when there are none).',
      inputSchema: { device: DEVICE_ARG },
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
        const result = await ctx.runner.runChecked(['forward', '--list'], {
          serial,
          operation: 'list_forwards',
          timeoutMs: ctx.config.limits.defaultTimeoutMs,
          maxBytes: ctx.config.limits.maxOutputBytes,
        });
        return textResult(
          capText(
            JSON.stringify(parseForwardList(result.stdout, serial), null, 2),
            ctx.config.limits.maxOutputBytes,
          ),
        );
      }),
  );

  server.registerTool(
    'list_reverses',
    {
      title: 'List reverse port forwards',
      description:
        'List the reverse socket connections of one device (`adb reverse --list`) as a JSON array of {serial, remote, local} objects (empty array when there are none). remote is the device-side listen spec, local the host-side target.',
      inputSchema: { device: DEVICE_ARG },
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
        const result = await ctx.runner.runChecked(['reverse', '--list'], {
          serial,
          operation: 'list_reverses',
          timeoutMs: ctx.config.limits.defaultTimeoutMs,
          maxBytes: ctx.config.limits.maxOutputBytes,
        });
        return textResult(
          capText(
            JSON.stringify(parseReverseList(result.stdout, serial), null, 2),
            ctx.config.limits.maxOutputBytes,
          ),
        );
      }),
  );
}
