import { parse as parseToml, TomlDate } from "smol-toml";

import {
  productError,
  type ProductError,
  type Result
} from "../errors/index.js";
import {
  admitSkillPackage,
  type InvalidSkillPackage
} from "../package/index.js";

export type RepositoryDiscoveryConfig = Readonly<{
  include: ReadonlyArray<string>;
  exclude: ReadonlyArray<string>;
}>;

export type RepositoryFileFact = Readonly<{
  path: string;
  content: string;
}>;

export type DiscoveredSkillPackage = Readonly<{
  name: string;
  description: string;
  packageRoot: string;
}>;

export type RepositoryDiscoveryInput = Readonly<{
  repositoryRootBasename: string;
  repositoryMetadata?: string | undefined;
  files: ReadonlyArray<RepositoryFileFact>;
}>;

export type DiscoveryPatternErrorReason =
  | "absolute-path"
  | "parent-segment"
  | "unsupported-syntax";

export type InvalidDiscoveryPattern = ProductError<
  "InvalidDiscoveryPattern",
  Readonly<{
    field: "include" | "exclude";
    pattern: string;
    reason: DiscoveryPatternErrorReason;
  }>
>;

export type RepositoryDiscoveryError =
  | RepositoryMetadataError
  | InvalidSkillPackage
  | InvalidDiscoveryPattern
  | ProductError<
      "AmbiguousPackageDiscovery",
      Readonly<{
        packageName: string;
        packageRoots: ReadonlyArray<string>;
      }>
    >;

export type RepositoryMetadataErrorReason =
  | "invalid-toml"
  | "discovery-not-table"
  | "include-not-string-array"
  | "exclude-not-string-array";

export type RepositoryMetadataError =
  | ProductError<
      "MissingRepositoryMetadataSchema",
      Readonly<Record<string, never>>
    >
  | ProductError<
      "InvalidRepositoryMetadataSchema",
      Readonly<{ actualType: string }>
    >
  | ProductError<
      "UnsupportedRepositoryMetadataSchema",
      Readonly<{ schema: number }>
    >
  | ProductError<
      "UnknownRepositoryMetadataField",
      Readonly<{ field: string }>
    >
  | ProductError<
      "UnknownRepositoryDiscoveryField",
      Readonly<{ field: string }>
    >
  | ProductError<
      "InvalidRepositoryMetadata",
      Readonly<{
        reason: RepositoryMetadataErrorReason;
        path: string;
      }>
    >;

const DEFAULT_DISCOVERY_CONFIG: RepositoryDiscoveryConfig = {
  include: ["**"],
  exclude: []
};

export function parseRepositoryMetadata(
  source: string | undefined
): Result<RepositoryDiscoveryConfig, RepositoryMetadataError> {
  if (source === undefined) {
    return {
      ok: true,
      value: cloneDefaultDiscoveryConfig()
    };
  }

  let parsedDocument: unknown;
  try {
    parsedDocument = parseToml(source, {
      integersAsBigInt: true,
      maxDepth: 100
    });
  } catch {
    return invalidRepositoryMetadata("invalid-toml", "$");
  }

  if (!isTomlTable(parsedDocument)) {
    return invalidRepositoryMetadata("invalid-toml", "$");
  }
  const document = parsedDocument;

  if (!("schema" in document)) {
    return {
      ok: false,
      error: productError("MissingRepositoryMetadataSchema", {})
    };
  }

  const schema = document.schema;
  if (typeof schema !== "bigint" || schema <= 0n) {
    return {
      ok: false,
      error: productError("InvalidRepositoryMetadataSchema", {
        actualType: typeof schema
      })
    };
  }
  if (schema !== 1n) {
    return {
      ok: false,
      error: productError("UnsupportedRepositoryMetadataSchema", {
        schema: Number(schema)
      })
    };
  }

  const unknownField = firstUnknownField(document, ["schema", "discovery"]);
  if (unknownField !== undefined) {
    return {
      ok: false,
      error: productError("UnknownRepositoryMetadataField", {
        field: unknownField
      })
    };
  }

  if (document.discovery === undefined) {
    return {
      ok: true,
      value: cloneDefaultDiscoveryConfig()
    };
  }
  if (!isTomlTable(document.discovery)) {
    return invalidRepositoryMetadata("discovery-not-table", "discovery");
  }

  const discovery = document.discovery;
  const unknownDiscoveryField = firstUnknownField(discovery, [
    "include",
    "exclude"
  ]);
  if (unknownDiscoveryField !== undefined) {
    return {
      ok: false,
      error: productError("UnknownRepositoryDiscoveryField", {
        field: unknownDiscoveryField
      })
    };
  }

  let include: ReadonlyArray<string> = [
    ...DEFAULT_DISCOVERY_CONFIG.include
  ];
  if (discovery.include !== undefined) {
    if (!isStringArray(discovery.include)) {
      return invalidRepositoryMetadata(
        "include-not-string-array",
        "discovery.include"
      );
    }
    include = discovery.include.length === 0 ? ["**"] : [...discovery.include];
  }

  let exclude: ReadonlyArray<string> = [
    ...DEFAULT_DISCOVERY_CONFIG.exclude
  ];
  if (discovery.exclude !== undefined) {
    if (!isStringArray(discovery.exclude)) {
      return invalidRepositoryMetadata(
        "exclude-not-string-array",
        "discovery.exclude"
      );
    }
    exclude = [...discovery.exclude];
  }

  return {
    ok: true,
    value: {
      include,
      exclude
    }
  };
}

export function discoverRepositorySkills(
  input: RepositoryDiscoveryInput
): Result<ReadonlyArray<DiscoveredSkillPackage>, RepositoryDiscoveryError> {
  const metadataResult = parseRepositoryMetadata(input.repositoryMetadata);
  if (!metadataResult.ok) {
    return metadataResult;
  }

  const patternError = validateDiscoveryPatterns(metadataResult.value);
  if (patternError !== undefined) {
    return { ok: false, error: patternError };
  }

  const candidates = input.files
    .map((file) => ({ file, packageRoot: packageRootForSkillFile(file.path) }))
    .filter(
      (
        candidate
      ): candidate is Readonly<{
        file: RepositoryFileFact;
        packageRoot: string;
      }> => candidate.packageRoot !== undefined
    )
    .filter(({ packageRoot }) =>
      isSelectedPackageRoot(packageRoot, metadataResult.value)
    )
    .sort((left, right) => compareStrings(left.packageRoot, right.packageRoot));

  const discovered: DiscoveredSkillPackage[] = [];
  for (const candidate of candidates) {
    const rootBasename =
      candidate.packageRoot === "."
        ? input.repositoryRootBasename
        : basename(candidate.packageRoot);
    const admission = admitSkillPackage({
      rootBasename,
      skillMarkdown: candidate.file.content
    });
    if (!admission.ok) {
      return admission;
    }

    discovered.push({
      name: admission.value.name,
      description: admission.value.description,
      packageRoot: candidate.packageRoot
    });
  }

  discovered.sort((left, right) => {
    const nameOrder = compareStrings(left.name, right.name);
    return nameOrder !== 0
      ? nameOrder
      : compareStrings(left.packageRoot, right.packageRoot);
  });

  for (let index = 1; index < discovered.length; index += 1) {
    const previous = discovered[index - 1];
    const current = discovered[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      previous.name === current.name
    ) {
      const packageRoots: string[] = [previous.packageRoot, current.packageRoot];
      let nextIndex = index + 1;
      while (discovered[nextIndex]?.name === current.name) {
        const duplicate = discovered[nextIndex];
        if (duplicate !== undefined) {
          packageRoots.push(duplicate.packageRoot);
        }
        nextIndex += 1;
      }

      return {
        ok: false,
        error: productError("AmbiguousPackageDiscovery", {
          packageName: current.name,
          packageRoots
        })
      };
    }
  }

  return { ok: true, value: discovered };
}

function validateDiscoveryPatterns(
  config: RepositoryDiscoveryConfig
): InvalidDiscoveryPattern | undefined {
  for (const field of ["include", "exclude"] as const) {
    for (const pattern of config[field]) {
      const reason = invalidPatternReason(pattern);
      if (reason !== undefined) {
        return productError("InvalidDiscoveryPattern", {
          field,
          pattern,
          reason
        });
      }
    }
  }

  return undefined;
}

function invalidPatternReason(
  pattern: string
): DiscoveryPatternErrorReason | undefined {
  if (
    pattern.startsWith("/") ||
    /^[A-Za-z]:\//u.test(pattern)
  ) {
    return "absolute-path";
  }

  const segments = pattern.split("/");
  if (segments.includes("..")) {
    return "parent-segment";
  }

  if (
    pattern.length === 0 ||
    pattern.startsWith("!") ||
    /[\[\]{}]/u.test(pattern) ||
    /[?*+@!]\(/u.test(pattern)
  ) {
    return "unsupported-syntax";
  }

  return undefined;
}

function packageRootForSkillFile(path: string): string | undefined {
  if (path === "SKILL.md") {
    return ".";
  }

  const suffix = "/SKILL.md";
  if (!path.endsWith(suffix)) {
    return undefined;
  }

  const root = path.slice(0, -suffix.length);
  return root.length === 0 ? undefined : root;
}

function isSelectedPackageRoot(
  packageRoot: string,
  config: RepositoryDiscoveryConfig
): boolean {
  const included = config.include.some((pattern) =>
    matchesDiscoveryPattern(pattern, packageRoot)
  );
  if (!included) {
    return false;
  }

  return !config.exclude.some((pattern) =>
    matchesDiscoveryPattern(pattern, packageRoot)
  );
}

function matchesDiscoveryPattern(pattern: string, packageRoot: string): boolean {
  const patternSegments = pattern === "." ? [] : pattern.split("/");
  const pathSegments = packageRoot === "." ? [] : packageRoot.split("/");
  const memo = new Map<string, boolean>();

  const matchAt = (patternIndex: number, pathIndex: number): boolean => {
    const key = `${patternIndex}:${pathIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }

    let result: boolean;
    if (patternIndex === patternSegments.length) {
      result = pathIndex === pathSegments.length;
    } else {
      const patternSegment = patternSegments[patternIndex];
      if (patternSegment === "**") {
        result =
          matchAt(patternIndex + 1, pathIndex) ||
          (pathIndex < pathSegments.length && matchAt(patternIndex, pathIndex + 1));
      } else {
        const pathSegment = pathSegments[pathIndex];
        result =
          pathSegment !== undefined &&
          patternSegment !== undefined &&
          matchesDiscoverySegment(patternSegment, pathSegment) &&
          matchAt(patternIndex + 1, pathIndex + 1);
      }
    }

    memo.set(key, result);
    return result;
  };

  return matchAt(0, 0);
}

function matchesDiscoverySegment(pattern: string, value: string): boolean {
  const patternCharacters = Array.from(pattern);
  const valueCharacters = Array.from(value);
  const memo = new Map<string, boolean>();

  const matchAt = (patternIndex: number, valueIndex: number): boolean => {
    const key = `${patternIndex}:${valueIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }

    let result: boolean;
    if (patternIndex === patternCharacters.length) {
      result = valueIndex === valueCharacters.length;
    } else {
      const character = patternCharacters[patternIndex];
      if (character === "*") {
        result =
          matchAt(patternIndex + 1, valueIndex) ||
          (valueIndex < valueCharacters.length && matchAt(patternIndex, valueIndex + 1));
      } else if (character === "?") {
        result =
          valueIndex < valueCharacters.length &&
          matchAt(patternIndex + 1, valueIndex + 1);
      } else {
        result =
          valueCharacters[valueIndex] === character &&
          matchAt(patternIndex + 1, valueIndex + 1);
      }
    }

    memo.set(key, result);
    return result;
  };

  return matchAt(0, 0);
}

function basename(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1] ?? "";
}

function invalidRepositoryMetadata(
  reason: RepositoryMetadataErrorReason,
  path: string
): Result<never, RepositoryMetadataError> {
  return {
    ok: false,
    error: productError("InvalidRepositoryMetadata", {
      reason,
      path
    })
  };
}

function cloneDefaultDiscoveryConfig(): RepositoryDiscoveryConfig {
  return {
    include: [...DEFAULT_DISCOVERY_CONFIG.include],
    exclude: [...DEFAULT_DISCOVERY_CONFIG.exclude]
  };
}

function firstUnknownField(
  value: Readonly<Record<string, unknown>>,
  allowedFields: ReadonlyArray<string>
): string | undefined {
  const allowed = new Set(allowedFields);
  return Object.keys(value)
    .filter((field) => !allowed.has(field))
    .sort(compareStrings)[0];
}

function isTomlTable(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value) && !(value instanceof TomlDate);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
