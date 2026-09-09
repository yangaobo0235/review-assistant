"""文档提取批处理服务。

主要职责：管理并发、超时、失败分类和渐进式提取结果。
修改日期：2026-08-26
修改人：wuyi
"""

import asyncio
import inspect
import logging
from collections.abc import Callable
from typing import Any

from app.agent.document_policies import DOCUMENT_POLICIES, DocumentPolicy
from app.agent.errors import classify_qwen_error, describe_qwen_error
from app.agent.field_routing import normalize_document_type, route_fields
from app.agent.models import (
    AgentAdvice,
    AgentBatchResult,
    MaterialCompletenessReport,
    QwenExtraction,
    RecognizedDocument,
    RetryAttempt,
)
from app.agent.qwen_client import QwenClient
from app.agent.retry import retry_reason_for_error, retry_reason_for_extraction
from app.businesses.material_policies import DEFAULT_RETRY_POLICY, RetryPolicy
from app.models.review import FieldObservation

MAX_CONCURRENT_IMAGES = 6
IMAGE_TIMEOUT_SECONDS = 50.0
REVIEW_DEADLINE_SECONDS = 55.0
CLASSIFICATION_CONFIDENCE_THRESHOLD = 0.70
logger = logging.getLogger("uvicorn.error")

ProgressCallback = Callable[[AgentBatchResult], Any]


class AgentService:
    """并发提取图片审核字段，同时确保确定性规则保留在模型之外。"""

    def __init__(
        self,
        client: QwenClient,
        *,
        max_concurrency: int = MAX_CONCURRENT_IMAGES,
        image_timeout: float = IMAGE_TIMEOUT_SECONDS,
        review_deadline: float = REVIEW_DEADLINE_SECONDS,
    ) -> None:
        """配置模型客户端、单图并发上限以及单图和整单截止时间。"""
        self.client = client
        self.max_concurrency = max_concurrency
        self.image_timeout = image_timeout
        self.review_deadline = review_deadline

    def extract(
        self, images: list[Any]
    ) -> tuple[dict[str, tuple[str, int]], list[str], list[float]]:
        """兼容原同步接口，返回首次识别值、限制说明和置信度。"""
        batch = asyncio.run(self.extract_async(images))
        recognized: dict[str, tuple[str, int]] = {}
        for item in batch.observations:
            if item.image_index is not None and item.value:
                recognized.setdefault(item.field, (str(item.value), item.image_index))
        return recognized, batch.limitations, batch.confidences

    async def extract_async(
        self,
        images: list[Any],
        on_progress: ProgressCallback | None = None,
        retry_policy: RetryPolicy = DEFAULT_RETRY_POLICY,
        absolute_deadline: float | None = None,
        initial_report: MaterialCompletenessReport | None = None,
    ) -> AgentBatchResult:
        """并发处理一批图片，在单图或整单超时时保留已经完成的部分结果。"""
        result = AgentBatchResult(total_count=len(images), material_completeness=initial_report)
        semaphore = asyncio.Semaphore(self.max_concurrency)
        loop = asyncio.get_running_loop()
        deadline = absolute_deadline or loop.time() + self.review_deadline

        async def run_one(image: Any) -> None:
            """处理单张图片，并在每个终态向调用方发送进度快照。"""
            image_name = image.image_id or image.index
            if image.category_hint == "id_card":
                result.limitations.append("身份证资料按策略跳过")
                result.completed_count += 1
                result.completed_image_ids.append(str(image_name))
                logger.info("Agent image skipped: image=%s type=id_card", image_name)
                await self._notify(on_progress, result)
                return
            if image.business_scope == "other":
                result.limitations.append(
                    f"图片 {image_name} 不属于车辆审核资料，已跳过"
                )
                result.completed_count += 1
                result.completed_image_ids.append(str(image_name))
                await self._notify(on_progress, result)
                return
            if image.collection_error or not image.data_url:
                result.failed_count += 1
                result.failed_image_ids.append(str(image_name))
                result.limitations.append(f"图片 {image_name} 内容不可用")
                await self._notify(on_progress, result)
                return
            try:
                async with semaphore:
                    first_error: RuntimeError | None = None
                    try:
                        extraction, policy = await asyncio.wait_for(
                            self._extract_image(image),
                            timeout=min(self.image_timeout, max(0.001, deadline - loop.time())),
                        )
                        reason = retry_reason_for_extraction(extraction, policy)
                    except RuntimeError as exc:
                        first_error = exc
                        reason = retry_reason_for_error(exc)
                        extraction = policy = None
                    if first_error is not None and reason is None:
                        raise first_error
                    if reason and retry_policy.semantic_retry_count > 0:
                        remaining = deadline - loop.time()
                        if remaining < retry_policy.minimum_retry_window_seconds:
                            result.retry_summary.attempts.append(RetryAttempt(
                                target_id=str(image_name), stage="qwen", attempt_number=2,
                                reason_code=reason, strategy="focused_extraction", result="skipped", duration_ms=0,
                            ))
                            result.limitations.append(f"图片 {image_name} 满足重试条件但剩余时间不足")
                            if first_error is not None:
                                raise first_error
                        else:
                            started = loop.time()
                            try:
                                extraction, policy = await asyncio.wait_for(
                                    self._extract_image(image, retry_reason=reason),
                                    timeout=min(self.image_timeout, remaining),
                                )
                            except (RuntimeError, TimeoutError):
                                result.retry_summary.attempts.append(RetryAttempt(
                                    target_id=str(image_name), stage="qwen", attempt_number=2,
                                    reason_code=reason, strategy="focused_extraction", result="failed",
                                    duration_ms=max(0, int((loop.time() - started) * 1000)),
                                ))
                                raise
                            result.retry_summary.attempts.append(RetryAttempt(
                                target_id=str(image_name), stage="qwen", attempt_number=2,
                                reason_code=reason, strategy="focused_extraction", result="succeeded",
                                duration_ms=max(0, int((loop.time() - started) * 1000)),
                            ))
            except TimeoutError:
                result.timed_out_count += 1
                result.timed_out_image_ids.append(str(image_name))
                result.limitations.append(f"图片 {image_name} Qwen 识别超时")
                logger.warning("Agent image timed out: image=%s", image_name)
                await self._notify(on_progress, result)
                return
            except RuntimeError as exc:
                error_code = classify_qwen_error(exc)
                result.failed_count += 1
                result.failed_image_ids.append(str(image_name))
                result.limitations.append(f"图片 {image_name} Qwen 处理失败（{error_code}）")
                logger.warning("Agent image failed: image=%s error_type=%s error_code=%s error_detail=%s", image_name, type(exc).__name__, error_code, describe_qwen_error(exc) or "none")
                await self._notify(on_progress, result)
                return

            if (
                policy is None
                or normalize_document_type(extraction.document_type)
                != policy.document_type
            ):
                result.failed_count += 1
                result.failed_image_ids.append(str(image_name))
                result.limitations.append(
                    f"图片 {image_name} 资料类型不一致，请人工复核"
                )
                await self._notify(on_progress, result)
                return

            result.recognized_documents.append(RecognizedDocument(
                target_id=str(image_name), image_index=image.index,
                document_type=policy.document_type, business_scope=image.business_scope,
                covered_pages=list(extraction.fields.get("registration.covered_pages", []))
                if isinstance(extraction.fields.get("registration.covered_pages", []), list) else [],
                uncertain_fields=list(extraction.uncertain_fields),
            ))

            routed_fields, routing_limitation = route_fields(
                image.business_scope,
                policy.document_type,
                extraction.fields,
            )
            if routing_limitation:
                result.limitations.append(f"图片 {image_name}：{routing_limitation}")
            accepted = 0
            for field_name, value in routed_fields.items():
                if value:
                    result.observations.append(
                        FieldObservation(
                            field=field_name,
                            source_type="image",
                            source_id=str(image_name),
                            document_type=policy.document_type,
                            image_index=image.index,
                            image_id=str(image_name),
                            business_scope=image.business_scope,
                            group_title=image.group_title,
                            group_order=image.group_order,
                            value=value,
                            confidence=extraction.confidence,
                        )
                    )
                    accepted += 1
            if image.business_scope == "transfer" and extraction.uncertain_fields:
                result.observations.append(
                    FieldObservation(
                        field="transfer.uncertain_fields",
                        source_type="image",
                        source_id=str(image_name),
                        document_type=policy.document_type,
                        image_index=image.index,
                        image_id=str(image_name),
                        business_scope=image.business_scope,
                        group_title=image.group_title,
                        group_order=image.group_order,
                        value=extraction.uncertain_fields,
                        confidence=extraction.confidence,
                    )
                )
            if extraction.confidence is not None:
                result.confidences.append(extraction.confidence)
            result.completed_count += 1
            result.completed_image_ids.append(str(image_name))
            logger.info(
                "Agent image completed: image=%s type=%s accepted_field_count=%d",
                image_name,
                policy.document_type,
                accepted,
            )
            await self._notify(on_progress, result)

        tasks = {asyncio.create_task(run_one(image)): image for image in images}
        if not tasks:
            return result
        _, pending = await asyncio.wait(tasks, timeout=max(0, deadline - loop.time()))
        # 整单截止后取消剩余任务，但不丢弃截止前已经生成的观察结果。
        for task in pending:
            task.cancel()
            image = tasks[task]
            image_name = image.image_id or image.index
            result.timed_out_count += 1
            result.timed_out_image_ids.append(str(image_name))
            result.limitations.append(f"图片 {image_name} 超过整单审核时限")
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
            await self._notify(on_progress, result)
        return result

    async def _extract_image(
        self,
        image: Any,
        *,
        retry_reason: str | None = None,
    ) -> tuple[QwenExtraction, DocumentPolicy | None]:
        """选择合并或分阶段识别路径，并返回与实际材料类型匹配的策略。"""
        # 页面分组只是启发式提示，可能把相邻的新车/发票图片误标成旧车资料。
        # 支持合并分类提取的客户端以模型实际 document_type 作为字段路由依据，
        # 同时保持每张图片只有一次模型调用。
        if hasattr(self.client, "extract_unknown"):
            extract_unknown = self.client.extract_unknown
            extraction = await extract_unknown(
                image.model_dump(),
                **self._retry_kwargs(extract_unknown, retry_reason),
            )
            normalized_type = normalize_document_type(extraction.document_type)
            normalized = extraction.model_copy(
                update={"document_type": normalized_type}
            )
            return normalized, DOCUMENT_POLICIES.get(normalized_type)

        hinted_type = (
            image.document_type_hint
            if image.document_type_hint != "unknown"
            else image.category_hint
        )
        category = normalize_document_type(hinted_type or "unknown")
        policy = DOCUMENT_POLICIES.get(category)
        if policy is not None:
            extract_fields = self.client.extract_fields
            extraction = await extract_fields(
                image.model_dump(),
                policy,
                **self._retry_kwargs(extract_fields, retry_reason),
            )
            return extraction, policy

        classification = await self.client.classify_document(image.model_dump())
        classified_type = normalize_document_type(classification.document_type)
        if (
            classified_type not in DOCUMENT_POLICIES
            or classification.confidence < CLASSIFICATION_CONFIDENCE_THRESHOLD
        ):
            raise RuntimeError("资料类型无法可靠识别")
        policy = DOCUMENT_POLICIES[classified_type]
        extract_fields = self.client.extract_fields
        extraction = await extract_fields(
            image.model_dump(),
            policy,
            **self._retry_kwargs(extract_fields, retry_reason),
        )
        normalized = extraction.model_copy(
            update={"document_type": normalize_document_type(extraction.document_type)}
        )
        return normalized, policy

    @staticmethod
    def _retry_kwargs(method: Callable[..., Any], retry_reason: str | None) -> dict[str, str]:
        """仅向支持新契约的客户端传递纠错原因，兼容现有受控测试客户端。"""
        if retry_reason is None:
            return {}
        parameters = inspect.signature(method).parameters.values()
        if any(
            parameter.name == "retry_reason"
            or parameter.kind is inspect.Parameter.VAR_KEYWORD
            for parameter in parameters
        ):
            return {"retry_reason": retry_reason}
        return {}

    @staticmethod
    async def _notify(
        callback: ProgressCallback | None,
        result: AgentBatchResult,
    ) -> None:
        """向同步或异步回调发送隔离的结果快照。"""
        if callback is None:
            return
        callback_result = callback(result.model_copy(deep=True))
        if inspect.isawaitable(callback_result):
            await callback_result


def build_agent_advice(
    recommendation: str,
    comparison_count: int,
    limitations: list[str],
    confidences: list[float],
) -> AgentAdvice:
    """根据确定性推荐、覆盖范围和模型置信度生成兼容版 Agent 建议。"""
    titles = {
        "PASS": "未发现明确冲突",
        "REJECT_SUGGESTED": "发现字段冲突",
        "REVIEW_REQUIRED": "建议人工复核",
    }
    summary = f"已完成 {comparison_count} 个必检字段的规则比对。"
    if limitations:
        summary += "部分图片或模型能力不可用，结果不完整。"
    confidence = sum(confidences) / len(confidences) if confidences else None
    return AgentAdvice(
        title=titles[recommendation],
        summary=summary,
        confidence=confidence,
        basis=["Qwen 图片识别", "确定性字段规则"],
        limitations=list(dict.fromkeys(limitations)),
    )
