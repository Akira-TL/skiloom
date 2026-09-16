import { parse as parseToml, TomlDate } from "smol-toml";

import {
  productError,
  type ProductError,
  type Result
} from "../errors/index.js";

export type RepositoryDiscoveryConfig = Readonly<{
  include: ReadonlyArray<string>;
  exclude: ReadonlyArray<string>;
}>;

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
