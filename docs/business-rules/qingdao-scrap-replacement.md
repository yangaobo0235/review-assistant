# 青岛报废置换审核规则（`scrap_replacement | qingdao | 1.0`）

本文档是青岛 Profile 的业务基线。代码实现分别位于后端 `app/businesses/profiles.py`、`app/businesses/replacement_policies.py`、`app/rules/replacement_policy_checks.py`、`app/rules/material_completeness.py`、`app/rules/affiliation_subject_checks.py`，以及前端 `src/adapters`、`src/browser`、`src/components` 和 `src/session`。修改其中任意一处规则，都必须同时核对本文档和测试。

`Profile`（业务配置档案）定义青岛这一业务版本；`Registry`（注册表）按 ID 查找实现；`Capability`（审核能力）由 `Handler`（处理器）或 `Subgraph`（子图）执行；`Renderer`（渲染器）负责前端工作台展示。本文中的代码 ID 保持英文以便与实现对应，后文首次出现的专业术语均按此含义理解。

## 1. Profile 身份和启用范围

| 项目 | 配置 |
| --- | --- |
| `business_type` | `scrap_replacement` |
| `region` | `qingdao` |
| `version` | `1.0` |
| `rules_configured` | `true` |
| 页面路径识别 | URL 包含 `/scrap-replace-qingdao` |
| 前端工作台 | `FIELD_WORKBENCH` |
| 页面动作 | `fill_affiliation_fields` |
| 失败默认策略 | `MANUAL_REVIEW` |

只有页面身份、地区和版本同时匹配时，才能选择本 Profile。页面 URL 命中但页面指纹、采集批次或请求地区不匹配时必须拒绝审核和写回。

## 2. 必审字段

### 旧车和报废证明

`old_vehicle.type`（报废车辆类型）、`old_vehicle.recycle_date`（报废交车日期）、`scrap_certificate.certificate_no`（报废证明编号）、`old_vehicle.vin`（报废车架号）、`old_vehicle.plate_no`（报废车牌号）、`old_vehicle.owner`（报废车所有人）、`old_vehicle.engine_model`（报废发动机型号）。

### 新车和发票

`new_vehicle.fuel_type`（新车燃料类型）、`invoice.code`（发票代码）、`invoice.invoice_no`（发票号码）、`invoice.amount`（开票金额）、`invoice.invoice_date`（开票日期）、`new_vehicle.vin`（新车架号）、`new_vehicle.plate_no`（新车车牌号）、`new_vehicle.owner`（新车所有人）、`new_vehicle.registration_date`（注册日期）、`application.terminal_certificate_no`（终端证件号）、`application.customer_name`（客户名称）、`application.terminal_phone`（终端客户手机号）。

页面还可能采集 `application.submitted_at`、`application.owner_type`、`application.dealer_name` 和 `page_ocr.new_vehicle_vin`，这些字段用于展示、辅助主体判断或 OCR 诊断；它们不能被前端当作新的业务规则。

## 3. 材料清单和页码

材料策略为 `enforce`，必须至少采集以下六类材料：

| 业务范围 | 材料 | 页码要求 |
| --- | --- | --- |
| `old_vehicle` | 旧车行驶证 | 至少 1 张 |
| `old_vehicle` | 旧车机动车登记证 | 第 1、2 页 |
| `old_vehicle` | 报废证明 | 至少 1 张 |
| `new_vehicle` | 新车行驶证 | 至少 1 张 |
| `new_vehicle` | 新车机动车登记证 | 第 1、2 页 |
| `new_vehicle` | 新车发票 | 至少 1 张 |

采集阶段检查图片是否存在、是否读取失败、候选是否超出上限；识别阶段再次确认材料类型和登记证页码。缺失、无法读取、无法识别或页码不足分别产生材料任务，不能使用“有图片”替代“材料类型和页码已确认”。

## 4. 后端能力绑定

| 能力 ID | 类型/阶段 | 是否必需 | 产出 | 失败行为 |
| --- | --- | --- | --- | --- |
| `material_completeness` | MATERIAL / `INPUT_COVERAGE` | 是 | `material.coverage` | 人工复核 |
| `scrap_certificate_qr` | EXTERNAL / `EVIDENCE` | 是 | `qr.valid`、`scrap_certificate.verified` | 人工复核 |
| `qingdao_replacement_policy` | RULE / `POST_COMPARE` | 是 | `replacement.eligible` | 人工复核 |
| `affiliation_subject` | RULE / `FINAL_REVIEW` | 是 | `subject.relation` | 人工复核 |

二维码能力依赖 `old_vehicle` 材料，默认超时 60 秒；二维码解码最多 3 轮，网页核验按 RetryPolicy 执行。外部服务失败不能自动通过。

## 5. 青岛地区政策规则

政策 ID 为 `scrap_replacement_qingdao`，版本 `1.0`。规则只读取指定材料的唯一、可读、非不确定字段：

1. **新车发票日期**：读取 `invoice.invoice_date`，来源必须是 `invoice / new_vehicle` 图片。日期必须在 **2026-09-01 至 2026-09-30（含边界）**。缺失、格式无效、多个冲突值或 OCR 不确定为 `INSUFFICIENT`；超出范围为 `CONFLICT`。
2. **回收证明交车日期**：读取 `old_vehicle.recycle_date`，来源必须是 `scrap_certificate / old_vehicle` 图片。日期必须不晚于 **2026-10-31**。缺失、格式无效或证据不唯一为 `INSUFFICIENT`；晚于截止日为 `CONFLICT`。
3. **新车发票产地**：读取 `new_vehicle.origin`，来源必须是新车发票图片。允许值为“青岛”“青岛市”“山东省青岛市”，规范化后完全匹配；不匹配为 `CONFLICT`，无法取得唯一值为 `INSUFFICIENT`。

三项政策检查仍由后端生成 `POLICY-INVOICE-DATE`、`POLICY-DISPOSAL-DEADLINE` 和 `POLICY-NEW-ORIGIN`，但展示层会把前两项分别合并到 `invoice.invoice_date` 和 `old_vehicle.recycle_date` 字段任务中。审核员在字段卡片即可看到“符合政策范围：2026-09-01 至 2026-09-30”和“不晚于 2026-10-31”，响应中不再残留独立的页面外日期核验任务。任一项为冲突或不足，建议不得自动通过。

## 6. 主体关系和挂靠规则

`affiliation_subject` 比较旧车所有人和新车所有人，先识别主体类型：个人需要姓名符合个人姓名格式；公司需要匹配营业执照或公司名称特征。页面 `application.owner_type` 的“个人”“公司/企业”可作为新车主体类型声明，但声明与材料推断冲突时必须人工复核。

- 个人与个人：姓名一致，且对应身份证正反面已确认，结果 `MATCH`；姓名不同，结果 `CONFLICT`。
- 同一公司：新旧车公司法定名称一致，且营业执照已确认，结果 `MATCH`。
- 两家公司：分别存在唯一营业执照且法定代表人均可确认；法人相同为 `MATCH`，不同为 `CONFLICT`。
- 公司与个人：公司营业执照法人与个人姓名相同为 `MATCH`，不同为 `CONFLICT`。
- 缺少营业执照、身份证、法人姓名，或存在多份/冲突证据，结果为 `INSUFFICIENT`。

只有主体关系为 `MATCH`，且推断出的 `owner_type`（主体类型）为 `PERSONAL`（个人）或 `COMPANY`（公司）时，后端才提出两个页面动作：`old_vehicle.affiliation`（报废车挂靠）和 `new_vehicle.affiliation`（新车挂靠）。两个动作携带同一主体类型，前端据此自动选择两个下拉框；前端必须原子地校验并填写两个字段，不能只填写其中一个。客户名称等辅助检查仍显示为独立人工事项，但不阻断明确的主体类型动作。

## 7. 前端行为

前端业务选择显示为“青岛报废置换审核”；手动选择会产生 `scrap_replacement / qingdao / 1.0`。字段优先工作台按后端 `ReviewTask` 展示页面原值、材料值、差异位置、证据图片和处理状态。前端只负责标签、排序、人工选择和调用写回动作，不重新计算日期、产地或主体关系。

页面动作只允许 `old_vehicle.affiliation` 和 `new_vehicle.affiliation`。写回前检查页面实例、采集 ID、目标控件唯一性、原值和动作授权；写回后回读，任何失败都执行回滚并要求重新采集。

青岛页面必须遵守统一的[审核工作台前端展示规范](../frontend-presentation.md)：`CONFLICT` 字段和政策结果使用红色冲突标记，`INSUFFICIENT`、材料不确定和外部降级使用橙色待复核标记；页面值、材料值和证据来源同时展示。日期政策直接显示在对应字段卡片，不重复显示页面外核验。材料只展示 `MATERIAL-GROUP`（材料完整性和识别异常统一任务）。带 `page_target_field`（页面定位字段）的冲突任务必须显示默认填入页面原值的人工输入框和“回填此值”按钮；写回成功后定位控件并高亮约 4 秒，回读成功才显示成功。主体关系通过且动作意图合法时自动选择个人/公司挂靠，两个字段必须原子回填。

## 8. 规则变更记录

修改日期范围、产地范围、材料清单、必需能力、任务 ID 或页面动作时，必须：创建新版本或明确迁移、更新本文档和通用业务规则索引、补充边界和降级测试、验证前端标签与 Profile 映射、说明旧任务如何回放。不得直接修改常量后只更新截图或前端文案。

## 9. Profile、注册表和绑定清单

### 后端 BusinessRegistry

```text
BusinessType.SCRAP_REPLACEMENT
  + Region.QINGDAO
  + version 1.0
  → SCRAP_REPLACEMENT_QINGDAO
```

该 Profile 由 `BUSINESS_PROFILES` 注册到 `BusinessRegistry`，键为 `scrap_replacement / qingdao / 1.0`。它不是通过前端名称猜测出来的；后端会用业务类型、地区和版本精确解析。

### CapabilityRegistry 绑定

| 注册能力 | `CapabilitySpec.kind` | stage | dependencies | required | failure policy |
| --- | --- | --- | --- | --- | --- |
| `material_completeness`（材料完整性） | `MATERIAL`（材料能力） | `INPUT_COVERAGE`（输入覆盖阶段） | 无 | 是 | `MANUAL_REVIEW`（人工复核） |
| `scrap_certificate_qr`（报废证明二维码核验） | `EXTERNAL`（外部核验） | `EVIDENCE`（证据阶段） | `old_vehicle`（旧车材料） | 是 | `MANUAL_REVIEW`（人工复核） |
| `qingdao_replacement_policy`（青岛置换政策） | `RULE`（业务规则） | `POST_COMPARE`（字段比较后阶段） | 规范字段和证据 | 是 | `MANUAL_REVIEW`（人工复核） |
| `affiliation_subject`（挂靠主体关系） | `RULE`（业务规则） | `FINAL_REVIEW`（最终审核阶段） | 旧/新车主体材料 | 是 | `MANUAL_REVIEW`（人工复核） |

Profile 的 `binding_declarations` 与 `capability_specs` 必须一一对应。规则 ID、能力 ID 和 Profile 地区不一致时，服务启动失败。

### 业务规则和外部核验注册表

- `BusinessRuleRegistry`（业务规则注册表）：注册 `qingdao_replacement_policy`（青岛置换政策）和 `affiliation_subject`（挂靠主体关系）。
- `ExternalCheckRegistry`（外部核验注册表）：注册 `scrap_certificate_qr`（报废证明二维码核验），模式为 `REQUIRED`（必需执行）。
- `PageActionRegistry`（页面动作注册表）：注册 `fill_affiliation_fields`（填写挂靠字段），可逆、需要授权，可写字段为 `old_vehicle.affiliation`（报废车挂靠）和 `new_vehicle.affiliation`（新车挂靠）。

### 前端注册表

- `ScrapReplacementPageAdapter`（报废置换页面适配器）：识别 URL `/scrap-replace-qingdao`，返回 `qingdao / 1.0`。
- `PageAdapterRegistry`（页面适配器注册表）：负责页面适配器解析和页面身份校验。
- `RendererRegistry`（渲染器注册表）：键 `scrap_replacement|qingdao|1.0` 映射到 `ScrapReplacementReview`（报废置换审核工作台）。
- `PageActionRegistry`（页面动作注册表）：执行后端返回的 `fill_affiliation_fields`（填写挂靠字段），实际 DOM（页面文档对象模型）写回由 Adapter（适配器）/Content Script（内容脚本）守卫。

## 10. 子图和主图调用关系

青岛请求仍然只进入一张通用主图。主图在 `plan_capabilities` 根据本 Profile 生成能力计划，在 `execute_capabilities` 通过统一能力子图边界执行：

```text
统一主图
  → material_completeness（材料完整性）子图/Handler（处理器）
  → scrap_certificate_qr（报废证明二维码核验）子图/Handler（处理器）
  → qingdao_replacement_policy（青岛置换政策）子图/Handler（处理器）
  → affiliation_subject（挂靠主体关系）子图/Handler（处理器）
  → 字段比较 → 事实聚合 → 任务生成 → 建议
```

当前运行时使用通用 `build_capability_subgraph` 包装单个 Handler；材料校验、二维码核验、政策评估、主体关系、字段比较和最终复核目录提供后续细分子图边界。未来拆分青岛政策子图时，只能改变 `qingdao_replacement_policy` 能力内部，不能新增青岛专用主图或让前端直接调用子图节点。

## 11. 青岛完整交付映射

| 业务概念 | 后端位置 | 前端位置 | 文档/测试关注点 |
| --- | --- | --- | --- |
| Profile 选择 | `app/businesses/profiles.py`、`registry.py` | `business-detector.ts` | 页面身份和版本 |
| 材料清单 | `material_policies.py`、`material_completeness.py` | `MaterialChecklist` | 图片、类型、页码、读取失败 |
| 政策日期/产地 | `replacement_policies.py`、`replacement_policy_checks.py` | 政策任务 Renderer | 边界日期、青岛产地 |
| 主体关系 | `affiliation_subject_checks.py` | 主体证据组件 | 身份证、营业执照、法人 |
| 二维码 | QR Handler/Registry | QR 任务详情 | 解码、官网、降级 |
| 字段比较 | `compare.py`、任务装配 | 工作台字段卡片 | 页面值、材料值、差异 |
| 挂靠回填 | PageAction Registry | `page-field-writer.ts` | 原子写入、回读、回滚 |
