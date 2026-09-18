import {
  productError,
  type ProductError,
  type Result
} from "../../../../domain/errors/index.js";
import type {
  TargetRecoveryMarkerFacts
} from "../../../../domain/target/recovery.js";
import {
  parseTargetStateMarker,
  writeTargetStateMarker
} from "../../../../domain/target/state-marker.js";
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
  const canonical = parseTargetStateMarker(
    writeTargetStateMarker(input.marker)
  );
  if (!canonical.ok) {
    return failed(input.marker);
  }

  if (input.override !== undefined) {
    try {
      await input.override(canonical.value);
      return { ok: true, value: undefined };
    } catch {
      return failed(input.marker);
    }
  }

  const written = await writeTargetStateMarkerFile(
    input.targetRoot,
    canonical.value
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
