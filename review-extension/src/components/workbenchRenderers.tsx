import type { ReactNode } from "react";
import type { PageData, PageFillAction, ReviewResponse } from "../types/review";
import type { PageFillResult } from "../pageFillClient";
import { ScrapReplacementReview } from "./ScrapReplacementReview";
import { ReviewTaskWorkbench } from "./ReviewTaskWorkbench";

export interface WorkbenchRendererProps {
  review: ReviewResponse;
  pageData: PageData | null;
  onFocusImage: (imageId: string) => Promise<void>;
  onApplyPageFieldValue: (field: string, value: string, expectedValue?: string | null) => Promise<PageFillResult>;
  onApplyAffiliationFill: (actions: PageFillAction[]) => Promise<PageFillResult>;
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
registerWorkbenchRenderer("*", ({ review }) => <ReviewTaskWorkbench review={review} />);
