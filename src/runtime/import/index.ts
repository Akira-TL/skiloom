export {
  importExactPackage,
  type ExactImportError,
  type ExactImportResult,
  type ExactImportSourceAcceptanceFacts,
  type ExactImportSourceAcceptanceFailed,
  type ExactImportTargetIdentityConflict,
  type ExactImportTargetNotEmpty,
  type ExactImportTargetUnavailable,
  type ImportExactPackageInput,
  type InvalidExactImportTargetIdentity
} from "./exact.js";

export {
  mergeExactPackage,
  type ExactMergeAuthorizationRequired,
  type ExactMergeTargetObservationFailed,
  type MergeExactPackageError,
  type MergeExactPackageInput,
  type MergeExactPackageResult
} from "./merge.js";
