import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { AdbError } from '../adb/errors.js';
import type { ServerContext } from '../context.js';
import { quoteForDeviceShell } from '../util/shell.js';
import { guard, textResult } from './common.js';

const DEVICE_ARG = z
  .string()
  .optional()
  .describe('Device serial from list_devices; optional when exactly one device is connected.');

/**
 * Component line from `cmd package resolve-activity --brief`, e.g.
 * "com.android.settings/.Settings" or "com.example/com.example.MainActivity".
 * The same command can print a `priority=… isDefault=…` header before it and
 * "No activity found" (exit 0) when the package has no launcher activity.
 */
const LAUNCHER_COMPONENT_LINE = /^([A-Za-z0-9_][A-Za-z0-9_.]*)\/([A-Za-z0-9_.$][A-Za-z0-9_.$]*)$/;

function parseLauncherComponent(output: string): string | undefined {
  for (const line of output.split('\n')) {
    const match = LAUNCHER_COMPONENT_LINE.exec(line.trim());
    if (match) return `${match[1]}/${match[2]}`;
  }
  return undefined;
}

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
    'launch_package',
    {
      title: 'Launch an app by package id',
      description:
        'Launch an installed app by package id: resolve its LAUNCHER activity (`cmd package resolve-activity --brief`) and start it (`am start -n`, with -W when wait is true). Returns the resolved component so later calls can use start_activity without re-resolving. The `monkey -p <package> 1` one-liner exists, but this keeps everyday launches off the shell escape hatch.',
      inputSchema: {
        package: z.string().min(1).describe('Package name to launch, e.g. "com.android.settings".'),
        wait: z.boolean().optional().describe('Pass -W and wait for the launch to be reported as displayed (default false).'),
        timeout_ms: z.number().int().positive().optional().describe('Timeout in milliseconds (default 30000; raise it when wait is true).'),
        device: DEVICE_ARG,
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
        const serial = await ctx.devices.resolve(args.device);
        const timeoutMs = args.timeout_ms ?? ctx.config.limits.defaultTimeoutMs;
        const resolveCommand = [
          'cmd',
          'package',
          'resolve-activity',
          '--brief',
          '-c',
          'android.intent.category.LAUNCHER',
          args.package,
        ]
          .map(quoteForDeviceShell)
          .join(' ');
        const resolution = await ctx.runner.run(['shell', resolveCommand], {
          serial,
          operation: 'launch_package',
          timeoutMs,
          maxBytes: ctx.config.limits.maxOutputBytes,
        });
        const resolutionOutput = `${resolution.stdout}\n${resolution.stderr}`.trim();
        const component = resolution.exitCode === 0 ? parseLauncherComponent(resolutionOutput) : undefined;
        if (!component) {
          throw new AdbError({
            cause: 'COMMAND_FAILED',
            message: `Could not resolve a launcher activity for ${args.package} on ${serial}${resolution.exitCode !== 0 ? ` (exit ${resolution.exitCode})` : ''}${resolutionOutput ? `: ${resolutionOutput}` : ''}`,
            hint: 'Verify the package id with list_packages (a substring filter helps); some installed apps have no LAUNCHER activity, so launch those with start_activity using an explicit component or intent action instead.',
          });
        }

        const launchArgv = ['am', 'start'];
        if (args.wait) launchArgv.push('-W');
        launchArgv.push('-n', component);
        const launchCommand = launchArgv.map(quoteForDeviceShell).join(' ');
        const result = await ctx.runner.run(['shell', launchCommand], {
          serial,
          operation: 'launch_package',
          timeoutMs,
          maxBytes: ctx.config.limits.maxOutputBytes,
        });
        const output = `${result.stdout}\n${result.stderr}`.trim();
        if (result.exitCode !== 0 || /^\s*Error:/m.test(result.stdout)) {
          throw new AdbError({
            cause: 'COMMAND_FAILED',
            message: `am start failed on ${serial} for ${component} (exit ${result.exitCode})${output ? `: ${output}` : ''}`,
            hint: 'The resolved launcher component did not start. Retry, or use start_activity with an explicit component or intent action; check logcat if it keeps failing.',
          });
        }
        const summary = `Launched ${component} on ${serial}.`;
        return textResult(output.length > 0 ? `${summary}\n${output}` : summary);
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
