/**
 * Typed adb failure causes (design §5).
 *
 * adb reports failures as free-form stderr text with a non-zero exit code, so we
 * translate the well-known failure shapes into machine-readable causes and pair
 * each cause with an actionable message plus a hint for the model.
 */

export type AdbErrorCause =
  | 'DEVICE_UNAUTHORIZED'
  | 'DEVICE_OFFLINE'
  | 'NO_DEVICE'
  | 'MULTIPLE_DEVICES'
  | 'ADB_SERVER_CONFLICT'
  | 'TIMEOUT'
  | 'COMMAND_FAILED';

export interface AdbErrorDetails {
  cause: AdbErrorCause;
  message: string;
  hint?: string;
  /** Raw adb stderr, when available. */
  stderr?: string;
  exitCode?: number;
  /** Device serials relevant to the failure (e.g. multiple-device candidates). */
  candidates?: string[];
}

export class AdbError extends Error {
  /** Machine-readable cause; see `AdbErrorCause`. */
  override readonly cause: AdbErrorCause;
  readonly hint?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly candidates: string[];

  constructor(details: AdbErrorDetails) {
    super(details.message);
    this.name = 'AdbError';
    this.cause = details.cause;
    if (details.hint !== undefined) this.hint = details.hint;
    if (details.stderr !== undefined) this.stderr = details.stderr;
    if (details.exitCode !== undefined) this.exitCode = details.exitCode;
    this.candidates = details.candidates ?? [];
  }

  /** Single text block the model can act on: cause, message, hint, stderr excerpt. */
  toToolText(): string {
    const lines = [`[${this.cause}] ${this.message}`];
    if (this.hint) lines.push(`Hint: ${this.hint}`);
    if (this.candidates.length > 0) lines.push(`Candidates: ${this.candidates.join(', ')}`);
    // COMMAND_FAILED already embeds the stderr excerpt in its message.
    const excerpt = this.cause === 'COMMAND_FAILED' ? '' : excerptStderr(this.stderr);
    if (excerpt) lines.push(`stderr: ${excerpt}`);
    return lines.join('\n');
  }
}

export function isAdbError(error: unknown): error is AdbError {
  return error instanceof AdbError;
}

export interface AdbFailure {
  stderr: string;
  exitCode: number;
  stdout?: string;
  timedOut?: boolean;
  timeoutMs?: number;
}

export interface AdbFailureContext {
  /** Serial explicitly requested by the caller, if any. */
  serial?: string;
  /** Human label for the attempted operation, used in messages. */
  operation?: string;
}

const STDERR_EXCERPT_LIMIT = 600;

function excerptStderr(stderr: string | undefined): string {
  if (!stderr) return '';
  const trimmed = stderr.trim();
  if (trimmed.length === 0) return '';
  const lines = trimmed.split('\n').filter((line) => line.trim().length > 0);
  const joined = lines.join('\n');
  return joined.length > STDERR_EXCERPT_LIMIT
    ? `${joined.slice(0, STDERR_EXCERPT_LIMIT)}…`
    : joined;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? '';
}

export function unauthorizedError(serial: string | undefined): AdbError {
  const target = serial ? `Device "${serial}"` : 'A device';
  return new AdbError({
    cause: 'DEVICE_UNAUTHORIZED',
    message: `${target} is unauthorized: debugging is not allowed by the device yet.`,
    hint: 'Unlock the device screen and accept the "Allow USB debugging?" prompt (check "Always allow" to keep it), then retry.',
  });
}

export function offlineError(serial: string | undefined): AdbError {
  const target = serial ? `Device "${serial}"` : 'The device';
  return new AdbError({
    cause: 'DEVICE_OFFLINE',
    message: `${target} is offline: adb cannot talk to it right now.`,
    hint: 'Reconnect the USB cable or run "adb reconnect" (adb_server_restart is the last resort), then retry.',
  });
}

export function noDeviceError(serial: string | undefined, candidates: string[] = []): AdbError {
  const message = serial
    ? `Device "${serial}" is not connected.`
    : 'No Android device or emulator is connected.';
  return new AdbError({
    cause: 'NO_DEVICE',
    message,
    hint: serial
      ? 'Run list_devices and pass a serial from the returned list, or start that emulator/device.'
      : 'Start an emulator or connect a device (USB or "adb connect <host>:<port>"), then verify with list_devices.',
    ...(candidates.length > 0 ? { candidates } : {}),
  });
}

export function multipleDevicesError(candidates: string[]): AdbError {
  return new AdbError({
    cause: 'MULTIPLE_DEVICES',
    message: `More than one device is connected (${candidates.join(', ')}).`,
    hint: 'Pass "device": "<serial>" to select one. Use list_devices to see serials and states.',
    ...(candidates.length > 0 ? { candidates } : {}),
  });
}

export function serverConflictError(stderr: string): AdbError {
  return new AdbError({
    cause: 'ADB_SERVER_CONFLICT',
    message: 'The adb server running on this host does not match the adb client binary.',
    hint: 'Run the adb_server_restart tool (or "adb kill-server") to restart the shared adb server with the client version, then retry.',
    stderr,
  });
}

export function timeoutError(options: { timeoutMs: number; operation?: string; stderr?: string }): AdbError {
  const what = options.operation ? options.operation : 'adb command';
  return new AdbError({
    cause: 'TIMEOUT',
    message: `${what} timed out after ${options.timeoutMs} ms.`,
    hint: 'Raise timeout_ms for slow operations (large installs, dumpsys), or check that the device is responsive (get_device_info).',
    ...(options.stderr !== undefined ? { stderr: options.stderr } : {}),
  });
}

export function commandFailedError(options: {
  stderr: string;
  exitCode: number;
  operation?: string;
}): AdbError {
  const excerpt = excerptStderr(options.stderr) || firstLine(options.stderr);
  const what = options.operation ? options.operation : 'adb command';
  return new AdbError({
    cause: 'COMMAND_FAILED',
    message: excerpt
      ? `${what} failed (exit ${options.exitCode}): ${excerpt}`
      : `${what} failed with exit code ${options.exitCode} and no stderr output.`,
    hint: 'Inspect the stderr excerpt; for device-side failures try running the equivalent command via the shell tool.',
    stderr: options.stderr,
    exitCode: options.exitCode,
  });
}

const SERVER_CONFLICT_PATTERNS = [
  /adb server version .* doesn't match this client/i,
  /server version mismatch/i,
  /adb server didn'?t ack/i,
  /cannot connect to daemon at tcp:\d+/i,
  /protocol fault \(no status\)/i,
];

const NO_DEVICE_PATTERNS = [
  /no devices\/emulators found/i,
  /device .*not found/i,
  /no device \(?s\)? found/i,
];
const MULTIPLE_DEVICE_PATTERNS = [/more than one device/i, /more than one emulator/i];
const UNAUTHORIZED_PATTERNS = [/\bunauthorized\b/i, /error: device unauthorized/i];
const OFFLINE_PATTERNS = [/\bdevice offline\b/i, /\boffline\b/i];

/**
 * Map an adb failure (stderr + exit code) onto a typed error.
 * Order matters: device-state problems are more actionable than generic failures.
 */
export function mapAdbFailure(failure: AdbFailure, context: AdbFailureContext = {}): AdbError {
  const stderr = failure.stderr ?? '';
  if (failure.timedOut) {
    return timeoutError({
      timeoutMs: failure.timeoutMs ?? 0,
      ...(context.operation !== undefined ? { operation: context.operation } : {}),
      stderr,
    });
  }
  if (SERVER_CONFLICT_PATTERNS.some((pattern) => pattern.test(stderr))) {
    return serverConflictError(stderr);
  }
  if (MULTIPLE_DEVICE_PATTERNS.some((pattern) => pattern.test(stderr))) {
    return multipleDevicesError([]);
  }
  if (UNAUTHORIZED_PATTERNS.some((pattern) => pattern.test(stderr))) {
    return unauthorizedError(context.serial);
  }
  if (OFFLINE_PATTERNS.some((pattern) => pattern.test(stderr))) {
    return offlineError(context.serial);
  }
  if (NO_DEVICE_PATTERNS.some((pattern) => pattern.test(stderr))) {
    return noDeviceError(context.serial);
  }
  return commandFailedError({
    stderr,
    exitCode: failure.exitCode,
    ...(context.operation !== undefined ? { operation: context.operation } : {}),
  });
}
