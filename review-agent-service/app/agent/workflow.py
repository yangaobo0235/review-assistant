"""LangGraph 审核工作流。

主要职责：按确定顺序编排提取、核验、比较和建议生成节点。
修改日期：2026-08-26
修改人：wuyi
"""

from collections.abc import Callable, Mapping
from itertools import pairwise
from typing import Any, Required, TypedDict

from langgraph.graph import END, START, StateGraph

from app.agent.models import (
    AgentAdvice,
    AgentBatchResult,
    MaterialCompletenessReport,
    ReviewCheck,
)
from app.agent.planner import plan_capabilities
from app.businesses.context_validation import validate_request_route
from app.businesses.profiles import BusinessProfile
from app.models.review import (
    BusinessType,
    PageFillAction,
    QrCheck,
    Region,
    ReviewRequest,
    ReviewResponse,
    ReviewStep,
)
from app.rules.affiliation_subject_checks import (
    build_affiliation_auxiliary_checks,
    build_affiliation_subject_check,
)
from app.rules.business_rule_registry import BusinessRuleRegistry
from app.rules.capabilities import (
    BusinessRuleHandler,
    ExternalCheckHandler,
    ExternalCheckSpec,
    ReviewExecutionContext,
    RuleExecutionResult,
)
from app.rules.check_results import qr_review_checks, unique_checks
from app.rules.cross_document_common import raw_settled_value
from app.rules.evidence_values import batch_observations
from app.rules.external_check_registry import ExternalCheckRegistry
from app.rules.material_completeness import evaluate_collected, evaluate_extracted
from app.rules.replacement_policy_checks import build_replacement_policy_checks
from app.rules.review_step_routing import build_review_steps
from app.services.review_assembly import assemble_review_response

WORKFLOW_NODE_ORDER = (
    "validate_context",
    "assess_collected_materials",
    "extract_documents",
    "assess_extracted_evidence",
    "run_external_checks",
    "compare_same_fields",
    "run_business_rules",
    "prepare_review_steps",
    "derive_recommendation",
    "build_final_response",
)


class ReviewState(TypedDict, total=False):
    """工作流节点共享状态；Required 字段由入口保证，其余字段按节点顺序产生。"""

    request: Required[ReviewRequest]
    profile: Required[BusinessProfile]
    batch_callback: Callable[[AgentBatchResult], Any] | None
    batch: AgentBatchResult
    qr_checks: list[QrCheck]
    external_results: list[ReviewCheck]
    response: ReviewResponse
    cross_checks: list[ReviewCheck]
    page_fill_intent: list[PageFillAction]
    recommendation: str
    advice: AgentAdvice
    material_completeness: MaterialCompletenessReport
    review_steps: list[ReviewStep]


class ReviewWorkflow:
    """按固定节点顺序执行提取、核验、比较和最终建议组装。"""

    def __init__(
        self,
        service: Any,
        *,
        external_check_handlers: Mapping[str, ExternalCheckHandler] | None = None,
        business_rule_handlers: Mapping[str, BusinessRuleHandler] | None = None,
    ) -> None:
        """构建并编译审核状态图，具体业务能力由服务门面提供。"""
        self.service = service
        self.external_checks = ExternalCheckRegistry(
            {
                "scrap_certificate_qr": self._run_scrap_certificate_qr,
                **(external_check_handlers or {}),
            }
        )
        builtin_rules: dict[str, BusinessRuleHandler] = {
            "qingdao_replacement_policy": self._run_replacement_policy,
            "changchun_replacement_policy": self._run_replacement_policy,
            "affiliation_subject": self._run_affiliation_subject,
        }
        additional_rules = dict(business_rule_handlers or {})
        overridden = builtin_rules.keys() & additional_rules.keys()
        if overridden:
            raise ValueError(f"不能覆盖内置业务规则：{', '.join(sorted(overridden))}")
        self.business_rules = BusinessRuleRegistry({**builtin_rules, **additional_rules})
        for profile in service.registry.profiles:
            self.external_checks.validate(profile.external_checks)
            self.business_rules.validate(profile.rule_groups)
            unknown_actions = set(profile.page_actions) - {"fill_affiliation_fields"}
            if unknown_actions:
                raise ValueError(
                    f"未注册页面动作：{', '.join(sorted(unknown_actions))}"
                )
            if (
                set(profile.rule_groups)
                & {"qingdao_replacement_policy", "changchun_replacement_policy"}
                and profile.replacement_policy is None
            ):
                raise ValueError("地区政策规则缺少 replacement_policy 配置")
            policy = profile.replacement_policy
            policy_rules = set(profile.rule_groups) & {
                "qingdao_replacement_policy",
                "changchun_replacement_policy",
            }
            if policy is not None and (
                profile.business_type is not BusinessType.SCRAP_REPLACEMENT
                or policy.region != profile.region
                or policy.version != profile.version
                or policy.policy_id != f"scrap_replacement_{profile.region.value}"
                or policy_rules
                and policy_rules != {f"{profile.region.value}_replacement_policy"}
            ):
                raise ValueError("地区政策的归属、版本或规则标识与 Profile 不一致")
        builder = StateGraph(ReviewState)
        builder.add_node("validate_context", self._validate_context)
        builder.add_node("assess_collected_materials", self._assess_collected_materials)
        builder.add_node("extract_documents", self._extract_documents)
        builder.add_node("assess_extracted_evidence", self._assess_extracted_evidence)
        builder.add_node("run_external_checks", self._run_external_checks)
        builder.add_node("compare_same_fields", self._compare_same_fields)
        builder.add_node("run_business_rules", self._run_business_rules)
        builder.add_node("prepare_review_steps", self._prepare_review_steps)
        builder.add_node("derive_recommendation", self._derive_recommendation)
        builder.add_node("build_final_response", self._build_final_response)
        builder.add_edge(START, WORKFLOW_NODE_ORDER[0])
        for source, target in pairwise(WORKFLOW_NODE_ORDER):
            builder.add_edge(source, target)
        builder.add_edge(WORKFLOW_NODE_ORDER[-1], END)
        self.graph = builder.compile()

    @staticmethod
    def _validate_context(state: ReviewState) -> dict[str, Any]:
        """保留入口已解析的请求和业务配置，建立稳定的初始状态。"""
        request, profile = state["request"], state["profile"]
        validate_request_route(request)
        if (
            profile.business_type != request.business_type
            or profile.version != request.profile_version
            or profile.region != request.region
            and profile.region is not Region.DEFAULT
        ):
            raise ValueError("请求业务、地区或版本与显式 Profile 不一致")
        return {"request": state["request"], "profile": state["profile"]}

    async def _extract_documents(self, state: ReviewState) -> dict[str, Any]:
        """调用批处理服务提取材料字段，并透传进度回调。"""
        batch = await self.service._extract_documents(
            state["request"],
            state.get("batch_callback"),
            state["profile"],
            state.get("material_completeness"),
        )
        return {"batch": batch}

    @staticmethod
    async def _assess_collected_materials(state: ReviewState) -> dict[str, Any]:
        report = evaluate_collected(state["request"], state["profile"])
        callback = state.get("batch_callback")
        if callback is not None:
            callback_result = callback(
                AgentBatchResult(
                    total_count=len(state["request"].images),
                    material_completeness=report,
                )
            )
            if hasattr(callback_result, "__await__"):
                await callback_result
        return {"material_completeness": report}

    @staticmethod
    async def _assess_extracted_evidence(state: ReviewState) -> dict[str, Any]:
        batch = state.get("batch")
        if batch is None:
            raise RuntimeError("工作流状态缺少文档提取结果")
        report = evaluate_extracted(state["request"], state["profile"], batch)
        updated = batch.model_copy(update={"material_completeness": report})
        callback = state.get("batch_callback")
        if callback is not None:
            callback_result = callback(updated)
            if hasattr(callback_result, "__await__"):
                await callback_result
        return {"batch": updated, "material_completeness": report}

    @staticmethod
    def _plan_capabilities(state: ReviewState) -> dict[str, Any]:
        return {"capability_plan": plan_capabilities(state["profile"])} 

    def _execution_context(self, state: ReviewState) -> ReviewExecutionContext:
        batch = state.get("batch")
        if batch is None:
            raise RuntimeError("工作流状态缺少文档提取结果")
        response = state.get("response")
        return ReviewExecutionContext(
            request=state["request"],
            profile=state["profile"],
            batch=batch,
            observations=tuple(batch_observations(batch)),
            comparisons=tuple(response.comparisons if response else ()),
            qr_checks=tuple(state.get("qr_checks", ())),
        )

    async def _run_scrap_certificate_qr(
        self,
        context: ReviewExecutionContext,
        spec: ExternalCheckSpec,
    ) -> tuple[ReviewCheck | QrCheck, ...]:
        checks = await self.service._collect_qr_checks(
            context.request,
            context.batch,
            context.profile,
        )
        if not checks and spec.mode == "REQUIRED":
            return (
                ReviewCheck(
                    check_id=f"EXTERNAL-{spec.check_id}",
                    label="二维码官网核验",
                    status="INSUFFICIENT",
                    reason="缺少可核验的报废回收证明材料",
                ),
            )
        return tuple(checks)

    async def _run_external_checks(self, state: ReviewState) -> dict[str, Any]:
        """只执行当前 Profile 声明的外部核验。"""
        results = await self.external_checks.execute(
            state["profile"].external_checks,
            self._execution_context(state),
        )
        return {
            "qr_checks": [item for item in results if isinstance(item, QrCheck)],
            "external_results": unique_checks(
                item for item in results if isinstance(item, ReviewCheck)
            ),
        }

    def _compare_same_fields(self, state: ReviewState) -> dict[str, Any]:
        """组装页面、图片和官网观察值并执行同字段比较。"""
        batch = state.get("batch")
        qr_checks = state.get("qr_checks")
        if batch is None:
            raise RuntimeError("工作流状态缺少文档提取结果")
        if qr_checks is None:
            raise RuntimeError("工作流状态缺少二维码核验结果")
        response = self.service._build_response(
            state["request"],
            batch,
            state["profile"],
            include_tools=False,
            qr_checks=qr_checks,
            business_checks=[],
            defer_advice=True,
        )
        return {
            "response": response,
            "external_results": unique_checks(
                [
                    *state.get("external_results", []),
                    *qr_review_checks(response.qr_checks, state["request"].images),
                ]
            ),
        }

    @staticmethod
    def _run_replacement_policy(context: ReviewExecutionContext) -> RuleExecutionResult:
        policy = context.profile.replacement_policy
        if policy is None:
            raise ValueError("地区政策规则缺少 replacement_policy 配置")
        return RuleExecutionResult(
            checks=tuple(
                build_replacement_policy_checks(policy, list(context.observations))
            )
        )

    @staticmethod
    def _run_affiliation_subject(
        context: ReviewExecutionContext,
    ) -> RuleExecutionResult:
        comparisons = {item.field: item for item in context.comparisons}
        result = build_affiliation_subject_check(
            context.request.page_fields.get("old_vehicle.owner")
            or raw_settled_value(comparisons, "old_vehicle.owner"),
            context.request.page_fields.get("new_vehicle.owner")
            or raw_settled_value(comparisons, "new_vehicle.owner"),
            list(context.observations),
            context.request.page_fields.get("application.owner_type"),
        )
        auxiliary_checks = build_affiliation_auxiliary_checks(
            page_fields=context.request.page_fields,
            new_owner_type=result.owner_types[1],
            new_owner=context.request.page_fields.get("new_vehicle.owner")
            or raw_settled_value(comparisons, "new_vehicle.owner"),
        )
        return RuleExecutionResult(
            checks=(result.check, *auxiliary_checks),
            page_action_candidates=(
                result.page_actions
                if result.check.status == "MATCH"
                and all(check.status == "MATCH" for check in auxiliary_checks)
                else ()
            ),
        )

    def _run_business_rules(self, state: ReviewState) -> dict[str, Any]:
        result = self.business_rules.execute(
            state["profile"].rule_groups,
            self._execution_context(state),
        )
        allowed_actions = (
            list(result.page_action_candidates)
            if "fill_affiliation_fields" in state["profile"].page_actions
            else []
        )
        return {
            "cross_checks": list(result.checks),
            "page_fill_intent": allowed_actions,
        }

    @staticmethod
    def _prepare_review_steps(state: ReviewState) -> dict[str, Any]:
        """读取工作流状态，把步骤路由委托给集中路由模块。"""

        response = state.get("response")
        if response is None:
            raise RuntimeError("工作流状态缺少同字段比对结果")
        batch = state.get("batch")
        return {
            "review_steps": build_review_steps(
                request=state["request"],
                profile=state["profile"],
                comparisons=list(response.comparisons),
                external_checks=list(state.get("external_results", [])),
                business_checks=list(state.get("cross_checks", [])),
                completeness=state.get("material_completeness"),
                limitations=list(batch.limitations if batch else []),
            )
        }

    @staticmethod
    def _derive_recommendation(state: ReviewState) -> dict[str, Any]:
        """汇总字段、跨材料、二维码和能力限制，生成安全审核建议。"""
        response = state.get("response")
        cross_checks = state.get("cross_checks")
        qr_checks = state.get("qr_checks")
        batch = state.get("batch")
        if response is None:
            raise RuntimeError("工作流状态缺少同字段比对结果")
        if cross_checks is None:
            raise RuntimeError("工作流状态缺少跨材料比对结果")
        if qr_checks is None:
            raise RuntimeError("工作流状态缺少二维码核验结果")
        if batch is None:
            raise RuntimeError("工作流状态缺少文档提取结果")
        assembled = assemble_review_response(
            response,
            batch,
            business_checks=cross_checks,
            external_checks=state.get("external_results", []),
            page_actions=state.get("page_fill_intent", []),
            review_steps=state.get("review_steps", []),
        )
        return {
            "response": assembled,
            "recommendation": assembled.recommendation.value,
            "advice": assembled.agent_advice,
        }

    @staticmethod
    def _build_final_response(state: ReviewState) -> dict[str, Any]:
        """把最终建议写回响应，并按冲突程度计算风险级别。"""
        current_response = state.get("response")
        recommendation = state.get("recommendation")
        advice = state.get("advice")
        cross_checks = state.get("cross_checks")
        if current_response is None:
            raise RuntimeError("工作流状态缺少同字段比对结果")
        if recommendation is None:
            raise RuntimeError("工作流状态缺少审核建议")
        if advice is None:
            raise RuntimeError("工作流状态缺少最终建议详情")
        if cross_checks is None:
            raise RuntimeError("工作流状态缺少跨材料比对结果")
        return {"response": current_response}

    async def run(
        self,
        request: ReviewRequest,
        profile: BusinessProfile | None = None,
        batch_callback: Callable[[AgentBatchResult], Any] | None = None,
    ) -> tuple[ReviewResponse, AgentBatchResult]:
        """执行完整审核图并返回经过类型校验的最终响应。"""

        resolved_profile: BusinessProfile = (
            self.service.resolve_profile(request) if profile is None else profile
        )
        initial_state: ReviewState = {
            "request": request,
            "profile": resolved_profile,
            "batch_callback": batch_callback,
        }
        state = await self.graph.ainvoke(initial_state)
        response = state.get("response")
        batch = state.get("batch")
        if response is None or batch is None:
            raise RuntimeError("工作流未生成完整审核结果")
        return response, batch

