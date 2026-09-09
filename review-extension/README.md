# Review Assistant Extension

基于 Manifest V3 的浏览器扩展，负责识别车辆审核页面、采集字段与材料图片，并在 Side Panel 中展示 Agent 返回的进度、证据和审核建议。

扩展只读取页面并展示辅助结果，不会自动提交“通过”或“驳回”。

## 快速开始

要求 Node.js `>=22.18.0`。

```powershell
npm ci
npm run build
```

在 Edge 的 `edge://extensions` 或 Chrome 的 `chrome://extensions` 中开启开发者模式，然后加载 `dist` 目录。Agent 服务需要运行在 `http://127.0.0.1:8010`。

## 代码导航

- `public/`：Manifest、后台脚本和页面采集脚本。
- `src/App.tsx`：Side Panel 页面组合。
- `src/hooks/useReviewWorkflow.ts`：采集、任务轮询和结果生命周期。
- `src/components/`：进度、完整性、建议和证据组件。
- `src/reviewClient.ts`：Agent HTTP 客户端。
- `src/*Presentation.ts`：后端结果到界面模型的转换。
- `tests/`：Node.js 测试。

## 验证

```powershell
npm test
npm run build
npm run lint
```

完整说明见项目 [README](../README.md)、[架构文档](../docs/architecture.md) 和 [开发指南](../docs/development.md)。
