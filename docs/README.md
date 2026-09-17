# 文档总索引

本目录是 Review Assistant 的长期工程文档。文档以当前代码为准，历史计划、废弃协议和停用业务不属于现行架构。

## 架构

- [architecture.md](architecture.md)：系统分层、前后端边界、目录职责和数据流。
- [glossary.md](glossary.md)：英文专业术语、中文含义和状态枚举对照。
- [frontend-presentation.md](frontend-presentation.md)：审核工作台状态颜色、冲突标红、证据定位、回填高亮和页面失效行为。
- [langgraph.md](langgraph.md)：LangGraph（流程图编排框架）主图、节点中英文名称、状态和分支规则。
- [registries-and-subgraphs.md](registries-and-subgraphs.md)：Profile（业务配置档案）、Capability Registry（能力注册表）、Handler（处理器）、Subgraph（子图）和页面注册表。
- [business-rules.md](business-rules.md)：当前业务、字段、材料、外部核验、政策和页面动作。
  - [青岛报废置换规则](business-rules/qingdao-scrap-replacement.md)
  - [长春报废置换规则](business-rules/changchun-scrap-replacement.md)
  - [业务规则文档模板](business-rules/template.md)

## 开发与扩展

- [extension-guide.md](extension-guide.md)：新增审核页面或新审核业务的完整流程，包括 PageAdapter（页面适配器）、PageAction（页面动作）和 Renderer（渲染器）。
- [ai-change-policy.md](ai-change-policy.md)：AI 和开发者修改代码时的强制约束。
- [testing-and-release.md](testing-and-release.md)：测试分层、验证命令、版本和发布流程。
- [server-deployment.md](server-deployment.md)：腾讯云容器部署、SSH 本地端口转发、更新与回滚。

## 阅读顺序

第一次接触项目：先读 `architecture.md` 和 `langgraph.md`；需要增加业务时再读 `registries-and-subgraphs.md` 和 `extension-guide.md`；准备提交代码时读 `ai-change-policy.md` 和 `testing-and-release.md`。

## 文档使用规则

这些文档描述的是当前实现和必须保持的架构约束，不是可以随意忽略的建议。代码、测试和文档出现不一致时，先确认是否发生了已批准的架构变更；如果没有，应修正文档或代码使其重新一致。历史计划不再作为实现依据，新的决策应直接更新对应主题文档并在提交记录中说明原因。

文档按职责拆分：架构文档回答“边界在哪里”，LangGraph 文档回答“流程如何运行”，注册表文档回答“能力如何接入”，业务规则文档回答“当前判断是什么”，扩展手册回答“如何新增页面或业务”，AI 准则回答“修改时不能破坏什么”，测试发布文档回答“如何证明改动可交付”。

每次新增公共类型、节点、注册表、Profile、页面动作或权限时，必须同步更新至少一篇相关文档，并在 PR 中给出链接。发现文档缺失、歧义或与实现不符，应先补充澄清再继续大范围改动。
