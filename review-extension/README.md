# Review Extension

浏览器扩展负责页面采集、审核工作台呈现和受控写回。它通过后端协议获得事实与任务，不实现服务端业务规则。

其中 `PageAdapter`（页面适配器）负责网页采集，`Renderer`（渲染器）负责工作台展示，`PageAction`（页面动作）负责受控写回；`DOM`（页面文档对象模型）只允许在浏览器侧访问。

## 目录职责

| 目录 | 职责 |
| --- | --- |
| `src/browser` | DOM 读取、页面识别、图片候选和浏览器 API |
| `src/adapters` | 页面到 `PageData` 的适配器 |
| `src/session` | 会话、页面动作控制和动作注册表 |
| `src/components` | React 工作台和任务渲染器 |
| `src/hooks` | 工作流状态和请求编排 |
| `src/types` | 前端协议和页面动作类型 |
| `public/manifest.json` | 扩展权限与入口声明 |
| `dist` | 构建产物，禁止手工编辑 |

## 页面扩展规则

新增审核页面先添加 `PageAdapter` 和 `PageActionRegistry` 条目，再接入通用采集与工作台。页面选择器、字段定位、写回白名单只能存在适配器或动作控制器中；不要把 DOM 选择器放进后端或 React 业务组件。

## 本地验证

```powershell
npm install
npm test
npm run lint
npm run build
```

普通 `npm run build` 生成连接本地 `127.0.0.1:8010` 的开发版，扩展名称会显示为“赋界审核助手(本地)”；`npm run build:public` 生成连接腾讯云审核服务的朋友试用版，扩展名称保持为“赋界审核助手”。需要临时连接其他环境时，可在构建进程中设置 `VITE_AGENT_BASE_URL`。

## 前端运行链路

页面脚本先通过 `COLLECT_PAGE_MANIFEST` 采集标准 `PageData` 清单，不在初始阶段读取全部图片。Hook 创建流式任务后启动两个上传 Worker；每个 Worker 通过 `READ_REVIEW_IMAGE` 逐张完成图片读取、压缩和 multipart 上传，服务端可以同时开始识别。Hook 每秒轮询任务状态，最长等待 120 秒，响应中的 `ReviewTask` 进入任务工作台。

浏览器图片压缩并发和上传并发均为 2。压缩后的图片可以保留在当前页面状态中用于结果缩略图，但发送到创建任务接口的清单和上传 metadata 不得重复携带 Base64 正文。Renderer 只负责可视化和用户确认；Action Controller 在执行前重新确认页面实例、字段原值和动作权限。任何网络错误、协议错误或页面变化都应显示为可恢复状态，不能静默清空审核结果。完整生命周期见[审核流水线文档](../docs/review-pipeline.md)。

重新加载或更新扩展后，已经打开的业务网页不会自动获得新 Content Script。出现 `Could not establish connection. Receiving end does not exist.` 时，应刷新业务网页并重新打开侧边栏，不要把它误判为后端故障。

## 代码评审重点

检查组件是否只消费后端结果、Hook 是否避免重复请求、Adapter 是否处理异步 DOM 和页面刷新、Action 是否执行白名单与回读、Manifest 是否只申请必要权限、类型是否与后端协议一致。禁止直接改 `dist`、在 `public` 新增旧式业务脚本，或在 UI 层复制后端规则。
