# Review Assistant Extension

基于 Manifest V3 的浏览器扩展，负责识别车辆审核页面、采集字段与材料图片，并在 Side Panel 中展示 Agent 返回的进度、证据和审核建议。

目标业务（报废置换青岛/长春 `1.0`）使用字段优先流程：后端一次运行到底并返回带展示路由的审核步骤，扩展把 `PAGE_FIELD` 步骤标记在宿主页面原字段旁（成功项常驻标记，异常项只出现“确认无误 / 标记异常”，任一点击立即进入下一项），Side Panel 助手只显示当前唯一一个页面外待人工事项或一个阻塞问题，不显示正常成功项、页面字段副本、完成历史或汇总。过户、车源和一致性审核继续使用原有结果界面和行为。扩展不会自动点击“通过”“驳回”“立即提交”或“取消”。

唯一自动写入白名单是原本为空的“报废车挂靠”和“新车挂靠”两个字段：仅当后端主体关系与三个辅助保护检查全部通过并返回填写意图时，`public/page-field-writer.js` 才执行一次联合预检（目标唯一、当前为空、控件可用、选项唯一、页面身份一致）加写入、回读；任一条件失败则两个字段都不写入，写入或回读失败会全量回滚，回滚同样只允许这两个字段。

标记、决定回传、原图定位和页面填写都绑定采集时的标签页、页面 URL、页面实例、单次采集标识（`collectionId`）及申请单号或 VIN 记录指纹；任一身份失效（导航、刷新、同 URL 换单、控件重渲染）都会立即停止后续标记和写入，并在助手中显示阻塞原因。人工“确认无误 / 标记异常”只记录在 Side Panel 的 React 内存中，绝不改写后端返回的 `MATCH/CONFLICT/INSUFFICIENT` 结论，关闭或刷新后清空。

## 快速开始

要求 Node.js `>=22.18.0`。

```powershell
npm ci
npm run build
```

在 Edge 的 `edge://extensions` 或 Chrome 的 `chrome://extensions` 中开启开发者模式，然后加载 `dist` 目录。Agent 服务需要运行在 `http://127.0.0.1:8010`。

## 代码导航

- `public/`：Manifest、后台脚本和页面采集脚本。
- `public/page-review-marker.js`：在原字段旁渲染只读核验标记和人工决定按钮；只操作扩展自己的节点。
- `public/page-field-writer.js`：两个挂靠字段的受限预检、填写、回读和全量回滚。
- `src/App.tsx`：Side Panel 页面组合。
- `src/hooks/useReviewWorkflow.ts`：采集、任务轮询和结果生命周期。
- `src/hooks/useScrapReplacementReview.ts`：目标业务的字段优先会话编排和一次性挂靠写入闸门。
- `src/reviewSession.ts` / `src/reviewSteps.ts`：纯内存会话状态机与步骤排序、人工动作判定。
- `src/pageReviewClient.ts` / `src/pageFillClient.ts`：带页面身份的标记消息和挂靠填写消息客户端。
- `src/components/ScrapReplacementReview.tsx`：目标业务助手，只显示当前页面外待人工事项或阻塞问题。
- `src/components/`：进度、完整性、建议和证据组件；`ReviewResults.tsx` 按业务 Profile 分流新旧界面。
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
