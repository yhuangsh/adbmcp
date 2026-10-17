import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { AdbError } from '../adb/errors.js';
import type { ServerContext } from '../context.js';
import { quoteForDeviceShell } from '../util/shell.js';
import { capText, guard, textResult } from './common.js';

/** Dump target on the device; reused between calls so nothing accumulates. */
export const UI_DUMP_PATH = '/sdcard/window_dump.xml';

/** Prefix for `to_file` dumps: timestamped, so files accumulate until the consumer removes them. */
export const UI_FILE_DUMP_PREFIX = '/data/local/tmp/adbmcp-ui-';

/** Disambiguates dumps from concurrent calls that land in the same millisecond (shared HTTP context). */
let uiDumpSequence = 0;

/**
 * `uiautomator dump` reports success with a "UI hierchary dumped to: <path>"
 * line on older builds (including the historical misspelling) and prints a
 * corrected "hierarchy" spelling on newer ones; some builds print nothing on
 * success. Anything else is a failure even when the exit code is 0.
 */
function dumpReportedFailure(output: string): boolean {
  if (output.length === 0) return false;
  return !/dumped to/i.test(output) || /\b(error|failed|could not|unable)\b/i.test(output);
}

export function registerUiTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'get_ui_hierarchy',
    {
      title: 'Get the UI hierarchy',
      description:
        'Dump the current view hierarchy of one device as uiautomator XML (`uiautomator dump`), including bounds, resource ids, text and clickability. Use it to find stable selectors before driving the UI through shell (input tap/text). With to_file: true the XML is kept on the device at /data/local/tmp/adbmcp-ui-<timestamp>.xml and returned as {path, bytes} instead of inline text, so large dumps stay structurally valid; retrieve it with pull_file. Dumps accumulate at that prefix by design — remove them with the shell tool (rm <path>) after pulling.',
      inputSchema: {
        device: z
          .string()
          .optional()
          .describe('Device serial from list_devices; optional when exactly one device is connected.'),
        timeout_ms: z.number().int().positive().optional().describe('Timeout in milliseconds for the dump (default 30000).'),
        to_file: z
          .boolean()
          .optional()
          .describe('Write the dump to /data/local/tmp/adbmcp-ui-<timestamp>.xml and return {path, bytes} instead of inline XML (default false).'),
      },
      // readOnlyHint stays true with to_file: the inline path already writes the
      // default dump file (/sdcard/window_dump.xml) on every call, and a
      // diagnostic dump under /data/local/tmp is ephemeral tool output, not user
      // state. The tool never deletes it; the consumer owns cleanup.
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

        if (args.to_file) {
          // Sequence suffix: shared HTTP context means two sessions can call to_file
          // within the same millisecond — Date.now() alone would collide.
          const path = `${UI_FILE_DUMP_PREFIX}${Date.now()}-${uiDumpSequence++}.xml`;
          const dump = await ctx.runner.runChecked(['shell', `uiautomator dump ${quoteForDeviceShell(path)}`], {
            serial,
            operation: 'get_ui_hierarchy',
            timeoutMs,
            maxBytes: ctx.config.limits.maxOutputBytes,
          });
          const dumpOutput = `${dump.stdout}\n${dump.stderr}`.trim();
          if (dumpReportedFailure(dumpOutput)) {
            throw new AdbError({
              cause: 'COMMAND_FAILED',
              message: `uiautomator dump did not report success on ${serial}: ${dumpOutput}`,
              hint: 'The screen may be off, animating, or showing a secure window — wake and retry. If it keeps failing, retry without to_file to inspect the inline dump path.',
            });
          }

          const wc = await ctx.runner.runChecked(['shell', `wc -c ${quoteForDeviceShell(path)}`], {
            serial,
            operation: 'get_ui_hierarchy',
            timeoutMs,
            maxBytes: ctx.config.limits.maxOutputBytes,
          });
          const token = wc.stdout.trim().split(/\s+/)[0] ?? '';
          const bytes = /^\d+$/.test(token) ? Number(token) : Number.NaN;
          if (!Number.isInteger(bytes) || bytes <= 0) {
            throw new AdbError({
              cause: 'COMMAND_FAILED',
              message: `uiautomator dump produced no readable file on ${serial} (${path}): ${wc.stdout.trim() || 'empty wc output'}`,
              hint: 'The screen may be off, animating, or showing a secure window — wake and retry. The dump file is timestamped, so a retry never reuses a stale one.',
            });
          }

          return textResult(
            `${JSON.stringify({ path, bytes })}\nRetrieve it with pull_file (remote_path: "${path}"), then remove it with the shell tool: rm ${path}. Dumps accumulate at ${UI_FILE_DUMP_PREFIX}* by design (no auto-delete).`,
          );
        }

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
