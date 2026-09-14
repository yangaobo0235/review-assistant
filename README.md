# 车辆审核辅助 Agent

浏览器扩展采集车辆审核页面与材料，FastAPI / LangGraph 后端提取证据、核验字段和业务规则，审核员在侧边栏查看差异、图片并进行人工复核。当前接入青岛/长春报废置换和过户；车源与一致性审核规则尚未配置。

## 从哪里开始

**只读一份详细文档：[项目完整手册](docs/system-spec.md)。**

| 你想做什么 | 直接阅读 |
| --- | --- |
| 了解每个页面、字段规则和之前确认的交互要求 | [手册第 1–8 章](docs/system-spec.md#1-产品目标与不可违反的边界) |
| 理解代码、LangGraph 节点、Profile 和接口 | [手册第 9–11 章](docs/system-spec.md#9-代码映射) |
| 安装、启动服务、加载扩展 | [手册第 12 章](docs/system-spec.md#12-安装运行与配置) |
| 修改代码、运行测试、排查问题 | [手册第 13 章](docs/system-spec.md#13-开发验收与排错) |

新开 AI 对话时可以直接说明：

> 请先阅读 README.md 和 docs/system-spec.md，理解页面、字段规则及交互约束，再按手册定位相关源码和测试。历史归档只作背景，不直接执行旧计划；发现需求、文档和代码不一致时请明确指出。

## 项目结构

```text
review-assistant/
├─ README.md                 # 本页：阅读入口
├─ docs/system-spec.md       # 唯一完整手册
├─ docs/archive/             # 历次设计与计划，日常无需阅读
├─ review-agent-service/     # Python / FastAPI / LangGraph
├─ review-extension/         # Manifest V3 / React / TypeScript
├─ start-agent.ps1           # 启动后端
└─ start-extension-build.ps1 # 构建扩展
```

环境要求：Python >=3.11,<3.13、uv、Node.js >=22.18.0、npm、Chrome 或 Edge，以及本地 DashScope 配置。完整命令见手册，避免多处维护。

系统提供审核辅助；最终审核决定由人工完成。普通字段可由审核员主动回填，自动写入只针对符合条件的两个空白挂靠字段；不会自动通过、驳回或提交业务单据。

## 按需查看

- [贡献规范](CONTRIBUTING.md)：提交和 PR 约定。
- [安全策略](SECURITY.md)：数据、密钥和漏洞反馈。
- [历史方案](docs/archive/README.md)：仅用于追溯旧决策。
- [MIT License](LICENSE)。
