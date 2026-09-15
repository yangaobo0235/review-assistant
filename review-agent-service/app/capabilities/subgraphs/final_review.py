"""Final review aggregation subgraph boundary."""

from collections.abc import Awaitable, Callable

from app.models.review import CapabilityResult
from app.rules.capabilities import CapabilitySpec, ReviewExecutionContext

from .common import build_capability_subgraph


def build_final_review_subgraph(
    handler: Callable[[ReviewExecutionContext, CapabilitySpec], Awaitable[CapabilityResult]],
) -> Callable[[ReviewExecutionContext, CapabilitySpec], Awaitable[CapabilityResult]]:
    return build_capability_subgraph(handler)
