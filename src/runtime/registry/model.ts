export type RegistryDirectRequirement =
  | Readonly<{
      kind: "package" | "repository";
      coordinate: string;
      sourceKind: "github-release";
      versionRequirement: string | null;
    }>
  | Readonly<{
      kind: "package" | "repository";
      coordinate: string;
      sourceKind: "git";
      requestedRef: string;
    }>;

export type RegistryResolvedSource =
  | Readonly<{
      repositoryCoordinate: string;
      sourceKind: "github-release";
      version: string;
      actualTag: string;
      exactCommit: string;
      immutable: boolean | null;
    }>
  | Readonly<{
      repositoryCoordinate: string;
      sourceKind: "git";
      requestedRef: string;
      exactCommit: string;
    }>;

export type RegistryResolvedPackage = Readonly<{
  packageCoordinate: string;
  repositoryCoordinate: string;
  packageRoot: string;
  contentDigest: string;
}>;

export type RegistryDependencyEdge = Readonly<{
  fromPackage: string;
  toPackage: string;
}>;

export type RegistryProjection = Readonly<{
  packageCoordinate: string;
  activationName: string;
  ownership: "managed" | "detached";
  materialization: "symlink" | "junction" | "copy";
  transformJson: string | null;
}>;

export type RegistryDetachedBaseline =
  | Readonly<{
      packageCoordinate: string;
      repositoryCoordinate: string;
      sourceKind: "github-release";
      version: string;
      actualTag: string;
      exactCommit: string;
      packageRoot: string;
      contentDigest: string;
    }>
  | Readonly<{
      packageCoordinate: string;
      repositoryCoordinate: string;
      sourceKind: "git";
      requestedRef: string;
      exactCommit: string;
      packageRoot: string;
      contentDigest: string;
    }>;

export type RegistryDependencyObservation = Readonly<{
  packageCoordinate: string;
  packageContentDigest: string;
  kind: "software" | "special";
  name: string;
  status: string;
  detectedVersion: string | null;
  location: string | null;
  note: string | null;
}>;

export type RegistryTargetLocation = Readonly<{
  path: string;
  observedGeneration: number | null;
}>;

export type RegistryForkLocationTransfer = Readonly<{
  fromTargetId: string;
  expectedFromGeneration: number;
  path: string;
}>;

export type RegistryTargetState = Readonly<{
  targetId: string;
  generation: number;
  locations: ReadonlyArray<RegistryTargetLocation>;
  directRequirements: ReadonlyArray<RegistryDirectRequirement>;
  resolvedSources: ReadonlyArray<RegistryResolvedSource>;
  resolvedPackages: ReadonlyArray<RegistryResolvedPackage>;
  dependencyEdges: ReadonlyArray<RegistryDependencyEdge>;
  projections: ReadonlyArray<RegistryProjection>;
  detachedBaselines: ReadonlyArray<RegistryDetachedBaseline>;
  dependencyObservations: ReadonlyArray<RegistryDependencyObservation>;
}>;

export type RegistryTargetStateInput = Omit<RegistryTargetState, "generation">;

export type RegistryPendingProjectionAction = Readonly<{
  stagingPath: string;
  activationName: string;
}>;

export type RegistryPendingOperation = Readonly<{
  operationId: string;
  targetId: string;
  baseGeneration: number;
  nextGeneration: number;
  actions: ReadonlyArray<RegistryPendingProjectionAction>;
}>;

export type RegistryPendingOperationInput = Readonly<{
  operationId: string;
  actions: ReadonlyArray<RegistryPendingProjectionAction>;
}>;
