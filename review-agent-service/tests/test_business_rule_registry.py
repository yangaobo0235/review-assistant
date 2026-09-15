import pytest

from app.agent.models import AgentBatchResult, CheckResult
from app.businesses.profiles import TRANSFER_DEFAULT
from app.models.review import ReviewRequest
from app.rules.business_rule_registry import BusinessRuleRegistry, UnknownBusinessRule
from app.rules.capabilities import ReviewExecutionContext, RuleExecutionResult


def context():
    return ReviewExecutionContext(
        request=ReviewRequest(
            page_url="https://example.test/transfer",
            business_type="transfer",
            region="default",
        ),
        profile=TRANSFER_DEFAULT,
        batch=AgentBatchResult(),
        observations=(),
    )


def test_registry_runs_only_configured_rules_in_order() -> None:
    registry = BusinessRuleRegistry(
        {
            "first": lambda _: RuleExecutionResult(checks=(CheckResult(
                check_id="FIRST", label="第一项", status="MATCH", reason="通过"
            ),)),
            "second": lambda _: RuleExecutionResult(checks=(CheckResult(
                check_id="SECOND", label="第二项", status="MATCH", reason="通过"
            ),)),
        }
    )

    result = registry.execute(("second", "first"), context())

    assert [item.check_id for item in result.checks] == ["SECOND", "FIRST"]


def test_registry_rejects_unknown_rule() -> None:
    with pytest.raises(UnknownBusinessRule, match="missing"):
        BusinessRuleRegistry({}).execute(("missing",), context())
