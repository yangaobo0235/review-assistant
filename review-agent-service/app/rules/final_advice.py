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

FIELD_LABELS = {
    "old_vehicle.recycle_date": "报废交车日期",
    "old_vehicle.vin": "报废车辆车架号",
    "old_vehicle.plate_no": "报废车辆车牌号",
    "old_vehicle.owner": "报废车辆所有人",
    "old_vehicle.engine_model": "报废发动机型号",
    "invoice.code": "发票代码",
    "invoice.amount": "开票金额",
    "invoice.invoice_date": "开票日期",
    "new_vehicle.vin": "新车车架号",
    "new_vehicle.plate_no": "新车车牌号",
    "new_vehicle.owner": "新车所有人",
    "transfer.plate_no": "车牌号",
    "transfer.vin": "车架号",
    "transfer.buyer_name": "过户发票买方名称",
    "transfer.seller_name": "卖方名称",
    "transfer.invoice_date": "开票日期",
}


def _field_finding(comparison: FieldComparison) -> ReviewCheck:
    values = [
        ReviewCheckValue(source=item.source, value=item.value)
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
