/**
 * Byte-accurate output capping helpers.
 *
 * Agent-facing output must stay token-lean, so every subprocess result passes
 * through a head+tail cap: the beginning and the end of the output are the parts
 * a model needs (status lines vs. the actual error), the middle is dropped.
 */

/** Marker inserted where output was dropped. Kept short on purpose. */
export const TRUNCATION_MARKER = '[adbmcp: output truncated]';

export interface BoundedText {
  text: string;
  truncated: boolean;
  droppedBytes: number;
}

function splitCaps(maxBytes: number): { headBytes: number; tailBytes: number } {
  const tailBytes = Math.floor(maxBytes / 2);
  return { headBytes: maxBytes - tailBytes, tailBytes };
}

function describeDropped(droppedBytes: number): string {
  return `\n${TRUNCATION_MARKER} ${droppedBytes} bytes omitted\n`;
}

/** Cap a complete string, keeping its head and tail. */
export function truncateText(text: string, maxBytes: number): BoundedText {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) {
    return { text, truncated: false, droppedBytes: 0 };
  }
  const { headBytes, tailBytes } = splitCaps(maxBytes);
  const head = buffer.subarray(0, headBytes).toString('utf8');
  const tail = buffer.subarray(buffer.byteLength - tailBytes).toString('utf8');
  const droppedBytes = buffer.byteLength - headBytes - tailBytes;
  return {
    text: `${head}${describeDropped(droppedBytes)}${tail}`,
    truncated: true,
    droppedBytes,
  };
}

export interface BoundedLines {
  text: string;
  truncated: boolean;
  droppedLines: number;
}

/**
 * Keep at most `maxLines` lines. `from: 'tail'` keeps the most recent lines
 * (logcat-shaped output), `'head'` keeps the first ones (listings).
 */
export function truncateLines(
  text: string,
  maxLines: number,
  from: 'head' | 'tail' = 'head',
): BoundedLines {
  const lines = text.split('\n');
  if (lines.length <= maxLines) {
    return { text, truncated: false, droppedLines: 0 };
  }
  const droppedLines = lines.length - maxLines;
  const kept = from === 'head' ? lines.slice(0, maxLines) : lines.slice(lines.length - maxLines);
  const marker = `${TRUNCATION_MARKER} ${droppedLines} lines omitted (${from === 'head' ? 'first' : 'last'} ${maxLines} kept)`;
  const output = from === 'head' ? [...kept, marker] : [marker, ...kept];
  return { text: output.join('\n'), truncated: true, droppedLines };
}

/**
 * Streaming collector with bounded memory: keeps the first `headBytes` and the
 * most recent `tailBytes` of a stream, counting what it dropped. Used by the
 * adb subprocess layer so a runaway command cannot exhaust memory.
 */
export class OutputCollector {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private readonly head: Buffer[] = [];
  private readonly tail: Buffer[] = [];
  private headBytes = 0;
  private tailBytes = 0;
  private total = 0;

  constructor(private readonly maxBytes: number) {
    const { headBytes, tailBytes } = splitCaps(maxBytes);
    this.headLimit = headBytes;
    this.tailLimit = tailBytes;
  }

  push(chunk: Buffer): void {
    this.total += chunk.byteLength;
    let remainder: Buffer | null = chunk;
    if (this.headBytes < this.headLimit) {
      const room = this.headLimit - this.headBytes;
      const slice = remainder.subarray(0, room);
      this.head.push(slice);
      this.headBytes += slice.byteLength;
      remainder = remainder.byteLength > room ? remainder.subarray(room) : null;
    }
    if (remainder) {
      this.tail.push(remainder);
      this.tailBytes += remainder.byteLength;
      while (this.tailBytes > this.tailLimit && this.tail.length > 0) {
        const oldest = this.tail[0];
        if (oldest === undefined) break;
        const excess = this.tailBytes - this.tailLimit;
        if (oldest.byteLength <= excess) {
          this.tail.shift();
          this.tailBytes -= oldest.byteLength;
        } else {
          this.tail[0] = oldest.subarray(excess);
          this.tailBytes -= excess;
        }
      }
    }
  }

  /** Bytes received in total, before capping. */
  get receivedBytes(): number {
    return this.total;
  }

  isTruncated(): boolean {
    return this.total > this.maxBytes;
  }

  /** Bytes dropped by the cap. */
  get droppedBytes(): number {
    return Math.max(0, this.total - this.headBytes - this.tailBytes);
  }

  toBuffer(): Buffer {
    return Buffer.concat([...this.head, ...this.tail]);
  }

  toText(): BoundedText {
    const droppedBytes = this.droppedBytes;
    if (droppedBytes === 0) {
      return { text: this.toBuffer().toString('utf8'), truncated: false, droppedBytes: 0 };
    }
    const head = Buffer.concat(this.head).toString('utf8');
    const tail = Buffer.concat(this.tail).toString('utf8');
    return {
      text: `${head}${describeDropped(droppedBytes)}${tail}`,
      truncated: true,
      droppedBytes,
    };
  }
}
