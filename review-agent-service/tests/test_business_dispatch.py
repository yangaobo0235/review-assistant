import pytest
from fastapi.testclient import TestClient

from app.agent.models import AgentBatchResult, RecognizedDocument
from app.main import app
from app.models.review import FieldObservation, ImageInput, ReviewRequest
from app.rules.review_fields import TRANSFER_REVIEW_FIELDS
from app.services.review import ReviewService

client = TestClient(app)


def transfer_batch() -> AgentBatchResult:
    return AgentBatchResult(
        observations=[
            FieldObservation(
                field="transfer.plate_no",
                source_type="image",
                source_id="invoice",
                value="冀A34870",
                document_type="invoice",
                business_scope="transfer",
            ),
            FieldObservation(
                field="transfer.vin",
                source_type="image",
                source_id="invoice",
                value="VIN-1",
                document_type="invoice",
                business_scope="transfer",
            ),
            FieldObservation(
                field="transfer.vin",
                source_type="image",
                source_id="reg",
                value="VIN-1",
                document_type="registration_certificate",
                business_scope="transfer",
                group_order=2,
            ),
            FieldObservation(
                field="transfer.buyer_name",
                source_type="image",
                source_id="invoice",
                value="丙公司",
                document_type="invoice",
                business_scope="transfer",
            ),
            FieldObservation(
                field="transfer.seller_name",
                source_type="image",
                source_id="invoice",
                value="乙公司",
                document_type="invoice",
                business_scope="transfer",
            ),
            FieldObservation(
                field="transfer.invoice_date",
                source_type="image",
                source_id="invoice",
                value="2026-08-15",
                document_type="invoice",
                business_scope="transfer",
            ),
            FieldObservation(
                field="transfer.registration.covered_pages",
                source_type="image",
                source_id="reg",
                value=[1, 2, 3, 4],
                document_type="registration_certificate",
                business_scope="transfer",
            ),
            FieldObservation(
                field="transfer.registration.initial_owner",
                source_type="image",
                source_id="reg",
                value="甲公司",
                document_type="registration_certificate",
                business_scope="transfer",
            ),
            FieldObservation(
                field="transfer.registration.transfer_records",
                source_type="image",
                source_id="reg",
                value=[
                    {"owner": "乙公司", "date": "2024-01-01", "page": 2, "order": 1},
                    {"owner": "丙公司", "date": "2026-08-16", "page": 4, "order": 2},
                ],
                document_type="registration_certificate",
                business_scope="transfer",
            ),
        ],
        confidences=[0.95, 0.96],
    )


def transfer_request(page_fields: dict[str, str] | None = None) -> ReviewRequest:
    return ReviewRequest(
        page_url="https://example.test/transfer/1",
        business_type="transfer",
        region="default",
        page_fields=page_fields or {},
        images=[
            ImageInput(
                index=0,
                src="data:image/jpeg;base64,AA==",
                business_scope="transfer",
                document_type_hint="invoice",
                group_title="过户资料",
                group_order=1,
            ),
            ImageInput(
                index=1,
                src="data:image/jpeg;base64,AA==",
                business_scope="transfer",
                document_type_hint="registration_certificate",
                group_title="过户资料",
                group_order=2,
            ),
        ],
    )


@pytest.mark.asyncio
async def test_transfer_response_passes_without_qr_when_all_rules_match(
    monkeypatch,
) -> None:
    service = ReviewService()
    batch = transfer_batch().model_copy(
        update={
            "recognized_documents": [
                RecognizedDocument(
                    target_id="invoice",
                    document_type="invoice",
                    business_scope="transfer",
                ),
                RecognizedDocument(
                    target_id="reg",
                    document_type="registration_certificate",
                    business_scope="transfer",
                    covered_pages=[1, 2, 3, 4],
                ),
            ]
        }
    )

    async def extract(*args):
        return batch

    monkeypatch.setattr(service, "_extract_documents", extract)
    result = await service.assist_async(
        transfer_request(
            {
                "transfer.plate_no": "冀A34870",
                "transfer.vin": "VIN-1",
                "transfer.buyer_name": "丙公司",
                "transfer.seller_name": "乙公司",
                "transfer.invoice_date": "2026-08-15",
                "transfer.source_publish_date": "2026-08-13 17:01:31",
            }
        ),
    )

    assert result.recommendation.value == "PASS"
    assert result.issues == []
    assert result.qr_checks == []
    assert {item.check_id for item in result.cross_checks} == {
        "CROSS-TRANSFER-SELLER-001",
        "CROSS-TRANSFER-BUYER-001",
        "CROSS-TRANSFER-DATE-001",
    }
    assert not any(
        item.label == "二维码官网核验" for item in result.agent_advice.findings
    )
    assert result.page_fill_intent == []
    assert not any(
        step.category == "EXTERNAL"
        or "POLICY" in step.step_id
        or "AFFILIATION" in step.step_id
        for step in result.review_tasks
    )


def test_transfer_profile_keeps_structured_observations_out_of_same_field_sections() -> (
    None
):
    result = ReviewService()._build_response(
        transfer_request(),
        transfer_batch(),
        include_tools=False,
    )

    assert [item.field for item in result.comparisons] == list(TRANSFER_REVIEW_FIELDS)
    assert all("registration" not in item.field for item in result.comparisons)


@pytest.mark.parametrize(
    ("missing_source_id", "omit_page_vin"),
    [
        ("invoice", False),
        ("reg", False),
        (None, True),
    ],
)
def test_transfer_vin_requires_page_invoice_and_registration_sources(
    missing_source_id: str | None,
    omit_page_vin: bool,
) -> None:
    batch = transfer_batch()
    batch.observations = [
        item
        for item in batch.observations
        if not (item.field == "transfer.vin" and item.source_id == missing_source_id)
    ]
    page_fields = {
        "transfer.plate_no": "冀A34870",
        "transfer.buyer_name": "丙公司",
        "transfer.seller_name": "乙公司",
        "transfer.invoice_date": "2026-08-15",
        "transfer.source_publish_date": "2026-08-13",
    }
    if not omit_page_vin:
        page_fields["transfer.vin"] = "VIN-1"

    result = ReviewService()._build_response(
        transfer_request(page_fields),
        batch,
        include_tools=False,
    )

    vin = next(item for item in result.comparisons if item.field == "transfer.vin")
    assert vin.status.value == "REVIEW_REQUIRED"
    assert result.recommendation.value == "REVIEW_REQUIRED"


def test_transfer_uncertain_invoice_vin_cannot_match() -> None:
    batch = transfer_batch()
    batch.observations.append(
        FieldObservation(
            field="transfer.uncertain_fields",
            source_type="image",
            source_id="invoice",
            value=["vehicle.vin"],
            document_type="invoice",
            business_scope="transfer",
        )
    )
    result = ReviewService()._build_response(
        transfer_request(
            {
                "transfer.plate_no": "冀A34870",
                "transfer.vin": "VIN-1",
                "transfer.buyer_name": "丙公司",
                "transfer.seller_name": "乙公司",
                "transfer.invoice_date": "2026-08-15",
                "transfer.source_publish_date": "2026-08-13",
            }
        ),
        batch,
        include_tools=False,
    )

    vin = next(item for item in result.comparisons if item.field == "transfer.vin")
    assert vin.status.value == "REVIEW_REQUIRED"
    assert "字段识别不确定" in vin.message


def test_transfer_uncertainty_does_not_hide_an_explicit_conflict() -> None:
    batch = transfer_batch()
    batch.observations.append(
        FieldObservation(
            field="transfer.uncertain_fields",
            source_type="image",
            source_id="reg",
            value=["vehicle.vin"],
            document_type="registration_certificate",
            business_scope="transfer",
        )
    )
    result = ReviewService()._build_response(
        transfer_request(
            {
                "transfer.plate_no": "冀A34870",
                "transfer.vin": "VIN-CONFLICT",
                "transfer.buyer_name": "丙公司",
                "transfer.seller_name": "乙公司",
                "transfer.invoice_date": "2026-08-15",
                "transfer.source_publish_date": "2026-08-13",
            }
        ),
        batch,
        include_tools=False,
    )

    vin = next(item for item in result.comparisons if item.field == "transfer.vin")
    assert vin.status.value == "CONFLICT"


def test_transfer_uncertain_observation_keeps_pre_branch_aggregation() -> None:
    """过户保持分支前语义：图片 uncertain 标记不触发同字段聚合一票否决。"""
    batch = transfer_batch()
    batch.observations = [
        item.model_copy(update={"uncertain": True})
        if item.field == "transfer.plate_no" and item.source_type == "image"
        else item
        for item in batch.observations
    ]
    result = ReviewService()._build_response(
        transfer_request(
            {
                "transfer.plate_no": "冀A34870",
                "transfer.vin": "VIN-1",
                "transfer.buyer_name": "丙公司",
                "transfer.seller_name": "乙公司",
                "transfer.invoice_date": "2026-08-15",
                "transfer.source_publish_date": "2026-08-13",
            }
        ),
        batch,
        include_tools=False,
    )

    plate = next(
        item for item in result.comparisons if item.field == "transfer.plate_no"
    )
    assert plate.status.value == "MATCH"


def test_scrap_target_profile_uncertain_observation_forces_review() -> None:
    """目标 Profile 保留一票否决：图片 uncertain 时同字段比较强制人工复核。"""
    batch = AgentBatchResult(
        observations=[
            FieldObservation(
                field="new_vehicle.vin",
                source_type="image",
                source_id="new",
                value="VIN-1",
                uncertain=True,
            )
        ]
    )
    result = ReviewService()._build_response(
        ReviewRequest(
            page_url="https://example.test/review/1",
            business_type="scrap_replacement",
            region="qingdao",
            page_fields={"new_vehicle.vin": "VIN-1"},
        ),
        batch,
        include_tools=False,
    )

    vin = next(item for item in result.comparisons if item.field == "new_vehicle.vin")
    assert vin.status.value == "REVIEW_REQUIRED"
    assert vin.message == "图片识别结果不确定，请核对原图"


def test_scrap_request_uses_scrap_fields_and_sections() -> None:
    result = ReviewService().assist(
        ReviewRequest(
            page_url="https://example.test/scrap-replace-qingdao",
            business_type="scrap_replacement",
            region="qingdao",
            page_fields={"old_vehicle.vin": "VIN-1"},
            images=[],
        )
    )

    assert any(item.field == "old_vehicle.vin" for item in result.comparisons)
    assert [item.id for item in result.sections] == ["old_vehicle", "new_vehicle"]


def test_vehicle_source_does_not_execute_scrap_rules() -> None:
    result = ReviewService().assist(
        ReviewRequest(
            page_url="https://example.test/vehicle-source",
            business_type="vehicle_source",
            region="default",
            workflow_stage="vehicle_source",
            page_fields={"old_vehicle.vin": "MUST-NOT-BE-COMPARED"},
            images=[],
        )
    )

    assert result.comparisons == []
    assert result.recommendation.value == "REVIEW_REQUIRED"
    assert "车源审核规则尚未配置，请人工复核" in result.issues
    assert result.business_type.value == "vehicle_source"


def test_unknown_profile_version_returns_422() -> None:
    response = client.post(
        "/api/review/assist",
        json={
            "pageUrl": "https://example.test/vehicle-source",
            "businessType": "vehicle_source",
            "region": "default",
            "profileVersion": "9.9",
            "images": [],
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "审核业务配置不存在或版本不兼容"


def test_unknown_profile_version_is_rejected_before_job_creation() -> None:
    response = client.post(
        "/api/review/jobs",
        json={
            "pageUrl": "https://example.test/vehicle-source",
            "businessType": "vehicle_source",
            "region": "default",
            "profileVersion": "9.9",
            "images": [],
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "审核业务配置不存在或版本不兼容"
