"""能力执行的唯一调度入口：只执行 READY，隔离异常、限制耗时。"""

import asyncio
import logging
from collections.abc import Mapping, Sequence

from app.agent.models import CheckResult
from app.agent.planner import CapabilityPlanItem
from app.rules.capabilities import (
    CapabilityBinding,
    CapabilityHandler,
    CapabilityResult,
    CapabilitySpec,
    ReviewExecutionContext,
)

logger = logging.getLogger(__name__)


class CapabilityRegistry:
    def __init__(self, handlers: Mapping[str, CapabilityHandler], specs: Mapping[str, CapabilitySpec] | None = None):
        self.handlers = dict(handlers)
        self.specs = dict(specs or {})

    def register(self, spec: CapabilitySpec, handler: CapabilityHandler) -> None:
        if spec.capability_id in self.handlers:
            raise ValueError(f"能力已注册：{spec.capability_id}")
        self.specs[spec.capability_id] = spec
        self.handlers[spec.capability_id] = handler

    def get(self, capability_id: str) -> CapabilitySpec:
        try:
            return self.specs[capability_id]
        except KeyError as exc:
            raise KeyError(f"未注册能力：{capability_id}") from exc

    def describe(self) -> tuple[CapabilitySpec, ...]:
        """Return registered capability metadata in deterministic order."""
        return tuple(self.specs[key] for key in sorted(self.specs))

    def validate(self, specs: Sequence[CapabilitySpec]) -> None:
        ids = [item.capability_id for item in specs]
        if len(ids) != len(set(ids)):
            raise ValueError("Profile 能力标识重复")
        missing = set(ids) - self.handlers.keys()
        if missing:
            raise ValueError(f"未注册能力：{', '.join(sorted(missing))}")
        for spec in specs:
            self.specs.setdefault(spec.capability_id, spec)

    def validate_bindings(
        self,
        bindings: Sequence[CapabilityBinding],
        specs: Sequence[CapabilitySpec],
    ) -> None:
        """Validate a Profile declaration against registered capabilities."""
        ids = [binding.capability_id for binding in bindings]
        if len(ids) != len(set(ids)):
            raise ValueError("Profile 能力标识重复")
        spec_map = {spec.capability_id: spec for spec in specs}
        unknown = set(ids) - set(spec_map)
        if unknown:
            raise ValueError(f"Profile 绑定了未定义能力：{', '.join(sorted(unknown))}")
        missing_handlers = set(ids) - set(self.handlers)
        if missing_handlers:
            raise ValueError(f"能力缺少处理器：{', '.join(sorted(missing_handlers))}")
        for binding in bindings:
            if binding.required is not None and not isinstance(binding.required, bool):
                raise ValueError(f"能力 {binding.capability_id} 的 required 必须为布尔值")

    async def execute(self, spec: CapabilitySpec, plan: CapabilityPlanItem, context: ReviewExecutionContext) -> CapabilityResult:
        if plan.status != "READY":
            return self._unavailable(spec, plan.status, plan.reason, "MATERIAL_MISSING", 0)
        handler = self.handlers[spec.capability_id]
        for attempt in range(1, spec.retries + 2):
            try:
                async with asyncio.timeout(spec.timeout_seconds):
                    result = await handler(context, spec)
                if result.capability_id != spec.capability_id:
                    raise ValueError("能力返回了其他能力的标识")
                return result.model_copy(update={"attempts": attempt})
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - isolate handler failures
                logger.warning("Capability %s failed: %s", spec.capability_id, type(exc).__name__)
                if attempt > spec.retries:
                    code = "EXTERNAL_SERVICE_FAILED" if spec.kind == "EXTERNAL" else "CAPABILITY_FAILED"
                    status = "SKIPPED" if spec.failure_policy in {"SAFE_DEGRADE", "SKIP"} else (
                        "BLOCKED" if spec.failure_policy == "BLOCK" else "FAILED"
                    )
                    return self._unavailable(spec, status, "能力执行超时" if isinstance(exc, TimeoutError) else "能力执行失败，请人工复核", code, attempt)
        raise RuntimeError("能力执行未产生结果")

    @staticmethod
    def _unavailable(spec: CapabilitySpec, status: str, reason: str, code: str, attempts: int) -> CapabilityResult:
        # A BLOCKED plan already means the Planner resolved this binding as
        # required, even when the static spec is optional. Preserve that
        # decision instead of silently dropping the reviewer task.
        required = status in {"BLOCKED", "FAILED", "NOT_CONFIGURED"}
        return CapabilityResult(
            capability_id=spec.capability_id, status=status, error_code=code if required else None,
            attempts=attempts, limitations=[reason] if required else [],
            checks=[CheckResult(check_id=f"CAPABILITY-{spec.capability_id}", label="能力核验", status="INSUFFICIENT", reason=reason)] if required else [],
        )
