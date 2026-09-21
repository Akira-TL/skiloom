export {
  openMachineRegistry,
  type MachineRegistry,
  type RegistryLocationLockedError,
  type RegistryObservationLockedError,
  type RegistryOpenError,
  type RegistryPendingLockedError,
  type RegistryReplaceLockedError
} from "./locked.js";
export {
  createRegistryBackup,
  restoreRegistryBackup,
  type RegistryBackupFailed,
  type RegistryBackupInfo,
  type RegistryCorrupt,
  type RegistryMaintenanceError,
  type RegistryMigrationFailed,
  type RegistryMigrationUnsupported,
  type RegistryRestoreError,
  type RegistryRestoreFailed,
  type RegistrySchemaTooNew
} from "./maintenance.js";
export {
  CURRENT_REGISTRY_SCHEMA_VERSION
} from "./schema.js";
export { readPendingOperations } from "./read.js";
export type {
  RegistryDependencyEdge,
  RegistryDependencyObservation,
  RegistryDetachedBaseline,
  RegistryForkLocationTransfer,
  RegistryDirectRequirement,
  RegistryProjection,
  RegistryResolvedPackage,
  RegistryResolvedSource,
  RegistryTargetLocation,
  RegistryTargetState,
  RegistryTargetStateInput,
  RegistryPendingOperation,
  RegistryPendingOperationInput,
  RegistryPendingProjectionAction
} from "./model.js";
