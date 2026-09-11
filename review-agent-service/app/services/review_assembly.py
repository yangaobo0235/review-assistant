"""部分与最终响应共用的唯一建议、风险和检查组装入口。"""

from app.agent.models import AgentBatchResult, ReviewCheck
from app.models.review import PageFillAction, Recommendation, ReviewResponse, ReviewStep
from app.rules.check_results import unique_checks
from app.rules.final_advice import build_final_advice


def assemble_review_response(
    response: ReviewResponse,
    batch: AgentBatchResult,
    *,
    business_checks: list[ReviewCheck],
    external_checks: list[ReviewCheck] | None = None,
    page_actions: list[PageFillAction] | None = None,
    review_steps: list[ReviewStep] | None = None,
) -> ReviewResponse:
    checks = unique_checks(business_checks)
    decision, advice = build_final_advice(
        response.comparisons,
        unique_checks([*checks, *(external_checks or [])]),
        response.qr_checks,
        response.issues,
        batch.limitations,
        batch.confidences,
        completeness=batch.material_completeness,
    )
    return response.model_copy(
        update={
            "recommendation": Recommendation(decision),
            "risk_level": "LOW"
            if decision == "PASS"
            else "HIGH"
            if any(item.status == "CONFLICT" for item in advice.findings)
            else "MEDIUM",
            "summary": advice.summary,
            "cross_checks": checks,
            "agent_advice": advice,
            "page_fill_intent": page_actions or [],
            "review_steps": review_steps or [],
        }
    )
