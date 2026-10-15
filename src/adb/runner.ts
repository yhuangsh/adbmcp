import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { AdbError, mapAdbFailure, timeoutError } from './errors.js';
import { OutputCollector } from '../util/output.js';

export interface AdbExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the head+tail byte cap dropped output. */
  truncated: boolean;
  droppedBytes: number;
}

export interface AdbBinaryResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

export interface RunOptions {
  /** Device serial; when set the call is scoped with `-s <serial>`. */
  serial?: string;
  timeoutMs?: number;
  /** Byte cap for stdout (text result). */
  maxBytes?: number;
  /** Human label used in error messages, e.g. "install_apk". */
  operation?: string;
}

/** The seam every tool depends on, so tests can drive a fake adb. */
export interface AdbInvoker {
  run(args: string[], options?: RunOptions): Promise<AdbExecResult>;
  runChecked(args: string[], options?: RunOptions): Promise<AdbExecResult>;
  runBinary(args: string[], options?: RunOptions): Promise<AdbBinaryResult>;
}

export interface AdbRunnerOptions {
  /** adb binary: `ADB_PATH` config value or "adb" resolved from PATH. */
  adbPath?: string;
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
}

/** Default cap for stdout kept in memory (head+tail), in bytes. */
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;

export class AdbRunner implements AdbInvoker {
  private readonly adbPath: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(options: AdbRunnerOptions = {}) {
    this.adbPath = options.adbPath ?? 'adb';
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  /** Full adb argv for a call, with device scoping applied. */
  buildArgv(args: string[], serial?: string): string[] {
    return serial ? ['-s', serial, ...args] : [...args];
  }

  async run(args: string[], options: RunOptions = {}): Promise<AdbExecResult> {
    const result = await this.execute(args, options);
    const text = result.stdoutCollector.toText();
    return {
      stdout: text.text,
      stderr: result.stderr,
      exitCode: result.exitCode,
      truncated: text.truncated,
      droppedBytes: text.droppedBytes,
    };
  }

  /** Same as `run`, but a non-zero exit becomes a typed `AdbError`. */
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

  /** Raw (binary) stdout, e.g. `exec-out screencap -p`. */
  async runBinary(args: string[], options: RunOptions = {}): Promise<AdbBinaryResult> {
    const result = await this.execute(args, options);
    if (result.exitCode !== 0) {
      throw mapAdbFailure(
        { stdout: '', stderr: result.stderr, exitCode: result.exitCode },
        {
          ...(options.serial !== undefined ? { serial: options.serial } : {}),
          ...(options.operation !== undefined ? { operation: options.operation } : {}),
        },
      );
    }
    const stdout = result.stdoutCollector.toBuffer();
    return {
      stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      truncated: result.stdoutCollector.isTruncated(),
    };
  }

  private async execute(args: string[], options: RunOptions): Promise<Execution> {
    const serial = options.serial;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const maxBytes = options.maxBytes ?? this.maxOutputBytes;
    const argv = this.buildArgv(args, serial);

    return await new Promise<Execution>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.adbPath, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        reject(this.spawnFailure(error));
        return;
      }

      const stdoutCollector = new OutputCollector(maxBytes);
      const stderrCollector = new OutputCollector(maxBytes);
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => stdoutCollector.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrCollector.push(chunk));

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(this.spawnFailure(error));
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const stderr = stderrCollector.toText().text;
        if (timedOut) {
          reject(
            timeoutError({
              timeoutMs,
              stderr,
              ...(options.operation !== undefined ? { operation: options.operation } : {}),
            }),
          );
          return;
        }
        // A signal with no exit code (e.g. killed by the OS) is still a failure.
        const exitCode = code ?? (signal ? 1 : 0);
        resolve({ stdoutCollector, stderr, exitCode });
      });

      // Nothing is written to stdin, but closing it lets adb commands that read
      // stdin (e.g. `pm install` prompts) finish instead of hanging.
      child.stdin.end();
    });
  }

  private spawnFailure(error: unknown): AdbError {
    const message = error instanceof Error ? error.message : String(error);
    const notFound =
      typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
    return new AdbError({
      cause: 'COMMAND_FAILED',
      message: notFound
        ? `Cannot execute the adb binary "${this.adbPath}": file not found.`
        : `Failed to start the adb binary "${this.adbPath}": ${message}`,
      hint: notFound
        ? 'Install Android platform-tools and put "adb" on PATH, or set the ADB_PATH environment variable to the full path of the binary.'
        : 'Check that the adb binary is executable and that ADB_PATH points at a valid path.',
    });
  }
}

interface Execution {
  stdoutCollector: OutputCollector;
  stderr: string;
  exitCode: number;
}
