import type { SkiloomHomePaths } from "../home.js";
import {
  observePackageCommonSoftware,
  type HostObservationDiagnosticCode,
  type HostProbeExecutor
} from "../host-observation/index.js";
import type {
  RegistryDependencyObservation,
  RegistryResolvedPackage
} from "../registry/model.js";
import { verifyPackageStoreEntry } from "../store.js";

export type DoctorPackageIssue = Readonly<{
  code:
    | "StoreEntryMissing"
    | "StoreEntryCorrupt"
    | HostObservationDiagnosticCode
    | "InvalidHostObservationMetadata";
  severity: "warning" | "error";
  subject: string;
  recommendation: "repair" | null;
  facts: Readonly<Record<string, unknown>>;
}>;

export type DoctorPackageInspection = Readonly<{
  storeHealthy: ReadonlyMap<string, boolean>;
  storesHealthy: boolean;
  observations: ReadonlyArray<RegistryDependencyObservation>;
  issues: ReadonlyArray<DoctorPackageIssue>;
}>;

export function sortDoctorObservations(
  observations: ReadonlyArray<RegistryDependencyObservation>
): ReadonlyArray<RegistryDependencyObservation> {
  return [...observations].sort((left, right) =>
    compareUtf8(
      [left.packageCoordinate, left.kind, left.name].join("\0"),
      [right.packageCoordinate, right.kind, right.name].join("\0")
    )
  );
}

export async function inspectDoctorPackages(
  home: SkiloomHomePaths,
  packages: ReadonlyArray<RegistryResolvedPackage>,
  execute?: HostProbeExecutor
): Promise<DoctorPackageInspection> {
  const storeHealthy = new Map<string, boolean>();
  const observations: RegistryDependencyObservation[] = [];
  const issues: DoctorPackageIssue[] = [];
  let storesHealthy = true;

  for (const packageFact of packages) {
    const verified = await verifyPackageStoreEntry(
      home,
      packageFact.contentDigest
    );
    const healthy = verified.ok;
    storeHealthy.set(packageFact.packageCoordinate, healthy);
    if (!healthy) {
      const missing =
        verified.error.code === "StoreEntryNotFound";
      issues.push({
        code: missing
          ? "StoreEntryMissing"
          : "StoreEntryCorrupt",
        severity: "error",
        subject: packageFact.packageCoordinate,
        recommendation: "repair",
        facts: {
          storeError: verified.error.code
        }
      });
      storesHealthy = false;
      continue;
    }

    const host = await observePackageCommonSoftware({
      packageCoordinate: packageFact.packageCoordinate,
      packageContentDigest: packageFact.contentDigest,
      snapshot: verified.value.snapshot,
      ...(execute === undefined ? {} : { execute })
    });
    observations.push(...host.observations);
    for (const issue of host.diagnostics) {
      issues.push({
        code: issue.code,
        severity: "warning",
        subject: issue.packageCoordinate,
        recommendation: null,
        facts: issue.facts
      });
    }
  }

  return {
    storeHealthy,
    storesHealthy,
    observations,
    issues
  };
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  );
}
