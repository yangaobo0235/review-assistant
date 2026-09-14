"""材料清单和证据来源完整性评估。"""

from collections.abc import Iterable

from app.agent.field_routing import route_fields
from app.agent.models import (
    AgentBatchResult,
    MaterialChecklistItem,
    MaterialCompletenessIssue,
    MaterialCompletenessReport,
    MaterialFieldDetail,
)
from app.businesses.material_policies import SourceSelector
from app.businesses.profiles import BusinessProfile
from app.models.review import FieldObservation, ReviewRequest
from app.rules.review_fields import SCRAP_PAGE_FIELD_LABELS

FIELD_LABELS = {
    **SCRAP_PAGE_FIELD_LABELS,
    "registration.covered_pages": "登记证页码",
    "new_vehicle.origin": "新车发票产地",
    "identity_card.name": "身份证姓名",
    "identity_card.side": "身份证正反面",
    "business_license.company_name": "企业名称",
    "business_license.legal_representative": "法定代表人",
    "business_license.unified_social_credit_code": "统一社会信用代码",
    "transfer.plate_no": "车牌号",
    "transfer.vin": "车架号",
    "transfer.buyer_name": "买方名称",
    "transfer.seller_name": "卖方名称",
    "transfer.invoice_date": "开票日期",
}
SOURCE_LABELS = {
    "page": "申请页面",
    "invoice": "二手车发票",
    "registration_certificate": "登记证第2页",
}
MATERIAL_LABELS = {
    "scrap_certificate": "报废证明",
    "vehicle_license": "行驶证",
    "registration_certificate": "机动车登记证",
    "invoice": "发票",
    "business_license": "营业执照",
    "identity_card": "身份证",
}
UNCERTAIN_FIELD_ROUTES = {
    "invoice": {
        "vehicle.plate_no": "transfer.plate_no",
        "vehicle.vin": "transfer.vin",
        "invoice.buyer_name": "transfer.buyer_name",
        "invoice.seller_name": "transfer.seller_name",
        "invoice.invoice_date": "transfer.invoice_date",
    },
    "registration_certificate": {
        "vehicle.vin": "transfer.vin",
    },
}


def _issue(code: str, message: str, action: str, **kwargs: object) -> MaterialCompletenessIssue:
    return MaterialCompletenessIssue(code=code, message=message, suggested_action=action, **kwargs)


def _dedupe(items: Iterable[MaterialCompletenessIssue]) -> list[MaterialCompletenessIssue]:
    seen: set[tuple[object, ...]] = set()
    result = []
    for item in items:
        key = (
            item.code,
            item.material_type,
            item.business_scope,
            item.field,
            tuple(item.missing_pages),
            tuple(item.missing_sources),
        )
        if key not in seen:
            seen.add(key)
            result.append(item)
    return result


def _status(issues: list[MaterialCompletenessIssue]) -> str:
    return "COMPLETE" if not issues else "UNCERTAIN" if any(item.code in {"AMBIGUOUS_REQUIRED_FIELD", "IMAGE_SELECTION_OVERFLOW", "UNCERTAIN_MATERIAL", "UNCERTAIN_REQUIRED_FIELD"} for item in issues) else "INCOMPLETE"


def _material_key(document_type: str, business_scope: str) -> str:
    return f"{business_scope}:{document_type}"


def evaluate_collected(request: ReviewRequest, profile: BusinessProfile) -> MaterialCompletenessReport:
    policy = profile.material_policy
    if policy is None or policy.mode == "disabled":
        return MaterialCompletenessReport(phase="COLLECTED", status="COMPLETE", enforced=False)
    issues: list[MaterialCompletenessIssue] = []
    checklist: list[MaterialChecklistItem] = []
    diagnostics = request.collection_diagnostics
    if diagnostics.image_overflow:
        issues.append(_issue("IMAGE_SELECTION_OVERFLOW", "候选资料超过选择上限，请确认是否漏审", "请确认未被截断的审核材料"))
    for field in diagnostics.ambiguous_fields:
        if field in profile.required_fields:
            issues.append(_issue("AMBIGUOUS_REQUIRED_FIELD", f"页面字段“{field}”存在多个冲突候选", "请人工确认页面字段", field=field))
    for requirement in policy.materials:
        candidates = [
            image for image in request.images
            if image.business_scope == requirement.business_scope
            and image.category_hint == requirement.document_type
        ]
        matches = [image for image in candidates if not image.collection_error]
        status = "PRESENT"
        reason = "页面已采集到对应材料图片"
        if len(matches) < requirement.minimum_count:
            if candidates and any(image.collection_error for image in candidates):
                status = "UNCERTAIN"
                reason_code = "image_unreadable"
                reason_detail = f"{requirement.display_name.removeprefix('机动车')}图片读取失败，系统未取得可识别的原图内容"
                message = f"{requirement.display_name}图片无法读取"
                action = "请重新加载原图或补充可正常打开的图片"
            else:
                status = "MISSING"
                reason_code = "material_missing"
                reason_detail = "页面未采集到对应材料图片"
                message = f"缺少{requirement.display_name}"
                action = f"请补充{requirement.display_name}"
            issues.append(_issue(
                "MISSING_MATERIAL",
                message,
                action,
                reason_code=reason_code,
                reason_detail=reason_detail,
                material_type=requirement.document_type,
                business_scope=requirement.business_scope,
            ))
            reason = message
        checklist.append(MaterialChecklistItem(
            key=_material_key(requirement.document_type, requirement.business_scope),
            display_name=requirement.display_name,
            material_type=requirement.document_type,
            business_scope=requirement.business_scope,
            status=status,
            required_pages=list(requirement.required_pages),
            image_ids=[str(image.image_id or image.index) for image in candidates],
            reason=reason,
        ))
    if diagnostics.collection_issues:
        issues.append(_issue("COLLECTION_FAILURE", "图片采集存在异常", "请重新采集审核材料"))
    return MaterialCompletenessReport(
        phase="COLLECTED",
        status=_status(issues),
        enforced=policy.mode == "enforce",
        issues=_dedupe(issues),
        checklist=checklist,
    )


def _matches(selector: SourceSelector, observation: FieldObservation, batch: AgentBatchResult) -> bool:
    if observation.source_type != selector.source_type:
        return False
    if selector.document_type and observation.document_type != selector.document_type:
        return False
    if selector.business_scope and observation.business_scope != selector.business_scope:
        return False
    if selector.required_page is None:
        return observation.value not in (None, "")
    for document in batch.recognized_documents:
        if document.target_id == observation.source_id and selector.required_page in document.covered_pages:
            return observation.value not in (None, "")
    return False


def _documents_for_selector(
    selector: SourceSelector,
    batch: AgentBatchResult,
) -> list[object]:
    return [
        document
        for document in batch.recognized_documents
        if (not selector.document_type or document.document_type == selector.document_type)
        and (not selector.business_scope or document.business_scope == selector.business_scope)
    ]


def _field_is_uncertain(document: object, field: str) -> bool:
    document_type = str(getattr(document, "document_type", ""))
    uncertain_fields = getattr(document, "uncertain_fields", [])
    return any(
        raw_field == field
        or UNCERTAIN_FIELD_ROUTES.get(document_type, {}).get(str(raw_field)) == field
        for raw_field in uncertain_fields
    )


def _image_ids_for_selector(selector: SourceSelector, request: ReviewRequest) -> set[str]:
    return {
        str(image.image_id or image.index)
        for image in request.images
        if (not selector.document_type or image.category_hint == selector.document_type)
        and (not selector.business_scope or image.business_scope == selector.business_scope)
    }


def _missing_source_reason(
    field: str,
    selector: SourceSelector,
    request: ReviewRequest,
    batch: AgentBatchResult,
) -> tuple[str, str]:
    if selector.source_type == "page":
        return "page_field_missing", "申请页面未采集到该字段，请检查页面字段是否为空或未加载"
    documents = _documents_for_selector(selector, batch)
    if any(_field_is_uncertain(document, field) for document in documents):
        if field == "transfer.invoice_date":
            return "recognition_uncertain", "日期区域可能模糊、遮挡或不可辨认"
        return "recognition_uncertain", "图片可能模糊、遮挡或关键信息不可辨认"
    image_ids = _image_ids_for_selector(selector, request)
    if any(
        image.collection_error and str(image.image_id or image.index) in image_ids
        for image in request.images
    ):
        return "image_unreadable", "图片读取失败，系统未能取得可识别的原图内容"
    if image_ids & (set(batch.failed_image_ids) | set(batch.timed_out_image_ids)):
        return "recognition_failed", "图片识别失败或超时，未能生成可靠证据"
    return "evidence_not_extracted", "现有图片中未提取到该字段，无法判断是内容未展示还是清晰度不足"


def _missing_pages_reason(
    matching: list[object],
    request: ReviewRequest,
    batch: AgentBatchResult,
    business_scope: str,
) -> tuple[str, str]:
    if any("registration.covered_pages" in getattr(document, "uncertain_fields", []) for document in matching):
        return "recognition_uncertain", "图片可能模糊、遮挡，导致页码区域或页面内容不可辨认"
    selector = SourceSelector("image", "registration_certificate", business_scope)
    image_ids = _image_ids_for_selector(selector, request)
    if image_ids & (set(batch.failed_image_ids) | set(batch.timed_out_image_ids)):
        return "recognition_failed", "登记证图片识别失败或超时，未能确认页面范围"
    return "evidence_not_extracted", "已收到登记证图片，但未提取到这些页码，无法确认图片是否包含对应页面"


def evaluate_extracted(request: ReviewRequest, profile: BusinessProfile, batch: AgentBatchResult) -> MaterialCompletenessReport:
    policy = profile.material_policy
    if policy is None or policy.mode == "disabled":
        return MaterialCompletenessReport(phase="EXTRACTED", status="COMPLETE", enforced=False)
    issues: list[MaterialCompletenessIssue] = []
    checklist: list[MaterialChecklistItem] = []
    documents = [document for document in batch.recognized_documents if document.business_scope]
    for requirement in policy.materials:
        matching = [document for document in documents if document.document_type == requirement.document_type and document.business_scope == requirement.business_scope]
        present_pages = sorted({page for document in matching for page in document.covered_pages})
        missing_pages = sorted(set(requirement.required_pages) - set(present_pages))
        candidate_images = [
            image for image in request.images
            if image.category_hint == requirement.document_type
            and image.business_scope == requirement.business_scope
        ]
        image_ids = [str(image.image_id or image.index) for image in candidate_images]
        failed_ids = set(batch.failed_image_ids) | set(batch.timed_out_image_ids)
        status = "PRESENT"
        reason = "材料类型和必需页码已确认"
        if len(matching) < requirement.minimum_count:
            status = "UNCERTAIN" if candidate_images else "MISSING"
            issue_code = (
                "UNCERTAIN_MATERIAL" if status == "UNCERTAIN" else "MISSING_MATERIAL"
            )
            recognition_failed = bool(set(image_ids) & failed_ids)
            reason = (
                f"{requirement.display_name}识别失败或超时"
                if recognition_failed
                else f"{requirement.display_name}已上传，但材料类型无法确认"
                if status == "UNCERTAIN"
                else f"缺少{requirement.display_name}"
            )
            issues.append(_issue(
                issue_code,
                reason,
                (
                    "请检查对应原图并确认材料类型；如图片模糊，请补充清晰图片"
                    if status == "UNCERTAIN"
                    else f"请补充{requirement.display_name}"
                ),
                reason_code=(
                    "recognition_failed"
                    if recognition_failed
                    else "recognition_uncertain"
                    if status == "UNCERTAIN"
                    else "material_missing"
                ),
                material_type=requirement.document_type,
                business_scope=requirement.business_scope,
            ))
        if missing_pages and matching:
            page_text = "、".join(str(page) for page in missing_pages)
            reason_code, reason_detail = _missing_pages_reason(
                matching,
                request,
                batch,
                requirement.business_scope,
            )
            issues.append(_issue(
                "MISSING_REGISTRATION_PAGES",
                f"{requirement.display_name}第{page_text}页未能确认",
                "请检查对应页原图；如图片模糊、遮挡或缺页，请补充清晰完整图片",
                reason_code=reason_code,
                reason_detail=reason_detail,
                material_type=requirement.document_type,
                business_scope=requirement.business_scope,
                required_pages=list(requirement.required_pages),
                present_pages=present_pages,
                missing_pages=missing_pages,
            ))
            status = "UNCERTAIN"
            reason = f"第{page_text}页未能确认"
        checklist.append(MaterialChecklistItem(
            key=_material_key(requirement.document_type, requirement.business_scope),
            display_name=requirement.display_name,
            material_type=requirement.document_type,
            business_scope=requirement.business_scope,
            status=status,
            required_pages=list(requirement.required_pages),
            present_pages=present_pages,
            missing_pages=missing_pages,
            image_ids=[document.target_id for document in matching] or image_ids,
            reason=reason,
        ))
    for requirement in policy.field_sources:
        observations = [item for item in batch.observations if isinstance(item, FieldObservation) and item.field == requirement.field]
        missing_selectors = []
        for selector in requirement.all_of:
            present = (
                request.page_fields.get(requirement.field) not in (None, "")
                if selector.source_type == "page"
                else any(_matches(selector, item, batch) for item in observations)
            )
            if not present:
                missing_selectors.append(selector)
        if missing_selectors:
            reasons = [
                _missing_source_reason(requirement.field, selector, request, batch)
                for selector in missing_selectors
            ]
            reason_priority = {
                "image_unreadable": 0,
                "recognition_failed": 1,
                "recognition_uncertain": 2,
                "page_field_missing": 3,
                "evidence_not_extracted": 4,
            }
            reason_code, reason_detail = min(
                reasons,
                key=lambda item: reason_priority[item[0]],
            )
            missing_sources = sorted({
                selector.document_type or selector.source_type
                for selector in missing_selectors
            })
            field_label = FIELD_LABELS.get(requirement.field, requirement.field)
            source_text = "、".join(SOURCE_LABELS.get(source, source) for source in missing_sources)
            issues.append(_issue(
                "MISSING_FIELD_SOURCE",
                f"{field_label}缺少{source_text}证据",
                "请检查对应页面或原图；如内容不清晰，请补充清晰图片",
                reason_code=reason_code,
                reason_detail=reason_detail,
                field=requirement.field,
                missing_sources=missing_sources,
            ))
    for document in documents:
        if document.uncertain_fields:
            matching_issue = next((
                issue
                for issue in issues
                if issue.reason_code == "recognition_uncertain"
                and issue.business_scope in {None, document.business_scope}
                and (
                    issue.material_type == document.document_type
                    or (
                        issue.field is not None
                        and _field_is_uncertain(document, issue.field)
                    )
                )
            ), None)
            material_name = next((
                item.display_name for item in policy.materials
                if item.document_type == document.document_type and item.business_scope == document.business_scope
            ), MATERIAL_LABELS.get(document.document_type, "审核材料"))
            details = []
            for raw_field in dict.fromkeys(document.uncertain_fields):
                routed, _ = route_fields(document.business_scope, document.document_type, {raw_field: "待核对"})
                field = next(iter(routed), raw_field)
                candidates = [item for item in batch.observations
                              if item.source_type == "image" and item.field in {field, raw_field}
                              and (document.target_id in {item.source_id, item.image_id}
                                   or document.image_index is not None and item.image_index == document.image_index)]
                value = document.uncertain_values.get(raw_field)
                if raw_field not in document.uncertain_values and candidates:
                    value = candidates[0].value
                image = next((item for item in request.images
                              if str(item.image_id or item.index) == document.target_id
                              or document.image_index is not None and item.index == document.image_index), None)
                details.append(MaterialFieldDetail(
                    field=field, field_label=FIELD_LABELS.get(field, "未明确的识别字段"),
                    material_name=material_name, value=value,
                    image_id=str(image.image_id or image.index) if image else document.target_id,
                    image_index=image.index if image else document.image_index,
                ))
            if matching_issue is not None:
                matching_issue.field_details.extend(details)
            else:
                issues.append(_issue(
                    "UNCERTAIN_REQUIRED_FIELD",
                    f"{material_name}存在无法确认的字段",
                    "请核对以下字段和对应原图；确实无法辨认时再补充清晰图片",
                    field_details=details,
                    reason_code="recognition_uncertain",
                    reason_detail="图片可能模糊、遮挡或关键信息不可辨认",
                    material_type=document.document_type,
                    business_scope=document.business_scope,
                ))
    return MaterialCompletenessReport(
        phase="EXTRACTED",
        status=_status(issues),
        enforced=policy.mode == "enforce",
        issues=_dedupe(issues),
        checklist=checklist,
    )
