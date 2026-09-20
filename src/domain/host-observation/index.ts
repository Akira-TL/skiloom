import {
  productError,
  type ProductError,
  type Result
} from "../errors/index.js";

export type HostVersionComparator = "=" | "<" | "<=" | ">" | ">=";

export type HostVersionTuple = ReadonlyArray<bigint>;

export type HostSoftwareRequirement =
  | Readonly<{ kind: "presence" }>
  | Readonly<{
      kind: "comparators";
      comparators: ReadonlyArray<Readonly<{
        operator: HostVersionComparator;
        version: HostVersionTuple;
      }>>;
    }>;

export type InvalidHostSoftwareRequirement = ProductError<
  "InvalidHostSoftwareRequirement",
  Readonly<{
    requirement: string;
    reason: "empty" | "invalid-syntax" | "invalid-number";
  }>
>;

export type InvalidHostSoftwareVersion = ProductError<
  "InvalidHostSoftwareVersion",
  Readonly<{
    version: string;
    reason: "invalid-syntax" | "invalid-number";
  }>
>;

const COMPARATOR_PATTERN = /^(<=|>=|=|<|>)(\d+(?:\.\d+)*)$/u;
const VERSION_PATTERN = /^\d+(?:\.\d+)*$/u;

export function parseHostSoftwareRequirement(
  source: string
): Result<HostSoftwareRequirement, InvalidHostSoftwareRequirement> {
  const requirement = source.trim();
  if (requirement.length === 0) {
    return invalidRequirement(source, "empty");
  }
  if (requirement === "*") {
    return {
      ok: true,
      value: { kind: "presence" }
    };
  }

  const comparators: Array<{
    operator: HostVersionComparator;
    version: HostVersionTuple;
  }> = [];
  for (const token of requirement.split(",")) {
    const normalized = token.trim();
    const match = COMPARATOR_PATTERN.exec(normalized);
    if (match === null) {
      return invalidRequirement(source, "invalid-syntax");
    }
    const parsedVersion = parseVersionTuple(match[2]!);
    if (!parsedVersion.ok) {
      return invalidRequirement(source, "invalid-number");
    }
    comparators.push({
      operator: match[1] as HostVersionComparator,
      version: parsedVersion.value
    });
  }

  if (comparators.length === 0) {
    return invalidRequirement(source, "invalid-syntax");
  }

  return {
    ok: true,
    value: {
      kind: "comparators",
      comparators
    }
  };
}

export function matchesHostSoftwareRequirement(
  requirement: HostSoftwareRequirement,
  detectedVersion: string
): Result<boolean, InvalidHostSoftwareVersion> {
  const parsedVersion = parseDetectedVersion(detectedVersion);
  if (!parsedVersion.ok) {
    return parsedVersion;
  }
  if (requirement.kind === "presence") {
    return { ok: true, value: true };
  }

  return {
    ok: true,
    value: requirement.comparators.every((comparator) =>
      comparatorMatches(
        compareVersionTuples(
          parsedVersion.value,
          comparator.version
        ),
        comparator.operator
      )
    )
  };
}

export function parseHostSoftwareVersion(
  source: string
): Result<HostVersionTuple, InvalidHostSoftwareVersion> {
  return parseDetectedVersion(source);
}

function parseDetectedVersion(
  source: string
): Result<HostVersionTuple, InvalidHostSoftwareVersion> {
  if (!VERSION_PATTERN.test(source)) {
    return {
      ok: false,
      error: productError("InvalidHostSoftwareVersion", {
        version: source,
        reason: "invalid-syntax"
      })
    };
  }
  const parsed = parseVersionTuple(source);
  if (!parsed.ok) {
    return {
      ok: false,
      error: productError("InvalidHostSoftwareVersion", {
        version: source,
        reason: "invalid-number"
      })
    };
  }
  return parsed;
}

function parseVersionTuple(
  source: string
): Result<HostVersionTuple, InvalidHostSoftwareVersion> {
  try {
    return {
      ok: true,
      value: source.split(".").map((part) => BigInt(part))
    };
  } catch {
    return {
      ok: false,
      error: productError("InvalidHostSoftwareVersion", {
        version: source,
        reason: "invalid-number"
      })
    };
  }
}

function compareVersionTuples(
  left: HostVersionTuple,
  right: HostVersionTuple
): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index] ?? 0n;
    const rightPart = right[index] ?? 0n;
    if (leftPart < rightPart) {
      return -1;
    }
    if (leftPart > rightPart) {
      return 1;
    }
  }
  return 0;
}

function comparatorMatches(
  comparison: number,
  operator: HostVersionComparator
): boolean {
  switch (operator) {
    case "=":
      return comparison === 0;
    case "<":
      return comparison < 0;
    case "<=":
      return comparison <= 0;
    case ">":
      return comparison > 0;
    case ">=":
      return comparison >= 0;
  }
}

function invalidRequirement(
  requirement: string,
  reason: InvalidHostSoftwareRequirement["facts"]["reason"]
): Result<never, InvalidHostSoftwareRequirement> {
  return {
    ok: false,
    error: productError("InvalidHostSoftwareRequirement", {
      requirement,
      reason
    })
  };
}
