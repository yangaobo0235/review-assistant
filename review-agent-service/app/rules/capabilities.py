"""方案 C 的能力处理器共享契约。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, Protocol

from app.agent.models import AgentBatchResult, ReviewCheck
from app.models.review import (
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
class ReviewExecutionContext:
    request: ReviewRequest
    profile: BusinessProfile
    batch: AgentBatchResult
    observations: tuple[FieldObservation, ...]
    comparisons: tuple[FieldComparison, ...] = ()
    qr_checks: tuple[QrCheck, ...] = ()


@dataclass(frozen=True)
class RuleExecutionResult:
    checks: tuple[ReviewCheck, ...] = ()
    page_action_candidates: tuple[PageFillAction, ...] = ()


class ExternalCheckHandler(Protocol):
    async def __call__(
        self,
        context: ReviewExecutionContext,
        spec: ExternalCheckSpec,
    ) -> tuple[ReviewCheck | QrCheck, ...]: ...


class BusinessRuleHandler(Protocol):
    def __call__(self, context: ReviewExecutionContext) -> RuleExecutionResult: ...
