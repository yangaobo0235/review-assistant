import pytest

from app.agent.models import AgentBatchResult
from app.businesses.profiles import TRANSFER_DEFAULT
from app.models.review import ReviewRequest
from app.rules.capabilities import ExternalCheckSpec, ReviewExecutionContext
from app.rules.external_check_registry import (
    ExternalCheckRegistry,
    UnknownExternalCheck,
)


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


@pytest.mark.asyncio
async def test_empty_configuration_skips_all_external_checks() -> None:
    called = False

    async def handler(_context, _spec):
        nonlocal called
        called = True
        return ()

    result = await ExternalCheckRegistry({"qr": handler}).execute((), context())

    assert result == ()
    assert called is False


@pytest.mark.asyncio
async def test_registry_rejects_unknown_external_check() -> None:
    with pytest.raises(UnknownExternalCheck, match="missing"):
        await ExternalCheckRegistry({}).execute(
            (ExternalCheckSpec("missing", "REQUIRED"),),
            context(),
        )
