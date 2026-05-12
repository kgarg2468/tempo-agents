import type { Fingerprint, TempoConflict } from "@tempo/shared";

export function activeSessionConflict(
  conflicts: TempoConflict[]
): TempoConflict | undefined {
  return conflicts.find(
    (conflict) => conflict.status === "open" || conflict.status === "acknowledged"
  );
}

export function surfaceLabelsForSessionGraph({
  conflicts
}: {
  fingerprints: Fingerprint[];
  conflicts: TempoConflict[];
}): string[] {
  const activeConflict = activeSessionConflict(conflicts);
  if (!activeConflict) return [];
  return [activeConflict.primarySurface];
}

export function targetSurfacesForFingerprint(
  fingerprint: Fingerprint,
  activeConflict: TempoConflict | undefined
): string[] {
  if (
    activeConflict &&
    activeConflict.affectedWorktreeIds.includes(fingerprint.worktreeId)
  ) {
    return [activeConflict.primarySurface];
  }
  return [];
}

export function surfaceId(label: string): string {
  return `surface-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}
