/** Page identity primitives shared by collection and write guards. */

export interface ReviewPageIdentity {
  pageUrl: string;
  pageInstanceId: string;
  collectionId: string;
  pageFingerprint: string;
}

/** Build a stable fingerprint from strong business anchors only. */
export function buildPageFingerprint(fields: Record<string, unknown>): string {
  const anchors = [
    "application.id",
    "old_vehicle.vin",
    "new_vehicle.vin",
    "old_vehicle.owner",
    "new_vehicle.owner",
  ]
    .map((field) => [field, String(fields?.[field] || "").trim()] as const)
    .filter(([, value]) => value);
  const hasStrongAnchor = anchors.some(
    ([field]) => field === "application.id" || field.endsWith(".vin"),
  );
  return hasStrongAnchor ? JSON.stringify(anchors) : "";
}

export function createPageInstanceId(): string {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

