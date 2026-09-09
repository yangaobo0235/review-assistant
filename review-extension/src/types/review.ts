export type ImageGroup = "身份证" | "回收证明" | "旧车资料" | "新车资料" | "发票及其他图片" | "未分类";
export type BusinessType = "scrap_replacement" | "vehicle_source" | "transfer" | "consistency";
export type Region = "default" | "qingdao" | "changchun";
export type SelectionMode = "AUTO" | "MANUAL";

export interface BusinessSelection {
  businessType: BusinessType;
  region: Region;
  profileVersion: string;
  workflowStage: BusinessType;
  selectionMode: SelectionMode;
}

/** Content Script 从审核页提取的图片元数据；不包含图片二进制。 */
export interface PageImage {
  index: number;
  imageId?: string;
  src: string;
  alt: string;
  group: ImageGroup | string;
  categoryHint?: string;
  documentTypeHint?: string;
  businessScope?: string;
  groupTitle?: string;
  groupOrder?: number;
  mimeType?: string | null;
  sizeBytes?: number | null;
  dataUrl?: string | null;
  collectionError?: string | null;
  pagePosition?: string;
  naturalWidth?: number;
  naturalHeight?: number;
}

export interface PageData {
  pageUrl: string;
  pageTitle: string;
  applicationId?: string;
  pageFields: Record<string, string>;
  pageText: string;
  images: PageImage[];
  businessType?: BusinessType;
  region?: Region;
  profileVersion?: string;
  workflowStage?: BusinessType;
  selectionMode?: SelectionMode;
  businessDetectionError?: string;
  collectionDiagnostics?: {
    scannedControls: number;
    matchedFields: number;
    unmatchedLabels: string[];
    candidateCount?: number;
    ambiguousFields?: string[];
    imageSuccessCount: number;
    imageFailureCount: number;
    scannedImages?: number;
    selectedImages?: number;
    imageOverflow?: boolean;
    collectionIssues?: string[];
  };
  collectionIssues?: string[];
}

export interface MaterialCompletenessIssue {
  code: string;
  reason_code?: "material_missing" | "image_unreadable" | "recognition_failed" | "recognition_uncertain" | "evidence_not_extracted" | "page_field_missing" | null;
  reason_detail?: string | null;
  material_type?: string | null;
  business_scope?: string | null;
  field?: string | null;
  required_pages?: number[];
  present_pages?: number[];
  missing_pages?: number[];
  missing_sources?: string[];
  message: string;
  suggested_action: string;
}

export interface MaterialCompletenessReport {
  phase: "COLLECTED" | "EXTRACTED";
  status: "COMPLETE" | "INCOMPLETE" | "UNCERTAIN";
  enforced: boolean;
  issues: MaterialCompletenessIssue[];
}

export interface RetryAttempt {
  target_id: string;
  stage: "qwen" | "qr_decode" | "qr_web";
  attempt_number: number;
  reason_code: string;
  strategy: string;
  result: "succeeded" | "failed" | "skipped";
  duration_ms: number;
}

export interface RetrySummary {
  total_retries?: number;
  qwen_retries?: number;
  qr_decode_rounds?: number;
  qr_web_retries?: number;
  attempts: RetryAttempt[];
}

export type FieldStatus = "MATCH" | "CONFLICT" | "REVIEW_REQUIRED";
export type Recommendation = "PASS" | "REJECT_SUGGESTED" | "REVIEW_REQUIRED";
export type ReviewCheckStatus = "MATCH" | "CONFLICT" | "INSUFFICIENT";

export interface ReviewCheckValue {
  source: string;
  value?: string | number | null;
}

export interface ReviewCheck {
  check_id: string;
  label: string;
  status: ReviewCheckStatus;
  reason: string;
  values: ReviewCheckValue[];
  evidence?: Evidence[];
}

export interface Evidence {
  source: string;
  image_index?: number;
  detail?: string;
  image_id?: string | null;
  business_scope?: string | null;
  group_title?: string | null;
  group_order?: number | null;
  document_type?: string | null;
  value?: string | number | null;
  conflicting?: boolean;
}

declare global {
  var ReviewEvidenceLabel: {
    label(evidence: Evidence): string;
    documentNames: Record<string, string>;
  };
}

export interface FieldComparison {
  field: string;
  left_value?: string | null;
  right_value?: string | null;
  status: FieldStatus;
  source: string;
  confidence?: number | null;
  evidence: Evidence[];
  message: string;
}

export interface QrCheck {
  image_index?: number | null;
  raw_value?: string | null;
  url?: string | null;
  domain_valid?: boolean | null;
  accessible?: boolean | null;
  page_fields: Record<string, string>;
  status: FieldStatus;
  message: string;
}

export interface ReviewResponse {
  business_type: BusinessType;
  region: Region;
  profile_version: string;
  recommendation: Recommendation;
  risk_level: string;
  summary: string;
  comparisons: FieldComparison[];
  qr_checks: QrCheck[];
  cross_checks: ReviewCheck[];
  issues: string[];
  sections: ResultSection[];
  context_summary?: {
    field_count?: number;
    image_count?: number;
    image_failed_count?: number;
    completed_count?: number;
    failed_count?: number;
    timed_out_count?: number;
  };
  agent_advice?: {
    decision: "PASS" | "REVIEW_REQUIRED";
    title: string;
    summary: string;
    confidence?: number | null;
    recognition_confidence?: number | null;
    findings: ReviewCheck[];
    basis: string[];
    limitations: string[];
  } | null;
  material_completeness?: MaterialCompletenessReport | null;
  retry_summary?: RetrySummary | null;
}

export interface ResultSection {
  id: string;
  title: string;
  fields: string[];
}

export type JobStatus = "RUNNING" | "PARTIAL" | "COMPLETED" | "FAILED";

export interface ReviewProgress {
  total_count: number;
  completed_count: number;
  failed_count: number;
  timed_out_count: number;
}

export interface ReviewGroupProgress extends ReviewProgress {
  status: JobStatus;
}

export interface ReviewJobCreated {
  job_id: string;
  status: JobStatus;
  created_at: string;
}

export interface ReviewJobSnapshot {
  job_id: string;
  status: JobStatus;
  created_at: string;
  progress: ReviewProgress;
  groups: Record<string, ReviewGroupProgress>;
  result?: ReviewResponse | null;
  message?: string | null;
  material_completeness?: MaterialCompletenessReport | null;
  retry_summary?: RetrySummary | null;
}
