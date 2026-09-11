# Review Agent Service

车辆审核辅助系统的后端服务，负责业务 Profile 解析、Qwen 材料提取、固定通用 LangGraph 编排、可配置外部核验、确定性规则和异步任务管理。

报废置换已分别配置青岛和长春政策，并通过普通处理器执行日期、长春产地和主体关系核验。Profile 只声明 `external_checks`、`rule_groups` 和 `page_actions`，不会把具体业务写入 LangGraph 节点。

## 快速开始

```powershell
Copy-Item .env.example .env
uv sync --locked
uv run uvicorn app.main:app --host 127.0.0.1 --port 8010 --reload
```

`.env` 中至少需要配置：

```dotenv
DASHSCOPE_API_KEY=replace-with-your-dashscope-api-key
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DASHSCOPE_MODEL=qwen3.7-plus
```

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查 |
| `POST` | `/api/review/assist` | 同步审核辅助 |
| `POST` | `/api/review/jobs` | 创建异步任务 |
| `GET` | `/api/review/jobs/{job_id}` | 查询任务快照 |

## 代码导航

- `app/main.py`：FastAPI 入口。
- `app/businesses/`：业务 Profile 与材料策略。
- `app/agent/`：Qwen 客户端、提取策略和 LangGraph。
- `app/rules/`：字段聚合与确定性规则。
- `app/services/`：审核门面、任务和二维码服务。
- `app/models/`：领域与 API 模型。
- `tests/`：后端测试。

当前工作流没有 Checkpoint 或任务数据库。任务快照保存在进程内存中，服务重启后需要重新发起审核。

## 验证

```powershell
uv run pytest -q
uv run ruff check app tests
```

完整说明见项目 [README](../README.md)、[架构文档](../docs/architecture.md) 和 [开发指南](../docs/development.md)。
