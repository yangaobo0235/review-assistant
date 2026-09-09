"""审核领域与 API 模型。

主要职责：定义请求、响应、证据、比较和任务状态契约。
修改日期：2026-08-26
修改人：wuyi
"""

from enum import StrEnum
from typing import Any

from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    HttpUrl,
    model_validator,
)

from app.agent.models import (
    AgentAdvice,
    MaterialCompletenessReport,
    RetrySummary,
    ReviewCheck,
)


class FieldStatus(StrEnum):
    MATCH = "MATCH"
    CONFLICT = "CONFLICT"
    REVIEW_REQUIRED = "REVIEW_REQUIRED"


class Recommendation(StrEnum):
    PASS = "PASS"
    REJECT_SUGGESTED = "REJECT_SUGGESTED"
    REVIEW_REQUIRED = "REVIEW_REQUIRED"


class JobStatus(StrEnum):
    RUNNING = "RUNNING"
    PARTIAL = "PARTIAL"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class BusinessType(StrEnum):
    SCRAP_REPLACEMENT = "scrap_replacement"
    VEHICLE_SOURCE = "vehicle_source"
    TRANSFER = "transfer"
    CONSISTENCY = "consistency"


class Region(StrEnum):
    DEFAULT = "default"
    QINGDAO = "qingdao"
    CHANGCHUN = "changchun"


class SelectionMode(StrEnum):
    AUTO = "AUTO"
    MANUAL = "MANUAL"


class ImageInput(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    index: int = Field(ge=0)
    src: str
    group: str = "未分类"
    image_id: str | None = Field(default=None, validation_alias=AliasChoices("image_id", "imageId"))
    category_hint: str = Field(
        default="unknown",
        validation_alias=AliasChoices("category_hint", "categoryHint"),
    )
    business_scope: str = Field(
        default="unknown",
        validation_alias=AliasChoices("business_scope", "businessScope"),
    )
    group_title: str = Field(
        default="未分类资料",
        validation_alias=AliasChoices("group_title", "groupTitle"),
    )
    group_order: int | None = Field(
        default=None,
        ge=1,
        validation_alias=AliasChoices("group_order", "groupOrder"),
    )
    document_type_hint: str = Field(
        default="unknown",
        validation_alias=AliasChoices("document_type_hint", "documentTypeHint"),
    )
    mime_type: str | None = Field(default=None, validation_alias=AliasChoices("mime_type", "mimeType"))
    size_bytes: int | None = Field(default=None, ge=0, validation_alias=AliasChoices("size_bytes", "sizeBytes"))
    data_url: str | None = Field(default=None, validation_alias=AliasChoices("data_url", "dataUrl"))
    collection_error: str | None = Field(
        default=None,
        validation_alias=AliasChoices("collection_error", "collectionError"),
    )
    alt: str = ""
    page_position: str | None = Field(
        default=None,
        validation_alias=AliasChoices("page_position", "pagePosition"),
    )

    @model_validator(mode="before")
    @classmethod
    def derive_legacy_business_scope(cls, value: Any) -> Any:
        if not isinstance(value, dict) or "business_scope" in value or "businessScope" in value:
            return value
        category = value.get("category_hint", value.get("categoryHint", "unknown"))
        old_types = {"scrap_certificate", "old_vehicle", "registration_certificate"}
        new_types = {"new_vehicle", "invoice"}
        scope = "old_vehicle" if category in old_types else "new_vehicle" if category in new_types else "unknown"
        return {**value, "business_scope": scope}


class Evidence(BaseModel):
    source: str
    image_index: int | None = None
    detail: str | None = None
    image_id: str | None = None
    business_scope: str | None = None
    group_title: str | None = None
    group_order: int | None = None
    document_type: str | None = None
    value: Any = None
    conflicting: bool = False


class FieldObservation(BaseModel):
    """One independently observed value and its review-document source."""

    field: str
    source_type: str
    source_id: str
    value: Any = None
    document_type: str | None = None
    image_index: int | None = None
    image_id: str | None = None
    business_scope: str | None = None
    group_title: str | None = None
    group_order: int | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)


class FieldComparison(BaseModel):
    field: str
    left_value: Any = None
    right_value: Any = None
    status: FieldStatus
    source: str = "rule_engine"
    confidence: float | None = Field(default=None, ge=0, le=1)
    evidence: list[Evidence] = Field(default_factory=list)
    message: str = ""


class QrCheck(BaseModel):
    image_index: int | None = None
    raw_value: str | None = None
    url: str | None = None
    domain_valid: bool | None = None
    accessible: bool | None = None
    page_fields: dict[str, Any] = Field(default_factory=dict)
    status: FieldStatus = FieldStatus.REVIEW_REQUIRED
    message: str = ""


class ReviewRequest(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    page_url: HttpUrl | str = Field(validation_alias=AliasChoices("page_url", "pageUrl"))
    business_type: BusinessType = Field(
        default=BusinessType.SCRAP_REPLACEMENT,
        validation_alias=AliasChoices("business_type", "businessType"),
    )
    region: Region = Region.QINGDAO
    profile_version: str = Field(
        default="1.0",
        validation_alias=AliasChoices("profile_version", "profileVersion"),
    )
    selection_mode: SelectionMode = Field(
        default=SelectionMode.AUTO,
        validation_alias=AliasChoices("selection_mode", "selectionMode"),
    )
    workflow_stage: str = Field(
        default="scrap_replacement",
        validation_alias=AliasChoices("workflow_stage", "workflowStage"),
    )
    application_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("application_id", "applicationId"),
    )
    page_title: str = Field(
        default="",
        validation_alias=AliasChoices("page_title", "pageTitle"),
    )
    page_fields: dict[str, Any] = Field(
        default_factory=dict,
        validation_alias=AliasChoices("page_fields", "pageFields"),
    )
    images: list[ImageInput] = Field(default_factory=list)
    collection_diagnostics: "CollectionDiagnostics" = Field(
        default_factory=lambda: CollectionDiagnostics(),
        validation_alias=AliasChoices("collection_diagnostics", "collectionDiagnostics"),
    )


class CollectionDiagnostics(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    scanned_controls: int = Field(default=0, ge=0, validation_alias=AliasChoices("scanned_controls", "scannedControls"))
    matched_fields: int = Field(default=0, ge=0, validation_alias=AliasChoices("matched_fields", "matchedFields"))
    unmatched_labels: list[str] = Field(default_factory=list, validation_alias=AliasChoices("unmatched_labels", "unmatchedLabels"))
    candidate_count: int = Field(default=0, ge=0, validation_alias=AliasChoices("candidate_count", "candidateCount"))
    ambiguous_fields: list[str] = Field(default_factory=list, validation_alias=AliasChoices("ambiguous_fields", "ambiguousFields"))
    image_success_count: int = Field(default=0, ge=0, validation_alias=AliasChoices("image_success_count", "imageSuccessCount"))
    image_failure_count: int = Field(default=0, ge=0, validation_alias=AliasChoices("image_failure_count", "imageFailureCount"))
    scanned_images: int = Field(default=0, ge=0, validation_alias=AliasChoices("scanned_images", "scannedImages"))
    selected_images: int = Field(default=0, ge=0, validation_alias=AliasChoices("selected_images", "selectedImages"))
    image_overflow: bool = Field(default=False, validation_alias=AliasChoices("image_overflow", "imageOverflow"))
    collection_issues: list[str] = Field(default_factory=list, validation_alias=AliasChoices("collection_issues", "collectionIssues"))


class ResultSection(BaseModel):
    id: str
    title: str
    fields: list[str] = Field(default_factory=list)


class ReviewResponse(BaseModel):
    business_type: BusinessType = BusinessType.SCRAP_REPLACEMENT
    region: Region = Region.QINGDAO
    profile_version: str = "1.0"
    recommendation: Recommendation
    risk_level: str
    summary: str
    comparisons: list[FieldComparison] = Field(default_factory=list)
    qr_checks: list[QrCheck] = Field(default_factory=list)
    cross_checks: list[ReviewCheck] = Field(default_factory=list)
    issues: list[str] = Field(default_factory=list)
    sections: list[ResultSection] = Field(default_factory=list)
    context_summary: dict[str, Any] = Field(default_factory=dict)
    agent_advice: AgentAdvice | None = None
    material_completeness: MaterialCompletenessReport | None = None
    retry_summary: RetrySummary | None = None


class ReviewProgress(BaseModel):
    total_count: int = 0
    completed_count: int = 0
    failed_count: int = 0
    timed_out_count: int = 0


class ReviewGroupProgress(ReviewProgress):
    status: JobStatus = JobStatus.RUNNING


class ReviewJobCreated(BaseModel):
    job_id: str
    status: JobStatus = JobStatus.RUNNING
    created_at: str


class ReviewJobSnapshot(BaseModel):
    job_id: str
    status: JobStatus
    created_at: str
    progress: ReviewProgress
    groups: dict[str, ReviewGroupProgress] = Field(default_factory=dict)
    result: ReviewResponse | None = None
    message: str | None = None
    material_completeness: MaterialCompletenessReport | None = None
    retry_summary: RetrySummary | None = None
