import {
  isValidSkillName,
  parsePackageCoordinate
} from "../coordinate/index.js";
import {
  productError,
  type ProductError,
  type Result
} from "../errors/index.js";

export type TargetPackageFact = Readonly<{
  packageCoordinate: string;
  packageRoot: string;
  contentDigest: string;
}>;

export type TargetDependencyEdge = Readonly<{
  sourcePackageCoordinate: string;
  targetPackageCoordinate: string;
}>;

export type TargetProjectionRename = Readonly<{
  packageCoordinate: string;
  activationName: string;
}>;

export type TargetDependencyRoute = Readonly<{
  dependencyPackageCoordinate: string;
  fromActivationName: string;
  toActivationName: string;
}>;

export type TargetProjectionTransform = Readonly<{
  rename: Readonly<{
    fromActivationName: string;
    toActivationName: string;
  }> | null;
  dependencyRoutes: ReadonlyArray<TargetDependencyRoute>;
}>;

export type TargetProjection = Readonly<{
  packageCoordinate: string;
  packageRoot: string;
  contentDigest: string;
  activationName: string;
  projectionKind: "direct" | "transformed-copy";
  transform: TargetProjectionTransform | null;
}>;

export type TargetPlan = Readonly<{
  projections: ReadonlyArray<TargetProjection>;
  reachablePackages: ReadonlyArray<string>;
  unreachableManagedPackages: ReadonlyArray<string>;
}>;

export type InvalidActivationName = ProductError<
  "InvalidActivationName",
  Readonly<{
    packageCoordinate: string;
    activationName: string;
    reason: "invalid-skill-name";
  }>
>;

export type ActivationNameConflict = ProductError<
  "ActivationNameConflict",
  Readonly<{
    activationName: string;
    packageCoordinates: ReadonlyArray<string>;
  }>
>;

export type InvalidTargetPlanInput = ProductError<
  "InvalidTargetPlanInput",
  Readonly<{
    reason:
      | "invalid-package-coordinate"
      | "duplicate-package"
      | "duplicate-rename"
      | "conflicting-rename"
      | "unknown-direct-root"
      | "unknown-edge-source"
      | "unknown-edge-target"
      | "unknown-rename-package";
    packageCoordinate: string;
  }>
>;

export type TargetPlanError =
  | InvalidActivationName
  | ActivationNameConflict
  | InvalidTargetPlanInput;

export type TargetPlannerInput = Readonly<{
  packages: ReadonlyArray<TargetPackageFact>;
  dependencyEdges: ReadonlyArray<TargetDependencyEdge>;
  directRoots: ReadonlyArray<string>;
  renames: ReadonlyArray<TargetProjectionRename>;
}>;

type PreparedPackage = Readonly<{
  packageCoordinate: string;
  packageRoot: string;
  contentDigest: string;
  defaultActivationName: string;
}>;

export function planTargetProjections(
  input: TargetPlannerInput
): Result<TargetPlan, TargetPlanError> {
  const preparedPackages = preparePackages(input.packages);
  if (!preparedPackages.ok) {
    return preparedPackages;
  }

  const packageByCoordinate = new Map(
    preparedPackages.value.map((packageFact) => [packageFact.packageCoordinate, packageFact])
  );

  const edges = prepareEdges(input.dependencyEdges, packageByCoordinate);
  if (!edges.ok) {
    return edges;
  }

  const roots = prepareRoots(input.directRoots, packageByCoordinate);
  if (!roots.ok) {
    return roots;
  }

  const reachable = computeReachable(roots.value, edges.value);
  const reachablePackages = [...reachable].sort(compareUtf8);
  const unreachableManagedPackages = preparedPackages.value
    .map((packageFact) => packageFact.packageCoordinate)
    .filter((coordinate) => !reachable.has(coordinate));

  const renames = prepareRenames(input.renames, packageByCoordinate, reachable);
  if (!renames.ok) {
    return renames;
  }

  const activationByPackage = new Map<string, string>();
  for (const packageCoordinate of reachablePackages) {
    const packageFact = packageByCoordinate.get(packageCoordinate)!;
    activationByPackage.set(
      packageCoordinate,
      renames.value.get(packageCoordinate) ?? packageFact.defaultActivationName
    );
  }

  const activationConflict = findActivationConflict(activationByPackage);
  if (activationConflict !== undefined) {
    return { ok: false, error: activationConflict };
  }

  const outgoingEdges = buildOutgoingEdges(edges.value, reachable);
  const projections = reachablePackages.map((packageCoordinate): TargetProjection => {
    const packageFact = packageByCoordinate.get(packageCoordinate)!;
    const activationName = activationByPackage.get(packageCoordinate)!;
    const rename = activationName === packageFact.defaultActivationName
      ? null
      : {
          fromActivationName: packageFact.defaultActivationName,
          toActivationName: activationName
        };

    const dependencyRoutes: TargetDependencyRoute[] = [];
    for (const edge of outgoingEdges.get(packageCoordinate) ?? []) {
      const targetPackage = packageByCoordinate.get(edge.targetPackageCoordinate)!;
      const targetActivation = activationByPackage.get(edge.targetPackageCoordinate)!;
      if (targetActivation === targetPackage.defaultActivationName) {
        continue;
      }
      dependencyRoutes.push({
        dependencyPackageCoordinate: edge.targetPackageCoordinate,
        fromActivationName: targetPackage.defaultActivationName,
        toActivationName: targetActivation
      });
    }
    dependencyRoutes.sort((left, right) =>
      compareUtf8(left.dependencyPackageCoordinate, right.dependencyPackageCoordinate)
    );

    if (rename === null && dependencyRoutes.length === 0) {
      return {
        packageCoordinate,
        packageRoot: packageFact.packageRoot,
        contentDigest: packageFact.contentDigest,
        activationName,
        projectionKind: "direct",
        transform: null
      };
    }

    return {
      packageCoordinate,
      packageRoot: packageFact.packageRoot,
      contentDigest: packageFact.contentDigest,
      activationName,
      projectionKind: "transformed-copy",
      transform: {
        rename,
        dependencyRoutes
      }
    };
  });

  return {
    ok: true,
    value: {
      projections,
      reachablePackages,
      unreachableManagedPackages
    }
  };
}

function preparePackages(
  packages: ReadonlyArray<TargetPackageFact>
): Result<ReadonlyArray<PreparedPackage>, InvalidTargetPlanInput> {
  const sorted = [...packages].sort((left, right) =>
    compareUtf8(left.packageCoordinate, right.packageCoordinate)
  );
  const prepared: PreparedPackage[] = [];
  let previousCoordinate: string | undefined;

  for (const packageFact of sorted) {
    if (packageFact.packageCoordinate === previousCoordinate) {
      return {
        ok: false,
        error: productError("InvalidTargetPlanInput", {
          reason: "duplicate-package",
          packageCoordinate: packageFact.packageCoordinate
        })
      };
    }
    previousCoordinate = packageFact.packageCoordinate;

    const parsed = parsePackageCoordinate(packageFact.packageCoordinate);
    if (!parsed.ok) {
      return {
        ok: false,
        error: productError("InvalidTargetPlanInput", {
          reason: "invalid-package-coordinate",
          packageCoordinate: packageFact.packageCoordinate
        })
      };
    }

    prepared.push({
      ...packageFact,
      defaultActivationName: parsed.value.packageName
    });
  }

  return { ok: true, value: prepared };
}

function prepareEdges(
  edges: ReadonlyArray<TargetDependencyEdge>,
  packageByCoordinate: ReadonlyMap<string, PreparedPackage>
): Result<ReadonlyArray<TargetDependencyEdge>, InvalidTargetPlanInput> {
  const unique = new Map<string, TargetDependencyEdge>();
  for (const edge of [...edges].sort(compareEdges)) {
    if (!packageByCoordinate.has(edge.sourcePackageCoordinate)) {
      return {
        ok: false,
        error: productError("InvalidTargetPlanInput", {
          reason: "unknown-edge-source",
          packageCoordinate: edge.sourcePackageCoordinate
        })
      };
    }
    if (!packageByCoordinate.has(edge.targetPackageCoordinate)) {
      return {
        ok: false,
        error: productError("InvalidTargetPlanInput", {
          reason: "unknown-edge-target",
          packageCoordinate: edge.targetPackageCoordinate
        })
      };
    }
    unique.set(edgeKey(edge), edge);
  }
  return { ok: true, value: [...unique.values()] };
}

function prepareRoots(
  roots: ReadonlyArray<string>,
  packageByCoordinate: ReadonlyMap<string, PreparedPackage>
): Result<ReadonlyArray<string>, InvalidTargetPlanInput> {
  const unique = [...new Set(roots)].sort(compareUtf8);
  for (const root of unique) {
    if (!packageByCoordinate.has(root)) {
      return {
        ok: false,
        error: productError("InvalidTargetPlanInput", {
          reason: "unknown-direct-root",
          packageCoordinate: root
        })
      };
    }
  }
  return { ok: true, value: unique };
}

function prepareRenames(
  renames: ReadonlyArray<TargetProjectionRename>,
  packageByCoordinate: ReadonlyMap<string, PreparedPackage>,
  reachable: ReadonlySet<string>
): Result<ReadonlyMap<string, string>, InvalidActivationName | InvalidTargetPlanInput> {
  const sorted = [...renames].sort((left, right) => {
    const coordinate = compareUtf8(left.packageCoordinate, right.packageCoordinate);
    return coordinate !== 0
      ? coordinate
      : compareUtf8(left.activationName, right.activationName);
  });
  const result = new Map<string, string>();

  for (const rename of sorted) {
    if (!packageByCoordinate.has(rename.packageCoordinate)) {
      return {
        ok: false,
        error: productError("InvalidTargetPlanInput", {
          reason: "unknown-rename-package",
          packageCoordinate: rename.packageCoordinate
        })
      };
    }
    if (!reachable.has(rename.packageCoordinate)) {
      continue;
    }
    if (!isValidSkillName(rename.activationName)) {
      return {
        ok: false,
        error: productError("InvalidActivationName", {
          packageCoordinate: rename.packageCoordinate,
          activationName: rename.activationName,
          reason: "invalid-skill-name"
        })
      };
    }
    const prior = result.get(rename.packageCoordinate);
    if (prior !== undefined) {
      return {
        ok: false,
        error: productError("InvalidTargetPlanInput", {
          reason: prior === rename.activationName ? "duplicate-rename" : "conflicting-rename",
          packageCoordinate: rename.packageCoordinate
        })
      };
    }
    result.set(rename.packageCoordinate, rename.activationName);
  }

  return { ok: true, value: result };
}

function computeReachable(
  roots: ReadonlyArray<string>,
  edges: ReadonlyArray<TargetDependencyEdge>
): ReadonlySet<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = outgoing.get(edge.sourcePackageCoordinate) ?? [];
    targets.push(edge.targetPackageCoordinate);
    outgoing.set(edge.sourcePackageCoordinate, targets);
  }
  for (const targets of outgoing.values()) {
    targets.sort(compareUtf8);
  }

  const reachable = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const coordinate = queue.shift()!;
    if (reachable.has(coordinate)) {
      continue;
    }
    reachable.add(coordinate);
    for (const target of outgoing.get(coordinate) ?? []) {
      if (!reachable.has(target)) {
        queue.push(target);
      }
    }
  }
  return reachable;
}

function buildOutgoingEdges(
  edges: ReadonlyArray<TargetDependencyEdge>,
  reachable: ReadonlySet<string>
): ReadonlyMap<string, ReadonlyArray<TargetDependencyEdge>> {
  const outgoing = new Map<string, TargetDependencyEdge[]>();
  for (const edge of edges) {
    if (!reachable.has(edge.sourcePackageCoordinate) || !reachable.has(edge.targetPackageCoordinate)) {
      continue;
    }
    const values = outgoing.get(edge.sourcePackageCoordinate) ?? [];
    values.push(edge);
    outgoing.set(edge.sourcePackageCoordinate, values);
  }
  for (const values of outgoing.values()) {
    values.sort(compareEdges);
  }
  return outgoing;
}

function findActivationConflict(
  activationByPackage: ReadonlyMap<string, string>
): ActivationNameConflict | undefined {
  const packagesByActivation = new Map<string, string[]>();
  for (const [packageCoordinate, activationName] of activationByPackage) {
    const coordinates = packagesByActivation.get(activationName) ?? [];
    coordinates.push(packageCoordinate);
    packagesByActivation.set(activationName, coordinates);
  }

  for (const activationName of [...packagesByActivation.keys()].sort(compareUtf8)) {
    const coordinates = packagesByActivation.get(activationName)!;
    if (coordinates.length <= 1) {
      continue;
    }
    coordinates.sort(compareUtf8);
    return productError("ActivationNameConflict", {
      activationName,
      packageCoordinates: coordinates
    });
  }
  return undefined;
}

function compareEdges(left: TargetDependencyEdge, right: TargetDependencyEdge): number {
  const source = compareUtf8(left.sourcePackageCoordinate, right.sourcePackageCoordinate);
  return source !== 0
    ? source
    : compareUtf8(left.targetPackageCoordinate, right.targetPackageCoordinate);
}

function edgeKey(edge: TargetDependencyEdge): string {
  return `${edge.sourcePackageCoordinate}\0${edge.targetPackageCoordinate}`;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
