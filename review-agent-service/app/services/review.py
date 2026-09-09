"""审核服务编排门面。

主要职责：协调业务配置、工作流和辅助工具，不内嵌响应策略。
修改日期：2026-08-26
修改人：wuyi
"""

import asyncio
import inspect
from collections.abc import Callable
from typing import Any

from app.agent.config import load_qwen_config
from app.agent.models import AgentBatchResult, MaterialCompletenessReport
from app.agent.qwen_client import QwenClient
from app.agent.service import AgentService
from app.agent.workflow import ReviewWorkflow
from app.businesses.profiles import BusinessProfile
from app.businesses.registry import BusinessRegistry, build_business_registry
from app.models.review import (
    FieldObservation,
    FieldStatus,
    QrCheck,
    ReviewRequest,
    ReviewResponse,
)
from app.services.qr import QrCodeService, QrWebVerifier
from app.services.review_response import (
    build_review_response,
    build_unconfigured_response,
)
from app.services.tools import MockOcrTool, MockVisionTool

ReviewProgressCallback = Callable[[ReviewResponse, AgentBatchResult], Any]


class ReviewService:
    """Coordinate document extraction, verification tools, and response building."""

    def __init__(
        self,
        ocr: object | None = None,
        vision: object | None = None,
        qr: object | None = None,
        registry: BusinessRegistry | None = None,
    ) -> None:
        self.ocr = ocr or MockOcrTool()
        self.vision = vision or MockVisionTool()
        self.qr = qr or QrCodeService()
        self.qr_web = QrWebVerifier(allowed_hosts=["qclt.mofcom.gov.cn"])
        self.registry = registry or build_business_registry()
        config = load_qwen_config()
        self.agent = AgentService(QwenClient(config)) if config.available else None
        self.workflow = ReviewWorkflow(self)

    def assist(self, request: ReviewRequest) -> ReviewResponse:
        return asyncio.run(self.assist_async(request))

    async def assist_async(
        self,
        request: ReviewRequest,
        on_progress: ReviewProgressCallback | None = None,
    ) -> ReviewResponse:
        """解析业务配置并执行审核；未配置规则时安全降级。"""

        profile = self.resolve_profile(request)

        async def handle_agent_progress(batch: AgentBatchResult) -> None:
            if on_progress is None:
                return
            progress_response = self._build_response(
                request,
                batch,
                profile,
                include_tools=False,
            )
            callback_result = on_progress(progress_response, batch)
            if inspect.isawaitable(callback_result):
                await callback_result

        if not profile.rules_configured:
            batch = AgentBatchResult(total_count=len(request.images))
            response = self._build_unconfigured_response(request, profile)
            if on_progress:
                callback_result = on_progress(response, batch)
                if inspect.isawaitable(callback_result):
                    await callback_result
            return response

        response, batch = await self.workflow.run(
            request,
            profile,
            handle_agent_progress,
        )
        if on_progress:
            callback_result = on_progress(response, batch.model_copy(deep=True))
            if inspect.isawaitable(callback_result):
                await callback_result
        return response

    async def _extract_documents(
        self,
        request: ReviewRequest,
        batch_callback: Callable[[AgentBatchResult], Any] | None = None,
        profile: BusinessProfile | None = None,
        initial_report: MaterialCompletenessReport | None = None,
    ) -> AgentBatchResult:
        if self.agent:
            resolved_profile = profile or self.resolve_profile(request)
            return await self.agent.extract_async(
                request.images,
                batch_callback,
                retry_policy=resolved_profile.retry_policy,
                initial_report=initial_report,
            )

        unavailable_image_ids = [
            str(image.image_id or image.index)
            for image in request.images
            if image.collection_error or not image.data_url
        ]
        return AgentBatchResult(
            total_count=len(request.images),
            failed_count=len(unavailable_image_ids),
            failed_image_ids=unavailable_image_ids,
            limitations=["DashScope Agent 未配置：缺少 DASHSCOPE_API_KEY"],
        )

    def resolve_profile(self, request: ReviewRequest) -> BusinessProfile:
        return self.registry.resolve(
            request.business_type,
            request.region,
            request.profile_version,
        )

    def _build_response(
        self,
        request: ReviewRequest,
        batch: AgentBatchResult,
        profile: BusinessProfile | None = None,
        *,
        include_tools: bool,
        qr_checks: list[QrCheck] | None = None,
    ) -> ReviewResponse:
        resolved_profile = profile or self.resolve_profile(request)
        observations = list(batch.observations)
        issues: list[str] = []

        for field_name in resolved_profile.required_fields:
            page_value = request.page_fields.get(field_name)
            if page_value not in (None, ""):
                observations.append(
                    FieldObservation(
                        field=field_name,
                        source_type="page",
                        source_id="review_page",
                        value=page_value,
                    )
                )

        if not request.images:
            issues.append("未采集到审核图片")
        if not request.page_fields:
            issues.append("未采集到右侧申请字段")

        for image in request.images:
            if image.collection_error:
                image_name = image.image_id or image.index
                issues.append(f"图片 {image_name} 采集失败：{image.collection_error}")
                continue
            if not include_tools:
                continue
            try:
                ocr_result = self.ocr.recognize(image.model_dump())
                self.vision.inspect(image.model_dump(), image.group)
            except (OSError, RuntimeError, TypeError, ValueError) as exc:
                issues.append(f"图片 {image.index} 识别失败：{type(exc).__name__}")
                continue
            for field_name, value in ocr_result.fields.items():
                if (
                    field_name in resolved_profile.required_fields
                    or field_name == "scrap_certificate.certificate_no"
                ) and value:
                    observations.append(
                        FieldObservation(
                            field=field_name,
                            source_type="image",
                            source_id=f"ocr-{image.image_id or image.index}",
                            image_index=image.index,
                            value=value,
                            confidence=ocr_result.confidence,
                        )
                    )

        return build_review_response(
            request,
            batch,
            resolved_profile,
            observations,
            issues,
            qr_checks,
        )

    @staticmethod
    def _build_unconfigured_response(
        request: ReviewRequest,
        profile: BusinessProfile,
    ) -> ReviewResponse:
        return build_unconfigured_response(request, profile)

    async def _collect_qr_checks(
        self,
        request: ReviewRequest,
        batch: AgentBatchResult,
        profile: BusinessProfile | None = None,
    ) -> list[QrCheck]:
        resolved_profile = profile or self.resolve_profile(request)
        if not resolved_profile.qr_required:
            return []

        checks: list[QrCheck] = []
        scrap_indices = {
            item.image_index
            for item in batch.observations
            if getattr(item, "document_type", None) == "scrap_certificate"
        }
        for image in request.images:
            if image.collection_error or (
                image.category_hint != "scrap_certificate"
                and image.index not in scrap_indices
            ):
                continue
            if hasattr(self.qr, "decode_data_url_with_rounds"):
                decoded, attempts = self.qr.decode_data_url_with_rounds(
                    image.data_url or "", image.index,
                    max_rounds=resolved_profile.retry_policy.qr_decode_max_rounds,
                )
                batch.retry_summary.attempts.extend(attempts)
            else:
                decoded = self.qr.decode_data_url(image.data_url or "", image.index)
            if not decoded:
                checks.append(
                    QrCheck(
                        image_index=image.index,
                        status=FieldStatus.REVIEW_REQUIRED,
                        message="未识别到二维码",
                    )
                )
                continue
            for item in decoded:
                if hasattr(self.qr_web, "verify_with_retry"):
                    verified, attempts = await self.qr_web.verify_with_retry(item.raw_value, image.index, retry_count=resolved_profile.retry_policy.qr_web_retry_count)
                    batch.retry_summary.attempts.extend(attempts)
                else:
                    verified = await self.qr_web.verify(item.raw_value, image.index)
                status = (
                    FieldStatus.MATCH
                    if verified.status == "MATCH"
                    else FieldStatus.REVIEW_REQUIRED
                )
                checks.append(
                    QrCheck(
                        image_index=image.index,
                        raw_value=item.raw_value,
                        url=verified.url,
                        domain_valid=verified.domain_valid,
                        accessible=verified.accessible,
                        page_fields=verified.page_fields,
                        status=status,
                        message=(
                            "二维码网页字段已提取"
                            if verified.page_fields
                            else "二维码网页无法完成核验"
                        ),
                    )
                )
        return checks
