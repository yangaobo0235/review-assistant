"""LangGraph 审核工作流。

主要职责：按确定顺序编排提取、核验、比较和建议生成节点。
修改日期：2026-08-26
修改人：wuyi
"""

from collections.abc import Callable
from itertools import pairwise
from typing import Any, Required, TypedDict

from langgraph.graph import END, START, StateGraph

from app.agent.models import (
    AgentAdvice,
    AgentBatchResult,
    MaterialCompletenessReport,
    ReviewCheck,
)
from app.businesses.profiles import BusinessProfile
from app.models.review import QrCheck, Recommendation, ReviewRequest, ReviewResponse
from app.rules.final_advice import build_final_advice
from app.rules.material_completeness import evaluate_collected, evaluate_extracted

WORKFLOW_NODE_ORDER = (
    "validate_context",
    "assess_collected_materials",
    "extract_documents",
    "assess_extracted_evidence",
    "verify_qr",
    "compare_same_fields",
    "compare_cross_documents",
    "derive_recommendation",
    "build_final_advice",
)


class ReviewState(TypedDict, total=False):
    """工作流节点共享状态；Required 字段由入口保证，其余字段按节点顺序产生。"""

    request: Required[ReviewRequest]
    profile: Required[BusinessProfile]
    batch_callback: Callable[[AgentBatchResult], Any] | None
    batch: AgentBatchResult
    qr_checks: list[QrCheck]
    response: ReviewResponse
    cross_checks: list[ReviewCheck]
    recommendation: str
    advice: AgentAdvice
    material_completeness: MaterialCompletenessReport


class ReviewWorkflow:
    """按固定节点顺序执行提取、核验、比较和最终建议组装。"""

    def __init__(self, service: Any) -> None:
        """构建并编译审核状态图，具体业务能力由服务门面提供。"""
        self.service = service
        builder = StateGraph(ReviewState)
        builder.add_node("validate_context", self._validate_context)
        builder.add_node("assess_collected_materials", self._assess_collected_materials)
        builder.add_node("extract_documents", self._extract_documents)
        builder.add_node("assess_extracted_evidence", self._assess_extracted_evidence)
        builder.add_node("verify_qr", self._verify_qr)
        builder.add_node("compare_same_fields", self._compare_same_fields)
        builder.add_node("compare_cross_documents", self._compare_cross_documents)
        builder.add_node("derive_recommendation", self._derive_recommendation)
        builder.add_node("build_final_advice", self._build_final_advice)
        builder.add_edge(START, WORKFLOW_NODE_ORDER[0])
        for source, target in pairwise(WORKFLOW_NODE_ORDER):
            builder.add_edge(source, target)
        builder.add_edge(WORKFLOW_NODE_ORDER[-1], END)
        self.graph = builder.compile()

    @staticmethod
    def _validate_context(state: ReviewState) -> dict[str, Any]:
        """保留入口已解析的请求和业务配置，建立稳定的初始状态。"""
        return {"request": state["request"], "profile": state["profile"]}

    async def _extract_documents(self, state: ReviewState) -> dict[str, Any]:
        """调用批处理服务提取材料字段，并透传进度回调。"""
        batch = await self.service._extract_documents(
            state["request"], state.get("batch_callback"), state["profile"], state.get("material_completeness")
        )
        return {"batch": batch}

    @staticmethod
    async def _assess_collected_materials(state: ReviewState) -> dict[str, Any]:
        report = evaluate_collected(state["request"], state["profile"])
        callback = state.get("batch_callback")
        if callback is not None:
            callback_result = callback(AgentBatchResult(total_count=len(state["request"].images), material_completeness=report))
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

    async def _verify_qr(self, state: ReviewState) -> dict[str, Any]:
        """基于材料提取结果执行二维码收集与官网核验。"""
        batch = state.get("batch")
        if batch is None:
            raise RuntimeError("工作流状态缺少文档提取结果")
        return {
            "qr_checks": await self.service._collect_qr_checks(
                state["request"],
                batch,
                state["profile"],
            )
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
            include_tools=True,
            qr_checks=qr_checks,
        )
        return {"response": response}

    @staticmethod
    def _compare_cross_documents(state: ReviewState) -> dict[str, Any]:
        """从响应中提取已经由业务规则生成的跨材料检查结果。"""
        response = state.get("response")
        if response is None:
            raise RuntimeError("工作流状态缺少同字段比对结果")
        return {"cross_checks": response.cross_checks}

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
        recommendation, advice = build_final_advice(
            response.comparisons,
            cross_checks,
            qr_checks,
            response.issues,
            batch.limitations,
            batch.confidences,
            completeness=batch.material_completeness,
            qr_required=state["profile"].qr_required,
        )
        return {"recommendation": recommendation, "advice": advice}

    @staticmethod
    def _build_final_advice(state: ReviewState) -> dict[str, Any]:
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
        response = current_response.model_copy(
            update={
                "recommendation": Recommendation(recommendation),
                "risk_level": (
                    "LOW"
                    if recommendation == "PASS"
                    else "HIGH"
                    if any(item.status == "CONFLICT" for item in advice.findings)
                    else "MEDIUM"
                ),
                "summary": advice.summary,
                "cross_checks": cross_checks,
                "agent_advice": advice,
            }
        )
        return {"response": response}

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
