/**
 * 功能：组合 Side Panel 页面并管理业务与异常筛选。
 * 职责边界：不管理任务轮询，不实现后端审核规则；
 * 报废置换字段审核由结果工作台在侧边栏内管理。
 * 修改日期：2026-09-11
 * 修改人：wuyi
 */

import { useState } from "react";

import "./App.css";
import forjLogo from "./assets/forj-logo.png";
import { ReviewProgress } from "./components/ReviewProgress";
import { ReviewResults } from "./components/ReviewResults";
import type { ExceptionFilter } from "./exceptionPresentation";
import { useReviewWorkflow } from "./hooks/useReviewWorkflow";
import { businessLabels, type BusinessChoice } from "./reviewPanelConfig";

function App() {
  const [businessSelection, setBusinessSelection] = useState<BusinessChoice>("AUTO");
  const [exceptionFilter, setExceptionFilter] = useState<ExceptionFilter>("ALL");
  const workflow = useReviewWorkflow(businessSelection);

  const changeBusinessSelection = (selection: BusinessChoice) => {
    workflow.reset();
    setBusinessSelection(selection);
  };

  return (
    <main className="review-panel">
      <header>
        <div className="brand-header">
          <img className="brand-logo" src={forjLogo} alt="赋界科技" />
          <div className="brand-copy">
            <h1>车辆智能审核</h1>
            <p>识别资料差异，辅助人工复核</p>
          </div>
        </div>
      </header>

      <section className="business-control" aria-label="审核业务选择">
        <label htmlFor="business-selection">审核业务</label>
        <select
          id="business-selection"
          value={businessSelection}
          onChange={(event) => changeBusinessSelection(event.target.value as BusinessChoice)}
          disabled={workflow.loading}
        >
          {Object.entries(businessLabels).map(([value, label]) => (
            <option value={value} key={value}>{label}</option>
          ))}
        </select>
        {workflow.pageData?.businessType ? (
          <small>
            当前：{workflow.pageData.businessType === "scrap_replacement"
              ? `${workflow.pageData.region === "changchun" ? "长春" : "青岛"}报废置换审核`
              : workflow.pageData.businessType === "consistency"
                ? `${workflow.pageData.region === "changchun" ? "长春" : "青岛"}一致性审核`
                : businessLabels[workflow.pageData.businessType]} ·{" "}
            {workflow.pageData.selectionMode === "MANUAL" ? "人工选择" : "自动识别"}
          </small>
        ) : null}
      </section>

      <button
        onClick={workflow.startReview}
        disabled={workflow.loading || !workflow.pageData?.businessType}
      >
        {workflow.loading ? "正在识别并核验……" : "开始审核检查"}
      </button>

      {workflow.error ? <div className="error-message">{workflow.error}</div> : null}
      {workflow.notice ? <div className="notice-message">{workflow.notice}</div> : null}
      {workflow.job ? <ReviewProgress job={workflow.job} /> : null}
      {workflow.review ? (
        <ReviewResults
          review={workflow.review}
          job={workflow.job}
          pageData={workflow.pageData}
          exceptionFilter={exceptionFilter}
          onExceptionFilterChange={setExceptionFilter}
          onFocusImage={workflow.focusOriginalImage}
          onApplyPageFieldValue={workflow.applyPageFieldValue}
          onApplyAffiliationFill={workflow.applyAffiliationFill}
          onRerun={workflow.startReview}
          pageFillResult={workflow.pageFillResult}
        />
      ) : null}

      <footer>所有审核结果仅供人工参考，不会自动提交审核决定</footer>
    </main>
  );
}

export default App;
