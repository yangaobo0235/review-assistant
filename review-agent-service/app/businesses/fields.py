"""报废置换审核的主要字段清单及展示名称。

清单与标签的唯一来源是业务扩展包 `app.businesses.packs`；本模块只做导出
和分组，不再单独维护一份。
"""

from app.businesses.packs import SCRAP_REPLACEMENT_PACK as _PACK

_SECTION_KEYS = _PACK.section_field_keys()

# 分区 → 必审字段，顺序与扩展包中的声明顺序一致。
OLD_VEHICLE_FIELDS = _SECTION_KEYS["old_vehicle"]
NEW_VEHICLE_AND_INVOICE_FIELDS = _SECTION_KEYS["new_vehicle"]
PRIMARY_REVIEW_FIELDS = _PACK.required_keys()
TRANSFER_REVIEW_FIELDS: tuple[str, ...] = ()

# 报废置换页面控件的已知语义。实际字段数量和顺序来自每次 DOM 采集，
# 不能用本表推导页面字段总数。
SCRAP_PAGE_FIELD_LABELS = _PACK.labels()

# 客户名称由主体关系规则取得材料侧候选，同时仍须作为页面字段独立展示。
SCRAP_FIELD_BY_AFFILIATION_CHECK_ID = {
    "AFFILIATION-AUX-CUSTOMER-NAME": "application.customer_name",
}
