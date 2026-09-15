# Profile、注册表与子图

业务配置采用 `Profile → CapabilitySpec/Binding → Planner → Registry → Handler/Subgraph → CapabilityResult` 链路。Profile 描述适用范围和能力组合；注册表负责发现与校验；Handler 或子图负责执行。

这里的 `Registry`（注册表）是按 ID 管理实现的目录，`Handler`（处理器）是实际执行函数，`Subgraph`（子图）是可独立编排的领域流程，`CapabilityResult`（能力结果）是统一输出。不要把这些英文名称理解成新的业务概念，它们是架构角色。

## 注册表

| 注册表 | 内容 | 所在边界 |
| --- | --- | --- |
| `BusinessRegistry`（业务注册表） | 业务标识、页面范围、启用状态、Profile（业务配置档案） | 业务选择 |
| `CapabilityRegistry`（能力注册表） | 能力规格、输入、输出、Handler（处理器）、版本 | 能力发现 |
| `ExternalCheckRegistry`（外部核验注册表） | 外部核验名称、超时、降级策略 | 外部服务 |
| `BusinessRuleRegistry`（业务规则注册表） | 规则集合、阈值、适用 Profile（业务配置档案） | 规则执行 |
| `PageAdapterRegistry`（页面适配器注册表） | 页面身份和采集适配器 | 浏览器采集 |
| `PageActionRegistry`（页面动作注册表） | 页面写入动作、白名单和回滚器 | 浏览器写回 |
| `RendererRegistry`（渲染器注册表） | 任务类型到工作台渲染器 | 前端展示 |

`CapabilitySpec` 至少包含 `id`、`version`、`input_contract`、`output_contract`、`supports_profiles`、`timeout`、`degradation_policy` 和 `handler`。能力必须幂等、可观测、可测试，并返回状态而非抛出业务结论字符串。

## 当前代码中的注册关系

当前生产 Profile 由后端 `app/businesses/registry.py` 的 `BusinessRegistry` 构建，来源是 `BUSINESS_PROFILES`：

| Profile | 状态 | 已注册能力 |
| --- | --- | --- |
| `scrap_replacement/qingdao/1.0` | active | `material_completeness`、`scrap_certificate_qr`、`qingdao_replacement_policy`、`affiliation_subject` |
| `scrap_replacement/changchun/1.0` | active | `material_completeness`、`scrap_certificate_qr`、`changchun_replacement_policy`、`affiliation_subject` |
| `vehicle_source/default/1.0` | unconfigured | 无生产能力 |
| `consistency/qingdao/1.0` | unconfigured | 无生产能力 |
| `consistency/changchun/1.0` | unconfigured | 无生产能力 |

`TRANSFER_DEFAULT` 仅用于历史数据和迁移测试，不加入 `BUSINESS_PROFILES`，因此不能被生产 `BusinessRegistry` 解析。后端启动时会检查 Profile 的能力、外部核验、业务规则、页面动作和地区政策是否都能在相应注册表中找到，并校验 ID、地区和版本一致。

## 当前能力到处理器的映射

`ReviewWorkflow` 创建三个执行入口：`ExternalCheckRegistry` 处理外部核验，`BusinessRuleRegistry` 处理业务规则，`CapabilityRegistry` 统一执行能力并隔离超时和异常。

| 能力 | 注册表 | 当前处理器/规则 |
| --- | --- | --- |
| `material_completeness` | `CapabilityRegistry` | 材料完整性 Handler，调用 collected/extracted 两阶段检查 |
| `scrap_certificate_qr` | `ExternalCheckRegistry` + `CapabilityRegistry` | 二维码解码与官网核验 Handler |
| `qingdao_replacement_policy` | `BusinessRuleRegistry` + `CapabilityRegistry` | `build_replacement_policy_checks(QINGDAO_REPLACEMENT_POLICY, ...)` |
| `changchun_replacement_policy` | `BusinessRuleRegistry` + `CapabilityRegistry` | `build_replacement_policy_checks(CHANGCHUN_REPLACEMENT_POLICY, ...)` |
| `affiliation_subject` | `BusinessRuleRegistry` + `CapabilityRegistry` | `build_affiliation_subject_check(...)` |

业务规则注册表负责按 ID 找到函数；能力注册表负责按照 `CapabilitySpec` 的阶段、依赖、超时、重试和失败策略执行。两者不能在前端重新实现。

## 子图边界

可独立组合、拥有独立输入输出和失败策略的领域流程才拆成子图。当前适合的子图包括材料完整性、二维码核验、主体关系、地区政策、文档证据和车源一致性。子图不应直接修改主图状态中无关字段，也不能绕过注册表。

## 当前子图实现状态

当前主图通过 `app/capabilities/subgraphs/common.py` 的 `build_capability_subgraph` 为每个已注册能力包裹统一的单节点执行子图：

```text
START → execute(handler(context, spec)) → END
```

这个包装保证能力都经过统一的 LangGraph 边界、超时隔离和 `CapabilityResult` 返回契约。`app/capabilities/subgraphs/` 还提供可进一步细化的领域子图工厂：

| 子图工厂 | 领域用途 | 当前 Profile 使用情况 |
| --- | --- | --- |
| `build_material_validation_subgraph` | 材料类型、数量和页码校验 | 材料能力的扩展边界 |
| `build_qr_verification_subgraph` | 二维码解析、外部访问和字段核验 | `scrap_certificate_qr` 的扩展边界 |
| `build_policy_evaluation_subgraph` | 地区政策日期、产地和阈值 | 青岛/长春政策能力的扩展边界 |
| `build_entity_relationship_subgraph` | 个人、公司、身份证和营业执照关系 | `affiliation_subject` 的扩展边界 |
| `build_field_comparison_subgraph` | 页面字段与材料字段比较 | 通用字段比较扩展边界 |
| `build_evidence_extraction_subgraph` | OCR 和证据规范化 | 证据提取扩展边界 |
| `build_final_review_subgraph` | 任务汇总和最终复核 | 最终建议扩展边界 |

“扩展边界”表示已经有稳定名称和输入输出方向，但当前 Profile 的能力执行仍由 Workflow 注册 Handler 并通过通用包装调用。后续把某个能力内部拆成多节点子图时，必须保持同一个 `CapabilitySpec` 和 `CapabilityResult`，不能让主图直接依赖子图内部节点名。

## 前端注册关系

前端 `ScrapReplacementPageAdapter` 通过 URL 识别青岛和长春，输出相同的业务类型和不同的 `region`；`PageAdapterRegistry` 负责页面识别和页面身份校验。`workbenchRenderers.tsx` 为两个 Profile Key 注册同一个 `ScrapReplacementReview`，未配置或未来业务使用通用 `ReviewTaskWorkbench`。后端 Profile 的 `page_action_ids` 与前端动作执行器必须通过稳定 `action_id` 对接，不能依赖组件名称或地区字符串。

## 新增能力流程

1. 在 Profile 中声明适用业务和字段需求。
2. 定义 `CapabilitySpec`、输入输出模型和结果状态。
3. 实现 Handler 或子图，处理超时、缺材料和外部错误。
4. 注册到 `CapabilityRegistry` 与必要的规则注册表。
5. 将结果映射为 `EvidenceFact`、`CheckResult` 和 `ReviewTask`。
6. 增加契约、规则、降级和 API 测试，并更新业务文档。

不得在 `ReviewResults.tsx`、主图节点或 API 路由中硬编码能力分支。

## 版本与生命周期

注册表 ID 全局唯一且稳定，版本采用显式字符串。新增版本可以并存，Profile 通过绑定选择版本；删除或停用先将状态设为 disabled，保留读取和回放能力，确认无生产引用后再清理实现。注册表加载时应校验重复 ID、缺少 Handler、Profile 不匹配和不支持的协议版本，并在启动阶段尽早失败。

## 可观测性

每次能力执行记录 `capability_id`、版本、Profile、输入摘要、开始/结束时间、结果状态、证据引用和降级原因。日志不得包含身份证号、完整发票或密钥；调试数据使用脱敏摘要。相同输入和配置应产生可重放的结果，随机或模型调用需记录模型版本和提示版本。

## Profile 的组成

一个 Profile 应至少声明：`id`、显示名称、适用页面指纹、启用状态、字段集合、材料需求、能力绑定、规则版本、外部核验开关、任务优先级和默认降级策略。Profile 只描述“使用哪些能力以及如何组合”，不实现能力逻辑。相同能力可以被多个 Profile 复用；只有参数或阈值不同才通过绑定配置覆盖。

示意：

```yaml
id: qingdao_scrap_replacement
status: active
required_materials: [scrap_certificate, invoice, new_vehicle]
capabilities:
  - id: material_completeness
    version: v2
  - id: affiliation_subject
    version: v1
  - id: regional_policy
    version: v1
```

## 能力结果的最小形状

能力不得只返回布尔值。最小结果应包含能力 ID 和版本、`status`、标准化理由、输入事实引用、产出事实、人工动作建议、耗时、错误类别和 `degradation`。状态只允许使用注册的枚举，未知状态在边界层拒绝。这样可以让工作台在没有理解业务细节的情况下展示任务，也让审计人员能够复核结论来源。

## Handler 与子图的选择

单次计算、无内部阶段且失败语义简单的能力使用 Handler；包含多步提取、外部核验、条件分支、重试或独立测试边界的能力使用子图。子图内部可以有自己的节点和分支，但必须通过一个明确的输入模型和一个明确的 `CapabilityResult` 与主图交互。

## 注册表冲突处理

注册表启动加载时发现重复 ID、版本覆盖、循环依赖、Profile 引用停用能力或 Handler 不可导入，应阻止服务启动并给出具体诊断。运行期间禁止动态替换生产注册表；配置热更新必须有版本、签名和回滚机制。页面注册表与后端业务注册表的 ID 不要求相同，但映射关系必须显式记录。
