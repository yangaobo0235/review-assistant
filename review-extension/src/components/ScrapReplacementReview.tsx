import { useCallback, useMemo, useState } from "react";

import { evidencePresentation } from "../evidencePresentation";
import { fieldLabel } from "../reviewPanelConfig";
import { isBlockingPageFillFailure, type PageFillResult } from "../pageFillClient";
import { isFieldFirstTaskVisible, isQrTask } from "../reviewSteps";
import type { CheckResultValue, EvidenceFact, PageData, PageImage, QrCheck, ReviewResponse, ReviewTask } from "../types/review";

/**
 * 字段优先工作台：按后端给出的字段条目展示证据、结论和人工处置。
 *
 * 报废置换（青岛、长春）和车源审核共用本组件；两者的差别只在注册处
 * （`workbenchRenderers.tsx`）传进来的展示策略，组件内部不写业务分支。
 * 组件名沿用历史命名，行为与展示策略都由注册表和 `reviewSteps` 决定。
 */
interface Props {
  review: ReviewResponse;
  pageData?: PageData | null;
  onFocusImage?: (imageId: string) => Promise<{ ok: boolean; error?: string }>;
  onApplyPageFieldValue?: (field: string, value: string, expectedValue?: string | null) => Promise<PageFillResult>;
  onApplyPageFieldGroupValue?: (fields: string[], value: string, expectedValues?: Record<string, string | null | undefined>) => Promise<PageFillResult>;
  onRerun?: () => Promise<void>;
  /** 是否把材料完整性任务也放进工作台。 */
  materialTasksVisible?: boolean;
  /** 是否展示「页面外核验」视图。车源审核的规则结论已经落在字段行里，不需要它。 */
  externalView?: boolean;
}

type View = "PENDING" | "ALL" | "EXTERNAL";
type Decision = "MARKED_EXCEPTION";
const statusText = { MATCH: "一致", CONFLICT: "冲突", INSUFFICIENT: "待复核" } as const;
const DATE_POLICY_FIELD_BY_STEP: Record<string, string> = {
  "BUSINESS-POLICY-INVOICE-DATE": "invoice.invoice_date",
  "BUSINESS-POLICY-DISPOSAL-DEADLINE": "old_vehicle.recycle_date",
};


export function ScrapReplacementReview(props: Props) {
  return <Workbench key={props.pageData?.collectionId} {...props} />;
}

function Workbench({ review, pageData, onFocusImage = async () => ({ ok: false, error: "原图定位未配置" }), onApplyPageFieldValue = async () => ({ ok: false, message: "页面写回未配置" }), onApplyPageFieldGroupValue = async () => ({ ok: false, message: "页面组合字段写回未配置" }), onRerun, materialTasksVisible = false, externalView = true }: Props & { review: ReviewResponse }) {
  const steps = useMemo(() => [...(review.review_tasks ?? [])].sort((a, b) => a.sequence - b.sequence), [review.review_tasks]);
  // Apply the presentation policy before deriving tabs, counts or selection,
  // so hidden backend compatibility tasks cannot leak into a secondary view.
  const fieldKeys = new Set(
    steps
      .filter((step) => step.category === "FIELD")
      .map((step) => step.page_field ?? step.page_target_field)
      .filter((field): field is string => Boolean(field)),
  );
  const displaySteps = steps.filter((step) => {
    if (!isFieldFirstTaskVisible(step, { materialTasksVisible })) return false;
    const policyField = DATE_POLICY_FIELD_BY_STEP[step.step_id];
    return !(policyField && fieldKeys.has(policyField));
  });
  const [view, setView] = useState<View>("PENDING");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [message, setMessage] = useState("");
  const [filledCount, setFilledCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [blockingIssue, setBlockingIssue] = useState("");
  const effectiveNeedsAction = (step: ReviewTask) => step.requires_reviewer_action;
  const pending = displaySteps.filter((step) => effectiveNeedsAction(step) && !decisions[step.step_id]);
  const visible = view === "PENDING" ? pending : view === "EXTERNAL" ? displaySteps.filter((step) => step.category !== "FIELD") : displaySteps.filter((step) => step.category === "FIELD");
  const current = visible.find((step) => step.step_id === selectedId) ?? visible[0] ?? null;
  const choose = (step: ReviewTask, decision: Decision) => { setDecisions((previous) => ({ ...previous, [step.step_id]: decision })); setSelectedId(null); setMessage("已记录本项人工处置"); };
  const handleWriteFailure = useCallback((reason: unknown) => {
    const failure = typeof reason === "object" && reason && "message" in reason
      ? reason as Pick<PageFillResult, "message" | "code">
      : { message: typeof reason === "string" ? reason : "页面回填失败" };
    setMessage(failure.message);
    if (isBlockingPageFillFailure(failure)) setBlockingIssue(failure.message);
  }, []);
  // 原图定位的结果就地显示：面板顶部的提示离字段卡片很远，只在那里报错
  // 等于"点了没反应"。
  const focus = async (imageId: string) => {
    setMessage("正在定位原图…");
    const result = await onFocusImage(imageId);
    setMessage(result?.ok
      ? "已定位到原图，页面已滚动并高亮该图；如未看到请检查原审核页面"
      : result?.error || "原图定位失败，请重新采集");
  };
  const fill = async (step: ReviewTask, value: string) => { const field = fieldFromStep(step); if (!field || !pageData || busy || blockingIssue) return; const fields = step.page_target_fields?.length ? step.page_target_fields : [field]; const expectedValues = Object.fromEntries(fields.map((targetField) => [targetField, pageData.pageFields[targetField] ?? null])); setBusy(true); setMessage(fields.length > 1 ? "正在联合回填并回读页面字段..." : "正在回填并回读页面字段..."); try { const result = fields.length > 1 ? await onApplyPageFieldGroupValue(fields, value, expectedValues) : await onApplyPageFieldValue(field, value, expectedValues[field]); if (result.ok) { setFilledCount((count) => count + 1); setMessage(`${stepTitle(step)}已${fields.length > 1 ? "同时回填两个字段并" : ""}回读，已定位到页面字段；核对后请点击“标记人工复核”`); } else handleWriteFailure(result); } catch (error) { handleWriteFailure(error); } finally { setBusy(false); } };
  const allDone = pending.length === 0;
  return <section className="review-workbench" aria-label="字段证据审核工作台"><header className="workbench-summary"><div><strong>字段证据审核</strong><small>自动通过 {displaySteps.filter((step) => !effectiveNeedsAction(step)).length} · 已人工处理 {Object.keys(decisions).length} · 待处理 {pending.length}</small></div><b>{blockingIssue ? "页面已失效" : allDone ? "已处理完毕" : `${pending.length} 项待处理`}</b></header>{blockingIssue ? <div className="workbench-blocked" role="alert"><strong>页面操作已停止</strong><span>{blockingIssue}</span>{onRerun ? <button type="button" onClick={() => void onRerun()}>重新采集并复核</button> : null}</div> : null}<nav className="workbench-tabs" aria-label="审核视图">{(workbenchViews({ externalView, pending: pending.length, fieldCount: displaySteps.filter((step) => step.category === 'FIELD').length, externalCount: displaySteps.filter((step) => step.category !== 'FIELD').length })).map(([key, label]) => <button type="button" className={view === key ? "active" : ""} key={key} onClick={() => { setView(key); setSelectedId(null); }}>{label}</button>)}</nav><div className="workbench-index">{visible.map((step) => <button type="button" className={current?.step_id === step.step_id ? "selected" : ""} key={step.step_id} onClick={() => setSelectedId(step.step_id)}><span>{stepTitle(step)}</span><b className={`status-${step.result_status.toLowerCase()}`}>{decisions[step.step_id] ? "已处理" : statusText[step.result_status]}</b></button>)}</div><div className="workbench-detail">{current ? <StepDetail step={current} pageData={pageData} qrChecks={review.qr_checks} disabled={busy || Boolean(blockingIssue)} onFocusImage={focus} onFill={fill} onChoose={choose} /> : <div className="workbench-empty"><strong>{allDone ? "本轮审核已完成" : "当前没有待处理项目"}</strong><p>可切换到全部字段查看完整核验记录。</p></div>}{message ? <p className="workbench-message">{message}</p> : null}</div>{filledCount > 0 && onRerun && !blockingIssue ? <div className="final-review-action"><span>页面已发生 {filledCount} 项回填</span><button type="button" onClick={() => void onRerun()}>重新采集并最终复核</button></div> : null}</section>;
}

type ViewSpec = readonly [View, string];

/**
 * 工作台视图表。
 *
 * 「页面外核验」放的是材料完整性和规则结论；车源审核的规则结论已经投影到
 * 对应字段行里、任务本身也不再下发，再留一个页签只会是重复信息，所以由注册处关掉。
 */
function workbenchViews({ externalView, pending, fieldCount, externalCount }: {
  externalView: boolean;
  pending: number;
  fieldCount: number;
  externalCount: number;
}): readonly ViewSpec[] {
  const views: ViewSpec[] = [["PENDING", `待处理 (${pending})`], ["ALL", `全部字段 (${fieldCount})`]];
  if (externalView) views.push(["EXTERNAL", `页面外核验 (${externalCount})`]);
  return views;
}

function fieldFromStep(step: ReviewTask) { return step.page_field ?? step.page_target_field ?? null; }
function stepTitle(step: ReviewTask) { return step.label; }
function StepDetail({ step, pageData, qrChecks, disabled, onFocusImage, onFill, onChoose }: { step: ReviewTask; pageData?: PageData | null; qrChecks: QrCheck[]; disabled: boolean; onFocusImage: (id: string) => Promise<void>; onFill: (step: ReviewTask, value: string) => Promise<void>; onChoose: (step: ReviewTask, decision: Decision) => void }) {
  const field = fieldFromStep(step);
  const pageValue = field ? pageData?.pageFields[field] ?? step.page_value : step.page_value;
  const values = isQrTask(step) ? [] : step.values.filter((item) => item.source !== "申请页面字段" && item.value != null && String(item.value).trim() && String(item.value) !== "[object Object]");
  const images = new Map((pageData?.images ?? []).filter((image) => image.imageId).map((image) => [image.imageId as string, image]));
  const effectiveStatus = step.result_status;
  const requiresAction = step.requires_reviewer_action;
  const pageValues = step.page_values?.length ? step.page_values : [{ source: "页面原始值", value: pageValue }];
  // 页面字段条目一定有页面原值；规则结论**只有自己带了页面侧取值时**才摆这一块
  // （新旧车所有人一致性要先让审核员看到页面比出了什么）。没有的一律不显示，
  // 否则会凭空渲染一行“未采集”。
  const hasPageValues = step.category === "FIELD" || Boolean(step.page_values?.length);
  return <article className="workbench-card">
    <div className="workbench-card-title"><div><small>{CATEGORY_LABELS[step.category] ?? "核验"}</small><h2>{stepTitle(step)}</h2></div><b className={`status-${effectiveStatus.toLowerCase()}`}>{statusText[effectiveStatus]}</b></div>
    {hasPageValues ? <div className="page-value"><span>页面原始值</span>{pageValues.map((item) => <div className="page-value-row" key={item.source}><small>{pageValueLabel(item.source)}</small><strong>{cleanPageValue(item.value) || "未采集"}</strong></div>)}{step.details?.page_value_note ? <p className="page-value-note">{step.details.page_value_note}</p> : null}</div> : null}
    {values.length ? <div className="candidate-list"><span className="evidence-section-title">材料提取值</span>{values.map((item, index) => { const image = (item.image_id ? images.get(item.image_id) : undefined) || (pageData?.images ?? []).find((candidate) => item.image_index != null && candidate.index === item.image_index); return <CandidateValue key={`${item.source}-${index}`} item={item} image={image} stepLabel={stepTitle(step)} canFill={Boolean(field) && step.result_status !== "MATCH"} disabled={disabled || !step.writable} onFocusImage={onFocusImage} onFill={(value) => onFill(step, value)} />; })}</div> : null}
    {step.details?.reason_distributed ? null : <p className="workbench-reason">{step.reason}</p>}
    {field ? <ManualValueInput key={`${pageData?.collectionId}-${field}`} initialValue={cleanPageValue(pageValue)} label={stepTitle(step)} disabled={disabled || !pageData || !step.writable} onFill={(value) => onFill(step, value)} /> : null}
    {isQrTask(step) ? qrChecks.map((check, index) => <QrUrl check={check} key={`${check.image_index}-${index}`} />) : null}
    <StructuredEvidence evidence={step.evidence} />
    {requiresAction ? <div className="workbench-actions"><button type="button" disabled={disabled} className="secondary-action" onClick={() => onChoose(step, "MARKED_EXCEPTION")}>标记人工复核</button></div> : null}
  </article>;
}
/**
 * 一条材料候选值：结论、与页面的比对结果、比对说明和原图都在同一个框里。
 *
 * 车型一个字段下挂着马力、整车型号、排放标准好几条结论，写着它们的其实是
 * 字段底部那段拼起来的长理由；删掉之后审核员得在框和理由之间来回对照。
 * 后端把每条检查自己的说明放在 `check_reason` 上，由本组件贴到框里。
 * `conflicting` 与 `check_reason` 都由后端给出，前端只负责显示，不自己比较取值。
 */
function CandidateValue({ item, image, stepLabel, canFill, disabled, onFocusImage, onFill }: {
  item: CheckResultValue;
  image?: PageImage;
  stepLabel: string;
  canFill: boolean;
  disabled: boolean;
  onFocusImage: (id: string) => Promise<void>;
  onFill: (value: string) => Promise<void>;
}) {
  const label = item.source === "图片识别" ? evidencePresentation(item).label : item.source;
  const comparison = item.conflicting == null ? "" : item.conflicting ? "与页面不一致" : "与页面一致";
  return <div className="candidate">
    <div>
      <strong>{renderDiff(item.value, item.differences)}</strong>
      <small>{label}{comparison ? <>{` · `}{markMismatch(comparison)}</> : null}{item.derived_from === "invoice.invoice_no" ? " · 由发票数电号码适配" : ""}</small>
      {item.check_reason ? <span className="candidate-basis">{markMismatch(item.check_reason)}</span> : null}
      {image ? <div className="candidate-evidence"><img src={image.dataUrl || image.src} alt="材料" />{image.imageId ? <button type="button" onClick={() => void onFocusImage(image.imageId as string)}>查看原图</button> : null}</div> : null}
    </div>
    {canFill ? <button aria-label={`${stepLabel}回填材料值`} className="fill-value-button" type="button" disabled={disabled} onClick={() => void onFill(String(item.value))}>回填此值</button> : null}
  </div>;
}

function ManualValueInput({ initialValue, label, disabled, onFill }: {
  initialValue: string;
  label: string;
  disabled: boolean;
  onFill: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initialValue);
  return <div className="manual-fill">
    <label>
      <span>人工输入值</span>
      <input aria-label={`${label}人工输入值`} value={value} disabled={disabled}
        onChange={(event) => setValue(event.target.value)} />
    </label>
    <button type="button" className="fill-value-button" disabled={disabled || !value.trim()}
      onClick={() => void onFill(value.trim())}>回填此值</button>
  </div>;
}

const CATEGORY_LABELS: Record<string, string> = {
  FIELD: "页面字段",
  MATERIAL: "资料完整性",
  BUSINESS_RULE: "业务规则",
  EXTERNAL: "页面外核验",
};

/**
 * 把说明里的「不一致」标红。
 *
 * 后端给的是完整句子，前端只做呈现：不改字、不加字、不据此改变任何状态。
 * 这里只认「不一致」三个字，与页面一致时不标，避免整句都被染红。
 */
const MISMATCH_TEXT = "不一致";
function markMismatch(text: string) {
  return text.split(MISMATCH_TEXT).flatMap((part, index) =>
    index === 0
      ? [part]
      : [<mark className="mismatch" key={index}>{MISMATCH_TEXT}</mark>, part],
  );
}

function cleanPageValue(value: unknown) { return String(value ?? "").trim(); }
function pageValueLabel(source: string) {
  return fieldLabel(source);
}
function renderDiff(value: unknown, differences: import("../types/review").DifferenceRange[] = []) {
  const chars = [...String(value ?? "")];
  return [...chars, ""].map((char, index) => <span key={index}>
    {differences.filter((range) => range.kind === "MISSING" && range.start === index).map((range, i) => <mark className="value-diff" key={i} title={`缺少页面字符：${range.page_text}`}>[缺少 {range.page_text}]</mark>)}
    {differences.some((range) => range.start <= index && index < range.end) ? <mark className="value-diff">{char}</mark> : char}
  </span>);
}
function QrUrl({ check }: { check: QrCheck }) {
  const verified = Boolean(check.url && check.domain_valid);
  return <>
    <div className="qr-verified-url">
      <span>识别官网网址</span>
      {verified ? <a href={check.url as string} target="_blank" rel="noreferrer noopener">{check.url}</a> : <strong>未取得已确认的官网网址</strong>}
      {verified && !check.accessible ? <small>官网地址已确认，后台暂未访问成功。可点击网址人工核验。</small> : null}
    </div>
    {check.raw_value ? <details className="qr-technical-details">
      <summary>查看技术详情</summary>
      <span>原始二维码内容</span>
      <p>{verified ? <a href={check.url as string} target="_blank" rel="noreferrer noopener">{check.raw_value}</a> : check.raw_value}</p>
    </details> : null}
  </>;
}

function StructuredEvidence({ evidence }: { evidence: EvidenceFact[] }) { const rows = evidence.flatMap((item) => item.value && typeof item.value === "object" && !Array.isArray(item.value) ? Object.entries(item.value as Record<string, unknown>).filter(([, value]) => value != null && value !== "").map(([key, value]) => ({ source: item.source, key, value: String(value) })) : item.field?.startsWith("business_license.") && item.value != null && item.value !== "" ? [{ source: item.source, key: item.field, value: String(item.value) }] : []); return rows.length ? <dl className="structured-evidence">{rows.map((row, index) => <div key={`${row.source}-${row.key}-${index}`}><dt>{row.source} · {structuredFieldLabel(row.key)}</dt><dd>{row.value}</dd></div>)}</dl> : null; }
function structuredFieldLabel(field: string) { return ({ company_name: "企业名称", "business_license.company_name": "企业名称", legal_representative: "法定代表人", "business_license.legal_representative": "法定代表人", unified_social_credit_code: "统一社会信用代码", "business_license.unified_social_credit_code": "统一社会信用代码", vin: "车架号", certificate_no: "证明编号" } as Record<string, string>)[field] ?? field; }
