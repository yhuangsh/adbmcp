/**
 * Bounded FIFO byte buffer for long-running streams.
 *
 * When the cap is exceeded the oldest bytes are dropped (and counted), so a
 * chatty stream can never exhaust server memory while the agent is busy.
 */
export class RingBuffer {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private dropped = 0;
  private droppedSinceConsume = 0;

  constructor(private readonly capacityBytes: number) {
    if (capacityBytes <= 0) {
      throw new Error('RingBuffer capacity must be a positive number of bytes.');
    }
  }

  /** Bytes currently buffered. */
  get size(): number {
    return this.bytes;
  }

  /** Total bytes dropped by the cap since the buffer was created. */
  get droppedBytes(): number {
    return this.dropped;
  }

  push(chunk: Buffer): void {
    if (chunk.byteLength === 0) return;
    let remaining: Buffer | null = chunk;
    if (chunk.byteLength > this.capacityBytes) {
      const overflow = chunk.byteLength - this.capacityBytes;
      this.dropped += overflow;
      this.droppedSinceConsume += overflow;
      remaining = chunk.subarray(overflow);
    }
    if (remaining) {
      this.chunks.push(remaining);
      this.bytes += remaining.byteLength;
    }
    while (this.bytes > this.capacityBytes) {
      const oldest = this.chunks[0];
      if (oldest === undefined) break;
      const excess = this.bytes - this.capacityBytes;
      if (oldest.byteLength <= excess) {
        this.chunks.shift();
        this.bytes -= oldest.byteLength;
      } else {
        this.chunks[0] = oldest.subarray(excess);
        this.bytes -= excess;
      }
      this.dropped += excess;
      this.droppedSinceConsume += excess;
    }
  }

  /** Remove and return up to `maxBytes` of the oldest buffered bytes. */
  drain(maxBytes: number): Buffer {
    if (maxBytes <= 0 || this.bytes === 0) return Buffer.alloc(0);
    const parts: Buffer[] = [];
    let taken = 0;
    while (taken < maxBytes && this.chunks.length > 0) {
      const oldest = this.chunks[0];
      if (oldest === undefined) break;
      const room = maxBytes - taken;
      if (oldest.byteLength <= room) {
        this.chunks.shift();
        this.bytes -= oldest.byteLength;
        taken += oldest.byteLength;
        parts.push(oldest);
      } else {
        parts.push(oldest.subarray(0, room));
        this.chunks[0] = oldest.subarray(room);
        this.bytes -= room;
        taken += room;
      }
    }
    return Buffer.concat(parts);
  }

  /** Dropped bytes since the previous call, then reset the counter. */
  consumeDropped(): number {
    const value = this.droppedSinceConsume;
    this.droppedSinceConsume = 0;
    return value;
  }

  clear(): void {
    this.chunks.length = 0;
    this.bytes = 0;
  }
}
