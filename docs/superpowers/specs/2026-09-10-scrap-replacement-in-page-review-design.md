# 青岛、长春报废置换原页面逐字段核验设计

## 1. 背景

当前扩展在后端完成整单审核后，把页面字段比对、地区政策、主体关系、材料完整性、二维码结果和证据集中展示在审核助手中。这会造成页面已有字段重复展示，也不能清晰表达“当前核验哪个字段”以及“异常时等待审核员处理”。

本次将报废置换审核调整为类似表单助手的逐项流程，但用途是只读核验，不是批量填写。唯一保留的写入能力是现有的“报废车挂靠”和“新车挂靠”自动填写。

## 2. 改造范围

只改造以下两个业务配置：

- `scrap_replacement/qingdao/1.0`
- `scrap_replacement/changchun/1.0`

过户、车源和一致性审核保持现有交互，不纳入本次改造。

## 3. 改造目标

1. 页面已有字段在原字段附近逐项显示核验状态。
2. 核验成功后保留“已核验”标记并自动进入下一项。
3. 冲突、证据不足或页面定位异常时暂停，等待审核员操作后继续。
4. 页面没有承载位置且需要人工确认的政策、派生关系、外部核验和异常信息只在审核助手中展示；正常通过项不展示。
5. 后端明确返回检查类型、展示目标和关联页面字段，扩展不通过中文名称猜测展示位置。
6. 保留两个挂靠字段的受控自动填写，并在主体关系核验步骤执行。
7. 后端仍一次运行到底，不引入人工中断、数据库或 LangGraph 检查点。

## 4. 非目标

- 不改变青岛、长春现有政策日期、产地和主体关系规则。
- 不修改页面中除两个挂靠字段之外的任何值。
- 不自动点击整单通过、驳回、提交或取消。
- 不保存跨刷新、跨页面或跨服务重启的审核进度。
- 不增加任务数据库、消息队列或人工恢复接口。

## 5. 核心设计原则

### 5.1 后端决定展示位置

每个审核步骤必须声明：

- `PAGE_FIELD`：页面存在可定位字段，在原字段旁显示。
- `ASSISTANT`：页面没有独立承载位置，在审核助手显示。

扩展只能读取结构化字段路由，不能按 `label`、`reason`、步骤 ID 前缀或中文关键字推断。

### 5.2 规则结论与人工操作分离

后端状态保持：

- `MATCH`：证据充分且一致，或规则满足。
- `CONFLICT`：可靠证据明确冲突，或规则不满足。
- `INSUFFICIENT`：页面、材料、识别或外部证据不足。

审核员的“人工确认无误”或“标记异常”只记录步骤已处理，不能把后端异常状态改成 `MATCH`。

### 5.3 页面标记不修改业务字段

页面核验状态通过扩展创建的独立 DOM 标记展示。标记不能触发输入事件、不能改变字段值，清理时也只能删除扩展自己创建的节点。

### 5.4 页面变化时安全停止

页面刷新、切换申请单、字段候选不唯一、目标节点失效、URL 或记录指纹变化时，停止后续标注和挂靠填写，不重新模糊查找相似字段。

## 6. 后端审核步骤契约

在现有 `ReviewStep` 增加结构化展示信息：

```python
class ReviewDisplayTarget(str, Enum):
    PAGE_FIELD = "PAGE_FIELD"
    ASSISTANT = "ASSISTANT"


class ReviewStep(BaseModel):
    step_id: str
    sequence: int
    category: Literal["FIELD", "EXTERNAL", "BUSINESS_RULE", "MATERIAL"]
    display_target: ReviewDisplayTarget
    page_field: str | None = None
    requires_reviewer_action: bool
    label: str
    result_status: Literal["MATCH", "CONFLICT", "INSUFFICIENT"]
    reason: str
    values: list[ReviewCheckValue] = Field(default_factory=list)
    evidence: list[Evidence] = Field(default_factory=list)
```

契约约束：

- `display_target == PAGE_FIELD` 时，`page_field` 必须是实际采集到的规范字段。
- `display_target == ASSISTANT` 时，`page_field` 必须为空。
- `MATCH` 的 `requires_reviewer_action` 为 `False`。
- `CONFLICT` 和 `INSUFFICIENT` 的 `requires_reviewer_action` 为 `True`。
- `sequence` 是整单唯一顺序，扩展严格按顺序执行。
- 后端一次返回完整步骤，不新增暂停或恢复接口。

如果基础字段在规则清单中但本次页面没有成功采集，该步骤改为 `ASSISTANT + INSUFFICIENT`，说明页面字段缺失或歧义。

## 7. 原页面展示内容

下列字段在页面成功采集并具有唯一目标时使用 `PAGE_FIELD`：

| 规范字段 | 页面含义 |
| --- | --- |
| `old_vehicle.recycle_date` | 报废车日期/报废交车日期 |
| `old_vehicle.vin` | 报废车辆车架号 |
| `old_vehicle.plate_no` | 报废车辆车牌号 |
| `old_vehicle.owner` | 报废车辆所有人 |
| `old_vehicle.engine_model` | 报废发动机型号 |
| `invoice.code` | 发票代码 |
| `invoice.amount` | 开票金额 |
| `invoice.invoice_date` | 开票日期 |
| `new_vehicle.vin` | 新车车架号 |
| `new_vehicle.plate_no` | 新车车牌号 |
| `new_vehicle.owner` | 新车所有人 |
| `application.owner_type` | 车辆所有人类型 |
| `page_ocr.new_vehicle_vin` | 页面 OCR 新车车架号 |
| `application.customer_name` | 客户名称 |

页面日期与材料日期是否一致，在原页面日期字段旁展示；日期是否符合地区政策区间，属于派生规则，在审核助手展示。两种结果不能合并。

## 8. 审核助手展示内容

审核助手不是第二份审核报告，不展示任何正常通过项、页面字段副本、已完成步骤或汇总列表。它只展示当前一个无法附着到原页面字段且需要审核员处理的事项。

可能进入审核助手的事项包括：

- 日期或产地政策无法确定或不满足。
- 新旧车主体及挂靠关系无法确定或冲突。
- 二维码官网不可访问、证据不足或结果冲突。
- 必需材料缺失、图片读取或识别失败、多份材料冲突。
- 规则要求的页面字段缺失、歧义或无法定位。
- 页面身份失效、Content Script 无响应或挂靠自动填写失败。

当前事项处理后立即从助手中移除并进入下一步骤，不保留成功历史。挂靠填写成功不形成常驻结果卡片。

相同根因不能同时以“材料完整性”“识别限制”“最终建议”等多种形式重复出现。审核助手不再显示：

- 页面字段的重复列表。
- 独立的最终审核建议卡片。
- 重复的二维码结果卡片。
- 重试次数、来源标识、图片 ID 等技术诊断。
- 全部原始证据和逐项审核汇总卡片。

异常项可以显示业务值、简明原因和“查看原图”，但不展示技术元数据。

## 9. 页面字段目标注册

`page-field-collector.js` 选出唯一候选时，同时保留对应 DOM 元素。发送到审核助手的数据只包含字段键和可定位状态：

```ts
interface PageFieldTargetSnapshot {
  field: string;
  present: boolean;
}
```

Content Script 内部维护字段到元素的映射，元素不跨消息传输。候选值冲突、候选不唯一或元素已经脱离 DOM 时，不建立映射。

## 10. 页面交互协议

新增消息：

- `SHOW_REVIEW_FIELD_STEP`：验证页面身份，定位字段，滚动并渲染当前状态。
- `COMPLETE_REVIEW_FIELD_STEP`：固化已核验或已人工处理状态，移除操作按钮。
- `REVIEW_FIELD_DECISION`：把审核员选择发送给 Side Panel。
- `CLEAR_REVIEW_FIELD_MARKERS`：重新审核或切换业务时清理扩展标记。

每次操作都要验证标签页、URL、页面实例、记录指纹和 `collectionId`。

人工选择固定为：

- `CONFIRMED`：人工确认当前项可继续。
- `MARKED_EXCEPTION`：人工标记异常后继续。

两个按钮点击后都立即记录选择并进入下一项，不再要求审核员额外点击“继续”。

## 11. 审核状态机

```text
IDLE
  -> RUNNING
  -> MATCH：保留成功标记并自动进入下一项
  -> CONFLICT/INSUFFICIENT：WAITING_REVIEWER
       -> 审核员操作 -> 下一项
  -> 页面身份失效：STALE_PAGE
  -> 全部处理完成：COMPLETED
```

行为规则：

1. `PAGE_FIELD + MATCH`：原页面显示“已核验”，标记成功后自动继续。
2. `PAGE_FIELD + CONFLICT/INSUFFICIENT`：原页面显示原因和人工操作，流程暂停。
3. `ASSISTANT + MATCH`：不在助手中展示，直接自动继续。
4. `ASSISTANT + CONFLICT/INSUFFICIENT`：助手展开详情和人工操作，流程暂停。
5. `PAGE_FIELD` 无法定位：助手显示定位异常并暂停，不进行模糊匹配。
6. 页面身份校验失败：进入 `STALE_PAGE`，禁止剩余标注和挂靠填写。

## 12. 挂靠自动填写

保留现有 `page_fill_intent` 和 `page-field-writer.js`，不放宽安全约束。

执行顺序：

1. 审核流程到达“新旧车主体及挂靠关系”。
2. 关系状态必须为 `MATCH`，后端必须返回两个合法填写意图。
3. 扩展调用现有填写客户端。
4. Content Script 联合预检两个字段：目标唯一、当前为空、控件可用、选项唯一、页面身份一致。
5. 两个字段填写后逐一回读。
6. 全部成功后直接继续，不生成常驻助手内容。
7. 任一失败，助手显示失败原因并暂停。

主体关系冲突或证据不足、无填写意图、字段已有值或页面身份变化时不填写。

## 13. 错误处理与兼容

| 场景 | 处理方式 |
| --- | --- |
| 页面字段候选不唯一 | 不建立目标；助手显示采集不足并暂停 |
| DOM 节点重渲染失效 | 不重新猜测；暂停并要求重新审核 |
| URL、页面实例或记录指纹变化 | 会话失效，禁止后续标注和填写 |
| Content Script 无响应 | 助手显示页面连接失败并暂停 |
| 原图定位失效 | 保留规则状态，提示重新采集原图 |
| 后端展示契约非法 | 拒绝启动逐项流程并显示契约错误 |
| 挂靠填写失败 | 依赖联合预检避免半写，并暂停等待人工处理 |

只有青岛、长春报废置换启用新状态机。其他业务继续使用原结果组件。

## 14. 测试与验收

自动测试覆盖：

- 后端展示契约、字段路由、异常去重和挂靠意图门控。
- 前端顺序执行、成功自动继续、异常暂停和人工状态不改写后端结论。
- Content Script 唯一目标映射、标记值不变、失效页面拒绝操作和定向清理。
- 仅两个目标 Profile 启用新流程，其他业务行为不变。

最终验收标准：

1. 青岛、长春页面字段按顺序在原位置核验。
2. 成功字段留下稳定可见的“已核验”标记。
3. 异常项在审核员操作前不进入下一项。
4. 审核助手只显示当前一个页面外人工处理项或客户端阻塞异常，不展示正常成功项、不重复页面字段、不保留审核汇总。
5. 扩展只读取后端结构化展示路由。
6. 两个挂靠字段仍可自动填写，其他字段绝不写入。
7. 页面或申请单变化后不误标记、不误填写。
8. 青岛、长春分别使用自身的日期、截止日期和产地规则。
