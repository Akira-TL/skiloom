import { TextDecoder, TextEncoder } from "node:util";

import { parseDocument } from "yaml";

import {
  isValidSkillName,
  parsePackageCoordinate
} from "../../domain/coordinate/index.js";
import {
  productError,
  type Result
} from "../../domain/errors/index.js";
import { admitSkillPackage } from "../../domain/package/index.js";
import type { PackageSnapshot } from "../../domain/snapshot/index.js";
import type {
  TargetDependencyRoute,
  TargetProjection
} from "../../domain/target/index.js";
import type {
  InvalidManagedProjectionInput,
  ManagedProjectionTree,
  ManagedTransformError,
  ManagedTransformMarkerConflict,
  UnsupportedManagedTransform,
  UnsupportedManagedTransformReason
} from "./types.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const UTF8_ENCODER = new TextEncoder();
const ROUTING_BEGIN = "<!-- SKILOOM-DEPENDENCY-ROUTING-V1:BEGIN -->";
const ROUTING_END = "<!-- SKILOOM-DEPENDENCY-ROUTING-V1:END -->";

export function buildManagedProjectionTree(
  snapshot: PackageSnapshot,
  projection: TargetProjection
): Result<ManagedProjectionTree, ManagedTransformError> {
  if (snapshot.contentDigest !== projection.contentDigest) {
    return invalidProjection(
      "snapshot-digest-mismatch",
      projection.packageCoordinate
    );
  }

  const coordinate = parsePackageCoordinate(projection.packageCoordinate);
  if (!coordinate.ok) {
    return invalidProjection(
      "invalid-package-coordinate",
      projection.packageCoordinate
    );
  }
  if (!isValidSkillName(projection.activationName)) {
    return invalidProjection(
      "invalid-activation-name",
      projection.activationName
    );
  }

  if (projection.projectionKind === "direct") {
    if (
      projection.transform !== null ||
      projection.activationName !== coordinate.value.packageName
    ) {
      return invalidProjection(
        "projection-kind-transform-mismatch",
        projection.packageCoordinate
      );
    }
    return {
      ok: true,
      value: {
        entries: snapshot.entries.map((entry) => ({
          path: entry.path,
          executable: entry.executable,
          content: Uint8Array.from(entry.content)
        }))
      }
    };
  }

  if (projection.transform === null) {
    return invalidProjection(
      "projection-kind-transform-mismatch",
      projection.packageCoordinate
    );
  }

  const rename = projection.transform.rename;
  if (rename === null) {
    if (projection.activationName !== coordinate.value.packageName) {
      return invalidProjection(
        "activation-name-transform-mismatch",
        projection.activationName
      );
    }
  } else if (
    rename.fromActivationName !== coordinate.value.packageName ||
    rename.toActivationName !== projection.activationName ||
    rename.fromActivationName === rename.toActivationName
  ) {
    return invalidProjection(
      "activation-name-transform-mismatch",
      projection.activationName
    );
  }

  const routes = prepareRoutes(projection.transform.dependencyRoutes, projection);
  if (!routes.ok) {
    return routes;
  }
  if (rename === null && routes.value.length === 0) {
    return invalidProjection(
      "projection-kind-transform-mismatch",
      projection.packageCoordinate
    );
  }

  const skillEntry = snapshot.entries.find((entry) => entry.path === "SKILL.md");
  if (skillEntry === undefined) {
    return unsupported(projection, "missing-skill-markdown");
  }

  let originalSkill: string;
  try {
    originalSkill = UTF8_DECODER.decode(skillEntry.content);
  } catch {
    return unsupported(projection, "invalid-skill-utf8");
  }

  const admitted = admitSkillPackage({
    rootBasename: coordinate.value.packageName,
    skillMarkdown: originalSkill
  });
  if (!admitted.ok) {
    return unsupported(projection, "source-skill-not-admitted");
  }

  let transformedSkill = originalSkill;
  if (rename !== null) {
    const renamed = renameSkillName(
      originalSkill,
      projection,
      rename.fromActivationName,
      rename.toActivationName
    );
    if (!renamed.ok) {
      return renamed;
    }
    transformedSkill = renamed.value;

    const transformedAdmission = admitSkillPackage({
      rootBasename: projection.activationName,
      skillMarkdown: transformedSkill
    });
    if (!transformedAdmission.ok) {
      return unsupported(projection, "transformed-skill-invalid");
    }
  }

  if (routes.value.length > 0) {
    if (originalSkill.includes(ROUTING_BEGIN)) {
      return markerConflict(projection, "begin");
    }
    if (originalSkill.includes(ROUTING_END)) {
      return markerConflict(projection, "end");
    }
    transformedSkill = appendRoutingBlock(transformedSkill, routes.value);
  }

  return {
    ok: true,
    value: {
      entries: snapshot.entries.map((entry) => ({
        path: entry.path,
        executable: entry.executable,
        content:
          entry.path === "SKILL.md"
            ? UTF8_ENCODER.encode(transformedSkill)
            : Uint8Array.from(entry.content)
      }))
    }
  };
}

function prepareRoutes(
  routes: ReadonlyArray<TargetDependencyRoute>,
  projection: TargetProjection
): Result<ReadonlyArray<TargetDependencyRoute>, UnsupportedManagedTransform> {
  const ordered = [...routes].sort((left, right) =>
    compareUtf8(
      left.dependencyPackageCoordinate,
      right.dependencyPackageCoordinate
    )
  );
  let previous: string | undefined;
  for (const route of ordered) {
    if (route.dependencyPackageCoordinate === previous) {
      return unsupported(projection, "duplicate-routing-dependency");
    }
    previous = route.dependencyPackageCoordinate;

    const dependency = parsePackageCoordinate(route.dependencyPackageCoordinate);
    if (
      !dependency.ok ||
      route.fromActivationName !== dependency.value.packageName
    ) {
      return unsupported(projection, "invalid-routing-dependency");
    }
    if (
      !isValidSkillName(route.toActivationName) ||
      route.toActivationName === route.fromActivationName
    ) {
      return unsupported(projection, "invalid-routing-activation");
    }
  }
  return { ok: true, value: ordered };
}

function renameSkillName(
  markdown: string,
  projection: TargetProjection,
  fromActivationName: string,
  toActivationName: string
): Result<string, UnsupportedManagedTransform> {
  const frontmatter = rawFrontmatter(markdown);
  if (frontmatter === undefined) {
    return unsupported(projection, "frontmatter-range-unavailable");
  }

  const document = parseDocument(frontmatter.yaml, {
    prettyErrors: false,
    uniqueKeys: true
  });
  if (document.errors.length > 0 || document.get("name") !== fromActivationName) {
    return unsupported(projection, "source-name-mismatch");
  }

  const range = yamlNodeRange(document.get("name", true));
  if (range === undefined) {
    return unsupported(projection, "frontmatter-range-unavailable");
  }

  const start = frontmatter.yamlOffset + range[0];
  const end = frontmatter.yamlOffset + range[1];
  return {
    ok: true,
    value: markdown.slice(0, start) + toActivationName + markdown.slice(end)
  };
}

function rawFrontmatter(
  markdown: string
): Readonly<{ yaml: string; yamlOffset: number }> | undefined {
  const firstNewline = markdown.indexOf("\n");
  if (firstNewline === -1) {
    return undefined;
  }
  const firstLine = stripCarriageReturn(markdown.slice(0, firstNewline));
  if (firstLine !== "---") {
    return undefined;
  }

  const yamlOffset = firstNewline + 1;
  let offset = yamlOffset;
  while (offset <= markdown.length) {
    const newline = markdown.indexOf("\n", offset);
    const lineEnd = newline === -1 ? markdown.length : newline;
    const line = stripCarriageReturn(markdown.slice(offset, lineEnd));
    if (line === "---") {
      return {
        yaml: markdown.slice(yamlOffset, offset),
        yamlOffset
      };
    }
    if (newline === -1) {
      break;
    }
    offset = newline + 1;
  }
  return undefined;
}

function yamlNodeRange(value: unknown): readonly [number, number] | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("range" in value) ||
    !Array.isArray(value.range) ||
    value.range.length < 2 ||
    typeof value.range[0] !== "number" ||
    typeof value.range[1] !== "number" ||
    value.range[0] < 0 ||
    value.range[1] < value.range[0]
  ) {
    return undefined;
  }
  return [value.range[0], value.range[1]];
}

function appendRoutingBlock(
  markdown: string,
  routes: ReadonlyArray<TargetDependencyRoute>
): string {
  const lines = [
    ROUTING_BEGIN,
    "## Skiloom dependency routing",
    "",
    "The following Skill dependencies use Target-local activation names. Use the listed Skill name when invoking each dependency; do not infer a filesystem path.",
    "",
    ...routes.map(
      (route) =>
        `- \`${route.dependencyPackageCoordinate}\`: use Skill \`${route.toActivationName}\``
    ),
    ROUTING_END,
    ""
  ];
  const separator = markdown.endsWith("\n") ? "\n" : "\n\n";
  return markdown + separator + lines.join("\n");
}

function stripCarriageReturn(value: string): string {
  return value.endsWith("\r") ? value.slice(0, -1) : value;
}

function invalidProjection(
  reason: InvalidManagedProjectionInput["facts"]["reason"],
  subject: string
): Result<never, InvalidManagedProjectionInput> {
  return {
    ok: false,
    error: productError("InvalidManagedProjectionInput", { reason, subject })
  };
}

function unsupported(
  projection: TargetProjection,
  reason: UnsupportedManagedTransformReason
): Result<never, UnsupportedManagedTransform> {
  return {
    ok: false,
    error: productError("UnsupportedManagedTransform", {
      packageCoordinate: projection.packageCoordinate,
      reason
    })
  };
}

function markerConflict(
  projection: TargetProjection,
  marker: ManagedTransformMarkerConflict["facts"]["marker"]
): Result<never, ManagedTransformMarkerConflict> {
  return {
    ok: false,
    error: productError("ManagedTransformMarkerConflict", {
      packageCoordinate: projection.packageCoordinate,
      marker
    })
  };
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
