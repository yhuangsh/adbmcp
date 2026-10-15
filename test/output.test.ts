import { describe, expect, it } from 'vitest';

import { OutputCollector, TRUNCATION_MARKER, truncateLines, truncateText } from '../src/util/output.js';

describe('truncateText', () => {
  it('leaves short text untouched', () => {
    const bounded = truncateText('hello', 100);
    expect(bounded).toEqual({ text: 'hello', truncated: false, droppedBytes: 0 });
  });

  it('keeps head and tail and reports how much was dropped', () => {
    const text = `${'H'.repeat(100)}${'D'.repeat(1000)}${'T'.repeat(100)}`;
    const bounded = truncateText(text, 200);
    expect(bounded.truncated).toBe(true);
    expect(bounded.droppedBytes).toBe(1000);
    expect(bounded.text.startsWith('H'.repeat(100))).toBe(true);
    expect(bounded.text.endsWith('T'.repeat(100))).toBe(true);
    expect(bounded.text).toContain(TRUNCATION_MARKER);
    expect(bounded.text).not.toContain('D'.repeat(50));
  });
});

describe('truncateLines', () => {
  const text = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n');

  it('keeps the newest lines for log-shaped output', () => {
    const bounded = truncateLines(text, 3, 'tail');
    expect(bounded.truncated).toBe(true);
    expect(bounded.droppedLines).toBe(7);
    expect(bounded.text).toContain('line 10');
    expect(bounded.text).toContain('line 8');
    expect(bounded.text).not.toContain('line 7\n');
    expect(bounded.text.split('\n')[0]).toBe(TRUNCATION_MARKER + ' 7 lines omitted (last 3 kept)');
  });

  it('keeps the first lines for listings', () => {
    const bounded = truncateLines(text, 2, 'head');
    expect(bounded.text.startsWith('line 1\nline 2')).toBe(true);
    expect(bounded.droppedLines).toBe(8);
  });

  it('is a no-op below the limit', () => {
    expect(truncateLines('a\nb', 5).truncated).toBe(false);
  });
});

describe('OutputCollector', () => {
  it('keeps memory bounded while preserving the head and the tail', () => {
    const collector = new OutputCollector(100);
    collector.push(Buffer.from('h'.repeat(50)));
    collector.push(Buffer.from('m'.repeat(500)));
    collector.push(Buffer.from('t'.repeat(50)));

    const bounded = collector.toText();
    expect(collector.receivedBytes).toBe(600);
    expect(collector.isTruncated()).toBe(true);
    expect(collector.droppedBytes).toBe(500);
    expect(bounded.text.startsWith('h'.repeat(50))).toBe(true);
    expect(bounded.text.endsWith('t'.repeat(50))).toBe(true);
    expect(bounded.text).toContain('500 bytes omitted');
    expect(bounded.text.length).toBeLessThan(300);
  });

  it('returns the raw bytes when nothing was dropped', () => {
    const collector = new OutputCollector(1000);
    collector.push(Buffer.from('abc'));
    expect(collector.isTruncated()).toBe(false);
    expect(collector.toBuffer().toString()).toBe('abc');
    expect(collector.toText().truncated).toBe(false);
  });

  it('caps a single oversized chunk to the head only', () => {
    const collector = new OutputCollector(100);
    collector.push(Buffer.from('x'.repeat(1000)));
    expect(collector.droppedBytes).toBe(900);
    expect(collector.toBuffer().byteLength).toBe(100);
  });
});
