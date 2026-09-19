"""后端生成最终工作台任务；前端不合并状态或猜测遗漏能力。"""

from collections.abc import Sequence

from app.models.review import ReviewTask
from app.workflow.models import MaterialCompletenessReport

DATE_POLICY_FIELDS = {
    # Business rule steps are namespaced by review_step_routing as
    # ``BUSINESS-{check_id}``; keep the merge keys aligned with that public ID.
    "BUSINESS-POLICY-INVOICE-DATE": "invoice.invoice_date",
    "BUSINESS-POLICY-DISPOSAL-DEADLINE": "old_vehicle.recycle_date",
}


def _merge(base: ReviewTask, members: Sequence[ReviewTask]) -> ReviewTask:
    all_tasks = [base, *members]
    severity = {"MATCH": 0, "INSUFFICIENT": 1, "CONFLICT": 2}
    status = max((item.result_status for item in all_tasks), key=severity.__getitem__)
    return base.model_copy(update={
        "result_status": status,
        "requires_reviewer_action": status != "MATCH",
        "reason": "；".join(dict.fromkeys(item.reason for item in all_tasks if item.reason)),
        "values": [value for item in all_tasks for value in item.values],
        "evidence": [value for item in all_tasks for value in item.evidence],
        "check_ids": list(dict.fromkeys(cid for item in all_tasks for cid in item.check_ids)),
    })


def prepare_display_tasks(
    tasks: Sequence[ReviewTask], *, qr_enabled: bool,
    completeness: MaterialCompletenessReport | None,
) -> list[ReviewTask]:
    # Field-first profiles keep the task in the assistant while exposing the
    # canonical DOM target through page_target_field. Date policy results must
    # merge against either representation so they never become duplicate
    # standalone assistant cards.
    by_field = {
        field: item
        for item in tasks
        if item.category == "FIELD"
        for field in (item.page_field or item.page_target_field,)
        if field
    }
    consumed: set[str] = set()
    replacements: dict[str, ReviewTask] = {}
    for task in tasks:
        field = DATE_POLICY_FIELDS.get(task.step_id)
        if field and field in by_field:
            base = by_field[field]
            replacements[base.step_id] = _merge(base, [task])
            consumed.add(task.step_id)
    subject = next((item for item in tasks if item.step_id == "BUSINESS-AFFILIATION-SUBJECT-001"), None)
    if subject:
        auxiliary = [item for item in tasks if item.step_id.startswith("BUSINESS-AFFILIATION-AUX-")]
        replacements[subject.step_id] = _merge(subject, auxiliary).model_copy(update={
            "details": {**subject.details, "affiliation_subject_status": subject.result_status},
        })
        consumed.update(item.step_id for item in auxiliary)
    material_members = [
        item
        for item in tasks
        if item.category == "MATERIAL"
        or item.step_id == "BUSINESS-MATERIAL-COMPLETENESS"
    ]
    result = []
    grouped = [
        ("QR-GROUP", "二维码官网核验", "EXTERNAL", [item for item in tasks if item.step_id.startswith("QR-") or item.step_id == "EXTERNAL-scrap_certificate_qr"], qr_enabled, "INSUFFICIENT", "未取得可核验的二维码"),
        ("MATERIAL-GROUP", "材料完整性", "MATERIAL", material_members, completeness is not None, "MATCH" if completeness and completeness.status == "COMPLETE" else "INSUFFICIENT", "必需材料已采集" if completeness and completeness.status == "COMPLETE" else "材料不完整或待确认"),
    ]
    for task_id, label, category, members, enabled, fallback, reason in grouped:
        if not enabled and not members:
            continue
        consumed.update(item.step_id for item in members)
        # 材料任务的公开语义只有“是否齐全”。识别限制、字段异常等
        # 内部诊断不能通过任务 reason 泄漏到工作台。
        status = (
            "MATCH"
            if completeness is not None and completeness.status == "COMPLETE"
            else fallback
        ) if category == "MATERIAL" else ("MATCH" if members else fallback)
        base = ReviewTask(
            step_id=task_id, sequence=min((item.sequence for item in members), default=10000),
            category=category, display_target="ASSISTANT", label=label,
            result_status=status, requires_reviewer_action=status != "MATCH",
            reason="" if members else reason,
        )
        result.append(base if category == "MATERIAL" else _merge(base, members))
    result.extend(replacements.get(item.step_id, item) for item in tasks if item.step_id not in consumed)
    return [item.model_copy(update={"sequence": i}) for i, item in enumerate(sorted(result, key=lambda item: item.sequence), 1)]
