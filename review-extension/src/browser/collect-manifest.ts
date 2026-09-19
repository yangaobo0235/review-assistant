/**
 * 页面采集清单：后端下发的字段别名、页面分组标题和材料分组关键词。
 *
 * 职责边界：只做结构转换和暂存，不判断业务。后端是这几张表的唯一来源，
 * 各模块里的内置表只作为清单不可用时的兜底；清单一旦应用就优先使用。
 */
import type { FieldDefinition } from "./dom.ts";

export interface ManifestField {
  key: string;
  label: string;
  aliases: string[];
  section: string;
  section_required: boolean;
  reviewable: boolean;
}

export interface ManifestPageGroup {
  label: string;
  scope: string;
  title: string;
}

export interface ManifestMaterial {
  document_type: string;
  label: string;
  hints: string[];
  /** 上传槽位 [业务分区, 组内序号]，用于类型不确定时兜底。 */
  slots: [string, number][];
}

export interface CollectManifest {
  business_type: string;
  /** 该业务认定的材料分区，如旧车 / 新车。 */
  scopes: string[];
  page_groups: ManifestPageGroup[];
  fields: ManifestField[];
  materials: ManifestMaterial[];
}

export interface ManifestImageProfile {
  /** 已知的图片类型：材料类型 + 页面分组分区（非材料分区除外）。 */
  knownTypes: Set<string>;
  /** 材料分组关键词构成的正则，用于判断图片是否属于审核材料。 */
  hintsPattern: RegExp;
  /** 业务认定的材料分区，用于给图片打分。 */
  scopes: Set<string>;
}

const NEVER_MATCHES = /$^/;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildImageProfile(manifest: CollectManifest): ManifestImageProfile {
  const hints = [...new Set(manifest.materials.flatMap((item) => item.hints))].filter(Boolean);
  return {
    knownTypes: new Set([
      ...manifest.materials.map((item) => item.document_type),
      ...manifest.page_groups.map((group) => group.scope).filter((scope) => scope !== "other"),
    ]),
    hintsPattern: hints.length ? new RegExp(hints.map(escapeRegExp).join("|")) : NEVER_MATCHES,
    scopes: new Set(manifest.scopes),
  };
}

export function toFieldDefinitions(manifest: CollectManifest): Record<string, FieldDefinition> {
  const definitions: Record<string, FieldDefinition> = {};
  for (const field of manifest.fields) {
    const definition: FieldDefinition = {
      aliases: [...field.aliases],
      section: field.section,
    };
    // 与内置表保持同样的写法：只在偏离默认值时写出这两个标记。
    if (!field.reviewable) definition.reviewable = false;
    if (field.section_required) definition.sectionRequired = true;
    definitions[field.key] = definition;
  }
  return definitions;
}

export function toGroupLabelEntries(
  manifest: CollectManifest,
): [string, { scope: string; title: string }][] {
  return manifest.page_groups.map((group) => [
    group.label,
    { scope: group.scope, title: group.title },
  ]);
}

let appliedFields: Record<string, FieldDefinition> | null = null;
let appliedGroups: [string, { scope: string; title: string }][] | null = null;
let appliedImageProfile: ManifestImageProfile | null = null;
let appliedSlots: [string, string][] | null = null;
let appliedFieldLabels: Record<string, string> | null = null;
let appliedMaterialLabels: Record<string, string> | null = null;

const isValid = (manifest: unknown): manifest is CollectManifest => {
  const candidate = manifest as CollectManifest | null;
  return Boolean(
    candidate
      && Array.isArray(candidate.scopes)
      && Array.isArray(candidate.fields)
      && Array.isArray(candidate.page_groups)
      && Array.isArray(candidate.materials),
  );
};

/**
 * 应用后端下发的采集清单。结构不完整时返回 false 并清空，调用方继续用内置表。
 */
export function applyCollectManifest(manifest: unknown): boolean {
  if (!isValid(manifest)) {
    appliedFields = null;
    appliedGroups = null;
    appliedImageProfile = null;
    appliedSlots = null;
    appliedFieldLabels = null;
    appliedMaterialLabels = null;
    return false;
  }
  appliedFields = toFieldDefinitions(manifest);
  appliedGroups = toGroupLabelEntries(manifest);
  appliedImageProfile = buildImageProfile(manifest);
  appliedSlots = manifest.materials.flatMap((item) =>
    (item.slots ?? []).map(
      ([scope, order]) => [`${scope}:${order}`, item.document_type] as [string, string],
    ),
  );
  appliedFieldLabels = Object.fromEntries(
    manifest.fields.map((field) => [field.key, field.label]),
  );
  appliedMaterialLabels = Object.fromEntries(
    manifest.materials.map((item) => [item.document_type, item.label]),
  );
  return true;
}

/** 已应用的上传槽位表；没有应用清单时返回 null，调用方退回内置表。 */
export function manifestSlotEntries(): [string, string][] | null {
  return appliedSlots;
}

/** 已应用的图片筛选依据；没有应用清单时返回 null，调用方退回内置规则。 */
export function manifestImageProfile(): ManifestImageProfile | null {
  return appliedImageProfile;
}

/** 已应用的字段定义；没有应用清单时返回 null，调用方退回内置表。 */
export function manifestFieldDefinitions(): Record<string, FieldDefinition> | null {
  return appliedFields;
}

/** 已应用的页面分组标题表；没有应用清单时返回 null。 */
export function manifestGroupLabelEntries(): [string, { scope: string; title: string }][] | null {
  return appliedGroups;
}

/**
 * 已应用的字段中文标签；没有应用清单时返回 null，调用方退回内置表。
 *
 * 侧边栏和 Content Script 是两个独立的运行时，各自应用同一份清单：采集
 * 逻辑在 Content Script，展示用的中文名在侧边栏。
 */
export function manifestFieldLabels(): Record<string, string> | null {
  return appliedFieldLabels;
}

/** 已应用的材料显示名（材料类型 → 中文名）；没有应用清单时返回 null。 */
export function manifestMaterialLabels(): Record<string, string> | null {
  return appliedMaterialLabels;
}

/** 拉取某个业务的采集清单；失败返回 null，调用方退回内置表。 */
export async function fetchCollectManifest(
  baseUrl: string,
  businessType: string,
  fetcher: typeof fetch = fetch,
): Promise<CollectManifest | null> {
  try {
    const response = await fetcher(
      `${baseUrl}/api/review/collect-manifest?business_type=${encodeURIComponent(businessType)}`,
    );
    if (!response.ok) return null;
    const manifest = await response.json();
    return isValid(manifest) ? manifest : null;
  } catch {
    return null;
  }
}
