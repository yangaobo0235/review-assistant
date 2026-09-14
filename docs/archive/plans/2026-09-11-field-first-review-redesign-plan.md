> 历史归档：本文是当时的设计/实施计划，可能包含已被替代或尚未完成的内容。当前要求和实现说明以[项目完整手册](../../system-spec.md)为准，请勿直接按旧计划执行。原文保留用于追溯。

# 原页面逐字段审核精简改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将青岛、长春报废置换审核改造成原页面逐字段只读核验流程，仅在无法附着到页面字段且需要人工确认时使用审核助手，并保留新车、旧车挂靠两个字段的受控自动写入。

**Architecture:** 后端继续一次性完成规则计算，并为每个步骤明确返回页面字段或助手展示目标。扩展在内存中顺序执行步骤：页面字段步骤由 Content Script 就地标记，异常按钮就地暂停；无页面字段的异常才进入精简助手。两个挂靠写入动作只在主体关系及其保护条件全部通过后执行，并继续沿用页面身份校验和联合预检。

**Tech Stack:** Python 3.11-3.12、FastAPI、Pydantic 2、LangGraph、Pytest、Ruff、TypeScript 6、React 19、Manifest V3 Content Script、Node test runner、Vite、ESLint。

**Spec:** `docs/superpowers/specs/2026-09-10-scrap-replacement-in-page-review-design.md`

## Global Constraints

- 新交互仅用于 `scrap_replacement/qingdao/1.0` 和 `scrap_replacement/changchun/1.0`。
- 页面字段默认只读；除 `old_vehicle.affiliation` 和 `new_vehicle.affiliation` 外不得写入任何字段。
- 不得点击整单通过、驳回、提交、取消或其他宿主页面业务按钮。
- `PAGE_FIELD + MATCH` 在原字段旁保留“核验成功”标记并自动前进。
- `PAGE_FIELD + CONFLICT/INSUFFICIENT` 在原字段旁显示原因及“确认无误 / 标记异常”，并暂停。
- 点击“确认无误”或“标记异常”后立即记录结果并进入下一项，不再额外点击“继续”。
- `ASSISTANT + MATCH` 不展示并自动前进；只有 `ASSISTANT + CONFLICT/INSUFFICIENT` 才在助手展示。
- 助手一次只展示当前一个需要人工处理的页面外事项，不展示正常结果、页面字段副本、完成历史、最终建议或汇总。
- 人工选择只记录在前端内存，不得篡改后端 `MATCH`、`CONFLICT`、`INSUFFICIENT` 结论。
- 页面实例、URL、申请单指纹、采集 ID 或 DOM 目标失效时立即停止后续标记和写入。
- 不增加数据库、队列、LangGraph 人工检查点、恢复 API 或跨刷新进度保存。
- 过户、车源和一致性审核继续使用现有结果界面和行为。

---

## 当前基线与文件职责

当前工作区已经包含一部分未完成改造：后端 `ReviewStep` 已有展示契约，但路由模块缺失，工作流仍按旧参数构造步骤；前端类型尚未同步，`ReviewFieldStepper` 仍在助手中展示全部步骤；页面字段采集器只返回值，没有保存普通字段 DOM 目标；挂靠填写在任务结束后立即触发。

### 后端

- `review-agent-service/app/models/review.py`：保留并验证 `ReviewStep` 展示契约。
- 创建 `review-agent-service/app/rules/review_step_routing.py`：唯一负责步骤排序、展示目标、页面字段映射和材料异常去重。
- `review-agent-service/app/agent/workflow.py`：调用路由模块，不再直接拼装展示步骤。
- `review-agent-service/tests/test_review_step_routing.py`：覆盖字段存在/缺失、助手隐藏语义、两个目标 Profile 和非目标 Profile。

### 原页面 Content Script

- `review-extension/public/page-field-collector.js`：从已接受的唯一候选保留 DOM 目标。
- 创建 `review-extension/public/page-review-marker.js`：只创建、更新、清理扩展自己的标记和按钮。
- `review-extension/public/content.js`：维护字段目标映射，验证页面身份，处理标记协议并上报人工选择。
- `review-extension/public/manifest.json`：在 `content.js` 前加载标记模块。

### 审核助手

- `review-extension/src/types/review.ts`：同步后端步骤契约和页面目标快照。
- 创建 `review-extension/src/reviewSession.ts`：实现无副作用的顺序状态机。
- 创建 `review-extension/src/pageReviewClient.ts`：封装页面消息和人工选择订阅。
- 创建 `review-extension/src/hooks/useScrapReplacementReview.ts`：编排步骤、暂停、清理和挂靠写入。
- 创建 `review-extension/src/components/ScrapReplacementReview.tsx`：只渲染当前页面外人工处理项或阻塞错误。
- `review-extension/src/components/ReviewResults.tsx`：仅为两个目标 Profile 切换新流程，其他业务保持旧组件。
- `review-extension/src/hooks/useReviewWorkflow.ts`：删除任务结束后的立即挂靠填写，改为暴露受控动作。

---

### Task 1: 完成后端审核步骤路由

**Files:**

- Create: `review-agent-service/app/rules/review_step_routing.py`
- Modify: `review-agent-service/app/agent/workflow.py`
- Modify: `review-agent-service/tests/test_review_step_routing.py`
- Modify: `review-agent-service/tests/test_review_steps_and_affiliation_gating.py`
- Test: `review-agent-service/tests/test_workflow.py`

**Interfaces:**

- Consumes: `ReviewRequest`、业务 `profile`、`FieldComparison`、外部检查、业务规则检查、材料完整性报告和识别限制。
- Produces: `build_review_steps(...) -> list[ReviewStep]`，每项都含 `display_target`、`page_field`、`requires_reviewer_action`。

- [ ] **Step 1: 固化目标业务和路由失败测试**

在现有测试基础上补充以下断言：

```python
def test_assistant_match_remains_in_contract_but_needs_no_reviewer_action():
    steps = build_steps(business_checks=[ReviewCheck(
        check_id="POLICY-INVOICE-DATE",
        label="新车发票日期政策核验",
        status="MATCH",
        reason="符合政策",
    )])
    assert steps[0].display_target == "ASSISTANT"
    assert steps[0].requires_reviewer_action is False


def test_missing_configured_page_field_becomes_actionable_assistant_step():
    step = next(item for item in build_steps(
        comparisons=[matching_comparison("new_vehicle.vin")],
    ) if item.step_id == "FIELD-new_vehicle.vin")
    assert step.display_target == "ASSISTANT"
    assert step.result_status == "INSUFFICIENT"
    assert step.requires_reviewer_action is True
```

- [ ] **Step 2: 运行聚焦测试并确认当前缺少路由模块**

```powershell
cd review-agent-service
uv run pytest tests/test_review_step_routing.py tests/test_review_steps_and_affiliation_gating.py -q
```

预期：测试因 `app.rules.review_step_routing` 不存在或工作流构造参数不完整而失败。

- [ ] **Step 3: 实现集中路由函数**

```python
def build_review_steps(
    *, request, profile, comparisons, external_checks,
    business_checks, completeness, limitations,
) -> list[ReviewStep]:
    steps: list[ReviewStep] = []
    # PAGE_FIELD 只用于目标 Profile 且请求中存在该规范字段；
    # 缺失字段转为 ASSISTANT + INSUFFICIENT。
    # 外部规则、派生规则和材料异常使用 ASSISTANT。
    return resequence(deduplicate_steps(steps))
```

字段展示目标必须来自显式映射表，不允许根据中文 `label` 或 `reason` 猜测。材料完整时不生成材料成功步骤；同一根因的材料问题和识别限制只保留一个步骤。

- [ ] **Step 4: 将工作流委托给路由模块**

`ReviewWorkflow._prepare_review_steps` 只读取状态并调用 `build_review_steps`：

```python
return {"review_steps": build_review_steps(
    request=state["request"],
    profile=state["profile"],
    comparisons=list(response.comparisons),
    external_checks=list(state.get("external_results", [])),
    business_checks=list(state.get("cross_checks", [])),
    completeness=state.get("material_completeness"),
    limitations=list(batch.limitations if batch else []),
)}
```

- [ ] **Step 5: 验证两个目标 Profile 与范围外业务**

```powershell
uv run pytest tests/test_review_step_routing.py tests/test_review_steps_and_affiliation_gating.py tests/test_workflow.py -q
```

预期：青岛、长春字段步骤具有明确目标；过户、车源、一致性不启用页内交互。

- [ ] **Step 6: Commit**

```powershell
git add app/rules/review_step_routing.py app/agent/workflow.py tests/test_review_step_routing.py tests/test_review_steps_and_affiliation_gating.py tests/test_workflow.py
git commit -m "fix: route review steps to page fields"
```

### Task 2: 采集并保存唯一页面字段目标

**Files:**

- Modify: `review-extension/public/page-field-collector.js`
- Modify: `review-extension/public/content.js`
- Modify: `review-extension/src/types/review.ts`
- Modify: `review-extension/tests/page-field-collector.test.mjs`
- Modify: `review-extension/tests/page-field-collector-wiring.test.mjs`

**Interfaces:**

- Produces internally: `fieldTargets: Array<{ field: string; element: Element }>`。
- Produces to Side Panel: `fieldTargets: Array<{ field: string; present: boolean }>`；DOM 元素不跨消息传输。

- [ ] **Step 1: 为唯一目标、同值重复目标和冲突目标编写失败测试**

```js
test("only one accepted DOM candidate becomes a review target", () => {
  const target = control({ label: "新车车架号", value: "VIN-1" });
  const result = collector.collect(fixture(target), "scrap_replacement");
  assert.equal(result.fieldTargets[0].field, "new_vehicle.vin");
  assert.equal(result.fieldTargets[0].element, target);
});

test("equally ranked duplicate DOM candidates do not expose a target", () => {
  const result = collector.collect(fixture(
    control({ label: "新车车架号", value: "VIN-1" }),
    control({ label: "新车车架号", value: "VIN-1" }),
  ), "scrap_replacement");
  assert.equal(result.fieldTargets.some(item => item.field === "new_vehicle.vin"), false);
  assert.ok(result.ambiguousFields.includes("new_vehicle.vin"));
});
```

- [ ] **Step 2: 运行采集测试并确认 `fieldTargets` 尚不存在**

```powershell
cd review-extension
npm test -- tests/page-field-collector.test.mjs tests/page-field-collector-wiring.test.mjs
```

- [ ] **Step 3: 在每类候选中保留真实元素并收紧唯一性**

所有 `controlCandidates`、`structuredCandidates` 和 `adjacentCandidates` 项都增加 `element`。只有唯一最高分候选时才同时写入 `pageFields[field]` 和 `fieldTargets`；候选并列时即使值相同也不建立 DOM 目标，避免标记到错误位置。

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

- [ ] **Step 4: Content Script 只保存最新采集的目标映射**

```js
reviewFieldElements.clear();
for (const { field, element } of fieldCollection.fieldTargets) {
  reviewFieldElements.set(field, { element, collectionId });
}

const fieldTargets = fieldCollection.fieldTargets.map(({ field }) => ({
  field,
  present: true,
}));
```

只有最终成为 `activeCollectionId` 的采集才能替换目标映射。

- [ ] **Step 5: 同步前端快照类型并验证**

```ts
export interface PageFieldTargetSnapshot {
  field: string;
  present: boolean;
}
```

将 `fieldTargets?: PageFieldTargetSnapshot[]` 加入 `PageData`，然后运行：

```powershell
npm test -- tests/page-field-collector.test.mjs tests/page-field-collector-wiring.test.mjs
```

- [ ] **Step 6: Commit**

```powershell
git add public/page-field-collector.js public/content.js src/types/review.ts tests/page-field-collector.test.mjs tests/page-field-collector-wiring.test.mjs
git commit -m "feat: retain unique review field targets"
```

### Task 3: 在原页面渲染核验状态和人工按钮

**Files:**

- Create: `review-extension/public/page-review-marker.js`
- Modify: `review-extension/public/content.js`
- Modify: `review-extension/public/manifest.json`
- Create: `review-extension/tests/page-review-marker.test.mjs`
- Modify: `review-extension/tests/page-field-collector-wiring.test.mjs`

**Interfaces:**

- Produces global API: `ReviewPageMarker.show(target, step, onDecision)`、`complete(stepId, decision)`、`clear()`。
- Content messages: `SHOW_REVIEW_FIELD_STEP`、`COMPLETE_REVIEW_FIELD_STEP`、`CLEAR_REVIEW_FIELD_MARKERS`、`REVIEW_FIELD_DECISION`。

- [ ] **Step 1: 先写标记隔离和按钮语义测试**

```js
test("match adds a persistent success marker without changing the field", () => {
  const input = fakeInput("VIN-1");
  marker.show(input, matchStep, () => {});
  assert.equal(input.value, "VIN-1");
  assert.equal(findMarker(matchStep.step_id).textContent, "核验成功");
});

test("an uncertain field pauses with two decisions and no continue button", () => {
  marker.show(fakeInput("VIN-1"), insufficientStep, decision => decisions.push(decision));
  assert.deepEqual(buttonLabels(), ["确认无误", "标记异常"]);
  clickButton("确认无误");
  assert.deepEqual(decisions, ["CONFIRMED"]);
  assert.equal(buttonLabels().length, 0);
});

test("clear removes only extension-owned nodes", () => {
  marker.clear();
  assert.equal(hostPageNode.isConnected, true);
  assert.equal(document.querySelectorAll("[data-review-assistant-marker]").length, 0);
});
```

- [ ] **Step 2: 运行测试并确认标记模块尚不存在**

```powershell
npm test -- tests/page-review-marker.test.mjs
```

- [ ] **Step 3: 实现宿主页面隔离标记**

标记节点使用 `data-review-assistant-marker=<stepId>`，通过独立类名或 Shadow DOM 设置明确的字体、前景色、背景色、边框、按钮高度和焦点样式。不得给原字段赋值或派发 `input/change` 事件。

```js
function show(target, step, onDecision) {
  if (!target?.isConnected) return { ok: false, error: "页面字段已变化，请重新审核" };
  const marker = buildMarker(step, onDecision);
  target.insertAdjacentElement("afterend", marker);
  if (step.requires_reviewer_action) {
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  return { ok: true };
}
```

- [ ] **Step 4: 接入带身份校验的消息处理**

所有 `SHOW`、`COMPLETE`、`CLEAR` 请求校验 `expectedPageUrl`、`expectedPageInstanceId`、`expectedPageFingerprint`、`expectedCollectionId`。`SHOW` 还必须确认映射属于当前采集且元素仍连接。

按钮点击后 Content Script 发送：

```js
chrome.runtime.sendMessage({
  type: "REVIEW_FIELD_DECISION",
  stepId: step.step_id,
  decision,
  pageInstanceId,
  collectionId: activeCollectionId,
});
```

同一按钮只接受第一次点击，随后立即禁用并移除操作区。

- [ ] **Step 5: 在 Manifest 中按顺序加载模块**

确保 `page-review-marker.js` 位于 `content.js` 之前，原采集、图片与挂靠写入脚本顺序保持不变。

- [ ] **Step 6: 验证标记、消息和页面值不变**

```powershell
npm test -- tests/page-review-marker.test.mjs tests/page-field-collector-wiring.test.mjs tests/page-field-writer.test.mjs
```

- [ ] **Step 7: Commit**

```powershell
git add public/page-review-marker.js public/content.js public/manifest.json tests/page-review-marker.test.mjs tests/page-field-collector-wiring.test.mjs
git commit -m "feat: review fields beside host controls"
```

### Task 4: 实现逐字段审核状态机和页面客户端

**Files:**

- Create: `review-extension/src/reviewSession.ts`
- Create: `review-extension/src/pageReviewClient.ts`
- Modify: `review-extension/src/types/review.ts`
- Replace target-flow usage of: `review-extension/src/reviewSteps.ts`
- Create: `review-extension/tests/review-session.test.mjs`
- Create: `review-extension/tests/page-review-client.test.mjs`

**Interfaces:**

- Produces: `createReviewSession`、`currentStep`、`completeMatchedStep`、`recordReviewerDecision`、`failReviewSession`。
- Produces: `showPageReviewStep`、`completePageReviewStep`、`clearPageReviewMarkers`、`subscribePageReviewDecisions`。

- [ ] **Step 1: 编写状态转换失败测试**

```js
test("page match auto-advances and page exception waits", () => {
  let state = createReviewSession([pageMatch, pageConflict]);
  state = completeMatchedStep(state, pageMatch.step_id);
  assert.equal(currentStep(state).step_id, pageConflict.step_id);
  assert.equal(state.phase, "WAITING_REVIEWER");
});

test("assistant match is hidden and auto-advances", () => {
  let state = createReviewSession([assistantMatch, assistantConflict]);
  state = completeMatchedStep(state, assistantMatch.step_id);
  assert.equal(currentStep(state).step_id, assistantConflict.step_id);
  assert.equal(state.phase, "WAITING_REVIEWER");
});

test("either reviewer decision advances immediately without mutating backend status", () => {
  const next = recordReviewerDecision(waitingState, pageConflict.step_id, "MARKED_EXCEPTION");
  assert.equal(next.index, waitingState.index + 1);
  assert.equal(next.decisions[pageConflict.step_id], "MARKED_EXCEPTION");
  assert.equal(pageConflict.result_status, "CONFLICT");
});
```

- [ ] **Step 2: 编写消息身份与过期事件测试**

```js
await showPageReviewStep(step, pageData, chromeApi);
assert.deepEqual(sent.message, {
  type: "SHOW_REVIEW_FIELD_STEP",
  step,
  expectedPageUrl: pageData.pageUrl,
  expectedPageInstanceId: pageData.pageInstanceId,
  expectedPageFingerprint: pageData.pageFingerprint,
  expectedCollectionId: pageData.collectionId,
});
```

人工事件的 `pageInstanceId`、`collectionId` 或 `stepId` 与当前会话不一致时必须忽略。

- [ ] **Step 3: 运行测试并确认新模块缺失**

```powershell
npm test -- tests/review-session.test.mjs tests/page-review-client.test.mjs
```

- [ ] **Step 4: 实现不可变状态模型**

```ts
export type ReviewSessionPhase =
  | "RUNNING" | "WAITING_REVIEWER" | "STALE_PAGE" | "COMPLETED";
export type ReviewerDecision = "CONFIRMED" | "MARKED_EXCEPTION";

export interface ReviewSessionState {
  phase: ReviewSessionPhase;
  index: number;
  decisions: Record<string, ReviewerDecision>;
  completedStepIds: string[];
  blockingIssue?: string;
}
```

状态机复制后端步骤并按 `sequence` 排序；所有转换验证当前 `stepId`，不允许旧按钮或重复事件推进会话。

- [ ] **Step 5: 实现页面客户端和订阅清理**

页面客户端统一构造身份参数。`subscribePageReviewDecisions` 返回取消订阅函数，React effect 卸载、重新审核和业务切换时必须调用。

- [ ] **Step 6: 运行聚焦测试**

```powershell
npm test -- tests/review-session.test.mjs tests/page-review-client.test.mjs
```

- [ ] **Step 7: Commit**

```powershell
git add src/reviewSession.ts src/pageReviewClient.ts src/types/review.ts src/reviewSteps.ts tests/review-session.test.mjs tests/page-review-client.test.mjs
git commit -m "feat: add field-first review session"
```

### Task 5: 将挂靠写入改成流程内的唯一特例

**Files:**

- Modify: `review-extension/src/hooks/useReviewWorkflow.ts`
- Modify: `review-extension/src/pageFillClient.ts`
- Modify: `review-extension/public/content.js`
- Modify: `review-extension/public/page-field-writer.js`
- Modify: `review-extension/tests/page-fill-client.test.mjs`
- Modify: `review-extension/tests/page-field-writer.test.mjs`
- Modify: `review-extension/tests/scrap-replacement-affiliation-fixture.test.mjs`

**Interfaces:**

- Produces from workflow: `applyAffiliationFill(actions: PageFillAction[]) -> Promise<PageFillResult>`。
- Existing writer remains limited to `old_vehicle.affiliation` and `new_vehicle.affiliation`。

- [ ] **Step 1: 证明当前任务完成后会立即填写**

增加接线测试，要求 `startReview` 不再在 `finalSnapshot` 后调用 `applyPageFillIntent`，并要求 workflow 暴露 `applyAffiliationFill`。

```js
assert.doesNotMatch(workflowSource,
  /finalSnapshot\.result\?\.page_fill_intent[\s\S]*applyPageFillIntent/);
assert.match(workflowSource, /applyAffiliationFill/);
```

- [ ] **Step 2: 增加全有或全无及字段白名单测试**

```js
test("a non-empty affiliation target prevents both writes", async () => {
  const result = await writer.execute(documentWithTargets({ old: "已有值", next: "" }), actions);
  assert.equal(result.ok, false);
  assert.equal(oldTarget.value, "已有值");
  assert.equal(newTarget.value, "");
});

test("writer rejects every field outside the two-field allowlist", async () => {
  const result = await writer.execute(document, [{ field: "new_vehicle.vin" }]);
  assert.equal(result.ok, false);
  assert.equal(vinTarget.value, "VIN-ORIGINAL");
});
```

- [ ] **Step 3: 从任务结束回调移除自动填写**

`useReviewWorkflow.startReview` 只保存审核结果；新增受控动作：

```ts
const applyAffiliationFill = useCallback(async (actions: PageFillAction[]) => {
  if (!pageData) return { ok: false, message: "没有找到原审核页面" };
  return applyPageFillIntent(actions, {
    tabId: pageData.sourceTabId,
    pageUrl: pageData.pageUrl,
    pageInstanceId: pageData.pageInstanceId,
    pageFingerprint: pageData.pageFingerprint,
    collectionId: pageData.collectionId,
  });
}, [pageData]);
```

- [ ] **Step 4: 补齐 `collectionId` 并保持联合预检**

`APPLY_PAGE_FILL_INTENT` 同样验证采集 ID。写入器先一次性确认两个目标唯一、均为空、可用、选项唯一且页面身份有效，全部通过后才依次写入并回读；失败时不得留下半写状态。

- [ ] **Step 5: 验证挂靠成功、阻断和非目标字段**

```powershell
npm test -- tests/page-fill-client.test.mjs tests/page-field-writer.test.mjs tests/scrap-replacement-affiliation-fixture.test.mjs
```

- [ ] **Step 6: Commit**

```powershell
git add src/hooks/useReviewWorkflow.ts src/pageFillClient.ts public/content.js public/page-field-writer.js tests/page-fill-client.test.mjs tests/page-field-writer.test.mjs tests/scrap-replacement-affiliation-fixture.test.mjs
git commit -m "fix: gate affiliation writes inside review flow"
```

### Task 6: 编排目标业务并精简审核助手

**Files:**

- Create: `review-extension/src/hooks/useScrapReplacementReview.ts`
- Create: `review-extension/src/components/ScrapReplacementReview.tsx`
- Modify: `review-extension/src/components/ReviewResults.tsx`
- Modify: `review-extension/src/App.tsx`
- Modify: `review-extension/src/App.css`
- Modify or retire for target flow: `review-extension/src/components/ReviewFieldStepper.tsx`
- Create: `review-extension/tests/scrap-replacement-review.test.mjs`
- Create: `review-extension/tests/scrap-replacement-review-wiring.test.mjs`

**Interfaces:**

- Consumes: `review.review_steps`、`pageData`、`page_fill_intent`、页面客户端和 `applyAffiliationFill`。
- Produces: 目标 Profile 的逐字段会话和仅包含当前助手异常的 UI。

- [ ] **Step 1: 编写目标 Profile 开关和助手内容失败测试**

```js
test("only Qingdao and Changchun scrap profiles use field-first review", () => {
  assert.equal(isFieldFirstProfile(qingdaoReview), true);
  assert.equal(isFieldFirstProfile(changchunReview), true);
  assert.equal(isFieldFirstProfile(transferReview), false);
});

test("assistant renders only the current actionable ASSISTANT step", () => {
  const html = renderReview([assistantMatch, pageConflict, assistantInsufficient]);
  assert.doesNotMatch(html, /政策校验通过/);
  assert.doesNotMatch(html, /页面字段冲突/);
  assert.match(html, /缺少新车发票/);
  assert.match(html, /确认无误/);
  assert.match(html, /标记异常/);
  assert.doesNotMatch(html, /继续|审核汇总|最终建议|重试次数/);
});
```

- [ ] **Step 2: 编写编排顺序和挂靠时机失败测试**

覆盖以下序列：页面成功自动前进；页面异常等待 Content Script 事件；助手成功隐藏并前进；助手异常等待组件按钮；两个按钮都一次点击即前进；主体关系和三个保护项全部 `MATCH` 后只调用一次挂靠写入；填写失败转为助手阻塞项。

- [ ] **Step 3: 运行聚焦测试并确认目标组件尚不存在**

```powershell
npm test -- tests/scrap-replacement-review.test.mjs tests/scrap-replacement-review-wiring.test.mjs
```

- [ ] **Step 4: 实现编排 Hook**

```ts
switch (step.display_target) {
  case "PAGE_FIELD":
    await showPageReviewStep(step, pageData);
    if (!step.requires_reviewer_action) advanceMatched(step.step_id);
    break;
  case "ASSISTANT":
    if (!step.requires_reviewer_action) advanceMatched(step.step_id);
    else waitForAssistantDecision(step);
    break;
}
```

主体关系步骤通过时，先确认三个辅助保护步骤也通过，再执行一次 `page_fill_intent`。填写成功直接继续且不添加常驻卡片；填写失败设置 `blockingIssue` 并等待人工处理。

- [ ] **Step 5: 实现严格精简的助手组件**

目标业务结果区域只允许渲染：

```tsx
return assistantStep ? (
  <section className="assistant-review-issue">
    <h2>{assistantStep.label}</h2>
    <p>{assistantStep.reason}</p>
    <ReviewValues values={assistantStep.values} />
    <ReviewImageAction evidence={assistantStep.evidence} />
    <div className="assistant-review-actions">
      <button onClick={() => decide("CONFIRMED")}>确认无误</button>
      <button onClick={() => decide("MARKED_EXCEPTION")}>标记异常</button>
    </div>
  </section>
) : blockingIssue ? <BlockingIssue message={blockingIssue} /> : null;
```

不得渲染 `ReviewAdvice`、`MaterialCompleteness`、`QrResults`、异常字段列表、成功步骤列表、步骤计数、技术元数据或完成汇总。当前事项处理后立即消失。

- [ ] **Step 6: 保持范围外业务旧界面**

```tsx
if (isFieldFirstProfile(review)) {
  return <ScrapReplacementReview {...fieldFirstProps} />;
}
return <LegacyReviewResults {...legacyProps} />;
```

旧 JSX 可以留在 `ReviewResults.tsx` 的命名组件中，避免本轮进行无关重构。

- [ ] **Step 7: 重置、切换业务和卸载时清理标记**

`workflow.reset()`、开始新审核、业务选择改变和组件卸载时调用 `clearPageReviewMarkers` 并取消消息订阅。清理失败只提示重新刷新页面，不得继续旧会话。

- [ ] **Step 8: 增加不会挤压宿主页面的响应式样式**

按钮设置稳定高度、明确焦点态和长文本换行；标记不得改变原字段容器宽度。窄侧栏中异常理由允许换行，不使用随视口缩放的字体。

- [ ] **Step 9: 运行目标测试、构建和静态检查**

```powershell
npm test -- tests/review-session.test.mjs tests/page-review-client.test.mjs tests/scrap-replacement-review.test.mjs tests/scrap-replacement-review-wiring.test.mjs tests/page-fill-client.test.mjs
npm run build
npm run lint
```

- [ ] **Step 10: Commit**

```powershell
git add src/hooks/useScrapReplacementReview.ts src/components/ScrapReplacementReview.tsx src/components/ReviewResults.tsx src/App.tsx src/App.css src/components/ReviewFieldStepper.tsx tests/scrap-replacement-review.test.mjs tests/scrap-replacement-review-wiring.test.mjs
git commit -m "feat: run field-first scrap review"
```

### Task 7: 全量回归、安全审计和 Edge 实页验收

**Files:**

- Modify: `review-agent-service/tests/test_backend_final_review_regressions.py`
- Modify: `review-extension/tests/scrap-replacement-affiliation-fixture.test.mjs`
- Modify: `docs/architecture.md`
- Modify: `review-agent-service/README.md`
- Modify: `review-extension/README.md`

**Interfaces:**

- Verifies: 后端契约、目标业务范围、原页面交互、助手最小展示、挂靠白名单和旧业务回归。

- [ ] **Step 1: 增加端到端后端契约回归**

```python
@pytest.mark.asyncio
@pytest.mark.parametrize("region", ["qingdao", "changchun"])
async def test_scrap_profiles_return_valid_display_routes(region):
    result = await run_review(region=region, page_fields={"new_vehicle.vin": "VIN-1"})
    assert all(step.display_target in {"PAGE_FIELD", "ASSISTANT"} for step in result.review_steps)
    assert all(step.page_field for step in result.review_steps if step.display_target == "PAGE_FIELD")
    assert all(step.page_field is None for step in result.review_steps if step.display_target == "ASSISTANT")
```

- [ ] **Step 2: 运行后端全部验证**

```powershell
cd review-agent-service
uv run pytest -q
uv run ruff check app tests
```

预期：两个命令退出码均为 0。

- [ ] **Step 3: 运行扩展全部验证**

```powershell
cd ..\review-extension
npm test
npm run build
npm run lint
```

预期：三个命令退出码均为 0。

- [ ] **Step 4: 审计所有页面写操作**

```powershell
rg -n "\.value\s*=|dispatchEvent|\.click\(" public src
git diff --check
```

人工检查要求：业务字段赋值和 `input/change` 事件仅存在于 `page-field-writer.js`，且只接受两个挂靠字段；`.click()` 不得命中宿主页面整单操作控件；`git diff --check` 无输出。

- [ ] **Step 5: 在 Edge 分别执行青岛、长春验收矩阵**

每个地区验证以下场景并保存结果：

1. 所有字段与规则通过：原字段旁保留成功标记，助手无结果卡片。
2. 一个页面字段冲突：滚动到该字段并暂停，只出现“确认无误 / 标记异常”。
3. 一个页面字段证据不足：按钮任一点击后立即进入下一字段，不出现额外“继续”。
4. 页面缺少规则要求字段：助手只显示当前缺失事项并暂停。
5. 页面外政策或材料无法确定：助手只显示当前事项；正常政策、二维码、材料结果不显示。
6. 主体关系与保护项通过：仅两个空白挂靠字段被写入并成功回读，助手不常驻显示成功卡片。
7. 一个挂靠字段非空、禁用或目标歧义：两个字段都不写入，助手显示阻塞原因。
8. 采集后切换申请单或页面重渲染：后续标记和写入立即停止。
9. 重复点击或旧页面消息：审核步骤不跳过、不重复推进。

- [ ] **Step 6: 更新架构和使用文档**

文档明确记录：后端一次运行到底；前端在内存中暂停；助手只显示当前页面外人工项；人工决定不改变后端结论；两个挂靠字段是唯一写入白名单；目标业务与旧业务边界。

- [ ] **Step 7: 最终变更审查**

```powershell
git status --short
git diff --stat
git diff --check
```

确认没有修改未列入计划的业务规则值，没有删除用户原有改动，没有生成构建产物或临时文件。

- [ ] **Step 8: Commit**

```powershell
git add tests/test_backend_final_review_regressions.py ../review-extension/tests/scrap-replacement-affiliation-fixture.test.mjs ../docs/architecture.md README.md ../review-extension/README.md
git commit -m "docs: document field-first review workflow"
```

## Final Completion Gate

- [ ] 后端全部 Pytest 通过。
- [ ] 后端 Ruff 通过。
- [ ] 扩展全部 Node 测试通过。
- [ ] 扩展生产构建通过。
- [ ] 扩展 ESLint 通过。
- [ ] `git diff --check` 通过。
- [ ] 青岛、长春均完成 9 项实页验收。
- [ ] 页面字段的“确认无误 / 标记异常”均一次点击立即进入下一项。
- [ ] 助手不显示任何正常成功项、页面字段副本、完成历史或汇总。
- [ ] 过户、车源和一致性审核行为保持不变。
- [ ] 除新车、旧车挂靠字段外，没有任何宿主页面字段写入。
