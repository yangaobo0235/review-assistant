"""跨材料规则公共工具。

主要职责：提供稳定取值、证据筛选和日期解析辅助函数。
修改日期：2026-08-26
修改人：wuyi
"""

from datetime import date

from app.agent.models import ReviewCheckValue
from app.models.review import Evidence, FieldComparison, FieldObservation, FieldStatus
from app.rules.normalize import normalize_value


def settled_value(
    comparisons: dict[str, FieldComparison],
    field: str,
) -> object | None:
    """Return a normalized comparison value only after its sources agree."""

    comparison = comparisons.get(field)
    if comparison is None or comparison.status is not FieldStatus.MATCH:
        return None
    return (
        comparison.right_value
        if comparison.right_value not in (None, "")
        else comparison.left_value
    )


def raw_settled_value(
    comparisons: dict[str, FieldComparison],
    field: str,
) -> object | None:
    comparison = comparisons.get(field)
    if comparison is None or comparison.status is not FieldStatus.MATCH:
        return None
    for item in comparison.evidence:
        if item.value not in (None, ""):
            return item.value
    return settled_value(comparisons, field)


def check_value(source: str, value: object | None) -> ReviewCheckValue:
    return ReviewCheckValue(source=source, value=value)


def comparison_image_evidence(
    comparisons: dict[str, FieldComparison],
    field: str,
) -> list[Evidence]:
    comparison = comparisons.get(field)
    if comparison is None:
        return []
    return [item for item in comparison.evidence if item.image_id]


def registration_evidence(
    observations: list[FieldObservation],
    *,
    owner: str | None = None,
    latest: bool = False,
) -> list[Evidence]:
    """Select only the registration record that supports the current check."""

    for item in observations:
        if (
            item.field != "transfer.registration.transfer_records"
            or not item.image_id
            or not isinstance(item.value, list)
        ):
            continue
        records = [record for record in item.value if isinstance(record, dict)]
        if owner is not None:
            expected = normalize_value("transfer.seller_name", owner)
            records = [
                record
                for record in records
                if normalize_value("transfer.seller_name", record.get("owner"))
                == expected
            ]
        if latest and records:
            records = sorted(
                records,
                key=lambda record: (
                    int(record.get("page", 0)),
                    int(record.get("order", 0)),
                    str(record.get("date", "")),
                ),
            )[-1:]
        if not records:
            continue
        return [
            Evidence(
                source="图片识别",
                image_index=item.image_index,
                detail=item.source_id,
                image_id=item.image_id,
                business_scope=item.business_scope,
                group_title=item.group_title,
                group_order=item.group_order,
                document_type=item.document_type,
                value=(
                    f"{records[0].get('owner', '')} · "
                    f"{records[0].get('date', '日期未取得')}"
                ),
            )
        ]

    if owner is not None:
        expected = normalize_value("transfer.seller_name", owner)
        for item in observations:
            if (
                item.field == "transfer.registration.initial_owner"
                and item.image_id
                and normalize_value("transfer.seller_name", item.value) == expected
            ):
                return [
                    Evidence(
                        source="图片识别",
                        image_index=item.image_index,
                        detail=item.source_id,
                        image_id=item.image_id,
                        business_scope=item.business_scope,
                        group_title=item.group_title,
                        group_order=item.group_order,
                        document_type=item.document_type,
                        value=str(item.value),
                    )
                ]
    return []


def parse_date(field: str, value: object | None) -> date | None:
    normalized = normalize_value(field, value)
    if not normalized:
        return None
    try:
        return date.fromisoformat(normalized[:10])
    except ValueError:
        return None
