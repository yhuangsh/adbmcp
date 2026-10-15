import { describe, expect, it } from 'vitest';

import { isAdbError } from '../src/adb/errors.js';
import { StreamRegistry, StreamNotFoundError } from '../src/streams/registry.js';
import { RingBuffer } from '../src/streams/ring-buffer.js';
import { createHarness, FakeStreamHandle, FakeStreamSpawner } from './helpers/fakes.js';

describe('RingBuffer', () => {
  it('keeps insertion order and drains FIFO', () => {
    const buffer = new RingBuffer(64);
    buffer.push(Buffer.from('hello '));
    buffer.push(Buffer.from('world'));
    expect(buffer.size).toBe(11);
    expect(buffer.drain(5).toString()).toBe('hello');
    expect(buffer.size).toBe(6);
    expect(buffer.drain(100).toString()).toBe(' world');
    expect(buffer.size).toBe(0);
    expect(buffer.droppedBytes).toBe(0);
  });

  it('drops the oldest bytes when the cap is exceeded and counts them', () => {
    const buffer = new RingBuffer(10);
    buffer.push(Buffer.from('0123456789'));
    buffer.push(Buffer.from('abcde'));
    expect(buffer.size).toBe(10);
    expect(buffer.droppedBytes).toBe(5);
    expect(buffer.consumeDropped()).toBe(5);
    // Counter is per-read: the model is told once about dropped bytes.
    expect(buffer.consumeDropped()).toBe(0);
    expect(buffer.drain(10).toString()).toBe('56789abcde');
  });

  it('trims a single oversized chunk to the cap', () => {
    const buffer = new RingBuffer(4);
    buffer.push(Buffer.from('abcdefgh'));
    expect(buffer.droppedBytes).toBe(4);
    expect(buffer.drain(100).toString()).toBe('efgh');
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new RingBuffer(0)).toThrow(/capacity/);
  });
});

describe('StreamRegistry', () => {
  it('scopes logcat to the device and returns a stream_id', async () => {
    const harness = createHarness();
    const started = await harness.streams.start({
      serial: 'emulator-5554',
      filterSpec: 'AndroidRuntime:E *:S',
    });
    expect(started.stream_id).toBe('logcat-1');
    expect(started.filter_spec).toBe('AndroidRuntime:E *:S');
    expect(harness.streamSpawner.lastArgv).toEqual([
      '-s',
      'emulator-5554',
      'logcat',
      '-v',
      'threadtime',
      'AndroidRuntime:E',
      '*:S',
    ]);
    expect(harness.streams.list()).toHaveLength(1);
  });

  it('reads only what arrived since the last read', async () => {
    const harness = createHarness();
    const started = await harness.streams.start({ serial: 'emulator-5554' });
    harness.streamSpawner.last.emitStdout('01-01 10:00:00.000 I/One: first\n');

    const first = harness.streams.read(started.stream_id);
    expect(first.text).toBe('01-01 10:00:00.000 I/One: first\n');
    expect(first.running).toBe(true);
    expect(first.dropped_bytes).toBe(0);

    const empty = harness.streams.read(started.stream_id);
    expect(empty.text).toBe('');
    expect(empty.bytes).toBe(0);
  });

  it('caps a read at max_bytes and keeps the remainder buffered', async () => {
    const harness = createHarness();
    const started = await harness.streams.start({ serial: 'emulator-5554' });
    const handle = harness.streamSpawner.last;
    handle.emitStdout('0123456789');

    const capped = harness.streams.read(started.stream_id, { maxBytes: 4 });
    expect(capped.text).toBe('0123');
    expect(capped.buffered_bytes).toBe(6);
    expect(harness.streams.read(started.stream_id).text).toBe('456789');
  });

  it('reports dropped bytes when the ring buffer overflows', async () => {
    const harness = createHarness({ bufferBytes: 8 });
    const started = await harness.streams.start({ serial: 'emulator-5554' });
    harness.streamSpawner.last.emitStdout('0123456789ABCDEF');

    const read = harness.streams.read(started.stream_id);
    expect(read.text).toBe('89ABCDEF');
    expect(read.dropped_bytes).toBe(8);
    expect(harness.streams.read(started.stream_id).dropped_bytes).toBe(0);
  });

  it('exposes the process state and stderr of the stream', async () => {
    const harness = createHarness();
    const started = await harness.streams.start({ serial: 'emulator-5554' });
    const handle = harness.streamSpawner.last;
    handle.emitStderr('--------- beginning of crash');
    handle.exit(0);

    const read = harness.streams.read(started.stream_id);
    expect(read.running).toBe(false);
    expect(read.exit_code).toBe(0);
    expect(read.stderr).toContain('beginning of crash');
  });

  it('refuses unknown stream ids and lists the active ones', async () => {
    const harness = createHarness();
    await harness.streams.start({ serial: 'emulator-5554' });
    expect(() => harness.streams.read('logcat-99')).toThrow(StreamNotFoundError);
    expect(() => harness.streams.read('logcat-99')).toThrow(/Active streams: logcat-1/);
    expect(() => harness.streams.stop('logcat-99')).toThrow(StreamNotFoundError);
  });

  it('stops a stream, returns unread output and forgets the handle', async () => {
    const harness = createHarness();
    const started = await harness.streams.start({ serial: 'emulator-5554' });
    const handle = harness.streamSpawner.last;
    handle.emitStdout('late line\n');

    const stopped = harness.streams.stop(started.stream_id);
    expect(stopped.stopped).toBe(true);
    expect(stopped.remaining_text).toBe('late line\n');
    expect(handle.killed).toContain('SIGTERM');
    expect(harness.streams.list()).toEqual([]);
    expect(() => harness.streams.read(started.stream_id)).toThrow(StreamNotFoundError);
  });

  it('kills every stream on shutdown', async () => {
    const harness = createHarness();
    await harness.streams.start({ serial: 'emulator-5554' });
    await harness.streams.start({ serial: 'R58M12345AB' });
    expect(harness.streams.list()).toHaveLength(2);

    harness.streams.closeAll();
    expect(harness.streams.list()).toEqual([]);
    for (const spawn of harness.streamSpawner.spawns) {
      expect(spawn.handle.killed).toContain('SIGKILL');
    }
  });

  it('fails fast when logcat exits during startup (no device)', async () => {
    const spawner = new FakeStreamSpawner((handle, argv) => {
      expect(argv).toContain('logcat');
      setTimeout(() => {
        handle.emitStderr('error: no devices/emulators found');
        handle.exit(1);
      }, 1);
    });
    const streams = new StreamRegistry({ spawner: spawner.spawner, startupGraceMs: 40 });

    const error = await streams.start({ serial: 'emulator-5554' }).catch((cause: unknown) => cause);
    expect(isAdbError(error)).toBe(true);
    if (!isAdbError(error)) return;
    expect(error.cause).toBe('NO_DEVICE');
    // A failed start must not leave a zombie stream behind.
    expect(streams.list()).toEqual([]);
  });

  it('reports a spawn failure as COMMAND_FAILED with an ADB_PATH hint', async () => {
    const spawner = new FakeStreamSpawner((handle) => {
      setTimeout(() => handle.fail(new Error('spawn adb ENOENT')), 1);
    });
    const streams = new StreamRegistry({ spawner: spawner.spawner, startupGraceMs: 40 });

    const error = await streams.start({ serial: 'emulator-5554' }).catch((cause: unknown) => cause);
    expect(isAdbError(error)).toBe(true);
    if (!isAdbError(error)) return;
    expect(error.cause).toBe('COMMAND_FAILED');
    expect(error.hint).toContain('ADB_PATH');
    expect(streams.list()).toEqual([]);
  });

  it('keeps streams usable when the device disconnects mid-stream', async () => {
    const harness = createHarness();
    const started = await harness.streams.start({ serial: 'emulator-5554' });
    const handle: FakeStreamHandle = harness.streamSpawner.last;
    handle.emitStdout('before disconnect\n');
    handle.emitStderr('error: device offline');
    handle.exit(1);

    const read = harness.streams.read(started.stream_id);
    expect(read.text).toContain('before disconnect');
    expect(read.running).toBe(false);
    expect(read.exit_code).toBe(1);
    expect(read.stderr).toContain('device offline');
  });
});
