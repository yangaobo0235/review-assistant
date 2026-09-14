# 项目完整手册

本手册统一维护产品要求、页面契约、字段规则、LangGraph、运行配置和开发排错。整理日期：2026-09-14。产品要求用于验收，实现说明以当前源码为依据；文档不是所有功能已通过真实页面验收的证明。新增业务、修改审核规则或让新的 AI 接手项目时，应先阅读本文，再阅读源码和测试。文档中的中文名称是审核员看到的名称；代码中的字段键只用于接口和规则内部传递。

## 阅读目录

日常只需要根目录 README 和本手册；无需再按顺序打开多份指南。

- [1. 产品目标与边界](#1-产品目标与不可违反的边界)
- [2. 页面类型与逐字段规则](#2-页面类型与页面特点)
- [3. 材料清单](#3-材料清单与材料页行为)
- [4. 字段核验与差异展示](#4-字段核验统一算法)
- [5. 地区政策](#5-地区政策规则)
- [6. 二维码核验](#6-二维码官网核验)
- [7. 主体关系与回填](#7-主体关系与挂靠自动选择)
- [8. 工作台交互](#8-审核工作台交互规范)
- [9. 源码导航](#9-代码映射)
- [10. LangGraph 与 Profile](#10-langgraph-与-profile)
- [11. 接口与运行状态](#11-接口与运行状态)
- [12. 安装运行与配置](#12-安装运行与配置)
- [13. 开发验收与排错](#13-开发验收与排错)
- [14. 历史文档与维护](#14-历史文档与维护)

新 AI 接手：先读第 1–8 章理解产品要求，再按第 9–11 章定位代码；开发环境和验证命令集中在第 12–13 章。`archive/` 内是历史方案，不是当前需求，不应直接照着旧计划执行。

## 1. 产品目标与不可违反的边界

系统帮助审核员完成“采集页面和材料 → 识别证据 → 确定性核验 → 人工确认”的工作。系统给出审核建议，但最终决定由审核员完成。

1. 模型只负责材料分类、字段提取和证据位置，不能直接决定通过或驳回。
2. 规则必须是可解释、可测试的确定性代码。冲突、缺失、识别不确定、外部服务失败和规则未配置，统一进入人工复核。
3. 浏览器扩展不能自动点击通过、驳回、提交、取消或人工复核按钮。
4. 自动写入与人工回填分开：审核员可主动回填受支持的普通字段；唯一允许自动写入的是报废置换页面中原本为空的“报废车挂靠”和“新车挂靠”，且必须满足后端闸门、页面身份和控件安全预检。
5. 审核结果不能只显示“识别异常”。异常必须列出字段中文名、页面原值、材料识别值、差异字符、对应图片和“查看原图”。
6. 回填成功必须回读真实 DOM，随后滚动、聚焦并高亮目标控件；失败不能把审核步骤错误标记为已处理。

## 2. 页面类型与页面特点

### 2.1 报废置换页面

报废置换分为青岛和长春两个地区 Profile，页面结构都由“旧车信息”“新车及发票信息”两组组成。实际控件数量和顺序以每次 DOM 采集为准，不能用固定数组推断页面总数。页面可能使用 Ant Design、Element、原生 `select`、单选框或自定义下拉框，也可能同时存在隐藏的列表副本和可见详情弹窗。

页面必须能采集或识别以下字段：

| 页面中文名称 | 字段键 | 主要核验来源 | 规则 |
| --- | --- | --- | --- |
| 车辆所有人类型 | `application.owner_type` | 页面系统值 | 只接受个人/公司（企业），不需要 OCR；无效则人工确认 |
| 报废车辆类型 | `old_vehicle.type` | 旧车行驶证、登记证、报废证明 | 多来源标准化后比对 |
| 报废交车日期 | `old_vehicle.recycle_date` | 报废证明 | 必须是唯一可读日期，并符合地区截止日 |
| 报废证明编号 | `scrap_certificate.certificate_no` | 报废证明 | 比较完整字符串，缺少连字符等字符也必须标红 |
| 报废车辆车架号 | `old_vehicle.vin` | 旧车行驶证、登记证、报废证明 | VIN 规范化后跨材料比对，易混淆字符按位置标红 |
| 报废车辆车牌号 | `old_vehicle.plate_no` | 旧车行驶证 | 页面值与材料值比对 |
| 报废发动机型号 | `old_vehicle.engine_model` | 旧车登记证 | 页面值与材料值比对 |
| 报废车辆所有人 | `old_vehicle.owner` | 旧车行驶证、报废证明 | 多来源主体名称比对，并参与挂靠主体规则 |
| 新车燃料类型 | `new_vehicle.fuel_type` | 新车登记证 | 页面值与材料值比对 |
| 发票代码 | `invoice.code` | 新车发票 | 允许从数电发票号码适配得到，但必须在证据中说明来源 |
| 发票号码 | `invoice.invoice_no` | 新车发票 | 完整字符串比对 |
| 开票金额 | `invoice.amount` | 新车发票 | 金额标准化后比对 |
| 开票日期 | `invoice.invoice_date` | 新车发票 | 必须符合地区政策月份 |
| 新车车架号 | `new_vehicle.vin` | 新车行驶证、登记证、发票 | 多来源 VIN 比对；字符级差异标红 |
| OCR 新车车架号 | `page_ocr.new_vehicle_vin` | 页面 OCR 控件是被核验值；材料来源与新车 VIN 相同 | 作为独立字段核验，规则与新车车架号一致；不参与挂靠主体关系 |
| 新车车牌号 | `new_vehicle.plate_no` | 新车行驶证 | 页面值与材料值比对 |
| 新车所有人 | `new_vehicle.owner` | 新车行驶证、发票 | 多来源主体名称比对，并参与挂靠主体规则 |
| 注册日期 | `new_vehicle.registration_date` | 新车行驶证 | 页面值与材料值比对 |
| 终端证件号 | `application.terminal_certificate_no` | 新车发票 | 页面值与材料值比对 |
| 客户名称 | `application.customer_name` | 新车发票、新车所有人 | 参与主体辅助检查 |
| 终端客户手机号 | `application.terminal_phone` | 新车发票 | 页面值与识别值逐字符比较，错误字符标红 |
| 报废车挂靠 | `old_vehicle.affiliation` | 主体关系推导 | 只允许在安全闸门通过后自动选择个人/公司 |
| 新车挂靠 | `new_vehicle.affiliation` | 主体关系推导 | 只允许在安全闸门通过后自动选择个人/公司 |

报废置换页面的侧边栏必须按字段工作台展示：字段中文名、状态、页面原值、材料提取值、缩略图、查看原图、差异高亮、人工输入框和回填按钮。英文键（如 `scrap_certificate`、`old_vehicle.affiliation`）不得直接展示给审核员。

### 2.2 过户页面

过户使用 `transfer/default/1.0`，仍走旧版结果页，不启用报废置换字段优先工作台。核验字段为车牌号、车架号、发票买方名称、卖方名称和开票日期；材料要求为二手车发票和机动车登记证第 1、2、3、4 页。规则包括页面/发票/登记证比对、登记历史和日期顺序检查。当前旧版界面按配置字段展示异常，不具备报废置换工作台的完整 DOM 控件目录；扩展这一能力须单独实现与验证。

### 2.3 车源页面

车源使用 `vehicle_source/default/1.0`。当前没有确定性规则，必须显示“车源审核规则尚未配置，请人工复核”，不能误报通过，也不能执行任何页面写入。

### 2.4 一致性审核页面

青岛和长春一致性审核入口已经隔离，但当前规则未配置，统一人工复核。不得借用报废置换的日期、二维码或挂靠规则。

## 3. 材料清单与材料页行为

报废置换要求：旧车行驶证、旧车登记证第 1、2 页、报废证明、新车行驶证、新车登记证第 1、2 页、新车发票。材料完整性界面要列出本次检查过的每种材料，而不是只列异常材料；每项显示“材料已提供、缺失或待确认”，并在有图片时显示缩略图和查看原图。

材料识别异常必须显示：材料名称、字段中文名、识别值、异常原因、对应图片。图片证据通过稳定 `imageId` 定位，不能因为 DOM 变化而误定位到另一张图片。单次最多提交 10 张图，原图最多 20 MB，归一化后单图最多 5 MB、最长边 2048px、JPEG 质量 0.85。

## 4. 字段核验统一算法

本章是比较和展示的公共约束；具体来源数量与缺失处理以 `field_evidence_policies.py` 和 `aggregate.py` 为准，不能强制每个允许来源都存在。

每个字段先经过允许来源过滤，再执行字段专用标准化，最后聚合成 `MATCH`、`CONFLICT` 或 `REVIEW_REQUIRED`。

1. 页面原值、材料识别值、二维码官网值分别保留原始文本和规范化文本。
2. 标准化只用于判断，不得覆盖界面上的原始值；界面必须同时展示原始值和识别值。
3. 页面值与允许的有效材料证据规范化后相同为 `MATCH`；规范化后不同为 `CONFLICT`；任一关键来源缺失、不确定或不可读为 `REVIEW_REQUIRED`。
4. VIN、车牌、证明编号、手机号等字符串差异必须在“识别值”文本中逐字符标红。缺少字符、增加字符、连字符差异和位置错位都算差异，不能只依赖整串颜色或黄色提示。
5. `new_vehicle.vin` 与 `page_ocr.new_vehicle_vin` 必须分别生成审核步骤：各自的页面原值来自各自文本框，材料识别值来自相同的新车 VIN 证据池。不能把两只控件的值串用、混入“不一致”提示，也不能写死某一位字符。
6. 页面原值和材料识别值都错误时，显示人工输入框，默认值为页面原值；审核员输入的值才是本次回填候选。

## 5. 地区政策规则

规则代码位于 `app/businesses/replacement_policies.py` 和 `app/rules/replacement_policy_checks.py`。

| 地区 | 新车发票日期 | 报废交车截止 | 发票产地 |
| --- | --- | --- | --- |
| 青岛 | 2026-09-01 至 2026-09-30 | 不晚于 2026-10-31 | 按配置的青岛值判断 |
| 长春 | 2026-07-01 至 2026-09-30 | 不晚于 2026-12-31 | 识别值包含“长春”即可通过 |

新车发票产地必须像其他字段一样展示材料识别值、对应发票图片和查看原图。平台名称不属于当前核验条件。日期和产地规则只使用指定发票/报废证明材料的识别值，不拿页面显示值替代材料政策证据。

## 6. 二维码官网核验

安全网址可点击与官网核验通过是两个状态；后台访问失败不能因此标记整项通过。

二维码流程位于 `app/services/qr.py`：本地解码 → URL 规范化 → HTTPS 校验 → `qclt.mofcom.gov.cn` 域名白名单 → 重定向和证书校验 → 官网内容读取。界面只保留审核员真正需要的“通过安全校验的官网网址”，地址必须可点击打开供人工核验；原始二维码内容可放在技术详情中。官网暂时无法访问但域名和安全校验通过时，状态应允许人工点击，不应把安全地址误判为非法地址。

## 7. 主体关系与挂靠自动选择

主体关系规则位于 `app/rules/affiliation_subject_checks.py`。当前个人主体需要对应身份证正反面，公司主体需要对应营业执照；相同主体合并材料要求。相同公司名称仍须确认执照，不同公司或个人与公司组合还须核对法人。下述同名/法人关系判断须同时满足这些材料条件。系统根据旧车所有人、新车所有人、营业执照、身份证和页面所有人类型判断个人/公司及法人关系：个人同名通过，个人不同名冲突；公司同名通过；不同公司需要各自营业执照且法人相同；个人与公司需要公司法人等于该个人。证据缺失、遮挡、歧义或冲突都不能生成填写意图。

主体关系与客户名称辅助检查通过后，后端只生成两个字段的 `page_fill_intent`，扩展才可执行自动下拉选择。页面写入必须：

- 只寻找可见的当前详情表单，不使用隐藏列表副本；
- 精确找到唯一控件和唯一“个人/公司”选项；
- 确认页面 URL、页面实例、`collectionId`、申请单号/VIN 指纹仍一致；
- 确认目标当前为空，不覆盖人工已有值；
- 写入后回读真实控件值；任一步骤失败则回滚已写入字段；
- 成功后滚动到控件、聚焦并高亮，让审核员能看到实际回填位置。

“回填此值”是普通字段的人工回填操作，也必须回读、定位和高亮；它不能自动改变审核步骤为“已处理”。“已处理”只能由审核员点击“标记人工复核”产生，不再增加“保留页面值”或“确认已核对”按钮。回填失败须释放忙碌状态并显示原因；只有页面身份确实失效才阻断整轮操作，普通控件失败不应使所有按钮失效。页面身份失效后提供重新采集入口，禁止放宽守卫以强行回填。

## 8. 审核工作台交互规范

- 页面原值必须读取实际控件值，不能把邻近的“不一致”“易混淆”等校验提示拼进值里；不能靠删除固定提示词代替正确采集。
- 删除重复的“申请页面字段”候选行，材料区只列实际证据；结构化主体数据展开为中文字段，不显示对象字符串。
- “待处理”页签显示待处理数量；“全部字段”和“页面外核验”页签也必须在括号内显示数量。
- 正常字段、异常字段和页面外规则按同一套步骤模型展示，不重复生成英文内部键。
- 材料提取值每行都是识别出的字段文本，下面横向排列缩略图与“查看原图”；不要显示多余的“图片识别”字样。
- “回填此值”和“查看原图”使用明显不同的颜色和语义；回填成功后显示成功反馈并定位页面字段。
- 页面原值、材料识别值、人工输入值三者必须区分；识别值与页面值不一致时只在识别值中标红差异字符。
- 新车发票产地、旧车登记证第 1、2 页、新旧车挂靠主体关系等页面外项目都要显示材料图片和查看原图。
- 材料完整性与识别异常必须说明核验了哪些材料、哪些页、哪些字段。
- 二维码、政策、主体关系和材料完整性属于页面外核验，不应伪装成普通页面字段。

## 9. 代码映射

后端：`app/agent/workflow.py`（主图）、`app/businesses/profiles.py`（Profile）、`app/rules/review_fields.py`（字段）、`app/rules/field_evidence_policies.py`（证据来源）、`app/rules/normalize.py` 与 `aggregate.py`（标准化聚合）、`app/rules/review_step_routing.py`（步骤路由）、`app/rules/material_completeness.py`（材料）、`app/rules/replacement_policy_checks.py`（地区政策）、`app/rules/affiliation_subject_checks.py`（主体关系）、`app/services/qr.py`（二维码）。

扩展：`public/page-field-collector.js`（页面字段采集）、`public/image-candidates.js` 与 `image-normalization.js`（材料图片）、`public/content.js`（消息协调）、`public/image-focus.js`（原图定位）、`public/page-field-writer.js`（自动挂靠与人工字段回填）、`src/hooks/useReviewWorkflow.ts`（任务生命周期）、`src/components/ScrapReplacementReview.tsx` 内 Workbench（当前字段审核状态）、`src/components/ScrapReplacementReview.tsx`（目标业务工作台）、`src/components/ReviewResults.tsx`（业务分流）、`src/valueDiff.ts`（字符差异）。实际加载顺序以 `public/manifest.json` 为准。

## 10. LangGraph 与 Profile

### 固定审核主图

主图定义在 `review-agent-service/app/agent/workflow.py`，所有已配置业务共用以下固定顺序：

```text
START
 -> validate_context
 -> assess_collected_materials
 -> extract_documents
 -> assess_extracted_evidence
 -> run_external_checks
 -> compare_same_fields
 -> run_business_rules
 -> prepare_review_steps
 -> derive_recommendation
 -> build_final_response
 -> END
```

| 节点 | 职责 | 主要输出 |
| --- | --- | --- |
| `validate_context` | 校验业务、地区、版本、路由和 Profile 一致 | 稳定请求上下文 |
| `assess_collected_materials` | 按材料策略检查已采集种类、分组和页数 | 初步完整性报告 |
| `extract_documents` | 调用模型分类材料并提取白名单字段、证据位置 | `AgentBatchResult` |
| `assess_extracted_evidence` | 检查缺失、不可读、不确定和材料页要求 | 更新后的完整性报告 |
| `run_external_checks` | 执行 Profile 声明的二维码等外部核验 | `qr_checks`、外部检查 |
| `compare_same_fields` | 标准化并聚合页面、图片、二维码观察值 | `comparisons` |
| `run_business_rules` | 按注册表顺序执行政策、主体关系、过户规则 | `cross_checks`、填写候选 |
| `prepare_review_steps` | 生成中文、有序、可展示的审核步骤和路由 | `review_steps` |
| `derive_recommendation` | 汇总冲突、证据不足和限制 | 建议与风险 |
| `build_final_response` | 组装最终 API 响应 | `ReviewResponse` |

节点只表达通用阶段。二维码、地区政策和挂靠关系通过 Profile 的能力声明接入，不为每个业务复制一张图。

### 业务配置

Profile 定义于 `app/businesses/profiles.py`，由 `BusinessRegistry` 按三元组精确解析。关键字段：

- `required_fields`、`sections`：页面/材料审核字段和分组。
- `material_policy`、`retry_policy`：材料完整性和重试预算。
- `external_checks`：外部核验规格，例如 `scrap_certificate_qr`。
- `rule_groups`：确定性规则组 ID。
- `page_actions`：允许的页面动作，目前只有 `fill_affiliation_fields`。
- `replacement_policy`：地区日期、交车截止和发票产地政策。

当前 Profile：

| 业务 | Profile | 能力 |
| --- | --- | --- |
| 报废置换 | `qingdao/1.0` | 二维码、青岛政策、主体关系、挂靠填写 |
| 报废置换 | `changchun/1.0` | 二维码、长春政策/产地、主体关系、挂靠填写 |
| 过户 | `default/1.0` | 登记历史和日期顺序 |
| 车源 | `default/1.0` | 未配置，直接人工复核 |
| 一致性 | `qingdao/1.0`、`changchun/1.0` | 地区入口已隔离，规则未配置 |

外部核验注册在 `app/rules/external_check_registry.py`，业务规则注册在 `app/rules/business_rule_registry.py`；内置处理器在 `ReviewWorkflow.__init__` 注册。新增简单能力时增加 Profile、处理器和测试，不修改主图。

### 状态与扩展方式

主图通过 `ReviewState` 传递 `request`、`profile`、`batch`、材料报告、二维码、字段响应、业务检查、审核步骤和建议。`StateGraph` 按固定顺序连接节点，`compile()` 没有 Checkpoint，`ainvoke()` 一次运行到结束；图片内部并发和重试由提取服务完成。图不会为了等待审核员而暂停。

当前报废置换工作台来自 `ReviewResults → ScrapReplacementReview → Workbench`。`useScrapReplacementReview.ts`、`reviewSession.ts` 和页面标记客户端仍保留旧兼容逻辑，不能据文件存在就认定它们是当前主入口。当前字段步骤在侧边栏展示；协议保留 `PAGE_FIELD` 枚举不代表页面仍注入旧版字段标记。

报废置换和过户材料策略当前均为 `enforce`。语义重试、置信度和二维码重试配置在 `app/businesses/material_policies.py`；默认语义重试 1 次、置信度阈值 0.70、最小重试窗口 2 秒、二维码解码最多 3 轮、官网重试 1 次。`app/agent/service.py` 中单任务图片并发为 6，单图预算 50 秒、提取批次预算 55 秒；不能将提取批次预算当作包括全部官网访问的整单硬超时。

模型连接参数在 `app/agent/config.py`；材料提取策略和提示词入口分别为 `app/agent/document_policies.py`、`app/agent/qwen_client.py`，字段路由在 `app/agent/field_routing.py`。修改提取能力时同步核对输出模型、白名单和证据定位，不能仅修改提示词。

## 11. 接口与运行状态

### 请求生命周期

页面识别业务和地区 → 采集实际控件、原值及材料图片 → 图片筛选/压缩 → 创建后台任务 → 模型提取 → 外部核验 → 字段比较 → 业务规则 → 完整结果 → 侧边栏人工处理/受控回填 → 重新采集最终复核。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/api/review/assist` | 同步审核 |
| POST | `/api/review/jobs` | 创建异步审核任务，返回 202 |
| GET | `/api/review/jobs/{job_id}` | 查询进度、部分结果或最终结果 |

请求/响应契约为 `app/models/review.py` 中的 `ReviewRequest` 和 `ReviewResponse`，扩展对应 `src/types/review.ts`。请求包括业务、地区、版本、页面字段、实际控件快照 `review_fields`、图片和采集诊断。响应包括 `comparisons`、`cross_checks`、`qr_checks`、`material_completeness`、`review_steps`、`page_fill_intent`、问题、识别限制和最终建议。

`review_steps` 用 `step_id` 唯一标识、`sequence` 排序、`category` 分类，并携带原值、证据、人工动作要求。字段比较的不足状态为 `REVIEW_REQUIRED`，步骤不足状态为 `INSUFFICIENT`，不要混用。最终建议正常路径为 `PASS` 或 `REVIEW_REQUIRED`；风险为 LOW/MEDIUM/HIGH。人工“已处理”不会把后端 CONFLICT 改成 MATCH。

`app/services/jobs.py` 的任务状态为 RUNNING、PARTIAL、COMPLETED、FAILED，按更新时间保留 600 秒；扩展默认每秒轮询、展示等待时限 60 秒。任务不存在/过期返回 404，Profile 不存在或不兼容返回 422。部分识别结果用于展示进度，不能冒充最终核验完成。

后端任务在进程内存，前端人工决定在 React 内存，刷新/关闭后不会恢复。当前没有任务数据库、认证授权、租户隔离、全局限流、对象存储或生产级审计。图片通过 Data URL 传输；Manifest 页面匹配范围仍宽，生产化要求见根目录 SECURITY.md。

## 12. 安装运行与配置

以下命令从仓库根目录开始；新开终端后确认所在目录，前后端服务分别运行。

| 工具 | 版本 |
| --- | --- |
| Python | `>=3.11,<3.13` |
| uv | 使用当前稳定版本 |
| Node.js | `>=22.18.0` |
| npm | 随 Node.js 安装 |
| 浏览器 | Microsoft Edge 或 Google Chrome |

扩展测试会直接导入 TypeScript 模块，因此 Node.js 版本不能低于 `22.18.0`。如果出现 `ERR_UNKNOWN_FILE_EXTENSION: .ts`，先检查 `node --version`。

### 后端服务

#### 安装依赖

```powershell
cd review-agent-service
uv sync --locked
```

#### 配置模型

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

#### 启动

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

### 浏览器扩展

#### 安装依赖

```powershell
cd review-extension
npm ci
```

#### 开发与构建

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

#### 加载扩展

1. 打开 `edge://extensions` 或 `chrome://extensions`。
2. 开启开发者模式。
3. 选择“加载解压缩的扩展”。
4. 选择 `review-extension/dist`。
5. 代码更新后重新构建、重新加载扩展，并刷新业务页面，使 Content Script 同步更新。

## 13. 开发验收与排错

### 代码职责

#### 后端

- API 层只负责参数校验和 HTTP 状态，不实现审核规则。
- `app/businesses/` 管理业务、地区、版本和材料策略。
- Agent 层负责模型调用、字段提取和工作流编排，不直接决定通过或驳回。
- Rules 层负责标准化、比较和建议生成，不访问浏览器页面。
- Services 层协调任务、二维码和响应组装，不重复领域模型。
- 公共请求、响应和跨层接口使用明确类型，避免用 `Any` 绕过可表达的领域模型。

#### 扩展

- React 组件负责展示，Hook 负责生命周期，HTTP 客户端负责接口与错误映射。
- `public/content.js` 只做页面脚本协调，复杂采集逻辑保持在独立模块。
- Manifest 加载的公共脚本依赖稳定的全局名称和加载顺序，调整前必须增加回归测试。
- 审核规则只存在于后端；扩展只展示服务端结果。
- 自动写入仅允许 `page_fill_intent` 指定的两个挂靠字段，人工回填走独立受控入口；必须绑定采集时的标签页、URL、页面实例和稳定记录指纹，并对空值、唯一控件、唯一选项及回读结果做校验。没有申请单号或 VIN 等强锚点时不得自动填写。
- 逐项审核的当前步骤和人工处理选择只使用 React 内存状态，不增加本地存储或后端持久化。

### 变更约定

- 行为变更先写聚焦测试，再实现最小改动。
- 失败、超时、证据不足或未配置规则必须降级为人工复核。
- 新业务必须有独立 `BusinessProfile`、字段范围、材料策略、确定性规则和回归测试。
- 新页面优先通过 Profile 声明 `external_checks`、`rule_groups` 和 `page_actions`，以及在注册表中增加普通处理器；简单规则不得复制或修改 LangGraph 主图。
- 只有包含多阶段、条件分支、独立重试或较多专用状态的复杂能力才考虑用子图适配器，并保持统一处理器输入输出。
- 不要修改生成目录、虚拟环境或第三方依赖目录中的文件。
- 注释解释业务原因、兼容性和非直观失败处理，不逐行翻译代码。

### 验证命令

新增字段时必须同步更新字段清单、中文名称、证据策略、材料来源、比较/标准化逻辑、审核步骤路由、界面展示和测试。新增业务时必须新增独立 Profile、材料策略、规则组和回归测试。

代码变更的完整验证命令如下；仅文档变更的检查范围见本节下文：

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

真实页面功能还必须在重新加载扩展并刷新业务页面后验证，特别是下拉选择、回填回读、定位高亮、隐藏表单防误写和页面变更后的阻断行为。

仅文档变更检查链接、目录、内容一致性和 `git diff --check` 即可。代码变更按影响范围执行针对性测试和项目要求的检查；测试数量应引用本次实际结果，不把历史通过数量当作当前验证。

### 常见问题

#### Agent 找不到 Python 环境

先在 `review-agent-service/` 执行 `uv sync --locked`。根启动脚本使用该目录下的 `.venv`。

#### 缺少 DashScope 配置

确认 `review-agent-service/.env` 存在且密钥有效。`.env.example` 只是模板。

#### Node 无法导入 `.ts`

执行 `node --version`，确保版本不低于 `22.18.0`，然后重新运行 `npm ci` 和 `npm test`。

#### Manifest 不是有效 JSON

确认修改的是 `review-extension/public/manifest.json`，然后重新运行 `npm run build`。`dist` 是可再生构建产物。

#### 端口被占用

使用 `start-agent.ps1 -Port <端口>` 可以临时更换后端端口，但扩展当前固定访问 `127.0.0.1:8010`；联调时两端必须保持一致。

#### PowerShell 中文显示异常

优先使用 PowerShell 7。必要时将当前终端切换为 UTF-8：

```powershell
chcp 65001
$OutputEncoding = [System.Text.Encoding]::UTF8
```

#### 回填不生效或页面卡住

依次查 `pageFields/review_fields` 采集值是否污染、`pageFillClient.ts` 的身份与 expectedValue、`content.js` 的消息返回、writer 的可见表单和选项定位、真实 DOM 回读、工作台 finally 是否释放 busy。不要硬编码某个 VIN 或去掉身份检查；刷新/换单与单控件选项失败应分别处理。

#### 图片、数量或差异展示不对

查后端值的 `image_id/image_index` 是否能关联本次图片、页面原值是否来自控件、材料值是否有正确字段和来源、`groupedDisplaySteps` 是否正确合并日期/二维码/材料项，以及字符高亮的 DOM 与 CSS。图片未采集时应明确说明缺少证据，不能拿别的图片补位。

## 14. 历史文档与维护

本手册合并了原 architecture、project-guide、development 和两个子项目 README 的有效内容。子项目 README 仅保留到本手册的指引；后端 README 还被 pyproject.toml 作为包描述引用，因此保留文件。

8 份历次设计/计划保存在 [历史方案目录](archive/README.md)，保留原文以便追溯，其中相互冲突的旧设计不是当前实现规范，也不表示全部计划已完成。需要追溯旧决策时再阅读，日常开发不必遍历归档。

今后字段/页面需求改第 2–8 章，工作流/接口改第 9–11 章，环境/排错改第 12–13 章。同一事实只维护一处；新增临时计划不应再成为另一份长期主文档。需求与实现有差异时明确记录差异和验收结果，不静默改写用户要求。
