import type { ReviewResponse } from "./types/review";

const FIELD_WORKBENCH_PROFILES: ReadonlySet<string> = new Set([
  "scrap_replacement|qingdao|1.0",
  "scrap_replacement|changchun|1.0",
]);

/** Only the approved Qingdao/Changchun scrap profiles use the EvidenceFact workbench. */
export function isFieldFirstProfile(
  review: Pick<ReviewResponse, "business_type" | "region" | "profile_version">,
): boolean {
  return FIELD_WORKBENCH_PROFILES.has(
    `${review.business_type}|${review.region}|${review.profile_version}`,
  );
}
