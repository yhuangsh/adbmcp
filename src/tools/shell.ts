import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { mapAdbFailure } from '../adb/errors.js';
import { assertShellCommandAllowed } from '../config.js';
import type { ServerContext } from '../context.js';
import { errorResult, guard, textResult } from './common.js';

/**
 * `shell` — the documented power-user escape hatch (design §4.1, §6).
 *
 * It is deliberately not read-only and is open-world: it can run anything the
 * device shell can. Guardrails (blocked patterns / allowed prefixes) run before
 * adb is spawned, and the annotations tell the host to confirm before use.
 */
export function registerShellTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'shell',
    {
      title: 'Run a device shell command',
      description:
        'Escape hatch: run an arbitrary command through `adb shell` on one device and return stdout/stderr. Powerful but not read-only — destructive commands are refused by default (reboot, su, mkfs, wipe, rm of / including split/reordered flags and the /* glob, and pipelines into sh/bash such as `curl … | sh` or `… | sudo bash`). This is a guardrail, not a sandbox: a deliberately obfuscated command can still get through. Prefer the dedicated tools (list_packages, install_apk, get_ui_hierarchy, …) when they cover the job. A non-zero remote exit code is reported as `exit_code: N` in the output. If the call times out, only the host-side adb client is killed; the command keeps running on the device (inherent to adb).',
      inputSchema: {
        command: z.string().min(1).describe('Device shell command, e.g. "dumpsys battery" or "ls /sdcard/Download".'),
        device: z.string().optional().describe('Device serial from list_devices; optional when exactly one device is connected.'),
        timeout_ms: z.number().int().positive().optional().describe('Command timeout in milliseconds (default 30000).'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      await guard(async () => {
        assertShellCommandAllowed(args.command, ctx.config.shell);
        const serial = await ctx.devices.resolve(args.device);
        const result = await ctx.runner.run(['shell', args.command], {
          serial,
          operation: 'shell',
          timeoutMs: args.timeout_ms ?? ctx.config.limits.defaultTimeoutMs,
          maxBytes: ctx.config.limits.maxOutputBytes,
        });

        if (result.exitCode !== 0) {
          const failure = mapAdbFailure(result, { serial, operation: `shell "${args.command}"` });
          // Device-side failures (e.g. `grep` finding nothing) are reported as
          // output with an exit code; adb-side failures become typed errors.
          if (failure.cause !== 'COMMAND_FAILED') return errorResult(failure);
          const sections = [`exit_code: ${result.exitCode}`];
          if (result.stdout.trim()) sections.push(result.stdout.trimEnd());
          if (result.stderr.trim()) sections.push(`stderr: ${result.stderr.trimEnd()}`);
          return textResult(sections.join('\n'));
        }

        const stdout = result.stdout.trimEnd();
        const sections = [stdout.length > 0 ? stdout : '(no output)'];
        if (result.stderr.trim()) sections.push(`stderr: ${result.stderr.trimEnd()}`);
        return textResult(sections.join('\n'));
      }),
  );
}
