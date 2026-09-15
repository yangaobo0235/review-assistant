import pytest

from app.agent.models import AgentBatchResult
from app.agent.workflow import WORKFLOW_NODE_ORDER, ReviewState
from app.models.review import ReviewRequest
from app.services.review import ReviewService


def test_workflow_declares_the_approved_node_order() -> None:
    assert WORKFLOW_NODE_ORDER == (
        "resolve_context",
        "validate_input",
        "assess_coverage",
        "extract_evidence",
        "assess_evidence_quality",
        "plan_capabilities",
        "execute_capabilities",
        "compare_fields",
        "assemble_facts",
        "prepare_review_tasks",
        "derive_recommendation",
        "build_response",
    )


def test_workflow_state_declares_entry_context_as_required() -> None:
    assert ReviewState.__required_keys__ == {"request", "profile"}


@pytest.mark.asyncio
async def test_workflow_returns_both_cross_checks_and_two_state_advice() -> None:
    result = await ReviewService().assist_async(
        ReviewRequest(
            page_url="https://example.test/review/1", region="qingdao", images=[]
        )
    )

    assert {check.check_id for check in result.cross_checks} == {
        "POLICY-INVOICE-DATE",
        "POLICY-DISPOSAL-DEADLINE",
        "POLICY-NEW-ORIGIN",
        "AFFILIATION-SUBJECT-001",
        "AFFILIATION-AUX-CUSTOMER-NAME",
        "MATERIAL-COMPLETENESS",
    }
    assert result.recommendation.value == "REVIEW_REQUIRED"
    assert result.agent_advice.decision == "REVIEW_REQUIRED"
    assert result.agent_advice.findings


@pytest.mark.asyncio
async def test_workflow_returns_its_local_batch_with_the_response() -> None:
    service = ReviewService()

    response, batch = await service.workflow.run(
        ReviewRequest(
            page_url="https://example.test/review/1", region="qingdao", images=[]
        )
    )

    assert response.recommendation.value == "REVIEW_REQUIRED"
    assert batch.total_count == 0


def test_partial_response_uses_final_advice_contract() -> None:
    service = ReviewService()
    request = ReviewRequest(
        page_url="https://example.test/review/1", region="qingdao", images=[]
    )

    response = service._build_response(
        request,
        AgentBatchResult(),
        include_tools=False,
    )

    assert response.agent_advice.title == "建议人工复核"
    assert response.agent_advice.findings
    assert response.cross_checks == []
