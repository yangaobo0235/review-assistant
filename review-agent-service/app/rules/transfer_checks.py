"""过户审核跨材料规则。

主要职责：校验登记历史、买卖方和开票日期关系。
修改日期：2026-08-26
修改人：wuyi
"""

from typing import Any

from app.agent.models import ReviewCheck
from app.models.review import FieldComparison, FieldObservation
from app.rules.cross_document_common import (
    check_value,
    comparison_image_evidence,
    parse_date,
    registration_evidence,
    settled_value,
)
from app.rules.normalize import normalize_value
from app.rules.transfer_registration import RegistrationSummary, summarize_registration


def _seller_insufficient_reason(
    seller: object,
    history: RegistrationSummary,
) -> str:
    if seller in (None, ""):
        return "二手车发票卖方尚未确定，无法校验卖方登记历史"
    missing_pages = sorted({1, 2, 3, 4} - history.covered_pages)
    if missing_pages:
        pages = "、".join(str(page) for page in missing_pages)
        return f"登记证缺少第{pages}页，无法完整校验卖方登记历史"
    if "registration.initial_owner" in history.uncertain_fields:
        return "登记证初始所有人识别内容异常，无法校验卖方登记历史"
    if "registration.transfer_records" in history.uncertain_fields:
        return "登记证转移登记记录识别不完整，无法校验卖方登记历史"
    if history.uncertain:
        return "登记证记录存在冲突或格式异常，无法校验卖方登记历史"
    return "登记证记录不完整，无法校验卖方登记历史"


def _seller_check(
    comparisons: dict[str, FieldComparison],
    observations: list[FieldObservation],
) -> ReviewCheck:
    seller = settled_value(comparisons, "transfer.seller_name")
    history = summarize_registration(observations)
    values = [
        check_value("二手车发票卖方", seller),
        check_value("登记证历史所有人", list(history.owners)),
    ]
    evidence = comparison_image_evidence(comparisons, "transfer.seller_name")
    seller_owner = seller if isinstance(seller, str) else None
    evidence.extend(registration_evidence(observations, owner=seller_owner))
    if seller in (None, "") or not history.seller_complete:
        return ReviewCheck(
            check_id="CROSS-TRANSFER-SELLER-001",
            label="卖方登记历史",
            status="INSUFFICIENT",
            reason=_seller_insufficient_reason(seller, history),
            values=values,
            evidence=evidence,
        )
    normalized_seller = normalize_value("transfer.seller_name", seller)
    matches = any(
        normalize_value("transfer.seller_name", owner) == normalized_seller
        for owner in history.owners
    )
    return ReviewCheck(
        check_id="CROSS-TRANSFER-SELLER-001",
        label="卖方登记历史",
        status="MATCH" if matches else "CONFLICT",
        reason=(
            "卖方存在于登记证历史所有人记录中"
            if matches
            else "卖方未出现在完整的登记证历史所有人记录中"
        ),
        values=values,
        evidence=evidence,
    )


def _buyer_check(
    comparisons: dict[str, FieldComparison],
    observations: list[FieldObservation],
) -> ReviewCheck:
    buyer = settled_value(comparisons, "transfer.buyer_name")
    history = summarize_registration(observations)
    values = [
        check_value("二手车发票买方", buyer),
        check_value("登记证最新转移登记所有人", history.latest_owner),
    ]
    evidence = comparison_image_evidence(comparisons, "transfer.buyer_name")
    evidence.extend(registration_evidence(observations, latest=True))
    if (
        buyer in (None, "")
        or not history.latest_owner_complete
        or history.latest_owner in (None, "")
    ):
        return ReviewCheck(
            check_id="CROSS-TRANSFER-BUYER-001",
            label="买方最新转移登记",
            status="INSUFFICIENT",
            reason="无法确定发票买方或登记证最新转移登记所有人",
            values=values,
            evidence=evidence,
        )
    matches = normalize_value("transfer.buyer_name", buyer) == normalize_value(
        "transfer.buyer_name",
        history.latest_owner,
    )
    return ReviewCheck(
        check_id="CROSS-TRANSFER-BUYER-001",
        label="买方最新转移登记",
        status="MATCH" if matches else "CONFLICT",
        reason=(
            "买方是登记证最新转移登记所有人"
            if matches
            else "买方不是登记证最新转移登记所有人"
        ),
        values=values,
        evidence=evidence,
    )


def _date_check(
    comparisons: dict[str, FieldComparison],
    observations: list[FieldObservation],
    page_fields: dict[str, Any],
) -> ReviewCheck:
    invoice_date = settled_value(comparisons, "transfer.invoice_date")
    publish_date = page_fields.get("transfer.source_publish_date")
    history = summarize_registration(observations)
    transfer_date = (
        history.records[-1].registration_date if history.records else None
    )
    values = [
        check_value("登记证最新转让登记日期", transfer_date),
        check_value("二手车发票开票日期", invoice_date),
        check_value("车源发布日期", publish_date),
    ]
    evidence = comparison_image_evidence(comparisons, "transfer.invoice_date")
    evidence.extend(registration_evidence(observations, latest=True))
    parsed_invoice = parse_date("transfer.invoice_date", invoice_date)
    parsed_publish = parse_date("transfer.source_publish_date", publish_date)
    if transfer_date is None or parsed_invoice is None or parsed_publish is None:
        return ReviewCheck(
            check_id="CROSS-TRANSFER-DATE-001",
            label="转让登记日期 ≥ 开票日期 ≥ 车源发布时间",
            status="INSUFFICIENT",
            reason="无法确定完整日期链，无法完成转让登记、开票与车源发布时间顺序校验",
            values=values,
            evidence=evidence,
        )
    matches = transfer_date >= parsed_invoice >= parsed_publish
    return ReviewCheck(
        check_id="CROSS-TRANSFER-DATE-001",
        label="转让登记日期 ≥ 开票日期 ≥ 车源发布时间",
        status="MATCH" if matches else "CONFLICT",
        reason=(
            "转让登记日期、开票日期和车源发布时间满足先后顺序"
            if matches
            else "转让登记日期、开票日期和车源发布时间不满足先后顺序"
        ),
        values=values,
        evidence=evidence,
    )


def build_transfer_checks(
    comparisons: list[FieldComparison],
    observations: list[FieldObservation],
    page_fields: dict[str, Any],
) -> list[ReviewCheck]:
    """Build seller, buyer, and date-chain checks for transfer reviews."""

    by_field = {comparison.field: comparison for comparison in comparisons}
    return [
        _seller_check(by_field, observations),
        _buyer_check(by_field, observations),
        _date_check(by_field, observations, page_fields),
    ]
