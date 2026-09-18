import {
  parsePackageCoordinate,
  parseRepositoryCoordinate
} from "../../../domain/coordinate/index.js";
import {
  productError,
  type Result
} from "../../../domain/errors/index.js";
import type {
  DirectInstallRequirement
} from "../../../domain/resolver/index.js";
import type {
  RegistryDirectRequirement
} from "../../registry/index.js";
import type {
  InvalidAcceptedRequirementChangeState
} from "./requirement-change.js";

export function registryRequirementsToDomain(
  targetId: string,
  requirements: ReadonlyArray<RegistryDirectRequirement>
): Result<
  ReadonlyArray<DirectInstallRequirement>,
  InvalidAcceptedRequirementChangeState
> {
  const result: DirectInstallRequirement[] = [];

  for (const requirement of requirements) {
    if (requirement.kind === "package") {
      const coordinate = parsePackageCoordinate(
        requirement.coordinate
      );
      if (!coordinate.ok) {
        return invalidRequirement(targetId);
      }
      result.push(
        requirement.sourceKind === "git"
          ? {
              kind: "package",
              coordinate: coordinate.value,
              sourceKind: "git",
              requestedRef: requirement.requestedRef
            }
          : {
              kind: "package",
              coordinate: coordinate.value,
              sourceKind: "github-release",
              ...(requirement.versionRequirement === null
                ? {}
                : {
                    versionRequirement:
                      requirement.versionRequirement
                  })
            }
      );
      continue;
    }

    const coordinate = parseRepositoryCoordinate(
      requirement.coordinate
    );
    if (!coordinate.ok) {
      return invalidRequirement(targetId);
    }
    result.push(
      requirement.sourceKind === "git"
        ? {
            kind: "repository",
            coordinate: coordinate.value,
            sourceKind: "git",
            requestedRef: requirement.requestedRef
          }
        : {
            kind: "repository",
            coordinate: coordinate.value,
            sourceKind: "github-release",
            ...(requirement.versionRequirement === null
              ? {}
              : {
                  versionRequirement:
                    requirement.versionRequirement
                })
          }
    );
  }

  return { ok: true, value: result };
}

function invalidRequirement(
  targetId: string
): Result<never, InvalidAcceptedRequirementChangeState> {
  return {
    ok: false,
    error: productError(
      "InvalidAcceptedRequirementChangeState",
      {
        targetId,
        reason: "invalid-direct-requirement"
      }
    )
  };
}
