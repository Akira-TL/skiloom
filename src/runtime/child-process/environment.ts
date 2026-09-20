import process from "node:process";

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
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const restricted: NodeJS.ProcessEnv = {};
  const seen = new Set<string>();

  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) {
      continue;
    }
    const lookup =
      platform === "win32"
        ? key.toUpperCase()
        : key;
    if (
      !ALLOWED_CHILD_ENVIRONMENT_KEYS.has(lookup) ||
      seen.has(lookup)
    ) {
      continue;
    }
    seen.add(lookup);
    restricted[key] = value;
  }
  return restricted;
}
