/**
 * Test doubles for the adb seam (design §5): no test in this repo needs a real
 * adb binary, device or emulator.
 */
import { mapAdbFailure } from '../../src/adb/errors.js';
import type {
  AdbBinaryResult,
  AdbExecResult,
  AdbInvoker,
  RunOptions,
} from '../../src/adb/runner.js';
import { loadConfig, type AdbmcpConfig } from '../../src/config.js';
import type { ServerContext } from '../../src/context.js';
import { DeviceManager } from '../../src/devices.js';
import { StreamRegistry, type StreamProcessHandle, type StreamSpawner } from '../../src/streams/registry.js';

export interface FakeResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  truncated?: boolean;
  droppedBytes?: number;
}

export interface FakeBinaryResult {
  stdout?: Buffer;
  stderr?: string;
  exitCode?: number;
}

export type FakeHandler = (args: string[], options: RunOptions) => FakeResult | Promise<FakeResult>;
export type FakeBinaryHandler = (
  args: string[],
  options: RunOptions,
) => FakeBinaryResult | Promise<FakeBinaryResult>;

export interface RecordedCall {
  args: string[];
  options: RunOptions;
}

export class FakeAdbRunner implements AdbInvoker {
  readonly calls: RecordedCall[] = [];

  constructor(
    private handler: FakeHandler = () => ({}),
    private binaryHandler: FakeBinaryHandler = () => ({ stdout: Buffer.alloc(0) }),
  ) {}

  onRun(handler: FakeHandler): void {
    this.handler = handler;
  }

  onRunBinary(handler: FakeBinaryHandler): void {
    this.binaryHandler = handler;
  }

  async run(args: string[], options: RunOptions = {}): Promise<AdbExecResult> {
    this.calls.push({ args, options });
    const result = await this.handler(args, options);
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.exitCode ?? 0,
      truncated: result.truncated ?? false,
      droppedBytes: result.droppedBytes ?? 0,
    };
  }

  /** Mirrors AdbRunner: a non-zero exit becomes a typed AdbError. */
  async runChecked(args: string[], options: RunOptions = {}): Promise<AdbExecResult> {
    const result = await this.run(args, options);
    if (result.exitCode !== 0) {
      throw mapAdbFailure(result, {
        ...(options.serial !== undefined ? { serial: options.serial } : {}),
        ...(options.operation !== undefined ? { operation: options.operation } : {}),
      });
    }
    return result;
  }

  async runBinary(args: string[], options: RunOptions = {}): Promise<AdbBinaryResult> {
    this.calls.push({ args, options });
    const result = await this.binaryHandler(args, options);
    const exitCode = result.exitCode ?? 0;
    const stdout = result.stdout ?? Buffer.alloc(0);
    if (exitCode !== 0) {
      throw mapAdbFailure(
        { stdout: '', stderr: result.stderr ?? '', exitCode },
        {
          ...(options.serial !== undefined ? { serial: options.serial } : {}),
          ...(options.operation !== undefined ? { operation: options.operation } : {}),
        },
      );
    }
    return { stdout, stderr: result.stderr ?? '', exitCode, truncated: false };
  }

  /** Args of every recorded call, flattened for easy assertions. */
  commands(): string[] {
    return this.calls.map((call) => call.args.join(' '));
  }
}

export class FakeStreamHandle implements StreamProcessHandle {
  readonly killed: NodeJS.Signals[] = [];
  private stdoutHandlers: Array<(chunk: Buffer) => void> = [];
  private stderrHandlers: Array<(chunk: Buffer) => void> = [];
  private exitHandlers: Array<(code: number | null) => void> = [];
  private errorHandlers: Array<(error: Error) => void> = [];
  private exited = false;

  onStdout(handler: (chunk: Buffer) => void): void {
    this.stdoutHandlers.push(handler);
  }

  onStderr(handler: (chunk: Buffer) => void): void {
    this.stderrHandlers.push(handler);
  }

  onExit(handler: (code: number | null) => void): void {
    this.exitHandlers.push(handler);
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.killed.push(signal);
  }

  emitStdout(text: string): void {
    for (const handler of this.stdoutHandlers) handler(Buffer.from(text, 'utf8'));
  }

  emitStderr(text: string): void {
    for (const handler of this.stderrHandlers) handler(Buffer.from(text, 'utf8'));
  }

  /** Emit after the current tick, like a real adb child process would. */
  emitStdoutSoon(text: string, delayMs = 1): void {
    setTimeout(() => this.emitStdout(text), delayMs);
  }

  exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const handler of this.exitHandlers) handler(code);
  }

  exitSoon(code: number, delayMs = 1): void {
    setTimeout(() => this.exit(code), delayMs);
  }

  fail(error: Error): void {
    for (const handler of this.errorHandlers) handler(error);
  }
}

export class FakeStreamSpawner {
  readonly spawns: Array<{ argv: string[]; handle: FakeStreamHandle }> = [];

  constructor(private readonly onSpawn?: (handle: FakeStreamHandle, argv: string[]) => void) {}

  readonly spawner: StreamSpawner = (argv: string[]) => {
    const handle = new FakeStreamHandle();
    this.spawns.push({ argv, handle });
    this.onSpawn?.(handle, argv);
    return handle;
  };

  get last(): FakeStreamHandle {
    const spawn = this.spawns.at(-1);
    if (!spawn) throw new Error('No stream was spawned.');
    return spawn.handle;
  }

  get lastArgv(): string[] {
    const spawn = this.spawns.at(-1);
    if (!spawn) throw new Error('No stream was spawned.');
    return spawn.argv;
  }
}

export const TWO_DEVICES_LONG = [
  'List of devices attached',
  'emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1',
  'R58M12345AB            device product:beyond1lteeea model:SM_G973F device:beyond1 transport_id:2',
  '',
].join('\n');

export const ONE_DEVICE_LONG = [
  'List of devices attached',
  'emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1',
  '',
].join('\n');

export interface TestHarnessOptions {
  handler?: FakeHandler;
  binaryHandler?: FakeBinaryHandler;
  env?: NodeJS.ProcessEnv;
  bufferBytes?: number;
  startupGraceMs?: number;
  defaultReadBytes?: number;
}

export interface TestHarness {
  ctx: ServerContext;
  runner: FakeAdbRunner;
  streams: StreamRegistry;
  streamSpawner: FakeStreamSpawner;
  config: AdbmcpConfig;
}

/** Fast config for tests: short timeouts, small buffers. */
export function testConfig(env: NodeJS.ProcessEnv = {}, bufferBytes = 4096): AdbmcpConfig {
  const base = loadConfig(env);
  return {
    ...base,
    limits: { ...base.limits, defaultTimeoutMs: 200, maxOutputBytes: 4096 },
    logcat: { ...base.logcat, bufferBytes },
  };
}

export function createHarness(options: TestHarnessOptions = {}): TestHarness {
  const config = testConfig(options.env ?? {}, options.bufferBytes ?? 4096);
  const runner = new FakeAdbRunner(
    options.handler ?? (() => ({ stdout: '' })),
    options.binaryHandler ?? (() => ({ stdout: Buffer.from('PNG\u0000fake', 'utf8') })),
  );
  const devices = new DeviceManager(runner, config);
  const streamSpawner = new FakeStreamSpawner();
  const streams = new StreamRegistry({
    spawner: streamSpawner.spawner,
    bufferBytes: config.logcat.bufferBytes,
    format: config.logcat.format,
    startupGraceMs: options.startupGraceMs ?? 15,
    ...(options.defaultReadBytes !== undefined ? { defaultReadBytes: options.defaultReadBytes } : {}),
  });
  return { ctx: { config, runner, devices, streams }, runner, streams, streamSpawner, config };
}

/** Handler that answers `adb devices -l` with the given listing. */
export function devicesHandler(
  listing: string,
  extra: (args: string[]) => FakeResult | undefined = () => undefined,
): FakeHandler {
  return (args) => {
    if (args[0] === 'devices') return { stdout: listing };
    return extra(args) ?? { stdout: '' };
  };
}
