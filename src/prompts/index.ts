import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

function promptText(text: string): { messages: { role: 'user'; content: { type: 'text'; text: string } }[] } {
  return { messages: [{ role: 'user', content: { type: 'text', text } }] };
}

function deviceLine(device: string | undefined): string {
  return device
    ? `Use device "${device}" for every adbmcp call.`
    : 'Call list_devices first and pass the chosen serial as "device" on every call (required when more than one device is connected).';
}

/** Prompt templates that orchestrate the tools above (design §4.1). */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'debug_crash',
    {
      title: 'Debug an app crash',
      description: 'Collect the evidence for an app crash: device info, filtered logcat, and reproduce the failure.',
      argsSchema: {
        package: z.string().optional().describe('Package name to reproduce, e.g. "com.example.app".'),
        device: z.string().optional().describe('Device serial from list_devices.'),
      },
    },
    (args) =>
      promptText(
        [
          'Investigate whether an Android app is crashing, using adbmcp.',
          deviceLine(args.device),
          args.package ? `Target package: ${args.package}.` : 'Determine the target package with list_packages if it is not obvious.',
          '',
          'Do this:',
          '1. get_device_info to record model, Android version and SDK.',
          '2. logcat_snapshot with filter_spec "AndroidRuntime:E *:S" and max_lines 200 to see recent fatal exceptions.',
          '3. If the crash is not in the buffer: start_logcat_stream with filter_spec "AndroidRuntime:E ActivityManager:I *:S".',
          args.package
            ? `4. force_stop_app on ${args.package}, then start_activity to reproduce, then read_logcat_stream.`
            : '4. force_stop_app and start_activity to reproduce the failure, then read_logcat_stream.',
          '5. stop_logcat_stream when done and summarise: exception type, message, the app frame in the stack, and the likely cause. Include the raw log lines you based the conclusion on.',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'install_and_launch',
    {
      title: 'Install and launch an APK',
      description: 'Install a freshly built APK, launch it, and verify that it started without crashing.',
      argsSchema: {
        apk_path: z.string().optional().describe('Path to the APK on the host machine.'),
        component: z.string().optional().describe('Component to launch, "package/Activity".'),
        device: z.string().optional().describe('Device serial from list_devices.'),
      },
    },
    (args) =>
      promptText(
        [
          'Install and launch an Android app with adbmcp.',
          deviceLine(args.device),
          args.apk_path ? `APK: ${args.apk_path} (host path).` : 'Ask which APK to install if the path is unknown — apk_path must be a host path.',
          args.component ? `Launch component: ${args.component}.` : 'Find the launch component with list_packages, or launch by action.',
          '',
          'Do this:',
          '1. list_devices and confirm the target device is in state "device".',
          '2. install_apk with replace: true so an existing build is replaced.',
          '3. start_logcat_stream with filter_spec "AndroidRuntime:E ActivityManager:I *:S".',
          '4. start_activity with wait: true (component if known, otherwise the launcher action).',
          '5. read_logcat_stream and screenshot to confirm the app is on screen.',
          '6. Report install result, launch result (activity + total time), any crash, and stop the stream.',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'capture_bug_report',
    {
      title: 'Capture a bug report bundle',
      description: 'Gather device info, logs, screenshot and UI hierarchy for a bug report on one device.',
      argsSchema: {
        device: z.string().optional().describe('Device serial from list_devices.'),
        notes: z.string().optional().describe('What the bug is / what the observer saw.'),
        logcat_filter: z.string().optional().describe('logcat filter spec to use (default "AndroidRuntime:E ActivityManager:I *:S").'),
      },
    },
    (args) =>
      promptText(
        [
          'Capture a bug report bundle from an Android device with adbmcp.',
          deviceLine(args.device),
          args.notes ? `Context from the reporter: ${args.notes}` : 'Ask the user what went wrong and when, if it is not already clear.',
          '',
          'Collect, in order:',
          '1. get_device_info (model, build, SDK).',
          `2. logcat_snapshot with filter_spec "${args.logcat_filter ?? 'AndroidRuntime:E ActivityManager:I *:S'}" and max_lines 500 (use the stream tools instead if you need to capture a longer window).`,
          '3. screenshot.',
          '4. get_ui_hierarchy (helps reproduce the exact screen state).',
          '5. list_packages if the report names an app that may not be installed here.',
          '',
          'Then write a concise report: device/build summary, what failed (with the exact log lines), observed screen state, and next diagnostic step. Note explicitly anything you could not capture.',
        ].join('\n'),
      ),
  );
}
