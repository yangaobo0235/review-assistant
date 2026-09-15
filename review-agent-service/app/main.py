"""审核 Agent HTTP API 入口。

主要职责：创建应用并暴露健康检查、同步审核和异步任务接口。
修改日期：2026-08-26
修改人：wuyi
"""

import logging

from fastapi import FastAPI, HTTPException, status

from app.businesses.context_validation import BusinessContextMismatch
from app.businesses.registry import BusinessProfileNotFound
from app.contracts.review_schema import review_contract_schema
from app.models.review import (
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
    created = review_jobs.create(request)
    logger.info("Review job created: job_id=%s", created.job_id)
    return created


@app.get("/api/review/jobs/{job_id}", response_model=ReviewJobSnapshot)
def get_review_job(job_id: str) -> ReviewJobSnapshot:
    try:
        return review_jobs.get(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="审核任务不存在或已过期") from exc
