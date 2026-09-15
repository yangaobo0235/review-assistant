from fastapi.testclient import TestClient

from app.main import app
from app.models.review import ReviewRequest
from app.services.review import ReviewService
from app.services.tools import ToolResult

client = TestClient(app)


def test_health_endpoint() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_assist_returns_review_structure_for_page_data() -> None:
    response = client.post(
        "/api/review/assist",
        json={
            "page_url": "https://example.test/review/1",
            "region": "qingdao",
            "application_id": "APP-1",
            "page_fields": {"old_vehicle.vin": "ABC123"},
            "images": [],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["recommendation"] == "REVIEW_REQUIRED"
    assert "comparisons" in body
    assert "qr_checks" in body
    assert body["context_summary"]["image_count"] == 0
    assert len(body["material_completeness"]["checklist"]) == 6
    subject_step = next(
        item
        for item in body["review_tasks"]
        if item["step_id"] == "BUSINESS-AFFILIATION-SUBJECT-001"
    )
    assert "subject_requirements" in subject_step["details"]


def test_job_api_creates_and_polls_review() -> None:
    created = client.post(
        "/api/review/jobs",
        json={"page_url": "https://example.test/review/1", "region": "qingdao", "images": []},
    )

    assert created.status_code == 202
    body = created.json()
    assert body["status"] == "RUNNING"

    polled = client.get(f"/api/review/jobs/{body['job_id']}")
    assert polled.status_code == 200
    assert polled.json()["status"] in {"RUNNING", "PARTIAL", "COMPLETED"}


def test_assist_marks_page_fields_for_manual_review_until_images_are_recognized() -> None:
    response = client.post(
        "/api/review/assist",
        json={
            "page_url": "https://example.test/review/1",
            "region": "qingdao",
            "page_fields": {"old_vehicle.vin": "ABC123"},
            "images": [],
        },
    )

    comparison = next(item for item in response.json()["comparisons"] if item["field"] == "old_vehicle.vin")
    assert comparison["status"] == "REVIEW_REQUIRED"


class FixedOcr:
    def recognize(self, image: object) -> ToolResult:
        return ToolResult(fields={"old_vehicle.vin": "DIFFERENT"}, confidence=0.99)


class FailingOcr:
    def recognize(self, image: object) -> ToolResult:
        raise RuntimeError("识别服务不可用")


def test_review_service_compares_recognized_image_fields_to_page_fields() -> None:
    service = ReviewService(ocr=FixedOcr())
    result = service.assist(
        ReviewRequest(
            page_url="https://example.test/review/1",
            region="qingdao",
            page_fields={"old_vehicle.vin": "ABC123"},
            images=[{"index": 0, "src": "image", "group": "回收证明"}],
        )
    )

    vin_comparison = next(item for item in result.comparisons if item.field == "old_vehicle.vin")
    assert vin_comparison.status.value == "CONFLICT"
    assert result.recommendation.value == "REVIEW_REQUIRED"
    assert any(item.check_id == "FIELD-old_vehicle.vin" for item in result.agent_advice.findings)


def test_review_service_continues_when_one_image_tool_fails() -> None:
    service = ReviewService(ocr=FailingOcr())
    result = service.assist(
        ReviewRequest(
            page_url="https://example.test/review/1",
            region="qingdao",
            page_fields={"old_vehicle.vin": "ABC123"},
            images=[{"index": 0, "src": "image", "group": "回收证明"}],
        )
    )

    assert result.recommendation.value == "REVIEW_REQUIRED"
    assert any("图片 0" in issue for issue in result.issues)


def test_review_service_reports_context_image_summary_and_collection_errors() -> None:
    service = ReviewService()
    result = service.assist(
        ReviewRequest(
            page_url="https://example.test/review/1",
            region="qingdao",
            images=[
                {
                    "index": 0,
                    "src": "data:image/jpeg;base64,AA==",
                    "imageId": "img-0001",
                    "mimeType": "image/jpeg",
                    "sizeBytes": 2,
                    "collectionError": "图片读取失败",
                }
            ],
        )
    )

    assert result.context_summary == {
        "field_count": 0,
        "image_count": 1,
        "image_failed_count": 1,
        "completed_count": 0,
        "failed_count": 1,
        "timed_out_count": 0,
    }
    assert "图片 img-0001 采集失败：图片读取失败" in result.issues


def test_review_service_only_compares_configured_business_fields() -> None:
    service = ReviewService()
    result = service.assist(
        ReviewRequest(
            page_url="https://example.test/review/1",
            region="qingdao",
            page_fields={
                "old_vehicle.vin": "OLD-VIN",
                "old_vehicle.engine_model": "ENGINE-1",
                "invoice.code": "INVOICE-CODE",
                "invoice.invoice_no": "INVOICE-NO",
                "invoice.amount": "152000",
                "scrap_certificate.certificate_no": "CERTIFICATE-001",
            },
            images=[],
        )
    )

    compared_fields = {comparison.field for comparison in result.comparisons}
    assert "old_vehicle.vin" in compared_fields
    assert "old_vehicle.engine_model" in compared_fields
    assert "invoice.code" in compared_fields
    assert "invoice.invoice_no" in compared_fields
    assert "invoice.amount" in compared_fields
    assert "scrap_certificate.certificate_no" in compared_fields


def test_review_service_includes_missing_required_business_fields() -> None:
    result = ReviewService().assist(
        ReviewRequest(page_url="https://example.test/review/1", region="qingdao", page_fields={}, images=[])
    )

    compared_fields = {comparison.field for comparison in result.comparisons}
    assert "old_vehicle.recycle_date" in compared_fields
    assert "new_vehicle.owner" in compared_fields
