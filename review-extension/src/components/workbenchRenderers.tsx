import type { ReactNode } from "react";
import type { PageData, ReviewResponse } from "../types/review";
import type { PageFillResult } from "../pageFillClient";
import { ScrapReplacementReview } from "./ScrapReplacementReview";
import { ReviewTaskWorkbench } from "./ReviewTaskWorkbench";

export interface WorkbenchRendererProps {
  review: ReviewResponse;
  pageData: PageData | null;
  onFocusImage: (imageId: string) => Promise<{ ok: boolean; error?: string }>;
  onApplyPageFieldValue: (field: string, value: string, expectedValue?: string | null) => Promise<PageFillResult>;
  onApplyPageFieldGroupValue: (fields: string[], value: string, expectedValues?: Record<string, string | null | undefined>) => Promise<PageFillResult>;
  onRerun: () => Promise<void>;
}

type WorkbenchRenderer = (props: WorkbenchRendererProps) => ReactNode;

const renderers = new Map<string, WorkbenchRenderer>();

export function registerWorkbenchRenderer(key: string, renderer: WorkbenchRenderer): void {
  if (!key || renderers.has(key)) throw new Error(`工作台渲染器已注册：${key}`);
  renderers.set(key, renderer);
}

export function resolveWorkbenchRenderer(review: ReviewResponse): WorkbenchRenderer | null {
  const exactKey = `${review.business_type}|${review.region}|${review.profile_version}`;
  return renderers.get(exactKey) || (review.review_tasks?.length ? renderers.get("*") || null : null);
}

registerWorkbenchRenderer("scrap_replacement|qingdao|1.0", (props) => <ScrapReplacementReview {...props} />);
registerWorkbenchRenderer("scrap_replacement|changchun|1.0", (props) => <ScrapReplacementReview {...props} />);
// 车源审核共用字段优先工作台，但两处展示策略不同：
// - 材料要求（行驶证必须有、登记证书与铭牌二选一）必须让审核员看到；
// - 车型的马力/整车型号/排放标准三条结论已经投影到「车型」字段行里，
//   后端不再单独下发这些任务，页签也就不需要了。
registerWorkbenchRenderer(
  "vehicle_source|default|1.0",
  (props) => <ScrapReplacementReview {...props} materialTasksVisible externalView={false} />,
);
// 过户审核同样用字段优先工作台。三份材料必须让审核员看到——登记证书第 3、4 页
// 缺了就没法核买家名称和证件号，那是两份材料共同支撑的字段；材料完整性被静默
// 藏起来时，审核员只会看到两个字段「证据不足」，不知道是缺哪张图。
// 开票日期的规则结论已经投影到「开票日期」字段行，不需要页面外核验页签。
registerWorkbenchRenderer(
  "transfer|default|1.0",
  (props) => <ScrapReplacementReview {...props} materialTasksVisible externalView={false} />,
);
registerWorkbenchRenderer("*", ({ review }) => <ReviewTaskWorkbench review={review} />);
