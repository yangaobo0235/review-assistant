"""字段优先的审核步骤集中路由。

主要职责：一次运行内决定每个审核步骤展示在宿主页面字段还是助手面板，
并完成材料异常去重和步骤排序。展示目标只来自本模块的显式映射表，
不根据中文 label 或 reason 猜测；页内交互只对目标 Profile 启用，
未配置业务继续使用结果界面。
"""

from collections.abc import Sequence
from typing import Literal

from app.agent.models import (
    MaterialCompletenessReport,
    ReviewCheck,
    ReviewCheckValue,
)
from app.businesses.profiles import BusinessProfile
from app.models.review import (
    BusinessType,
    Evidence,
    FieldComparison,
    FieldStatus,
    Region,
    ReviewDisplayTarget,
    ReviewFieldSnapshot,
    ReviewRequest,
    ReviewStep,
)
from app.rules.affiliation_subject_checks import normalize_page_owner_type
from app.rules.field_evidence_policies import field_policy
from app.rules.final_advice import FIELD_LABELS
from app.rules.normalize import normalize_value
from app.rules.review_fields import (
    PRIMARY_REVIEW_FIELDS,
    SCRAP_FIELD_BY_AFFILIATION_CHECK_ID,
    SCRAP_PAGE_FIELD_LABELS,
)

# 只有这两个目标 Profile 启用页内交互（业务、地区、版本三元组显式列出）。
PAGE_INTERACTION_PROFILES = frozenset(
    {
        (BusinessType.SCRAP_REPLACEMENT, Region.QINGDAO, "1.0"),
        (BusinessType.SCRAP_REPLACEMENT, Region.CHANGCHUN, "1.0"),
    }
)


def is_page_interaction_profile(
    business_type: BusinessType,
    region: Region,
    version: str,
) -> bool:
    """字段优先目标 Profile 的唯一判定；新增语义只允许对这两个 Profile 生效。"""
    return (business_type, region, version) in PAGE_INTERACTION_PROFILES

# 显式映射表：同字段比较的规范字段 -> 宿主页面采集字段键。
PAGE_FIELD_BY_CANONICAL_FIELD: dict[str, str] = {
    field: field for field in PRIMARY_REVIEW_FIELDS
}

# 显式映射表：辅助守护检查 -> 宿主页面采集字段键。
PAGE_FIELD_BY_CHECK_ID: dict[str, str] = {
    **SCRAP_FIELD_BY_AFFILIATION_CHECK_ID,
}

MISSING_PAGE_FIELD_REASON = "页面字段缺失或存在歧义，请人工核对该字段"

Category = Literal["FIELD", "EXTERNAL", "BUSINESS_RULE", "MATERIAL"]
ResultStatus = Literal["MATCH", "CONFLICT", "INSUFFICIENT"]


def _evidence_source(item: Evidence | dict[str, object]) -> str:
    """兼容历史业务规则返回 dict evidence 和新 Evidence 模型。"""
    if isinstance(item, dict):
        return str(item.get("source") or "未知来源")
    return item.source


def _coerce_evidence(item: Evidence | dict[str, object]) -> Evidence:
    """Normalize legacy business-rule evidence dictionaries for the API model."""
    return item if isinstance(item, Evidence) else Evidence.model_validate(item)


def _step(
    *,
    step_id: str,
    category: Category,
    display_target: ReviewDisplayTarget,
    label: str,
    result_status: ResultStatus,
    reason: str,
    page_field: str | None = None,
    page_value: object | None = None,
    control_type: str | None = None,
    writable: bool = False,
    values: Sequence[ReviewCheckValue] = (),
    evidence: Sequence[Evidence] = (),
    details: dict[str, object] | None = None,
    requires_reviewer_action: bool | None = None,
    evidence_mode: str | None = None,
    not_found_sources: Sequence[str] = (),
    normalized_page_value: str | None = None,
) -> ReviewStep:
    """构建单个步骤；MATCH 不需要人工处理，其余状态必须处理。"""
    resolved_details = details or {}
    return ReviewStep(
        step_id=step_id,
        sequence=1,
        category=category,
        display_target=display_target,
        page_field=page_field,
        page_value=page_value,
        control_type=control_type,
        writable=writable,
        requires_reviewer_action=(result_status != "MATCH") if requires_reviewer_action is None else requires_reviewer_action,
        label=label,
        result_status=result_status,
        reason=reason,
        values=list(values),
        evidence=[_coerce_evidence(item) for item in evidence],
        details=resolved_details,
        evidence_count=len(evidence),
        evidence_sources=list(dict.fromkeys(_evidence_source(item) for item in evidence)),
        evidence_mode=evidence_mode,
        not_found_sources=list(not_found_sources),
        normalized_page_value=normalized_page_value,
    )


def _comparison_status(comparison: FieldComparison) -> ResultStatus:
    if comparison.status is FieldStatus.MATCH:
        return "MATCH"
    if comparison.status is FieldStatus.CONFLICT:
        return "CONFLICT"
    return "INSUFFICIENT"


def _page_field_collected(request: ReviewRequest, page_field: str) -> bool:
    """只有页面成功采集且无歧义的字段才能作为展示目标。"""
    if page_field in request.collection_diagnostics.ambiguous_fields:
        return False
    return request.page_fields.get(page_field) not in (None, "")


def _field_step(
    request: ReviewRequest,
    comparison: FieldComparison,
    *,
    page_interaction: bool,
) -> ReviewStep:
    label = FIELD_LABELS.get(comparison.field, "材料字段核验")
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
    result_status = _comparison_status(comparison)
    material_evidence_by_image: dict[str, Evidence] = {}
    for item in comparison.evidence:
        if item.image_id and item.source == "图片识别":
            material_evidence_by_image.setdefault(item.image_id, item)
    material_evidence = list(material_evidence_by_image.values())
    if result_status == "MATCH" and not _page_field_collected(request, comparison.field):
        result_status = "INSUFFICIENT"
        reason = f"{comparison.message}；{MISSING_PAGE_FIELD_REASON}"
    else:
        reason = comparison.message
    if comparison.field == "invoice.code" and any(
        item.derived_from == "invoice.invoice_no" for item in comparison.evidence
    ):
        reason = f"{reason}；发票代码由票面数电号码适配"
    # 报废置换字段全部在审核助手中展示；原页面保持干净，不再注入标记。
    # 页面是否采集、页面原值和材料证据都由 evidence/values 传给工作台处理。
    policy = field_policy(comparison.field)
    return _step(
        step_id=f"FIELD-{comparison.field}",
        category="FIELD",
        display_target=ReviewDisplayTarget.ASSISTANT,
        label=label,
        result_status=result_status,
        reason=reason,
        page_value=request.page_fields.get(comparison.field),
        values=values,
        evidence=material_evidence,
        requires_reviewer_action=(result_status != "MATCH"),
        details={
            "evidence_count": len({item.image_id for item in material_evidence}),
            "evidence_mode": policy.mode if policy else None,
            "evidence_sources": list(dict.fromkeys(_evidence_source(item) for item in material_evidence)),
            "not_found_sources": list(policy.allowed_document_types) if policy and not material_evidence else [],
            "normalized_page_value": normalize_value(comparison.field, comparison.right_value),
        },
        evidence_mode=policy.mode if policy else None,
        not_found_sources=policy.allowed_document_types if policy and not material_evidence else (),
        normalized_page_value=normalize_value(comparison.field, comparison.right_value),
    )


def _page_catalog_step(snapshot: ReviewFieldSnapshot, step_id: str) -> ReviewStep:
    """为没有已配置核验来源的实际页面控件保留可审查步骤。"""
    has_value = snapshot.value not in (None, "")
    return _step(
        step_id=step_id,
        category="FIELD",
        display_target=ReviewDisplayTarget.ASSISTANT,
        label=snapshot.label,
        result_status="INSUFFICIENT",
        reason=(
            "当前材料和规则未配置该页面控件的核验来源，请人工核对"
            if has_value
            else "当前页面控件未填写，且没有已配置的材料核验来源，请人工核对"
        ),
        page_value=snapshot.value,
        control_type=snapshot.control_type,
        writable=False,
        values=[ReviewCheckValue(source="申请页面字段", value=snapshot.value)],
    )


def _owner_type_system_step(snapshot: ReviewFieldSnapshot) -> ReviewStep:
    """Treat the backend-provided owner type as input, not OCR evidence."""

    valid = normalize_page_owner_type(snapshot.value) is not None
    return _step(
        step_id="FIELD-application.owner_type",
        category="FIELD",
        display_target=ReviewDisplayTarget.ASSISTANT,
        label=snapshot.label,
        result_status="MATCH" if valid else "INSUFFICIENT",
        reason=(
            "系统业务字段，无需材料比对"
            if valid
            else "车辆所有人类型为空或不是个人/企业，请人工确认"
        ),
        page_value=snapshot.value,
        control_type=snapshot.control_type,
        writable=False,
        values=[ReviewCheckValue(source="申请页面字段", value=snapshot.value)],
    )


def _affiliation_catalog_step(
    request: ReviewRequest,
    check: ReviewCheck,
    field: str,
) -> ReviewStep:
    """把主体关系辅助检查同时投影为实际 DOM 字段目录中的字段项。"""
    result_status: ResultStatus = check.status
    reason = check.reason
    if result_status == "MATCH" and not _page_field_collected(request, field):
        result_status = "INSUFFICIENT"
        reason = f"{reason}；{MISSING_PAGE_FIELD_REASON}"
    return _step(
        step_id=f"FIELD-{field}",
        category="FIELD",
        display_target=ReviewDisplayTarget.ASSISTANT,
        label=SCRAP_PAGE_FIELD_LABELS[field],
        result_status=result_status,
        reason=reason,
        values=check.values,
        evidence=check.evidence,
    )


def _with_control_snapshot(
    step: ReviewStep, snapshot: ReviewFieldSnapshot
) -> ReviewStep:
    # Operation-only affiliation controls are identified by their canonical
    # field key. Never expose that internal key as the reviewer-facing label.
    label = {
        "old_vehicle.affiliation": "报废车挂靠",
        "new_vehicle.affiliation": "新车挂靠",
    }.get(snapshot.field, snapshot.label)
    return step.model_copy(
        update={
            "label": label,
            "page_value": snapshot.value,
            "control_type": snapshot.control_type,
            "writable": snapshot.editable,
        }
    )


def _affiliation_control_step(
    snapshot: ReviewFieldSnapshot,
    subject: ReviewCheck | None,
) -> ReviewStep:
    is_old = snapshot.field == "old_vehicle.affiliation"
    type_source = "旧车主体类型" if is_old else "新车主体类型"
    expected_raw = next(
        (
            item.value
            for item in (subject.values if subject else [])
            if item.source == type_source
        ),
        None,
    )
    expected_type = str(expected_raw) if expected_raw in {"PERSONAL", "COMPANY"} else None
    expected_label = {"PERSONAL": "个人", "COMPANY": "公司"}.get(expected_type)
    actual_type = normalize_page_owner_type(snapshot.value)
    values = [ReviewCheckValue(source="申请页面字段", value=snapshot.value)]
    if expected_label:
        values.append(ReviewCheckValue(source="主体关系核验", value=expected_label))

    if subject is None or subject.status != "MATCH":
        status: ResultStatus = subject.status if subject else "INSUFFICIENT"
        reason = "主体关系尚未通过，不能确定挂靠字段的正确取值"
    elif not expected_type:
        status = "INSUFFICIENT"
        reason = "主体关系已核验，但未得到明确的个人/公司类型"
    elif not actual_type:
        # 挂靠字段本身是主体关系规则的派生填写目标，不要求材料再次
        # 提供同名证据。主体关系已通过且类型明确时，空控件也视为规则通过，
        # 由页面写入链路负责填写“个人/公司”。
        status = "MATCH"
        reason = f"主体关系核验已通过，将自动填写{expected_label}"
    elif actual_type == expected_type:
        status = "MATCH"
        reason = "页面挂靠类型与主体关系核验结果一致"
    else:
        status = "CONFLICT"
        reason = "页面挂靠类型与主体关系核验结果不一致"

    return _step(
        step_id=f"FIELD-{snapshot.field}",
        category="FIELD",
        display_target=ReviewDisplayTarget.ASSISTANT,
        label=snapshot.label,
        result_status=status,
        reason=reason,
        page_value=snapshot.value,
        control_type=snapshot.control_type,
        writable=False,
        values=values,
        evidence=subject.evidence if subject else [],
    )


def _scrap_field_steps(
    request: ReviewRequest,
    comparisons: Sequence[FieldComparison],
    business_checks: Sequence[ReviewCheck],
) -> list[ReviewStep]:
    if not request.review_fields:
        return [
            _field_step(request, comparison, page_interaction=True)
            for comparison in comparisons
        ]

    comparisons_by_field = {item.field: item for item in comparisons}
    auxiliary_by_field = {
        SCRAP_FIELD_BY_AFFILIATION_CHECK_ID[item.check_id]: item
        for item in business_checks
        if item.check_id in SCRAP_FIELD_BY_AFFILIATION_CHECK_ID
    }
    subject = next(
        (item for item in business_checks if item.check_id == "AFFILIATION-SUBJECT-001"),
        None,
    )
    mapped_counts: dict[str, int] = {}
    for snapshot in request.review_fields:
        if snapshot.field:
            mapped_counts[snapshot.field] = mapped_counts.get(snapshot.field, 0) + 1

    steps: list[ReviewStep] = []
    for index, snapshot in enumerate(
        sorted(request.review_fields, key=lambda item: item.order), start=1
    ):
        # 只读日期等控件仍然是需要核验的页面字段；只有无法映射语义的
        # 只读控件才跳过。editable 仅决定是否允许页面回写。
        if not snapshot.editable and not snapshot.field:
            continue
        field = snapshot.field if mapped_counts.get(snapshot.field or "") == 1 else None
        if field == "application.owner_type":
            steps.append(_owner_type_system_step(snapshot))
            continue
        if field in {"old_vehicle.affiliation", "new_vehicle.affiliation"}:
            steps.append(_affiliation_control_step(snapshot, subject))
            continue
        comparison = comparisons_by_field.get(field)
        auxiliary = auxiliary_by_field.get(field)
        if comparison is not None:
            steps.append(
                _with_control_snapshot(
                    _field_step(request, comparison, page_interaction=True), snapshot
                )
            )
        elif auxiliary is not None:
            steps.append(
                _with_control_snapshot(
                    _affiliation_catalog_step(request, auxiliary, field), snapshot
                )
            )
        else:
            step_id = f"FIELD-{field}" if field else f"FIELD-DOM-{index}"
            steps.append(_page_catalog_step(snapshot, step_id))
    return steps


def _external_step(check: ReviewCheck) -> ReviewStep:
    return _step(
        step_id=check.check_id,
        category="EXTERNAL",
        display_target=ReviewDisplayTarget.ASSISTANT,
        label=check.label,
        result_status=check.status,
        reason=check.reason,
        values=check.values,
        evidence=check.evidence,
    )


def _business_step(
    request: ReviewRequest,
    check: ReviewCheck,
    *,
    page_interaction: bool,
) -> ReviewStep:
    return _step(
        step_id=f"BUSINESS-{check.check_id}",
        category="BUSINESS_RULE",
        display_target=ReviewDisplayTarget.ASSISTANT,
        label=check.label,
        result_status=check.status,
        reason=check.reason,
        values=check.values,
        evidence=check.evidence,
        details=check.details,
    )


def _material_steps(
    profile: BusinessProfile,
    completeness: MaterialCompletenessReport | None,
    limitations: Sequence[str],
) -> list[ReviewStep]:
    steps: list[ReviewStep] = []
    issue_causes: set[str] = set()
    if completeness is not None and profile.material_policy is not None:
        # 材料完整时不生成材料成功步骤，只展示实际存在的问题。
        for index, issue in enumerate(completeness.issues, start=1):
            steps.append(
                _step(
                    step_id=f"MATERIAL-{issue.code}-{index}",
                    category="MATERIAL",
                    display_target=ReviewDisplayTarget.ASSISTANT,
                    label="资料完整性",
                    result_status="INSUFFICIENT",
                    reason=f"{issue.message}；{issue.suggested_action}",
                )
            )
            issue_causes.update(
                cause for cause in (issue.reason_detail, issue.message) if cause
            )
    # 同一根因的材料问题和识别限制只保留材料问题这一个步骤。
    unique_limitations = [
        limitation
        for limitation in dict.fromkeys(limitations)
        if limitation not in issue_causes
    ]
    steps.extend(
        _step(
            step_id=f"LIMITATION-{index}",
            category="MATERIAL",
            display_target=ReviewDisplayTarget.ASSISTANT,
            label="识别限制",
            result_status="INSUFFICIENT",
            reason=limitation,
        )
        for index, limitation in enumerate(unique_limitations, start=1)
    )
    return steps


def _deduplicate_steps(steps: Sequence[ReviewStep]) -> list[ReviewStep]:
    seen: set[str] = set()
    result: list[ReviewStep] = []
    for step in steps:
        if step.step_id not in seen:
            seen.add(step.step_id)
            result.append(step)
    return result


def _resequence(steps: Sequence[ReviewStep]) -> list[ReviewStep]:
    return [
        step.model_copy(update={"sequence": sequence})
        for sequence, step in enumerate(steps, start=1)
    ]


def build_review_steps(
    *,
    request: ReviewRequest,
    profile: BusinessProfile,
    comparisons: Sequence[FieldComparison],
    external_checks: Sequence[ReviewCheck],
    business_checks: Sequence[ReviewCheck],
    completeness: MaterialCompletenessReport | None,
    limitations: Sequence[str],
) -> list[ReviewStep]:
    """一次返回完整、有序、带展示目标的审核步骤列表。"""
    page_interaction = is_page_interaction_profile(
        profile.business_type,
        profile.region,
        profile.version,
    )
    steps: list[ReviewStep] = []
    # PAGE_FIELD 只用于目标 Profile 且请求中存在该规范字段；
    # 缺失字段转为 ASSISTANT + INSUFFICIENT。
    # 外部规则、派生规则和材料异常使用 ASSISTANT。
    if page_interaction:
        steps.extend(_scrap_field_steps(request, comparisons, business_checks))
    else:
        steps.extend(
            _field_step(request, comparison, page_interaction=False)
            for comparison in comparisons
        )
    steps.extend(_external_step(check) for check in external_checks)
    steps.extend(
        _business_step(request, check, page_interaction=page_interaction)
        for check in business_checks
    )
    steps.extend(_material_steps(profile, completeness, limitations))
    return _resequence(_deduplicate_steps(steps))
