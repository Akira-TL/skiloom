import {
  productError,
  type ProductError,
  type Result
} from "../../../../domain/errors/index.js";
import type {
  TargetRecoveryMarkerFacts
} from "../../../../domain/target/recovery.js";
import {
  writeTargetStateMarkerFile
} from "../../../target-state-marker.js";

export type LifecycleMarkerSyncCallback = (
  marker: TargetRecoveryMarkerFacts
) => void | Promise<void>;

export type LifecycleMarkerSyncFailed = ProductError<
  "LifecycleMarkerSyncFailed",
  Readonly<{
    targetId: string;
    generation: number;
  }>
>;

export async function syncLifecycleMarker(
  input: Readonly<{
    targetRoot: string;
    marker: TargetRecoveryMarkerFacts;
    override?: LifecycleMarkerSyncCallback;
  }>
): Promise<Result<void, LifecycleMarkerSyncFailed>> {
  if (input.override !== undefined) {
    try {
      await input.override(input.marker);
      return { ok: true, value: undefined };
    } catch {
      return failed(input.marker);
    }
  }

  const written = await writeTargetStateMarkerFile(
    input.targetRoot,
    input.marker
  );
  return written.ok
    ? { ok: true, value: undefined }
    : failed(input.marker);
}

function failed(
  marker: TargetRecoveryMarkerFacts
): Result<never, LifecycleMarkerSyncFailed> {
  return {
    ok: false,
    error: productError("LifecycleMarkerSyncFailed", {
      targetId: marker.targetId,
      generation: marker.generation
    })
  };
}
