import pytest

from app.businesses.profiles import BusinessProfile
from app.businesses.registry import BusinessRegistry
from app.capabilities.specs import RuleExecutionResult
from app.models.review import BusinessType, Region, ReviewRequest
from app.services.review import ReviewService
from app.workflow.models import CheckResult


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


@pytest.mark.asyncio
async def test_profile_without_material_or_field_requirements_has_no_missing_input_issues():
    service = ReviewService(
        registry=BusinessRegistry((single_field_profile(),)),
        business_rule_handlers={
            "single_field_test": lambda _: RuleExecutionResult(
                checks=(CheckResult(check_id="READY", label="配置核验", status="MATCH", reason="配置满足"),)
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
