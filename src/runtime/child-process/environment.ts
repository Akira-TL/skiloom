const ALLOWED_CHILD_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE"
]);

export function restrictedChildProcessEnvironment(
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const restricted: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (
      value !== undefined &&
      ALLOWED_CHILD_ENVIRONMENT_KEYS.has(
        key.toUpperCase()
      )
    ) {
      restricted[key] = value;
    }
  }
  return restricted;
}
