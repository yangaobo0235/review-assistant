/** Page identity primitives shared by collection and write guards. */

export interface ReviewPageIdentity {
  pageUrl: string;
  pageInstanceId: string;
  collectionId: string;
  pageFingerprint: string;
}

/**
 * 内置指纹锚点：采集清单不可用时的兜底，与报废置换的历史口径一致。
 *
 * 锚点是**业务知识**（哪个字段能唯一标识这条审核记录），正常运行时不从这里
 * 取，而是由后端随采集清单下发，见 `manifestIdentityAnchors()`。
 */
export const BUILTIN_IDENTITY_ANCHORS = [
  "application.id",
  "old_vehicle.vin",
  "new_vehicle.vin",
  "old_vehicle.owner",
  "new_vehicle.owner",
] as const;

/** 强锚点：能唯一标识记录的编号类字段；只有它们存在时指纹才算数。 */
const isStrongAnchor = (field: string) =>
  field === "application.id" || field.endsWith(".vin");

/**
 * 用业务锚点拼出页面指纹。
 *
 * 指纹只收**有值的**锚点：空字段写进去只会让指纹随页面渲染时机抖动。
 * 一个强锚点都没有时返回空串——空指纹会让所有页面写回和原图定位拒绝执行，
 * 这比拿"所有人姓名"这类弱字段充当身份安全。
 *
 * 锚点必须由业务声明：写死成报废置换的字段名会让另一个业务（车源页面上
 * 根本没有 `old_vehicle.*`）永远拿不到指纹，表现就是"点了没反应"。
 */
export function buildPageFingerprint(
  fields: Record<string, unknown>,
  anchors: readonly string[] = BUILTIN_IDENTITY_ANCHORS,
): string {
  const present = anchors
    .map((field) => [field, String(fields?.[field] || "").trim()] as const)
    .filter(([, value]) => value);
  return present.some(([field]) => isStrongAnchor(field)) ? JSON.stringify(present) : "";
}

export function createPageInstanceId(): string {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}
