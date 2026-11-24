import type {
  InvestigationAssessment,
  InvestigationCitation,
  InvestigationRecommendation,
  InvestigationRun,
  JsonValue,
} from "./types";
import { uiText } from "./ui-text";
import "./report.css";

export interface InvestigationRecordProps {
  run: InvestigationRun;
  /** Set when the controller is showing its last run-table observation. */
  stale?: boolean;
  /** Optional run-table observation time for callers that have it available. */
  observedAt?: string;
}

function formatTime(value: unknown): string {
  if (typeof value !== "string") return "Not recorded";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
}

function prose(value: unknown, fallback = "Not recorded"): string {
  return typeof value === "string" && value.trim() ? uiText(value) : fallback;
}

function exactJson(value: JsonValue | undefined, fallback = "Not recorded"): string {
  if (value === undefined) return fallback;
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function assessmentLabel(assessment: InvestigationAssessment): string {
  if (assessment === "ongoing") return "Ongoing";
  if (assessment === "recovered") return "Recovered";
  return "Unknown";
}

function targetLabel(target: string): string {
  if (target === "checkout") return "Checkout";
  if (target === "inventory") return "Inventory";
  return uiText(target);
}

function isPastDeadline(run: InvestigationRun): boolean {
  const deadline = Date.parse(run.deadlineAt);
  return run.status === "running" && Number.isFinite(deadline) && deadline <= Date.now();
}

type RecordTone = "running" | "overdue" | "failed" | "outdated" | "complete";

function recordTone(run: InvestigationRun, stale: boolean): RecordTone {
  if (run.status === "failed") return "failed";
  if (stale) return "outdated";
  if (isPastDeadline(run)) return "overdue";
  if (run.status === "running") return "running";
  return "complete";
}

function stateLabel(run: InvestigationRun, stale: boolean): string {
  if (run.status === "failed") return "Failed";
  if (stale) return "Outdated";
  if (isPastDeadline(run)) return "Overdue";
  if (run.status === "running") return "Running";
  return run.report ? `Complete: ${assessmentLabel(run.report.assessment)}` : "Complete";
}

function traceUrl(run: InvestigationRun): string | undefined {
  const traceId = run.traceRef?.traceId;
  const region = run.traceRef?.region;
  if (typeof traceId !== "string" || typeof region !== "string" || !/^[a-z0-9-]{3,32}$/.test(region)) return undefined;
  const normalizedTraceId = /^[a-f0-9]{32}$/i.test(traceId)
    ? `1-${traceId.slice(0, 8)}-${traceId.slice(8)}`
    : /^1-[a-f0-9]{8}-[a-f0-9]{24}$/i.test(traceId) ? traceId : undefined;
  if (!normalizedTraceId) return undefined;
  return `https://console.aws.amazon.com/xray/home?region=${encodeURIComponent(region)}#/traces/${encodeURIComponent(normalizedTraceId)}`;
}

function recommendationDetail(recommendation: InvestigationRecommendation): string | undefined {
  if (recommendation.action === "Other") {
    return typeof recommendation.value === "string" && recommendation.value.trim()
      ? prose(recommendation.value)
      : recommendation.explanation ? prose(recommendation.explanation) : undefined;
  }
  const target = typeof recommendation.target === "string" && recommendation.target.trim()
    ? targetLabel(recommendation.target)
    : undefined;
  const value = recommendation.value !== undefined && recommendation.value !== null && recommendation.value !== ""
    ? typeof recommendation.value === "string" ? uiText(recommendation.value) : String(recommendation.value)
    : undefined;
  const unit = typeof recommendation.unit === "string" && recommendation.unit.trim() ? uiText(recommendation.unit) : undefined;
  const valueWithUnit = [value, unit].filter(Boolean).join(" ");
  if (target && valueWithUnit) return `${target}: ${valueWithUnit}`;
  return target ?? valueWithUnit;
}

function RecommendationBlock({ recommendation, compact = false }: { recommendation: InvestigationRecommendation; compact?: boolean }) {
  const detail = recommendationDetail(recommendation);
  return <section className={`ir-recommendation${compact ? " ir-recommendation-compact" : ""}`} aria-label="Agent recommendation">
    <p className="ir-section-label">Recommendation</p>
    <strong className="ir-recommendation-action">{prose(recommendation.action)}</strong>
    {detail && <p className="ir-recommendation-detail">{detail}</p>}
    {!compact && recommendation.explanation && <p className="ir-prose">{prose(recommendation.explanation)}</p>}
    {!compact && recommendation.policy && <p className="ir-prose"><strong>Policy:</strong> {prose(recommendation.policy)}</p>}
    {!compact && recommendation.policyDetail && <p className="ir-prose"><strong>Policy detail:</strong> {prose(recommendation.policyDetail)}</p>}
  </section>;
}

function EvidenceItem({ citation }: { citation: InvestigationCitation }) {
  return <li className="ir-evidence-item">
    <div className="ir-evidence-source">
      <strong>{citation.source}</strong>
      <span className="ir-mono">{citation.resource}</span>
    </div>
    <p className="ir-prose">{prose(citation.finding)}</p>
    <small>Window {formatTime(citation.windowStart)} to {formatTime(citation.windowEnd)}; observed {formatTime(citation.observedAt)}</small>
  </li>;
}

function CaveatList({ title, values }: { title: string; values: string[] }) {
  if (values.length === 0) return null;
  return <section className="ir-caveat-group" aria-label={title}>
    <h5>{title}</h5>
    <ul>{values.map((value, index) => <li key={`${title}-${index}`}>{prose(value)}</li>)}</ul>
  </section>;
}

function TechnicalDetails({ run, observedAt }: { run: InvestigationRun; observedAt?: string }) {
  const trace = run.traceRef;
  const capture = run.captureRef;
  const traceEntries = trace ? Object.entries(trace) : [];
  return <section className="ir-technical" aria-label="Technical details">
    <h5>Technical details</h5>
    <dl className="ir-facts">
      <div><dt>Run ID</dt><dd className="ir-mono">{run.runId}</dd></div>
      <div><dt>Runtime session</dt><dd className="ir-mono">{run.runtimeSessionId}</dd></div>
      <div><dt>Candidate</dt><dd className="ir-mono">{run.candidateId}</dd></div>
      <div><dt>Source revision</dt><dd className="ir-mono">{run.sourceRevision}</dd></div>
      {run.artifactSha256 && <div><dt>Runtime artifact SHA-256</dt><dd className="ir-mono">{run.artifactSha256}</dd></div>}
      <div><dt>Prompt SHA-256</dt><dd className="ir-mono">{run.promptSha256}</dd></div>
      <div><dt>Model</dt><dd className="ir-mono">{run.modelId}</dd></div>
      <div><dt>Runtime version</dt><dd className="ir-mono">{run.runtimeVersion}</dd></div>
      <div><dt>Endpoint</dt><dd className="ir-mono">{run.endpointName}</dd></div>
      <div><dt>Runtime ARN</dt><dd className="ir-mono">{run.runtimeArn}</dd></div>
      <div><dt>Started</dt><dd>{formatTime(run.startedAt)}</dd></div>
      <div><dt>Deadline</dt><dd>{formatTime(run.deadlineAt)}</dd></div>
      {run.finishedAt && <div><dt>Finished</dt><dd>{formatTime(run.finishedAt)}</dd></div>}
      {observedAt && <div><dt>Run-table observed</dt><dd>{formatTime(observedAt)}</dd></div>}
    </dl>
    {trace && <div className="ir-trace">
      <h5>Trace reference</h5>
      {traceEntries.map(([key, value]) => <div className="ir-trace-row" key={key}><span>{key}</span><span className="ir-mono">{exactJson(value)}</span></div>)}
    </div>}
    {capture && <CaptureDetails capture={capture} />}
  </section>;
}

function CaptureDetails({ capture }: { capture: Record<string, JsonValue> }) {
  const gaps = Array.isArray(capture.gaps) ? capture.gaps.filter((gap): gap is string => typeof gap === "string") : [];
  const captureObservedAt = capture.capturedAt ?? capture.observedAt;
  return <section className="ir-capture">
    <h5>Source capture and coverage</h5>
    <dl className="ir-facts">
      <div><dt>Private source location</dt><dd className="ir-mono">{exactJson(capture.bucket)} / {exactJson(capture.prefix)}</dd></div>
      <div><dt>Baseline or manifest</dt><dd className="ir-mono">{exactJson(capture.manifestKey ?? capture.baselineKey ?? capture.key)}</dd></div>
      <div><dt>Query results</dt><dd className="ir-mono">{exactJson(capture.queryResultsKey)}</dd></div>
      <div><dt>Capture completeness</dt><dd>{exactJson(capture.completeness)}; observed {typeof captureObservedAt === "string" ? formatTime(captureObservedAt) : "Not recorded"}</dd></div>
      <div><dt>Coverage</dt><dd>{exactJson(capture.coveredFrom, "Start not recorded")} to {exactJson(capture.coveredThrough, "End not recorded")}</dd></div>
    </dl>
    {gaps.length > 0 && <ul className="ir-gaps">{gaps.map((gap, index) => <li key={index}>{prose(gap)}</li>)}</ul>}
  </section>;
}

function FullReport({ run, observedAt }: { run: InvestigationRun; observedAt?: string }) {
  return <details className="ir-full-report">
    <summary>{run.report ? "View full report" : "View run details"}</summary>
    {run.failure && <section className="ir-full-failure">
      <h5>Failure</h5>
      <p><strong>{run.failure.code}</strong></p>
      <p className="ir-prose">{prose(run.failure.message)}</p>
    </section>}
    {run.report && <section className="ir-full-report-body" aria-label="Full investigation report">
      <p className="ir-summary">{prose(run.report.summary)}</p>
      <RecommendationBlock recommendation={run.report.recommendation} />
      <section className="ir-evidence" aria-label="Source evidence">
        <h5>Evidence</h5>
        <ol>{run.report.evidence.map((citation, index) => <EvidenceItem key={`${citation.source}-${citation.resource}-${index}`} citation={citation} />)}</ol>
      </section>
      <div className="ir-caveats">
        <CaveatList title="Uncertainties" values={run.report.uncertainties} />
        <CaveatList title="Alternatives" values={run.report.alternatives} />
      </div>
    </section>}
    <TechnicalDetails run={run} observedAt={observedAt} />
  </details>;
}

export function InvestigationRecord({ run, stale = false, observedAt }: InvestigationRecordProps) {
  const tone = recordTone(run, stale);
  const trace = traceUrl(run);
  return <article className={`investigation-report-record ir-${tone}`} aria-label="Investigation record">
    <header className="ir-header">
      <div className="ir-header-copy">
        <h4 aria-live="polite">{stateLabel(run, stale)}</h4>
        <p className="ir-transition">Alarm transition {formatTime(run.transitionAt)}</p>
      </div>
      {run.failure && <span className="ir-failure-code">{run.failure.code}</span>}
    </header>

    {run.status === "complete" && !stale && run.report?.recommendation && <RecommendationBlock recommendation={run.report.recommendation} compact />}
    {trace && <p className="ir-trace-link"><a href={trace} target="_blank" rel="noreferrer">Open native CloudWatch trace</a></p>}
    <FullReport run={run} observedAt={observedAt} />
  </article>;
}

