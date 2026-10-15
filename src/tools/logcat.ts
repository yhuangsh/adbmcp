import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { truncateLines } from '../util/output.js';
import { guard, textResult } from './common.js';

const DEVICE_ARG = z
  .string()
  .optional()
  .describe('Device serial from list_devices; optional when exactly one device is connected.');

const FILTER_SPEC_ARG = z
  .string()
  .optional()
  .describe(
    'logcat filter spec, e.g. "AndroidRuntime:E *:S" or "ActivityManager:I *:S". Space separated, passed to adb logcat as-is.',
  );

const DEFAULT_SNAPSHOT_LINES = 200;
const MAX_SNAPSHOT_LINES = 5_000;

function formatStreamStatus(read: {
  stream_id: string;
  running: boolean;
  exit_code: number | null;
  buffered_bytes: number;
  dropped_bytes: number;
  stderr: string;
}): string {
  const state = read.running ? 'running' : `exited (code ${read.exit_code ?? 'unknown'})`;
  const parts = [
    `stream ${read.stream_id}: ${state}`,
    `buffered_bytes=${read.buffered_bytes}`,
    `dropped_bytes=${read.dropped_bytes}`,
  ];
  if (read.stderr.length > 0) parts.push(`stderr: ${read.stderr}`);
  return parts.join(', ');
}

export function registerLogcatTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'logcat_snapshot',
    {
      title: 'Read a logcat snapshot',
      description:
        'Dump the current logcat buffer (`adb logcat -d`) from one device, optionally filtered to a log tag. Bounded output; use the stream tools when you need to watch logs over time.',
      inputSchema: {
        filter_spec: FILTER_SPEC_ARG,
        max_lines: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Maximum lines to return, most recent kept (default ${DEFAULT_SNAPSHOT_LINES}, max ${MAX_SNAPSHOT_LINES}).`),
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
        const tokens = args.filter_spec?.trim() ? args.filter_spec.trim().split(/\s+/) : [];
        const result = await ctx.runner.runChecked(
          ['logcat', '-d', '-v', ctx.config.logcat.format, ...tokens],
          {
            serial,
            operation: 'logcat_snapshot',
            timeoutMs: args.timeout_ms ?? ctx.config.limits.defaultTimeoutMs,
            maxBytes: ctx.config.limits.maxOutputBytes,
          },
        );
        const maxLines = Math.min(args.max_lines ?? DEFAULT_SNAPSHOT_LINES, MAX_SNAPSHOT_LINES);
        const bounded = truncateLines(result.stdout.trimEnd(), maxLines, 'tail');
        const body = bounded.text.length > 0 ? bounded.text : '(logcat buffer is empty)';
        return textResult(`${body}\n---\ndevice: ${serial}, filter: ${args.filter_spec ?? 'none'}`);
      }),
  );

  server.registerTool(
    'start_logcat_stream',
    {
      title: 'Start a logcat stream',
      description:
        'Start a long-lived `adb logcat` process on one device and return a stream_id. Poll it with read_logcat_stream and release it with stop_logcat_stream. Streams are killed when the server shuts down.',
      inputSchema: {
        filter_spec: FILTER_SPEC_ARG,
        device: DEVICE_ARG,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      await guard(async () => {
        const serial = await ctx.devices.resolve(args.device);
        const started = await ctx.streams.start({
          serial,
          ...(args.filter_spec !== undefined ? { filterSpec: args.filter_spec } : {}),
        });
        return textResult(JSON.stringify(started, null, 2));
      }),
  );

  server.registerTool(
    'read_logcat_stream',
    {
      title: 'Read a logcat stream',
      description:
        'Return buffered logcat output accumulated since the previous read of this stream. Output is capped per call; anything not returned stays buffered for the next read. Dropped bytes are reported when the ring buffer overflowed.',
      inputSchema: {
        stream_id: z.string().min(1).describe('stream_id returned by start_logcat_stream.'),
        max_bytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum bytes to return in this call (default 65536).'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      await guard(async () => {
        const read = ctx.streams.read(args.stream_id, {
          ...(args.max_bytes !== undefined ? { maxBytes: args.max_bytes } : {}),
        });
        const body = read.text.length > 0 ? read.text.trimEnd() : '(no new logcat output)';
        return textResult(`${body}\n---\n${formatStreamStatus(read)}`);
      }),
  );

  server.registerTool(
    'stop_logcat_stream',
    {
      title: 'Stop a logcat stream',
      description:
        'Terminate a logcat stream and forget its stream_id. Up to max_bytes of output buffered but not yet read is returned in this result; any excess is discarded and reported.',
      inputSchema: {
        stream_id: z.string().min(1).describe('stream_id returned by start_logcat_stream.'),
        max_bytes: z.number().int().positive().optional().describe('Maximum buffered bytes to return (default 65536).'),
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
        const stopped = ctx.streams.stop(args.stream_id, {
          ...(args.max_bytes !== undefined ? { maxBytes: args.max_bytes } : {}),
        });
        const tail =
          stopped.remaining_text.length > 0
            ? `\n\nUnread output before stopping:\n${stopped.remaining_text.trimEnd()}`
            : '';
        const discarded =
          stopped.remaining_bytes > 0
            ? `\n\nWarning: ${stopped.remaining_bytes} more buffered bytes were discarded because they did not fit in max_bytes. The stream is already removed, so pass a larger max_bytes next time before stopping to retrieve them.`
            : '';
        return textResult(
          `Stream ${stopped.stream_id} stopped (dropped_bytes=${stopped.dropped_bytes}).${tail}${discarded}`,
        );
      }),
  );
}
