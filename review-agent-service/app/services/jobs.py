"""本地异步审核任务管理。

主要职责：管理任务生命周期、进度快照、部分结果和过期清理。
修改日期：2026-08-26
修改人：wuyi
"""

import asyncio
import logging
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from app.agent.models import AgentBatchResult
from app.models.review import (
    JobStatus,
    ReviewGroupProgress,
    ReviewJobCreated,
    ReviewJobSnapshot,
    ReviewProgress,
    ReviewRequest,
    ReviewResponse,
)

JOB_TTL_SECONDS = 600.0
OLD_SCOPES = {"old_vehicle"}
NEW_SCOPES = {"new_vehicle"}
logger = logging.getLogger("uvicorn.error")


@dataclass
class _StoredJob:
    request: ReviewRequest
    snapshot: ReviewJobSnapshot
    done: threading.Event
    updated_at: float


class ReviewJobManager:
    """Run local review jobs outside request lifetimes and expose snapshots."""

    def __init__(self, review_service: Any, ttl_seconds: float = JOB_TTL_SECONDS) -> None:
        self.review_service = review_service
        self.ttl_seconds = ttl_seconds
        self._jobs: dict[str, _StoredJob] = {}
        self._lock = threading.Lock()

    def create(self, request: ReviewRequest) -> ReviewJobCreated:
        self._cleanup()
        job_id = str(uuid.uuid4())
        created_at = datetime.now().astimezone().isoformat()
        groups = {
            "old_vehicle": ReviewGroupProgress(
                total_count=sum(image.business_scope in OLD_SCOPES for image in request.images)
            ),
            "new_vehicle": ReviewGroupProgress(
                total_count=sum(image.business_scope in NEW_SCOPES for image in request.images)
            ),
        }
        snapshot = ReviewJobSnapshot(
            job_id=job_id,
            status=JobStatus.RUNNING,
            created_at=created_at,
            progress=ReviewProgress(total_count=len(request.images)),
            groups=groups,
        )
        stored = _StoredJob(request, snapshot, threading.Event(), time.monotonic())
        with self._lock:
            self._jobs[job_id] = stored
        thread = threading.Thread(target=self._run, args=(job_id,), daemon=True)
        thread.start()
        return ReviewJobCreated(job_id=job_id, created_at=created_at)

    def get(self, job_id: str) -> ReviewJobSnapshot:
        self._cleanup()
        with self._lock:
            stored = self._jobs.get(job_id)
            if stored is None:
                raise KeyError(job_id)
            return stored.snapshot.model_copy(deep=True)

    def wait(self, job_id: str, timeout: float | None = None) -> bool:
        with self._lock:
            stored = self._jobs.get(job_id)
        return bool(stored and stored.done.wait(timeout))

    def _run(self, job_id: str) -> None:
        asyncio.run(self._run_async(job_id))

    async def _run_async(self, job_id: str) -> None:
        with self._lock:
            stored = self._jobs[job_id]
        latest_batch = AgentBatchResult(total_count=len(stored.request.images))

        async def update(response: ReviewResponse, batch: AgentBatchResult) -> None:
            nonlocal latest_batch
            latest_batch = batch.model_copy(deep=True)
            self._update_snapshot(stored, response, batch, final=False)

        try:
            response = await self.review_service.assist_async(stored.request, update)
            self._update_snapshot(stored, response, latest_batch, final=True)
        except Exception as exc:
            logger.exception(
                "Review job failed: job_id=%s error_type=%s",
                job_id,
                type(exc).__name__,
            )
            with self._lock:
                stored.snapshot.status = JobStatus.FAILED
                stored.snapshot.message = f"审核任务失败：{type(exc).__name__}"
                stored.updated_at = time.monotonic()
        finally:
            logger.info(
                "Review job finished: job_id=%s status=%s completed=%d failed=%d timed_out=%d",
                job_id,
                stored.snapshot.status,
                stored.snapshot.progress.completed_count,
                stored.snapshot.progress.failed_count,
                stored.snapshot.progress.timed_out_count,
            )
            stored.done.set()

    def _update_snapshot(
        self,
        stored: _StoredJob,
        response: ReviewResponse,
        batch: AgentBatchResult,
        *,
        final: bool,
    ) -> None:
        progress = ReviewProgress(
            total_count=batch.total_count,
            completed_count=batch.completed_count,
            failed_count=batch.failed_count,
            timed_out_count=batch.timed_out_count,
        )
        completed_ids = set(batch.completed_image_ids)
        failed_ids = set(batch.failed_image_ids)
        timed_out_ids = set(batch.timed_out_image_ids)
        groups = {
            "old_vehicle": self._group_progress(
                stored.request,
                OLD_SCOPES,
                completed_ids,
                failed_ids,
                timed_out_ids,
                final=final,
            ),
            "new_vehicle": self._group_progress(
                stored.request,
                NEW_SCOPES,
                completed_ids,
                failed_ids,
                timed_out_ids,
                final=final,
            ),
        }
        processed_count = (
            progress.completed_count + progress.failed_count + progress.timed_out_count
        )
        if final:
            status = (
                JobStatus.PARTIAL
                if processed_count < progress.total_count
                or progress.failed_count
                or progress.timed_out_count
                else JobStatus.COMPLETED
            )
        else:
            status = JobStatus.RUNNING
        with self._lock:
            stored.snapshot.status = status
            stored.snapshot.progress = progress
            stored.snapshot.groups = groups
            stored.snapshot.result = response
            stored.snapshot.material_completeness = response.material_completeness
            stored.snapshot.retry_summary = response.retry_summary
            stored.updated_at = time.monotonic()

    @staticmethod
    def _group_progress(
        request: ReviewRequest,
        scopes: set[str],
        completed_ids: set[str],
        failed_ids: set[str],
        timed_out_ids: set[str],
        *,
        final: bool,
    ) -> ReviewGroupProgress:
        ids = {
            str(image.image_id or image.index)
            for image in request.images
            if image.business_scope in scopes
        }
        completed = len(ids & completed_ids)
        failed = len(ids & failed_ids)
        timed_out = len(ids & timed_out_ids)
        processed = completed + failed + timed_out
        if not ids or processed == len(ids):
            status = JobStatus.PARTIAL if failed or timed_out else JobStatus.COMPLETED
        elif final or processed:
            status = JobStatus.PARTIAL
        else:
            status = JobStatus.RUNNING
        return ReviewGroupProgress(
            status=status,
            total_count=len(ids),
            completed_count=completed,
            failed_count=failed,
            timed_out_count=timed_out,
        )

    def _cleanup(self) -> None:
        cutoff = time.monotonic() - self.ttl_seconds
        with self._lock:
            expired = [key for key, value in self._jobs.items() if value.updated_at < cutoff]
            for key in expired:
                del self._jobs[key]
