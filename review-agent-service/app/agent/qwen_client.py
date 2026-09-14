"""Qwen 文档识别客户端。

主要职责：发送受控模型请求并校验、过滤结构化提取结果。
修改日期：2026-08-26
修改人：wuyi
"""

import asyncio
import json
import re
from typing import Any

import httpx
from pydantic import ValidationError

from app.agent.config import QwenConfig
from app.agent.document_policies import (
    DocumentPolicy,
    build_classification_prompt,
    build_unknown_extraction_prompt,
)
from app.agent.models import QwenClassification, QwenExtraction


class QwenResponseSyntaxError(ValueError):
    """模型响应包含 JSON 外形，但语法无法解析。"""


class QwenResponseSchemaError(ValueError):
    """JSON 已成功解析，但内容不满足提取结果的数据结构。"""

    def __init__(self, message: str, *, detail: str = "unknown") -> None:
        """保存安全错误消息及供内部日志使用的有界结构详情。"""
        super().__init__(message)
        self.detail = detail


class QwenResponseStructureError(ValueError):
    """模型响应没有且仅有一个 JSON 对象。"""


REGISTRATION_OWNER_FIELD = "registration.initial_owner"
REGISTRATION_OWNER_CONTAMINATION = re.compile(
    r"(?:居民身份证|身份证(?:号码?)?|统一社会信用代码|组织机构代码)"
    r"|(?<!\d)\d{17}[\dXx](?!\d)"
)
FIELD_LABEL_ECHOES: dict[str, frozenset[str]] = {
    "old_vehicle.recycle_date": frozenset({"交车日期", "报废交车日期"}),
    "scrap_certificate.certificate_no": frozenset({"回收证明编号", "报废证明编号"}),
    "invoice.invoice_no": frozenset({"发票号码", "数电号码"}),
    "invoice.amount": frozenset({"价税合计", "价税合计小写", "价税合计（小写）", "开票金额"}),
    "invoice.invoice_date": frozenset({"开票日期"}),
    "new_vehicle.origin": frozenset({"产地"}),
    "invoice.terminal_certificate_no": frozenset({"统一社会信用代码", "纳税人识别号", "终端证件号"}),
    "invoice.phone": frozenset({"电话", "终端客户手机号"}),
    "vehicle.type": frozenset({"车辆类型"}),
    "vehicle.vin": frozenset({"车辆识别代号", "车辆识别代号/车架号码", "车架号码"}),
    "vehicle.plate_no": frozenset({"号牌号码", "车牌号"}),
    "vehicle.owner": frozenset({"所有人", "机动车所有人", "购买方名称"}),
    "vehicle.engine_model": frozenset({"发动机型号"}),
    "vehicle.fuel_type": frozenset({"燃料种类", "燃料类型"}),
    "vehicle.registration_date": frozenset({"注册日期"}),
}


def _drop_field_name_echoes(normalized: dict[str, Any]) -> None:
    """Drop model placeholders such as {"invoice.code": "invoice.code"}."""
    fields = normalized.get("fields")
    if not isinstance(fields, dict):
        return
    normalized["fields"] = {
        field: value
        for field, value in fields.items()
        if not (
            isinstance(value, str)
            and (
                value.strip() == field
                or value.strip() in FIELD_LABEL_ECHOES.get(field, frozenset())
            )
        )
    }


def _restrict_extraction_to_policy(
    extraction: QwenExtraction,
    policy: DocumentPolicy,
    business_scope: str,
) -> QwenExtraction:
    """只保留当前材料和业务范围白名单中的字段及证据位置。"""
    allowed = set(policy.fields_for_scope(business_scope))
    fields = {
        field: value
        for field, value in extraction.fields.items()
        if field in allowed
    }
    uncertain_fields = list(
        dict.fromkeys(
            field for field in extraction.uncertain_fields if field in allowed
        )
    )
    evidence_regions = [
        region for region in extraction.evidence_regions if region.field in allowed
    ]
    return extraction.model_copy(
        update={
            "fields": fields,
            "uncertain_fields": uncertain_fields,
            "evidence_regions": evidence_regions,
        }
    )


def _normalize_registration_owner(normalized: dict[str, Any]) -> None:
    """拒绝混入证件信息或多个主体的初始所有人，不尝试截断猜测。"""
    fields = normalized.get("fields")
    if not isinstance(fields, dict) or REGISTRATION_OWNER_FIELD not in fields:
        return
    owner = fields.get(REGISTRATION_OWNER_FIELD)
    valid = (
        isinstance(owner, str)
        and bool(owner.strip())
        and not REGISTRATION_OWNER_CONTAMINATION.search(owner)
        and "/" not in owner
        and "／" not in owner
    )
    if valid:
        return
    normalized["fields"] = {
        field: value
        for field, value in fields.items()
        if field != REGISTRATION_OWNER_FIELD
    }
    uncertain_fields = normalized.get("uncertain_fields")
    if isinstance(uncertain_fields, list) and REGISTRATION_OWNER_FIELD not in uncertain_fields:
        normalized["uncertain_fields"] = [*uncertain_fields, REGISTRATION_OWNER_FIELD]


def parse_qwen_extraction(content: str) -> QwenExtraction:
    """从模型响应中解析唯一 JSON 对象，并校验为结构化提取结果。"""
    # 兼容模型偶尔忽略“仅输出 JSON”约束而返回 Markdown 代码块的情况。
    fenced_blocks = re.findall(r"```(?:json)?\s*(.*?)```", content, flags=re.DOTALL | re.IGNORECASE)
    if fenced_blocks:
        candidates = [_decode_json_object(block.strip()) for block in fenced_blocks]
    else:
        candidates = []
        decoder = json.JSONDecoder()
        offset = 0
        while True:
            object_start = content.find("{", offset)
            if object_start < 0:
                break
            try:
                value, end = decoder.raw_decode(content[object_start:])
            except json.JSONDecodeError:
                offset = object_start + 1
                continue
            candidates.append(value)
            offset = object_start + end

    if len(candidates) != 1:
        # 多个对象存在歧义，禁止自行选择其中一个作为审核依据。
        if not candidates and "{" in content:
            raise QwenResponseSyntaxError("JSON 对象解码失败")
        raise QwenResponseStructureError("响应中的 JSON 对象不唯一或不存在")
    value = candidates[0]
    normalized = dict(value)
    fields = normalized.get("fields")
    if fields is None:
        normalized["fields"] = {}
    elif isinstance(fields, dict):
        normalized["fields"] = {
            field: field_value
            for field, field_value in fields.items()
            if field_value is not None
        }

    for collection_name in ("evidence_regions", "uncertain_fields"):
        if normalized.get(collection_name) is None:
            normalized[collection_name] = []
    uncertain_fields = normalized.get("uncertain_fields")
    if isinstance(uncertain_fields, str):
        uncertain_field = uncertain_fields.strip()
        normalized["uncertain_fields"] = [uncertain_field] if uncertain_field else []
    _drop_field_name_echoes(normalized)
    _normalize_registration_owner(normalized)

    try:
        return QwenExtraction.model_validate(normalized)
    except ValidationError as exc:
        details = []
        for item in exc.errors():
            location = ".".join(str(part) for part in item.get("loc", ())) or "root"
            error_type = str(item.get("type", "unknown"))
            details.append(f"{location}:{error_type}")
        raise QwenResponseSchemaError(
            "响应 JSON 不符合字段结构",
            detail=",".join(details[:5]),
        ) from exc


def _decode_json_object(content: str) -> dict[str, Any]:
    """解码 JSON，并确保顶层结构为对象。"""
    value = json.loads(content)
    if not isinstance(value, dict):
        raise TypeError("响应中的 JSON 不是对象")
    return value


class QwenClient:
    """发送受控视觉模型请求，并把响应转换为经过校验的领域模型。"""

    def __init__(self, config: QwenConfig, transport: httpx.AsyncBaseTransport | None = None) -> None:
        """使用指定连接配置和可选测试传输层创建客户端。"""
        self.config = config
        self.transport = transport

    async def classify_document(self, image: dict[str, Any]) -> QwenClassification:
        """仅判断未知图片的材料类型，不提取业务字段。"""
        content = await self._complete(image, build_classification_prompt())
        try:
            return QwenClassification.model_validate_json(content)
        except ValueError as exc:
            raise RuntimeError(f"Qwen 分类响应格式无效：{exc}") from exc

    async def extract_fields(
        self,
        image: dict[str, Any],
        policy: DocumentPolicy,
        *,
        retry_reason: str | None = None,
    ) -> QwenExtraction:
        """按已知材料策略提取白名单字段。"""
        image_index = int(image.get("index", 0))
        business_scope = str(image.get("business_scope", "unknown"))
        content = await self._complete(
            image,
            policy.build_extraction_prompt(
                image_index,
                business_scope,
                retry_reason=retry_reason,
            ),
        )
        try:
            extraction = parse_qwen_extraction(content)
            return _restrict_extraction_to_policy(
                extraction,
                policy,
                business_scope,
            )
        except (ValueError, TypeError) as exc:
            if isinstance(exc, json.JSONDecodeError):
                cause: BaseException = QwenResponseSyntaxError("JSON 解码失败")
            else:
                cause = exc
            raise RuntimeError(f"Qwen 字段响应格式无效：{exc}") from cause

    async def extract_unknown(
        self,
        image: dict[str, Any],
        *,
        retry_reason: str | None = None,
    ) -> QwenExtraction:
        """在一次模型调用中完成未知材料分类和受限字段提取。"""
        image_index = int(image.get("index", 0))
        business_scope = str(image.get("business_scope", "unknown"))
        content = await self._complete(
            image,
            build_unknown_extraction_prompt(
                image_index,
                business_scope,
                retry_reason=retry_reason,
            ),
        )
        try:
            return parse_qwen_extraction(content)
        except (ValueError, TypeError) as exc:
            if isinstance(exc, json.JSONDecodeError):
                cause: BaseException = QwenResponseSyntaxError("JSON 解码失败")
            else:
                cause = exc
            raise RuntimeError(f"Qwen 未分类资料响应格式无效：{exc}") from cause

    async def _complete(self, image: dict[str, Any], prompt: str) -> str:
        """调用兼容 OpenAI 协议的 Qwen 接口并返回文本内容。"""
        if not self.config.available:
            raise RuntimeError("DASHSCOPE_API_KEY 未配置")
        data_url = image.get("data_url") or image.get("src")
        payload = {
            "model": self.config.model,
            "enable_thinking": False,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": data_url}},
            ]}],
            "temperature": 0,
            "response_format": {"type": "json_object"},
        }
        headers = {"Authorization": f"Bearer {self.config.api_key}"}
        try:
            async with httpx.AsyncClient(timeout=self.config.timeout, transport=self.transport) as client:
                response = await client.post(
                    f"{self.config.base_url}/chat/completions",
                    json=payload,
                    headers=headers,
                )
                if response.status_code == 429:
                    # 对短时限流只做一次轻量重试，避免单图调用无限阻塞整批审核。
                    await asyncio.sleep(0.25)
                    response = await client.post(
                        f"{self.config.base_url}/chat/completions",
                        json=payload,
                        headers=headers,
                    )
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            if isinstance(content, list):
                content = "".join(part.get("text", "") for part in content)
            if not isinstance(content, str):
                raise TypeError("message.content 不是字符串")
            return content
        except httpx.HTTPStatusError as exc:
            detail = exc.response.text[:500].replace("\n", " ")
            raise RuntimeError(
                f"Qwen 调用失败：HTTP {exc.response.status_code} {detail}"
            ) from exc
        except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError, AttributeError) as exc:
            raise RuntimeError(f"Qwen 调用失败：{exc}") from exc
