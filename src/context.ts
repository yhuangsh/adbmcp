import type { AdbInvoker } from './adb/runner.js';
import type { AdbmcpConfig } from './config.js';
import type { DeviceManager } from './devices.js';
import type { StreamRegistry } from './streams/registry.js';

/** Everything a tool needs. Built once in the entrypoint, injected into registrars. */
export interface ServerContext {
  config: AdbmcpConfig;
  runner: AdbInvoker;
  devices: DeviceManager;
  streams: StreamRegistry;
}
