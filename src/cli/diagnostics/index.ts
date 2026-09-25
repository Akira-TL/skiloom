import {
  productError,
  type ProductError
} from "../../domain/errors/index.js";
import type {
  SkillsMpSearchFailed
} from "../../runtime/catalog/skillsmp.js";
import type {
  GitHubRateLimited
} from "../../runtime/source/github/index.js";
import type {
  TargetCopyRequiresSyncOrFork
} from "../status.js";
import type {
  ResolvedCliTarget
} from "../target-selector.js";

export type CatalogProviderProvenance =
  ProductError<
    "CatalogProviderProvenance",
    Readonly<{
      provider: "skillsmp";
      role: "discovery-only";
    }>
  >;

export type HostPresetHint = ProductError<
  "HostPresetHint",
  Readonly<{
    host: NonNullable<ResolvedCliTarget["host"]>;
    scope: ResolvedCliTarget["scope"];
    kind: "capability" | "risk";
    hint:
      | "directory-symlink-documented"
      | "directory-symlink-worktree-not-guaranteed";
    provenance: "host-target-presets-v0";
  }>
>;

export function catalogProviderWarnings():
ReadonlyArray<CatalogProviderProvenance> {
  return [
    productError("CatalogProviderProvenance", {
      provider: "skillsmp",
      role: "discovery-only"
    })
  ];
}

export function hostPresetWarnings(
  target: ResolvedCliTarget
): ReadonlyArray<HostPresetHint> {
  if (target.host === null) {
    return [];
  }

  const hint =
    target.host === "opencode"
      ? {
          kind: "risk" as const,
          hint:
            "directory-symlink-worktree-not-guaranteed" as const
        }
      : {
          kind: "capability" as const,
          hint: "directory-symlink-documented" as const
        };

  return [
    productError("HostPresetHint", {
      host: target.host,
      scope: target.scope,
      ...hint,
      provenance: "host-target-presets-v0"
    })
  ];
}

export function formatDiagnosticWarning(
  warning: ProductError
): string | undefined {
  if (warning.code === "CatalogProviderProvenance") {
    return (
      "Notice [SkillsMP]: Catalog results are discovery-only; " +
      "Skiloom re-verifies explicit GitHub source facts."
    );
  }
  if (warning.code !== "HostPresetHint") {
    return undefined;
  }

  const facts = warning.facts as HostPresetHint["facts"];
  if (facts.kind === "risk") {
    return (
      "Warning [" + facts.host + "]: directory symlink " +
      "discovery is not guaranteed in git-worktree " +
      "sandboxes; this hint does not choose Skiloom " +
      "Target materialization."
    );
  }
  return (
    "Hint [" + facts.host + "]: directory symlink support " +
    "is documented; this hint does not choose Skiloom " +
    "Target materialization."
  );
}

function formatUnixInstant(
  unixSeconds: number
): string | undefined {
  const date = new Date(unixSeconds * 1000);
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toISOString();
}

export function formatDiagnosticFailure(
  error: ProductError,
  exitCode: number
): string | undefined {
  if (error.code === "TargetCopyRequiresSyncOrFork") {
    const facts =
      error.facts as TargetCopyRequiresSyncOrFork["facts"];
    return (
      "skiloom: Target copy generation " +
      facts.markerGeneration +
      " is behind Registry generation " +
      facts.registryGeneration +
      "; run skiloom sync or skiloom fork for this Target " +
      "before continuing (exit " + exitCode + ")"
    );
  }
  if (error.code === "GitHubRateLimited") {
    const facts = error.facts as GitHubRateLimited["facts"];
    const resetInstant =
      facts.resetAtUnixSeconds === null
        ? undefined
        : formatUnixInstant(facts.resetAtUnixSeconds);
    const retry =
      facts.retryAfterSeconds !== null
        ? "retry after " + facts.retryAfterSeconds + " seconds"
        : resetInstant === undefined
          ? "retry later"
          : "retry after " + resetInstant;
    return (
      "skiloom: GitHub rate limit reached (HTTP " +
      facts.status +
      "); " +
      retry +
      ", or set GH_TOKEN/GITHUB_TOKEN for authenticated " +
      "GitHub access (exit " + exitCode + ")"
    );
  }

  if (error.code !== "SkillsMpSearchFailed") {
    return undefined;
  }

  const facts = error.facts as SkillsMpSearchFailed["facts"];
  const status =
    facts.status === null
      ? ""
      : " (HTTP " + facts.status + ")";

  let guidance: string;
  switch (facts.reason) {
    case "authentication":
      guidance =
        "authentication failed" + status +
        "; check SKILLSMP_API_KEY";
      break;
    case "rate-limit":
      guidance =
        "rate limit reached" + status +
        "; retry later";
      break;
    case "incompatible-response":
      guidance =
        "response schema is incompatible" + status +
        "; update Skiloom";
      break;
    case "timeout":
      guidance =
        "search timed out; retry the search";
      break;
    case "network":
      guidance =
        "network request failed; retry the search";
      break;
    case "provider-error":
      guidance =
        "provider request failed" + status +
        "; retry the search";
      break;
  }

  return (
    "skiloom: SkillsMP " + guidance +
    ", or use an explicit GitHub coordinate " +
    "(exit " + exitCode + ")"
  );
}
