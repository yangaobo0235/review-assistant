"""审核服务编排门面。

主要职责：协调业务配置、工作流和辅助工具，不内嵌响应策略。
修改日期：2026-08-26
修改人：wuyi
"""

import asyncio
import inspect
from collections.abc import Callable, Mapping
from typing import Any
from uuid import uuid4

from app.agent.config import load_qwen_config
from app.agent.models import AgentBatchResult, MaterialCompletenessReport
from app.agent.qwen_client import QwenClient
from app.agent.service import AgentService
from app.agent.workflow import ReviewWorkflow
from app.businesses.context_validation import validate_request_route
from app.businesses.profiles import BusinessProfile
from app.businesses.registry import BusinessRegistry, build_business_registry
from app.capabilities.page_actions import PageActionHandler
from app.models.review import (
    FieldObservation,
    FieldStatus,
    ImageInput,
    PageActionIntent,
    QrCheck,
    ReviewRequest,
    ReviewResponse,
)
from app.rules.capabilities import BusinessRuleHandler, ExternalCheckHandler
from app.rules.evidence_values import batch_observations
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
        external_check_handlers: Mapping[str, ExternalCheckHandler] | None = None,
        business_rule_handlers: Mapping[str, BusinessRuleHandler] | None = None,
        page_action_handlers: Mapping[str, PageActionHandler] | None = None,
    ) -> None:
        self.ocr = ocr or MockOcrTool()
        self.vision = vision or MockVisionTool()
        self.qr = qr or QrCodeService()
        self.qr_web = QrWebVerifier(allowed_hosts=["qclt.mofcom.gov.cn"])
        self.registry = registry or build_business_registry()
        config = load_qwen_config()
        self.agent = AgentService(QwenClient(config)) if config.available else None
        self.workflow = ReviewWorkflow(
            self,
            external_check_handlers=external_check_handlers,
            business_rule_handlers=business_rule_handlers,
            page_action_handlers=page_action_handlers,
        )

    def assist(self, request: ReviewRequest) -> ReviewResponse:
        return asyncio.run(self.assist_async(request))

    async def assist_async(
        self,
        request: ReviewRequest,
        on_progress: ReviewProgressCallback | None = None,
    ) -> ReviewResponse:
        """解析业务配置并执行审核；未配置规则时安全降级。"""

        response, _ = await self.assist_with_batch_async(request, on_progress=on_progress)
        return response

    async def assist_with_batch_async(
        self,
        request: ReviewRequest,
        on_progress: ReviewProgressCallback | None = None,
        initial_batch: AgentBatchResult | None = None,
    ) -> tuple[ReviewResponse, AgentBatchResult]:
        """执行审核并允许复用流式阶段已经完成的图片提取结果。"""

        if not request.trace_id:
            request = request.model_copy(update={"trace_id": uuid4().hex})
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
            batch = initial_batch or AgentBatchResult(total_count=len(request.images))
            response = self._build_unconfigured_response(request, profile)
            if on_progress:
                callback_result = on_progress(response, batch)
                if inspect.isawaitable(callback_result):
                    await callback_result
            return response, batch

        response, batch = await self.workflow.run(
            request,
            profile,
            handle_agent_progress,
            initial_batch=initial_batch,
        )
        if on_progress:
            callback_result = on_progress(response, batch.model_copy(deep=True))
            if inspect.isawaitable(callback_result):
                await callback_result
        return response, batch

    async def _extract_documents(
        self,
        request: ReviewRequest,
        batch_callback: Callable[[AgentBatchResult], Any] | None = None,
        profile: BusinessProfile | None = None,
        initial_report: MaterialCompletenessReport | None = None,
    ) -> AgentBatchResult:
        resolved_profile = profile or self.resolve_profile(request)
        if (
            not request.images
            and resolved_profile.material_policy is None
            and not resolved_profile.required_fields
        ):
            return AgentBatchResult()
        if self.agent:
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
        validate_request_route(request)
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
        business_checks: list | None = None,
        page_fill_intent: list | None = None,
        defer_advice: bool = False,
    ) -> ReviewResponse:
        resolved_profile = profile or self.resolve_profile(request)
        observations = batch_observations(batch)
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

        if not request.images and (
            resolved_profile.material_policy is not None
            or resolved_profile.required_fields
        ):
            issues.append("未采集到审核图片")
        if not request.page_fields and resolved_profile.required_fields:
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

        response = build_review_response(
            request,
            batch,
            resolved_profile,
            observations,
            issues,
            qr_checks,
            business_checks,
            page_fill_intent,
            defer_advice,
        )
        # Page side effects are proposed by the backend protocol. The browser
        # adapter decides whether and how to execute them.
        if any(
            item.field == "invoice.invoice_no" and item.status is FieldStatus.MATCH
            for item in response.comparisons
        ):
            response = response.model_copy(update={
                "page_actions": [
                    *response.page_actions,
                    PageActionIntent(action_id="verify_invoice", payload={"field": "invoice.invoice_no"}),
                ],
            })
        return response

    async def extract_image_async(
        self,
        request: ReviewRequest,
        image: ImageInput,
    ) -> AgentBatchResult:
        """识别流式任务中的一张图片，最终规则汇总阶段不会再次识别。"""

        profile = self.resolve_profile(request)
        image_request = request.model_copy(update={"images": [image]})
        return await self._extract_documents(image_request, profile=profile)

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
        checks: list[QrCheck] = []
        scrap_indices = {
            item.image_index
            for item in batch.observations
            if getattr(item, "document_type", None) == "scrap_certificate"
        }
        scrap_indices.update(
            document.image_index
            for document in batch.recognized_documents
            if document.document_type == "scrap_certificate"
        )
        scrap_ids = {
            document.target_id
            for document in batch.recognized_documents
            if document.document_type == "scrap_certificate"
        }
        scanned_scrap_indices: list[int] = []
        decoded_any = False
        first_undecoded_index: int | None = None
        for image in request.images:
            is_scrap = (
                image.category_hint == "scrap_certificate"
                or image.document_type_hint == "scrap_certificate"
                or image.index in scrap_indices
                or str(image.image_id or image.index) in scrap_ids
            )
            # 分类模型偶尔把回收证明识别为旧车资料。报废置换的二维码只允许
            # 从旧车区域读取，因此在没有可靠回收证明分类时回退扫描旧车图片，
            # 避免“有二维码但未进入核验流程”。
            # 回收证明上的二维码经常在上传时被标成 vehicle_license/unknown，
            # 或者同一批材料只有部分图片被模型分类为 scrap_certificate。
            # 报废置换中所有旧车区域图片都属于受控材料范围，统一尝试解码，
            # 后续仍由官方域名白名单和网页字段完整性决定是否通过。
            # 页面采集器在部分旧页面无法从 DOM 标签推导业务分组，会把
            # business_scope 留为 unknown；已知的旧车材料类型仍然是安全的
            # 二维码扫描候选。官网域名白名单会在后续步骤再次兜底。
            fallback_old_vehicle = image.business_scope == "old_vehicle" or (
                image.business_scope in {"unknown", ""}
                and (
                    image.category_hint in {
                        "old_vehicle",
                        "vehicle_license",
                        "registration_certificate",
                        "scrap_certificate",
                    }
                    or image.document_type_hint
                    in {
                        "old_vehicle",
                        "vehicle_license",
                        "registration_certificate",
                        "scrap_certificate",
                    }
                )
            )
            if image.collection_error or not (is_scrap or fallback_old_vehicle):
                continue
            scanned_scrap_indices.append(image.index)
            # data_url 是扩展端规范化后的首选来源；兼容直接提交 data URL
            # 到 src 的旧客户端，避免只因字段名不同而显示“未识别二维码”。
            image_data = image.data_url or (
                image.src if str(image.src).startswith("data:") else ""
            )
            if hasattr(self.qr, "decode_data_url_with_rounds"):
                decoded, attempts = self.qr.decode_data_url_with_rounds(
                    image_data,
                    image.index,
                    max_rounds=resolved_profile.retry_policy.qr_decode_max_rounds,
                )
                batch.retry_summary.attempts.extend(attempts)
            else:
                decoded = self.qr.decode_data_url(image_data, image.index)
            if not decoded:
                if first_undecoded_index is None:
                    first_undecoded_index = image.index
                continue
            decoded_any = True
            for item in decoded:
                if hasattr(self.qr_web, "verify_with_retry"):
                    verified, attempts = await self.qr_web.verify_with_retry(
                        item.raw_value,
                        image.index,
                        retry_count=resolved_profile.retry_policy.qr_web_retry_count,
                    )
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
        # 旧车区域通常包含行驶证、登记证和回收证明三张图。没有二维码时
        # 只生成一条整体结果，避免同一根因在助手中重复三次；一旦任意一张
        # 图片解码成功，则只保留官网核验结果，不再混入其它图片的“未识别”提示。
        if scanned_scrap_indices and not decoded_any and not checks:
            checks.append(
                QrCheck(
                    image_index=(first_undecoded_index if first_undecoded_index is not None else scanned_scrap_indices[0]),
                    status=FieldStatus.REVIEW_REQUIRED,
                    message="未识别到二维码",
                )
            )
        return checks
