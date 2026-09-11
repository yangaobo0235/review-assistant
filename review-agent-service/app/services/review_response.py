"""审核响应组装。

主要职责：把观察、检查、风险和建议转换为 API 响应。
修改日期：2026-08-26
修改人：wuyi
"""

from app.agent.models import AgentBatchResult
from app.businesses.profiles import BusinessProfile
from app.models.review import (
    FieldComparison,
    FieldObservation,
    FieldStatus,
    QrCheck,
    Recommendation,
    ResultSection,
    ReviewRequest,
    ReviewResponse,
)
from app.rules.aggregate import aggregate_field
from app.rules.check_results import unique_checks
from app.rules.normalize import normalize_value
from app.rules.review_step_routing import is_page_interaction_profile
from app.rules.transfer_sources import (
    enforce_transfer_source_requirements,
    filter_transfer_observations,
)
from app.services.review_assembly import assemble_review_response


def _append_qr_observations(
    observations: list[FieldObservation],
    qr_checks: list[QrCheck],
) -> None:
    for check in qr_checks:
        for field, value in check.page_fields.items():
            mapped_field = (
                "old_vehicle.vin"
                if field == "vin"
                else "scrap_certificate.certificate_no"
            )
            observations.append(
                FieldObservation(
                    field=mapped_field,
                    source_type="qr_page",
                    source_id=f"qr-{check.image_index}",
                    image_index=check.image_index,
                    value=value,
                )
            )


def _mark_qr_conflicts(
    observations: list[FieldObservation],
    qr_checks: list[QrCheck],
) -> bool:
    has_conflict = False
    for check in qr_checks:
        for page_field, page_value in check.page_fields.items():
            candidates = [
                item.value
                for item in observations
                if item.image_index == check.image_index
                and item.source_type == "image"
                and (
                    (page_field == "vin" and item.field.endswith(".vin"))
                    or (
                        page_field == "certificate_no"
                        and item.field.endswith("certificate_no")
                    )
                )
                and item.value not in (None, "")
            ]
            field_name = (
                "old_vehicle.vin"
                if page_field == "vin"
                else "scrap_certificate.certificate_no"
            )
            if candidates and normalize_value(
                field_name, candidates[0]
            ) != normalize_value(field_name, page_value):
                check.status = FieldStatus.CONFLICT
                check.message = "二维码网页字段与图片识别结果冲突"
                has_conflict = True
    return has_conflict


def _build_comparisons(
    request: ReviewRequest,
    profile: BusinessProfile,
    observations: list[FieldObservation],
) -> list[FieldComparison]:
    # 不确定标记的一票否决只对字段优先目标 Profile 生效，其余业务保持历史语义。
    uncertain_requires_review = is_page_interaction_profile(
        profile.business_type, profile.region, profile.version
    )
    comparisons = [
        aggregate_field(
            field_name,
            [
                item
                for item in filter_transfer_observations(field_name, observations)
                if item.field == field_name
            ]
            if request.business_type.value == "transfer"
            else [item for item in observations if item.field == field_name],
            uncertain_requires_review=uncertain_requires_review,
        )
        for field_name in profile.required_fields
    ]
    if request.business_type.value == "transfer":
        return [
            enforce_transfer_source_requirements(comparison, observations)
            for comparison in comparisons
        ]
    return comparisons


def build_review_response(
    request: ReviewRequest,
    batch: AgentBatchResult,
    profile: BusinessProfile,
    observations: list[FieldObservation],
    issues: list[str],
    qr_checks: list[QrCheck] | None = None,
    business_checks: list | None = None,
    page_fill_intent: list | None = None,
    defer_advice: bool = False,
) -> ReviewResponse:
    """把提取结果和确定性检查组装为稳定的审核响应。"""

    resolved_qr_checks = qr_checks or []
    _append_qr_observations(observations, resolved_qr_checks)
    _mark_qr_conflicts(observations, resolved_qr_checks)
    comparisons = _build_comparisons(request, profile, observations)
    cross_checks = unique_checks(business_checks or [])
    response = ReviewResponse(
        business_type=request.business_type,
        region=request.region,
        profile_version=profile.version,
        recommendation=Recommendation.REVIEW_REQUIRED,
        risk_level="MEDIUM",
        summary="审核检查正在进行",
        comparisons=comparisons,
        qr_checks=resolved_qr_checks,
        cross_checks=cross_checks,
        issues=issues,
        sections=[
            ResultSection(
                id=section.id,
                title=section.title,
                fields=list(section.fields),
            )
            for section in profile.sections
        ],
        context_summary={
            "field_count": len(request.page_fields),
            "image_count": len(request.images),
            "image_failed_count": sum(
                bool(image.collection_error) for image in request.images
            ),
            "completed_count": batch.completed_count,
            "failed_count": batch.failed_count,
            "timed_out_count": batch.timed_out_count,
        },
        material_completeness=batch.material_completeness,
        retry_summary=batch.retry_summary,
        page_fill_intent=page_fill_intent or [],
    )
    return (
        response
        if defer_advice
        else assemble_review_response(
            response,
            batch,
            business_checks=cross_checks,
            page_actions=page_fill_intent,
        )
    )


def build_unconfigured_response(
    request: ReviewRequest,
    profile: BusinessProfile,
) -> ReviewResponse:
    """Build the stable manual-review response for an unconfigured profile."""

    message = profile.unconfigured_message or "当前审核业务规则尚未配置，请人工复核"
    response = ReviewResponse(
        business_type=request.business_type,
        region=request.region,
        profile_version=profile.version,
        recommendation=Recommendation.REVIEW_REQUIRED,
        risk_level="MEDIUM",
        summary=message,
        issues=[message],
        sections=[],
        context_summary={
            "field_count": len(request.page_fields),
            "image_count": len(request.images),
            "image_failed_count": sum(
                bool(image.collection_error) for image in request.images
            ),
            "completed_count": 0,
            "failed_count": 0,
            "timed_out_count": 0,
        },
    )
    return assemble_review_response(
        response, AgentBatchResult(), business_checks=[]
    ).model_copy(update={"summary": message})
