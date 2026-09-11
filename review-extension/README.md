# Review Assistant Extension

基于 Manifest V3 的浏览器扩展，负责识别车辆审核页面、采集字段与材料图片，并在 Side Panel 中展示 Agent 返回的进度、证据和审核建议。

扩展读取页面并逐项展示全部审核结果。唯一自动写入例外是：后端确定性核验允许时，填写原本为空的“报废车挂靠”和“新车挂靠”。扩展不会自动点击“通过”“驳回”“立即提交”或“取消”。

页面填写绑定采集时的标签页、页面 URL、页面实例及申请单号或 VIN 记录指纹；没有稳定记录指纹，或控件已有值、不唯一、禁用、选项歧义、页面刷新、同 URL 换单、回读失败时立即停止。`collectionId` 仅用于原图定位，它将定位请求绑定到当前图片映射，不参与页面填写约束。人工查看进度只保存在 Side Panel 的 React 内存中，关闭或刷新后清空。

## 快速开始

要求 Node.js `>=22.18.0`。

```powershell
npm ci
npm run build
```

在 Edge 的 `edge://extensions` 或 Chrome 的 `chrome://extensions` 中开启开发者模式，然后加载 `dist` 目录。Agent 服务需要运行在 `http://127.0.0.1:8010`。

## 代码导航

- `public/`：Manifest、后台脚本和页面采集脚本。
- `public/page-field-writer.js`：两个挂靠字段的受限预检、填写和回读。
- `src/App.tsx`：Side Panel 页面组合。
- `src/hooks/useReviewWorkflow.ts`：采集、任务轮询和结果生命周期。
- `src/components/`：进度、完整性、建议和证据组件。
- `src/components/ReviewFieldStepper.tsx`：按后端顺序展示全部核验步骤和会话内人工处理。
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
