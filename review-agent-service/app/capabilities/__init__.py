"""Stable public capability APIs.

The implementation currently lives in ``app.rules`` while the architecture is
being migrated. This package is the future extension boundary for capability
specifications, handlers and subgraphs; callers should import from here.
"""

from app.rules.capabilities import (
    CapabilityBinding,
    CapabilityHandler,
    CapabilitySpec,
    ExternalCheckSpec,
    ReviewExecutionContext,
)
from app.rules.capability_registry import CapabilityRegistry

from .models import CapabilityPlanEntry, CapabilityResult
from .page_actions import PageActionHandler, PageActionRegistry, PageActionSpec

__all__ = [
    "CapabilityBinding",
    "CapabilityHandler",
    "CapabilityPlanEntry",
    "CapabilityRegistry",
    "CapabilityResult",
    "CapabilitySpec",
    "ExternalCheckSpec",
    "PageActionHandler",
    "PageActionRegistry",
    "PageActionSpec",
    "ReviewExecutionContext",
]
