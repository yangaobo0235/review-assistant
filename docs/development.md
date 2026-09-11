# 开发指南

## 1. 环境要求

| 工具 | 版本 |
| --- | --- |
| Python | `>=3.11,<3.13` |
| uv | 使用当前稳定版本 |
| Node.js | `>=22.18.0` |
| npm | 随 Node.js 安装 |
| 浏览器 | Microsoft Edge 或 Google Chrome |

扩展测试会直接导入 TypeScript 模块，因此 Node.js 版本不能低于 `22.18.0`。如果出现 `ERR_UNKNOWN_FILE_EXTENSION: .ts`，先检查 `node --version`。

## 2. Agent 服务

### 安装依赖

```powershell
cd review-agent-service
uv sync --locked
```

### 配置模型

```powershell
Copy-Item .env.example .env
```

本地 `.env` 支持：

```dotenv
DASHSCOPE_API_KEY=replace-with-your-dashscope-api-key
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DASHSCOPE_MODEL=qwen3.7-plus
```

进程环境变量优先于 `.env`。不要把真实密钥写入代码、测试、日志或提交记录。

### 启动

在项目根目录执行：

```powershell
.\start-agent.ps1
```

可选参数：

```powershell
.\start-agent.ps1 -NoReload
.\start-agent.ps1 -Port 8020
.\start-agent.ps1 -BindHost 0.0.0.0
```

绑定到非回环地址只适合受控网络调试；当前服务没有生产级认证。

### 验证

```powershell
cd review-agent-service
uv run pytest -q
uv run ruff check app tests
```

## 3. 浏览器扩展

### 安装依赖

```powershell
cd review-extension
npm ci
```

### 开发与构建

```powershell
npm run dev
npm run build
```

Vite 开发页面不能完整模拟浏览器扩展 API；页面采集、Side Panel 和原图定位需要在加载后的扩展中验证。

也可以从项目根目录执行：

```powershell
.\start-extension-build.ps1
```

构建产物位于 `review-extension/dist`。修改 Manifest 时编辑 `review-extension/public/manifest.json`，不要直接修改 `dist/manifest.json`。

### 加载扩展

1. 打开 `edge://extensions` 或 `chrome://extensions`。
2. 开启开发者模式。
3. 选择“加载解压缩的扩展”。
4. 选择 `review-extension/dist`。
5. 代码更新后重新构建并在扩展管理页点击重新加载。

### 验证

```powershell
cd review-extension
npm test
npm run build
npm run lint
```

## 4. 代码组织

### 后端

- API 层只负责参数校验和 HTTP 状态，不实现审核规则。
- `app/businesses/` 管理业务、地区、版本和材料策略。
- Agent 层负责模型调用、字段提取和工作流编排，不直接决定通过或驳回。
- Rules 层负责标准化、比较和建议生成，不访问浏览器页面。
- Services 层协调任务、二维码和响应组装，不重复领域模型。
- 公共请求、响应和跨层接口使用明确类型，避免用 `Any` 绕过可表达的领域模型。

### 扩展

- React 组件负责展示，Hook 负责生命周期，HTTP 客户端负责接口与错误映射。
- `public/content.js` 只做页面脚本协调，复杂采集逻辑保持在独立模块。
- Manifest 加载的公共脚本依赖稳定的全局名称和加载顺序，调整前必须增加回归测试。
- 审核规则只存在于后端；扩展只展示服务端结果。
- 页面写入仅允许 `page_fill_intent` 指定的两个挂靠字段；必须绑定采集时的标签页、URL、页面实例和稳定记录指纹，并对空值、唯一控件、唯一选项及回读结果做校验。没有申请单号或 VIN 等强锚点时不得自动填写。
- 逐项审核的当前步骤和人工处理选择只使用 React 内存状态，不增加本地存储或后端持久化。

## 5. 变更规则

- 行为变更先写聚焦测试，再实现最小改动。
- 失败、超时、证据不足或未配置规则必须降级为人工复核。
- 新业务必须有独立 `BusinessProfile`、字段范围、材料策略、确定性规则和回归测试。
- 新页面优先通过 Profile 声明 `external_checks`、`rule_groups` 和 `page_actions`，以及在注册表中增加普通处理器；简单规则不得复制或修改 LangGraph 主图。
- 只有包含多阶段、条件分支、独立重试或较多专用状态的复杂能力才考虑用子图适配器，并保持统一处理器输入输出。
- 不要修改生成目录、虚拟环境或第三方依赖目录中的文件。
- 注释解释业务原因、兼容性和非直观失败处理，不逐行翻译代码。

## 6. 提交前检查

```powershell
cd review-agent-service
uv run pytest -q
uv run ruff check app tests

cd ..\review-extension
npm test
npm run build
npm run lint

cd ..
git diff --check
```

GitHub Actions 会在 `main` 分支推送和 Pull Request 时执行同等检查。

## 7. 常见问题

### Agent 找不到 Python 环境

先在 `review-agent-service/` 执行 `uv sync --locked`。根启动脚本使用该目录下的 `.venv`。

### 缺少 DashScope 配置

确认 `review-agent-service/.env` 存在且密钥有效。`.env.example` 只是模板。

### Node 无法导入 `.ts`

执行 `node --version`，确保版本不低于 `22.18.0`，然后重新运行 `npm ci` 和 `npm test`。

### Manifest 不是有效 JSON

确认修改的是 `review-extension/public/manifest.json`，然后重新运行 `npm run build`。`dist` 是可再生构建产物。

### 端口被占用

使用 `start-agent.ps1 -Port <端口>` 可以临时更换后端端口，但扩展当前固定访问 `127.0.0.1:8010`；联调时两端必须保持一致。

### PowerShell 中文显示异常

优先使用 PowerShell 7。必要时将当前终端切换为 UTF-8：

```powershell
chcp 65001
$OutputEncoding = [System.Text.Encoding]::UTF8
```
