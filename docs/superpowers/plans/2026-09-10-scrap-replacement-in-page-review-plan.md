# 青岛、长春报废置换原页面逐字段核验实施计划

> **供执行人员使用：** 实施本计划时必须使用 `superpowers:executing-plans`，严格按任务和复核节点执行。每个步骤使用复选框跟踪；用户确认本文档之前不得开始修改业务代码。

**目标：** 青岛、长春报废置换审核在原页面逐项核验已有字段，审核助手只展示页面外规则和异常，并保留受控的挂靠字段自动填写。

**架构：** 后端为每个审核步骤明确返回 `display_target`、可选的 `page_field` 和是否需要人工操作。扩展使用仅存在内存中的状态机，把页面步骤发送给 Content Script 标记服务，把助手步骤渲染为精简列表，并且只在主体关系通过时调用现有挂靠填写器。

**技术栈：** Python 3.11-3.12、FastAPI、Pydantic 2、LangGraph、Pytest、TypeScript 6、React 19、Manifest V3 Content Script、Node test runner、Vite、ESLint。

**设计文档：** `docs/superpowers/specs/2026-09-10-scrap-replacement-in-page-review-design.md`

## 全局约束

- 新交互仅用于 `scrap_replacement/qingdao/1.0` 和 `scrap_replacement/changchun/1.0`。
- 保留青岛、长春现有政策数值和确定性规则结论。
- 不得通过中文标签或步骤 ID 前缀猜测展示位置。
- 除 `old_vehicle.affiliation` 和 `new_vehicle.affiliation` 外不得修改页面字段。
- 不得点击整单通过、驳回、提交或取消。
- 不增加数据库、LangGraph 检查点、暂停恢复 API 或跨刷新会话恢复。
- 人工操作只保存为前端状态，不得覆盖后端 `MATCH`、`CONFLICT` 或 `INSUFFICIENT`。
- 页面失效、目标歧义、DOM 节点脱离或指纹校验失败时必须安全停止。
- 过户、车源和一致性审核保持现有行为。

## 文件职责

### 后端

- 修改 `review-agent-service/app/models/review.py`：增加审核步骤展示契约。
- 新建 `review-agent-service/app/rules/review_step_routing.py`：集中决定展示目标、关联字段、顺序、人工门控和异常去重。
- 修改 `review-agent-service/app/agent/workflow.py`：把步骤构建委托给路由模块。
- 新建 `review-agent-service/tests/test_review_step_routing.py`：覆盖契约、路由、顺序和去重。
- 修改 `review-agent-service/tests/test_review_steps_and_affiliation_gating.py`：覆盖两个 Profile 和挂靠意图门控。
- 修改 `review-agent-service/tests/test_workflow.py`：覆盖端到端响应和范围外业务回归。

### 扩展页面层

- 修改 `review-extension/public/page-field-collector.js`：保留规范字段对应的唯一 DOM 目标。
- 新建 `review-extension/public/page-review-marker.js`：渲染和清理扩展自己的字段标记，不修改字段值。
- 修改 `review-extension/public/content.js`：维护目标映射并处理标记消息。
- 修改 `review-extension/public/manifest.json`：在 `content.js` 前加载标记服务。
- 修改 `review-extension/tests/page-field-collector.test.mjs`：验证唯一目标和歧义目标。
- 新建 `review-extension/tests/page-review-marker.test.mjs`：验证标记、清理、失效目标和值不变。
- 修改 `review-extension/tests/page-field-collector-wiring.test.mjs`：验证消息接线和目标映射所有权。

### 扩展审核助手层

- 修改 `review-extension/src/types/review.ts`：同步后端展示类型和目标快照类型。
- 新建 `review-extension/src/reviewSession.ts`：实现纯状态机和 Profile 开关。
- 新建 `review-extension/src/pageReviewClient.ts`：封装类型安全的 Content Script 消息。
- 新建 `review-extension/src/hooks/useScrapReplacementReview.ts`：编排步骤、人工操作和挂靠填写。
- 新建 `review-extension/src/components/ScrapReplacementReview.tsx`：实现精简审核助手界面。
- 修改 `review-extension/src/components/ReviewResults.tsx`：只对两个目标 Profile 使用新界面。
- 修改 `review-extension/src/hooks/useReviewWorkflow.ts`：删除任务结束后立即填写，改为提供可调用的填写动作。
- 修改 `review-extension/src/App.tsx`：重置或切换业务时清理页面标记。
- 修改 `review-extension/src/App.css`：增加稳定尺寸的字段徽标和助手状态样式。
- 新建或修改对应 Node 测试，覆盖状态机、消息和组件接线。

## 任务 1：增加后端展示契约

**涉及文件：**

- 修改：`review-agent-service/app/models/review.py`
- 新建：`review-agent-service/tests/test_review_step_routing.py`

**产出接口：**

- `ReviewDisplayTarget.PAGE_FIELD`
- `ReviewDisplayTarget.ASSISTANT`
- 带 `display_target`、`page_field`、`requires_reviewer_action` 的 `ReviewStep`

- [ ] **步骤 1：先编写失败的模型契约测试**

```python
import pytest
from pydantic import ValidationError

from app.models.review import ReviewDisplayTarget, ReviewStep


def make_step(**changes):
    values = dict(
        step_id="FIELD-new_vehicle.vin",
        sequence=1,
        category="FIELD",
        display_target=ReviewDisplayTarget.PAGE_FIELD,
        page_field="new_vehicle.vin",
        requires_reviewer_action=False,
        label="新车车架号",
        result_status="MATCH",
        reason="页面与材料一致",
    )
    values.update(changes)
    return ReviewStep(**values)


def test_page_field_target_requires_field_key():
    with pytest.raises(ValidationError):
        make_step(page_field=None)


def test_assistant_target_rejects_page_field_key():
    with pytest.raises(ValidationError):
        make_step(display_target="ASSISTANT", page_field="new_vehicle.vin")


def test_non_match_requires_reviewer_action():
    with pytest.raises(ValidationError):
        make_step(result_status="CONFLICT", requires_reviewer_action=False)
```

- [ ] **步骤 2：运行测试，确认因契约尚不存在而失败**

```powershell
cd review-agent-service
uv run pytest tests/test_review_step_routing.py -q
```

预期：导入或断言失败，原因是新枚举和字段尚不存在。

- [ ] **步骤 3：实现枚举、字段和跨字段校验**

```python
class ReviewDisplayTarget(str, Enum):
    PAGE_FIELD = "PAGE_FIELD"
    ASSISTANT = "ASSISTANT"


@model_validator(mode="after")
def validate_display_contract(self):
    if self.display_target is ReviewDisplayTarget.PAGE_FIELD and not self.page_field:
        raise ValueError("PAGE_FIELD review steps require page_field")
    if self.display_target is ReviewDisplayTarget.ASSISTANT and self.page_field is not None:
        raise ValueError("ASSISTANT review steps cannot declare page_field")
    if self.requires_reviewer_action != (self.result_status != "MATCH"):
        raise ValueError("requires_reviewer_action must match result_status")
    return self
```

- [ ] **步骤 4：重新运行聚焦测试**

```powershell
uv run pytest tests/test_review_step_routing.py -q
```

预期：本任务新增的契约测试全部通过。

- [ ] **步骤 5：提交本任务**

```powershell
git add review-agent-service/app/models/review.py review-agent-service/tests/test_review_step_routing.py
git commit -m "feat: define review step display contract"
```

## 任务 2：明确路由青岛和长春审核步骤

**涉及文件：**

- 新建：`review-agent-service/app/rules/review_step_routing.py`
- 修改：`review-agent-service/app/agent/workflow.py`
- 修改：`review-agent-service/tests/test_review_step_routing.py`
- 修改：`review-agent-service/tests/test_review_steps_and_affiliation_gating.py`

**产出接口：**

新增函数 `build_review_steps(request, profile, comparisons, external_checks, business_checks, completeness, limitations) -> list[ReviewStep]`，由工作流统一调用。

- [ ] **步骤 1：增加页面字段存在与缺失的失败测试**

```python
def test_present_comparison_routes_to_page_field(qingdao_context):
    step = next(
        item for item in build_review_steps(**qingdao_context)
        if item.step_id == "FIELD-new_vehicle.vin"
    )
    assert step.display_target == "PAGE_FIELD"
    assert step.page_field == "new_vehicle.vin"
    assert step.requires_reviewer_action is False


def test_missing_page_field_routes_to_assistant(qingdao_context):
    steps = build_review_steps(**{**qingdao_context, "page_fields": {}})
    step = next(item for item in steps if item.step_id == "FIELD-new_vehicle.vin")
    assert (step.display_target, step.page_field, step.result_status) == (
        "ASSISTANT", None, "INSUFFICIENT"
    )
```

- [ ] **步骤 2：增加页面外规则与业务范围测试**

```python
@pytest.mark.parametrize("check_id", [
    "POLICY-INVOICE-DATE",
    "POLICY-DISPOSAL-DEADLINE",
    "POLICY-NEW-ORIGIN",
    "AFFILIATION-SUBJECT-001",
    "QR-1",
])
def test_derived_checks_route_to_assistant(qingdao_context, check_id):
    step = next(item for item in build_review_steps(**qingdao_context) if check_id in item.step_id)
    assert step.display_target == "ASSISTANT"
    assert step.page_field is None
```

同时增加断言：过户、车源和一致性 Profile 不启用新的页面逐项流程。

- [ ] **步骤 3：运行测试并确认失败**

```powershell
uv run pytest tests/test_review_step_routing.py tests/test_review_steps_and_affiliation_gating.py -q
```

预期：路由模块尚不存在，或现有步骤缺少展示字段。

- [ ] **步骤 4：实现集中路由函数**

```python
IN_PAGE_AUXILIARY_FIELDS = {
    "AFFILIATION-AUX-OWNER-TYPE": "application.owner_type",
    "AFFILIATION-AUX-NEW-VIN": "page_ocr.new_vehicle_vin",
    "AFFILIATION-AUX-CUSTOMER-NAME": "application.customer_name",
}


def target_for(field: str, page_fields: dict[str, object]):
    if page_fields.get(field) not in (None, ""):
        return ReviewDisplayTarget.PAGE_FIELD, field
    return ReviewDisplayTarget.ASSISTANT, None
```

页面字段比对和三个辅助页面字段调用 `target_for`；地区政策、主体关系、二维码、材料和识别限制固定路由到 `ASSISTANT`。顺序按 Profile 字段清单、辅助字段、政策/关系/二维码、材料异常排列。

- [ ] **步骤 5：让工作流调用新路由模块**

```python
return {
    "review_steps": build_review_steps(
        request=state["request"],
        profile=state["profile"],
        comparisons=state["response"].comparisons,
        external_checks=state.get("external_results", []),
        business_checks=state.get("cross_checks", []),
        completeness=state.get("material_completeness"),
        limitations=state.get("batch").limitations if state.get("batch") else [],
    )
}
```

- [ ] **步骤 6：运行路由和工作流测试**

```powershell
uv run pytest tests/test_review_step_routing.py tests/test_review_steps_and_affiliation_gating.py tests/test_workflow.py -q
```

预期：路由断言通过，现有两个挂靠填写意图的门控测试仍通过。

- [ ] **步骤 7：提交本任务**

```powershell
git add review-agent-service/app/rules/review_step_routing.py review-agent-service/app/agent/workflow.py review-agent-service/tests/test_review_step_routing.py review-agent-service/tests/test_review_steps_and_affiliation_gating.py
git commit -m "feat: route scrap review steps by display target"
```

## 任务 3：精简材料信息并去重助手异常

**涉及文件：**

- 修改：`review-agent-service/app/rules/review_step_routing.py`
- 修改：`review-agent-service/tests/test_review_step_routing.py`
- 修改：`review-agent-service/tests/test_workflow.py`

- [ ] **步骤 1：增加失败测试**

```python
def test_complete_material_report_creates_no_assistant_step(qingdao_context):
    context = {**qingdao_context, "completeness": complete_report(), "limitations": []}
    labels = [item.label for item in build_review_steps(**context)]
    assert "资料完整性" not in labels
    assert "识别限制" not in labels


def test_same_missing_evidence_root_is_only_shown_once(qingdao_context):
    context = {
        **qingdao_context,
        "completeness": missing_invoice_report(reason_code="recognition_failed"),
        "limitations": ["新车发票识别失败或超时"],
    }
    items = [item for item in build_review_steps(**context) if item.category == "MATERIAL"]
    assert len(items) == 1
```

- [ ] **步骤 2：运行测试并确认现有实现会重复展示**

```powershell
uv run pytest tests/test_review_step_routing.py -q
```

- [ ] **步骤 3：实现稳定问题标识与异常时才输出**

```python
def material_issue_key(issue: MaterialCompletenessIssue) -> tuple[str, ...]:
    return (
        issue.reason_code or issue.code,
        issue.field or "",
        issue.material_type or "",
        issue.business_scope or "",
    )
```

材料完整时不创建成功步骤；只从 `report.issues` 创建助手异常。已经由结构化材料问题表达的识别限制不再重复创建自由文本步骤。

- [ ] **步骤 4：运行全部后端测试和静态检查**

```powershell
uv run pytest -q
uv run ruff check app tests
```

预期：两个命令退出码均为 0。

- [ ] **步骤 5：提交本任务**

```powershell
git add review-agent-service/app/rules/review_step_routing.py review-agent-service/tests/test_review_step_routing.py review-agent-service/tests/test_workflow.py
git commit -m "fix: deduplicate scrap review assistant issues"
```

## 任务 4：采集并保存稳定的页面字段目标

**涉及文件：**

- 修改：`review-extension/public/page-field-collector.js`
- 修改：`review-extension/public/content.js`
- 修改：`review-extension/src/types/review.ts`
- 修改：`review-extension/tests/page-field-collector.test.mjs`
- 修改：`review-extension/tests/page-field-collector-wiring.test.mjs`

- [ ] **步骤 1：增加唯一目标与歧义目标的失败测试**

```js
test("返回规范字段对应的唯一 DOM 目标", () => {
  const target = element({ label: "新车车架号", text: "VIN-1", section: "new_vehicle", source: "structured" });
  const result = collect(collector, fixture([target]));
  assert.equal(result.fieldTargets[0].field, "new_vehicle.vin");
  assert.equal(result.fieldTargets[0].element, target);
});

test("同等候选值冲突时不暴露页面目标", () => {
  const result = collect(collector, fixture([
    element({ label: "新车车架号", text: "VIN-1", section: "new_vehicle", source: "structured" }),
    element({ label: "新车车架号", text: "VIN-2", section: "new_vehicle", source: "structured" }),
  ]));
  assert.equal(result.fieldTargets.some(item => item.field === "new_vehicle.vin"), false);
});
```

- [ ] **步骤 2：运行测试并确认失败**

```powershell
cd review-extension
npm test -- tests/page-field-collector.test.mjs tests/page-field-collector-wiring.test.mjs
```

预期：`fieldTargets` 尚不存在。

- [ ] **步骤 3：在候选排序过程中保留真实元素**

每种候选结构增加 `element`；唯一最高分候选被接受时，记录 `{ field, element }`。冲突候选不建立目标。

```js
return {
  pageFields,
  fieldTargets,
  writableTargets,
  unmatchedLabels,
  ambiguousFields,
  candidateCount: candidates.length,
  scannedControls,
};
```

- [ ] **步骤 4：Content Script 保存元素并只返回快照**

```js
reviewFieldElements.clear();
fieldCollection.fieldTargets.forEach(({ field, element }) => {
  reviewFieldElements.set(field, { element, collectionId });
});

const fieldTargets = fieldCollection.fieldTargets.map(({ field }) => ({
  field,
  present: true,
}));
```

目标映射只能在最新一次采集完成时替换，规则与当前图片目标映射一致。

- [ ] **步骤 5：增加 TypeScript 快照类型**

```ts
export interface PageFieldTargetSnapshot {
  field: string;
  present: boolean;
}
```

- [ ] **步骤 6：运行页面采集相关测试**

```powershell
npm test -- tests/page-field-collector.test.mjs tests/page-field-collector-wiring.test.mjs
```

预期：测试全部通过。

- [ ] **步骤 7：提交本任务**

```powershell
git add review-extension/public/page-field-collector.js review-extension/public/content.js review-extension/src/types/review.ts review-extension/tests/page-field-collector.test.mjs review-extension/tests/page-field-collector-wiring.test.mjs
git commit -m "feat: retain canonical page field targets"
```

## 任务 5：实现隔离的原页面核验标记服务

**涉及文件：**

- 新建：`review-extension/public/page-review-marker.js`
- 修改：`review-extension/public/content.js`
- 修改：`review-extension/public/manifest.json`
- 新建：`review-extension/tests/page-review-marker.test.mjs`

**产出接口：**

- `ReviewPageMarker.show(target, step, onDecision)`
- `ReviewPageMarker.complete(stepId, decision)`
- `ReviewPageMarker.clear()`

- [ ] **步骤 1：增加标记行为失败测试**

```js
test("增加成功徽标但不改变原字段值", () => {
  const input = fakeInput("VIN-1");
  marker.show(input, matchStep, () => {});
  assert.equal(input.value, "VIN-1");
  assert.equal(document.querySelector('[data-review-assistant-marker="FIELD-new_vehicle.vin"]').textContent, "已核验");
});

test("只有异常步骤显示人工操作", () => {
  marker.show(fakeInput("VIN-1"), conflictStep, decision => decisions.push(decision));
  click("人工确认无误");
  assert.deepEqual(decisions, ["CONFIRMED"]);
});

test("拒绝失效目标且只清理扩展节点", () => {
  const result = marker.show({ isConnected: false }, matchStep, () => {});
  assert.deepEqual(result, { ok: false, error: "页面字段已变化，请重新审核" });
});
```

- [ ] **步骤 2：运行测试并确认模块不存在**

```powershell
npm test -- tests/page-review-marker.test.mjs
```

- [ ] **步骤 3：实现扩展自有标记节点和样式**

```js
const show = (target, step, onDecision) => {
  if (!target?.isConnected) return { ok: false, error: "页面字段已变化，请重新审核" };
  const marker = buildMarker(step, onDecision);
  target.insertAdjacentElement("afterend", marker);
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  return { ok: true, rendered: true };
};
```

标记使用 `data-review-assistant-marker=<stepId>`，明确设置前景色、背景色、边框、字号和焦点样式，避免受宿主页面主题影响。

- [ ] **步骤 4：接入带页面身份校验的消息处理**

处理 `SHOW_REVIEW_FIELD_STEP`、`COMPLETE_REVIEW_FIELD_STEP`、`CLEAR_REVIEW_FIELD_MARKERS`。每次先调用现有记录一致性校验，再验证 `collectionId`、目标唯一性和 `element.isConnected`。

- [ ] **步骤 5：在清单中加载标记脚本**

将 `page-review-marker.js` 放在 `content.js` 之前。

- [ ] **步骤 6：运行标记和消息测试**

```powershell
npm test -- tests/page-review-marker.test.mjs tests/page-field-collector-wiring.test.mjs
```

预期：标记行为通过，任何测试中的原字段值均未改变。

- [ ] **步骤 7：提交本任务**

```powershell
git add review-extension/public/page-review-marker.js review-extension/public/content.js review-extension/public/manifest.json review-extension/tests/page-review-marker.test.mjs review-extension/tests/page-field-collector-wiring.test.mjs
git commit -m "feat: render guarded in-page review markers"
```

## 任务 6：实现前端审核状态机和页面消息客户端

**涉及文件：**

- 新建：`review-extension/src/reviewSession.ts`
- 新建：`review-extension/src/pageReviewClient.ts`
- 修改：`review-extension/src/types/review.ts`
- 新建：`review-extension/tests/review-session.test.mjs`
- 新建：`review-extension/tests/page-review-client.test.mjs`

- [ ] **步骤 1：增加状态转换失败测试**

```ts
test("成功步骤自动前进但异常步骤等待人工", () => {
  let state = createReviewSession([pageMatch, assistantConflict]);
  state = completeMatchedStep(state, pageMatch.step_id);
  assert.equal(state.index, 1);
  assert.equal(state.phase, "WAITING_REVIEWER");
});

test("人工处理不会改变后端结论", () => {
  const state = recordReviewerDecision(waitingState, assistantConflict.step_id, "MARKED_EXCEPTION");
  assert.equal(state.decisions[assistantConflict.step_id], "MARKED_EXCEPTION");
  assert.equal(assistantConflict.result_status, "CONFLICT");
});

test("只有青岛长春报废置换启用新流程", () => {
  assert.equal(isInPageScrapProfile(qingdaoReview), true);
  assert.equal(isInPageScrapProfile(changchunReview), true);
  assert.equal(isInPageScrapProfile(transferReview), false);
  assert.equal(isInPageScrapProfile(consistencyReview), false);
});
```

- [ ] **步骤 2：增加消息身份参数失败测试**

```js
await showPageReviewStep(pageMatch, pageTarget, chromeApi);
assert.deepEqual(sent.message, {
  type: "SHOW_REVIEW_FIELD_STEP",
  step: pageMatch,
  expectedPageUrl: pageTarget.pageUrl,
  expectedPageInstanceId: pageTarget.pageInstanceId,
  expectedPageFingerprint: pageTarget.pageFingerprint,
  expectedCollectionId: pageTarget.collectionId,
});
```

- [ ] **步骤 3：运行测试并确认新模块尚不存在**

```powershell
npm test -- tests/review-session.test.mjs tests/page-review-client.test.mjs
```

- [ ] **步骤 4：实现不可变状态模型**

```ts
export type ReviewSessionPhase = "IDLE" | "RUNNING" | "WAITING_REVIEWER" | "STALE_PAGE" | "COMPLETED";
export type ReviewerDecision = "CONFIRMED" | "MARKED_EXCEPTION";

export interface ReviewSessionState {
  phase: ReviewSessionPhase;
  index: number;
  decisions: Record<string, ReviewerDecision>;
  completedStepIds: string[];
  clientIssue?: string;
}
```

状态机复制并按 `sequence` 排序步骤，不修改后端响应对象；回调的 `stepId` 不是当前步骤时必须拒绝。

- [ ] **步骤 5：实现类型安全的页面消息客户端**

三个客户端调用在发消息前必须检查标签页 ID、URL、页面实例、指纹、采集 ID 和 `sendMessage`。

- [ ] **步骤 6：运行状态机和消息测试**

```powershell
npm test -- tests/review-session.test.mjs tests/page-review-client.test.mjs
```

预期：全部通过。

- [ ] **步骤 7：提交本任务**

```powershell
git add review-extension/src/reviewSession.ts review-extension/src/pageReviewClient.ts review-extension/src/types/review.ts review-extension/tests/review-session.test.mjs review-extension/tests/page-review-client.test.mjs
git commit -m "feat: add local scrap review session state"
```

## 任务 7：实现精简审核助手并调整挂靠填写时机

**涉及文件：**

- 新建：`review-extension/src/hooks/useScrapReplacementReview.ts`
- 新建：`review-extension/src/components/ScrapReplacementReview.tsx`
- 修改：`review-extension/src/components/ReviewResults.tsx`
- 修改：`review-extension/src/hooks/useReviewWorkflow.ts`
- 修改：`review-extension/src/App.tsx`
- 修改：`review-extension/src/App.css`
- 修改：`review-extension/tests/review-steps.test.mjs`
- 新建：`review-extension/tests/scrap-replacement-review-wiring.test.mjs`
- 修改：`review-extension/tests/page-fill-client.test.mjs`

- [ ] **步骤 1：增加“任务结束不立即填写”的失败测试**

```js
test("任务完成后不立即执行挂靠填写", () => {
  const source = readFileSync(new URL("../src/hooks/useReviewWorkflow.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /finalSnapshot\.result\?\.page_fill_intent[\s\S]*applyPageFillIntent/);
  assert.match(source, /applyAffiliationFill/);
});
```

- [ ] **步骤 2：增加范围开关和精简内容失败测试**

```js
test("只有目标报废置换 Profile 使用新组件", () => {
  const source = readFileSync(new URL("../src/components/ReviewResults.tsx", import.meta.url), "utf8");
  assert.match(source, /isInPageScrapProfile\(review\)/);
  assert.match(source, /<ScrapReplacementReview/);
});

test("精简助手不渲染旧版重复卡片", () => {
  const source = readFileSync(new URL("../src/components/ScrapReplacementReview.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /ReviewAdvice|MaterialCompleteness|QrResults|ResultGroup/);
  assert.match(source, /step\.display_target === "ASSISTANT"/);
});
```

- [ ] **步骤 3：运行测试并确认当前实现不满足要求**

```powershell
npm test -- tests/scrap-replacement-review-wiring.test.mjs tests/page-fill-client.test.mjs tests/review-steps.test.mjs
```

- [ ] **步骤 4：从通用工作流暴露受控填写动作**

```ts
const applyAffiliationFill = useCallback(async (actions: PageFillAction[]) => {
  if (!pageData) return { ok: false, message: "没有找到原审核页面" };
  const result = await applyPageFillIntent(actions, {
    tabId: pageData.sourceTabId,
    pageUrl: pageData.pageUrl,
    pageInstanceId: pageData.pageInstanceId,
    pageFingerprint: pageData.pageFingerprint,
  });
  setPageFillResult(result);
  return result;
}, [pageData]);
```

删除轮询完成后的立即填写调用。

- [ ] **步骤 5：实现报废置换编排 Hook**

每次只处理一个步骤：

- `PAGE_FIELD` 调用页面消息客户端。
- `ASSISTANT` 交给精简组件展示。
- `MATCH` 在渲染成功后自动前进。
- `CONFLICT` 和 `INSUFFICIENT` 收到人工选择后才前进。
- 当前步骤为 `AFFILIATION-SUBJECT-001` 且结果为 `MATCH` 时，只调用一次 `applyAffiliationFill`。
- 填写成功增加本地结果 `CLIENT-AFFILIATION-FILL`；填写失败显示原因并暂停。

- [ ] **步骤 6：实现精简助手组件**

组件只显示：

- 当前地区、当前步骤和总进度。
- 已完成的 `ASSISTANT` 紧凑状态行。
- 当前异常的业务值、原因、可选查看原图和两个人工按钮。
- 页面过期、标记失败或挂靠填写失败。
- 简短的“本次逐项核验已完成”。

不得显示原始来源 ID、图片 ID、重试次数、旧版审核建议、页面字段异常列表或重复二维码/材料卡片。

- [ ] **步骤 7：只为两个目标 Profile 选择新组件**

```tsx
if (isInPageScrapProfile(review)) {
  return (
    <ScrapReplacementReview
      review={review}
      pageData={pageData}
      onFocusImage={onFocusImage}
      onApplyAffiliationFill={onApplyAffiliationFill}
    />
  );
}
return <LegacyReviewResults {...legacyProps} />;
```

旧版 JSX 移到命名组件中，其他业务保持原行为。

- [ ] **步骤 8：增加稳定响应式样式**

控件使用稳定高度和最大宽度，长文本允许换行，不使用视口宽度缩放字体。页面徽标明确设置颜色、背景、边框、字号和焦点状态，兼容明暗宿主页面。

- [ ] **步骤 9：运行前端聚焦测试、构建和静态检查**

```powershell
npm test -- tests/review-session.test.mjs tests/page-review-client.test.mjs tests/scrap-replacement-review-wiring.test.mjs tests/page-fill-client.test.mjs tests/review-steps.test.mjs
npm run build
npm run lint
```

预期：所有命令退出码为 0。

- [ ] **步骤 10：提交本任务**

```powershell
git add review-extension/src/hooks/useScrapReplacementReview.ts review-extension/src/components/ScrapReplacementReview.tsx review-extension/src/components/ReviewResults.tsx review-extension/src/hooks/useReviewWorkflow.ts review-extension/src/App.tsx review-extension/src/App.css review-extension/tests/review-steps.test.mjs review-extension/tests/scrap-replacement-review-wiring.test.mjs review-extension/tests/page-fill-client.test.mjs
git commit -m "feat: run scrap reviews in page field order"
```

## 任务 8：完成安全回归、真实页面验收和文档更新

**涉及文件：**

- 修改：`review-agent-service/tests/test_backend_final_review_regressions.py`
- 修改：`review-extension/tests/scrap-replacement-affiliation-fixture.test.mjs`
- 修改：`docs/architecture.md`
- 修改：`review-agent-service/README.md`
- 修改：`review-extension/README.md`

- [ ] **步骤 1：增加精确范围的后端回归测试**

```python
@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("region", "path"),
    [("qingdao", "scrap-replace-qingdao"), ("changchun", "scrap-replace-changchun")],
)
async def test_scrap_profiles_return_explicit_display_routes(region, path):
    result = await ReviewService().assist_async(
        ReviewRequest(
            page_url=f"https://admin.forjtruck.com/{path}/review/1",
            business_type="scrap_replacement",
            region=region,
            workflow_stage="scrap_replacement",
            page_fields={"new_vehicle.vin": "VIN-1"},
            images=[],
        )
    )
    assert all(step.display_target in {"PAGE_FIELD", "ASSISTANT"} for step in result.review_steps)
    assert all(step.page_field is None for step in result.review_steps if step.display_target == "ASSISTANT")
```

- [ ] **步骤 2：扩展挂靠页面夹具测试**

验证字段标记出现前后两个挂靠选择框值不变；只有主体关系为 `MATCH` 后写入器才填写两个字段。再把其中一个字段设为非空，验证联合预检阻止任何部分写入。

- [ ] **步骤 3：运行全部自动验证**

在 `review-agent-service` 中运行：

```powershell
uv run pytest -q
uv run ruff check app tests
```

在 `review-extension` 中运行：

```powershell
npm test
npm run build
npm run lint
```

预期：全部命令退出码为 0。

- [ ] **步骤 4：在 Edge 中分别验收青岛和长春**

每个地区都要记录以下七种场景：

1. 页面字段和助手规则全部通过。
2. 一个页面字段冲突并等待人工操作。
3. 一个页面字段证据不足并等待人工操作。
4. 缺少一种必需材料，只在助手显示。
5. 主体关系通过，两个空白挂靠字段填写并回读成功。
6. 一个挂靠字段非空或目标歧义，不发生部分写入。
7. 采集后切换申请单，剩余标注和填写全部停止。

- [ ] **步骤 5：更新架构和使用文档**

后端文档加入以下响应示例：

```json
{
  "step_id": "FIELD-new_vehicle.vin",
  "sequence": 7,
  "category": "FIELD",
  "display_target": "PAGE_FIELD",
  "page_field": "new_vehicle.vin",
  "requires_reviewer_action": false,
  "label": "新车车架号",
  "result_status": "MATCH",
  "reason": "页面与材料一致",
  "values": [],
  "evidence": []
}
```

同时说明：新交互只用于青岛、长春报废置换；人工操作不持久化；只有两个挂靠字段允许写入。

- [ ] **步骤 6：检查最终差异中是否存在越界写入**

```powershell
rg -n "click\(|\.value\s*=|dispatchEvent" review-extension/src review-extension/public
git diff --check
git status --short
```

预期：写值和输入事件只存在于既有挂靠写入器；点击处理只涉及扩展自己的标记按钮；没有整单业务按钮选择器；`git diff --check` 无输出。

- [ ] **步骤 7：提交回归测试和文档**

```powershell
git add review-agent-service/tests/test_backend_final_review_regressions.py review-extension/tests/scrap-replacement-affiliation-fixture.test.mjs docs/architecture.md review-agent-service/README.md review-extension/README.md
git commit -m "docs: describe in-page scrap review workflow"
```

## 最终完成门槛

只有以下条件全部满足，才能宣布改造完成：

- [ ] 后端全部测试通过。
- [ ] 后端 Ruff 检查通过。
- [ ] 扩展全部测试通过。
- [ ] 扩展生产构建通过。
- [ ] 扩展 ESLint 检查通过。
- [ ] `git diff --check` 通过。
- [ ] 青岛、长春都完成七项真实页面验收。
- [ ] 过户、车源和一致性审核行为没有变化。
- [ ] 除两个挂靠字段外没有写入任何页面字段。
