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


def _deduplicate_sources(
    field_name: str,
    observations: list[FieldObservation],
) -> list[FieldObservation]:
    """把同一物理图片的重复 OCR 行合并为一个证据来源。"""
    grouped: dict[tuple[str, str], list[FieldObservation]] = {}
    order: list[tuple[str, str]] = []
    for item in observations:
        # image_index 是同一张材料在请求中的稳定物理标识。它比 source_id
        # 更可靠，因为兼容 OCR 层可能同时产生 ``ocr-1`` 和 ``1`` 两行。
        source_key = (
            f"image-index:{item.image_index}"
            if item.source_type == "image" and item.image_index is not None
            else item.image_id or item.source_id or "page"
        )
        key = (item.source_type, str(source_key))
        current = grouped.get(key)
        if current is None:
            grouped[key] = [item]
            order.append(key)
            continue
        current.append(item)
    page_values = [item.value for item in observations if item.source_type == "page"]
    page_normalized = {normalize_value(field_name, value) for value in page_values}
    result: list[FieldObservation] = []
    for key in order:
        candidates = grouped[key]
        # 发票票面可能同时被通用 OCR 和专用 OCR 读出。页面已有值时，
        # 优先保留同页面值的候选，避免另一条低质量 OCR 把一致结果误报冲突。
        matching = [item for item in candidates if normalize_value(field_name, item.value) in page_normalized]
        pool = matching or candidates
        result.append(max(
            pool,
            key=lambda item: (
                item.confidence if item.confidence is not None else -1.0,
                bool(item.image_id) and not str(item.source_id).startswith("ocr-"),
            ),
        ))
    return result


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
    *,
    uncertain_requires_review: bool = False,
    single_evidence_requires_review: bool = True,
) -> FieldComparison:
    """Compare all non-empty sources without discarding conflicting values."""
    valid = _deduplicate_sources(
        field_name,
        [item for item in observations if str(item.value or "").strip()]
    )
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
            normalized_value=normalize_value(field_name, item.value),
            derived_from=item.derived_from,
            evidence_region=item.evidence_region,
        )
        for item in valid
    ]

    # 不确定标记的一票否决只服务于字段优先的目标 Profile；
    # 过户等既有业务保持历史聚合语义，不因 uncertain 改变状态。
    if uncertain_requires_review and any(item.uncertain for item in valid):
        status = FieldStatus.REVIEW_REQUIRED
        message = "图片识别结果不确定，请核对原图"
    elif not valid:
        status = FieldStatus.REVIEW_REQUIRED
        message = "页面与图片均未取得有效值"
    elif len(valid) == 1 and valid[0].source_type == "page":
        status = FieldStatus.REVIEW_REQUIRED
        message = "页面字段已采集，但未从材料中取得可核验值"
    elif len(valid) == 1 and single_evidence_requires_review:
        status = FieldStatus.REVIEW_REQUIRED
        message = "仅有一个有效来源，证据不足"
    elif len(valid) == 1:
        status = FieldStatus.MATCH
        message = "已发现 1 份有效证据，按实际证据核验"
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
