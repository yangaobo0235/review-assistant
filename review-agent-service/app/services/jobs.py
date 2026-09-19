"""本地异步审核任务管理。

主要职责：管理任务生命周期、进度快照、部分结果和过期清理。
修改日期：2026-08-26
修改人：wuyi
"""

import asyncio
import logging
import os
import threading
import time
import uuid
from concurrent.futures import CancelledError, Future
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from app.models.review import (
    ImageInput,
    JobStatus,
    ReviewGroupProgress,
    ReviewJobCreated,
    ReviewJobPhase,
    ReviewJobSnapshot,
    ReviewProgress,
    ReviewRequest,
    ReviewResponse,
)
from app.services.fair_scheduler import FairAsyncScheduler
from app.workflow.models import AgentBatchResult

JOB_TTL_SECONDS = 600.0
MAX_STREAM_IMAGES = 16
OLD_SCOPES = {"old_vehicle"}
NEW_SCOPES = {"new_vehicle"}
logger = logging.getLogger("uvicorn.error")


@dataclass
class _StoredJob:
    request: ReviewRequest
    snapshot: ReviewJobSnapshot
    done: threading.Event
    updated_at: float
    streaming: bool = False
    batch: AgentBatchResult = field(default_factory=AgentBatchResult)
    received_ids: set[str] = field(default_factory=set)
    pending_count: int = 0
    upload_complete: bool = False
    finalize_started: bool = False
    cancelled: bool = False


class ReviewJobManager:
    """Run local review jobs outside request lifetimes and expose snapshots."""

    def __init__(
        self,
        review_service: Any,
        ttl_seconds: float = JOB_TTL_SECONDS,
        scheduler: FairAsyncScheduler | None = None,
        finalize_scheduler: FairAsyncScheduler | None = None,
    ) -> None:
        self.review_service = review_service
        self.ttl_seconds = ttl_seconds
        self._jobs: dict[str, _StoredJob] = {}
        self._lock = threading.Lock()
        self.scheduler = scheduler or FairAsyncScheduler(
            global_limit=int(os.getenv("REVIEW_MODEL_GLOBAL_CONCURRENCY", "12")),
            per_job_limit=int(os.getenv("REVIEW_MODEL_JOB_CONCURRENCY", "6")),
        )
        finalize_limit = int(os.getenv("REVIEW_FINALIZE_CONCURRENCY", "2"))
        self.finalize_scheduler = finalize_scheduler or FairAsyncScheduler(
            global_limit=finalize_limit,
            per_job_limit=1,
        )

    def create(self, request: ReviewRequest) -> ReviewJobCreated:
        # 旧插件仍提交整批 JSON；生产 ReviewService 支持流式能力时，把它
        # 内部转换到同一公平队列，避免旧接口绕过全服务器并发上限。
        if callable(getattr(self.review_service, "extract_image_async", None)) and callable(
            getattr(self.review_service, "assist_with_batch_async", None)
        ):
            images = list(request.images)
            created = self.create_stream(self._without_image_payloads(request))
            try:
                for image in images:
                    self.add_stream_image(created.job_id, image)
                self.complete_stream(created.job_id)
            except Exception:
                self.cancel(created.job_id)
                raise
            return created

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
            progress=ReviewProgress(
                total_count=len(request.images),
                uploaded_count=len(request.images),
            ),
            groups=groups,
            phase=ReviewJobPhase.RECOGNIZING,
        )
        stored = _StoredJob(request, snapshot, threading.Event(), time.monotonic())
        with self._lock:
            self._jobs[job_id] = stored
        thread = threading.Thread(target=self._run, args=(job_id,), daemon=True)
        thread.start()
        return ReviewJobCreated(job_id=job_id, created_at=created_at)

    def create_stream(self, request: ReviewRequest) -> ReviewJobCreated:
        """创建先接收图片、再汇总规则的流式审核任务。"""

        self._cleanup()
        if len(request.images) > MAX_STREAM_IMAGES:
            raise ValueError(f"单次审核最多允许 {MAX_STREAM_IMAGES} 张图片")
        image_ids = [self._image_id(image) for image in request.images]
        if len(set(image_ids)) != len(image_ids):
            raise ValueError("图片清单包含重复标识")
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
            phase=ReviewJobPhase.UPLOADING,
        )
        stored = _StoredJob(
            request=request,
            snapshot=snapshot,
            done=threading.Event(),
            updated_at=time.monotonic(),
            streaming=True,
            batch=AgentBatchResult(total_count=len(request.images)),
        )
        with self._lock:
            self._jobs[job_id] = stored
        return ReviewJobCreated(job_id=job_id, created_at=created_at)

    def add_stream_image(self, job_id: str, image: ImageInput) -> ReviewJobSnapshot:
        """幂等接收一张图片，并立即加入全局公平识别队列。"""

        image = self._with_single_image_payload(image)
        image_id = self._image_id(image)
        with self._lock:
            stored = self._jobs.get(job_id)
            if stored is None or not stored.streaming:
                raise KeyError(job_id)
            if stored.cancelled or stored.upload_complete:
                raise RuntimeError("审核任务已停止接收图片")
            if image_id in stored.received_ids:
                return stored.snapshot.model_copy(deep=True)
            expected_ids = {self._image_id(item) for item in stored.request.images}
            if image_id not in expected_ids:
                raise ValueError("上传图片不属于该审核任务")
            stored.received_ids.add(image_id)
            stored.request = self._replace_image(stored.request, image)
            stored.snapshot.progress.uploaded_count = len(stored.received_ids)
            stored.snapshot.phase = ReviewJobPhase.RECOGNIZING
            stored.updated_at = time.monotonic()
            if image.collection_error or not image.data_url:
                self._merge_batch(stored.batch, self._failed_image_batch(image))
                self._refresh_stream_snapshot(stored)
                return stored.snapshot.model_copy(deep=True)
            stored.pending_count += 1
            # 单图识别只需要页面上下文和当前图片。不要把已经上传的其它
            # Base64 图片一起深拷贝到每个排队任务，避免并发时成倍占用内存。
            request = self._without_image_payloads(stored.request)

        future = self.scheduler.submit(
            job_id,
            lambda: self.review_service.extract_image_async(request, image),
        )
        future.add_done_callback(
            lambda completed, current_job_id=job_id, current_image=image: self._image_finished(
                current_job_id, current_image, completed
            )
        )
        return self.get(job_id)

    def complete_stream(self, job_id: str) -> ReviewJobSnapshot:
        """关闭上传阶段；所有识别完成后自动进入最终规则汇总。"""

        should_finalize = False
        with self._lock:
            stored = self._jobs.get(job_id)
            if stored is None or not stored.streaming:
                raise KeyError(job_id)
            if stored.cancelled:
                return stored.snapshot.model_copy(deep=True)
            expected = {self._image_id(item): item for item in stored.request.images}
            for image_id, image in expected.items():
                if image_id in stored.received_ids:
                    continue
                failed = image.model_copy(update={"collection_error": "图片未上传"})
                stored.request = self._replace_image(stored.request, failed)
                stored.received_ids.add(image_id)
                self._merge_batch(stored.batch, self._failed_image_batch(failed))
            stored.upload_complete = True
            stored.snapshot.progress.uploaded_count = len(stored.received_ids)
            stored.updated_at = time.monotonic()
            self._refresh_stream_snapshot(stored)
            should_finalize = self._begin_finalize_locked(stored)
            snapshot = stored.snapshot.model_copy(deep=True)
        if should_finalize:
            self._start_finalize(job_id)
        return snapshot

    def cancel(self, job_id: str) -> ReviewJobSnapshot:
        with self._lock:
            stored = self._jobs.get(job_id)
            if stored is None:
                raise KeyError(job_id)
            stored.cancelled = True
            stored.snapshot.status = JobStatus.CANCELLED
            stored.snapshot.phase = ReviewJobPhase.CANCELLED
            stored.snapshot.message = "审核任务已取消"
            stored.request = self._without_image_payloads(stored.request)
            stored.updated_at = time.monotonic()
            stored.done.set()
            snapshot = stored.snapshot.model_copy(deep=True)
        self.scheduler.cancel_pending(job_id)
        return snapshot

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
                # 对外只返回异常类型；具体原因保留在服务端日志中，避免模型响应、
                # 页面字段或其他敏感数据随异常文本泄漏到前端。
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

    def _image_finished(
        self,
        job_id: str,
        image: ImageInput,
        future: Future[AgentBatchResult],
    ) -> None:
        if future.cancelled():
            return
        try:
            batch = future.result()
        except CancelledError:
            return
        except BaseException as exc:
            logger.exception(
                "Stream image failed: job_id=%s image_id=%s error_type=%s",
                job_id,
                self._image_id(image),
                type(exc).__name__,
            )
            batch = self._failed_image_batch(image, "模型识别任务异常")

        should_finalize = False
        with self._lock:
            stored = self._jobs.get(job_id)
            if stored is None or stored.cancelled:
                return
            self._merge_batch(stored.batch, batch)
            self._release_non_qr_image_payload(stored, image, batch)
            stored.pending_count = max(0, stored.pending_count - 1)
            stored.updated_at = time.monotonic()
            self._refresh_stream_snapshot(stored)
            should_finalize = self._begin_finalize_locked(stored)
        if should_finalize:
            self._start_finalize(job_id)

    def _begin_finalize_locked(self, stored: _StoredJob) -> bool:
        if (
            stored.streaming
            and stored.upload_complete
            and stored.pending_count == 0
            and not stored.finalize_started
            and not stored.cancelled
        ):
            stored.finalize_started = True
            stored.snapshot.phase = ReviewJobPhase.FINALIZING
            return True
        return False

    def _start_finalize(self, job_id: str) -> None:
        self.finalize_scheduler.submit(
            job_id,
            lambda: self._finalize_async(job_id),
        )

    async def _finalize_async(self, job_id: str) -> None:
        with self._lock:
            stored = self._jobs.get(job_id)
            if stored is None or stored.cancelled:
                return
            request = stored.request.model_copy(deep=True)
            batch = stored.batch.model_copy(deep=True)
        try:
            response, final_batch = await self.review_service.assist_with_batch_async(
                request,
                initial_batch=batch,
            )
            with self._lock:
                current = self._jobs.get(job_id)
                if current is None or current.cancelled:
                    return
                current.batch = final_batch.model_copy(deep=True)
            self._update_snapshot(stored, response, final_batch, final=True)
        except Exception as exc:
            logger.exception(
                "Stream review finalization failed: job_id=%s error_type=%s",
                job_id,
                type(exc).__name__,
            )
            with self._lock:
                stored.snapshot.status = JobStatus.FAILED
                stored.snapshot.phase = ReviewJobPhase.FAILED
                stored.snapshot.message = f"审核任务失败：{type(exc).__name__}"
                stored.updated_at = time.monotonic()
        finally:
            # 二维码核验等最终能力执行完成后，不再需要保留图片内容。
            # 任务快照和模型结果仍保留到 TTL 到期。
            with self._lock:
                current = self._jobs.get(job_id)
                if current is not None:
                    current.request = self._without_image_payloads(current.request)
                    current.updated_at = time.monotonic()
                    current.done.set()

    def _refresh_stream_snapshot(self, stored: _StoredJob) -> None:
        uploaded = len(stored.received_ids)
        stored.snapshot.progress = ReviewProgress(
            total_count=stored.batch.total_count,
            uploaded_count=uploaded,
            completed_count=stored.batch.completed_count,
            failed_count=stored.batch.failed_count,
            timed_out_count=stored.batch.timed_out_count,
        )
        stored.snapshot.groups = {
            "old_vehicle": self._group_progress(
                stored.request,
                OLD_SCOPES,
                set(stored.batch.completed_image_ids),
                set(stored.batch.failed_image_ids),
                set(stored.batch.timed_out_image_ids),
                final=False,
            ),
            "new_vehicle": self._group_progress(
                stored.request,
                NEW_SCOPES,
                set(stored.batch.completed_image_ids),
                set(stored.batch.failed_image_ids),
                set(stored.batch.timed_out_image_ids),
                final=False,
            ),
        }

    @staticmethod
    def _image_id(image: ImageInput) -> str:
        return str(image.image_id or image.index)

    @classmethod
    def _replace_image(cls, request: ReviewRequest, image: ImageInput) -> ReviewRequest:
        image_id = cls._image_id(image)
        images = [
            image if cls._image_id(item) == image_id else item
            for item in request.images
        ]
        return request.model_copy(update={"images": images})

    @staticmethod
    def _without_image_payloads(request: ReviewRequest) -> ReviewRequest:
        images = [
            image.model_copy(update={
                "data_url": None,
                "src": "" if image.src.startswith("data:") else image.src,
            })
            for image in request.images
        ]
        return request.model_copy(update={"images": images})

    @staticmethod
    def _with_single_image_payload(image: ImageInput) -> ImageInput:
        if image.data_url and image.src.startswith("data:"):
            return image.model_copy(update={"src": ""})
        return image

    @classmethod
    def _release_non_qr_image_payload(
        cls,
        stored: _StoredJob,
        image: ImageInput,
        batch: AgentBatchResult,
    ) -> None:
        """识别后尽早释放最终二维码核验不再需要的图片正文。"""

        old_document_hints = {
            "old_vehicle",
            "vehicle_license",
            "registration_certificate",
            "scrap_certificate",
        }
        recognized_as_scrap = any(
            document.document_type == "scrap_certificate"
            for document in batch.recognized_documents
        )
        needs_qr_payload = (
            image.business_scope == "old_vehicle"
            or image.category_hint in old_document_hints
            or image.document_type_hint in old_document_hints
            or recognized_as_scrap
        )
        if needs_qr_payload:
            return
        released = image.model_copy(update={
            "data_url": None,
            "src": "" if image.src.startswith("data:") else image.src,
        })
        stored.request = cls._replace_image(stored.request, released)

    @classmethod
    def _failed_image_batch(
        cls,
        image: ImageInput,
        reason: str | None = None,
    ) -> AgentBatchResult:
        image_id = cls._image_id(image)
        return AgentBatchResult(
            total_count=1,
            failed_count=1,
            failed_image_ids=[image_id],
            limitations=[reason or f"图片 {image_id} 内容不可用"],
        )

    @staticmethod
    def _merge_batch(target: AgentBatchResult, incoming: AgentBatchResult) -> None:
        target.observations.extend(incoming.observations)
        target.limitations.extend(incoming.limitations)
        target.confidences.extend(incoming.confidences)
        target.completed_count += incoming.completed_count
        target.failed_count += incoming.failed_count
        target.timed_out_count += incoming.timed_out_count
        target.completed_image_ids.extend(incoming.completed_image_ids)
        target.failed_image_ids.extend(incoming.failed_image_ids)
        target.timed_out_image_ids.extend(incoming.timed_out_image_ids)
        target.recognized_documents.extend(incoming.recognized_documents)
        target.retry_summary.attempts.extend(incoming.retry_summary.attempts)

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
            uploaded_count=stored.snapshot.progress.uploaded_count,
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
            if stored.cancelled:
                return
            stored.snapshot.status = status
            stored.snapshot.progress = progress
            stored.snapshot.groups = groups
            stored.snapshot.result = response
            stored.snapshot.material_completeness = response.material_completeness
            stored.snapshot.retry_summary = response.retry_summary
            stored.snapshot.phase = (
                ReviewJobPhase.COMPLETED if final else ReviewJobPhase.RECOGNIZING
            )
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
