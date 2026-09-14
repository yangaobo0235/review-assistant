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
SCRAP_REPLACEMENT_MATERIAL_POLICY = MaterialPolicy(
    mode="enforce",
    materials=(
        MaterialRequirement("vehicle_license", "old_vehicle", display_name="旧车行驶证"),
        MaterialRequirement(
            "registration_certificate",
            "old_vehicle",
            required_pages=(1, 2),
            display_name="旧车登记证第 1、2 页",
        ),
        MaterialRequirement("scrap_certificate", "old_vehicle", display_name="报废证明"),
        MaterialRequirement("vehicle_license", "new_vehicle", display_name="新车行驶证"),
        MaterialRequirement(
            "registration_certificate",
            "new_vehicle",
            required_pages=(1, 2),
            display_name="新车登记证第 1、2 页",
        ),
        MaterialRequirement("invoice", "new_vehicle", display_name="新车发票"),
    ),
)

TRANSFER_MATERIAL_POLICY = MaterialPolicy(mode="disabled")
