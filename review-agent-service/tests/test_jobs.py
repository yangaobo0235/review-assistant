from app.agent.models import AgentBatchResult
from app.models.review import (
    JobStatus,
    ReviewRequest,
    ReviewResponse,
)
from app.services.jobs import ReviewJobManager


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
