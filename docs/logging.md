# 审核日志规范

日志的目标是让开发人员只看后端控制台，就能回答一次审核发生了什么：请求是否进入、使用了哪个 Profile（业务配置档案）、主图走了哪些节点、每项能力是否执行、材料识别哪些成功或失败、是否发生重试/超时/降级、最终建议是什么。日志用于诊断和审计线索，不能替代 `ReviewResponse`（审核响应）中的业务证据。

## 控制台日志格式

服务使用 Uvicorn（ASGI 服务运行器）的现有控制台输出，每条审核诊断日志以 `review_event` 开头，后面是稳定的 `key=value` 字段。例如：

```text
INFO review_event event=workflow_started trace_id=abc123 job_id=job-42 profile=scrap_replacement/qingdao/1.0 image_count=8 page_field_count=16
INFO review_event event=node_started trace_id=abc123 job_id=job-42 node=extract_evidence batch_completed=0 batch_failed=0 batch_timed_out=0 comparison_count=0 task_count=0 capability_count=0 degradation_count=0
INFO review_event event=image_extraction_completed trace_id=abc123 job_id=job-42 image_id=old_vehicle-03 document_type=scrap_certificate accepted_field_count=6 uncertain_field_count=0
INFO review_event event=capability_completed trace_id=abc123 job_id=job-42 capability_id=qingdao_replacement_policy status=SUCCEEDED attempts=1 duration_ms=12.4 check_count=3 limitation_count=0
INFO review_event event=workflow_completed trace_id=abc123 job_id=job-42 recommendation=REVIEW_REQUIRED risk_level=MEDIUM comparison_count=18 task_count=4 issue_count=1 degradation_count=0
```

`trace_id`（链路 ID）是一次审核的主索引；异步审核另外带 `job_id`（任务 ID）。排查问题时先复制这两个 ID，再按时间顺序查看日志。日志字段只记录标识、状态、数量、类型和耗时，不记录身份证号、完整发票号、OCR 原文、图片数据、密钥或完整第三方响应。

## 事件生命周期

| 事件 | 含义 | 重点字段 |
| --- | --- | --- |
| `http_review_requested` | 收到同步审核请求 | 端点、图片数、页面字段数 |
| `http_job_requested` / `http_job_created` | 收到并创建异步任务 | `job_id`、图片数 |
| `job_started` / `job_progress` / `job_completed` | 异步任务生命周期 | 完成、失败、超时数量和建议 |
| `workflow_started` / `workflow_completed` | 一次主图运行的开始和结束 | Profile、建议、风险、任务数、耗时由节点日志提供 |
| `node_started` / `node_completed` | 每个 LangGraph（流程图框架）节点的进入和退出 | 节点名、状态数量、输出键、耗时 |
| `node_failed` / `workflow_failed` | 节点或主图异常 | 异常类型、节点、耗时；异常堆栈由 logger.exception 保留 |
| `evidence_extraction_started` / `completed` | 批量材料识别开始和汇总 | 图片数、完成/失败/超时、观察数量 |
| `image_extraction_started` | 单张图片开始处理 | 图片 ID、业务范围、材料类型提示 |
| `image_extraction_completed` | 单张图片识别完成 | 图片 ID、材料类型、接受字段数、不确定字段数 |
| `image_extraction_failed` / `timed_out` / `rejected` | 单图失败、超时或材料类型不接受 | 图片 ID、错误分类或原因 |
| `capability_started` / `completed` | 能力注册表执行生命周期 | 能力 ID、类型、阶段、状态、尝试次数、检查数 |
| `capability_attempt_failed` | 能力一次尝试失败但可能重试 | 能力 ID、尝试次数、异常类型 |

## 日志级别

- `INFO`：正常生命周期、节点、能力和单图结果。开发和联调时默认查看这些日志。
- `WARNING`：单图失败、超时、能力降级、外部服务不可用。这些不一定导致整单失败，但必须在最终建议中可追溯。
- `ERROR`：节点、主图或异步任务未能产生正常结果。需要结合同一 `trace_id` 的前序事件定位。
- `DEBUG`：暂不用于输出原始材料或模型响应；如未来增加，只能输出脱敏摘要，并且默认关闭。

## 常见排查路径

1. 没有 `http_job_created`：请求没有通过 API 校验或服务未收到请求。
2. 有 `job_started`，没有 `workflow_started`：任务线程启动后在服务门面之前失败，查看同一任务的 `job_failed` 堆栈。
3. 有 `node_started` 没有 `node_completed`：该节点抛出异常，查对应的 `node_failed`。
4. `image_extraction_started` 后只有 `timed_out` 或 `failed`：检查模型配置、网络、单图超时和整单截止时间。
5. `capability_started` 后为 `BLOCKED`：先看能力计划的材料依赖，不要把它误判为代码异常。
6. 所有节点完成但建议为人工复核：查看 `node_completed` 的任务数量、`capability_completed` 的限制数量和最终 `workflow_completed` 的 `issue_count`。
7. 页面展示与后端不一致：使用 `trace_id` 对照 `prepare_review_tasks` 输出的任务数量和前端收到的响应，不要只看浏览器轮询请求日志。

## 流式任务排查

流式审核还应同时查看任务快照中的 `status`、`phase`、`uploaded_count`、`completed_count`、`failed_count` 和 `timed_out_count`：

- `UPLOADING` 且上传数不增长：检查 Content Script、图片读取和上传网络。
- `RECOGNIZING` 且识别数不增长：检查模型配置、模型服务网络和公平队列是否积压。
- `FINALIZING` 持续较久：检查二维码网页核验、能力超时和最终汇总队列。
- `PARTIAL + COMPLETED`：任务生命周期已结束，但部分图片失败或超时；它不是仍在后台运行。
- `CANCELLED`：客户端错误或显式取消已经终止任务，尚未执行的图片不会再进入模型。

创建、逐图上传、上传关闭和轮询接口的完整关系见[审核流水线文档](review-pipeline.md)。

## 代码约束

日志通过 `app/services/logging_context.py` 的 `emit`（事件输出器）统一输出。新增日志必须：

1. 使用稳定的英文 `event` 名称，并在本文件登记；
2. 携带当前链路的 `trace_id`，异步任务同时携带 `job_id`；
3. 记录状态、数量、耗时或错误分类等诊断信息；
4. 不输出业务字段原值、证件号码、图片 Base64、提示词和密钥；
5. 不在前端日志中复制后端业务结论，前端只记录页面写回、回读和 DOM 定位失败。

日志事件是诊断协议的一部分，但不能让业务逻辑依赖日志是否成功写出。日志输出异常不得改变审核结果。
