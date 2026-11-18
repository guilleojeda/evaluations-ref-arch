import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TalkPublicationVerificationError,
  buildSessionBinding,
  parsePointer,
  selectApproval,
  selectQualificationKey,
  validateReviewLocator,
} from '../scripts/verify-talk-publication.ts';

const sourceRevision = 'a'.repeat(40);
const artifactSha256 = 'b'.repeat(64);
const configurationSha256 = 'c'.repeat(64);
const sourceSha256 = 'd'.repeat(64);
const promptSha256 = 'e'.repeat(64);
const manifestSha256 = 'f'.repeat(64);
const suiteSha256 = '1'.repeat(64);
const evaluatorSha256 = '2'.repeat(64);
const reportSha256 = '3'.repeat(64);
const caseId = 'phase14.denied-inventory-read.prepared';

function pointer({ suite = suiteSha256, evaluator = evaluatorSha256, cases = [caseId] } = {}) {
  return parsePointer({
    schemaVersion: 1,
    purpose: 'Phase 20 reviewed private evaluation input handoff',
    bucket: 'incident-triage-demo-evidence-027224425948-us-east-1',
    s3Key: `agent-evaluation/phase18/inputs/${'4'.repeat(64)}/staging.tar.gz`,
    sha256: '4'.repeat(64),
    suiteSha256: suite,
    evaluatorSha256: evaluator,
    caseIds: cases,
  });
}

function makeFixture() {
  const publication = {
    candidateId: 'repaired',
    endpointName: 'repaired',
    endpointArn: 'arn:aws:bedrock-agentcore:us-east-1:027224425948:runtime/demo/runtime-endpoint/repaired',
    runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:027224425948:runtime/demo',
    runtimeVersion: '20',
    artifactSha256,
    artifactVersionId: 'artifact-version',
    configurationSha256,
    sourceRevision,
    sourceSha256,
    promptSha256,
    modelId: 'us.anthropic.claude-sonnet-4-6',
    reviewManifestSha256: manifestSha256,
    caseSetSha256: suiteSha256,
    reportIdentitiesSha256: reportSha256,
    experimentId: 'experiment-1',
    reviewEnvironment: 'repaired-publication',
    reviewRunId: '123',
    reviewer: 'reviewer',
  };
  const receipt = {
    status: 'review_required',
    candidateId: 'repaired',
    sourceRevision,
    promptSha256,
    reviewManifestSha256: manifestSha256,
    artifact: {
      bucket: 'incident-triage-demo-evidence-027224425948-us-east-1',
      key: `agent-evaluation/phase20/${artifactSha256}/runtime.zip`,
      sha256: artifactSha256,
    },
    source: {
      bucket: 'incident-triage-demo-evidence-027224425948-us-east-1',
      key: `agent-evaluation/phase20/${artifactSha256}/prompt.py`,
      sha256: sourceSha256,
    },
    configuration: {
      bucket: 'incident-triage-demo-evidence-027224425948-us-east-1',
      key: `agent-evaluation/phase20/${artifactSha256}/runtime-configuration.json`,
      sha256: configurationSha256,
    },
    suite: { sha256: suiteSha256, caseIds: [caseId] },
    evaluator: { sha256: evaluatorSha256 },
    inputs: { suiteSha256, caseIds: [caseId] },
    privateReview: {},
    evaluation: { reportIdentitiesSha256: reportSha256 },
  };
  const manifest = {
    manifestSha256,
    artifactSha256,
    suiteSha256,
    evaluatorSha256,
    caseIdentities: [{ caseId }],
    reportIdentities: [{ caseId, reportSha256 }],
  };
  const remote = {
    repository: 'example/repo',
    branch: 'demo-deploy',
    gitTip: sourceRevision,
    githubTip: sourceRevision,
    pointerPath: 'agent/qualification-input.json',
    pointerSha256: '5'.repeat(64),
  };
  const approval = {
    runId: '123',
    reviewer: 'reviewer',
    reviewerId: 7,
    environment: 'repaired-publication',
    environmentId: 8,
    comment: `approve ${manifestSha256}`,
    state: 'approved',
    headSha: sourceRevision,
  };
  return { publication, receipt, manifest, remote, approval };
}

test('selects exactly one immutable qualification receipt', () => {
  const key = `agent-evaluation/phase20/${artifactSha256}/owner/123/1/${manifestSha256}/qualification.json`;
  assert.equal(selectQualificationKey([key], artifactSha256, manifestSha256), key);
  assert.throws(
    () => selectQualificationKey([key, key.replace('/owner/', '/other/')], artifactSha256, manifestSha256),
    TalkPublicationVerificationError,
  );
});

test('selects the exact protected approval and rejects a bare digest', () => {
  const environment = [{ id: 8, name: 'repaired-publication' }];
  const wrong = {
    state: 'approved',
    user: { id: 7 },
    environments: environment,
    comment: `approve ${'0'.repeat(64)}`,
  };
  const correct = {
    state: 'approved',
    user: { id: 7 },
    environments: environment,
    comment: `approve ${manifestSha256}`,
  };
  assert.equal(
    selectApproval([wrong, correct], { reviewerId: 7, environmentId: 8, manifestSha256 }).comment,
    correct.comment,
  );
  assert.throws(
    () => selectApproval([{ ...correct, comment: manifestSha256 }], { reviewerId: 7, environmentId: 8, manifestSha256 }),
    /exact manifest approval comment/,
  );
});

test('builds the minimal S5 session binding from matching identities', () => {
  const fixture = makeFixture();
  const binding = buildSessionBinding({
    ...fixture,
    receiptSha256: '6'.repeat(64),
    receiptKey: 'agent-evaluation/phase20/receipt/qualification.json',
    manifestKey: 'agent-evaluation/phase20/receipt/index.json',
    evidenceBucket: 'incident-triage-demo-evidence-027224425948-us-east-1',
    pointer: pointer(),
  });
  assert.equal(binding.demoDeploy.qualifiedCommit, sourceRevision);
  assert.equal(binding.demoDeploy.candidateId, 'repaired');
  assert.equal(binding.demoDeploy.artifactVersionId, 'artifact-version');
  assert.equal(binding.qualification.humanReview.status, 'approved');
  assert.equal(binding.qualification.inputPointer.evaluatorSha256, evaluatorSha256);
});

test('rejects a remote branch that advanced beyond the published source', () => {
  const fixture = makeFixture();
  assert.throws(
    () => buildSessionBinding({
      ...fixture,
      remote: { ...fixture.remote, gitTip: '9'.repeat(40), githubTip: '9'.repeat(40) },
      receiptSha256: '6'.repeat(64),
      receiptKey: 'receipt',
      manifestKey: 'manifest',
      evidenceBucket: 'incident-triage-demo-evidence-027224425948-us-east-1',
      pointer: pointer(),
    }),
    /advanced beyond the published repaired source/,
  );
});

test('parses the real qualified v20 receipt, manifest, approval, and historical head fixture', () => {
  // These identities are copied from the actual v20 native publication row,
  // Phase 20 S3 receipt/index, maintained pointer, and GitHub approval. The
  // historical head is deliberately an ephemeral test boundary; no remote
  // branch is created or moved, and the live command still rejects 711b6b6.
  const fixture = makeFixture();
  const evidenceBucket = 'incident-triage-demo-evidence-027224425948-us-east-1';
  const actualSource = '62236d0e8731242d5a6468cf931f003a323b5349';
  const actualArtifact = '1f8e45fedee78cc9cc60c8b777c2b3ef51eee53ac00909a3bbf499c78de28cf7';
  const actualPrompt = '0f8d10ce6f46302a00dbe60cb29ebfeb4212627000c78b3529e6e0c7696ff425';
  const actualSourceBytes = '88b8b94f2da13263407aadc1301bc5b4c2345fcec3ac2bd148fead9835807bdd';
  const actualConfig = 'c68bd2adda510445c119dbf933681f4189f3298711afa69d1f93936306a633ba';
  const actualSuite = '64e81d8ac825154dd49ee36ca750aca81bb4a07ab1612d1d00e6c28dba0a7bfe';
  const actualEvaluator = 'd153bfdc9551255516a565f8363eeea8f6c4962c7807ce015082d0edd907261f';
  const actualReports = '6ad649f0da85194e6b8c9f3675fd24f3a15d275d206a92a63ece7a49d394f5ca';
  const actualManifest = '29669b1dc3faa8a9bf7693aa5650937cd330741ebd02a1bc9ac80c549b06ec1b';
  const cases = [
    'phase14.denied-inventory-read.prepared',
    'phase14.inventory-capacity-overload.prepared',
    'phase14.recovery-with-old-alert.prepared',
  ];
  const receiptKey = `agent-evaluation/phase20/${actualArtifact}/guilleojeda/44265837592/1/${actualManifest}/qualification.json`;
  const manifestKey = `agent-evaluation/phase20/${actualArtifact}/guilleojeda/44265837592/1/${actualManifest}/index.json`;
  fixture.publication = {
    ...fixture.publication,
    runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:027224425948:runtime/IncidentTriageDemoAgent-7VWTOWDIs4',
    endpointArn: 'arn:aws:bedrock-agentcore:us-east-1:027224425948:runtime/IncidentTriageDemoAgent-7VWTOWDIs4/runtime-endpoint/repaired',
    runtimeVersion: '20', artifactSha256: actualArtifact,
    artifactVersionId: 'jSNSUJ_qWCBaBQdiQ3nlS7DgSvYbmwNl',
    configurationSha256: actualConfig, sourceRevision: actualSource,
    sourceSha256: actualSourceBytes, promptSha256: actualPrompt,
    reviewManifestSha256: actualManifest, caseSetSha256: actualSuite,
    reportIdentitiesSha256: actualReports, reviewRunId: '44265837592', reviewer: 'guilleojeda',
  };
  fixture.receipt = {
    ...fixture.receipt,
    sourceRevision: actualSource, promptSha256: actualPrompt, reviewManifestSha256: actualManifest,
    artifact: { bucket: evidenceBucket, key: `agent-evaluation/phase20/${actualArtifact}/runtime.zip`, sha256: actualArtifact },
    source: { bucket: evidenceBucket, key: `agent-evaluation/phase20/${actualArtifact}/prompt.py`, sha256: actualSourceBytes },
    configuration: { bucket: evidenceBucket, key: `agent-evaluation/phase20/${actualArtifact}/runtime-configuration.json`, sha256: actualConfig },
    suite: { sha256: actualSuite, caseIds: cases }, evaluator: { sha256: actualEvaluator },
    inputs: { suiteSha256: actualSuite, caseIds: cases },
    evaluation: { reportIdentitiesSha256: actualReports },
    github: { headSha: actualSource },
    privateReview: { s3: { bucket: evidenceBucket, prefix: receiptKey.slice(0, -'/qualification.json'.length), qualificationKey: receiptKey, manifestKey } },
  };
  fixture.manifest = {
    manifestSha256: actualManifest, artifactSha256: actualArtifact, suiteSha256: actualSuite,
    evaluatorSha256: actualEvaluator, caseIdentities: cases.map((caseId) => ({ caseId })),
    reportIdentities: cases.map((caseId) => ({ caseId })), github: { headSha: actualSource },
  };
  fixture.remote = {
    repository: 'guilleojeda/evaluations-ref-arch', branch: 'demo-deploy',
    gitTip: actualSource, githubTip: actualSource, pointerPath: 'agent/qualification-input.json',
    pointerSha256: '7b8786e22ded7cc43a30ee2584b8b22d6f884d0d1095b330fae0cd223fee2164',
  };
  fixture.approval = {
    runId: '44265837592', reviewer: 'guilleojeda', reviewerId: 18320860,
    environment: 'repaired-publication', environmentId: 27678290254,
    comment: `approve ${actualManifest}`, state: 'approved', headSha: actualSource,
  };
  const actualPointer = pointer({ suite: actualSuite, evaluator: actualEvaluator, cases });
  validateReviewLocator(fixture.receipt, receiptKey, manifestKey, [receiptKey, manifestKey], evidenceBucket);
  const binding = buildSessionBinding({
    ...fixture, pointer: actualPointer, receiptSha256: '05086e41e57af8906d648cf7535cd1570e963f6efe55420becba5d4a3a59f8c1',
    receiptKey, manifestKey, evidenceBucket,
  });
  assert.equal(binding.demoDeploy.qualifiedCommit, actualSource);
  assert.equal(binding.qualification.humanReview.approval.comment, `approve ${actualManifest}`);
  assert.equal(binding.qualification.inputPointer.suiteSha256, actualSuite);
});
