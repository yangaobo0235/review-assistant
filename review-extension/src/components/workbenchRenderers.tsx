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
registerWorkbenchRenderer("*", ({ review }) => <ReviewTaskWorkbench review={review} />);
