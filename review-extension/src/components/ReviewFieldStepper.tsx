import { useMemo, useState } from "react";

import {
  acknowledgeStep,
  createReviewStepState,
  nextReviewStep,
  previousReviewStep,
  reviewStepDecisionLabel,
  reviewStepStatusLabel,
  reviewStepTitle,
  isAffiliationRelationshipStep,
  sortedReviewSteps,
} from "../reviewSteps";
import { fieldLabel } from "../reviewPanelConfig";
import type { Evidence, ReviewStep } from "../types/review";
import { AffiliationReview } from "./AffiliationReview";

function valueText(value: unknown): string {
  if (value == null || value === "") return "未取得";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function evidenceText(evidence: Evidence): string {
  const parts = [evidence.source, evidence.detail, valueText(evidence.value)]
    .filter((item) => item && item !== "未取得");
  return parts.join(" · ") || "后端未返回可展示的证据内容";
}

function documentTypeLabel(documentType?: string | null): string {
  return {
    business_license: "营业执照",
    id_card: "身份证",
    registration_certificate: "机动车登记证书",
    scrap_certificate: "报废证明",
    vehicle_license: "机动车行驶证",
    invoice: "发票",
  }[documentType || ""] || documentType || "未标注文档类型";
}

function categoryLabel(category: ReviewStep["category"]): string {
  return { FIELD: "字段核验", EXTERNAL: "外部核验", BUSINESS_RULE: "业务规则", MATERIAL: "材料完整性" }[category];
}

export function ReviewFieldStepper({ reviewSteps, onFocusImage }: { reviewSteps?: ReviewStep[]; onFocusImage: (imageId: string) => Promise<void> }) {
  const steps = useMemo(() => sortedReviewSteps(reviewSteps), [reviewSteps]);
  const [state, setState] = useState(() => createReviewStepState(steps));

  if (!steps.length) {
    return <section className="result-card review-stepper"><h2>逐项审核</h2><p className="muted">当前审核未返回可展示的检查步骤。</p></section>;
  }

  if (state.index >= steps.length) {
    const handled = Object.keys(state.decisions).length;
    return (
      <section className="result-card review-stepper review-step-summary">
        <h2>逐项审核汇总</h2>
        <p>已查看 {steps.length} 项，其中 {handled} 项已记录人工处理方式。</p>
        <button className="stepper-secondary" type="button" onClick={() => setState(previousReviewStep(state))}>上一步</button>
      </section>
    );
  }

  const step = steps[state.index];
  const decision = state.decisions[step.step_id];
  const requiresDecision = step.result_status !== "MATCH";
  const continueStep = () => setState((current) => nextReviewStep(current, steps.length));
  const decide = (choice: "ACKNOWLEDGED" | "MANUAL_REVIEW") => {
    setState((current) => nextReviewStep(acknowledgeStep(current, step.step_id, choice), steps.length));
  };

  return (
    <section className={`result-card review-stepper review-step-${step.result_status.toLowerCase()}`} aria-label="逐项审核">
      <div className="stepper-heading">
        <div><h2>逐项审核</h2><small>第 {state.index + 1} / 共 {steps.length} 项</small></div>
        <strong>{reviewStepStatusLabel(step.result_status)}</strong>
      </div>
      <p className="stepper-category">{categoryLabel(step.category)} · 后端状态：{step.result_status}</p>
      <h3 className="stepper-title">{reviewStepTitle(step)}</h3>
      <p className="stepper-reason">{step.reason || "后端未返回原因说明"}</p>
      {isAffiliationRelationshipStep(step) ? <AffiliationReview step={step} /> : null}
      <StepValues values={step.values} />
      <StepEvidence evidence={step.evidence} onFocusImage={onFocusImage} />
      {decision ? <p className="stepper-decision">本次查看：{reviewStepDecisionLabel(decision)}</p> : null}
      <div className="stepper-actions">
        <button className="stepper-secondary" type="button" disabled={state.index === 0} onClick={() => setState(previousReviewStep(state))}>上一步</button>
        {requiresDecision ? (
          <div className="stepper-decision-actions">
            <button type="button" onClick={() => decide("ACKNOWLEDGED")}>已知悉，继续</button>
            <button className="stepper-manual" type="button" onClick={() => decide("MANUAL_REVIEW")}>标记人工复核</button>
          </div>
        ) : <button type="button" onClick={continueStep}>{state.index + 1 === steps.length ? "查看汇总" : "下一项"}</button>}
      </div>
    </section>
  );
}

function StepValues({ values }: { values: ReviewStep["values"] }) {
  if (!values.length) return <p className="stepper-empty">后端未返回参与核验的原始值。</p>;
  return <dl className="stepper-values">{values.map((item, index) => <div key={`${item.source}-${index}`}><dt>{item.source}</dt><dd>{valueText(item.value)}</dd></div>)}</dl>;
}

function StepEvidence({ evidence, onFocusImage }: { evidence: Evidence[]; onFocusImage: (imageId: string) => Promise<void> }) {
  if (!evidence.length) return <p className="stepper-empty">后端未返回原始证据。</p>;
  return (
    <section className="stepper-evidence">
      <h3>原始证据</h3>
      <ul>{evidence.map((item, index) => (
        <li key={`${item.source}-${index}`}>
          <p>{evidenceText(item)}</p>
          {item.uncertain ? <strong>识别不确定，待人工确认</strong> : null}
          <div className="stepper-evidence-meta">
            {item.document_type ? <span>文档类型：{documentTypeLabel(item.document_type)}</span> : null}
            {item.field ? <span>字段：{fieldLabel(item.field)}</span> : null}
            {item.source_id ? <span>来源标识：{item.source_id}</span> : null}
            {item.image_id ? <span>原图标识：{item.image_id}</span> : null}
          </div>
          {item.image_id ? <button className="evidence-focus" type="button" onClick={() => { if (item.image_id) void onFocusImage(item.image_id); }}>查看原图</button> : null}
        </li>
      ))}</ul>
    </section>
  );
}
