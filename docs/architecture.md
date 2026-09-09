# 架构说明

## 1. 设计目标

车辆审核辅助 Agent 在不修改原业务系统的前提下，为审核人员提供材料识别、多源字段比对、二维码核验和可解释的审核建议。

系统遵循三个核心边界：

1. 浏览器扩展负责采集和展示，不复制后端审核规则。
2. Qwen 负责分类与字段提取，不直接决定通过或驳回。
3. 最终建议由确定性规则生成；任何失败、冲突或证据不足都安全降级为人工复核。

## 2. 端到端数据流

```mermaid
sequenceDiagram
    participant Page as 审核页面
    participant Extension as 浏览器扩展
    participant API as FastAPI
    participant Workflow as LangGraph
    participant Qwen as Qwen
    participant Rules as 确定性规则

    Extension->>Page: 读取业务、字段和材料图片
    Extension->>Extension: 筛选并标准化图片
    Extension->>API: POST /api/review/jobs
    API->>Workflow: 启动异步审核任务
    Workflow->>Qwen: 分类并提取白名单字段
    Workflow->>Rules: 聚合页面、图片和官网证据
    Rules-->>Workflow: 字段状态、跨材料检查与建议
    Extension->>API: GET /api/review/jobs/{job_id}
    API-->>Extension: 进度、部分结果或最终结果
    Extension-->>Page: 展示证据并定位原图
```

请求边界是 `ReviewRequest`，主要包含业务类型、地区、Profile 版本、页面字段、材料图片和采集诊断。响应边界是 `ReviewResponse`，包含字段比较、二维码检查、跨材料检查、材料完整性、重试摘要、问题列表和最终建议。

## 3. 浏览器扩展

扩展位于 `review-extension/`，由 Manifest V3 后台脚本、页面 Content Script 和 React Side Panel 组成。

### 页面采集

- `public/business-detector.js`：根据路由和页面指纹识别业务。
- `public/page-field-collector.js`：从控件、标签、表格和只读结构中提取字段。
- `public/field-matcher.js`：根据标签精度、DOM 关系和业务分区选择字段候选。
- `public/business-scope.js`：识别旧车、新车、过户和非审核资料范围。
- `public/image-candidates.js`：过滤、评分并选择材料图片。
- `public/image-normalization.js`：统一图片格式、尺寸和体积。
- `public/content.js`：协调采集脚本并处理原图定位消息。

图片处理约束：

| 项目 | 当前值 |
| --- | ---: |
| 单次提交上限 | 10 张 |
| 原始图片上限 | 20 MB |
| 输出图片上限 | 5 MB |
| 最大边长 | 2048 px |
| 输出格式 | JPEG |
| JPEG 质量 | 0.85 |

### Side Panel

- `src/App.tsx`：组合页面与业务选择状态。
- `src/hooks/useReviewWorkflow.ts`：页面采集、任务创建、轮询和部分结果生命周期。
- `src/reviewClient.ts`：封装异步任务 HTTP 请求和错误映射。
- `src/reviewJobs.ts`：实现 1 秒轮询与 60 秒客户端展示时限。
- `src/components/`：展示进度、材料完整性、最终建议和异常证据。
- `src/*Presentation.ts`：把后端状态转换为稳定的界面展示模型。

扩展保留每张图片的稳定 `imageId`。审核人员点击原图操作时，Content Script 只定位仍与该 ID 对应的页面元素，不会在元素失效后操作其他图片。

## 4. Agent 服务

服务位于 `review-agent-service/`，以 `app/main.py` 为 HTTP 入口。

| 层 | 目录 | 职责 |
| --- | --- | --- |
| API | `app/main.py` | 参数校验、HTTP 状态、同步与异步入口 |
| 业务配置 | `app/businesses/` | 解析业务、地区、版本和材料策略 |
| Agent | `app/agent/` | Qwen 客户端、字段路由、重试和 LangGraph 编排 |
| 领域模型 | `app/models/` | 请求、响应、证据、比较和任务状态 |
| 确定性规则 | `app/rules/` | 值标准化、字段聚合、跨材料检查和最终建议 |
| 基础服务 | `app/services/` | 审核门面、任务管理、二维码和响应组装 |

`ReviewService` 是审核门面。它先解析 `BusinessProfile`，未配置规则的业务直接返回人工复核结果；已配置业务进入 LangGraph 工作流。

## 5. LangGraph 工作流

工作流使用固定顺序，节点之间通过类型化 `ReviewState` 传递结果：

```text
START
  -> validate_context
  -> assess_collected_materials
  -> extract_documents
  -> assess_extracted_evidence
  -> verify_qr
  -> compare_same_fields
  -> compare_cross_documents
  -> derive_recommendation
  -> build_final_advice
  -> END
```

- 采集前评估检查页面与材料覆盖情况。
- 文档提取对单任务最多并发处理 6 张图片。
- 单张模型调用最长 50 秒，整单工作流最长等待 55 秒。
- 部分图片失败或超时时保留已完成结果，并把未完成部分写入识别限制。
- 语义提取最多重试 1 次；二维码本地解码最多 3 轮；官网临时故障最多重试 1 次。

工作流当前没有持久化 Checkpoint，不能跨进程恢复节点状态。

## 6. 业务 Profile

`BusinessRegistry` 使用 `(business_type, region, profile_version)` 解析配置。精确地区优先；找不到时只允许回退到同业务、同版本的 `default` 地区配置，不会借用其他业务规则。

| 业务 | Profile | 材料完整性 | 二维码 | 规则 |
| --- | --- | --- | --- | --- |
| 报废置换 | `qingdao/1.0` | 观察模式 | 必需 | 已配置 |
| 过户审核 | `default/1.0` | 强制模式 | 不需要 | 已配置 |
| 车源审核 | `default/1.0` | 不执行 | 不需要 | 未配置，转人工 |
| 一致性审核 | `qingdao/1.0` | 不执行 | 不需要 | 未配置，转人工 |

## 7. 证据与确定性规则

同一字段可以包含申请页面、材料图片识别、二维码官网页面和受控辅助工具等证据来源。字段先按类型标准化，再聚合为三种状态：

| 状态 | 含义 |
| --- | --- |
| `MATCH` | 证据充分且一致 |
| `CONFLICT` | 可靠来源之间存在明确冲突 |
| `REVIEW_REQUIRED` | 字段缺失、来源不足或无法可靠判断 |

报废置换包含新旧车所有人一致性和报废交车日期/发票日期同年检查。过户审核包含卖方登记历史、买方最新转移登记，以及“转让登记日期 >= 开票日期 >= 车源发布时间”的顺序检查。

最终工作流只产生：

- `PASS`：必检项证据充分且规则满足；
- `REVIEW_REQUIRED`：存在冲突、缺失、识别限制、二维码异常、超时或未配置规则。

风险等级用于界面排序：全部满足为 `LOW`，证据不足为 `MEDIUM`，存在明确冲突为 `HIGH`。

## 8. 二维码安全策略

报废证明二维码经过本地解码、URL 规范化和域名白名单检查。只有允许的 HTTPS 官方域名才会被访问；重定向目标同样需要重新验证。官网返回字段作为独立证据参与比较，原始二维码 URL 不在侧边栏直接展示。

## 9. 异步任务

`ReviewJobManager` 在内存中管理任务：

1. `POST /api/review/jobs` 创建任务并返回 `202`。
2. 后台线程执行审核，并随图片完成更新快照。
3. 扩展通过 `GET /api/review/jobs/{job_id}` 轮询。
4. 任务状态为 `RUNNING`、`PARTIAL`、`COMPLETED` 或 `FAILED`。
5. 任务按最后更新时间保留 600 秒。

## 10. HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 服务健康检查 |
| `POST` | `/api/review/assist` | 同步执行一次审核辅助 |
| `POST` | `/api/review/jobs` | 创建异步审核任务 |
| `GET` | `/api/review/jobs/{job_id}` | 查询进度、部分结果或最终结果 |

业务 Profile 不存在或版本不兼容时返回 `422`；任务不存在或已过期时返回 `404`。

## 11. 部署边界

当前实现适合受控本地开发和业务验证，不应直接暴露到公网。生产化至少需要认证与授权、租户隔离、HTTPS 网关、任务队列、持久化存储、对象存储、全局限流、审计日志、指标监控和数据保留策略。
