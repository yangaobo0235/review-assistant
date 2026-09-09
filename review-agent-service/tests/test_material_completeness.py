from app.agent.models import AgentBatchResult, RecognizedDocument
from app.businesses.material_policies import TRANSFER_MATERIAL_POLICY
from app.businesses.profiles import SCRAP_REPLACEMENT_QINGDAO, TRANSFER_DEFAULT
from app.models.review import FieldObservation, ReviewRequest
from app.rules.material_completeness import evaluate_collected, evaluate_extracted


def test_transfer_collected_report_marks_ambiguity_and_overflow() -> None:
    request = ReviewRequest.model_validate({
        "pageUrl": "https://example.test/transfer",
        "businessType": "transfer",
        "region": "default",
        "collectionDiagnostics": {
            "ambiguousFields": ["transfer.vin"],
            "imageOverflow": True,
        },
    })
    report = evaluate_collected(request, TRANSFER_DEFAULT)
    assert report.status == "UNCERTAIN"
    assert {item.code for item in report.issues} >= {
        "AMBIGUOUS_REQUIRED_FIELD", "IMAGE_SELECTION_OVERFLOW", "MISSING_MATERIAL",
    }


def test_transfer_extracted_report_lists_missing_registration_pages_and_sources() -> None:
    request = ReviewRequest(
        page_url="https://example.test/transfer",
        business_type="transfer",
        region="default",
        page_fields={"transfer.vin": "VIN-1"},
        images=[{"index": 1, "src": "image", "businessScope": "transfer", "categoryHint": "invoice"}],
    )
    batch = AgentBatchResult(recognized_documents=[RecognizedDocument(
        target_id="registration-01", document_type="registration_certificate",
        business_scope="transfer", covered_pages=[1, 2],
    )])
    report = evaluate_extracted(request, TRANSFER_DEFAULT, batch)
    pages = next(item for item in report.issues if item.code == "MISSING_REGISTRATION_PAGES")
    assert pages.missing_pages == [3, 4]
    assert any(item.code == "MISSING_FIELD_SOURCE" for item in report.issues)
    assert report.enforced is True


def test_scrap_extracted_policy_is_observation_only() -> None:
    report = evaluate_extracted(
        ReviewRequest(page_url="https://example.test"),
        SCRAP_REPLACEMENT_QINGDAO,
        AgentBatchResult(),
    )
    assert report.status == "INCOMPLETE"
    assert report.enforced is False


def test_transfer_vin_requirement_requires_registration_page_two() -> None:
    requirement = next(item for item in TRANSFER_MATERIAL_POLICY.field_sources if item.field == "transfer.vin")
    assert {selector.required_page for selector in requirement.all_of} == {None, 2}


def test_missing_pages_explain_model_marked_page_number_as_uncertain() -> None:
    request = ReviewRequest(
        page_url="https://example.test/transfer",
        business_type="transfer",
        region="default",
    )
    batch = AgentBatchResult(recognized_documents=[RecognizedDocument(
        target_id="transfer-01",
        document_type="registration_certificate",
        business_scope="transfer",
        covered_pages=[3, 4],
        uncertain_fields=["registration.covered_pages"],
    )])

    report = evaluate_extracted(request, TRANSFER_DEFAULT, batch)
    issue = next(item for item in report.issues if item.code == "MISSING_REGISTRATION_PAGES")

    assert issue.reason_code == "recognition_uncertain"
    assert "图片可能模糊、遮挡" in issue.reason_detail
    assert issue.message == "机动车登记证第1、2页未能确认"


def test_missing_invoice_date_explains_uncertain_image_field() -> None:
    request = ReviewRequest(
        page_url="https://example.test/transfer",
        business_type="transfer",
        region="default",
        page_fields={"transfer.invoice_date": "2026-08-17"},
    )
    batch = AgentBatchResult(
        observations=[FieldObservation(
            field="transfer.uncertain_fields",
            source_type="image",
            source_id="transfer-03",
            document_type="invoice",
            business_scope="transfer",
            value=["invoice.invoice_date"],
        )],
        recognized_documents=[RecognizedDocument(
            target_id="transfer-03",
            document_type="invoice",
            business_scope="transfer",
            uncertain_fields=["invoice.invoice_date"],
        )],
    )

    report = evaluate_extracted(request, TRANSFER_DEFAULT, batch)
    issue = next(
        item for item in report.issues
        if item.code == "MISSING_FIELD_SOURCE" and item.field == "transfer.invoice_date"
    )

    assert issue.reason_code == "recognition_uncertain"
    assert issue.message == "开票日期缺少二手车发票证据"
    assert "日期区域可能模糊、遮挡或不可辨认" in issue.reason_detail


def test_missing_image_field_without_uncertainty_uses_cautious_reason() -> None:
    request = ReviewRequest(
        page_url="https://example.test/transfer",
        business_type="transfer",
        region="default",
        page_fields={"transfer.invoice_date": "2026-08-17"},
    )
    batch = AgentBatchResult(recognized_documents=[RecognizedDocument(
        target_id="transfer-03",
        document_type="invoice",
        business_scope="transfer",
    )])

    report = evaluate_extracted(request, TRANSFER_DEFAULT, batch)
    issue = next(
        item for item in report.issues
        if item.code == "MISSING_FIELD_SOURCE" and item.field == "transfer.invoice_date"
    )

    assert issue.reason_code == "evidence_not_extracted"
    assert "图片模糊" not in issue.reason_detail
    assert "未提取到" in issue.reason_detail


def test_collected_material_explains_image_read_failure() -> None:
    request = ReviewRequest.model_validate({
        "pageUrl": "https://example.test/transfer",
        "businessType": "transfer",
        "region": "default",
        "images": [{
            "index": 1,
            "imageId": "transfer-01",
            "src": "https://example.test/registration.jpg",
            "businessScope": "transfer",
            "categoryHint": "registration_certificate",
            "collectionError": "HTTP 403",
        }],
    })

    report = evaluate_collected(request, TRANSFER_DEFAULT)
    issue = next(
        item for item in report.issues
        if item.code == "MISSING_MATERIAL"
        and item.material_type == "registration_certificate"
    )

    assert issue.reason_code == "image_unreadable"
    assert issue.reason_detail == "登记证图片读取失败，系统未取得可识别的原图内容"
