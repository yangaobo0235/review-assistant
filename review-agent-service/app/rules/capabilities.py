"""方案 C 的能力处理器共享契约。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, Protocol

from app.agent.models import AgentBatchResult, CheckResult
from app.models.review import (
    CapabilityResult,
    FieldComparison,
    FieldObservation,
    PageFillAction,
    QrCheck,
    ReviewRequest,
)

if TYPE_CHECKING:
    from app.businesses.profiles import BusinessProfile


@dataclass(frozen=True)
class ExternalCheckSpec:
    check_id: str
    mode: Literal["REQUIRED", "WHEN_PRESENT"]

    def __post_init__(self) -> None:
        if self.mode not in ("REQUIRED", "WHEN_PRESENT"):
            raise ValueError(f"未知外部核验模式：{self.mode}")


@dataclass(frozen=True)
class CapabilitySpec:
    capability_id: str
    kind: Literal["EXTERNAL", "RULE", "MATERIAL"] = "RULE"
    version: str = "1.0"
    stage: Literal[
        "INPUT_COVERAGE", "EVIDENCE", "PRE_COMPARE", "POST_COMPARE", "FINAL_REVIEW"
    ] = "POST_COMPARE"
    input_facts: tuple[str, ...] = ()
    output_facts: tuple[str, ...] = ()
    required: bool = True
    dependencies: tuple[str, ...] = ()
    timeout_seconds: float = 30
    retries: int = 0
    failure_policy: Literal["BLOCK", "MANUAL_REVIEW", "SAFE_DEGRADE", "SKIP"] = "MANUAL_REVIEW"

    def __post_init__(self) -> None:
        if self.kind not in ("EXTERNAL", "RULE", "MATERIAL"):
            raise ValueError(f"未知能力类型：{self.kind}")
        if self.stage not in ("INPUT_COVERAGE", "EVIDENCE", "PRE_COMPARE", "POST_COMPARE", "FINAL_REVIEW"):
            raise ValueError(f"未知能力阶段：{self.stage}")
        if self.failure_policy not in ("BLOCK", "MANUAL_REVIEW", "SAFE_DEGRADE", "SKIP"):
            raise ValueError(f"未知能力失败策略：{self.failure_policy}")
        if self.timeout_seconds <= 0 or not 0 <= self.retries <= 3:
            raise ValueError("能力超时必须为正数，重试次数范围为 0–3")


@dataclass(frozen=True)
class CapabilityBinding:
    """Profile 对注册能力的一次声明，不包含执行代码。"""

    capability_id: str
    enabled: bool = True
    required: bool | None = None
    parameters: tuple[tuple[str, str], ...] = ()

    def parameter_dict(self) -> dict[str, str]:
        return dict(self.parameters)




class CapabilityHandler(Protocol):
    async def __call__(self, context: ReviewExecutionContext, spec: CapabilitySpec) -> CapabilityResult: ...


@dataclass(frozen=True)
class ReviewExecutionContext:
    request: ReviewRequest
    profile: BusinessProfile
    batch: AgentBatchResult
    observations: tuple[FieldObservation, ...]
    comparisons: tuple[FieldComparison, ...] = ()
    qr_checks: tuple[QrCheck, ...] = ()


@dataclass(frozen=True)
class RuleExecutionResult:
    checks: tuple[CheckResult, ...] = ()
    page_action_candidates: tuple[PageFillAction, ...] = ()


class ExternalCheckHandler(Protocol):
    async def __call__(
        self,
        context: ReviewExecutionContext,
        spec: ExternalCheckSpec,
    ) -> tuple[CheckResult | QrCheck, ...]: ...


class BusinessRuleHandler(Protocol):
    def __call__(self, context: ReviewExecutionContext) -> RuleExecutionResult: ...
