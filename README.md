# Review Assistant

Review Assistant 是一个面向车辆审核页面的浏览器扩展与审核服务。系统通过统一的 LangGraph（流程图编排框架）主图处理材料采集、文档识别、证据聚合、字段比较、业务规则和审核任务生成；前端只负责页面采集、任务呈现和受控页面操作。

当前生产能力包括青岛和长春的报废置换审核。车源和一致性入口保留为未配置或人工复核路径；过户能力已经停用，不得作为生产能力重新接入。

## 文档入口

- [文档总索引](docs/README.md)
- [系统架构与模块边界](docs/architecture.md)
- [审核工作台前端展示规范](docs/frontend-presentation.md)
- [LangGraph 主图与节点说明](docs/langgraph.md)
- [注册表、能力和子图](docs/registries-and-subgraphs.md)
- [当前业务规则](docs/business-rules.md)
- [新增审核页面扩展手册](docs/extension-guide.md)
- [AI 与开发者改动准则](docs/ai-change-policy.md)
- [测试、提交与发布](docs/testing-and-release.md)
- [GitHub 协作规范](CONTRIBUTING.md)
- [安全边界](SECURITY.md)

## 快速验证

后端：

```powershell
cd review-agent-service
uv run ruff check app tests
uv run python -m compileall -q app
uv run pytest tests -q
```

前端：

```powershell
npm --prefix review-extension install
npm --prefix review-extension test
npm --prefix review-extension run lint
npm --prefix review-extension run build
```

构建产物位于 `review-extension/dist`。不要直接编辑 `dist`，不要恢复旧的 `review-extension/public/*.js` 双源码。

## 运行时关系

扩展与后端之间只传递版本化审核协议。页面上的字段名称、CSS 选择器和控件操作属于扩展；材料是否齐全、字段是否一致、地区政策是否满足以及是否需要人工复核属于后端。新增功能时先判断它属于哪一侧，再沿注册表和标准协议接入，避免出现同一规则在两端各写一份。

## 开发入口

后端入口通常从 `app/main.py` 和 API 路由进入，审核流程从 `app/agent/workflow.py` 进入；业务 Profile 位于 `app/businesses`，能力和规则位于 `app/capabilities` 与 `app/rules`。前端入口从 `src/main.tsx` 开始，页面采集查看 `src/browser` 和 `src/adapters`，工作台查看 `src/components`，页面写回查看 `src/session`。遇到不确定的代码归属，先阅读 [系统架构与边界](docs/architecture.md) 和模块 README。

## 交付标准

一个改动只有在代码、测试、文档和回滚方式都明确时才算完成。不能以“本地页面看起来正常”代替后端契约测试，也不能以“测试通过”代替 Profile、注册表和权限边界审查。
