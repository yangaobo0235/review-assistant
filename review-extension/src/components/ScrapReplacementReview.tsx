import { useMemo, useState } from "react";

import type { PageFillResult } from "../pageFillClient";
import { fieldLabel } from "../reviewPanelConfig";
import type { Evidence, PageData, PageFillAction, QrCheck, ReviewResponse, ReviewStep } from "../types/review";

interface Props {
  review?: ReviewResponse;
  pageData?: PageData | null;
  onFocusImage?: (imageId: string) => Promise<void>;
  onApplyPageFieldValue?: (field: string, value: string, expectedValue?: string | null) => Promise<PageFillResult>;
  onApplyAffiliationFill?: (actions: PageFillAction[]) => Promise<PageFillResult>;
  onRerun?: () => Promise<void>;
  assistantStep?: ReviewStep | null;
  blockingIssue?: string | null;
  onDecide?: (stepId: string, decision: "CONFIRMED" | "MARKED_EXCEPTION") => void;
}

type View = "PENDING" | "ALL" | "EXTERNAL";
type Decision = "CONFIRMED" | "FILLED" | "MARKED_EXCEPTION";
const statusText = { MATCH: "一致", CONFLICT: "冲突", INSUFFICIENT: "待复核" } as const;
const DATE_POLICY_BY_FIELD: Record<string, string> = { "invoice.invoice_date": "BUSINESS-POLICY-INVOICE-DATE", "old_vehicle.recycle_date": "BUSINESS-POLICY-DISPOSAL-DEADLINE" };

export function ScrapReplacementReview(props: Props) {
  if (!props.review) return <LegacyAssistantFallback {...props} />;
  return <Workbench {...props} review={props.review} />;
}

function LegacyAssistantFallback({ assistantStep, blockingIssue, onDecide, onFocusImage = async () => {} }: Props) {
  if (blockingIssue) return <section className="assistant-review"><p className="assistant-review-reason">{blockingIssue}</p></section>;
  if (!assistantStep) return null;
  return <section className="assistant-review" aria-label="审核助手"><h2>{assistantStep.label}</h2><p className="assistant-review-reason">{assistantStep.reason}</p>{assistantStep.values.map((item, index) => <p key={`${item.source}-${index}`}><b>{item.source}</b> {String(item.value ?? "")}</p>)}<EvidenceActions evidence={assistantStep.evidence} onFocusImage={onFocusImage} />{assistantStep.requires_reviewer_action ? <div className="assistant-review-actions"><button type="button" onClick={() => onDecide?.(assistantStep.step_id, "CONFIRMED")}>确认无误</button><button type="button" onClick={() => onDecide?.(assistantStep.step_id, "MARKED_EXCEPTION")}>标记异常</button></div> : null}</section>;
}

function Workbench({ review, pageData, onFocusImage = async () => {}, onApplyPageFieldValue = async () => ({ ok: false, message: "页面写回未配置" }), onApplyAffiliationFill = async () => ({ ok: false, message: "挂靠写回未配置" }), onRerun }: Props & { review: ReviewResponse }) {
  const steps = useMemo(() => [...(review.review_steps ?? [])].sort((a, b) => a.sequence - b.sequence), [review.review_steps]);
  const displaySteps = useMemo(() => groupedDisplaySteps(review, steps), [review, steps]);
  const [view, setView] = useState<View>("PENDING");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [message, setMessage] = useState("");
  const [filledCount, setFilledCount] = useState(0);
  const [affiliationFilled, setAffiliationFilled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blockingIssue, setBlockingIssue] = useState("");
  const policyById = useMemo(() => new Map(steps.filter(isDatePolicy).map((step) => [step.step_id, step])), [steps]);
  const effectiveNeedsAction = (step: ReviewStep) => { const field = fieldFromStep(step); const policyId = field ? DATE_POLICY_BY_FIELD[field] : undefined; return step.requires_reviewer_action || Boolean(policyId && policyById.get(policyId)?.requires_reviewer_action); };
  const pending = displaySteps.filter((step) => effectiveNeedsAction(step) && !decisions[step.step_id]);
  const visible = view === "PENDING" ? pending : view === "EXTERNAL" ? displaySteps.filter((step) => step.category !== "FIELD") : displaySteps.filter((step) => step.category === "FIELD");
  const current = visible.find((step) => step.step_id === selectedId) ?? visible[0] ?? null;
  const choose = (step: ReviewStep, decision: Decision) => { setDecisions((previous) => ({ ...previous, [step.step_id]: decision })); setSelectedId(null); setMessage(decision === "FILLED" ? "字段已回填并回读" : "已记录本项人工处置"); };
  const handleWriteFailure = (reason: unknown) => { const text = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "页面回填失败"; setMessage(text); if (/页面已变化|重新审核|重新采集|context invalidated|Receiving end/i.test(text)) setBlockingIssue(text); };
  const fill = async (step: ReviewStep, value: string) => { const field = fieldFromStep(step); if (!field || !pageData || busy || blockingIssue) return; const oldValue = pageData.pageFields[field] ?? ""; if (oldValue && oldValue !== value && typeof globalThis.confirm === "function" && !globalThis.confirm(`页面已有值“${oldValue}”，确认覆盖吗？`)) return; setBusy(true); setMessage("正在回填并回读页面字段..."); try { const result = await onApplyPageFieldValue(field, value, oldValue || null); if (result.ok) { setFilledCount((count) => count + 1); choose(step, "FILLED"); } else handleWriteFailure(result.message); } catch (error) { handleWriteFailure(error); } finally { setBusy(false); } };
  const fillAffiliation = async () => { if (affiliationFilled || busy || blockingIssue) return; const actions = review.page_fill_intent ?? []; if (actions.length !== 2) { setMessage("当前主体关系没有可用的挂靠填写建议"); return; } setBusy(true); setMessage("正在联合校验并填写挂靠字段..."); try { const result = await onApplyAffiliationFill(actions); if (result.ok) { setAffiliationFilled(true); setFilledCount((count) => count + (result.actions?.length ?? 2)); } else handleWriteFailure(result.message); setMessage(result.message); } catch (error) { handleWriteFailure(error); } finally { setBusy(false); } };
  const allDone = pending.length === 0;
  return <section className="review-workbench" aria-label="字段证据审核工作台"><header className="workbench-summary"><div><strong>字段证据审核</strong><small>自动通过 {displaySteps.filter((step) => !effectiveNeedsAction(step)).length} · 已人工处理 {Object.keys(decisions).length} · 待处理 {pending.length}</small></div><b>{blockingIssue ? "页面已失效" : allDone ? "已处理完毕" : `${pending.length} 项待处理`}</b></header>{blockingIssue ? <div className="workbench-blocked" role="alert"><strong>页面操作已停止</strong><span>{blockingIssue}</span>{onRerun ? <button type="button" onClick={() => void onRerun()}>重新采集并复核</button> : null}</div> : null}<nav className="workbench-tabs" aria-label="审核视图">{([['PENDING', `待处理 (${pending.length})`], ['ALL', '全部字段'], ['EXTERNAL', '页面外核验']] as const).map(([key, label]) => <button type="button" className={view === key ? "active" : ""} key={key} onClick={() => { setView(key); setSelectedId(null); }}>{label}</button>)}</nav><div className="workbench-index">{visible.map((step) => <button type="button" className={current?.step_id === step.step_id ? "selected" : ""} key={step.step_id} onClick={() => setSelectedId(step.step_id)}><span>{stepTitle(step)}</span><b className={`status-${step.result_status.toLowerCase()}`}>{decisions[step.step_id] ? "已处理" : statusText[step.result_status]}</b></button>)}</div><div className="workbench-detail">{current ? <StepDetail step={current} policy={fieldFromStep(current) ? policyById.get(DATE_POLICY_BY_FIELD[fieldFromStep(current) as string]) : undefined} pageData={pageData} qrChecks={review.qr_checks} affiliationActions={review.page_fill_intent ?? []} affiliationFilled={affiliationFilled} disabled={busy || Boolean(blockingIssue)} onFocusImage={onFocusImage} onFill={fill} onFillAffiliation={fillAffiliation} onChoose={choose} /> : <div className="workbench-empty"><strong>{allDone ? "本轮审核已完成" : "当前没有待处理项目"}</strong><p>可切换到全部字段查看完整核验记录。</p></div>}{message ? <p className="workbench-message">{message}</p> : null}</div>{filledCount > 0 && onRerun && !blockingIssue ? <div className="final-review-action"><span>页面已发生 {filledCount} 项回填</span><button type="button" onClick={() => void onRerun()}>重新采集并最终复核</button></div> : null}</section>;
}

function fieldFromStep(step: ReviewStep) { return step.step_id.startsWith("FIELD-") ? step.step_id.slice(6) : null; }
function stepTitle(step: ReviewStep) { const field = fieldFromStep(step); return field ? fieldLabel(field) : step.label; }
function isDatePolicy(step: ReviewStep) { return step.step_id === "BUSINESS-POLICY-INVOICE-DATE" || step.step_id === "BUSINESS-POLICY-DISPOSAL-DEADLINE"; }
function isAuxiliaryAffiliation(step: ReviewStep) { return step.step_id.startsWith("BUSINESS-AFFILIATION-AUX-"); }

function groupedDisplaySteps(review: ReviewResponse, steps: ReviewStep[]): ReviewStep[] {
  const auxiliary = steps.filter(isAuxiliaryAffiliation);
  const base = steps.filter((step) => !isDatePolicy(step) && !isAuxiliaryAffiliation(step) && step.category !== "MATERIAL" && !step.step_id.startsWith("QR-")).map((step) => step.step_id === "BUSINESS-AFFILIATION-SUBJECT-001" ? mergeAffiliationStep(step, auxiliary) : step);
  const qrSteps = steps.filter((step) => step.step_id.startsWith("QR-"));
  const materialSteps = steps.filter((step) => step.category === "MATERIAL");
  const qr = mergeSteps("QR-GROUP", "二维码官网核验", qrSteps, review.qr_checks.length ? "查看二维码识别、官网访问和字段核验结果" : "未识别到可核验的二维码");
  const report = review.material_completeness;
  const materialStatus = report?.status === "COMPLETE" ? "MATCH" : "INSUFFICIENT";
  const material = mergeSteps("MATERIAL-GROUP", "材料完整性和识别异常", materialSteps, report?.status === "COMPLETE" ? "必需材料已采集并完成识别" : "材料不完整或存在识别异常", materialStatus);
  return [...base, qr, material].sort((left, right) => left.sequence - right.sequence);
}

function mergeAffiliationStep(subject: ReviewStep, auxiliary: ReviewStep[]): ReviewStep {
  const severity = { MATCH: 0, INSUFFICIENT: 1, CONFLICT: 2 } as const;
  const resultStatus = auxiliary.reduce<ReviewStep["result_status"]>((status, item) => severity[item.result_status] > severity[status] ? item.result_status : status, subject.result_status);
  return { ...subject, result_status: resultStatus, requires_reviewer_action: resultStatus !== "MATCH", reason: [subject.reason, ...auxiliary.map((item) => `${item.label}：${item.reason}`)].filter(Boolean).join("；"), values: [...subject.values, ...auxiliary.flatMap((item) => item.values)], evidence: [...subject.evidence, ...auxiliary.flatMap((item) => item.evidence)] };
}

function mergeSteps(stepId: string, label: string, members: ReviewStep[], fallbackReason: string, fallbackStatus: ReviewStep["result_status"] = "INSUFFICIENT"): ReviewStep {
  const severity = { MATCH: 0, INSUFFICIENT: 1, CONFLICT: 2 } as const;
  const resultStatus = members.reduce<ReviewStep["result_status"]>((status, item) => severity[item.result_status] > severity[status] ? item.result_status : status, members[0]?.result_status ?? fallbackStatus);
  return { step_id: stepId, sequence: members[0]?.sequence ?? Number.MAX_SAFE_INTEGER - (stepId === "QR-GROUP" ? 1 : 0), category: stepId === "MATERIAL-GROUP" ? "MATERIAL" : "EXTERNAL", display_target: "ASSISTANT", page_field: null, requires_reviewer_action: resultStatus !== "MATCH", label, result_status: resultStatus, reason: members.map((item) => item.reason).filter(Boolean).join("；") || fallbackReason, values: members.flatMap((item) => item.values), evidence: members.flatMap((item) => item.evidence) };
}

function StepDetail({ step, policy, pageData, qrChecks, affiliationActions, affiliationFilled, disabled, onFocusImage, onFill, onFillAffiliation, onChoose }: { step: ReviewStep; policy?: ReviewStep; pageData?: PageData | null; qrChecks: QrCheck[]; affiliationActions: PageFillAction[]; affiliationFilled: boolean; disabled: boolean; onFocusImage: (id: string) => Promise<void>; onFill: (step: ReviewStep, value: string) => Promise<void>; onFillAffiliation: () => Promise<void>; onChoose: (step: ReviewStep, decision: Decision) => void }) {
  const field = fieldFromStep(step); const pageValue = field && pageData ? pageData.pageFields[field] : undefined; const grouped = new Map<string, { value: string; sources: string[] }>();
  if (step.step_id !== "QR-GROUP") for (const item of step.values) { const value = String(item.value ?? "").trim(); if (!value || value === "[object Object]") continue; const key = value.replace(/\s+/g, "").toLowerCase(); const existing = grouped.get(key); if (existing) existing.sources.push(item.source); else grouped.set(key, { value, sources: [item.source] }); }
  const effectiveStatus = policy?.result_status && policy.result_status !== "MATCH" ? policy.result_status : step.result_status;
  const requiresAction = step.requires_reviewer_action || Boolean(policy?.requires_reviewer_action);
  return <article className="workbench-card"><div className="workbench-card-title"><div><small>{step.category === "FIELD" ? "页面字段" : "页面外核验"}</small><h2>{stepTitle(step)}</h2></div><b className={`status-${effectiveStatus.toLowerCase()}`}>{statusText[effectiveStatus]}</b></div>{field ? <div className="page-value"><span>页面原值</span><strong>{pageValue || "未采集"}</strong></div> : null}<p className="workbench-reason">{step.reason}</p>{policy ? <div className={`policy-result status-${policy.result_status.toLowerCase()}`}><b>地区政策核验</b><span>{policy.reason}</span></div> : null}{step.step_id === "QR-GROUP" ? qrChecks.map((check, index) => <QrUrl check={check} key={`${check.image_index}-${index}`} />) : null}{grouped.size ? <div className="candidate-list">{[...grouped.values()].map(({ value, sources }) => <div className="candidate" key={value}><strong>{value}</strong><small>{sources.join("、")}</small>{field && value !== String(pageValue ?? "") ? <button type="button" disabled={disabled} onClick={() => void onFill(step, value)}>回填此值</button> : null}</div>)}</div> : null}<StructuredEvidence evidence={step.evidence} /><EvidenceActions evidence={step.evidence} pageData={pageData} onFocusImage={onFocusImage} />{step.step_id === "BUSINESS-AFFILIATION-SUBJECT-001" && step.result_status === "MATCH" && affiliationActions.length === 2 ? <button type="button" className="affiliation-fill-action" disabled={affiliationFilled || disabled} onClick={() => void onFillAffiliation()}>{affiliationFilled ? "挂靠字段已填写" : "填写挂靠字段"}</button> : null}{requiresAction ? <div className="workbench-actions"><button type="button" disabled={disabled} onClick={() => onChoose(step, "CONFIRMED")}>{field ? "保留页面值" : "确认已核对"}</button><button type="button" disabled={disabled} className="secondary-action" onClick={() => onChoose(step, "MARKED_EXCEPTION")}>标记人工复核</button></div> : null}</article>;
}

function QrUrl({ check }: { check: QrCheck }) { const verified = Boolean(check.url && check.domain_valid && check.accessible); return <div className="qr-verified-url"><span>识别官网网址</span>{verified ? <a href={check.url as string} target="_blank" rel="noreferrer noopener">{check.url}</a> : <strong>未取得通过安全校验的官网网址</strong>}</div>; }

function StructuredEvidence({ evidence }: { evidence: Evidence[] }) { const rows = evidence.flatMap((item) => item.value && typeof item.value === "object" && !Array.isArray(item.value) ? Object.entries(item.value as Record<string, unknown>).filter(([, value]) => value != null && value !== "").map(([key, value]) => ({ source: item.source, key, value: String(value) })) : item.field?.startsWith("business_license.") && item.value != null && item.value !== "" ? [{ source: item.source, key: item.field, value: String(item.value) }] : []); return rows.length ? <dl className="structured-evidence">{rows.map((row, index) => <div key={`${row.source}-${row.key}-${index}`}><dt>{row.source} · {structuredFieldLabel(row.key)}</dt><dd>{row.value}</dd></div>)}</dl> : null; }
function structuredFieldLabel(field: string) { return ({ company_name: "企业名称", "business_license.company_name": "企业名称", legal_representative: "法定代表人", "business_license.legal_representative": "法定代表人", unified_social_credit_code: "统一社会信用代码", "business_license.unified_social_credit_code": "统一社会信用代码", vin: "车架号", certificate_no: "证明编号" } as Record<string, string>)[field] ?? field; }

function EvidenceActions({ evidence, pageData, onFocusImage }: { evidence: Evidence[]; pageData?: PageData | null; onFocusImage: (id: string) => Promise<void> }) { const ids = [...new Set(evidence.map((item) => item.image_id).filter((item): item is string => Boolean(item)))]; const images = new Map((pageData?.images ?? []).filter((image) => image.imageId).map((image) => [image.imageId as string, image])); return ids.length ? <div className="evidence-actions">{ids.map((id) => <div className="evidence-image" key={id}>{images.get(id)?.src ? <img src={images.get(id)?.dataUrl || images.get(id)?.src} alt={images.get(id)?.alt || "审核资料证据"} /> : null}<button type="button" onClick={() => void onFocusImage(id)}>查看原图</button></div>)}</div> : null; }
