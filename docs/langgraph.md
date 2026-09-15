# LangGraph 主图与节点

系统使用一张通用主图承载所有审核业务。节点按生命周期编排，业务差异通过 Profile、Planner 和注册表注入。

`LangGraph`（流程图编排框架）把审核流程拆成节点和边；`Profile`（业务配置档案）提供业务差异；`Planner`（能力规划器）决定本次请求执行哪些 `Capability`（审核能力）。

```text
START
  → resolve_context（解析上下文）
  → validate_input（校验输入）
  → assess_coverage（评估材料覆盖）
  → extract_evidence（提取证据）
  → assess_evidence_quality（评估证据质量）
  → plan_capabilities（规划能力）
  → execute_capabilities（执行能力）
  → record_degradation（记录降级）
  → compare_fields（比较字段）
  → assemble_facts（聚合事实）
  → prepare_review_tasks（生成审核任务）
  → derive_recommendation（生成建议）
  → build_response（构建响应）
  → END
```

| English | 中文 | 责任 |
| --- | --- | --- |
| `resolve_context`（解析上下文） | 解析上下文 | 识别页面、Profile（业务配置档案）、请求版本和租户上下文 |
| `validate_input`（校验输入） | 校验输入 | 校验必填字段、来源和协议版本 |
| `assess_coverage`（评估材料覆盖） | 评估材料覆盖 | 判断本次请求是否具备运行能力所需材料 |
| `extract_evidence`（提取证据） | 提取证据 | 将页面材料和 OCR（光学字符识别）结果规范化为证据候选 |
| `assess_evidence_quality`（评估证据质量） | 评估证据质量 | 处理清晰度、可信度、冲突和过期信息 |
| `plan_capabilities`（规划能力） | 规划能力 | 根据 Profile（业务配置档案）和覆盖情况选择已注册 Capability（审核能力） |
| `execute_capabilities`（执行能力） | 执行能力 | 调用 Handler（处理器）或 Subgraph（子图），收集结构化结果 |
| `record_degradation`（记录降级） | 记录降级 | 记录超时、不可用、缺材料和人工复核原因 |
| `compare_fields`（比较字段） | 比较字段 | 统一计算字段匹配、冲突和缺失状态 |
| `assemble_facts`（聚合事实） | 聚合事实 | 形成可解释的事实和来源链 |
| `prepare_review_tasks`（生成审核任务） | 生成审核任务 | 将异常、缺失和需确认项转换为 `ReviewTask`（审核任务） |
| `derive_recommendation`（生成建议） | 生成建议 | 按规则和任务状态推导建议，不直接写页面 |
| `build_response`（构建响应） | 构建响应 | 输出版本化响应、诊断信息和可展示结果 |

节点应保持小而纯：输入状态，返回状态增量，不读写浏览器，不包含页面选择器。条件分支只表达生命周期状态，例如输入无效、能力不可用或需要人工复核；不要为每个城市复制一套主图。

## 状态约定

`ReviewState` 只保存本次请求的上下文、规范化证据、能力计划、能力结果、字段比较、任务和建议。节点不得通过隐式全局变量传递数据；列表字段使用追加合并策略，标量字段由拥有该阶段的节点写入。所有外部调用都要写入耗时、版本、状态和降级原因，便于重放和审计。

## 合法分支

- `validate_input` 失败：直接生成协议错误响应，不执行任何能力。
- `assess_coverage` 发现关键材料缺失：仍可运行不依赖该材料的能力，缺失项生成任务。
- `execute_capabilities` 超时或外部服务不可用：记录降级，继续执行可用能力。
- `compare_fields` 出现冲突：保留冲突证据，建议至少为人工复核。

分支结果必须汇合到 `assemble_facts`，以保证响应形状稳定。新增分支先证明它属于生命周期控制；纯业务差异应进入注册表或子图。

## 阶段枚举对照

能力表中的 `MATERIAL`（材料能力）、`EXTERNAL`（外部核验）、`RULE`（业务规则）表示能力类型；`INPUT_COVERAGE`（输入覆盖）、`EVIDENCE`（证据处理）、`PRE_COMPARE`（字段比较前）、`POST_COMPARE`（字段比较后）和 `FINAL_REVIEW`（最终审核）表示能力在主图中的阶段。它们是程序枚举，不能在文档或前端中改写成含义不同的自定义状态。

## 节点输入输出约定

| 节点 | 主要读取 | 主要写入 |
| --- | --- | --- |
| `resolve_context` | 已解析的请求和 Profile（业务配置档案） | 稳定的 `request` 与 `profile` 上下文 |
| `validate_input` | `request`、Profile、协议字段 | `validation_error`（校验错误；为空表示通过） |
| `assess_coverage` | Profile 的材料需求、PageData | 覆盖矩阵、缺失材料 |
| `extract_evidence` | 材料索引、OCR 候选 | 候选证据集合 |
| `assess_evidence_quality` | 候选证据 | 质量分、冲突标记、可用证据 |
| `plan_capabilities` | Profile、覆盖矩阵、注册表 | 有序 `CapabilityPlanItem`（能力计划项）列表 |
| `execute_capabilities` | 能力计划、可用事实 | `CapabilityResult` 列表 |
| `record_degradation` | 失败和超时结果 | 统一降级事件 |
| `compare_fields` | 规范字段、事实 | 字段比较结果 |
| `assemble_facts` | 比较结果、能力结果 | 去重后的事实和检查结果 |
| `prepare_review_tasks` | 检查结果、缺失和冲突 | 去重、有优先级的任务 |
| `derive_recommendation` | 任务、规则结果 | 建议、阻断原因 |
| `build_response` | 全部公开结果 | `ReviewResponse` |

节点返回状态增量时必须遵守“只写自己负责的字段”原则。例如 `extract_evidence` 不能写最终建议，`derive_recommendation` 不能修改原始证据。节点之间传递的集合要有稳定排序和唯一键，避免重试造成顺序抖动。

## 并发与幂等

`execute_capabilities` 当前按能力计划顺序执行，并由 `CapabilityRegistry`（能力注册表）统一实施超时、重试和异常隔离；未来只有在注册表声明能力无共享副作用且依赖已满足时才可并发。依赖链必须显式表达，不能依靠 Python 调用顺序。每个能力使用 `request_id + capability_id + version` 作为幂等键；外部核验重试时保留第一次调用的诊断信息。

## 主图变更判定

只有以下情况才考虑增加或调整主图节点：出现新的跨业务生命周期阶段；现有状态无法表达新的失败语义；需要统一的安全或审计钩子。新增城市、材料类型、二维码供应商或字段规则均不属于主图变更，应通过 Profile、Registry 或 Subgraph 完成。任何主图变更都要更新本表、补充拓扑测试，并提供旧状态到新状态的兼容策略。
