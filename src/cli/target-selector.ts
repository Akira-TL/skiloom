import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type CliHostPreset =
  | "codex"
  | "claude"
  | "gemini"
  | "opencode";

export type CliTargetScope = "workspace" | "user";

export type ResolvedCliTarget = Readonly<{
  path: string;
  source: "default" | "explicit" | "host";
  host: CliHostPreset | null;
  scope: CliTargetScope;
}>;

export type ResolveCliTargetInput = Readonly<{
  cwd: string;
  userHome?: string;
  target?: string;
  host?: string;
  scope?: string;
}>;

export type ResolveCliTargetResult =
  | Readonly<{ ok: true; value: ResolvedCliTarget }>
  | Readonly<{
      ok: false;
      reason: string;
    }>;

export function resolveCliTarget(
  input: ResolveCliTargetInput
): ResolveCliTargetResult {
  if (
    input.target !== undefined &&
    (input.host !== undefined || input.scope !== undefined)
  ) {
    return {
      ok: false,
      reason: "--target is mutually exclusive with --host/--scope"
    };
  }

  const scope = input.scope ?? "workspace";
  if (scope !== "workspace" && scope !== "user") {
    return {
      ok: false,
      reason: `invalid --scope: ${scope}`
    };
  }

  if (input.target !== undefined) {
    return {
      ok: true,
      value: {
        path: resolve(input.cwd, input.target),
        source: "explicit",
        host: null,
        scope: "workspace"
      }
    };
  }

  const host = input.host;
  if (
    host !== undefined &&
    host !== "codex" &&
    host !== "claude" &&
    host !== "gemini" &&
    host !== "opencode"
  ) {
    return {
      ok: false,
      reason: `invalid --host: ${host}`
    };
  }

  const userHome = resolve(input.userHome ?? homedir());
  const base =
    scope === "workspace"
      ? resolve(input.cwd)
      : userHome;
  const targetPath =
    host === "claude"
      ? join(base, ".claude", "skills")
      : join(base, ".agents", "skills");

  return {
    ok: true,
    value: {
      path: targetPath,
      source: host === undefined ? "default" : "host",
      host: host ?? null,
      scope
    }
  };
}
