# 贡献指南

## 开发流程

1. 从最新 `main` 创建功能分支。
2. 保持改动聚焦；不要把业务行为、格式化和无关重构混在同一提交中。
3. 行为变更先添加能够复现需求或问题的测试。
4. 完成前运行前后端完整检查。
5. 通过 Pull Request 合并到 `main`。

建议使用 Conventional Commits：

```text
feat: add transfer profile
fix: preserve partial review results
docs: clarify local setup
test: cover ambiguous page fields
chore: update repository tooling
```

## 质量要求

后端：

```powershell
cd review-agent-service
uv run pytest -q
uv run ruff check app tests
```

扩展：

```powershell
cd review-extension
npm test
npm run build
npm run lint
```

Pull Request 需要说明变更目的、行为影响、风险边界和实际验证结果。涉及界面时附上截图；涉及审核规则时列出业务、地区、Profile 版本和安全降级行为。

## 数据与密钥

- 不提交 `.env`、API Key、访问令牌或内部服务凭据。
- 不提交真实证件、车辆信息、材料图片、审核结果或可识别个人的数据。
- 测试数据使用明确的虚构域名和值。
- 新日志不得包含图片内容、完整业务字段或密钥。

更多约定见 [开发指南](docs/development.md) 和 [安全策略](SECURITY.md)。
