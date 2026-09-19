"""审核 Agent HTTP API 入口。

主要职责：创建应用并暴露健康检查、同步审核和异步任务接口。
修改日期：2026-08-26
修改人：wuyi
"""

import asyncio
import base64
import logging
import os
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, status

from app.businesses.context_validation import BusinessContextMismatch
from app.businesses.packs import build_collect_manifest, pack_for_business
from app.businesses.registry import BusinessProfileNotFound
from app.contracts.review_schema import review_contract_schema
from app.models.review import (
    BusinessType,
    ImageInput,
    ReviewJobCreated,
    ReviewJobSnapshot,
    ReviewRequest,
    ReviewResponse,
)
from app.services.jobs import ReviewJobManager
from app.services.review import ReviewService

app = FastAPI(title="车辆审核辅助 Agent")
review_service = ReviewService()
review_jobs = ReviewJobManager(review_service)
# 使用 Uvicorn 已配置的 logger，确保 INFO 日志直接显示在启动终端。
logger = logging.getLogger("uvicorn.error")
MAX_STREAM_IMAGE_BYTES = 5 * 1024 * 1024
UPLOAD_GLOBAL_LIMIT = max(1, int(os.getenv("REVIEW_UPLOAD_GLOBAL_CONCURRENCY", "8")))
upload_slots = asyncio.Semaphore(UPLOAD_GLOBAL_LIMIT)


def validate_business_profile(request: ReviewRequest) -> None:
    try:
        review_service.resolve_profile(request)
    except BusinessContextMismatch as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except BusinessProfileNotFound as exc:
        raise HTTPException(
            status_code=422,
            detail="审核业务配置不存在或版本不兼容",
        ) from exc


@app.get("/health")
def health() -> dict[str, str]:
    """供扩展和部署探针检查 Agent 是否已启动。"""
    return {"status": "ok"}


@app.get("/api/review/schema")
def review_schema() -> dict[str, object]:
    """Expose the versioned request/response contract to integration clients."""
    return review_contract_schema()


@app.get("/api/review/collect-manifest")
def collect_manifest(business_type: BusinessType) -> dict[str, object]:
    """下发页面采集清单：字段别名、图片分组标题和材料分组关键词。

    采集清单只随业务类型变化（同一业务的各地区共用），因此不需要地区参数。
    前端据此完成字段匹配和图片归组；尚未声明清单的业务返回 404，前端退回内置表。
    """
    pack = pack_for_business(business_type)
    if pack is None:
        raise HTTPException(status_code=404, detail="该业务尚未声明采集清单")
    return build_collect_manifest(pack)


@app.post("/api/review/assist", response_model=ReviewResponse)
def assist(request: ReviewRequest) -> ReviewResponse:
    """执行一次只读审核辅助，不会修改原审核系统。"""
    validate_business_profile(request)
    logger.info(
        "Review request received: trace_id=%s application_id=%s field_count=%d image_count=%d",
        request.trace_id or "generated",
        request.application_id or "unknown",
        len(request.page_fields),
        len(request.images),
    )
    response = review_service.assist(request)
    logger.info(
        "Review completed: trace_id=%s recommendation=%s comparison_count=%d issue_count=%d",
        response.trace_id,
        response.recommendation,
        len(response.comparisons),
        len(response.issues),
    )
    return response


@app.post(
    "/api/review/jobs",
    response_model=ReviewJobCreated,
    status_code=status.HTTP_202_ACCEPTED,
)
def create_review_job(request: ReviewRequest) -> ReviewJobCreated:
    validate_business_profile(request)
    logger.info(
        "Review job requested: trace_id=%s application_id=%s image_count=%d",
        request.trace_id or "generated",
        request.application_id or "unknown",
        len(request.images),
    )
    try:
        created = review_jobs.create(request)
    except ValueError as exc:
        # 与 /jobs/stream 保持一致：请求本身不合法返回 422，不要冒成 500。
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    logger.info("Review job created: job_id=%s", created.job_id)
    return created


@app.post(
    "/api/review/jobs/stream",
    response_model=ReviewJobCreated,
    status_code=status.HTTP_202_ACCEPTED,
)
def create_stream_review_job(request: ReviewRequest) -> ReviewJobCreated:
    """先创建任务；图片由后续接口逐张上传并立即识别。"""

    validate_business_profile(request)
    try:
        created = review_jobs.create_stream(request)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    logger.info(
        "Stream review job created: job_id=%s expected_images=%d",
        created.job_id,
        len(request.images),
    )
    return created


@app.post(
    "/api/review/jobs/{job_id}/images",
    response_model=ReviewJobSnapshot,
    status_code=status.HTTP_202_ACCEPTED,
)
async def upload_stream_review_image(
    job_id: str,
    metadata: Annotated[str, Form()],
    file: Annotated[UploadFile | None, File()] = None,
) -> ReviewJobSnapshot:
    """接收一张规范化图片；无文件时 metadata 必须携带采集错误。"""

    await upload_slots.acquire()
    try:
        try:
            image = ImageInput.model_validate_json(metadata)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="图片元数据格式无效") from exc
        if file is not None:
            content = await file.read(MAX_STREAM_IMAGE_BYTES + 1)
            if len(content) > MAX_STREAM_IMAGE_BYTES:
                raise HTTPException(status_code=413, detail="单张图片不能超过 5 MB")
            mime_type = file.content_type or image.mime_type or "image/jpeg"
            image = image.model_copy(update={
                "mime_type": mime_type,
                "size_bytes": len(content),
                "data_url": f"data:{mime_type};base64,{base64.b64encode(content).decode('ascii')}",
                "collection_error": None,
            })
        elif not image.collection_error:
            raise HTTPException(status_code=422, detail="图片文件缺失且没有采集错误")
        try:
            return review_jobs.add_stream_image(job_id, image)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="审核任务不存在或已过期") from exc
        except (RuntimeError, ValueError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    finally:
        upload_slots.release()


@app.post(
    "/api/review/jobs/{job_id}/complete",
    response_model=ReviewJobSnapshot,
)
def complete_stream_review_upload(job_id: str) -> ReviewJobSnapshot:
    try:
        return review_jobs.complete_stream(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="审核任务不存在或已过期") from exc


@app.delete(
    "/api/review/jobs/{job_id}",
    response_model=ReviewJobSnapshot,
)
def cancel_review_job(job_id: str) -> ReviewJobSnapshot:
    try:
        return review_jobs.cancel(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="审核任务不存在或已过期") from exc


@app.get("/api/review/jobs/{job_id}", response_model=ReviewJobSnapshot)
def get_review_job(job_id: str) -> ReviewJobSnapshot:
    try:
        return review_jobs.get(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="审核任务不存在或已过期") from exc
