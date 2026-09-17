export {
  MachineRegistry,
  openMachineRegistry,
  type RegistryConnectionPragmas,
  type RegistryOpenError,
  type RegistryReplaceError,
  type RegistrySchemaUnsupported,
  type RegistryStateRejected
} from "./database.js";
export {
  CURRENT_REGISTRY_SCHEMA_VERSION
} from "./schema.js";
export type {
  RegistryDependencyEdge,
  RegistryDependencyObservation,
  RegistryDetachedBaseline,
  RegistryDirectRequirement,
  RegistryProjection,
  RegistryResolvedPackage,
  RegistryResolvedSource,
  RegistryTargetLocation,
  RegistryTargetState,
  RegistryTargetStateInput
} from "./model.js";
