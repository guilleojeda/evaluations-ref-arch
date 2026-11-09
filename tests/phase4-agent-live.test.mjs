import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

// Read-only checkpoints of the genuine hosted journey. Never creates alarms,
// starts investigations, changes settings, or spends application allowance.
const ALARM = 'arn:aws:cloudwatch:us-east-1:027224425948:alarm:IncidentTriageDemoAppStage5xx';
const MODEL = 'us.anthropic.claude-sonnet-4-6';
const SHA = /^[0-9a-f]{40}$/i;
const DIGEST = /^[0-9a-f]{64}$/i;
const ACTIONS = ['Increase reserved concurrency', 'Increase memory', 'Restore inventory access', 'Other'];

function required(name) {
  const value = process.env[name];
  assert.ok(value && !/\s/.test(value), `${name} must come from private credentials or retained native evidence`);
  return value;
}

function timestamp(value, label) {
  assert.ok(typeof value === 'string' && Number.isFinite(Date.parse(value)), `${label} must be a timestamp`);
  return Date.parse(value);
}

function nonempty(value, label) {
  assert.ok(typeof value === 'string' && value.length > 0, `${label} must be retained`);
}

function controllerOrigin() {
  const url = new URL(required('PHASE4_CONTROLLER_URL'));
  assert.equal(url.protocol, 'https:');
  assert.match(url.hostname, /^[a-z0-9]+\.execute-api\.us-east-1\.amazonaws\.com$/);
  assert.ok(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash);
  return url.origin;
}

function reportContract(report) {
  assert.ok(report && ['ongoing', 'recovered', 'unknown'].includes(report.assessment));
  nonempty(report.summary, 'report summary');
  assert.ok(ACTIONS.includes(report.recommendation?.action), 'one documented recommendation is required');
  assert.ok(Array.isArray(report.evidence) && report.evidence.length > 0, 'material source citations are required');
  for (const citation of report.evidence) {
    for (const field of ['source', 'resource', 'finding']) nonempty(citation[field], `citation ${field}`);
    const start = timestamp(citation.windowStart, 'citation windowStart');
    const end = timestamp(citation.windowEnd, 'citation windowEnd');
    assert.ok(start <= end, 'source window must be ordered');
    timestamp(citation.observedAt, 'citation observedAt');
  }
  assert.ok(Array.isArray(report.uncertainties), 'uncertainties must be explicit');
  assert.ok(Array.isArray(report.alternatives), 'alternatives must be explicit');
}

function reportHash(report) {
  const ordered = (value) => Array.isArray(value) ? value.map(ordered) :
    value && typeof value === 'object' ? Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, ordered(value[key])]),
    ) : value;
  return createHash('sha256').update(JSON.stringify(ordered(report))).digest('hex');
}

test('genuine alarm investigations remain discoverable through the deployed controller', {
  skip: process.env.PHASE4_LIVE !== '1' && 'Requires explicit native event/run evidence and controller credentials',
  timeout: 60_000,
}, async (t) => {
  const step = required('PHASE4_LIVE_STEP');
  assert.ok(['reported', 'interrupted', 'recovered'].includes(step));
  const origin = controllerOrigin();
  const bearer = required('PHASE4_CONTROLLER_BEARER');
  const sourceRevision = required('PHASE4_EXPECTED_AGENT_SHA');
  assert.match(sourceRevision, SHA);
  const transitionAt = required('PHASE4_TRANSITION_AT');
  timestamp(transitionAt, 'originating transition');
  assert.equal(new Date(transitionAt).toISOString(), transitionAt, 'supply normalized native transition time');
  const runId = required('PHASE4_RUN_ID');
  const runtimeSessionId = required('PHASE4_RUNTIME_SESSION_ID');
  const candidateId = required('PHASE4_CANDIDATE_ID');
  const promptSha256 = required('PHASE4_PROMPT_SHA256');
  assert.match(promptSha256, DIGEST);
  const privateValues = [bearer, createHash('sha256').update(bearer).digest('hex')];

  async function get(path, expectedStatus = 200, authenticated = true) {
    let response;
    try {
      response = await fetch(new URL(path, origin), {
        headers: { accept: 'application/json', ...(authenticated ? { authorization: `Bearer ${bearer}` } : {}) },
        redirect: 'error', signal: AbortSignal.timeout(8_000),
      });
    } catch {
      assert.fail(`GET ${path} could not complete`);
    }
    assert.equal(response.status, expectedStatus, `GET ${path} returned an unexpected status`);
    assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/i);
    const raw = await response.text();
    assert.ok(privateValues.every((value) => !raw.includes(value)), 'controller must not expose operator credentials');
    try {
      return JSON.parse(raw);
    } catch {
      assert.fail(`GET ${path} must return JSON`);
    }
  }

  await get('/api/investigations', 401, false);
  const query = `?transitionAt=${encodeURIComponent(transitionAt)}`;
  const exact = await get(`/api/investigations${query}`);
  timestamp(exact.observedAt, 'discovery observation');
  assert.ok(Array.isArray(exact.runs));
  assert.equal(exact.runs.length, 1, 'exact discovery must return only the originating event');
  const run = exact.runs[0];
  assert.equal(run.alarmArn, ALARM);
  assert.equal(run.transitionAt, transitionAt);
  assert.equal(run.runId, runId);
  assert.equal(run.runtimeSessionId, runtimeSessionId);
  assert.equal(run.candidateId, candidateId);
  assert.equal(run.sourceRevision, sourceRevision);
  assert.equal(run.promptSha256, promptSha256);
  assert.equal(run.modelId, MODEL);
  assert.match(run.runtimeArn ?? '', /^arn:aws:bedrock-agentcore:us-east-1:027224425948:runtime\//);
  assert.match(String(run.runtimeVersion ?? ''), /^[1-9]\d*$/);
  nonempty(run.endpointName, 'pinned endpoint name');
  const started = timestamp(run.startedAt, 'run start');
  const deadline = timestamp(run.deadlineAt, 'run deadline');
  assert.ok(started >= Date.parse(transitionAt) && deadline > started);
  // Native spans and S3 source coverage are independently inspected on AWS;
  // references alone cannot establish that actual telemetry was captured.

  const recent = await get('/api/investigations');
  assert.ok(Array.isArray(recent.runs));
  const matches = recent.runs.filter((item) => item.alarmArn === ALARM && item.transitionAt === transitionAt);
  assert.equal(matches.length, 1, 'recent discovery must contain one matching investigation');
  assert.equal(matches[0].runId, runId);
  const reconnected = await get(`/api/investigations${query}`);
  assert.equal(reconnected.runs?.length, 1);
  assert.equal(reconnected.runs[0].runId, runId);
  assert.equal(reconnected.runs[0].runtimeSessionId, runtimeSessionId);

  if (step === 'interrupted') {
    assert.equal(run.status, 'running', 'a stranded claim remains running and is displayed as overdue');
    assert.ok(Date.parse(exact.observedAt) > deadline, 'verify after the bounded deadline');
    assert.ok(run.report == null, 'process loss must not become a completed unknown report');
    assert.ok(run.finishedAt == null, 'do not invent a terminal result after process loss');
    assert.ok(reconnected.runs[0].report == null);
  } else {
    assert.equal(run.status, 'complete');
    assert.ok(timestamp(run.finishedAt, 'completion time') >= started);
    reportContract(run.report);
    assert.deepEqual(reconnected.runs[0].report, run.report, 'reconnection must preserve the actual report');
    assert.ok(run.traceRef && typeof run.traceRef === 'object', 'retain native trace/session selectors');
    assert.ok(run.captureRef && typeof run.captureRef === 'object', 'retain the independent source manifest reference');
    assert.equal(run.report.recommendation.action, 'Increase memory', 'the genuine initial candidate must exhibit the planned defect');
    assert.equal(run.report.recommendation.target, 'inventory');
    assert.equal(run.report.recommendation.unit, 'MB');
    const observedMemory = Number(required('PHASE4_OBSERVED_INVENTORY_MEMORY_MB'));
    assert.ok(Number.isInteger(observedMemory) && observedMemory >= 128);
    assert.ok(Number.isInteger(run.report.recommendation.value) && run.report.recommendation.value > observedMemory &&
      run.report.recommendation.value <= 10_240, 'memory proposal must be a supported larger allocation');
    if (step === 'recovered') {
      const expectedHash = required('PHASE4_EXPECTED_REPORT_SHA256');
      assert.match(expectedHash, DIGEST);
      assert.equal(reportHash(run.report), expectedHash, 'recovery must retain the original report');
      const alarm = await get('/api/alarm');
      assert.equal(alarm.alarm?.state, 'OK');
    }
  }
  t.diagnostic(`Verified ${step}: originating event, durable run/session, candidate/profile and reconnect`);
  if (run.report) t.diagnostic(`Retain PHASE4_EXPECTED_REPORT_SHA256=${reportHash(run.report)} for the recovered checkpoint`);
});
