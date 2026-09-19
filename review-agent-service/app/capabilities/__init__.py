"""能力契约、注册表、子图和页面动作的公共入口。"""

from app.capabilities.page_actions import (
    PageActionHandler,
    PageActionRegistry,
    PageActionSpec,
)
from app.capabilities.registry import CapabilityRegistry
from app.capabilities.specs import (
    CapabilityBinding,
    CapabilityHandler,
    CapabilitySpec,
    ExternalCheckSpec,
    ReviewExecutionContext,
)
from app.models.review import CapabilityPlanEntry, CapabilityResult

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
