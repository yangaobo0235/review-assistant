"""报废置换地区政策确定性检查。"""

from datetime import date

from app.agent.models import ReviewCheck, ReviewCheckValue
from app.businesses.replacement_policies import ReplacementPolicy
from app.models.review import FieldObservation
from app.rules.evidence_values import observation_evidence, readable_value
from app.rules.normalize import normalize_value


def _image_value(
    observations: list[FieldObservation],
    field: str,
    document_type: str,
    business_scope: str,
) -> tuple[object | None, list[dict]]:
    sources = [
        item
        for item in observations
        if item.field == field
        and item.source_type == "image"
        and item.document_type == document_type
        and item.business_scope == business_scope
    ]
    values = {
        normalize_value(field, item.value): item.value
        for item in sources
        if item.value not in (None, "")
    }
    evidence = observation_evidence(sources)
    if len(values) != 1 or any(
        item.uncertain or not readable_value(item.value) for item in sources
    ):
        return None, evidence
    return next(iter(values.values())), evidence


def _parse_date(field: str, value: object | None) -> date | None:
    normalized = normalize_value(field, value)
    if not normalized:
        return None
    try:
        return date.fromisoformat(normalized)
    except ValueError:
        return None


def _date_check(
    check_id: str,
    label: str,
    field: str,
    raw_value: object | None,
    lower: date | None,
    upper: date,
    evidence: list[dict],
) -> ReviewCheck:
    parsed = _parse_date(field, raw_value)
    values = [ReviewCheckValue(source=label, value=raw_value)]
    if parsed is None:
        return ReviewCheck(
            check_id=check_id,
            label=label,
            status="INSUFFICIENT",
            reason=f"未从指定图片材料取得唯一有效的{label}",
            values=values,
            evidence=evidence,
        )
    matches = (lower is None or parsed >= lower) and parsed <= upper
    range_text = (
        f"{lower.isoformat()} 至 {upper.isoformat()}"
        if lower
        else f"不晚于 {upper.isoformat()}"
    )
    return ReviewCheck(
        check_id=check_id,
        label=label,
        status="MATCH" if matches else "CONFLICT",
        reason=f"{label}{'符合' if matches else '不符合'}政策范围：{range_text}",
        values=values,
        evidence=evidence,
    )


def build_replacement_policy_checks(
    policy: ReplacementPolicy,
    observations: list[FieldObservation],
) -> list[ReviewCheck]:
    invoice_date, invoice_evidence = _image_value(
        observations, "invoice.invoice_date", "invoice", "new_vehicle"
    )
    recycle_date, recycle_evidence = _image_value(
        observations,
        "old_vehicle.recycle_date",
        "scrap_certificate",
        "old_vehicle",
    )
    checks = [
        _date_check(
            "POLICY-INVOICE-DATE",
            "新车发票日期",
            "invoice.invoice_date",
            invoice_date,
            policy.invoice_date_from,
            policy.invoice_date_to,
            invoice_evidence,
        ),
        _date_check(
            "POLICY-DISPOSAL-DEADLINE",
            "回收证明交车日期",
            "old_vehicle.recycle_date",
            recycle_date,
            None,
            policy.disposal_deadline,
            recycle_evidence,
        ),
    ]
    origin, origin_evidence = _image_value(
        observations, "new_vehicle.origin", "invoice", "new_vehicle"
    )
    normalized_origin = normalize_value("new_vehicle.origin", origin)
    allowed = {
        normalize_value("new_vehicle.origin", item) for item in policy.allowed_origins
    }
    keywords = tuple(filter(None, (normalize_value("new_vehicle.origin", item) for item in policy.origin_keywords)))
    rule_description = f"包含：{'、'.join(policy.origin_keywords)}" if keywords else f"允许：{'、'.join(policy.allowed_origins)}"
    if not allowed and not keywords:
        status = "INSUFFICIENT"
        reason = "当前地区未配置新车发票产地规则"
    elif not normalized_origin:
        status = "INSUFFICIENT"
        reason = "未从新车销售发票取得唯一有效的产地"
    elif normalized_origin in allowed or any(keyword in normalized_origin for keyword in keywords):
        status = "MATCH"
        reason = f"新车销售发票产地符合当前地区规则（{rule_description}）"
    else:
        status = "CONFLICT"
        reason = f"新车销售发票产地不符合当前地区规则（{rule_description}）"
    checks.append(
        ReviewCheck(
            check_id="POLICY-NEW-ORIGIN",
            label="新车发票产地",
            status=status,
            reason=reason,
            values=[
                ReviewCheckValue.model_validate({**item, "source": "新车销售发票"})
                for item in origin_evidence
            ] or [ReviewCheckValue(source="新车销售发票", value=origin)],
            evidence=origin_evidence,
        )
    )
    return checks
