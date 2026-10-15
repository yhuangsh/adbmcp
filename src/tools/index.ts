import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { ServerContext } from '../context.js';
import { registerListDevicesTool } from '../devices.js';
import { registerAppTools } from './app.js';
import { registerDeviceInfoTool } from './device-info.js';
import { registerFileTools } from './files.js';
import { registerForwardTools } from './forward.js';
import { registerLogcatTools } from './logcat.js';
import { registerPackageTools } from './packages.js';
import { registerScreenshotTool } from './screenshot.js';
import { registerServerTools } from './server.js';
import { registerShellTool } from './shell.js';
import { registerUiTools } from './ui.js';

/** Registers the MVP tool surface (design §4.1). */
export function registerTools(server: McpServer, ctx: ServerContext): void {
  registerListDevicesTool(server, ctx);
  registerDeviceInfoTool(server, ctx);
  registerShellTool(server, ctx);
  registerPackageTools(server, ctx);
  registerLogcatTools(server, ctx);
  registerScreenshotTool(server, ctx);
  registerFileTools(server, ctx);
  registerForwardTools(server, ctx);
  registerAppTools(server, ctx);
  registerUiTools(server, ctx);
  registerServerTools(server, ctx);
}
