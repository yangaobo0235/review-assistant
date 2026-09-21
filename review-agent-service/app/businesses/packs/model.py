"""业务扩展包：一个审核业务的声明式描述。

同一份业务数据目前有五处投影——字段清单与中文标签、字段证据策略、材料提取
白名单与读取指引、材料字段路由、前端 DOM 别名。它们各自维护，新增业务时
必须在多处各改一遍，且改漏一处不会报错，只会静默降级为人工复核。

业务扩展包把这份数据收敛成一份声明，各投影从它派生。派生函数只产出数据，
接入运行时由各投影模块自行决定；在确认派生结果与现有实现完全一致之前，
两边并行存在（见 `tests/test_pack_equivalence.py`）。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from app.businesses.material_policies import (
    DEFAULT_RETRY_POLICY,
    MaterialPolicy,
    RetryPolicy,
)
from app.businesses.replacement_policies import ReplacementPolicy
from app.capabilities.specs import CapabilityBinding, CapabilitySpec
from app.models.review import Region

EvidenceMode = Literal[
    "SYSTEM", "SINGLE_SOURCE", "AVAILABLE_EVIDENCE", "PARALLEL", "PAGE_AUXILIARY", "DERIVED"
]


@dataclass(frozen=True)
class AuthorityRule:
    """证据权威链上的一环。

    多条规则按顺序构成权威链：**链首来源是唯一比较基准**，其余来源是比对
    目标，各自按自己的 `match` 窗口与基准比对。链首缺失时结论降级为人工
    复核，不会退让给链上的下一条来源——这正是"最高标准"的含义。

    权威由业务声明，不由票数推断；因此新增字段只需声明权威链，不必再写
    一个专用的裁决函数。`label` 只用于生成面向审核员的理由文本。
    """

    source: Literal["qr_page", "page", "image"]
    label: str
    document_types: tuple[str, ...] = ()
    match: Literal["full", "suffix8"] = "full"
    # 该来源缺失时直接人工复核（例如页面值缺失就没有可比对的对象）。
    required: bool = False

    def __post_init__(self) -> None:
        if self.source not in ("qr_page", "page", "image"):
            raise ValueError(f"未知权威来源：{self.source}")
        if self.match not in ("full", "suffix8"):
            raise ValueError(f"未知比较窗口：{self.match}")


@dataclass(frozen=True)
class FieldDeclaration:
    """一个字段的全部声明。"""

    key: str
    label: str
    # Profile 里的展示分区。与 `page_section` 是两件事：这里决定后端把字段
    # 归到哪个分区，`page_section` 决定它在页面 DOM 的哪个区域。
    section: str = ""
    # 页面上的中文别名，供前端 DOM 采集使用。第一个是页面上最常见的写法。
    aliases: tuple[str, ...] = ()
    # 字段在页面 DOM 中所属的区域；未识别时为 "unknown"。
    page_section: str = "unknown"
    # 采集时必须落在 `page_section` 指定的区域内，否则判定为歧义。
    section_required: bool = False
    # 该字段在页面上是可核验的控件（False 表示只读展示）。
    reviewable: bool = True
    # 证据策略；None 表示该字段只用于展示或写回，不参与材料比对。
    mode: EvidenceMode | None = None
    sources: tuple[str, ...] = ()
    allow_single_evidence: bool = True
    normalizer: str = "default"
    authority: tuple[AuthorityRule, ...] = ()
    # 该页面字段与另一个材料字段共用同一份证据策略（如发票代码与号码双值）。
    material_field: str | None = None
    # 该字段进入 Profile 的必审清单。
    required: bool = False
    # 是否允许审核员把这个字段的值写回页面控件。默认不允许：写回是不可逆的
    # 页面操作，每个字段都要单独声明。浏览器侧还有字段白名单和控件类型两道闸，
    # 声明为可写不等于页面上一定会出现回填按钮。
    writable: bool = False
    # 日期时效：字段的日期必须落在「审核日往前推 N 天」到今天之间（含两端）。
    # None 表示不检查。超出不自动判不通过，而是降为人工复核——时效是政策口径，
    # 边上的一天之差通常要靠人判断。同一个页面在不同日期审核可能得到不同结果，
    # 这是政策本身的性质。
    max_age_days: int | None = None


@dataclass(frozen=True)
class MaterialDeclaration:
    """一类材料的声明。"""

    document_type: str
    display_name: str
    fields: tuple[str, ...] = ()
    guidance: str = ""
    # 业务范围（业务分区）对白名单、读取指引和显示名的覆写。
    scoped_fields: tuple[tuple[str, tuple[str, ...]], ...] = ()
    scoped_guidance: tuple[tuple[str, str], ...] = ()
    # 一份材料被多个业务共用时（如行驶证），不同业务的称呼可能不同，
    # 识别提示词里的称呼按业务分区覆写，避免车源审核的行驶证提示词
    # 沿用报废置换的“行驶证或车辆资料”。
    scoped_names: tuple[tuple[str, str], ...] = ()
    # 页面分组文字，供前端识别该材料的图片区域。
    hints: tuple[str, ...] = ()
    # 该材料允许出现的业务分区；空元组表示不限制。
    allowed_scopes: tuple[str, ...] = ()
    # 该材料不属于业务分区（如营业执照、身份证）：字段按材料自身白名单原样
    # 通过，不参与旧车/新车的分区判定。
    scope_independent: bool = False
    # 该材料上跟随页面分区落位的字段后缀：材料写作 vehicle.X（或旧/新前缀）
    # 时落到 {当前分区}.X。只列出的后缀跟随分区；未列出且没有显式路由规则的
    # 字段一律丢弃，避免材料上的无关字段冒充领域字段。
    scoped_vehicle_fields: tuple[str, ...] = ()
    # 上传槽位：(业务分区, 组内序号)。页面上同一分区的材料按固定顺序排列，
    # 类型识别不确定时用槽位兜底；前后端共用这一份，不要各写一遍。
    slots: tuple[tuple[str, int], ...] = ()

    def fields_for_scope(self, scope: str) -> tuple[str, ...]:
        for key, fields in self.scoped_fields:
            if key == scope:
                return fields
        return self.fields

    def guidance_for_scope(self, scope: str) -> str:
        for key, guidance in self.scoped_guidance:
            if key == scope:
                return guidance
        return self.guidance

    def name_for_scope(self, scope: str) -> str:
        for key, name in self.scoped_names:
            if key == scope:
                return name
        return self.display_name


@dataclass(frozen=True)
class RouteDeclaration:
    """材料字段 → 领域字段的路由规则。

    `scope` 为空表示适用于该材料的所有分区；`targets` 里的 `{scope}` 会被
    当前分区替换。同一条规则可以把一个材料字段映射到多个领域字段
    （例如发票购买方名称同时支撑新车所有人和客户名称）。
    """

    document_type: str
    source_field: str
    targets: tuple[str, ...]
    scope: str = ""


@dataclass(frozen=True)
class SectionDeclaration:
    """PageProfile 里的一个字段分区。"""

    key: str
    title: str


@dataclass(frozen=True)
class PageGroupDeclaration:
    """页面上的图片分组标题 → 业务分区。

    同一个分区可能对应多个标题（生产页面改过文案），因此是标题到分区的多对一映射。
    """

    label: str
    scope: str
    title: str


@dataclass(frozen=True)
class RegionDeclaration:
    """同一业务在不同地区的差异。

    字段、材料和能力绑定在地区之间共用；只有地区政策、页面地址和版本可能
    不同。地区政策能力 ID 由地区推导（`{region}_replacement_policy`），
    不需要单独声明。
    """

    region: Region
    version: str = "1.0"
    replacement_policy: ReplacementPolicy | None = None
    # 该地区审核页面的 URL 路径。
    admin_paths: tuple[str, ...] = ()

    def policy_capability_id(self) -> str | None:
        return f"{self.region.value}_replacement_policy" if self.replacement_policy else None


@dataclass(frozen=True)
class BusinessExtensionPack:
    """一个业务、地区、版本的完整声明。"""

    business_type: str
    # 该业务认可的图片业务分区（如旧车 / 新车）。采集到的图片落在这些
    # 分区之外时，字段一律不路由，转为人工复核。
    scopes: tuple[str, ...] = ()
    sections: tuple[SectionDeclaration, ...] = ()
    fields: tuple[FieldDeclaration, ...] = ()
    materials: tuple[MaterialDeclaration, ...] = ()
    # 页面上的图片分组标题 → 业务分区。
    page_groups: tuple[PageGroupDeclaration, ...] = ()
    # 材料字段 → 领域字段的路由规则。
    routes: tuple[RouteDeclaration, ...] = ()
    # 各地区变体；字段与材料在地区之间共用。
    regions: tuple[RegionDeclaration, ...] = ()
    # 能力绑定与规格（地区无关部分）。地区政策能力由 RegionDeclaration 推导。
    capability_specs: tuple[CapabilitySpec, ...] = ()
    binding_declarations: tuple[CapabilityBinding, ...] = ()
    # 允许的页面动作 ID 与是否启用页内交互。
    page_action_ids: tuple[str, ...] = ()
    page_interaction: bool = False
    # 允许浏览器写回的控件类型（`ReviewFieldSnapshot.control_type` 的取值，
    # 如 text / textarea / number / select / date）。**空元组表示不限制**，
    # 供没有声明过类型的业务沿用历史口径；新增业务应当显式声明，只放开
    # 浏览器写回器验证过的类型，没验证过的一律交人工填写。
    writable_control_kinds: tuple[str, ...] = ()
    # 页面指纹锚点：能唯一标识"这条审核记录"的字段。浏览器用有值的锚点拼出
    # 指纹，页面写回和原图定位都以它为前提；一个强锚点（`*.vin` 或
    # `application.id`）都没有时指纹为空，这些操作全部拒绝执行。
    # **必须按业务声明**：写死成某一个业务的字段名会让别的业务永远拿不到指纹。
    identity_anchors: tuple[str, ...] = ()
    # 规则检查项 → 页面字段：(check_id, field)。规则结论同时投影成该字段的
    # 核验条目，审核员在字段视图里就能看到结论，不必到页面外核验里找。
    # 一个字段可以绑定多条检查，投影时按最坏状态合并。
    field_check_bindings: tuple[tuple[str, str], ...] = ()
    # 本业务的审核字段就是声明的字段：页面上其他控件不进审核目录。
    # False（默认）表示未配置核验来源的页面控件仍保留一条“请人工核对”条目，
    # 避免页面控件被静默忽略。
    review_declared_fields_only: bool = False
    # 该业务的材料要求和受控执行预算。
    material_policy: MaterialPolicy | None = None
    retry_policy: RetryPolicy = DEFAULT_RETRY_POLICY

    def region(self, region: Region) -> RegionDeclaration | None:
        return next((item for item in self.regions if item.region == region), None)

    def check_bindings_by_field(self) -> dict[str, tuple[str, ...]]:
        """页面字段 → 投影到它上面的规则检查项，保持声明顺序。"""
        grouped: dict[str, list[str]] = {}
        for check_id, field in self.field_check_bindings:
            grouped.setdefault(field, []).append(check_id)
        return {field: tuple(check_ids) for field, check_ids in grouped.items()}

    def capabilities_for(self, declaration: RegionDeclaration) -> tuple[CapabilitySpec, ...]:
        """该地区的完整能力规格：共用部分 + 地区政策能力。"""
        specs = list(self.capability_specs)
        policy_id = declaration.policy_capability_id()
        if policy_id is not None:
            specs.append(
                CapabilitySpec(
                    policy_id,
                    kind="RULE",
                    stage="POST_COMPARE",
                    output_facts=("replacement.eligible",),
                    failure_policy="MANUAL_REVIEW",
                )
            )
        return tuple(specs)

    def bindings_for(self, declaration: RegionDeclaration) -> tuple[CapabilityBinding, ...]:
        """该地区的完整能力绑定：共用部分 + 地区政策能力。"""
        bindings = list(self.binding_declarations)
        policy_id = declaration.policy_capability_id()
        if policy_id is not None:
            bindings.append(CapabilityBinding(policy_id))
        return tuple(bindings)

    def field(self, key: str) -> FieldDeclaration | None:
        return next((item for item in self.fields if item.key == key), None)

    def required_keys(self) -> tuple[str, ...]:
        """必审字段，按声明顺序。"""
        return tuple(item.key for item in self.fields if item.required)

    def section_field_keys(self) -> dict[str, tuple[str, ...]]:
        """分区 → 必审字段键。"""
        grouped: dict[str, list[str]] = {}
        for item in self.fields:
            if item.required:
                grouped.setdefault(item.section, []).append(item.key)
        return {key: tuple(value) for key, value in grouped.items()}

    def labels(self) -> dict[str, str]:
        """字段键 → 中文标签。"""
        return {item.key: item.label for item in self.fields}

    def writable_field_keys(self) -> tuple[str, ...]:
        """允许写回的字段键，保持声明顺序。

        这是浏览器写回白名单的唯一来源；浏览器侧还有控件类型闸，声明为可写
        的字段在页面上渲染成下拉/日期控件时同样不允许写回。
        """
        return tuple(item.key for item in self.fields if item.writable)

    def material(self, document_type: str) -> MaterialDeclaration | None:
        return next(
            (item for item in self.materials if item.document_type == document_type),
            None,
        )


def slot_document_types(pack: BusinessExtensionPack) -> dict[tuple[str, int], str]:
    """(业务分区, 组内序号) → 材料类型；用于类型识别不确定时兜底。"""
    return {
        slot: material.document_type
        for material in pack.materials
        for slot in material.slots
    }


def build_collect_manifest(pack: BusinessExtensionPack) -> dict[str, object]:
    """生成前端页面采集清单。

    前端据此完成字段别名匹配、图片业务分区判定和材料分组，不再各自维护
    一份表。只包含需要在页面上采集的字段（有中文别名的）。
    """
    return {
        "business_type": pack.business_type,
        # 该业务认定的材料分区。前端据此判断图片是否属于审核材料、以及
        # 哪些分区的图片优先入选。
        "scopes": list(pack.scopes),
        "page_groups": [
            {"label": item.label, "scope": item.scope, "title": item.title}
            for item in pack.page_groups
        ],
        "fields": [
            {
                "key": item.key,
                "label": item.label,
                "aliases": list(item.aliases),
                "section": item.page_section,
                "section_required": item.section_required,
                "reviewable": item.reviewable,
            }
            for item in pack.fields
            if item.aliases
        ],
        # 允许写回的字段：**单独一张表，不能从 `fields` 里筛**。上面那张表只
        # 收录有中文别名的采集字段，而挂靠这类只用于操作、没有别名的字段同样
        # 允许写回；按 `fields` 过滤会静默丢掉它们。
        "writable_fields": list(pack.writable_field_keys()),
        # 允许写回的控件类型；空列表表示不限制（历史业务口径）。
        "writable_control_kinds": list(pack.writable_control_kinds),
        # 页面指纹锚点：浏览器用它判断"还是不是同一条审核记录"。
        "identity_anchors": list(pack.identity_anchors),
        "materials": [
            {
                "document_type": item.document_type,
                "label": item.display_name,
                "hints": list(item.hints),
                # 槽位按 material 分组下发，前端据此在类型不确定时兜底。
                "slots": [list(slot) for slot in item.slots],
            }
            for item in pack.materials
        ],
    }

