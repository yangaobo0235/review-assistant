import threading

import pytest

from app.models.review import (
    ImageInput,
    JobStatus,
    ReviewJobPhase,
    ReviewRequest,
    ReviewResponse,
)
from app.services.jobs import ReviewJobManager
from app.workflow.models import AgentBatchResult


def response(summary: str) -> ReviewResponse:
    return ReviewResponse(
        recommendation="REVIEW_REQUIRED",
        risk_level="MEDIUM",
        summary=summary,
    )


class FakeProgressReviewService:
    async def assist_async(self, request: ReviewRequest, on_progress: object = None) -> ReviewResponse:
        first = AgentBatchResult(
            total_count=2,
            completed_count=1,
            completed_image_ids=["old-1"],
        )
        if on_progress:
            await on_progress(response("报废组已完成"), first)
        final = AgentBatchResult(
            total_count=2,
            completed_count=2,
            completed_image_ids=["old-1", "new-1"],
        )
        if on_progress:
            await on_progress(response("全部完成"), final)
        return response("全部完成")


class FailingReviewService:
    async def assist_async(self, request: ReviewRequest, on_progress: object = None) -> ReviewResponse:
        raise AttributeError("missing business_field")


class UnprocessedImageReviewService:
    async def assist_async(
        self,
        request: ReviewRequest,
        on_progress: object = None,
    ) -> ReviewResponse:
        batch = AgentBatchResult(total_count=len(request.images))
        if on_progress:
            await on_progress(response("当前业务规则尚未配置"), batch)
        return response("当前业务规则尚未配置")


class StreamingReviewService:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.extracted_ids: list[str] = []
        self.final_batches: list[AgentBatchResult] = []

    async def extract_image_async(
        self,
        request: ReviewRequest,
        image: ImageInput,
    ) -> AgentBatchResult:
        image_id = str(image.image_id or image.index)
        with self.lock:
            self.extracted_ids.append(image_id)
        return AgentBatchResult(
            total_count=1,
            completed_count=1,
            completed_image_ids=[image_id],
        )

    async def assist_with_batch_async(
        self,
        request: ReviewRequest,
        on_progress: object = None,
        initial_batch: AgentBatchResult | None = None,
    ) -> tuple[ReviewResponse, AgentBatchResult]:
        assert initial_batch is not None
        with self.lock:
            self.final_batches.append(initial_batch.model_copy(deep=True))
        return response("流式审核完成"), initial_batch


def test_job_snapshot_updates_progress_and_business_groups() -> None:
    request = ReviewRequest(
        page_url="https://example.test/review/1",
        images=[
            {
                "index": 0,
                "imageId": "old-1",
                "src": "data:image/jpeg;base64,AA==",
                "categoryHint": "old_vehicle",
            },
            {
                "index": 1,
                "imageId": "new-1",
                "src": "data:image/jpeg;base64,AA==",
                "categoryHint": "new_vehicle",
            },
        ],
    )
    manager = ReviewJobManager(FakeProgressReviewService())

    created = manager.create(request)
    assert manager.wait(created.job_id, timeout=1)
    snapshot = manager.get(created.job_id)

    assert snapshot.status is JobStatus.COMPLETED
    assert snapshot.progress.completed_count == 2
    assert snapshot.groups["old_vehicle"].completed_count == 1
    assert snapshot.groups["new_vehicle"].completed_count == 1
    assert snapshot.result is not None
    assert snapshot.result.summary == "全部完成"


def test_job_with_timeout_finishes_as_partial() -> None:
    class PartialService:
        async def assist_async(self, request: ReviewRequest, on_progress: object = None) -> ReviewResponse:
            batch = AgentBatchResult(total_count=2, completed_count=1, timed_out_count=1)
            if on_progress:
                await on_progress(response("部分完成"), batch)
            return response("部分完成")

    manager = ReviewJobManager(PartialService())
    created = manager.create(ReviewRequest(page_url="https://example.test", images=[]))

    assert manager.wait(created.job_id, timeout=1)
    assert manager.get(created.job_id).status is JobStatus.PARTIAL


def test_terminal_job_with_unprocessed_images_finishes_as_partial() -> None:
    request = ReviewRequest(
        page_url="https://example.test/review/1",
        business_type="vehicle_source",
        region="default",
        images=[
            {
                "index": 0,
                "imageId": "old-1",
                "src": "data:image/jpeg;base64,AA==",
                "businessScope": "old_vehicle",
            }
        ],
    )
    manager = ReviewJobManager(UnprocessedImageReviewService())

    created = manager.create(request)
    assert manager.wait(created.job_id, timeout=1)
    snapshot = manager.get(created.job_id)

    assert snapshot.status is JobStatus.PARTIAL
    assert snapshot.groups["old_vehicle"].status is JobStatus.PARTIAL
    assert all(group.status is not JobStatus.RUNNING for group in snapshot.groups.values())


def test_job_failure_logs_traceback_and_keeps_safe_snapshot_message(caplog: object) -> None:
    manager = ReviewJobManager(FailingReviewService())

    with caplog.at_level("ERROR", logger="uvicorn.error"):
        created = manager.create(ReviewRequest(page_url="https://example.test", images=[]))
        assert manager.wait(created.job_id, timeout=1)

    snapshot = manager.get(created.job_id)
    failure_records = [
        record
        for record in caplog.records
        if record.getMessage().startswith("Review job failed:")
    ]

    assert snapshot.status is JobStatus.FAILED
    assert snapshot.message == "审核任务失败：AttributeError"
    assert len(failure_records) == 1
    assert failure_records[0].exc_info is not None
    assert failure_records[0].exc_info[0] is AttributeError


def test_job_groups_use_business_scope_instead_of_misleading_category_hint() -> None:
    request = ReviewRequest(
        page_url="https://example.test/review/1",
        images=[
            {
                "index": 6,
                "imageId": "new-1",
                "src": "data:image/jpeg;base64,AA==",
                "categoryHint": "old_vehicle",
                "businessScope": "new_vehicle",
            }
        ],
    )
    manager = ReviewJobManager(FakeProgressReviewService())

    created = manager.create(request)
    assert manager.wait(created.job_id, timeout=1)
    snapshot = manager.get(created.job_id)

    assert snapshot.groups["old_vehicle"].total_count == 0
    assert snapshot.groups["new_vehicle"].total_count == 1


def test_stream_job_recognizes_each_image_once_and_reuses_batch_for_finalization() -> None:
    service = StreamingReviewService()
    manager = ReviewJobManager(service)
    manifest = ReviewRequest(
        page_url="https://example.test/review/stream",
        images=[
            {
                "index": index,
                "imageId": f"image-{index}",
                "src": f"https://example.test/{index}.jpg",
                "businessScope": "old_vehicle" if index == 0 else "new_vehicle",
            }
            for index in range(2)
        ],
    )
    created = manager.create_stream(manifest)

    for image in manifest.images:
        uploaded = image.model_copy(update={"data_url": "data:image/jpeg;base64,AA=="})
        manager.add_stream_image(created.job_id, uploaded)
        # 客户端因响应丢失而重试时，服务端必须幂等，不能重复调用模型。
        manager.add_stream_image(created.job_id, uploaded)
    manager.complete_stream(created.job_id)

    assert manager.wait(created.job_id, timeout=2)
    snapshot = manager.get(created.job_id)
    assert snapshot.status is JobStatus.COMPLETED
    assert snapshot.phase is ReviewJobPhase.COMPLETED
    assert snapshot.progress.uploaded_count == 2
    assert snapshot.progress.completed_count == 2
    assert sorted(service.extracted_ids) == ["image-0", "image-1"]
    assert len(service.final_batches) == 1
    assert service.final_batches[0].completed_count == 2
    # 完成后仅保留图片元数据，避免在 10 分钟任务 TTL 内占用大量内存。
    assert all(image.data_url is None for image in manager._jobs[created.job_id].request.images)


def test_stream_job_marks_missing_images_failed_and_can_be_cancelled() -> None:
    service = StreamingReviewService()
    manager = ReviewJobManager(service)
    request = ReviewRequest(
        page_url="https://example.test/review/stream",
        images=[{"index": 0, "imageId": "missing", "src": "missing"}],
    )
    created = manager.create_stream(request)
    manager.complete_stream(created.job_id)

    assert manager.wait(created.job_id, timeout=2)
    snapshot = manager.get(created.job_id)
    assert snapshot.status is JobStatus.PARTIAL
    assert snapshot.progress.failed_count == 1
    assert service.extracted_ids == []

    cancelled = manager.create_stream(request)
    cancelled_snapshot = manager.cancel(cancelled.job_id)
    assert cancelled_snapshot.status is JobStatus.CANCELLED
    assert cancelled_snapshot.phase is ReviewJobPhase.CANCELLED


def test_stream_job_rejects_duplicate_manifest_image_ids() -> None:
    manager = ReviewJobManager(StreamingReviewService())
    request = ReviewRequest(
        page_url="https://example.test/review/stream",
        images=[
            {"index": 0, "imageId": "same", "src": "one"},
            {"index": 1, "imageId": "same", "src": "two"},
        ],
    )

    with pytest.raises(ValueError, match="重复标识"):
        manager.create_stream(request)


def test_stream_job_emits_phase_timing_line_for_reporting(caplog) -> None:
    """一次审核必须留下一行四段耗时——性能改动的对照组全靠它。

    缺锚点的段记 -1 而不是 0：拿 0 冒充"这一段没花时间"会把上传瓶颈
    误判成识别瓶颈，正好把并发参数调到反方向。
    """
    service = StreamingReviewService()
    manager = ReviewJobManager(service)
    manifest = ReviewRequest(
        page_url="https://example.test/review/timing",
        images=[
            {
                "index": 0,
                "imageId": "image-0",
                "src": "https://example.test/0.jpg",
                "businessScope": "old_vehicle",
            }
        ],
    )

    with caplog.at_level("INFO", logger="uvicorn.error"):
        created = manager.create_stream(manifest)
        manager.add_stream_image(
            created.job_id,
            manifest.images[0].model_copy(update={"data_url": "data:image/jpeg;base64,AA=="}),
        )
        manager.complete_stream(created.job_id)
        assert manager.wait(created.job_id, timeout=2)

    lines = [
        record.getMessage()
        for record in caplog.records
        if record.getMessage().startswith("review job timing")
    ]
    assert len(lines) == 1
    line = lines[0]
    assert f"job_id={created.job_id}" in line
    assert "status=COMPLETED" in line
    assert "images=1" in line

    durations = {}
    for part in line.split():
        key, _, value = part.partition("=")
        if key.endswith("_ms") or key == "peak_rss_mb":
            durations[key] = int(value)  # 值不是整数会抛 ValueError，测试即失败
    assert set(durations) >= {
        "upload_ms",
        "recognize_ms",
        "finalize_ms",
        "total_ms",
        "recognition_waited_ms",
        "peak_rss_mb",
    }
    assert durations["total_ms"] >= 0
