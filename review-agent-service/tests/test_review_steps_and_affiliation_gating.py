from app.agent.models import AgentBatchResult, ReviewCheck
from app.agent.workflow import ReviewWorkflow
from app.businesses.profiles import SCRAP_REPLACEMENT_QINGDAO, TRANSFER_DEFAULT
from app.models.review import FieldComparison, FieldStatus, ReviewRequest


def comparison(field: str, value: str) -> FieldComparison:
    return FieldComparison(
        field=field,
        left_value=value,
        right_value=value,
        status=FieldStatus.MATCH,
        message="多个来源字段一致",
    )


def test_affiliation_auxiliary_checks_gate_actions_but_keep_subject_match() -> None:
    request = ReviewRequest(
        page_url="https://example.test/scrap",
        page_fields={
            "application.owner_type": "企业",
            "page_ocr.new_vehicle_vin": "VIN-NEW",
            "application.customer_name": "张三",
        },
    )
    state = {
        "request": request,
        "profile": SCRAP_REPLACEMENT_QINGDAO,
        "batch": AgentBatchResult(),
        "response": type("Response", (), {
            "comparisons": [
                comparison("old_vehicle.owner", "张三"),
                comparison("new_vehicle.owner", "张三"),
                comparison("new_vehicle.vin", "VIN-NEW"),
            ],
        })(),
        "qr_checks": [],
    }

    result = ReviewWorkflow._run_affiliation_subject(ReviewWorkflow.__new__(ReviewWorkflow)._execution_context(state))

    assert result.checks[0].check_id == "AFFILIATION-SUBJECT-001"
    assert result.checks[0].status == "MATCH"
    assert {item.check_id: item.status for item in result.checks[1:]} == {
        "AFFILIATION-AUX-OWNER-TYPE": "CONFLICT",
        "AFFILIATION-AUX-NEW-VIN": "MATCH",
        "AFFILIATION-AUX-CUSTOMER-NAME": "MATCH",
    }
    assert result.page_action_candidates == ()


def test_affiliation_actions_require_every_auxiliary_match_and_accept_company_labels() -> None:
    request = ReviewRequest(
        page_url="https://example.test/scrap",
        page_fields={
            "application.owner_type": "公司",
            "page_ocr.new_vehicle_vin": "vin-new",
            "application.customer_name": "甲运输有限公司",
        },
    )
    state = {
        "request": request,
        "profile": SCRAP_REPLACEMENT_QINGDAO,
        "batch": AgentBatchResult(),
        "response": type("Response", (), {
            "comparisons": [
                comparison("old_vehicle.owner", "甲运输有限公司"),
                comparison("new_vehicle.owner", "甲运输有限公司"),
                comparison("new_vehicle.vin", "VIN-NEW"),
            ],
        })(),
        "qr_checks": [],
    }

    result = ReviewWorkflow._run_affiliation_subject(ReviewWorkflow.__new__(ReviewWorkflow)._execution_context(state))

    assert [item.status for item in result.checks] == ["MATCH", "MATCH", "MATCH", "MATCH"]
    assert [action.field for action in result.page_action_candidates] == [
        "old_vehicle.affiliation",
        "new_vehicle.affiliation",
    ]


def test_prepare_review_steps_includes_only_configured_capabilities_and_maps_statuses() -> None:
    request = ReviewRequest(
        page_url="https://example.test/transfer",
        business_type="transfer",
        region="default",
    )
    state = {
        "request": request,
        "profile": TRANSFER_DEFAULT,
        "response": type("Response", (), {
            "comparisons": [FieldComparison(
                field="transfer.vin", status=FieldStatus.REVIEW_REQUIRED,
                message="仅有一个有效来源，证据不足",
            )],
        })(),
        "cross_checks": [ReviewCheck(
            check_id="CROSS-TRANSFER-VIN-001", label="过户车架号", status="MATCH", reason="一致"
        )],
        "qr_checks": [],
        "batch": AgentBatchResult(),
    }

    result = ReviewWorkflow._prepare_review_steps(state)

    assert [(item.step_id, item.category, item.result_status) for item in result["review_steps"]] == [
        ("FIELD-transfer.vin", "FIELD", "INSUFFICIENT"),
        ("BUSINESS-CROSS-TRANSFER-VIN-001", "BUSINESS_RULE", "MATCH"),
    ]
    assert not any("QR" in item.step_id or "AFFILIATION" in item.step_id for item in result["review_steps"])


def test_scrap_missing_auxiliary_values_are_independent_steps_and_block_final_intent() -> None:
    request = ReviewRequest(page_url="https://example.test/scrap")
    state = {
        "request": request,
        "profile": SCRAP_REPLACEMENT_QINGDAO,
        "batch": AgentBatchResult(),
        "response": type("Response", (), {"comparisons": []})(),
        "qr_checks": [],
    }

    result = ReviewWorkflow._run_affiliation_subject(ReviewWorkflow.__new__(ReviewWorkflow)._execution_context(state))
    steps = ReviewWorkflow._prepare_review_steps({
        **state,
        "cross_checks": list(result.checks),
    })["review_steps"]

    assert {step.step_id for step in steps} >= {
        "BUSINESS-AFFILIATION-AUX-OWNER-TYPE",
        "BUSINESS-AFFILIATION-AUX-NEW-VIN",
        "BUSINESS-AFFILIATION-AUX-CUSTOMER-NAME",
    }
    assert all(step.result_status == "INSUFFICIENT" for step in steps if "AFFILIATION-AUX" in step.step_id)
    assert result.page_action_candidates == ()
