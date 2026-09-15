"""确定性检查结果，与材料事实和人工任务分离。"""

from typing import Any, Literal

from pydantic import BaseModel, Field

from app.models.evidence import DifferenceRange, EvidenceFact


class CheckResultValue(BaseModel):
    """确定性检查中参与比较的单个来源值。"""

    source: str
    differences: list[DifferenceRange] = Field(default_factory=list)
    value: Any = None
    source_id: str | None = None
    image_id: str | None = None
    image_index: int | None = None
    document_type: str | None = None
    detail: str | None = None
    derived_from: str | None = None
    evidence_region: list[float] | None = None


class CheckResult(BaseModel):
    """一项确定性审核检查的状态、原因和证据。"""

    check_id: str
    label: str
    status: Literal["MATCH", "CONFLICT", "INSUFFICIENT"]
    reason: str
    values: list[CheckResultValue] = Field(default_factory=list)
    evidence: list[EvidenceFact] = Field(default_factory=list)
    details: dict[str, Any] = Field(default_factory=dict)

