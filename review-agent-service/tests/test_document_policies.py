from app.agent.document_policies import (
    DOCUMENT_POLICIES,
    build_classification_prompt,
    build_unknown_extraction_prompt,
)


def test_transfer_registration_prompt_requests_structured_history() -> None:
    prompt = DOCUMENT_POLICIES["registration_certificate"].build_extraction_prompt(
        2, "transfer"
    )

    assert "registration.covered_pages" in prompt
    assert "registration.initial_owner" in prompt
    assert "registration.transfer_records" in prompt
    assert "vehicle.engine_model" not in prompt
    assert "版面不存在的字段不要写入 uncertain_fields" in prompt
    assert "图片内印刷" in prompt
    assert "第3页" in prompt
    assert "第4页" in prompt
    assert "covered_pages=[3,4]" in prompt
    assert "抵押登记" in prompt
    assert "解除抵押" in prompt
    assert "全部明确可见" in prompt
    assert "最新一条" in prompt
    assert "最新所有人" in prompt
    assert "最新转让登记日期" in prompt
    assert "owner、date、page、order" in prompt
    assert "YYYY-MM-DD" in prompt
    assert "registration.initial_owner 只读取" in prompt
    assert "居民身份证" in prompt
    assert "抵押权人" in prompt


def test_transfer_invoice_prompt_requests_only_transfer_fields() -> None:
    prompt = DOCUMENT_POLICIES["invoice"].build_extraction_prompt(4, "transfer")

    assert "invoice.buyer_name" in prompt
    assert "invoice.seller_name" in prompt
    assert "invoice.invoice_date" in prompt
    assert "invoice.code" not in prompt
    assert "invoice.amount" not in prompt


def test_each_supported_document_has_a_specific_allowlist() -> None:
    assert DOCUMENT_POLICIES["scrap_certificate"].fields == (
        "old_vehicle.recycle_date",
        "scrap_certificate.certificate_no",
        "vehicle.vin",
        "vehicle.plate_no",
        "vehicle.owner",
    )
    assert DOCUMENT_POLICIES["vehicle_license"].fields == (
        "vehicle.vin",
        "vehicle.plate_no",
        "vehicle.owner",
    )
    assert DOCUMENT_POLICIES["registration_certificate"].fields == (
        "vehicle.owner",
        "vehicle.vin",
        "vehicle.engine_model",
    )
    assert DOCUMENT_POLICIES["invoice"].fields == (
        "invoice.code",
        "invoice.invoice_no",
        "invoice.amount",
        "invoice.invoice_date",
        "new_vehicle.origin",
        "vehicle.vin",
        "vehicle.plate_no",
        "vehicle.owner",
    )
    assert DOCUMENT_POLICIES["business_license"].fields == (
        "business_license.company_name",
        "business_license.legal_representative",
        "business_license.unified_social_credit_code",
    )


def test_prompts_restrict_model_scope_and_output_contract() -> None:
    invoice_prompt = DOCUMENT_POLICIES["invoice"].build_extraction_prompt(image_index=3)

    assert "机动车销售发票" in invoice_prompt
    assert "invoice.code" in invoice_prompt
    assert "old_vehicle.vin" not in invoice_prompt
    assert '"box"' in invoice_prompt
    assert "image_index=3" in invoice_prompt

    classification_prompt = build_classification_prompt()
    assert "unsupported" in classification_prompt
    assert "不要提取业务字段" in classification_prompt
    assert "身份证信息" in classification_prompt


def test_engine_model_is_extracted_only_from_registration_certificate() -> None:
    engine_field = "vehicle.engine_model"

    assert engine_field in DOCUMENT_POLICIES["registration_certificate"].fields
    assert all(
        engine_field not in policy.fields
        for document_type, policy in DOCUMENT_POLICIES.items()
        if document_type != "registration_certificate"
    )
    assert "registration_certificate" in build_classification_prompt()


def test_registration_certificate_prompt_fields_follow_business_scope() -> None:
    policy = DOCUMENT_POLICIES["registration_certificate"]

    old_prompt = policy.build_extraction_prompt(
        image_index=2,
        business_scope="old_vehicle",
    )
    new_prompt = policy.build_extraction_prompt(
        image_index=2,
        business_scope="new_vehicle",
    )

    assert "vehicle.owner" in old_prompt
    assert "vehicle.vin" in old_prompt
    assert "vehicle.engine_model" in old_prompt
    assert "vehicle.owner" in new_prompt
    assert "vehicle.vin" in new_prompt
    assert "vehicle.engine_model" not in new_prompt


def test_combined_prompt_restricts_registration_fields_by_business_scope() -> None:
    old_prompt = build_unknown_extraction_prompt(2, "old_vehicle")
    new_prompt = build_unknown_extraction_prompt(2, "new_vehicle")

    assert "vehicle.engine_model" in old_prompt
    assert "vehicle.engine_model" not in new_prompt


def test_combined_prompt_uses_physical_vehicle_type_and_neutral_fields() -> None:
    prompt = build_unknown_extraction_prompt(image_index=2)

    assert "vehicle_license" in prompt
    assert "vehicle.vin" in prompt
    assert "vehicle.plate_no" in prompt
    assert "vehicle.owner" in prompt
    assert '"old_vehicle"' not in prompt
    assert '"new_vehicle"' not in prompt
