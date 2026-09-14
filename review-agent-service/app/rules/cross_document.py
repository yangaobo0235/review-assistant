"""跨材料规则入口。

当前正式业务为青岛和长春报废置换；历史过户规则已移除。
"""

from typing import Any

from app.agent.models import ReviewCheck
from app.models.review import FieldComparison


def build_cross_document_checks(
    business_type: object,
    comparisons: list[FieldComparison] | None = None,
    observations: list[Any] | None = None,
    page_fields: dict[str, Any] | None = None,
) -> list[ReviewCheck]:
    """保留稳定入口，当前不执行历史过户检查。"""
    return []
