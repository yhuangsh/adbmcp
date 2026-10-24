/**
 * Environment-driven configuration and server-side guardrails (design §6).
 *
 * Guardrails are authoritative: MCP annotations are advisory hints for the host,
 * while the checks here are what actually blocks an operation.
 */

export const DEFAULT_SHELL_BLOCKED_PATTERNS: readonly string[] = [
  // Guardrail, not a sandbox: it stops accidents and obvious misuse (reboot, root
  // escalation, piped-in shell scripts, filesystem destruction) without forking the
  // server. A deliberately evasive command can still get through — pair it with
  // ADBMCP_SHELL_ALLOWED_PREFIXES.
  // Reboot / power state changes.
  '(?:^|[;&|])\\s*reboot(?:\\s|$)',
  // Recursive force delete of the filesystem root.
  '\\brm\\s+-[a-z]*r[a-z]*f[a-z]*\\s+/+(?:\\s|$)',
  '\\brm\\s+-[a-z]*f[a-z]*r[a-z]*\\s+/+(?:\\s|$)',
  // Root deletion split across flags, reordered, or with a glob: rm -r -f /,
  // rm -f -r /, rm -rf /*. Kept separate from the two patterns above because a
  // glob after the root defeats their end anchor.
  '\\brm\\s+(?:-[A-Za-z-]+\\s+)+/+\\*?(?=\\s|$|[;&|)`])',
  // Piping downloaded or generated content into a shell: curl … | sh, … | sudo -E bash.
  // Matches sh/bash/mksh/dash (mksh is the actual Android shell binary). Two forms:
  // - spaced pipe (the realistic pipe-into-shell shape): full separator-aware lookahead
  //   excludes descriptor names (shasum, shellcheck) and quoted grep alternation
  //   such as grep -E 'sh|bash|zsh' or grep -E '(sh|bash)'.
  // - unspaced pipe (curl|sh): end-of-token lookahead only, so quoted alternations keep
  //   working; residual loss: unspaced `curl|sh;` and `$(curl|sh)` pass.
  // Textual matching caveat: patterns see the raw command text, including inside quotes.
  '\\|\\s+(?:(?:sudo|su)\\s+(?:-\\S+\\s+)*)?(?:ba|mk|da)?sh\\b(?=\\s|$|[;&|)`])',
  '\\|(?:(?:sudo|su)\\s+(?:-\\S+\\s+)*)?(?:ba|mk|da)?sh\\b(?=\\s|$)',
  // Privilege escalation; adbmcp never escalates on its own (design §6).
  '(?:^|[;&|])\\s*su(?:\\s|$)',
  '(?:^|[;&|])\\s*mkfs',
  '(?:^|[;&|])\\s*wipe(?:\\s|$)',
];

export const DEFAULT_PUSH_ALLOWED_ROOTS: readonly string[] = [
  '/sdcard',
  '/storage/emulated/0',
  '/data/local/tmp',
];

export const DEFAULT_LOG_TIMESTAMP_FORMAT = 'threadtime';

/**
 * Component ids of IMEs that accept the ADB_INPUT_B64 broadcast (issue #3):
 * ADB Keyboard is the reference implementation and the default.
 */
export const DEFAULT_IME_BROADCAST_COMPONENTS: readonly string[] = [
  'com.android.adbkeyboard/.AdbIME',
];

/** How type_text handles non-ASCII text (ADBMCP_TYPE_TEXT_NON_ASCII, issue #3). */
export type NonAsciiMode = 'ime' | 'reject';

export interface ShellPolicy {
  /** Regex sources; a command matching any of them is refused. */
  blockedPatterns: string[];
  /** When set, a command must start with one of these prefixes to be allowed. */
  allowedPrefixes: string[] | null;
}

export interface AdbmcpConfig {
  /** adb binary (ADB_PATH), default "adb" resolved from PATH. */
  adbPath: string;
  /** Serial allowlist (ADBMCP_ALLOWED_DEVICES); null means "all devices allowed". */
  allowedDevices: string[] | null;
  shell: ShellPolicy;
  /** Remote roots push_file may write to (ADBMCP_PUSH_ALLOWED_ROOTS). */
  pushAllowedRoots: string[];
  /**
   * Packages clear_app_data may wipe (ADBMCP_CLEAR_ALLOWED_PACKAGES).
   * Empty means "refuse every clear": the allowlist has no allow-all mode.
   */
  clearAllowedPackages: string[];
  limits: {
    defaultTimeoutMs: number;
    maxOutputBytes: number;
  };
  logcat: {
    /** Ring-buffer cap per logcat stream, in bytes. */
    bufferBytes: number;
    format: string;
  };
  input: {
    /**
     * How type_text handles non-ASCII text (ADBMCP_TYPE_TEXT_NON_ASCII):
     * 'ime' (default) sends the ADB_INPUT_B64 broadcast when a capable IME is
     * active; 'reject' fails with TEXT_NOT_ASCII (issue #3 option 2).
     */
    nonAscii: NonAsciiMode;
    /**
     * Component ids of IMEs that accept the ADB_INPUT_B64 broadcast
     * (ADBMCP_IME_BROADCAST_COMPONENTS, comma-separated).
     */
    imeBroadcastComponents: string[];
  };
}

export const DEFAULTS = {
  adbPath: 'adb',
  defaultTimeoutMs: 30_000,
  maxOutputBytes: 64 * 1024,
  logcatBufferBytes: 1024 * 1024,
} as const;

function parseList(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : null;
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received "${value}".`);
  }
  return parsed;
}

function parseNonAsciiMode(value: string | undefined): NonAsciiMode {
  if (value === undefined || value.trim() === '') return 'ime';
  const trimmed = value.trim();
  if (trimmed === 'ime' || trimmed === 'reject') return trimmed;
  throw new Error(`ADBMCP_TYPE_TEXT_NON_ASCII must be "ime" or "reject", received "${value}".`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdbmcpConfig {
  const adbPath = env['ADB_PATH']?.trim();
  return {
    adbPath: adbPath && adbPath.length > 0 ? adbPath : DEFAULTS.adbPath,
    allowedDevices: parseList(env['ADBMCP_ALLOWED_DEVICES']),
    shell: {
      blockedPatterns: parseList(env['ADBMCP_SHELL_BLOCKED_PATTERNS']) ?? [
        ...DEFAULT_SHELL_BLOCKED_PATTERNS,
      ],
      allowedPrefixes: parseList(env['ADBMCP_SHELL_ALLOWED_PREFIXES']),
    },
    pushAllowedRoots: parseList(env['ADBMCP_PUSH_ALLOWED_ROOTS']) ?? [...DEFAULT_PUSH_ALLOWED_ROOTS],
    clearAllowedPackages: parseList(env['ADBMCP_CLEAR_ALLOWED_PACKAGES']) ?? [],
    limits: {
      defaultTimeoutMs: parsePositiveInt(
        env['ADBMCP_TIMEOUT_MS'],
        DEFAULTS.defaultTimeoutMs,
        'ADBMCP_TIMEOUT_MS',
      ),
      maxOutputBytes: parsePositiveInt(
        env['ADBMCP_MAX_OUTPUT_BYTES'],
        DEFAULTS.maxOutputBytes,
        'ADBMCP_MAX_OUTPUT_BYTES',
      ),
    },
    logcat: {
      bufferBytes: parsePositiveInt(
        env['ADBMCP_LOGCAT_BUFFER_BYTES'],
        DEFAULTS.logcatBufferBytes,
        'ADBMCP_LOGCAT_BUFFER_BYTES',
      ),
      format: DEFAULT_LOG_TIMESTAMP_FORMAT,
    },
    input: {
      nonAscii: parseNonAsciiMode(env['ADBMCP_TYPE_TEXT_NON_ASCII']),
      imeBroadcastComponents:
        parseList(env['ADBMCP_IME_BROADCAST_COMPONENTS']) ?? [...DEFAULT_IME_BROADCAST_COMPONENTS],
    },
  };
}

export class GuardrailError extends Error {
  readonly rule: string;

  constructor(rule: string, message: string) {
    super(message);
    this.name = 'GuardrailError';
    this.rule = rule;
  }
}

/**
 * Enforce the `shell` tool guardrails. Patterns are JavaScript regex sources
 * tested against the whole command string (case-sensitive).
 */
export function assertShellCommandAllowed(command: string, policy: ShellPolicy): void {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    throw new GuardrailError('shell.empty', 'The shell command is empty.');
  }
  for (const source of policy.blockedPatterns) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(source);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new GuardrailError(
        'shell.blockedPatterns',
        `ADBMCP_SHELL_BLOCKED_PATTERNS contains an invalid regular expression "${source}": ${detail}`,
      );
    }
    if (pattern.test(trimmed)) {
      throw new GuardrailError(
        'shell.blocked',
        `Command refused by adbmcp shell guardrail (matched /${source}/). Reboot, privilege escalation, pipe-to-shell and filesystem-destroying commands are blocked by default; this is a guardrail, not a sandbox, and a maintainer can override it with ADBMCP_SHELL_BLOCKED_PATTERNS.`,
      );
    }
  }
  if (policy.allowedPrefixes) {
    const allowed = policy.allowedPrefixes.some((prefix) => trimmed.startsWith(prefix));
    if (!allowed) {
      throw new GuardrailError(
        'shell.prefix',
        `Command refused: ADBMCP_SHELL_ALLOWED_PREFIXES is set, so commands must start with one of: ${policy.allowedPrefixes.join(', ')}.`,
      );
    }
  }
}

/**
 * Enforce the `clear_app_data` package allowlist. Unlike the device and push
 * allowlists there is no allow-all default: an unset variable refuses every
 * clear, because the operation is irreversible for the user's data.
 */
export function assertClearPackageAllowed(packageName: string, allowedPackages: string[]): void {
  if (allowedPackages.includes(packageName)) return;
  const configured = allowedPackages.length > 0 ? allowedPackages.join(', ') : 'unset (empty)';
  throw new GuardrailError(
    'clear.notAllowed',
    `clear_app_data refused for "${packageName}": ADBMCP_CLEAR_ALLOWED_PACKAGES is ${configured}. Add the package name (comma-separated) to ADBMCP_CLEAR_ALLOWED_PACKAGES to allow clearing its data.`,
  );
}

/** Normalize an absolute device path for containment checks (no trailing slash). */
function normalizeRemotePath(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, '/');
  const withoutTrailing = collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
  return withoutTrailing;
}

/** True when `remotePath` is inside one of the allowed remote roots. */
export function isRemotePathAllowed(remotePath: string, allowedRoots: string[]): boolean {
  if (!remotePath.startsWith('/')) return false;
  if (remotePath.split('/').includes('..')) return false;
  const normalized = normalizeRemotePath(remotePath);
  return allowedRoots.some((root) => {
    const normalizedRoot = normalizeRemotePath(root);
    return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
  });
}
