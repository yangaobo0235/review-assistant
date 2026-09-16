# 长春报废置换审核规则（`scrap_replacement | changchun | 1.0`）

本文档是长春 Profile 的业务基线。代码实现分别位于后端 `app/businesses/profiles.py`、`app/businesses/replacement_policies.py`、`app/rules/replacement_policy_checks.py`、`app/rules/material_completeness.py`、`app/rules/affiliation_subject_checks.py`，以及前端 `src/adapters`、`src/browser`、`src/components` 和 `src/session`。长春与青岛共用审核流程和材料策略，但政策窗口、产地范围和能力 ID 必须保持地区一致。旧车 VIN、发票/新车 VIN 组合核验、手机号和材料展示遵循通用字段协议：二维码官网 VIN 为最高标准，行驶证/登记证只核对后 8 位；发票代码/号码、新车 VIN/OCR VIN 先校验页面双值一致再比材料；手机号只认页面值；材料任务只显示是否齐全。

`Profile`（业务配置档案）定义长春这一业务版本；`Registry`（注册表）按 ID 查找实现；`Capability`（审核能力）由 `Handler`（处理器）或 `Subgraph`（子图）执行；`Renderer`（渲染器）负责前端工作台展示。本文中的代码 ID 保持英文以便与实现对应，后文首次出现的专业术语均按此含义理解。

## 1. Profile 身份和启用范围

| 项目 | 配置 |
| --- | --- |
| `business_type` | `scrap_replacement` |
| `region` | `changchun` |
| `version` | `1.0` |
| `rules_configured` | `true` |
| 页面路径识别 | URL 包含 `/scrap-replace-changchun` |
| 前端工作台 | `FIELD_WORKBENCH` |
| 页面动作 | `fill_affiliation_fields` |
| 失败默认策略 | `MANUAL_REVIEW` |

地区、版本和页面指纹必须同时匹配。不能因为页面字段结构与青岛相同，就把青岛 Profile 或政策替换给长春；后端启动时会校验 Profile、政策地区、版本和规则 ID 的一致性。

## 2. 必审字段

长春使用与青岛相同的标准字段集合：

- 旧车：`old_vehicle.type`、`old_vehicle.recycle_date`、`scrap_certificate.certificate_no`、`old_vehicle.vin`、`old_vehicle.plate_no`、`old_vehicle.owner`、`old_vehicle.engine_model`。
- 新车和发票：`new_vehicle.fuel_type`、`invoice.code`、`invoice.invoice_no`、`invoice.amount`、`invoice.invoice_date`、`new_vehicle.vin`、`new_vehicle.plate_no`、`new_vehicle.owner`、`new_vehicle.registration_date`、`application.terminal_certificate_no`、`application.customer_name`、`application.terminal_phone`。

页面附加字段 `application.owner_type`、`application.dealer_name`、`application.submitted_at` 和 `page_ocr.new_vehicle_vin` 只用于展示、主体类型声明或组合字段核验，不能被前端转化为资格结论。

## 3. 材料清单和页码

长春 Profile 使用 `SCRAP_REPLACEMENT_MATERIAL_POLICY`，模式为 `enforce`。必须采集旧车行驶证、旧车登记证第 1、2 页、报废证明、新车行驶证、新车登记证第 1、2 页和新车发票。采集阶段与识别阶段分别校验图片读取、材料类型和页码。

缺少图片为 `MISSING_MATERIAL`；图片存在但读取失败或识别不确定为 `UNCERTAIN_MATERIAL`；登记证必需页未确认时为 `MISSING_REGISTRATION_PAGES` 并进入人工复核。材料覆盖不足不会阻止不依赖该材料的能力运行，但最终建议必须保留缺失任务。

## 4. 后端能力绑定

| 能力 ID | 类型/阶段 | 是否必需 | 产出 | 失败行为 |
| --- | --- | --- | --- | --- |
| `material_completeness` | MATERIAL / `INPUT_COVERAGE` | 是 | `material.coverage` | 人工复核 |
| `scrap_certificate_qr` | EXTERNAL / `EVIDENCE` | 是 | `qr.valid`、`scrap_certificate.verified` | 人工复核 |
| `changchun_replacement_policy` | RULE / `POST_COMPARE` | 是 | `replacement.eligible` | 人工复核 |
| `affiliation_subject` | RULE / `FINAL_REVIEW` | 是 | `subject.relation` | 人工复核 |

二维码能力依赖旧车材料，默认超时 60 秒。解码、网页核验和模型识别的重试都必须留下 `RetrySummary`，外部服务不可用时记录降级，不得自动通过。

## 5. 长春地区政策规则

政策 ID 为 `scrap_replacement_changchun`，版本 `1.0`。三项政策检查读取与青岛相同的指定图片字段，但使用长春自己的范围：

1. **新车发票日期**：`invoice.invoice_date` 必须在 **2026-07-01 至 2026-09-30（含边界）**。缺失、格式无效、多个冲突值或 OCR 不确定为 `INSUFFICIENT`；超出范围为 `CONFLICT`。
2. **回收证明交车日期**：`old_vehicle.recycle_date` 必须不晚于 **2026-12-31**。缺失、格式无效或证据不唯一为 `INSUFFICIENT`；晚于截止日为 `CONFLICT`。
3. **新车发票产地**：`new_vehicle.origin` 必须规范化后包含“长春”关键词，允许“长春”“长春市”“吉林省长春市”等包含该关键词的值。无法取得唯一值为 `INSUFFICIENT`，明确不包含关键词为 `CONFLICT`。

检查 ID 仍为 `POLICY-INVOICE-DATE`、`POLICY-DISPOSAL-DEADLINE` 和 `POLICY-NEW-ORIGIN`，但解释文本必须引用长春政策范围。展示层会把发票日期和报废交车日期政策结果合并到对应字段卡片，不再单独显示页面外日期核验；不能仅通过检查 ID 判断地区，响应中的 Profile 和政策版本也必须保留。

## 6. 主体关系和挂靠规则

长春复用统一的 `affiliation_subject` 规则：识别个人或公司主体，验证个人身份证正反面、公司营业执照和法定代表人，再比较旧车与新车主体关系。个人同名、同公司名称且营业执照确认、两家公司法人相同、公司法人等于个人姓名时可以 `MATCH`；姓名或法人不同为 `CONFLICT`；材料缺失、多份冲突或主体类型无法可靠判断为 `INSUFFICIENT`。

只有主体关系 `MATCH` 且 `owner_type`（主体类型）明确为 `PERSONAL`（个人）或 `COMPANY`（公司）时，才能产生 `old_vehicle.affiliation` 与 `new_vehicle.affiliation` 两个回填意图。前端据此自动选择两个挂靠下拉框；任一主体证据不完整都必须保持人工复核，不能因为政策日期和产地通过就自动填写挂靠字段。客户名称、VIN 等辅助检查可以单独要求审核，但不覆盖已明确的主体类型结论。

## 7. 前端行为

前端业务选择显示为“长春报废置换审核”，自动识别路径为 `/scrap-replace-changchun`，手动选择产生 `scrap_replacement / changchun / 1.0`。长春和青岛共享 `ScrapReplacementReview` Renderer，但通过 Profile Key 绑定，不能在组件中写地区判断来替代后端规则。

工作台展示材料清单、字段比较、二维码结果、政策检查、主体证据和降级原因。前端只负责呈现和用户操作；日期范围、产地关键词、材料是否足够和主体关系均由后端决定。

页面动作只能通过注册的 `fill_affiliation_fields` 执行，必须一次准备两个动作、校验页面实例和原值、写入后回读并在失败时回滚。刷新页面或重新采集后，旧动作自动失效。

长春页面遵守统一的[审核工作台前端展示规范](../frontend-presentation.md)：日期或产地冲突显示红色并同时显示页面/材料值，缺失材料、识别不确定、二维码不可用和政策无法校验显示橙色待复核状态；发票日期和报废交车日期政策直接显示在字段卡片。材料只保留一个 `MATERIAL-GROUP`，且只展示材料是否齐全，不展示识别异常。组合字段显示两个页面原始值，点击回填时两个页面字段必须原子写入、回读和失败回滚。带 `page_target_field` 的冲突任务显示默认页面原值的人工输入框和“回填此值”，成功后定位并高亮页面控件约 4 秒，回读失败则显示错误并回滚。主体关系通过且动作意图合法时自动选择个人/公司挂靠，页面失效时所有写回按钮立即禁用。

## 8. 规则变更记录

任何日期窗口、产地关键词、材料要求、能力依赖、任务 ID 或页面权限变化，都要创建新版本或提供迁移说明，更新本文档、`docs/business-rules.md` 和相关测试。禁止复制青岛配置再改几个字符串；应在 Profile、ReplacementPolicy 和注册表中显式声明长春差异。

## 9. Profile、注册表和绑定清单

### 后端 BusinessRegistry

```text
BusinessType.SCRAP_REPLACEMENT
  + Region.CHANGCHUN
  + version 1.0
  → SCRAP_REPLACEMENT_CHANGCHUN
```

该 Profile 由 `BUSINESS_PROFILES` 注册到 `BusinessRegistry`，键为 `scrap_replacement / changchun / 1.0`。长春必须精确解析自己的 Profile，不能使用青岛的地区政策作为默认回退。

### CapabilityRegistry 绑定

| 注册能力 | `CapabilitySpec.kind` | stage | dependencies | required | failure policy |
| --- | --- | --- | --- | --- | --- |
| `material_completeness`（材料完整性） | `MATERIAL`（材料能力） | `INPUT_COVERAGE`（输入覆盖阶段） | 无 | 是 | `MANUAL_REVIEW`（人工复核） |
| `scrap_certificate_qr`（报废证明二维码核验） | `EXTERNAL`（外部核验） | `EVIDENCE`（证据阶段） | `old_vehicle`（旧车材料） | 是 | `MANUAL_REVIEW`（人工复核） |
| `changchun_replacement_policy`（长春置换政策） | `RULE`（业务规则） | `POST_COMPARE`（字段比较后阶段） | 规范字段和证据 | 是 | `MANUAL_REVIEW`（人工复核） |
| `affiliation_subject`（挂靠主体关系） | `RULE`（业务规则） | `FINAL_REVIEW`（最终审核阶段） | 旧/新车主体材料 | 是 | `MANUAL_REVIEW`（人工复核） |

Profile 的 `binding_declarations`、`capability_specs` 和注册表 Handler 必须一一对应。规则 ID 必须包含长春语义，政策对象必须是 `scrap_replacement_changchun`、地区 `changchun`、版本 `1.0`；不一致时服务启动失败。

### 业务规则和外部核验注册表

- `BusinessRuleRegistry`（业务规则注册表）：注册 `changchun_replacement_policy`（长春置换政策）和 `affiliation_subject`（挂靠主体关系）。
- `ExternalCheckRegistry`（外部核验注册表）：注册 `scrap_certificate_qr`（报废证明二维码核验），模式为 `REQUIRED`（必需执行）。
- `PageActionRegistry`（页面动作注册表）：注册 `fill_affiliation_fields`（填写挂靠字段），可逆、需要授权，可写字段为 `old_vehicle.affiliation`（报废车挂靠）和 `new_vehicle.affiliation`（新车挂靠）。

### 前端注册表

- `ScrapReplacementPageAdapter`（报废置换页面适配器）：识别 URL `/scrap-replace-changchun`，返回 `changchun / 1.0`。
- `PageAdapterRegistry`（页面适配器注册表）：负责页面适配器解析和页面身份校验。
- `RendererRegistry`（渲染器注册表）：键 `scrap_replacement|changchun|1.0` 映射到共享的 `ScrapReplacementReview`（报废置换审核工作台）。
- `PageActionRegistry`（页面动作注册表）：执行后端返回的 `fill_affiliation_fields`（填写挂靠字段），实际 DOM（页面文档对象模型）写回由 Adapter（适配器）/Content Script（内容脚本）守卫。

## 10. 子图和主图调用关系

长春请求与青岛请求进入同一张通用主图，只由 Profile 的能力绑定决定执行内容：

```text
统一主图
  → material_completeness（材料完整性）子图/Handler（处理器）
  → scrap_certificate_qr（报废证明二维码核验）子图/Handler（处理器）
  → changchun_replacement_policy（长春置换政策）子图/Handler（处理器）
  → affiliation_subject（挂靠主体关系）子图/Handler（处理器）
  → 字段比较 → 事实聚合 → 任务生成 → 建议
```

当前运行时使用通用单节点能力子图包装 Handler；领域子图工厂为材料校验、二维码核验、政策评估、主体关系、字段比较和最终复核保留扩展边界。长春政策的日期和产地参数只能由 `CHANGCHUN_REPLACEMENT_POLICY` 提供，不能由前端或主图判断。

## 11. 长春完整交付映射

| 业务概念 | 后端位置 | 前端位置 | 文档/测试关注点 |
| --- | --- | --- | --- |
| Profile 选择 | `app/businesses/profiles.py`、`registry.py` | `business-detector.ts` | 页面身份和版本 |
| 材料清单 | 共享 `material_policies.py`、`material_completeness.py` | `MaterialChecklist` | 图片、类型、页码、读取失败 |
| 政策日期/产地 | `replacement_policies.py`、`replacement_policy_checks.py` | 政策任务 Renderer | 长春日期窗口、产地关键词 |
| 主体关系 | 共享 `affiliation_subject_checks.py` | 主体证据组件 | 身份证、营业执照、法人 |
| 二维码 | QR Handler/Registry | QR 任务详情 | 解码、官网、降级 |
| 字段比较 | `compare.py`、任务装配 | 工作台字段卡片 | 页面值、材料值、差异 |
| 挂靠回填 | PageAction Registry | `page-field-writer.ts` | 原子写入、回读、回滚 |
