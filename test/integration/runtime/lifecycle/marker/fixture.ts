import assert from "node:assert/strict";

import type {
  RegistryTargetState
} from "../../../../../src/runtime/registry/index.js";

export function expectedManagedMarkerBaselines(
  state: RegistryTargetState
): ReadonlyArray<Readonly<{
  packageCoordinate: string;
  activationName: string;
  materialization: "symlink" | "junction" | "copy";
  packageRoot: string;
  contentDigest: string;
  transformJson: string | null;
}>> {
  const packageByCoordinate = new Map(
    state.resolvedPackages.map((entry) => [
      entry.packageCoordinate,
      entry
    ])
  );
  return state.projections
    .filter((projection) => projection.ownership === "managed")
    .map((projection) => {
      const packageFact = packageByCoordinate.get(
        projection.packageCoordinate
      );
      assert.notEqual(packageFact, undefined);
      return {
        packageCoordinate: projection.packageCoordinate,
        activationName: projection.activationName,
        materialization: projection.materialization,
        packageRoot: packageFact!.packageRoot,
        contentDigest: packageFact!.contentDigest,
        transformJson: projection.transformJson
      };
    })
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.packageCoordinate, "utf8"),
        Buffer.from(right.packageCoordinate, "utf8")
      )
    );
}
