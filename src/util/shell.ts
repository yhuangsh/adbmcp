/**
 * Quote a token so a device-side shell (Android's mksh/sh via `adb shell`) sees
 * it as a single literal argument. Values that need no quoting are left alone so
 * the generated command stays readable in logs.
 */
const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function quoteForDeviceShell(token: string): string {
  if (token.length > 0 && SAFE_TOKEN.test(token)) return token;
  return `'${token.replaceAll("'", "'\\''")}'`;
}
