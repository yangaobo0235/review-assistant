# Review Agent Service

后端审核服务，负责接收页面采集的 `ReviewRequest`，选择 Profile，运行统一 LangGraph，并返回版本化的 `ReviewTask`、证据事实和建议。浏览器扩展不应复制这里的业务判断。

其中 `ReviewRequest`（审核请求）是前端提交的数据，`Profile`（业务配置档案）决定业务组合，`LangGraph`（流程图编排框架）负责生命周期，`ReviewTask`（审核任务）是返回给审核员处理的事项。

## 目录职责

| 目录 | 职责 |
| --- | --- |
| `app/api` | HTTP 路由、鉴权、请求响应边界 |
| `app/contracts` | 对外协议、兼容转换和错误码 |
| `app/models` | Pydantic 数据模型与领域值对象 |
| `app/agent` | LangGraph 状态、节点、规划器和模型客户端 |
| `app/businesses` | Profile、业务注册和上下文校验 |
| `app/rules` | 可注册能力、规则、比较、聚合和建议 |
| `app/capabilities` | 能力 Handler、子图及执行结果 |
| `app/services` | 作业、HTTP、二维码和审核装配服务 |
| `tests` | 按契约、规则、工作流和 API 分层的测试 |

## 开发约束

- 业务差异进入 `app/businesses/profiles.py` 和注册表，不在节点中写业务 `if`。
- 新能力必须有 `CapabilitySpec`、Handler、测试和可追踪的 `CapabilityResult`。
- 统一主图只编排生命周期；业务分支由 Profile 和 Planner 数据驱动。
- 对外协议优先使用 `review_tasks`、`EvidenceFact` 和 `CheckResult`，旧 `review_steps` 仅可在兼容层转换。

## 本地验证

```powershell
uv run ruff check app tests
uv run python -m compileall -q app
uv run pytest tests -q
```

## 请求处理约定

API 层只负责鉴权、协议解析、请求 ID 和错误映射；审核服务负责组装 LangGraph 输入；节点负责生命周期阶段；规则和能力负责领域判断。任何层都不得跳过下一层直接调用数据库、浏览器或模型客户端。异常要转换为稳定错误码，内部堆栈只写入受控日志。

## 新增后端代码前的检查

先确认是否已有同类字段、能力或注册表条目；优先扩展现有模型和接口。新增公开字段要更新 `app/contracts`、前端类型、契约测试和文档。新增规则要说明证据来源、缺失行为、冲突行为、版本和 Profile 范围。新增外部调用要声明超时、重试、熔断和脱敏策略。
