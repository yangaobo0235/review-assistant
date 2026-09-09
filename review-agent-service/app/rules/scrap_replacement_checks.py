"""报废置换跨材料规则。

主要职责：校验新旧车所有人及报废交车和发票年份。
修改日期：2026-08-26
修改人：wuyi
"""

from app.agent.models import ReviewCheck
from app.models.review import FieldComparison
from app.rules.cross_document_common import (
    check_value,
    parse_date,
    raw_settled_value,
    settled_value,
)
from app.rules.normalize import normalize_value


def _owner_check(comparisons: dict[str, FieldComparison]) -> ReviewCheck:
    old_owner = raw_settled_value(comparisons, "old_vehicle.owner")
    new_owner = raw_settled_value(comparisons, "new_vehicle.owner")
    values = [
        check_value("旧车资料", old_owner),
        check_value("新车资料", new_owner),
    ]
    if old_owner in (None, "") or new_owner in (None, ""):
        return ReviewCheck(
            check_id="CROSS-OWNER-001",
            label="新旧车所有人一致性",
            status="INSUFFICIENT",
            reason="基础字段尚未确定，无法完成所有人一致性校验",
            values=values,
        )
    matches = normalize_value("old_vehicle.owner", old_owner) == normalize_value(
        "new_vehicle.owner", new_owner
    )
    return ReviewCheck(
        check_id="CROSS-OWNER-001",
        label="新旧车所有人一致性",
        status="MATCH" if matches else "CONFLICT",
        reason=(
            "旧车所有人与新车所有人一致"
            if matches
            else "旧车所有人与新车所有人不一致"
        ),
        values=values,
    )


def _date_check(comparisons: dict[str, FieldComparison]) -> ReviewCheck:
    recycle_date = settled_value(comparisons, "old_vehicle.recycle_date")
    invoice_date = settled_value(comparisons, "invoice.invoice_date")
    values = [
        check_value("报废交车日期", recycle_date),
        check_value("新车开票日期", invoice_date),
    ]
    old_date = parse_date("old_vehicle.recycle_date", recycle_date)
    new_date = parse_date("invoice.invoice_date", invoice_date)
    if old_date is None or new_date is None:
        return ReviewCheck(
            check_id="CROSS-DATE-001",
            label="交车与开票日期同年",
            status="INSUFFICIENT",
            reason="基础日期尚未确定，无法完成同年校验",
            values=values,
        )
    matches = old_date.year == new_date.year
    return ReviewCheck(
        check_id="CROSS-DATE-001",
        label="交车与开票日期同年",
        status="MATCH" if matches else "CONFLICT",
        reason=(
            "报废交车日期与新车开票日期处于同一自然年"
            if matches
            else "报废交车日期与新车开票日期不在同一自然年"
        ),
        values=values,
    )


def build_scrap_replacement_checks(
    comparisons: list[FieldComparison],
) -> list[ReviewCheck]:
    """Build the cross-document checks for scrap-replacement reviews."""

    by_field = {comparison.field: comparison for comparison in comparisons}
    return [_owner_check(by_field), _date_check(by_field)]
