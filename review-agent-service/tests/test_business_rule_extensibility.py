import pytest

from app.agent.models import ReviewCheck, ReviewCheckValue
from app.businesses.profiles import BusinessProfile
from app.businesses.registry import BusinessRegistry
from app.models.review import BusinessType, Region, ReviewRequest
from app.rules.business_rule_registry import UnknownBusinessRule
from app.rules.capabilities import RuleExecutionResult
from app.services.review import ReviewService


def single_field_profile():
    return BusinessProfile(
        business_type=BusinessType.VEHICLE_SOURCE,
        region=Region.DEFAULT,
        version="1.0",
        required_fields=(),
        sections=(),
        rules_configured=True,
        rule_groups=("single_field_test",),
        external_checks=(),
        page_actions=(),
    )


@pytest.mark.parametrize("value,status", [("confirmed", "MATCH"), ("other", "CONFLICT")])
@pytest.mark.asyncio
async def test_injected_single_field_rule_runs_through_the_unchanged_graph(
    value, status
):
    calls = []

    def check_field(context):
        actual = context.request.page_fields.get("application.test_status")
        calls.append(actual)
        return RuleExecutionResult(
            checks=(
                ReviewCheck(
                    check_id="SINGLE-FIELD-001",
                    label="测试字段核验",
                    status="MATCH" if actual == "confirmed" else "CONFLICT",
                    reason="测试字段必须明确确认",
                    values=[ReviewCheckValue(source="测试页面字段", value=actual)],
                ),
            )
        )

    handlers = {"single_field_test": check_field}
    service = ReviewService(
        registry=BusinessRegistry((single_field_profile(),)),
        business_rule_handlers=handlers,
    )
    # Registration takes a snapshot rather than retaining a mutable caller map.
    handlers.clear()
    response = await service.assist_async(
        ReviewRequest(
            page_url="https://example.test/single-field",
            business_type="vehicle_source",
            region="default",
            page_fields={"application.test_status": value},
        )
    )

    assert calls == [value]
    assert [(step.step_id, step.category, step.result_status) for step in response.review_steps] == [
        ("BUSINESS-SINGLE-FIELD-001", "BUSINESS_RULE", status)
    ]
    assert [check.check_id for check in response.cross_checks] == ["SINGLE-FIELD-001"]
    assert response.qr_checks == []
    assert response.page_fill_intent == []
    assert any(
        finding.check_id == "SINGLE-FIELD-001"
        for finding in response.agent_advice.findings
    ) == (status == "CONFLICT")
    if status == "CONFLICT":
        assert response.risk_level == "HIGH"
        assert response.recommendation.value == "REVIEW_REQUIRED"
    else:
        assert response.recommendation.value == "PASS"
        assert response.risk_level == "LOW"
        assert response.issues == []
        assert response.agent_advice.findings == []


@pytest.mark.asyncio
async def test_profile_without_material_or_field_requirements_has_no_missing_input_issues():
    service = ReviewService(
        registry=BusinessRegistry((single_field_profile(),)),
        business_rule_handlers={
            "single_field_test": lambda _: RuleExecutionResult(
                checks=(ReviewCheck(check_id="READY", label="配置核验", status="MATCH", reason="配置满足"),)
            )
        },
    )
    response = await service.assist_async(ReviewRequest(
        page_url="https://example.test/empty",
        business_type="vehicle_source",
        region="default",
    ))
    assert response.issues == []
    assert response.agent_advice.findings == []
    assert response.recommendation.value == "PASS"
    assert response.risk_level == "LOW"


@pytest.mark.parametrize(
    "rule_id",
    [
        "qingdao_replacement_policy",
        "changchun_replacement_policy",
        "affiliation_subject",
        "transfer_registration",
    ],
)
def test_injected_business_rule_cannot_override_any_builtin(rule_id):
    with pytest.raises(ValueError, match="不能覆盖内置业务规则"):
        ReviewService(business_rule_handlers={rule_id: lambda _: RuleExecutionResult()})


def test_injection_does_not_silently_skip_an_unregistered_profile_rule():
    with pytest.raises(UnknownBusinessRule, match="single_field_test"):
        ReviewService(
            registry=BusinessRegistry((single_field_profile(),)),
            business_rule_handlers={"unrelated": lambda _: RuleExecutionResult()},
        )
