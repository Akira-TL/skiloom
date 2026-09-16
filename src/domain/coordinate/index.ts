import {
  productError,
  type ProductError,
  type Result
} from "../errors/index.js";

export type RepositoryCoordinate = Readonly<{
  owner: string;
  repo: string;
  canonical: string;
}>;

export type PackageCoordinate = Readonly<{
  repository: RepositoryCoordinate;
  packageName: string;
  canonical: string;
}>;

export type CoordinateErrorReason =
  | "segment-count"
  | "empty-segment"
  | "transport-syntax"
  | "git-suffix"
  | "invalid-package-name";

export type InvalidRepositoryCoordinate = ProductError<
  "InvalidRepositoryCoordinate",
  Readonly<{
    input: string;
    reason: Exclude<CoordinateErrorReason, "invalid-package-name">;
  }>
>;

export type InvalidPackageCoordinate = ProductError<
  "InvalidPackageCoordinate",
  Readonly<{
    input: string;
    reason: CoordinateErrorReason;
  }>
>;

const TRANSPORT_MARKERS = ["://", "?", "#", "@"] as const;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_SKILL_NAME_LENGTH = 64;

export function parseRepositoryCoordinate(
  input: string
): Result<RepositoryCoordinate, InvalidRepositoryCoordinate> {
  const structuralError = validateCoordinateStructure(input, 2);
  if (structuralError !== undefined) {
    return {
      ok: false,
      error: productError("InvalidRepositoryCoordinate", {
        input,
        reason: structuralError
      })
    };
  }

  const [ownerInput, repoInput] = input.split("/");
  if (ownerInput === undefined || repoInput === undefined) {
    return {
      ok: false,
      error: productError("InvalidRepositoryCoordinate", {
        input,
        reason: "segment-count"
      })
    };
  }

  if (repoInput.endsWith(".git")) {
    return {
      ok: false,
      error: productError("InvalidRepositoryCoordinate", {
        input,
        reason: "git-suffix"
      })
    };
  }

  const owner = asciiLowercase(ownerInput);
  const repo = asciiLowercase(repoInput);

  return {
    ok: true,
    value: {
      owner,
      repo,
      canonical: `${owner}/${repo}`
    }
  };
}

export function parsePackageCoordinate(
  input: string
): Result<PackageCoordinate, InvalidPackageCoordinate> {
  const structuralError = validateCoordinateStructure(input, 3);
  if (structuralError !== undefined) {
    return {
      ok: false,
      error: productError("InvalidPackageCoordinate", {
        input,
        reason: structuralError
      })
    };
  }

  const [ownerInput, repoInput, packageName] = input.split("/");
  if (
    ownerInput === undefined ||
    repoInput === undefined ||
    packageName === undefined
  ) {
    return {
      ok: false,
      error: productError("InvalidPackageCoordinate", {
        input,
        reason: "segment-count"
      })
    };
  }

  if (repoInput.endsWith(".git")) {
    return {
      ok: false,
      error: productError("InvalidPackageCoordinate", {
        input,
        reason: "git-suffix"
      })
    };
  }

  if (!isValidSkillName(packageName)) {
    return {
      ok: false,
      error: productError("InvalidPackageCoordinate", {
        input,
        reason: "invalid-package-name"
      })
    };
  }

  const owner = asciiLowercase(ownerInput);
  const repo = asciiLowercase(repoInput);
  const repository = {
    owner,
    repo,
    canonical: `${owner}/${repo}`
  } satisfies RepositoryCoordinate;

  return {
    ok: true,
    value: {
      repository,
      packageName,
      canonical: `${repository.canonical}/${packageName}`
    }
  };
}

export function isValidSkillName(name: string): boolean {
  return (
    name.length >= 1 &&
    name.length <= MAX_SKILL_NAME_LENGTH &&
    SKILL_NAME_PATTERN.test(name)
  );
}

export function asciiLowercase(value: string): string {
  let result = "";

  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && code >= 0x41 && code <= 0x5a) {
      result += String.fromCodePoint(code + 0x20);
    } else {
      result += character;
    }
  }

  return result;
}

function validateCoordinateStructure(
  input: string,
  segmentCount: number
): Exclude<CoordinateErrorReason, "invalid-package-name" | "git-suffix"> | undefined {
  if (TRANSPORT_MARKERS.some((marker) => input.includes(marker))) {
    return "transport-syntax";
  }

  const segments = input.split("/");
  if (segments.length !== segmentCount) {
    return "segment-count";
  }

  if (segments.some((segment) => segment.length === 0)) {
    return "empty-segment";
  }

  return undefined;
}
