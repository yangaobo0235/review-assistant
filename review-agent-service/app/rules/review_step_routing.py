"""字段优先的审核步骤集中路由。

主要职责：一次运行内决定每个审核步骤展示在宿主页面字段还是助手面板，
并完成材料异常去重和步骤排序。展示目标只来自本模块的显式映射表，
不根据中文 label 或 reason 猜测；页内交互只对目标 Profile 启用，
过户、车源和一致性继续使用现有结果界面。
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
    ReviewRequest,
    ReviewStep,
)
from app.rules.final_advice import FIELD_LABELS
from app.rules.review_fields import PRIMARY_REVIEW_FIELDS

# 只有这两个目标 Profile 启用页内交互（业务、地区、版本三元组显式列出）。
PAGE_INTERACTION_PROFILES = frozenset(
    {
        (BusinessType.SCRAP_REPLACEMENT, Region.QINGDAO, "1.0"),
        (BusinessType.SCRAP_REPLACEMENT, Region.CHANGCHUN, "1.0"),
    }
)

# 显式映射表：同字段比较的规范字段 -> 宿主页面采集字段键。
PAGE_FIELD_BY_CANONICAL_FIELD: dict[str, str] = {
    field: field for field in PRIMARY_REVIEW_FIELDS
}

# 显式映射表：辅助守护检查 -> 宿主页面采集字段键。
PAGE_FIELD_BY_CHECK_ID: dict[str, str] = {
    "AFFILIATION-AUX-OWNER-TYPE": "application.owner_type",
    "AFFILIATION-AUX-NEW-VIN": "page_ocr.new_vehicle_vin",
    "AFFILIATION-AUX-CUSTOMER-NAME": "application.customer_name",
}

MISSING_PAGE_FIELD_REASON = "页面字段缺失或存在歧义，请人工核对该字段"

Category = Literal["FIELD", "EXTERNAL", "BUSINESS_RULE", "MATERIAL"]
ResultStatus = Literal["MATCH", "CONFLICT", "INSUFFICIENT"]


def _step(
    *,
    step_id: str,
    category: Category,
    display_target: ReviewDisplayTarget,
    label: str,
    result_status: ResultStatus,
    reason: str,
    page_field: str | None = None,
    values: Sequence[ReviewCheckValue] = (),
    evidence: Sequence[Evidence] = (),
) -> ReviewStep:
    """构建单个步骤；MATCH 不需要人工处理，其余状态必须处理。"""
    return ReviewStep(
        step_id=step_id,
        sequence=1,
        category=category,
        display_target=display_target,
        page_field=page_field,
        requires_reviewer_action=result_status != "MATCH",
        label=label,
        result_status=result_status,
        reason=reason,
        values=list(values),
        evidence=list(evidence),
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
        ReviewCheckValue(source=item.source, value=item.value)
        for item in comparison.evidence
        if item.value not in (None, "")
    ]
    page_field = PAGE_FIELD_BY_CANONICAL_FIELD.get(comparison.field)
    if page_interaction and page_field is not None:
        if _page_field_collected(request, page_field):
            return _step(
                step_id=f"FIELD-{comparison.field}",
                category="FIELD",
                display_target=ReviewDisplayTarget.PAGE_FIELD,
                page_field=page_field,
                label=label,
                result_status=_comparison_status(comparison),
                reason=comparison.message,
                values=values,
                evidence=comparison.evidence,
            )
        # 基础字段在规则清单中但本次页面没有成功采集：转为助手面板并说明原因。
        return _step(
            step_id=f"FIELD-{comparison.field}",
            category="FIELD",
            display_target=ReviewDisplayTarget.ASSISTANT,
            label=label,
            result_status="INSUFFICIENT",
            reason=MISSING_PAGE_FIELD_REASON,
            values=values,
            evidence=comparison.evidence,
        )
    # 非目标 Profile 或映射表之外的字段继续使用助手面板展示。
    return _step(
        step_id=f"FIELD-{comparison.field}",
        category="FIELD",
        display_target=ReviewDisplayTarget.ASSISTANT,
        label=label,
        result_status=_comparison_status(comparison),
        reason=comparison.message,
        values=values,
        evidence=comparison.evidence,
    )


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
    page_field = PAGE_FIELD_BY_CHECK_ID.get(check.check_id)
    if (
        not page_interaction
        or page_field is None
        or not _page_field_collected(request, page_field)
    ):
        page_field = None
    return _step(
        step_id=f"BUSINESS-{check.check_id}",
        category="BUSINESS_RULE",
        display_target=(
            ReviewDisplayTarget.PAGE_FIELD
            if page_field is not None
            else ReviewDisplayTarget.ASSISTANT
        ),
        page_field=page_field,
        label=check.label,
        result_status=check.status,
        reason=check.reason,
        values=check.values,
        evidence=check.evidence,
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
    page_interaction = (
        profile.business_type,
        profile.region,
        profile.version,
    ) in PAGE_INTERACTION_PROFILES
    steps: list[ReviewStep] = []
    # PAGE_FIELD 只用于目标 Profile 且请求中存在该规范字段；
    # 缺失字段转为 ASSISTANT + INSUFFICIENT。
    # 外部规则、派生规则和材料异常使用 ASSISTANT。
    steps.extend(
        _field_step(request, comparison, page_interaction=page_interaction)
        for comparison in comparisons
    )
    steps.extend(_external_step(check) for check in external_checks)
    steps.extend(
        _business_step(request, check, page_interaction=page_interaction)
        for check in business_checks
    )
    steps.extend(_material_steps(profile, completeness, limitations))
    return _resequence(_deduplicate_steps(steps))
