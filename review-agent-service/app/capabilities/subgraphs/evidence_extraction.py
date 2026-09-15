"""Evidence extraction subgraph boundary."""

from collections.abc import Awaitable, Callable

from app.models.review import CapabilityResult
from app.rules.capabilities import CapabilitySpec, ReviewExecutionContext

from .common import build_capability_subgraph


def build_evidence_extraction_subgraph(
    handler: Callable[[ReviewExecutionContext, CapabilitySpec], Awaitable[CapabilityResult]],
) -> Callable[[ReviewExecutionContext, CapabilitySpec], Awaitable[CapabilityResult]]:
    """Return a handler-compatible extraction subgraph.

    The internal OCR/classification steps can evolve independently; the outer
    graph only observes the stable CapabilityResult contract.
    """

    return build_capability_subgraph(handler)
