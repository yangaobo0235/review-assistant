"""业务材料要求和受控执行预算。"""

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class SourceSelector:
    source_type: str
    document_type: str | None = None
    business_scope: str | None = None
    required_page: int | None = None


@dataclass(frozen=True)
class FieldSourceRequirement:
    field: str
    all_of: tuple[SourceSelector, ...] = ()
    any_of_groups: tuple[tuple[SourceSelector, ...], ...] = ()


@dataclass(frozen=True)
class MaterialRequirement:
    document_type: str
    business_scope: str
    minimum_count: int = 1
    required_pages: tuple[int, ...] = ()
    display_name: str = "审核材料"


@dataclass(frozen=True)
class RetryPolicy:
    semantic_retry_count: int = 1
    confidence_threshold: float = 0.70
    minimum_retry_window_seconds: float = 2.0
    qr_decode_max_rounds: int = 3
    qr_web_retry_count: int = 1


@dataclass(frozen=True)
class MaterialPolicy:
    mode: Literal["disabled", "observe", "enforce"]
    materials: tuple[MaterialRequirement, ...] = ()
    field_sources: tuple[FieldSourceRequirement, ...] = ()


DEFAULT_RETRY_POLICY = RetryPolicy()
TRANSFER_MATERIAL_POLICY = MaterialPolicy(mode="disabled")
