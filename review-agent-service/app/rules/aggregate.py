"""同字段多源证据聚合。

主要职责：标准化页面、图片和官网证据并生成字段比较。
修改日期：2026-08-26
修改人：wuyi
"""

from collections import Counter

from app.models.review import Evidence, FieldComparison, FieldObservation, FieldStatus
from app.rules.normalize import format_like_page, normalize_value

EVIDENCE_SOURCE_LABELS = {
    "image": "图片识别",
    "page": "申请页面字段",
    "qr_page": "二维码官网字段",
}


def _mark_conflicting_evidence(
    field_name: str,
    valid: list[FieldObservation],
    evidence: list[Evidence],
    status: FieldStatus,
) -> None:
    if status is not FieldStatus.CONFLICT:
        return

    official_values = {
        normalize_value(field_name, item.value)
        for item in valid
        if item.source_type == "qr_page"
    }
    reference: str | None
    if official_values:
        reference = next(iter(official_values)) if len(official_values) == 1 else None
    else:
        counts = Counter(normalize_value(field_name, item.value) for item in valid)
        highest_count = max(counts.values())
        winners = [value for value, count in counts.items() if count == highest_count]
        reference = winners[0] if len(winners) == 1 else None

    for observation, item in zip(valid, evidence, strict=True):
        item.conflicting = (
            reference is None
            or normalize_value(field_name, observation.value) != reference
        )


def aggregate_field(
    field_name: str,
    observations: list[FieldObservation],
) -> FieldComparison:
    """Compare all non-empty sources without discarding conflicting values."""
    valid = [item for item in observations if str(item.value or "").strip()]
    image_values = [item.value for item in valid if item.source_type == "image"]
    page_values = [item.value for item in valid if item.source_type == "page"]
    evidence = [
        Evidence(
            source=EVIDENCE_SOURCE_LABELS.get(item.source_type, item.source_type),
            source_id=item.source_id,
            field=item.field,
            uncertain=item.uncertain,
            image_index=item.image_index,
            detail=item.source_id,
            image_id=item.image_id,
            business_scope=item.business_scope,
            group_title=item.group_title,
            group_order=item.group_order,
            document_type=item.document_type,
            value=item.value,
        )
        for item in valid
    ]

    if any(item.uncertain for item in valid):
        status = FieldStatus.REVIEW_REQUIRED
        message = "图片识别结果不确定，请核对原图"
    elif not valid:
        status = FieldStatus.REVIEW_REQUIRED
        message = "页面与图片均未取得有效值"
    elif len(valid) == 1:
        status = FieldStatus.REVIEW_REQUIRED
        message = "仅有一个有效来源，证据不足"
    else:
        normalized = {normalize_value(field_name, item.value) for item in valid}
        if len(normalized) == 1:
            status = FieldStatus.MATCH
            message = "多个来源字段一致"
        else:
            status = FieldStatus.CONFLICT
            message = "多个来源存在不同值"

    confidences = [item.confidence for item in valid if item.confidence is not None]
    confidence = sum(confidences) / len(confidences) if confidences else None
    image_value = image_values[0] if image_values else None
    page_value = page_values[0] if page_values else None
    if field_name.endswith(".owner"):
        image_value = normalize_value(field_name, image_value)
        page_value = normalize_value(field_name, page_value)
    if status is FieldStatus.MATCH:
        image_value = format_like_page(field_name, image_value, page_value)
    _mark_conflicting_evidence(field_name, valid, evidence, status)
    return FieldComparison(
        field=field_name,
        left_value=image_value,
        right_value=page_value,
        status=status,
        confidence=confidence,
        evidence=evidence,
        message=message,
    )
