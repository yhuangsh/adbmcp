import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { AdbError } from '../adb/errors.js';
import type { ServerContext } from '../context.js';
import { quoteForDeviceShell } from '../util/shell.js';
import { guard, textResult } from './common.js';

const DEVICE_ARG = z
  .string()
  .optional()
  .describe('Device serial from list_devices; optional when exactly one device is connected.');

export function registerAppTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'start_activity',
    {
      title: 'Start an activity',
      description:
        'Launch an activity on one device (`am start`) either by component ("com.example/.MainActivity") or by intent action ("android.intent.action.VIEW" with optional data/extras). Use wait: true to block until the activity is reported as displayed.',
      inputSchema: {
        component: z.string().optional().describe('Explicit component "package/activity". Mutually exclusive with action.'),
        action: z.string().optional().describe('Intent action, e.g. "android.intent.action.VIEW". Mutually exclusive with component.'),
        data: z.string().optional().describe('Intent data URI (-d), e.g. "https://example.com/item/1".'),
        package: z.string().optional().describe('Restrict the intent to a package (-p), e.g. "com.example.app".'),
        extras: z
          .array(z.string())
          .optional()
          .describe('Raw `am start` arguments appended as-is and shell-quoted, e.g. ["--es", "message", "hello world", "--ez", "debug", "true"].'),
        wait: z.boolean().optional().describe('Pass -W and wait for launch to complete (default false).'),
        force_stop_first: z.boolean().optional().describe('Pass -S to force-stop the target app before starting it (default false).'),
        device: DEVICE_ARG,
        timeout_ms: z.number().int().positive().optional().describe('Timeout in milliseconds (default 30000; raise it when wait is true).'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      await guard(async () => {
        if (!args.component && !args.action) {
          throw new Error('start_activity needs either component ("package/activity") or action ("android.intent.action.…").');
        }
        if (args.component && args.action) {
          throw new Error('start_activity accepts component or action, not both — pass the component form for an explicit activity.');
        }
        const serial = await ctx.devices.resolve(args.device);
        const argv = ['am', 'start'];
        if (args.wait) argv.push('-W');
        if (args.force_stop_first) argv.push('-S');
        if (args.component) argv.push('-n', args.component);
        if (args.action) argv.push('-a', args.action);
        if (args.data) argv.push('-d', args.data);
        if (args.package) argv.push('-p', args.package);
        if (args.extras) argv.push(...args.extras);

        const command = argv.map(quoteForDeviceShell).join(' ');
        const result = await ctx.runner.run(['shell', command], {
          serial,
          operation: 'start_activity',
          timeoutMs: args.timeout_ms ?? ctx.config.limits.defaultTimeoutMs,
          maxBytes: ctx.config.limits.maxOutputBytes,
        });
        const output = `${result.stdout}\n${result.stderr}`.trim();
        if (result.exitCode !== 0 || /^\s*Error:/m.test(result.stdout)) {
          throw new AdbError({
            cause: 'COMMAND_FAILED',
            message: `am start failed on ${serial} (exit ${result.exitCode})${output ? `: ${output}` : ''}`,
            hint: 'Check the component with list_packages (the launcher activity may have a different name), or launch by action instead.',
          });
        }
        return textResult(output.length > 0 ? output : `Started ${args.component ?? args.action} on ${serial}.`);
      }),
  );

  server.registerTool(
    'force_stop_app',
    {
      title: 'Force-stop an app',
      description:
        'Stop all processes of a package on one device (`am force-stop`). Idempotent; safe to call when the app is not running.',
      inputSchema: {
        package: z.string().min(1).describe('Package name to stop, e.g. "com.example.app".'),
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
        const serial = await ctx.devices.resolve(args.device);
        await ctx.runner.runChecked(['shell', `am force-stop ${quoteForDeviceShell(args.package)}`], {
          serial,
          operation: 'force_stop_app',
          timeoutMs: ctx.config.limits.defaultTimeoutMs,
          maxBytes: ctx.config.limits.maxOutputBytes,
        });
        return textResult(`Force-stopped ${args.package} on ${serial}.`);
      }),
  );
}
