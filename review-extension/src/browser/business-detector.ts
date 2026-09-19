import { buildPageAdapterRegistry } from "../adapters/index.ts";
import type { BusinessSelection } from "../types/review";

/**
 * 功能：识别当前页面属于哪个审核业务，并处理人工选择与自动识别的冲突。
 * 职责边界：识别规则在各页面适配器里（`src/adapters/`）；本模块只提供
 * 识别入口和冲突判定，不自行维护路径表。
 */

const registry = buildPageAdapterRegistry();

/** 按页面适配器识别业务；识别不出来返回 null，不静默选择。 */
function detect(url: string, pageText = ""): BusinessSelection | null {
  return registry.selection(url, pageText);
}

/**
 * 解析本次审核的业务。
 *
 * 人工选择与自动识别矛盾时返回错误而不是以人工为准——页面说了算，
 * 否则会出现用长春的规则审青岛的单子。
 */
function resolve(
  url: string,
  pageText = "",
  manualSelection: BusinessSelection | null = null,
): { business: BusinessSelection | null; error: string | null } {
  const automatic = detect(url, pageText);

  if (!manualSelection) {
    return {
      business: automatic,
      error: automatic ? null : "无法识别当前审核业务，请人工选择",
    };
  }

  if (
    automatic
    && (automatic.businessType !== manualSelection.businessType
      || automatic.region !== manualSelection.region)
  ) {
    return { business: null, error: "人工选择的审核地区与当前页面不一致，请重新确认" };
  }

  return {
    business: {
      ...manualSelection,
      selectionMode: "MANUAL" as const,
      detectionStatus: "CONFIRMED",
    },
    error: null,
  };
}

export const ReviewBusinessDetector = { detect, resolve };
