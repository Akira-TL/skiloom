import {
  productError,
  type ProductError,
  type Result
} from "../errors/index.js";

const ASCII_WHITESPACE = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/gu;
const ASCII_WHITESPACE_CHARACTER = /[\t\n\v\f\r ]/u;
const IDENTIFIER_PATTERN = /^[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/u;
const NUMERIC_PATTERN = /^[0-9]+$/u;
const PARTIAL_VERSION_PATTERN = /^([0-9]+)(?:\.([0-9]+))?(?:\.([0-9]+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const FULL_VERSION_PATTERN = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

type ComparatorOperator =
  | "caret"
  | "tilde"
  | "exact"
  | "greater"
  | "greater-equal"
  | "less"
  | "less-equal"
  | "wildcard";

export type ReleaseVersion = Readonly<{
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: string;
  build: string;
  canonical: string;
}>;

export type ReleaseRequirementComparator = Readonly<{
  operator: ComparatorOperator;
  major: bigint;
  minor?: bigint;
  patch?: bigint;
  prerelease: string;
  canonical: string;
}>;

export type ReleaseRequirement = Readonly<{
  comparators: ReadonlyArray<ReleaseRequirementComparator>;
  canonical: string;
}>;

export type ReleaseRequirementErrorReason =
  | "empty"
  | "unsupported-union"
  | "unsupported-hyphen-range"
  | "missing-comma"
  | "invalid-wildcard"
  | "empty-comparator"
  | "invalid-comparator"
  | "invalid-version";

export type ReleaseVersionErrorReason = "invalid-version";

export type InvalidReleaseRequirement = ProductError<
  "InvalidReleaseRequirement",
  Readonly<{
    input: string;
    reason: ReleaseRequirementErrorReason;
  }>
>;

export type InvalidReleaseVersion = ProductError<
  "InvalidReleaseVersion",
  Readonly<{
    input: string;
    reason: ReleaseVersionErrorReason;
  }>
>;

export function parseReleaseRequirement(
  input: string
): Result<ReleaseRequirement, InvalidReleaseRequirement> {
  const trimmed = trimAsciiWhitespace(input);
  if (trimmed.length === 0) {
    return invalidRequirement(input, "empty");
  }
  if (trimmed.includes("||")) {
    return invalidRequirement(input, "unsupported-union");
  }
  if (/[\t\n\v\f\r ]-[\t\n\v\f\r ]/u.test(trimmed)) {
    return invalidRequirement(input, "unsupported-hyphen-range");
  }

  const pieces = trimmed.split(",");
  if (pieces.some((piece) => trimAsciiWhitespace(piece).length === 0)) {
    return invalidRequirement(input, "empty-comparator");
  }

  if (pieces.length > 1 && pieces.some((piece) => trimAsciiWhitespace(piece) === "*")) {
    return invalidRequirement(input, "invalid-wildcard");
  }

  const byCanonical = new Map<string, ReleaseRequirementComparator>();
  for (const piece of pieces) {
    const parsed = parseComparator(trimAsciiWhitespace(piece));
    if (!parsed.ok) {
      return invalidRequirement(input, parsed.reason);
    }
    byCanonical.set(parsed.value.canonical, parsed.value);
  }

  if (byCanonical.size === 1 && byCanonical.has("*")) {
    return {
      ok: true,
      value: {
        comparators: [],
        canonical: "*"
      }
    };
  }

  const comparators = [...byCanonical.values()].sort((left, right) =>
    compareUtf8(left.canonical, right.canonical)
  );

  return {
    ok: true,
    value: {
      comparators,
      canonical: comparators.map((comparator) => comparator.canonical).join(", ")
    }
  };
}

export function parseReleaseVersion(
  input: string
): Result<ReleaseVersion, InvalidReleaseVersion> {
  const match = FULL_VERSION_PATTERN.exec(input);
  if (match === null) {
    return invalidVersion(input);
  }

  const majorText = match[1];
  const minorText = match[2];
  const patchText = match[3];
  const prerelease = match[4] ?? "";
  const build = match[5] ?? "";
  if (
    majorText === undefined ||
    minorText === undefined ||
    patchText === undefined ||
    !isValidNumericIdentifier(majorText) ||
    !isValidNumericIdentifier(minorText) ||
    !isValidNumericIdentifier(patchText) ||
    !isValidPrerelease(prerelease) ||
    !isValidBuild(build)
  ) {
    return invalidVersion(input);
  }

  const major = BigInt(majorText);
  const minor = BigInt(minorText);
  const patch = BigInt(patchText);
  const canonical = `${major}.${minor}.${patch}${
    prerelease.length > 0 ? `-${prerelease}` : ""
  }${build.length > 0 ? `+${build}` : ""}`;

  return {
    ok: true,
    value: {
      major,
      minor,
      patch,
      prerelease,
      build,
      canonical
    }
  };
}

export function matchesReleaseRequirement(
  requirement: ReleaseRequirement,
  version: ReleaseVersion
): boolean {
  if (!requirement.comparators.every((comparator) => matchesComparator(comparator, version))) {
    return false;
  }

  if (version.prerelease.length === 0) {
    return true;
  }

  return requirement.comparators.some(
    (comparator) =>
      comparator.major === version.major &&
      comparator.minor === version.minor &&
      comparator.patch === version.patch &&
      comparator.prerelease.length > 0
  );
}

export function compareReleaseVersions(
  left: ReleaseVersion,
  right: ReleaseVersion
): -1 | 0 | 1 {
  const major = compareBigInt(left.major, right.major);
  if (major !== 0) {
    return major;
  }
  const minor = compareBigInt(left.minor, right.minor);
  if (minor !== 0) {
    return minor;
  }
  const patch = compareBigInt(left.patch, right.patch);
  if (patch !== 0) {
    return patch;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function parseComparator(
  input: string
):
  | Readonly<{ ok: true; value: ReleaseRequirementComparator }>
  | Readonly<{ ok: false; reason: ReleaseRequirementErrorReason }> {
  if (input === "*") {
    return {
      ok: true,
      value: {
        operator: "wildcard",
        major: 0n,
        prerelease: "",
        canonical: "*"
      }
    };
  }

  if (/^[xX]$/u.test(input) || /(?:^|\.)[xX](?:\.|$)/u.test(input)) {
    return { ok: false, reason: "invalid-wildcard" };
  }

  const operatorResult = parseOperator(input);
  if (!operatorResult.ok) {
    return operatorResult;
  }
  const versionText = trimAsciiWhitespace(operatorResult.rest);
  if (versionText.length === 0) {
    return { ok: false, reason: "invalid-version" };
  }

  if (containsMissingComma(versionText)) {
    return { ok: false, reason: "missing-comma" };
  }
  if (ASCII_WHITESPACE_CHARACTER.test(versionText)) {
    return { ok: false, reason: "invalid-version" };
  }

  if (versionText.includes("*")) {
    if (operatorResult.operator !== "default") {
      return { ok: false, reason: "invalid-wildcard" };
    }
    return parseWildcardComparator(versionText);
  }

  const partial = parsePartialVersion(versionText);
  if (!partial.ok) {
    return { ok: false, reason: "invalid-version" };
  }

  const operator =
    operatorResult.operator === "default" ? "caret" : operatorResult.operator;
  const operatorText = canonicalOperator(operator);
  const canonicalVersion = renderPartialVersion(partial.value);

  return {
    ok: true,
    value: {
      operator,
      major: partial.value.major,
      ...(partial.value.minor === undefined ? {} : { minor: partial.value.minor }),
      ...(partial.value.patch === undefined ? {} : { patch: partial.value.patch }),
      prerelease: partial.value.prerelease,
      canonical: `${operatorText}${canonicalVersion}`
    }
  };
}

function parseOperator(input: string):
  | Readonly<{
      ok: true;
      operator:
        | Exclude<ComparatorOperator, "wildcard">
        | "default";
      rest: string;
    }>
  | Readonly<{ ok: false; reason: "invalid-comparator" }> {
  const operators = [
    [">=", "greater-equal"],
    ["<=", "less-equal"],
    [">", "greater"],
    ["<", "less"],
    ["=", "exact"],
    ["~", "tilde"],
    ["^", "caret"]
  ] as const;

  for (const [token, operator] of operators) {
    if (input.startsWith(token)) {
      const rest = input.slice(token.length);
      if (/^[!<>=~^]/u.test(rest)) {
        return { ok: false, reason: "invalid-comparator" };
      }
      return { ok: true, operator, rest };
    }
  }

  if (/^[!<>=~^]/u.test(input)) {
    return { ok: false, reason: "invalid-comparator" };
  }
  return { ok: true, operator: "default", rest: input };
}

function parseWildcardComparator(
  input: string
):
  | Readonly<{ ok: true; value: ReleaseRequirementComparator }>
  | Readonly<{ ok: false; reason: "invalid-wildcard" }> {
  const majorOnly = /^([0-9]+)\.\*$/u.exec(input);
  const majorMinor = /^([0-9]+)\.([0-9]+)\.\*$/u.exec(input);

  if (majorOnly !== null) {
    const majorText = majorOnly[1];
    if (majorText === undefined || !isValidNumericIdentifier(majorText)) {
      return { ok: false, reason: "invalid-wildcard" };
    }
    const major = BigInt(majorText);
    return {
      ok: true,
      value: {
        operator: "wildcard",
        major,
        prerelease: "",
        canonical: `${major}.*`
      }
    };
  }

  if (majorMinor !== null) {
    const majorText = majorMinor[1];
    const minorText = majorMinor[2];
    if (
      majorText === undefined ||
      minorText === undefined ||
      !isValidNumericIdentifier(majorText) ||
      !isValidNumericIdentifier(minorText)
    ) {
      return { ok: false, reason: "invalid-wildcard" };
    }
    const major = BigInt(majorText);
    const minor = BigInt(minorText);
    return {
      ok: true,
      value: {
        operator: "wildcard",
        major,
        minor,
        prerelease: "",
        canonical: `${major}.${minor}.*`
      }
    };
  }

  return { ok: false, reason: "invalid-wildcard" };
}

type PartialVersion = Readonly<{
  major: bigint;
  minor?: bigint;
  patch?: bigint;
  prerelease: string;
}>;

function parsePartialVersion(
  input: string
): Readonly<{ ok: true; value: PartialVersion }> | Readonly<{ ok: false }> {
  const match = PARTIAL_VERSION_PATTERN.exec(input);
  if (match === null) {
    return { ok: false };
  }

  const majorText = match[1];
  const minorText = match[2];
  const patchText = match[3];
  const prerelease = match[4] ?? "";
  const build = match[5] ?? "";
  if (
    majorText === undefined ||
    !isValidNumericIdentifier(majorText) ||
    (minorText !== undefined && !isValidNumericIdentifier(minorText)) ||
    (patchText !== undefined && !isValidNumericIdentifier(patchText)) ||
    ((prerelease.length > 0 || build.length > 0) && patchText === undefined) ||
    !isValidPrerelease(prerelease) ||
    !isValidBuild(build)
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    value: {
      major: BigInt(majorText),
      ...(minorText === undefined ? {} : { minor: BigInt(minorText) }),
      ...(patchText === undefined ? {} : { patch: BigInt(patchText) }),
      prerelease
    }
  };
}

function matchesComparator(
  comparator: ReleaseRequirementComparator,
  version: ReleaseVersion
): boolean {
  switch (comparator.operator) {
    case "exact":
    case "wildcard":
      return matchesExact(comparator, version);
    case "greater":
      return matchesGreater(comparator, version);
    case "greater-equal":
      return matchesExact(comparator, version) || matchesGreater(comparator, version);
    case "less":
      return matchesLess(comparator, version);
    case "less-equal":
      return matchesExact(comparator, version) || matchesLess(comparator, version);
    case "tilde":
      return matchesTilde(comparator, version);
    case "caret":
      return matchesCaret(comparator, version);
  }
}

function matchesExact(
  comparator: ReleaseRequirementComparator,
  version: ReleaseVersion
): boolean {
  return (
    version.major === comparator.major &&
    (comparator.minor === undefined || version.minor === comparator.minor) &&
    (comparator.patch === undefined || version.patch === comparator.patch) &&
    version.prerelease === comparator.prerelease
  );
}

function matchesGreater(
  comparator: ReleaseRequirementComparator,
  version: ReleaseVersion
): boolean {
  if (version.major !== comparator.major) {
    return version.major > comparator.major;
  }
  if (comparator.minor === undefined) {
    return false;
  }
  if (version.minor !== comparator.minor) {
    return version.minor > comparator.minor;
  }
  if (comparator.patch === undefined) {
    return false;
  }
  if (version.patch !== comparator.patch) {
    return version.patch > comparator.patch;
  }
  return comparePrerelease(version.prerelease, comparator.prerelease) > 0;
}

function matchesLess(
  comparator: ReleaseRequirementComparator,
  version: ReleaseVersion
): boolean {
  if (version.major !== comparator.major) {
    return version.major < comparator.major;
  }
  if (comparator.minor === undefined) {
    return false;
  }
  if (version.minor !== comparator.minor) {
    return version.minor < comparator.minor;
  }
  if (comparator.patch === undefined) {
    return false;
  }
  if (version.patch !== comparator.patch) {
    return version.patch < comparator.patch;
  }
  return comparePrerelease(version.prerelease, comparator.prerelease) < 0;
}

function matchesTilde(
  comparator: ReleaseRequirementComparator,
  version: ReleaseVersion
): boolean {
  if (version.major !== comparator.major) {
    return false;
  }
  if (comparator.minor !== undefined && version.minor !== comparator.minor) {
    return false;
  }
  if (comparator.patch !== undefined && version.patch !== comparator.patch) {
    return version.patch > comparator.patch;
  }
  return comparePrerelease(version.prerelease, comparator.prerelease) >= 0;
}

function matchesCaret(
  comparator: ReleaseRequirementComparator,
  version: ReleaseVersion
): boolean {
  if (version.major !== comparator.major) {
    return false;
  }
  if (comparator.minor === undefined) {
    return true;
  }
  if (comparator.patch === undefined) {
    return comparator.major > 0n
      ? version.minor >= comparator.minor
      : version.minor === comparator.minor;
  }

  if (comparator.major > 0n) {
    if (version.minor !== comparator.minor) {
      return version.minor > comparator.minor;
    }
    if (version.patch !== comparator.patch) {
      return version.patch > comparator.patch;
    }
  } else if (comparator.minor > 0n) {
    if (version.minor !== comparator.minor) {
      return false;
    }
    if (version.patch !== comparator.patch) {
      return version.patch > comparator.patch;
    }
  } else if (
    version.minor !== comparator.minor ||
    version.patch !== comparator.patch
  ) {
    return false;
  }

  return comparePrerelease(version.prerelease, comparator.prerelease) >= 0;
}

function comparePrerelease(left: string, right: string): -1 | 0 | 1 {
  if (left === right) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const commonLength = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < commonLength; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined || rightPart === undefined) {
      continue;
    }
    if (leftPart === rightPart) {
      continue;
    }

    const leftNumeric = NUMERIC_PATTERN.test(leftPart);
    const rightNumeric = NUMERIC_PATTERN.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return compareBigInt(BigInt(leftPart), BigInt(rightPart));
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftPart < rightPart ? -1 : 1;
  }

  return leftParts.length < rightParts.length ? -1 : 1;
}

function isValidNumericIdentifier(value: string): boolean {
  return NUMERIC_PATTERN.test(value) && (value === "0" || !value.startsWith("0"));
}

function isValidPrerelease(value: string): boolean {
  if (value.length === 0) {
    return true;
  }
  if (!IDENTIFIER_PATTERN.test(value)) {
    return false;
  }
  return value.split(".").every(
    (identifier) =>
      identifier.length > 0 &&
      (!NUMERIC_PATTERN.test(identifier) || isValidNumericIdentifier(identifier))
  );
}

function isValidBuild(value: string): boolean {
  return value.length === 0 || IDENTIFIER_PATTERN.test(value);
}

function renderPartialVersion(version: PartialVersion): string {
  let result = `${version.major}`;
  if (version.minor !== undefined) {
    result += `.${version.minor}`;
  }
  if (version.patch !== undefined) {
    result += `.${version.patch}`;
    if (version.prerelease.length > 0) {
      result += `-${version.prerelease}`;
    }
  }
  return result;
}

function canonicalOperator(operator: Exclude<ComparatorOperator, "wildcard">): string {
  switch (operator) {
    case "caret":
      return "^";
    case "tilde":
      return "~";
    case "exact":
      return "=";
    case "greater":
      return ">";
    case "greater-equal":
      return ">=";
    case "less":
      return "<";
    case "less-equal":
      return "<=";
  }
}

function containsMissingComma(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== undefined && ASCII_WHITESPACE_CHARACTER.test(character)) {
      const remainder = trimAsciiWhitespace(value.slice(index));
      return /^[0-9*^~=<>&|]/u.test(remainder);
    }
  }
  return false;
}

function trimAsciiWhitespace(value: string): string {
  return value.replace(ASCII_WHITESPACE, "");
}

function compareBigInt(left: bigint, right: bigint): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function invalidRequirement(
  input: string,
  reason: ReleaseRequirementErrorReason
): Result<never, InvalidReleaseRequirement> {
  return {
    ok: false,
    error: productError("InvalidReleaseRequirement", { input, reason })
  };
}

function invalidVersion(input: string): Result<never, InvalidReleaseVersion> {
  return {
    ok: false,
    error: productError("InvalidReleaseVersion", {
      input,
      reason: "invalid-version"
    })
  };
}
