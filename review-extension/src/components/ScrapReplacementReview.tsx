import { useEffect, useMemo, useRef, useState } from "react";

import { isBlockingPageFillFailure, type PageFillResult } from "../pageFillClient";
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
type Decision = "MARKED_EXCEPTION";
const statusText = { MATCH: "一致", CONFLICT: "冲突", INSUFFICIENT: "待复核" } as const;
const DATE_POLICY_BY_FIELD: Record<string, string> = { "invoice.invoice_date": "BUSINESS-POLICY-INVOICE-DATE", "old_vehicle.recycle_date": "BUSINESS-POLICY-DISPOSAL-DEADLINE" };

export function ScrapReplacementReview(props: Props) {
  if (!props.review) return <LegacyAssistantFallback {...props} />;
  return <Workbench key={props.pageData?.collectionId} {...props} review={props.review} />;
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
  const automaticAttempt = useRef("");
  const policyById = useMemo(() => new Map(steps.filter(isDatePolicy).map((step) => [step.step_id, step])), [steps]);
  const effectiveNeedsAction = (step: ReviewStep) => { const field = fieldFromStep(step); const policyId = field ? DATE_POLICY_BY_FIELD[field] : undefined; return step.requires_reviewer_action || Boolean(policyId && policyById.get(policyId)?.requires_reviewer_action); };
  const pending = displaySteps.filter((step) => effectiveNeedsAction(step) && !decisions[step.step_id]);
  const visible = view === "PENDING" ? pending : view === "EXTERNAL" ? displaySteps.filter((step) => step.category !== "FIELD") : displaySteps.filter((step) => step.category === "FIELD");
  const current = visible.find((step) => step.step_id === selectedId) ?? visible[0] ?? null;
  const choose = (step: ReviewStep, decision: Decision) => { setDecisions((previous) => ({ ...previous, [step.step_id]: decision })); setSelectedId(null); setMessage("已记录本项人工处置"); };
  const handleWriteFailure = (reason: unknown) => {
    const failure = typeof reason === "object" && reason && "message" in reason
      ? reason as Pick<PageFillResult, "message" | "code">
      : { message: typeof reason === "string" ? reason : "页面回填失败" };
    setMessage(failure.message);
    if (isBlockingPageFillFailure(failure)) setBlockingIssue(failure.message);
  };
  const fill = async (step: ReviewStep, value: string) => { const field = fieldFromStep(step); if (!field || !pageData || busy || blockingIssue) return; const oldValue = pageData.pageFields[field] ?? ""; setBusy(true); setMessage("正在回填并回读页面字段..."); try { const result = await onApplyPageFieldValue(field, value, oldValue); if (result.ok) { setFilledCount((count) => count + 1); setMessage(`${stepTitle(step)}已回填并回读，已定位到页面字段；核对后请点击“标记人工复核”`); } else handleWriteFailure(result); } catch (error) { handleWriteFailure(error); } finally { setBusy(false); } };
  const fillAffiliation = async () => { if (affiliationFilled || busy || blockingIssue) return; const actions = review.page_fill_intent ?? []; if (actions.length !== 2) { setMessage("当前主体关系没有可用的挂靠填写建议"); return; } setBusy(true); setMessage("正在联合校验并填写挂靠字段..."); try { const result = await onApplyAffiliationFill(actions); if (result.ok) { setAffiliationFilled(true); setFilledCount((count) => count + (result.actions?.length ?? 2)); } else handleWriteFailure(result); setMessage(result.message); } catch (error) { handleWriteFailure(error); } finally { setBusy(false); } };
  useEffect(() => { const id = pageData?.collectionId; const actions = review.page_fill_intent ?? []; if (!id || actions.length !== 2 || automaticAttempt.current === id) return; const subject = displaySteps.find((step) => step.step_id === "BUSINESS-AFFILIATION-SUBJECT-001"); if (subject && subject.details?.affiliation_subject_status !== "MATCH" && subject.result_status !== "MATCH") return; if (!actions.some((a) => a.field === "old_vehicle.affiliation") || !actions.some((a) => a.field === "new_vehicle.affiliation")) return; automaticAttempt.current = id; void Promise.resolve().then(() => fillAffiliation()); }, [pageData?.collectionId, review.page_fill_intent]);
  const allDone = pending.length === 0;
  return <section className="review-workbench" aria-label="字段证据审核工作台"><header className="workbench-summary"><div><strong>字段证据审核</strong><small>自动通过 {displaySteps.filter((step) => !effectiveNeedsAction(step)).length} · 已人工处理 {Object.keys(decisions).length} · 待处理 {pending.length}</small></div><b>{blockingIssue ? "页面已失效" : allDone ? "已处理完毕" : `${pending.length} 项待处理`}</b></header>{blockingIssue ? <div className="workbench-blocked" role="alert"><strong>页面操作已停止</strong><span>{blockingIssue}</span>{onRerun ? <button type="button" onClick={() => void onRerun()}>重新采集并复核</button> : null}</div> : null}<nav className="workbench-tabs" aria-label="审核视图">{([['PENDING', `待处理 (${pending.length})`], ['ALL', '全部字段 (' + steps.filter((step) => step.category === 'FIELD').length + ')'], ['EXTERNAL', '页面外核验 (' + displaySteps.filter((step) => step.category !== 'FIELD').length + ')']] as const).map(([key, label]) => <button type="button" className={view === key ? "active" : ""} key={key} onClick={() => { setView(key); setSelectedId(null); }}>{label}</button>)}</nav><div className="workbench-index">{visible.map((step) => <button type="button" className={current?.step_id === step.step_id ? "selected" : ""} key={step.step_id} onClick={() => setSelectedId(step.step_id)}><span>{stepTitle(step)}</span><b className={`status-${step.result_status.toLowerCase()}`}>{decisions[step.step_id] ? "已处理" : statusText[step.result_status]}</b></button>)}</div><div className="workbench-detail">{current ? <StepDetail step={current} policy={fieldFromStep(current) ? policyById.get(DATE_POLICY_BY_FIELD[fieldFromStep(current) as string]) : undefined} pageData={pageData} qrChecks={review.qr_checks} affiliationActions={review.page_fill_intent ?? []} affiliationFilled={affiliationFilled} materialReport={review.material_completeness} disabled={busy || Boolean(blockingIssue)} onFocusImage={onFocusImage} onFill={fill} onFillAffiliation={fillAffiliation} onChoose={choose} /> : <div className="workbench-empty"><strong>{allDone ? "本轮审核已完成" : "当前没有待处理项目"}</strong><p>可切换到全部字段查看完整核验记录。</p></div>}{message ? <p className="workbench-message">{message}</p> : null}</div>{filledCount > 0 && onRerun && !blockingIssue ? <div className="final-review-action"><span>页面已发生 {filledCount} 项回填</span><button type="button" onClick={() => void onRerun()}>重新采集并最终复核</button></div> : null}</section>;
}

function fieldFromStep(step: ReviewStep) { return step.page_field || (step.step_id.startsWith("FIELD-") ? step.step_id.slice(6) : null); }
function stepTitle(step: ReviewStep) { const field = fieldFromStep(step); const labels: Record<string, string> = { "old_vehicle.affiliation": "报废车挂靠", "new_vehicle.affiliation": "新车挂靠" }; return field ? labels[field] || fieldLabel(field) : step.label; }
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
  return { ...subject, result_status: resultStatus, requires_reviewer_action: resultStatus !== "MATCH", details: { ...(subject.details || {}), affiliation_subject_status: subject.result_status }, reason: [subject.reason, ...auxiliary.map((item) => `${item.label}：${item.reason}`)].filter(Boolean).join("；"), values: [...subject.values, ...auxiliary.flatMap((item) => item.values)], evidence: [...subject.evidence, ...auxiliary.flatMap((item) => item.evidence)] };
}

function mergeSteps(stepId: string, label: string, members: ReviewStep[], fallbackReason: string, fallbackStatus: ReviewStep["result_status"] = "INSUFFICIENT"): ReviewStep {
  const severity = { MATCH: 0, INSUFFICIENT: 1, CONFLICT: 2 } as const;
  const resultStatus = members.reduce<ReviewStep["result_status"]>((status, item) => severity[item.result_status] > severity[status] ? item.result_status : status, members[0]?.result_status ?? fallbackStatus);
  return { step_id: stepId, sequence: members[0]?.sequence ?? Number.MAX_SAFE_INTEGER - (stepId === "QR-GROUP" ? 1 : 0), category: stepId === "MATERIAL-GROUP" ? "MATERIAL" : "EXTERNAL", display_target: "ASSISTANT", page_field: null, requires_reviewer_action: resultStatus !== "MATCH", label, result_status: resultStatus, reason: members.map((item) => item.reason).filter(Boolean).join("；") || fallbackReason, values: members.flatMap((item) => item.values), evidence: members.flatMap((item) => item.evidence) };
}

function StepDetail({ step, policy, pageData, qrChecks, affiliationActions, affiliationFilled, disabled, onFocusImage, onFill, onFillAffiliation, onChoose, materialReport }: { step: ReviewStep; policy?: ReviewStep; pageData?: PageData | null; qrChecks: QrCheck[]; affiliationActions: PageFillAction[]; affiliationFilled: boolean; disabled: boolean; onFocusImage: (id: string) => Promise<void>; materialReport?: any; onFill: (step: ReviewStep, value: string) => Promise<void>; onFillAffiliation: () => void; onChoose: (step: ReviewStep, decision: Decision) => void }) {
  const field = fieldFromStep(step); const pageValue = field ? pageData?.pageFields[field] ?? step.page_value : undefined;
  const values = step.step_id === "QR-GROUP" ? [] : step.values.filter((item) => item.source !== "申请页面字段" && item.value != null && String(item.value).trim() && String(item.value) !== "[object Object]");
  const images = new Map((pageData?.images ?? []).filter((image) => image.imageId).map((image) => [image.imageId as string, image]));
  const effectiveStatus = policy?.result_status && policy.result_status !== "MATCH" ? policy.result_status : step.result_status;
  const requiresAction = step.requires_reviewer_action || Boolean(policy?.requires_reviewer_action);
  return <article className="workbench-card"><div className="workbench-card-title"><div><small>{step.category === "FIELD" ? "页面字段" : "页面外核验"}</small><h2>{stepTitle(step)}</h2></div><b className={`status-${effectiveStatus.toLowerCase()}`}>{statusText[effectiveStatus]}</b></div>{field ? <div className="page-value"><span>页面原始值</span><strong>{cleanPageValue(pageValue) || "未采集"}</strong></div> : null}{values.length ? <div className="candidate-list"><span className="evidence-section-title">材料提取值</span>{values.map((item, index) => { const image = (item.image_id ? images.get(item.image_id) : undefined) || (pageData?.images ?? []).find((candidate) => item.image_index != null && candidate.index === item.image_index); return <div className="candidate" key={`${item.source}-${index}`}><div><strong>{renderDiff(field, pageValue, item.value)}</strong><small>{String(item.source || "").replace(/图片识别/g, "").replace(/\s*·\s*$/, "")}</small>{image ? <div className="candidate-evidence"><img src={image.dataUrl || image.src} alt="材料" />{image.imageId ? <button type="button" onClick={() => void onFocusImage(image.imageId as string)}>查看原图</button> : null}</div> : null}</div>{field && String(item.value) !== String(pageValue ?? "") ? <button className="fill-value-button" type="button" disabled={disabled} onClick={() => void onFill(step, String(item.value))}>回填此值</button> : null}</div>; })}</div> : null}<p className="workbench-reason">{step.reason}</p>{field ? <ManualValueInput key={`${pageData?.collectionId}-${field}`} initialValue={cleanPageValue(pageValue)} label={stepTitle(step)} disabled={disabled || !pageData} onFill={(value) => onFill(step, value)} /> : null}{step.step_id === "MATERIAL-GROUP" ? <MaterialChecklist report={materialReport} pageData={pageData} onFocusImage={onFocusImage} /> : null}{step.step_id === "BUSINESS-AFFILIATION-SUBJECT-001" ? <SubjectRequirements requirements={step.details?.subject_requirements || []} pageData={pageData} onFocusImage={onFocusImage} /> : null}{policy ? <div className={`policy-result status-${policy.result_status.toLowerCase()}`}><b>地区政策核验</b><span>{policy.reason}</span></div> : null}{step.step_id === "QR-GROUP" ? qrChecks.map((check, index) => <QrUrl check={check} key={`${check.image_index}-${index}`} />) : null}<StructuredEvidence evidence={step.evidence} />{step.step_id === "BUSINESS-AFFILIATION-SUBJECT-001" && (step.details?.affiliation_subject_status === "MATCH" || step.result_status === "MATCH") && affiliationActions.length === 2 ? <button type="button" className="affiliation-fill-action" disabled={affiliationFilled || disabled} onClick={() => void onFillAffiliation()}>{affiliationFilled ? "挂靠字段已填写" : "自动填写挂靠字段"}</button> : null}{requiresAction ? <div className="workbench-actions"><button type="button" disabled={disabled} className="secondary-action" onClick={() => onChoose(step, "MARKED_EXCEPTION")}>标记人工复核</button></div> : null}</article>;
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

function cleanPageValue(value: unknown) { return String(value ?? "").replace(/(?:易混淆|不一致|一致)$/g, "").trim(); }
function renderDiff(_field: string | null, page: unknown, value: unknown) { const left = cleanPageValue(page); const right = cleanPageValue(value); if (!left) return right; return [...right].map((char, i) => left[i] === char ? <span key={i}>{char}</span> : <mark className="value-diff" key={i}>{char}</mark>); }
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

function MaterialChecklist({ report, pageData, onFocusImage }: { report?: import("../types/review").MaterialCompletenessReport | null; pageData?: PageData | null; onFocusImage: (id: string) => Promise<void> }) {
  const images = pageData?.images || [];
  const imageById = new Map(images.map((image) => [image.imageId, image]));
  const details = (report?.issues || []).flatMap((issue) => issue.field_details || []);
  return <>
    {details.length ? <section className="material-field-issues" aria-label="识别异常字段">
      <strong>需要核对的字段</strong>
      {details.map((detail, index) => {
        const image = (detail.image_id ? imageById.get(detail.image_id) : undefined)
          || images.find((item) => detail.image_index != null && item.index === detail.image_index);
        const value = detail.value == null || detail.value === "" ? "未识别到有效值"
          : typeof detail.value === "object" ? JSON.stringify(detail.value) : String(detail.value);
        return <div className="material-field-issue" key={`${detail.image_id}-${detail.field}-${index}`}>
          <strong>{detail.material_name} · {detail.field_label}</strong>
          <span>识别值：<b>{value}</b></span>
          <small>识别结果不确定，请对照原图核对</small>
          {image ? <div className="candidate-evidence">
            <img src={image.dataUrl || image.src} alt={`${detail.material_name}原图`} />
            {image.imageId ? <button type="button" onClick={() => void onFocusImage(image.imageId as string)}>查看原图</button> : null}
          </div> : <small>本次采集未取得对应图片，请重新采集后查看</small>}
        </div>;
      })}
    </section> : null}
    <div className="material-checklist">{(report?.checklist || []).map((item) =>
      <div className="material-checklist-row" key={item.key}>
        <span>{item.display_name}</span>
        <b>{item.status === "PRESENT" ? "材料已提供" : item.status === "MISSING" ? "缺失" : "待确认"}</b>
        {item.image_ids?.length ? <div className="evidence-actions">{item.image_ids.map((id) =>
          <div className="evidence-image" key={id}>
            {imageById.get(id)?.src ? <img src={imageById.get(id)?.dataUrl || imageById.get(id)?.src} alt="材料" /> : null}
            <button type="button" onClick={() => void onFocusImage(id)}>查看原图</button>
          </div>)}</div> : null}
      </div>)}</div>
  </>;
}

function SubjectRequirements({ requirements, pageData, onFocusImage }: { requirements: any[]; pageData?: PageData | null; onFocusImage: (id: string) => Promise<void> }) { if (!requirements.length) return null; const images = new Map((pageData?.images || []).map((image) => [image.imageId, image])); return <div className="subject-requirements">{requirements.map((item, index) => <div className="subject-requirement" key={`${item.party}-${item.document}-${index}`}><div><strong>{item.subject_name} · {subjectDocumentLabel(item.document)}</strong><small>{item.reason}</small></div><b>{item.status === "PRESENT" ? "已核验" : item.status === "MISSING" ? "缺失" : "待确认"}</b>{item.image_ids?.length ? <div className="evidence-actions">{item.image_ids.map((id: string) => <div className="evidence-image" key={id}>{images.get(id)?.src ? <img src={images.get(id)?.dataUrl || images.get(id)?.src} alt="材料" /> : null}<button type="button" onClick={() => void onFocusImage(id)}>{images.get(id)?.alt || "查看原图"}</button></div>)}</div> : null}</div>)}</div>; }function subjectDocumentLabel(document: string) { return ({ identity_card_front: "身份证正面", identity_card_back: "身份证反面", business_license: "营业执照" } as Record<string,string>)[document] || document; }function StructuredEvidence({ evidence }: { evidence: Evidence[] }) { const rows = evidence.flatMap((item) => item.value && typeof item.value === "object" && !Array.isArray(item.value) ? Object.entries(item.value as Record<string, unknown>).filter(([, value]) => value != null && value !== "").map(([key, value]) => ({ source: item.source, key, value: String(value) })) : item.field?.startsWith("business_license.") && item.value != null && item.value !== "" ? [{ source: item.source, key: item.field, value: String(item.value) }] : []); return rows.length ? <dl className="structured-evidence">{rows.map((row, index) => <div key={`${row.source}-${row.key}-${index}`}><dt>{row.source} · {structuredFieldLabel(row.key)}</dt><dd>{row.value}</dd></div>)}</dl> : null; }
function structuredFieldLabel(field: string) { return ({ company_name: "企业名称", "business_license.company_name": "企业名称", legal_representative: "法定代表人", "business_license.legal_representative": "法定代表人", unified_social_credit_code: "统一社会信用代码", "business_license.unified_social_credit_code": "统一社会信用代码", vin: "车架号", certificate_no: "证明编号" } as Record<string, string>)[field] ?? field; }

function EvidenceActions({ evidence, pageData, onFocusImage }: { evidence: Evidence[]; pageData?: PageData | null; onFocusImage: (id: string) => Promise<void> }) { const ids = [...new Set(evidence.map((item) => item.image_id).filter((item): item is string => Boolean(item)))]; const images = new Map((pageData?.images ?? []).filter((image) => image.imageId).map((image) => [image.imageId as string, image])); return ids.length ? <div className="evidence-actions">{ids.map((id) => <div className="evidence-image" key={id}>{images.get(id)?.src ? <img src={images.get(id)?.dataUrl || images.get(id)?.src} alt={images.get(id)?.alt || "审核资料证据"} /> : null}<button type="button" onClick={() => void onFocusImage(id)}>查看原图</button></div>)}</div> : null; }
