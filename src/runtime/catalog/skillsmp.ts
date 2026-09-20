import {
  parseRepositoryCoordinate
} from "../../domain/coordinate/index.js";
import {
  productError,
  type ProductError,
  type Result
} from "../../domain/errors/index.js";

const SEARCH_ENDPOINT =
  "https://skillsmp.com/api/v1/skills/search";
const SEARCH_TIMEOUT_MS = 10_000;

export type CatalogSignal = Readonly<{
  provider: "skillsmp";
  kind: "stars" | "language" | "updated-at";
  value: number | string;
}>;

export type CatalogCandidate = Readonly<{
  provider: "skillsmp";
  providerEntryId: string;
  name: string;
  description: string | null;
  displayUrl: string | null;
  githubRepository: string | null;
  githubPackagePathHint: string | null;
  installable: boolean;
  signals: ReadonlyArray<CatalogSignal>;
}>;

export type SkillsMpSearchResult = Readonly<{
  provider: "skillsmp";
  query: string;
  candidates: ReadonlyArray<CatalogCandidate>;
}>;

export type SkillsMpSearchFailureReason =
  | "timeout"
  | "authentication"
  | "rate-limit"
  | "provider-error"
  | "network"
  | "incompatible-response";

export type SkillsMpSearchAction =
  | "retry"
  | "retry-later"
  | "check-credentials"
  | "update-client";

export type SkillsMpSearchFailed = ProductError<
  "SkillsMpSearchFailed",
  Readonly<{
    provider: "skillsmp";
    reason: SkillsMpSearchFailureReason;
    status: number | null;
    action: SkillsMpSearchAction;
    retryable: boolean;
    fallback: "explicit-github-coordinate";
  }>
>;

export async function searchSkillsMp(
  query: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<
  Result<SkillsMpSearchResult, SkillsMpSearchFailed>
> {
  let response: Response;
  try {
    response = await fetchImpl(
      searchUrl(query),
      {
        method: "GET",
        headers: skillsMpHeaders(),
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
      }
    );
  } catch (error) {
    return failed(
      isTimeoutError(error) ? "timeout" : "network",
      null
    );
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return failed("authentication", response.status);
    }
    if (response.status === 429) {
      return failed("rate-limit", response.status);
    }
    return failed("provider-error", response.status);
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return failed(
      "incompatible-response",
      response.status
    );
  }
  const skills = parseSkillsResponse(raw);
  if (skills === undefined) {
    return failed(
      "incompatible-response",
      response.status
    );
  }

  return {
    ok: true,
    value: {
      provider: "skillsmp",
      query,
      candidates: skills.map(normalizeCandidate)
    }
  };
}

function searchUrl(query: string): string {
  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set("q", query);
  return url.toString();
}

function skillsMpHeaders(): Readonly<Record<string, string>> {
  const apiKey = process.env.SKILLSMP_API_KEY;
  return apiKey === undefined || apiKey.length === 0
    ? { accept: "application/json" }
    : {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`
      };
}

type RawSkill = Readonly<{
  id: string;
  name: string;
  description: string | null;
  githubUrl: string | null;
  skillUrl: string | null;
  stars: number | null;
  contentLanguage: string | null;
  updatedAt: string | null;
}>;

function parseSkillsResponse(
  value: unknown
): ReadonlyArray<RawSkill> | undefined {
  if (!isRecord(value) || value.success !== true) {
    return undefined;
  }
  if (!isRecord(value.data) || !Array.isArray(value.data.skills)) {
    return undefined;
  }

  const skills: RawSkill[] = [];
  for (const entry of value.data.skills) {
    const parsed = parseRawSkill(entry);
    if (parsed === undefined) {
      return undefined;
    }
    skills.push(parsed);
  }
  return skills;
}

function parseRawSkill(
  value: unknown
): RawSkill | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0
  ) {
    return undefined;
  }

  const description = nullableString(
    value.description
  );
  const githubUrl = nullableString(
    value.githubUrl
  );
  const skillUrl = nullableString(
    value.skillUrl
  );
  const contentLanguage = nullableString(
    value.contentLanguage
  );
  const updatedAt = nullableString(
    value.updatedAt
  );
  if (
    description === undefined ||
    githubUrl === undefined ||
    skillUrl === undefined ||
    contentLanguage === undefined ||
    updatedAt === undefined
  ) {
    return undefined;
  }

  const stars =
    value.stars === null || value.stars === undefined
      ? null
      : typeof value.stars === "number" &&
          Number.isSafeInteger(value.stars) &&
          value.stars >= 0
        ? value.stars
        : undefined;
  if (stars === undefined) {
    return undefined;
  }

  return {
    id: value.id,
    name: value.name,
    description,
    githubUrl,
    skillUrl,
    stars,
    contentLanguage,
    updatedAt
  };
}

function normalizeCandidate(
  skill: RawSkill
): CatalogCandidate {
  const github = normalizeGithubNomination(
    skill.githubUrl
  );
  const signals: CatalogSignal[] = [];
  if (skill.stars !== null) {
    signals.push({
      provider: "skillsmp",
      kind: "stars",
      value: skill.stars
    });
  }
  if (skill.contentLanguage !== null) {
    signals.push({
      provider: "skillsmp",
      kind: "language",
      value: skill.contentLanguage
    });
  }
  if (skill.updatedAt !== null) {
    signals.push({
      provider: "skillsmp",
      kind: "updated-at",
      value: skill.updatedAt
    });
  }

  return {
    provider: "skillsmp",
    providerEntryId: skill.id,
    name: skill.name,
    description: skill.description,
    displayUrl: skill.skillUrl,
    githubRepository:
      github?.repository ?? null,
    githubPackagePathHint:
      github?.packagePathHint ?? null,
    installable: github !== undefined,
    signals
  };
}

function normalizeGithubNomination(
  source: string | null
): Readonly<{
  repository: string;
  packagePathHint: string | null;
}> | undefined {
  if (source === null) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com"
  ) {
    return undefined;
  }

  const segments = url.pathname
    .split("/")
    .filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return undefined;
  }

  const owner = decodeGithubPathSegment(segments[0]!);
  const repo = decodeGithubPathSegment(segments[1]!);
  if (owner === undefined || repo === undefined) {
    return undefined;
  }

  const repository = parseRepositoryCoordinate(
    `${owner}/${repo}`
  );
  if (!repository.ok) {
    return undefined;
  }

  const packagePathHint =
    packagePathHintFromGithubSegments(segments);
  if (packagePathHint === undefined) {
    return undefined;
  }

  return {
    repository: repository.value.canonical,
    packagePathHint
  };
}

function packagePathHintFromGithubSegments(
  segments: ReadonlyArray<string>
): string | null | undefined {
  if (
    segments.length < 5 ||
    (segments[2] !== "tree" &&
      segments[2] !== "blob")
  ) {
    return null;
  }

  const pathSegments: string[] = [];
  for (const rawSegment of segments.slice(4)) {
    const segment = decodeGithubPathSegment(rawSegment);
    if (
      segment === undefined ||
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\")
    ) {
      return undefined;
    }
    pathSegments.push(segment);
  }

  if (
    segments[2] === "blob" &&
    pathSegments.at(-1) === "SKILL.md"
  ) {
    pathSegments.pop();
  }
  return pathSegments.length === 0
    ? null
    : pathSegments.join("/");
}

function decodeGithubPathSegment(
  segment: string
): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

function nullableString(
  value: unknown
): string | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string"
    ? value
    : undefined;
}

function failed(
  reason: SkillsMpSearchFailureReason,
  status: number | null
): Result<never, SkillsMpSearchFailed> {
  const guidance = failureGuidance(reason);
  return {
    ok: false,
    error: productError("SkillsMpSearchFailed", {
      provider: "skillsmp",
      reason,
      status,
      action: guidance.action,
      retryable: guidance.retryable,
      fallback: "explicit-github-coordinate"
    })
  };
}

function failureGuidance(
  reason: SkillsMpSearchFailureReason
): Readonly<{
  action: SkillsMpSearchAction;
  retryable: boolean;
}> {
  switch (reason) {
    case "authentication":
      return {
        action: "check-credentials",
        retryable: false
      };
    case "rate-limit":
      return {
        action: "retry-later",
        retryable: true
      };
    case "incompatible-response":
      return {
        action: "update-client",
        retryable: false
      };
    case "timeout":
    case "network":
    case "provider-error":
      return {
        action: "retry",
        retryable: true
      };
  }
}

function isTimeoutError(
  error: unknown
): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.name === "TimeoutError")
  );
}

function isRecord(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
