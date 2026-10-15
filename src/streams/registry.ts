import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

import { AdbError, mapAdbFailure } from '../adb/errors.js';
import { RingBuffer } from './ring-buffer.js';

export interface StreamProcessHandle {
  onStdout(handler: (chunk: Buffer) => void): void;
  onStderr(handler: (chunk: Buffer) => void): void;
  onExit(handler: (code: number | null) => void): void;
  onError(handler: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

/** Seam so tests can run the registry without adb (design §5: stream registry). */
export type StreamSpawner = (argv: string[]) => StreamProcessHandle;

export function createAdbStreamSpawner(adbPath: string): StreamSpawner {
  return (argv: string[]): StreamProcessHandle => {
    const child = spawn(adbPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    return {
      onStdout(handler) {
        (child.stdout as Readable).on('data', (chunk: Buffer) => handler(chunk));
      },
      onStderr(handler) {
        (child.stderr as Readable).on('data', (chunk: Buffer) => handler(chunk));
      },
      onExit(handler) {
        child.on('close', (code) => handler(code));
      },
      onError(handler) {
        child.on('error', (error) => handler(error));
      },
      kill(signal = 'SIGTERM') {
        child.kill(signal);
      },
    };
  };
}

export interface StartLogcatStreamOptions {
  serial: string;
  filterSpec?: string;
  /** Grace period used to surface immediate failures (no device, bad filter). */
  startupGraceMs?: number;
}

export interface StartedLogcatStream {
  stream_id: string;
  device: string;
  filter_spec: string | null;
  format: string;
  hint: string;
}

export interface LogcatStreamRead {
  stream_id: string;
  text: string;
  bytes: number;
  buffered_bytes: number;
  dropped_bytes: number;
  running: boolean;
  exit_code: number | null;
  stderr: string;
}

export interface StoppedLogcatStream {
  stream_id: string;
  stopped: boolean;
  remaining_text: string;
  remaining_bytes: number;
  dropped_bytes: number;
}

export interface LogcatStreamSummary {
  stream_id: string;
  device: string;
  filter_spec: string | null;
  running: boolean;
  started_at: string;
  buffered_bytes: number;
  dropped_bytes: number;
}

export interface StreamRegistryOptions {
  spawner: StreamSpawner;
  /** Ring-buffer cap per stream, in bytes. */
  bufferBytes?: number;
  /** logcat `-v` format, e.g. "threadtime". */
  format?: string;
  /** Bytes returned by a single read when the caller does not cap it. */
  defaultReadBytes?: number;
  /** Grace period before `start` resolves successfully, in ms. */
  startupGraceMs?: number;
}

export const DEFAULT_STREAM_BUFFER_BYTES = 1024 * 1024;
export const DEFAULT_STREAM_READ_BYTES = 64 * 1024;
export const DEFAULT_STARTUP_GRACE_MS = 150;

export class StreamNotFoundError extends Error {
  constructor(streamId: string, activeIds: string[]) {
    super(
      activeIds.length > 0
        ? `Unknown logcat stream "${streamId}". Active streams: ${activeIds.join(', ')}.`
        : `Unknown logcat stream "${streamId}". No logcat streams are active; call start_logcat_stream first.`,
    );
    this.name = 'StreamNotFoundError';
  }
}

interface ActiveStream {
  id: string;
  serial: string;
  filterSpec: string | null;
  startedAt: Date;
  handle: StreamProcessHandle;
  buffer: RingBuffer;
  stderr: RingBuffer;
  running: boolean;
  exitCode: number | null;
  receivedOutput: boolean;
  spawnError: Error | null;
}

/**
 * Registry of long-running adb streams (design §5).
 *
 * `start_*` spawns the process and returns a handle, `read_*` drains buffered
 * output, `stop_*` terminates and forgets the stream, and every stream is killed
 * on server shutdown (`closeAll`).
 */
export class StreamRegistry {
  private readonly streams = new Map<string, ActiveStream>();
  private readonly spawner: StreamSpawner;
  private readonly bufferBytes: number;
  private readonly format: string;
  private readonly defaultReadBytes: number;
  private readonly startupGraceMs: number;
  private nextId = 1;

  constructor(options: StreamRegistryOptions) {
    this.spawner = options.spawner;
    this.bufferBytes = options.bufferBytes ?? DEFAULT_STREAM_BUFFER_BYTES;
    this.format = options.format ?? 'threadtime';
    this.defaultReadBytes = options.defaultReadBytes ?? DEFAULT_STREAM_READ_BYTES;
    this.startupGraceMs = options.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS;
  }

  /** Build the adb argv for a stream; exposed for tests and logging. */
  buildArgv(serial: string, filterSpec: string | null): string[] {
    const tokens = filterSpec ? filterSpec.trim().split(/\s+/).filter((token) => token.length > 0) : [];
    return ['-s', serial, 'logcat', '-v', this.format, ...tokens];
  }

  async start(options: StartLogcatStreamOptions): Promise<StartedLogcatStream> {
    const filterSpec = options.filterSpec?.trim() ? options.filterSpec.trim() : null;
    const id = `logcat-${this.nextId++}`;
    const argv = this.buildArgv(options.serial, filterSpec);
    const handle = this.spawner(argv);
    const entry: ActiveStream = {
      id,
      serial: options.serial,
      filterSpec,
      startedAt: new Date(),
      handle,
      buffer: new RingBuffer(this.bufferBytes),
      stderr: new RingBuffer(8 * 1024),
      running: true,
      exitCode: null,
      receivedOutput: false,
      spawnError: null,
    };
    this.streams.set(id, entry);

    handle.onStdout((chunk) => {
      entry.receivedOutput = true;
      entry.buffer.push(chunk);
    });
    handle.onStderr((chunk) => entry.stderr.push(chunk));
    handle.onExit((code) => {
      entry.running = false;
      entry.exitCode = code;
    });
    handle.onError((error) => {
      entry.spawnError = error;
      entry.running = false;
    });

    await this.awaitStartup(entry, options.startupGraceMs ?? this.startupGraceMs);

    return {
      stream_id: id,
      device: options.serial,
      filter_spec: filterSpec,
      format: this.format,
      hint: 'Poll read_logcat_stream with this stream_id; call stop_logcat_stream when done.',
    };
  }

  read(streamId: string, options: { maxBytes?: number } = {}): LogcatStreamRead {
    const entry = this.require(streamId);
    const maxBytes = options.maxBytes ?? this.defaultReadBytes;
    const chunk = entry.buffer.drain(maxBytes);
    const dropped = entry.buffer.consumeDropped();
    const result: LogcatStreamRead = {
      stream_id: entry.id,
      text: chunk.toString('utf8'),
      bytes: chunk.byteLength,
      buffered_bytes: entry.buffer.size,
      dropped_bytes: dropped,
      running: entry.running,
      exit_code: entry.exitCode,
      stderr: entry.stderr.drain(8 * 1024).toString('utf8').trim(),
    };
    if (!entry.running && entry.spawnError) {
      result.stderr = `${result.stderr}${result.stderr ? '\n' : ''}${entry.spawnError.message}`.trim();
    }
    return result;
  }

  stop(streamId: string, options: { maxBytes?: number } = {}): StoppedLogcatStream {
    const entry = this.require(streamId);
    if (entry.running) {
      entry.handle.kill('SIGTERM');
      // Escalate only if SIGTERM is ignored; unref'd so shutdown is not delayed.
      const timer = setTimeout(() => entry.handle.kill('SIGKILL'), 2_000);
      timer.unref();
    }
    const remaining = entry.buffer.drain(options.maxBytes ?? this.defaultReadBytes);
    const result: StoppedLogcatStream = {
      stream_id: entry.id,
      stopped: true,
      remaining_text: remaining.toString('utf8'),
      remaining_bytes: entry.buffer.size,
      dropped_bytes: entry.buffer.droppedBytes,
    };
    entry.buffer.clear();
    this.streams.delete(entry.id);
    return result;
  }

  list(): LogcatStreamSummary[] {
    return [...this.streams.values()].map((entry) => ({
      stream_id: entry.id,
      device: entry.serial,
      filter_spec: entry.filterSpec,
      running: entry.running,
      started_at: entry.startedAt.toISOString(),
      buffered_bytes: entry.buffer.size,
      dropped_bytes: entry.buffer.droppedBytes,
    }));
  }

  /** Kill every stream; called on server shutdown (SIGINT/SIGTERM/close). */
  closeAll(): void {
    for (const entry of this.streams.values()) {
      if (entry.running) {
        entry.handle.kill('SIGKILL');
        entry.running = false;
      }
      entry.buffer.clear();
    }
    this.streams.clear();
  }

  private require(streamId: string): ActiveStream {
    const entry = this.streams.get(streamId);
    if (!entry) {
      throw new StreamNotFoundError(
        streamId,
        this.list().map((summary) => summary.stream_id),
      );
    }
    return entry;
  }

  private async awaitStartup(entry: ActiveStream, graceMs: number): Promise<void> {
    if (graceMs <= 0) return;
    const deadline = Date.now() + graceMs;
    for (;;) {
      if (entry.spawnError) {
        this.streams.delete(entry.id);
        throw new AdbError({
          cause: 'COMMAND_FAILED',
          message: `Could not start logcat stream on "${entry.serial}": ${entry.spawnError.message}`,
          hint: 'Check ADB_PATH and that the adb binary is executable.',
        });
      }
      if (!entry.running) {
        if (entry.exitCode === 0 || entry.exitCode === null) return;
        const stderr = entry.stderr.drain(8 * 1024).toString('utf8');
        this.streams.delete(entry.id);
        throw mapAdbFailure(
          { stderr, exitCode: entry.exitCode },
          { serial: entry.serial, operation: `logcat stream on ${entry.serial}` },
        );
      }
      if (entry.receivedOutput) return;
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
