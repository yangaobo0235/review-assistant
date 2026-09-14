"""最终审核建议生成。

主要职责：汇总字段、二维码和跨材料检查并形成安全建议。
修改日期：2026-08-26
修改人：wuyi
"""

from app.agent.models import (
    AgentAdvice,
    MaterialCompletenessReport,
    ReviewCheck,
    ReviewCheckValue,
)
from app.models.review import FieldComparison, FieldStatus, QrCheck
from app.rules.check_results import qr_review_checks, unique_checks
from app.rules.review_fields import SCRAP_PAGE_FIELD_LABELS

FIELD_LABELS = {
    **SCRAP_PAGE_FIELD_LABELS,
}


def _field_finding(comparison: FieldComparison) -> ReviewCheck:
    values = [
        ReviewCheckValue(
            source=item.source,
            value=item.value,
            source_id=item.source_id,
            image_id=item.image_id,
            image_index=item.image_index,
            document_type=item.document_type,
            detail=item.detail,
            derived_from=item.derived_from,
            evidence_region=item.evidence_region,
        )
        for item in comparison.evidence
        if item.value not in (None, "")
    ]
    return ReviewCheck(
        check_id=f"FIELD-{comparison.field}",
        label=FIELD_LABELS.get(comparison.field, comparison.field),
        status="CONFLICT"
        if comparison.status is FieldStatus.CONFLICT
        else "INSUFFICIENT",
        reason=comparison.message,
        values=values,
        evidence=[item.model_dump() for item in comparison.evidence],
    )


def build_final_advice(
    comparisons: list[FieldComparison],
    cross_checks: list[ReviewCheck],
    qr_checks: list[QrCheck],
    issues: list[str],
    limitations: list[str],
    confidences: list[float],
    *,
    completeness: MaterialCompletenessReport | None = None,
) -> tuple[str, AgentAdvice]:
    findings = [
        _field_finding(item)
        for item in comparisons
        if item.status is not FieldStatus.MATCH
    ]
    findings.extend(item for item in cross_checks if item.status != "MATCH")
    if completeness is not None and completeness.enforced:
        findings.extend(
            ReviewCheck(
                check_id=f"MATERIAL-{item.code}-{index}",
                label="资料完整性",
                status="INSUFFICIENT",
                reason=f"{item.message}；{item.suggested_action}",
            )
            for index, item in enumerate(completeness.issues, start=1)
        )
    # 缺少外部结果由声明 REQUIRED 的能力生成。
    findings.extend(
        item for item in qr_review_checks(qr_checks) if item.status != "MATCH"
    )
    findings.extend(
        ReviewCheck(
            check_id=f"ISSUE-{index}",
            label="资料完整性",
            status="INSUFFICIENT",
            reason=issue,
        )
        for index, issue in enumerate(dict.fromkeys(issues), start=1)
    )
    findings.extend(
        ReviewCheck(
            check_id=f"LIMITATION-{index}",
            label="识别限制",
            status="INSUFFICIENT",
            reason=limitation,
        )
        for index, limitation in enumerate(dict.fromkeys(limitations), start=1)
    )

    findings = unique_checks(findings)
    decision = "REVIEW_REQUIRED" if findings else "PASS"
    confidence = sum(confidences) / len(confidences) if confidences else None
    basis = {"确定性审核规则"}
    if any(
        item.source == "申请页面字段"
        for comparison in comparisons
        for item in comparison.evidence
    ):
        basis.add("页面申请信息")
    if any(
        item.source == "图片识别"
        for comparison in comparisons
        for item in comparison.evidence
    ):
        basis.add("资料图片识别")
    if qr_checks:
        basis.add("二维码官网核验")
    advice = AgentAdvice(
        decision=decision,
        title="建议人工复核" if findings else "建议通过",
        summary=f"发现 {len(findings)} 项需要审核人员确认"
        if findings
        else "全部必检项目满足要求",
        findings=findings,
        recognition_confidence=confidence,
        confidence=confidence,
        basis=[
            item
            for item in (
                "页面申请信息",
                "资料图片识别",
                "二维码官网核验",
                "确定性审核规则",
            )
            if item in basis
        ],
        limitations=list(dict.fromkeys(limitations)),
    )
    return decision, advice
