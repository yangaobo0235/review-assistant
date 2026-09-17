import { useCallback, useMemo, useState } from "react";

import { evidencePresentation } from "../evidencePresentation";
import { fieldLabel } from "../reviewPanelConfig";
import { isBlockingPageFillFailure, type PageFillResult } from "../pageFillClient";
import { isQrTask, isScrapReplacementTaskVisible } from "../reviewSteps";
import type { EvidenceFact, PageData, QrCheck, ReviewResponse, ReviewTask } from "../types/review";

interface Props {
  review?: ReviewResponse;
  pageData?: PageData | null;
  onFocusImage?: (imageId: string) => Promise<void>;
  onApplyPageFieldValue?: (field: string, value: string, expectedValue?: string | null) => Promise<PageFillResult>;
  onApplyPageFieldGroupValue?: (fields: string[], value: string, expectedValues?: Record<string, string | null | undefined>) => Promise<PageFillResult>;
  onRerun?: () => Promise<void>;
  assistantStep?: ReviewTask | null;
  blockingIssue?: string | null;
  onDecide?: (stepId: string, decision: "CONFIRMED" | "MARKED_EXCEPTION") => void;
}

type View = "PENDING" | "ALL" | "EXTERNAL";
type Decision = "MARKED_EXCEPTION";
const statusText = { MATCH: "一致", CONFLICT: "冲突", INSUFFICIENT: "待复核" } as const;
const DATE_POLICY_FIELD_BY_STEP: Record<string, string> = {
  "BUSINESS-POLICY-INVOICE-DATE": "invoice.invoice_date",
  "BUSINESS-POLICY-DISPOSAL-DEADLINE": "old_vehicle.recycle_date",
};


export function ScrapReplacementReview(props: Props) {
  if (!props.review) return <LegacyAssistantFallback {...props} />;
  return <Workbench key={props.pageData?.collectionId} {...props} review={props.review} />;
}

function LegacyAssistantFallback({ assistantStep, blockingIssue, onDecide, onFocusImage = async () => {} }: Props) {
  if (blockingIssue) return <section className="assistant-review"><p className="assistant-review-reason">{blockingIssue}</p></section>;
  if (!assistantStep) return null;
  return <section className="assistant-review" aria-label="审核助手"><h2>{assistantStep.label}</h2><p className="assistant-review-reason">{assistantStep.reason}</p>{assistantStep.values.map((item, index) => <p key={`${item.source}-${index}`}><b>{item.source}</b> {String(item.value ?? "")}</p>)}<EvidenceActions evidence={assistantStep.evidence} onFocusImage={onFocusImage} />{assistantStep.requires_reviewer_action ? <div className="assistant-review-actions"><button type="button" onClick={() => onDecide?.(assistantStep.step_id, "CONFIRMED")}>确认无误</button><button type="button" onClick={() => onDecide?.(assistantStep.step_id, "MARKED_EXCEPTION")}>标记异常</button></div> : null}</section>;
}

function Workbench({ review, pageData, onFocusImage = async () => {}, onApplyPageFieldValue = async () => ({ ok: false, message: "页面写回未配置" }), onApplyPageFieldGroupValue = async () => ({ ok: false, message: "页面组合字段写回未配置" }), onRerun }: Props & { review: ReviewResponse }) {
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
    if (!isScrapReplacementTaskVisible(step)) return false;
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
  const fill = async (step: ReviewTask, value: string) => { const field = fieldFromStep(step); if (!field || !pageData || busy || blockingIssue) return; const fields = step.page_target_fields?.length ? step.page_target_fields : [field]; const expectedValues = Object.fromEntries(fields.map((targetField) => [targetField, pageData.pageFields[targetField] ?? null])); setBusy(true); setMessage(fields.length > 1 ? "正在联合回填并回读页面字段..." : "正在回填并回读页面字段..."); try { const result = fields.length > 1 ? await onApplyPageFieldGroupValue(fields, value, expectedValues) : await onApplyPageFieldValue(field, value, expectedValues[field]); if (result.ok) { setFilledCount((count) => count + 1); setMessage(`${stepTitle(step)}已${fields.length > 1 ? "同时回填两个字段并" : ""}回读，已定位到页面字段；核对后请点击“标记人工复核”`); } else handleWriteFailure(result); } catch (error) { handleWriteFailure(error); } finally { setBusy(false); } };
  const allDone = pending.length === 0;
  return <section className="review-workbench" aria-label="字段证据审核工作台"><header className="workbench-summary"><div><strong>字段证据审核</strong><small>自动通过 {displaySteps.filter((step) => !effectiveNeedsAction(step)).length} · 已人工处理 {Object.keys(decisions).length} · 待处理 {pending.length}</small></div><b>{blockingIssue ? "页面已失效" : allDone ? "已处理完毕" : `${pending.length} 项待处理`}</b></header>{blockingIssue ? <div className="workbench-blocked" role="alert"><strong>页面操作已停止</strong><span>{blockingIssue}</span>{onRerun ? <button type="button" onClick={() => void onRerun()}>重新采集并复核</button> : null}</div> : null}<nav className="workbench-tabs" aria-label="审核视图">{([['PENDING', `待处理 (${pending.length})`], ['ALL', '全部字段 (' + displaySteps.filter((step) => step.category === 'FIELD').length + ')'], ['EXTERNAL', '页面外核验 (' + displaySteps.filter((step) => step.category !== 'FIELD').length + ')']] as const).map(([key, label]) => <button type="button" className={view === key ? "active" : ""} key={key} onClick={() => { setView(key); setSelectedId(null); }}>{label}</button>)}</nav><div className="workbench-index">{visible.map((step) => <button type="button" className={current?.step_id === step.step_id ? "selected" : ""} key={step.step_id} onClick={() => setSelectedId(step.step_id)}><span>{stepTitle(step)}</span><b className={`status-${step.result_status.toLowerCase()}`}>{decisions[step.step_id] ? "已处理" : statusText[step.result_status]}</b></button>)}</div><div className="workbench-detail">{current ? <StepDetail step={current} pageData={pageData} qrChecks={review.qr_checks} disabled={busy || Boolean(blockingIssue)} onFocusImage={onFocusImage} onFill={fill} onChoose={choose} /> : <div className="workbench-empty"><strong>{allDone ? "本轮审核已完成" : "当前没有待处理项目"}</strong><p>可切换到全部字段查看完整核验记录。</p></div>}{message ? <p className="workbench-message">{message}</p> : null}</div>{filledCount > 0 && onRerun && !blockingIssue ? <div className="final-review-action"><span>页面已发生 {filledCount} 项回填</span><button type="button" onClick={() => void onRerun()}>重新采集并最终复核</button></div> : null}</section>;
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
  return <article className="workbench-card">
    <div className="workbench-card-title"><div><small>{step.category === "FIELD" ? "页面字段" : "页面外核验"}</small><h2>{stepTitle(step)}</h2></div><b className={`status-${effectiveStatus.toLowerCase()}`}>{statusText[effectiveStatus]}</b></div>
    {step.category === "FIELD" ? <div className="page-value"><span>页面原始值</span>{pageValues.map((item) => <div className="page-value-row" key={item.source}><small>{pageValueLabel(item.source)}</small><strong>{cleanPageValue(item.value) || "未采集"}</strong></div>)}</div> : null}
    {values.length ? <div className="candidate-list"><span className="evidence-section-title">材料提取值</span>{values.map((item, index) => { const image = (item.image_id ? images.get(item.image_id) : undefined) || (pageData?.images ?? []).find((candidate) => item.image_index != null && candidate.index === item.image_index); return <div className="candidate" key={`${item.source}-${index}`}><div><strong>{renderDiff(item.value, item.differences)}</strong><small>{item.source === "图片识别" ? evidencePresentation(item).label : item.source}{item.derived_from === "invoice.invoice_no" ? " · 由发票数电号码适配" : ""}</small>{image ? <div className="candidate-evidence"><img src={image.dataUrl || image.src} alt="材料" />{image.imageId ? <button type="button" onClick={() => void onFocusImage(image.imageId as string)}>查看原图</button> : null}</div> : null}</div>{field && step.result_status !== "MATCH" ? <button aria-label={`${stepTitle(step)}回填材料值`} className="fill-value-button" type="button" disabled={disabled || !step.writable} onClick={() => void onFill(step, String(item.value))}>回填此值</button> : null}</div>; })}</div> : null}
    <p className="workbench-reason">{step.reason}</p>
    {field ? <ManualValueInput key={`${pageData?.collectionId}-${field}`} initialValue={cleanPageValue(pageValue)} label={stepTitle(step)} disabled={disabled || !pageData || !step.writable} onFill={(value) => onFill(step, value)} /> : null}
    {isQrTask(step) ? qrChecks.map((check, index) => <QrUrl check={check} key={`${check.image_index}-${index}`} />) : null}
    <StructuredEvidence evidence={step.evidence} />
    {requiresAction ? <div className="workbench-actions"><button type="button" disabled={disabled} className="secondary-action" onClick={() => onChoose(step, "MARKED_EXCEPTION")}>标记人工复核</button></div> : null}
  </article>;
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

function EvidenceActions({ evidence, pageData, onFocusImage }: { evidence: EvidenceFact[]; pageData?: PageData | null; onFocusImage: (id: string) => Promise<void> }) { const ids = [...new Set(evidence.map((item) => item.image_id).filter((item): item is string => Boolean(item)))]; const images = new Map((pageData?.images ?? []).filter((image) => image.imageId).map((image) => [image.imageId as string, image])); return ids.length ? <div className="evidence-actions">{ids.map((id) => <div className="evidence-image" key={id}>{images.get(id)?.src ? <img src={images.get(id)?.dataUrl || images.get(id)?.src} alt={images.get(id)?.alt || "审核资料证据"} /> : null}<button type="button" onClick={() => void onFocusImage(id)}>查看原图</button></div>)}</div> : null; }
