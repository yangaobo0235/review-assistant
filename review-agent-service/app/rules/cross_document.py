"""跨材料规则分派入口。

主要职责：根据业务类型调用对应的确定性跨材料检查。
修改日期：2026-08-26
修改人：wuyi
"""

from typing import Any

from app.agent.models import ReviewCheck
from app.models.review import BusinessType, FieldComparison, FieldObservation
from app.rules.scrap_replacement_checks import build_scrap_replacement_checks
from app.rules.transfer_checks import build_transfer_checks


def build_cross_document_checks(
    business_type: BusinessType | list[FieldComparison],
    comparisons: list[FieldComparison] | None = None,
    observations: list[FieldObservation] | None = None,
    page_fields: dict[str, Any] | None = None,
) -> list[ReviewCheck]:
    """按业务类型分派跨材料检查，并兼容既有调用参数。"""

    # Older callers passed comparisons as the first positional argument before
    # multi-business routing existed. Keep that path until those clients migrate.
    if isinstance(business_type, list):
        return build_scrap_replacement_checks(business_type)

    resolved_comparisons = comparisons or []
    if business_type is BusinessType.SCRAP_REPLACEMENT:
        return build_scrap_replacement_checks(resolved_comparisons)
    if business_type is BusinessType.TRANSFER:
        return build_transfer_checks(
            resolved_comparisons,
            observations or [],
            page_fields or {},
        )
    return []
