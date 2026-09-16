"""文档识别策略与受限提示词构建。

主要职责：集中定义各类材料允许提取的字段，并根据业务范围生成字段白名单和识别提示词。
本模块只约束模型提取内容，不负责跨材料比对或生成最终审核结论。
"""

import json
from dataclasses import dataclass

COLLECTION_TYPE_INSTRUCTION = (
    "uncertain_fields 必须是 JSON 字符串数组；没有不确定字段时输出 []，"
    '只有一个时也必须输出如 ["vehicle.vin"]，禁止输出字符串、对象或 null。'
    "evidence_regions 必须是 JSON 对象数组。"
)

LAYOUT_INSTRUCTION = (
    "图片可能横向、竖向、倒置、倾斜，或把证件正反面、登记证第1页和第2页拼在同一张图中；"
    "请先根据证件标题、表格和印刷文字方向确定正确阅读方向，再逐个区域读取。"
)

RETRY_INSTRUCTIONS = {
    "low_confidence": "请重新检查整张材料，重新确认资料类型和所有清晰可见的白名单字段。",
    "invalid_json": "严格只返回一个符合既定结构的 JSON 对象，不要添加解释或代码围栏。",
    "invalid_schema": (
        "上一次响应字段类型错误，请重新输出完整 JSON。"
        "uncertain_fields 必须是字符串数组，evidence_regions 必须是对象数组，fields 必须是对象。"
    ),
    "invalid_structure": "只返回唯一 JSON 对象，不要返回示例或多个候选结果。",
    "invalid_registration_owner": (
        "上一次初始所有人识别内容混入了证件信息或其他主体。"
        "registration.initial_owner 只读取注册登记栏中的机动车所有人姓名或名称。"
    ),
    "document_type_mismatch": "重新确认资料类型，并只按该资料类型的白名单提取字段。",
    "empty_supported_fields": "重新检查材料中清晰可见的白名单字段；不要猜测不可见内容。",
}


def _append_retry_instruction(prompt: str, retry_reason: str | None) -> str:
    """仅追加预定义的安全纠错指令，不回传模型上一次响应。"""
    instruction = RETRY_INSTRUCTIONS.get(retry_reason or "")
    return f"{prompt}{instruction}" if instruction else prompt


@dataclass(frozen=True)
class DocumentPolicy:
    """定义单类材料的提取白名单及其识别指引。

    ``fields`` 使用审核领域模型中的标准字段路径；模型只能返回白名单内的字段。
    ``field_guidance`` 说明该材料的读取位置和易混淆内容，不包含审核通过或驳回规则。
    """

    document_type: str
    display_name: str
    fields: tuple[str, ...]
    field_guidance: str

    def fields_for_scope(self, business_scope: str = "unknown") -> tuple[str, ...]:
        """返回当前业务范围允许提取的字段，未知业务使用材料默认白名单。"""
        if self.document_type == "vehicle_license":
            if business_scope == "old_vehicle":
                return (
                    "vehicle.type",
                    "vehicle.vin",
                    "vehicle.plate_no",
                    "vehicle.owner",
                )
            if business_scope == "new_vehicle":
                return (
                    "vehicle.vin",
                    "vehicle.plate_no",
                    "vehicle.owner",
                    "vehicle.registration_date",
                )
        if self.document_type == "registration_certificate":
            if business_scope == "old_vehicle":
                return (
                    "vehicle.vin",
                    "vehicle.engine_model",
                    "vehicle.type",
                    "registration.covered_pages",
                )
            if business_scope == "new_vehicle":
                return (
                    "vehicle.vin",
                    "vehicle.fuel_type",
                    "registration.covered_pages",
                )
        if self.document_type == "invoice" and business_scope == "new_vehicle":
            return (
                "invoice.invoice_no",
                "invoice.amount",
                "invoice.invoice_date",
                "new_vehicle.origin",
                "invoice.terminal_certificate_no",
                "vehicle.vin",
                "vehicle.owner",
            )
        return self.fields

    def guidance_for_scope(self, business_scope: str) -> str:
        """返回匹配业务范围的材料识别指引。"""
        if self.document_type == "vehicle_license" and business_scope == "old_vehicle":
            return (
                "读取正面车辆类型、号牌号码、所有人和车辆识别代号。"
                "车辆类型保留票面完整原文。号牌号码不能读取档案编号或条形码数字；"
                "车辆识别代号不能读取车辆型号；发动机号码不是发动机型号，不要输出。"
            )
        if self.document_type == "vehicle_license" and business_scope == "new_vehicle":
            return (
                "读取正面号牌号码、所有人、车辆识别代号和注册日期。"
                "注册日期只读取‘注册日期’，不得使用发证日期、检验有效期或强制报废期代替；"
                "号牌号码不能读取档案编号或条形码数字；车辆识别代号不能读取车辆型号。"
            )
        if self.document_type == "registration_certificate" and business_scope == "old_vehicle":
            return (
                "读取注册登记机动车信息栏中的车辆类型、车辆识别代号和第12项‘发动机型号’，"
                "第11项‘发动机号码’绝不能作为发动机型号。车辆识别代号不能读取车辆型号。"
                "同时只按图片页脚实际印刷的‘第X页’输出 registration.covered_pages，不按上传顺序猜测。"
            )
        if self.document_type == "registration_certificate" and business_scope == "new_vehicle":
            return (
                "读取注册登记信息栏的车辆识别代号，以及注册登记机动车信息栏第13项‘燃料种类’。"
                "燃料种类保留票面原文；车辆识别代号不能读取车辆型号、发动机号码或合格证号。"
                "新车所有人只从新车行驶证和机动车销售发票购买方名称取得，登记证所有人不作为新车所有人证据。"
                "同时只按图片页脚实际印刷的‘第X页’输出 registration.covered_pages，不按上传顺序猜测。"
            )
        if self.document_type == "invoice" and business_scope == "new_vehicle":
            return (
                "识别机动车销售统一发票。invoice.invoice_no 只读取票面‘数电号码’或‘发票号码’后的完整号码；"
                "模型不要输出 invoice.code，发票代码页面兼容由系统处理。"
                "invoice.amount 只读取‘价税合计（小写）’，不得读取不含税价、增值税税额或中文大写金额；"
                "invoice.invoice_date 只读取开票日期；new_vehicle.origin 只读取产地；"
                "vehicle.vin 只读取车辆识别代号/车架号码，不读取合格证号。"
                "vehicle.owner 只读取购买方名称，不读取销货单位名称；"
                "invoice.terminal_certificate_no 只读取购买方的统一社会信用代码/身份证号码，"
                "不得读取销货单位纳税人识别号、电话、账号、税号、主管税务机关代码、吨位、限乘人数或其他数字。"
            )
        return self.field_guidance

    def build_extraction_prompt(
        self,
        image_index: int,
        business_scope: str = "unknown",
        *,
        retry_reason: str | None = None,
    ) -> str:
        """构建已知材料类型的提取提示词，并固定字段白名单和证据图片序号。"""
        allowed_fields = json.dumps(
            self.fields_for_scope(business_scope),
            ensure_ascii=False,
        )
        prompt = (
            f"你正在识别{self.display_name}。{LAYOUT_INSTRUCTION}{self.guidance_for_scope(business_scope)}"
            f"仅允许输出字段：{allowed_fields}。"
            "只读取图片中明确可见的内容，不推测、不补全；看不清的字段不写入 fields，"
            "并将字段名写入 uncertain_fields；版面不存在的字段不要写入 uncertain_fields，"
            "不适用的字段也不要写入 uncertain_fields。"
            "fields 是‘标准字段路径: 图片中的实际文字值’的对象，字段路径只能作为键，绝不能作为值；"
            "普通字段值保留图片中的原始文字和符号，不要替换同义词、修正易混淆字符或执行业务归类；"
            "页码数组和转移登记记录等明确要求的结构化字段按对应指引输出。"
            "只输出 JSON 对象，不使用 Markdown，不给出审核结论。"
            f'document_type 必须为 "{self.document_type}"。'
            "JSON 必须包含 document_type、fields、confidence、evidence_regions、uncertain_fields。"
            f"{COLLECTION_TYPE_INSTRUCTION}"
            f'evidence_regions 的每一项使用 field、image_index={image_index} 和 "box"，'
            "box 格式为 [x1, y1, x2, y2]。"
        )
        return _append_retry_instruction(prompt, retry_reason)


# 策略表是材料类型、字段白名单和识别指引的唯一集中配置入口。
DOCUMENT_POLICIES: dict[str, DocumentPolicy] = {
    "scrap_certificate": DocumentPolicy(
        document_type="scrap_certificate",
        display_name="报废机动车回收证明",
        fields=(
            "vehicle.type",
            "old_vehicle.recycle_date",
            "scrap_certificate.certificate_no",
            "vehicle.vin",
            "vehicle.plate_no",
            "vehicle.owner",
        ),
        field_guidance=(
            "分别读取车辆类型、交车日期、回收证明编号、车辆识别代号、号牌号码和车辆所有人。"
            "交车日期必须读取‘交车日期’后的真实日期；回收证明编号必须读取证明上的完整编号。"
        ),
    ),
    "vehicle_license": DocumentPolicy(
        document_type="vehicle_license",
        display_name="机动车行驶证或车辆资料",
        fields=(
            "vehicle.type",
            "vehicle.vin",
            "vehicle.plate_no",
            "vehicle.owner",
            "vehicle.registration_date",
        ),
        field_guidance=(
            "读取车辆类型、车辆识别代号、号牌号码、车辆所有人和注册日期。"
            "车辆识别代号不得读取车辆型号；号牌号码不得读取档案编号；"
            "注册日期不得读取发证日期或检验有效期。不要判断车辆属于旧车还是新车。"
        ),
    ),
    "registration_certificate": DocumentPolicy(
        document_type="registration_certificate",
        display_name="机动车登记证书",
        fields=(
            "vehicle.owner",
            "vehicle.vin",
            "vehicle.engine_model",
            "vehicle.type",
            "vehicle.fuel_type",
            "vehicle.registration_date",
            "registration.covered_pages",
        ),
        field_guidance=(
            "读取机动车所有人、车辆识别代号、车辆类型、燃料种类和注册登记机动车信息栏第12项‘发动机型号’。"
            "不要把发动机号码、车辆型号或其他编号当成发动机型号。"
            "同时读取图片内明确印刷的页脚页码，registration.covered_pages 只输出图片中实际可见的页码数字数组，"
            "例如页脚同时出现‘第1页’和‘第2页’时输出 [1,2]；不要按上传顺序推测。"
        ),
    ),
    "invoice": DocumentPolicy(
        document_type="invoice",
        display_name="机动车销售发票",
        fields=(
            "invoice.invoice_no",
            "invoice.amount",
            "invoice.invoice_date",
            "new_vehicle.origin",
            "invoice.terminal_certificate_no",
            "vehicle.vin",
            "vehicle.owner",
        ),
        field_guidance=(
            "读取发票号码、价税合计（小写）、开票日期、产地、车辆识别代号、购买方名称、"
            "购买方统一社会信用代码；不提取销货单位电话。"
            "模型不要输出 invoice.code；数电号码到页面发票代码的兼容由系统完成。"
            "invoice.amount 必须读取票面价税合计（小写）的实际金额，不能输出字段名称、"
            "不含税价、税额或大写金额。"
        ),
    ),
    "business_license": DocumentPolicy(
        document_type="business_license",
        display_name="营业执照",
        fields=(
            "business_license.company_name",
            "business_license.legal_representative",
            "business_license.unified_social_credit_code",
        ),
        field_guidance="只读取企业名称、法定代表人或负责人、统一社会信用代码。",
    ),
    "identity_card": DocumentPolicy(
        document_type="identity_card",
        display_name="居民身份证",
        fields=(
            "identity_card.name",
            "identity_card.side",
        ),
        field_guidance=(
            "判断图片是身份证正面还是反面，identity_card.side 只能输出 FRONT 或 BACK。"
            "正面只读取姓名；反面不输出姓名。不要读取或输出身份证号码、住址、民族、出生日期或签发机关。"
        ),
    ),
}


def build_classification_prompt() -> str:
    """构建未知图片的首阶段分类提示词，不允许同时提取业务字段。"""
    return (
        "只判断这张图片的资料类型。document_type 只能是 scrap_certificate、vehicle_license、"
        "registration_certificate、invoice、business_license、identity_card 或 unsupported。"
        "不要提取业务字段，不要输出身份证号码等敏感信息，不要给出审核结论。"
        "只输出 JSON 对象，包含 document_type、confidence、reason；confidence 取值为 0 到 1。"
    )


def build_unknown_extraction_prompt(
    image_index: int,
    business_scope: str = "unknown",
    *,
    retry_reason: str | None = None,
) -> str:
    """构建未知材料的一轮分类与提取提示词，并按业务范围限制候选字段。"""
    # 把每类材料的白名单与指引一并提供给模型，分类后只能输出命中类型对应的字段。
    policies = {
        key: {
            "name": policy.display_name,
            "fields": policy.fields_for_scope(business_scope),
            "guidance": policy.guidance_for_scope(business_scope),
        }
        for key, policy in DOCUMENT_POLICIES.items()
    }
    prompt = (
        f"请判断资料类型并提取图片中明确可见的审核字段。{LAYOUT_INSTRUCTION}"
        "document_type 只能是 scrap_certificate、vehicle_license、registration_certificate、"
        "invoice、business_license、identity_card 或 unsupported。旧车和新车是页面业务归属，不是图片资料类型。"
        f"各类型字段白名单：{json.dumps(policies, ensure_ascii=False)}。"
        "只能输出最终 document_type 对应白名单中的字段，不推测、不补全，不给出审核结论。"
        "fields 是‘标准字段路径: 图片中的实际文字值’的对象，字段路径只能作为键，绝不能作为值；"
        "普通字段值保留图片中的原始文字和符号，不自行修正、归类或补全。"
        "看不清的字段写入 uncertain_fields；版面不存在的字段不要写入 uncertain_fields，"
        "不适用的字段也不要写入 uncertain_fields。"
        "只输出 JSON 对象，包含 document_type、fields、confidence、evidence_regions、uncertain_fields。"
        f"{COLLECTION_TYPE_INSTRUCTION}"
        f'evidence_regions 使用 image_index={image_index} 和 "box"=[x1,y1,x2,y2]。'
    )
    return _append_retry_instruction(prompt, retry_reason)
