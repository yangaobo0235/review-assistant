"""报废置换审核的业务声明（青岛与长春共用）。

字段与材料的定义在两地之间完全一致；地区差异只在政策窗口、产地范围和
能力 ID 上，由各自的 Profile 与 ReplacementPolicy 声明。
"""

from datetime import date

from app.businesses.material_policies import MaterialPolicy, MaterialRequirement
from app.businesses.packs.model import (
    AuthorityRule,
    BusinessExtensionPack,
    FieldDeclaration,
    MaterialDeclaration,
    PageGroupDeclaration,
    RegionDeclaration,
    RouteDeclaration,
    SectionDeclaration,
)
from app.businesses.replacement_policies import ReplacementPolicy
from app.capabilities.specs import CapabilityBinding, CapabilitySpec
from app.models.review import Region

OLD_SECTION = "old_vehicle"
NEW_SECTION = "new_vehicle"

# 地区政策：发票日期窗口、交车截止日和产地范围。这些是政策边界，
# 变更必须走版本升级，不得原地修改。
QINGDAO_REPLACEMENT_POLICY = ReplacementPolicy(
    policy_id="scrap_replacement_qingdao",
    region=Region.QINGDAO,
    version="1.0",
    invoice_date_from=date(2026, 9, 1),
    invoice_date_to=date(2026, 9, 30),
    disposal_deadline=date(2026, 10, 31),
    allowed_origins=("青岛", "青岛市", "山东省青岛市"),
)

CHANGCHUN_REPLACEMENT_POLICY = ReplacementPolicy(
    policy_id="scrap_replacement_changchun",
    region=Region.CHANGCHUN,
    version="1.0",
    invoice_date_from=date(2026, 7, 1),
    invoice_date_to=date(2026, 9, 30),
    disposal_deadline=date(2026, 12, 31),
    allowed_origins=("长春", "长春市", "吉林省长春市"),
    origin_keywords=("长春",),
)

# 必须采集的材料及页码要求。
SCRAP_REPLACEMENT_MATERIAL_POLICY = MaterialPolicy(
    mode="enforce",
    materials=(
        MaterialRequirement("vehicle_license", OLD_SECTION, display_name="旧车行驶证"),
        MaterialRequirement(
            "registration_certificate",
            OLD_SECTION,
            required_pages=(1, 2),
            display_name="旧车登记证第 1、2 页",
        ),
        MaterialRequirement("scrap_certificate", OLD_SECTION, display_name="报废证明"),
        MaterialRequirement("vehicle_license", NEW_SECTION, display_name="新车行驶证"),
        MaterialRequirement(
            "registration_certificate",
            NEW_SECTION,
            required_pages=(1, 2),
            display_name="新车登记证第 1、2 页",
        ),
        MaterialRequirement("invoice", NEW_SECTION, display_name="新车发票"),
    ),
)


SCRAP_REPLACEMENT_PACK = BusinessExtensionPack(
    business_type="scrap_replacement",
    scopes=(OLD_SECTION, NEW_SECTION),
    sections=(
        SectionDeclaration(OLD_SECTION, "报废车辆信息"),
        SectionDeclaration(NEW_SECTION, "新车及发票信息"),
    ),
    fields=(
        FieldDeclaration(
            key="old_vehicle.type",
            label="报废车辆类型",
            section=OLD_SECTION,
            aliases=("报废车辆类型",),
            page_section=OLD_SECTION,
            mode="PARALLEL",
            sources=("vehicle_license", "registration_certificate", "scrap_certificate"),
            normalizer="vehicle_type",
            required=True,
        ),
        FieldDeclaration(
            key="old_vehicle.recycle_date",
            label="报废交车日期",
            section=OLD_SECTION,
            aliases=("报废交车日期", "报废车日期"),
            page_section=OLD_SECTION,
            mode="SINGLE_SOURCE",
            sources=("scrap_certificate",),
            normalizer="date",
            required=True,
        ),
        FieldDeclaration(
            key="scrap_certificate.certificate_no",
            label="报废证明编号",
            section=OLD_SECTION,
            aliases=("报废证明编号", "回收证明编号"),
            page_section=OLD_SECTION,
            mode="SINGLE_SOURCE",
            sources=("scrap_certificate",),
            required=True,
        ),
        FieldDeclaration(
            key="old_vehicle.vin",
            label="报废车辆车架号",
            section=OLD_SECTION,
            aliases=("报废车辆车架号", "旧车车架号", "车架号"),
            page_section=OLD_SECTION,
            section_required=True,
            mode="PARALLEL",
            sources=("vehicle_license", "registration_certificate"),
            normalizer="vin",
            authority=(
                AuthorityRule("qr_page", "二维码官网"),
                AuthorityRule("page", "申请页面", required=True),
                AuthorityRule(
                    "image",
                    "行驶证或登记证",
                    ("vehicle_license", "registration_certificate"),
                    "suffix8",
                ),
            ),
            required=True,
        ),
        FieldDeclaration(
            key="old_vehicle.plate_no",
            label="报废车辆车牌号",
            section=OLD_SECTION,
            aliases=("报废车辆车牌号", "旧车车牌号", "车牌号"),
            page_section=OLD_SECTION,
            section_required=True,
            mode="SINGLE_SOURCE",
            sources=("vehicle_license",),
            normalizer="plate",
            required=True,
        ),
        FieldDeclaration(
            key="old_vehicle.owner",
            label="报废车辆所有人",
            section=OLD_SECTION,
            aliases=("报废车辆所有人", "旧车所有人", "车辆所有人", "所有人"),
            page_section=OLD_SECTION,
            section_required=True,
            mode="PARALLEL",
            sources=("vehicle_license", "scrap_certificate"),
            normalizer="party_name",
            required=True,
        ),
        FieldDeclaration(
            key="old_vehicle.engine_model",
            label="报废发动机型号",
            section=OLD_SECTION,
            aliases=("报废发动机型号", "发动机型号"),
            page_section=OLD_SECTION,
            mode="SINGLE_SOURCE",
            sources=("registration_certificate",),
            required=True,
        ),
        FieldDeclaration(
            key="new_vehicle.fuel_type",
            label="新车燃料类型",
            section=NEW_SECTION,
            aliases=("新车燃料类型",),
            page_section=NEW_SECTION,
            mode="SINGLE_SOURCE",
            sources=("registration_certificate",),
            required=True,
        ),
        FieldDeclaration(
            key="invoice.code",
            label="发票代码",
            section=NEW_SECTION,
            aliases=("发票代码",),
            page_section=NEW_SECTION,
            mode="SINGLE_SOURCE",
            sources=("invoice",),
            required=True,
        ),
        FieldDeclaration(
            key="invoice.invoice_no",
            label="发票号码",
            section=NEW_SECTION,
            aliases=("发票号码",),
            page_section=NEW_SECTION,
            mode="SINGLE_SOURCE",
            sources=("invoice",),
            required=True,
        ),
        FieldDeclaration(
            key="invoice.amount",
            label="开票金额",
            section=NEW_SECTION,
            aliases=("开票金额",),
            page_section=NEW_SECTION,
            mode="SINGLE_SOURCE",
            sources=("invoice",),
            normalizer="amount",
            required=True,
        ),
        FieldDeclaration(
            key="invoice.invoice_date",
            label="开票日期",
            section=NEW_SECTION,
            aliases=("开票日期", "发票日期"),
            page_section=NEW_SECTION,
            mode="SINGLE_SOURCE",
            sources=("invoice",),
            normalizer="date",
            required=True,
        ),
        FieldDeclaration(
            key="new_vehicle.vin",
            label="新车车架号",
            section=NEW_SECTION,
            aliases=("新车车架号", "车架号"),
            page_section=NEW_SECTION,
            section_required=True,
            mode="PARALLEL",
            sources=("vehicle_license", "registration_certificate", "invoice"),
            normalizer="vin",
            required=True,
        ),
        FieldDeclaration(
            key="new_vehicle.plate_no",
            label="新车车牌号",
            section=NEW_SECTION,
            aliases=("新车车牌号", "车牌号"),
            page_section=NEW_SECTION,
            section_required=True,
            mode="SINGLE_SOURCE",
            sources=("vehicle_license",),
            normalizer="plate",
            required=True,
        ),
        FieldDeclaration(
            key="new_vehicle.owner",
            label="新车所有人",
            section=NEW_SECTION,
            aliases=("新车所有人", "车辆所有人", "所有人"),
            page_section=NEW_SECTION,
            section_required=True,
            mode="PARALLEL",
            sources=("vehicle_license", "invoice"),
            normalizer="party_name",
            required=True,
        ),
        FieldDeclaration(
            key="new_vehicle.registration_date",
            label="注册日期",
            section=NEW_SECTION,
            aliases=("注册日期",),
            page_section=NEW_SECTION,
            mode="SINGLE_SOURCE",
            sources=("vehicle_license",),
            normalizer="date",
            required=True,
        ),
        FieldDeclaration(
            key="application.terminal_certificate_no",
            label="终端证件号",
            section=NEW_SECTION,
            aliases=("终端证件号",),
            page_section=NEW_SECTION,
            mode="SINGLE_SOURCE",
            sources=("invoice",),
            required=True,
        ),
        FieldDeclaration(
            key="application.customer_name",
            label="客户名称",
            section=NEW_SECTION,
            aliases=("客户名称",),
            page_section="unknown",
            mode="SINGLE_SOURCE",
            sources=("invoice",),
            normalizer="party_name",
            required=True,
        ),
        FieldDeclaration(
            key="application.terminal_phone",
            label="终端客户手机号",
            section=NEW_SECTION,
            aliases=("终端客户手机号",),
            page_section=NEW_SECTION,
            mode="SYSTEM",
            required=True,
        ),
        FieldDeclaration(
            key="application.id",
            label="申请单ID",
            aliases=("申请单ID", "申请单编号"),
            page_section="unknown",
        ),
        FieldDeclaration(
            key="application.submitted_at",
            label="申请时间",
            aliases=("申请时间",),
            page_section="unknown",
            reviewable=False,
        ),
        FieldDeclaration(
            key="application.owner_type",
            label="车辆所有人类型",
            aliases=("车辆所有人类型",),
            page_section="unknown",
            mode="SYSTEM",
        ),
        FieldDeclaration(
            key="application.dealer_name",
            label="经销商",
            aliases=("经销商",),
            page_section=OLD_SECTION,
            reviewable=False,
        ),
        FieldDeclaration(
            key="page_ocr.new_vehicle_vin",
            label="OCR新车车架号",
            aliases=("OCR新车车架号",),
            page_section="unknown",
            material_field="new_vehicle.vin",
        ),
        FieldDeclaration(
            key="old_vehicle.affiliation",
            label="报废车挂靠",
            aliases=(),
            page_section="unknown",
            mode="DERIVED",
        ),
        FieldDeclaration(
            key="new_vehicle.affiliation",
            label="新车挂靠",
            aliases=(),
            page_section="unknown",
            mode="DERIVED",
        ),
    ),
    materials=(
        MaterialDeclaration(
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
            guidance=(
                "分别读取车辆类型、交车日期、回收证明编号、车辆识别代号、号牌号码和车辆所有人。"
                "交车日期必须读取‘交车日期’后的真实日期；回收证明编号必须读取证明上的完整编号。"
            ),
            hints=("报废证明", "回收证明", "报废车辆资料", "旧车资料"),
            slots=(("old_vehicle", 3),),
            scoped_vehicle_fields=("vin", "plate_no", "owner", "type", "registration_date", "fuel_type"),
            # 回收证明只属于旧车资料区域。
            allowed_scopes=(OLD_SECTION,),
        ),
        MaterialDeclaration(
            document_type="vehicle_license",
            display_name="机动车行驶证或车辆资料",
            fields=(
                "vehicle.type",
                "vehicle.vin",
                "vehicle.plate_no",
                "vehicle.owner",
                "vehicle.registration_date",
            ),
            guidance=(
                "读取车辆类型、车辆识别代号、号牌号码、车辆所有人和注册日期。"
                "车辆识别代号不得读取车辆型号；号牌号码不得读取档案编号；"
                "注册日期不得读取发证日期或检验有效期。不要判断车辆属于旧车还是新车。"
            ),
            scoped_fields=(
                ("old_vehicle", ("vehicle.type", "vehicle.vin", "vehicle.plate_no", "vehicle.owner")),
                (
                    "new_vehicle",
                    (
                        "vehicle.vin",
                        "vehicle.plate_no",
                        "vehicle.owner",
                        "vehicle.registration_date",
                    ),
                ),
            ),
            scoped_guidance=(
                (
                    "old_vehicle",
                    ("读取正面车辆类型、号牌号码、所有人和车辆识别代号。"
                    "车辆类型保留票面完整原文。号牌号码不能读取档案编号或条形码数字；"
                    "车辆识别代号不能读取车辆型号；发动机号码不是发动机型号，不要输出。"),
                ),
                (
                    "new_vehicle",
                    ("读取正面号牌号码、所有人、车辆识别代号和注册日期。"
                    "注册日期只读取‘注册日期’，不得使用发证日期、检验有效期或强制报废期代替；"
                    "号牌号码不能读取档案编号或条形码数字；车辆识别代号不能读取车辆型号。"),
                ),
            ),
            hints=("行驶证", "旧车资料", "新车资料", "报废车辆资料"),
            slots=(("old_vehicle", 1), ("new_vehicle", 1)),
            scoped_vehicle_fields=("vin", "plate_no", "owner", "type", "registration_date", "fuel_type"),
        ),
        MaterialDeclaration(
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
            guidance=(
                "读取机动车所有人、车辆识别代号、车辆类型、燃料种类和注册登记机动车信息栏第12项‘发动机型号’。"
                "不要把发动机号码、车辆型号或其他编号当成发动机型号。"
                "同时读取图片内明确印刷的页脚页码，registration.covered_pages 只输出图片中实际可见的页码数字数组，"
                "例如页脚同时出现‘第1页’和‘第2页’时输出 [1,2]；不要按上传顺序推测。"
            ),
            scoped_fields=(
                (
                    "old_vehicle",
                    (
                        "vehicle.vin",
                        "vehicle.engine_model",
                        "vehicle.type",
                        "registration.covered_pages",
                    ),
                ),
                ("new_vehicle", ("vehicle.vin", "vehicle.fuel_type", "registration.covered_pages")),
            ),
            scoped_guidance=(
                (
                    "old_vehicle",
                    ("读取注册登记机动车信息栏中的车辆类型、车辆识别代号和第12项‘发动机型号’，"
                    "第11项‘发动机号码’绝不能作为发动机型号。车辆识别代号不能读取车辆型号。"
                    "同时只按图片页脚实际印刷的‘第X页’输出 registration.covered_pages，不按上传顺序猜测。"),
                ),
                (
                    "new_vehicle",
                    ("读取注册登记信息栏的车辆识别代号，以及注册登记机动车信息栏第13项‘燃料种类’。"
                    "燃料种类保留票面原文；车辆识别代号不能读取车辆型号、发动机号码或合格证号。"
                    "新车所有人只从新车行驶证和机动车销售发票购买方名称取得，登记证所有人不作为新车所有人证据。"
                    "同时只按图片页脚实际印刷的‘第X页’输出 registration.covered_pages，不按上传顺序猜测。"),
                ),
            ),
            hints=("登记证书", "机动车登记证", "旧车资料", "新车资料"),
            slots=(("old_vehicle", 2), ("new_vehicle", 2)),
        ),
        MaterialDeclaration(
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
            guidance=(
                "读取发票号码、价税合计（小写）、开票日期、产地、车辆识别代号、购买方名称、"
                "购买方统一社会信用代码；不提取销货单位电话。"
                "模型不要输出 invoice.code；数电号码到页面发票代码的兼容由系统完成。"
                "invoice.amount 必须读取票面价税合计（小写）的实际金额，不能输出字段名称、"
                "不含税价、税额或大写金额。"
            ),
            scoped_fields=(
                (
                    "new_vehicle",
                    (
                        "invoice.invoice_no",
                        "invoice.amount",
                        "invoice.invoice_date",
                        "new_vehicle.origin",
                        "invoice.terminal_certificate_no",
                        "vehicle.vin",
                        "vehicle.owner",
                    ),
                ),
            ),
            scoped_guidance=(
                (
                    "new_vehicle",
                    ("识别机动车销售统一发票。invoice.invoice_no 只读取票面‘数电号码’或‘发票号码’后的完整号码；"
                    "模型不要输出 invoice.code，发票代码页面兼容由系统处理。"
                    "invoice.amount 只读取‘价税合计（小写）’，不得读取不含税价、增值税税额或中文大写金额；"
                    "invoice.invoice_date 只读取开票日期；new_vehicle.origin 只读取产地；"
                    "vehicle.vin 只读取车辆识别代号/车架号码，不读取合格证号。"
                    "vehicle.owner 只读取购买方名称，不读取销货单位名称；"
                    "invoice.terminal_certificate_no 只读取购买方的统一社会信用代码/身份证号码，"
                    "不得读取销货单位纳税人识别号、电话、账号、税号、主管税务机关代码、吨位、限乘人数或其他数字。"),
                ),
            ),
            hints=("发票", "新车资料"),
            slots=(("new_vehicle", 3),),
            scoped_vehicle_fields=("vin", "plate_no", "owner", "type", "registration_date", "fuel_type"),
            # 新车发票只属于新车资料区域。
            allowed_scopes=(NEW_SECTION,),
        ),
        MaterialDeclaration(
            document_type="business_license",
            display_name="营业执照",
            fields=(
                "business_license.company_name",
                "business_license.legal_representative",
                "business_license.unified_social_credit_code",
            ),
            guidance="只读取企业名称、法定代表人或负责人、统一社会信用代码。",
            hints=("营业执照",),
            scope_independent=True,
        ),
        MaterialDeclaration(
            document_type="identity_card",
            display_name="居民身份证",
            fields=(
                "identity_card.name",
                "identity_card.side",
            ),
            guidance=(
                "判断图片是身份证正面还是反面，identity_card.side 只能输出 FRONT 或 BACK。"
                "正面只读取姓名；反面不输出姓名。不要读取或输出身份证号码、住址、民族、出生日期或签发机关。"
            ),
            hints=("身份证",),
            scope_independent=True,
        ),
    ),
    # 页面上的图片分组标题 → 业务分区。同一个分区可能对应多个标题：
    # 生产页面改过文案，旧标题仍要能识别，否则那批图片会丢掉分区。
    page_groups=(
        PageGroupDeclaration("报废车辆资料", OLD_SECTION, "报废车辆资料"),
        PageGroupDeclaration("报废车辆信息", OLD_SECTION, "报废车辆信息"),
        PageGroupDeclaration("报废车资料", OLD_SECTION, "报废车资料"),
        PageGroupDeclaration("旧车资料", OLD_SECTION, "旧车资料"),
        PageGroupDeclaration("新车资料", NEW_SECTION, "新车资料"),
        PageGroupDeclaration("新车及发票信息", NEW_SECTION, "新车及发票信息"),
        PageGroupDeclaration("新车及发票资料", NEW_SECTION, "新车及发票资料"),
        PageGroupDeclaration("发票资料", NEW_SECTION, "发票资料"),
        PageGroupDeclaration("营业执照", "business_license", "营业执照"),
        PageGroupDeclaration("身份证正面", "identity", "身份证正面"),
        PageGroupDeclaration("身份证反面", "identity", "身份证反面"),
        PageGroupDeclaration("身份证", "identity", "身份证"),
        PageGroupDeclaration("其他图片", "other", "其他图片"),
    ),
    # 材料字段 → 领域字段。没有列在这里的车辆通用字段走上面的后缀规则。
    routes=(
        # 回收证明只属于旧车区，交车日期和证明编号按原名通过。
        # 登记证书：只认 vehicle. 前缀（不接受 old_vehicle./new_vehicle. 这类
        # 兼容写法），字段逐条显式声明，所以不使用通用的车辆前缀规则。
        RouteDeclaration("registration_certificate", "vehicle.vin", ("{scope}.vin",)),
        RouteDeclaration("registration_certificate", "vehicle.type", ("{scope}.type",)),
        RouteDeclaration("registration_certificate", "vehicle.fuel_type", ("{scope}.fuel_type",)),
        RouteDeclaration(
            "registration_certificate",
            "vehicle.registration_date",
            ("{scope}.registration_date",),
        ),
        RouteDeclaration("scrap_certificate", "old_vehicle.recycle_date", ("old_vehicle.recycle_date",)),
        RouteDeclaration(
            "scrap_certificate",
            "scrap_certificate.certificate_no",
            ("scrap_certificate.certificate_no",),
        ),
        # 登记证书：证件上的发动机型号只属于旧车，新车不读该字段。
        RouteDeclaration(
            "registration_certificate",
            "vehicle.engine_model",
            ("{scope}.engine_model",),
            scope=OLD_SECTION,
        ),
        RouteDeclaration(
            "registration_certificate",
            "old_vehicle.engine_model",
            ("old_vehicle.engine_model",),
            scope=OLD_SECTION,
        ),
        # 发票：购买方名称同时支撑新车所有人和客户名称，避免客户名称因
        # 没有独立识别键而被判信息不足。
        RouteDeclaration("invoice", "invoice.invoice_no", ("invoice.invoice_no",)),
        RouteDeclaration("invoice", "invoice.amount", ("invoice.amount",)),
        RouteDeclaration("invoice", "invoice.invoice_date", ("invoice.invoice_date",)),
        RouteDeclaration("invoice", "new_vehicle.origin", ("new_vehicle.origin",)),
        RouteDeclaration(
            "invoice",
            "invoice.terminal_certificate_no",
            ("application.terminal_certificate_no",),
        ),
        RouteDeclaration(
            "invoice",
            "vehicle.owner",
            ("new_vehicle.owner", "application.customer_name"),
            scope=NEW_SECTION,
        ),
    ),
    # 同一业务的地区差异：政策、页面地址和版本。字段与材料在地区之间共用。
    regions=(
        RegionDeclaration(
            Region.QINGDAO,
            replacement_policy=QINGDAO_REPLACEMENT_POLICY,
            admin_paths=("/scrap-replace-qingdao",),
        ),
        RegionDeclaration(
            Region.CHANGCHUN,
            replacement_policy=CHANGCHUN_REPLACEMENT_POLICY,
            admin_paths=("/scrap-replace-changchun",),
        ),
    ),
    # 地区无关的能力绑定；地区政策能力由 RegionDeclaration 推导。
    capability_specs=(
        CapabilitySpec(
            "material_completeness", kind="MATERIAL", stage="INPUT_COVERAGE",
            output_facts=("material.coverage",), failure_policy="MANUAL_REVIEW",
        ),
        CapabilitySpec(
            "scrap_certificate_qr", kind="EXTERNAL", stage="EVIDENCE",
            required=True, dependencies=("old_vehicle",), timeout_seconds=60,
            output_facts=("qr.valid", "scrap_certificate.verified"),
            failure_policy="MANUAL_REVIEW",
        ),
        CapabilitySpec(
            "affiliation_subject", kind="RULE", stage="FINAL_REVIEW",
            output_facts=("subject.relation",), failure_policy="MANUAL_REVIEW",
        ),
        # 只提出页面动作，不产出检查项；失败不应产生人工复核任务。
        CapabilitySpec(
            "verify_invoice", kind="RULE", stage="POST_COMPARE",
            required=False, output_facts=("invoice.verification",),
            failure_policy="SAFE_DEGRADE",
        ),
    ),
    binding_declarations=(
        CapabilityBinding("material_completeness"),
        CapabilityBinding("scrap_certificate_qr", required=True),
        CapabilityBinding("affiliation_subject"),
        CapabilityBinding("verify_invoice", required=False),
    ),
    page_action_ids=("fill_affiliation_fields",),
    page_interaction=True,
    material_policy=SCRAP_REPLACEMENT_MATERIAL_POLICY,
)
