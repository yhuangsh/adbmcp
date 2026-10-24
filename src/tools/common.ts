import type { CallToolResult } from '@modelcontextprotocol/server';

import { isAdbError } from '../adb/errors.js';
import { GuardrailError } from '../config.js';
import { truncateText } from '../util/output.js';

/** Wrap text in an MCP tool result. */
export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * Convert any thrown value into an `isError` tool result. Typed adb failures keep
 * their machine-readable cause; guardrail refusals get their own marker so the
 * model can distinguish "policy said no" from "adb said no".
 */
export function errorResult(error: unknown): CallToolResult {
  let text: string;
  if (isAdbError(error)) {
    text = error.toToolText();
  } else if (error instanceof GuardrailError) {
    text = `[${error.rule}] ${error.message}`;
  } else {
    text = `[ERROR] ${error instanceof Error ? error.message : String(error)}`;
  }
  return { isError: true, content: [{ type: 'text', text }] };
}

/** Runs a tool body, converting thrown errors into `isError` results. */
export async function guard(handler: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await handler();
  } catch (error) {
    return errorResult(error);
  }
}

/** Cap a tool's text output to the configured byte budget. */
export function capText(text: string, maxBytes: number): string {
  return truncateText(text, maxBytes).text;
}
