import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { ServerContext } from '../context.js';
import { registerListDevicesTool } from '../devices.js';
import { registerAppTools } from './app.js';
import { registerDeviceInfoTool } from './device-info.js';
import { registerDumpsysTool } from './dumpsys.js';
import { registerFileTools } from './files.js';
import { registerForwardTools } from './forward.js';
import { registerInputTools } from './input.js';
import { registerLogcatTools } from './logcat.js';
import { registerPackageTools } from './packages.js';
import { registerScreenshotTool } from './screenshot.js';
import { registerServerTools } from './server.js';
import { registerShellTool } from './shell.js';
import { registerUiTools } from './ui.js';
import { registerWirelessTools } from './wireless.js';

/**
 * Registers the tool surface: the MVP (design §4.1), v2.0 items 1–6 (design §4.2), plus the
 * v0.6.0 additions (`launch_package`, `get_ui_hierarchy` `to_file`).
 */
export function registerTools(server: McpServer, ctx: ServerContext): void {
  registerListDevicesTool(server, ctx);
  registerDeviceInfoTool(server, ctx);
  registerShellTool(server, ctx);
  registerPackageTools(server, ctx);
  registerLogcatTools(server, ctx);
  registerScreenshotTool(server, ctx);
  registerFileTools(server, ctx);
  registerForwardTools(server, ctx);
  registerWirelessTools(server, ctx);
  registerAppTools(server, ctx);
  registerUiTools(server, ctx);
  registerInputTools(server, ctx);
  registerDumpsysTool(server, ctx);
  registerServerTools(server, ctx);
}
