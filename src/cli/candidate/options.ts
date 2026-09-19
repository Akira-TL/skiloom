import process from "node:process";

import {
  resolveCliTarget,
  type ResolvedCliTarget
} from "../target-selector.js";

export type CliTargetedCandidateOptions = Readonly<{
  target: ResolvedCliTarget;
  plan: boolean;
  yes: boolean;
  allowReleaseRetarget: boolean;
  nonInteractive: boolean;
  json: boolean;
}>;

export type ParseCliCandidateOptionsResult =
  | Readonly<{
      ok: true;
      value: CliTargetedCandidateOptions;
    }>
  | Readonly<{
      ok: false;
      reason: string;
    }>;

export function parseCliCandidateOptions(
  argv: ReadonlyArray<string>,
  json: boolean
): ParseCliCandidateOptionsResult {
  let target: string | undefined;
  let host: string | undefined;
  let scope: string | undefined;
  let plan = false;
  let yes = false;
  let allowReleaseRetarget = false;
  let nonInteractive = false;
  const seenFlags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (
      option === "--plan" ||
      option === "--yes" ||
      option === "--allow-release-retarget" ||
      option === "--non-interactive"
    ) {
      if (seenFlags.has(option)) {
        return {
          ok: false,
          reason: "duplicate " + option
        };
      }
      seenFlags.add(option);
      if (option === "--plan") {
        plan = true;
      } else if (option === "--yes") {
        yes = true;
      } else if (option === "--allow-release-retarget") {
        allowReleaseRetarget = true;
      } else {
        nonInteractive = true;
      }
      continue;
    }

    if (
      option !== "--target" &&
      option !== "--host" &&
      option !== "--scope"
    ) {
      return {
        ok: false,
        reason: "unknown option: " + option
      };
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return {
        ok: false,
        reason: "missing value for " + option
      };
    }
    index += 1;

    if (option === "--target") {
      if (target !== undefined) {
        return {
          ok: false,
          reason: "duplicate --target"
        };
      }
      target = value;
    } else if (option === "--host") {
      if (host !== undefined) {
        return {
          ok: false,
          reason: "duplicate --host"
        };
      }
      host = value;
    } else {
      if (scope !== undefined) {
        return {
          ok: false,
          reason: "duplicate --scope"
        };
      }
      scope = value;
    }
  }

  const resolved = resolveCliTarget({
    cwd: process.cwd(),
    ...(target === undefined ? {} : { target }),
    ...(host === undefined ? {} : { host }),
    ...(scope === undefined ? {} : { scope })
  });
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason };
  }

  return {
    ok: true,
    value: {
      target: resolved.value,
      plan,
      yes,
      allowReleaseRetarget,
      nonInteractive,
      json
    }
  };
}
