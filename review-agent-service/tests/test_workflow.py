import pytest

from app.businesses.profiles import SCRAP_REPLACEMENT_QINGDAO
from app.capabilities.specs import ReviewExecutionContext
from app.models.review import FieldObservation, ReviewRequest
from app.services.review import ReviewService
from app.workflow.graph import WORKFLOW_NODE_ORDER, ReviewState, ReviewWorkflow
from app.workflow.models import AgentBatchResult

INVOICE_NO = "26320000000801433801"


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
        "OWNER-CONSISTENCY-001",
        "MATERIAL-COMPLETENESS",
        "FIELD-INVOICE-CODE-NO",
        "FIELD-NEW-VEHICLE-VIN",
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


def _invoice_observation(value: str) -> FieldObservation:
    return FieldObservation(
        field="invoice.invoice_no",
        source_type="image",
        source_id="invoice-01",
        value=value,
    )


@pytest.mark.asyncio
async def test_matched_invoice_number_proposes_verify_invoice_page_action(monkeypatch) -> None:
    """发票号码与页面一致时，由 `verify_invoice` 能力提出一键验真动作。"""
    service = ReviewService()

    async def matched(*_args, **_kwargs):
        return AgentBatchResult(observations=[_invoice_observation(INVOICE_NO)])

    monkeypatch.setattr(service, "_extract_documents", matched)
    response = await service.assist_async(ReviewRequest(
        page_url="https://example.test/review/1",
        region="qingdao",
        page_fields={"invoice.invoice_no": INVOICE_NO},
    ))

    assert [(action.action_id, action.payload) for action in response.page_actions] == [
        ("verify_invoice", {"field": "invoice.invoice_no"}),
    ]


@pytest.mark.asyncio
async def test_conflicting_invoice_number_does_not_propose_verify_invoice(monkeypatch) -> None:
    service = ReviewService()

    async def mismatched(*_args, **_kwargs):
        return AgentBatchResult(observations=[_invoice_observation("99999999999999999999")])

    monkeypatch.setattr(service, "_extract_documents", mismatched)
    response = await service.assist_async(ReviewRequest(
        page_url="https://example.test/review/1",
        region="qingdao",
        page_fields={"invoice.invoice_no": INVOICE_NO},
    ))

    assert response.page_actions == []


def test_verify_invoice_capability_is_silent_without_comparisons() -> None:
    """能力本身不产出检查项，因此不会影响工作台的待处理计数。"""
    context = ReviewExecutionContext(
        request=ReviewRequest(page_url="https://example.test/review/1", region="qingdao"),
        profile=SCRAP_REPLACEMENT_QINGDAO,
        batch=AgentBatchResult(),
        observations=(),
        comparisons=(),
    )

    result = ReviewWorkflow._run_verify_invoice(context)

    assert result.checks == ()
    assert result.page_action_intents == ()
