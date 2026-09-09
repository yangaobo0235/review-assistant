from collections.abc import Sequence

from app.models.review import Evidence, FieldComparison, FieldStatus
from app.rules.normalize import format_like_page, normalize_value


def compare_values(
    field_name: str,
    left_value: object,
    right_value: object,
    evidence: Sequence[Evidence],
) -> FieldComparison:
    """比较两个来源的同一字段，并把缺失值保守地标为人工复核。"""
    left = normalize_value(field_name, left_value)
    right = normalize_value(field_name, right_value)
    if not left and not right:
        status = FieldStatus.REVIEW_REQUIRED
        message = "页面字段和图片识别值均缺失"
    elif not left:
        status = FieldStatus.REVIEW_REQUIRED
        message = "图片识别值缺失，页面字段已采集"
    elif not right:
        status = FieldStatus.REVIEW_REQUIRED
        message = "页面字段缺失，图片识别值已采集"
    elif left == right:
        status = FieldStatus.MATCH
        message = "字段一致"
    else:
        status = FieldStatus.CONFLICT
        message = "字段冲突"
    return FieldComparison(
        field=field_name,
        left_value=format_like_page(field_name, left_value, right_value) if status is FieldStatus.MATCH else left_value,
        right_value=right_value,
        status=status,
        evidence=list(evidence),
        message=message,
    )
