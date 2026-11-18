#!/usr/bin/env -S npx tsx

/**
 * Read-only operator proof for the Phase 22 S5 starting point.
 *
 * The controller's native verifier is the authority for the AgentCore
 * publication.  This command only joins that verified tuple to the current
 * remote demo-deploy head, the protected GitHub approval, the immutable
 * Phase 20 receipt/review manifest, and the maintained qualification pointer.
 * It never selects an endpoint, changes a branch, publishes, or invokes the
 * agent.  The JSON result is a small input fragment for scripts/talk-session.py.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type { AgentSelection } from "../controller/src/types.js";

const COMMIT_RE = /^[0-9a-f]{40}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const DEFAULT_REGION = "us-east-1";
const DEFAULT_TABLE = "IncidentTriageDemoControllerRun";
const DEFAULT_BRANCH = "demo-deploy";
const DEFAULT_POINTER_PATH = "agent/qualification-input.json";

export class TalkPublicationVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TalkPublicationVerificationError";
  }
}

type JsonObject = { [key: string]: unknown };

export interface QualificationPointer {
  schemaVersion: number;
  purpose: string;
  bucket: string;
  s3Key: string;
  sha256: string;
  suiteSha256: string;
  evaluatorSha256: string;
  caseIds: string[];
}

interface QualificationManifest {
  manifestSha256: string;
  artifactSha256: string;
  suiteSha256: string;
  evaluatorSha256: string;
  caseIdentities: JsonObject[];
  reportIdentities: JsonObject[];
  github?: JsonObject;
}

interface QualificationReceipt extends JsonObject {
  status: string;
  candidateId: string;
  sourceRevision: string;
  promptSha256: string;
  reviewManifestSha256: string;
  artifact: JsonObject;
  source: JsonObject;
  configuration: JsonObject;
  suite: JsonObject;
  evaluator: JsonObject;
  inputs: JsonObject;
  privateReview: JsonObject;
}

interface ApprovalEvidence {
  runId: string;
  reviewer: string;
  reviewerId: number;
  environment: string;
  environmentId: number;
  comment: string;
  state: string;
  headSha: string;
}

interface RemoteEvidence {
  repository: string;
  branch: string;
  gitTip: string;
  githubTip: string;
  pointerPath: string;
  pointerSha256: string;
}

export interface SessionBinding {
  schemaVersion: 1;
  kind: "phase22-s5-qualification-binding";
  checkedAt: string;
  demoDeploy: {
    branch: string;
    qualifiedCommit: string;
    candidateId: "repaired";
    publicationId: string;
    sourceRevision: string;
    remoteTip: string;
    endpointName: string;
    endpointArn: string;
    runtimeArn: string;
    runtimeVersion: string;
    artifactSha256: string;
    artifactVersionId: string;
    configurationSha256: string;
    configurationVersionId?: string;
    promptSha256: string;
    sourceSha256: string;
    qualificationManifestSha256: string;
    suiteSha256: string;
    evaluatorSha256: string;
  };
  remote: RemoteEvidence;
  publication: {
    candidateId: string;
    endpointName: string;
    endpointArn: string;
    runtimeArn: string;
    runtimeVersion: string;
    artifactSha256: string;
    artifactVersionId: string;
    configurationSha256: string;
    configurationVersionId?: string;
    sourceRevision: string;
    sourceSha256: string;
    promptSha256: string;
    modelId: string;
  };
  qualification: {
    receipt: {
      bucket: string;
      key: string;
      sha256: string;
      status: string;
      sourceRevision: string;
      artifactSha256: string;
      sourceSha256: string;
      configurationSha256: string;
      promptSha256: string;
      manifestSha256: string;
      suiteSha256: string;
      evaluatorSha256: string;
      caseIds: string[];
    };
    reviewManifest: {
      bucket: string;
      key: string;
      sha256: string;
      artifactSha256: string;
      suiteSha256: string;
      evaluatorSha256: string;
      caseIds: string[];
      reportCount: number;
    };
    humanReview: {
      status: "approved";
      environment: string;
      reviewer: string;
      runId: string;
      manifestSha256: string;
      approval: ApprovalEvidence;
    };
    inputPointer: QualificationPointer;
  };
}

interface ParsedArgs {
  branch: string;
  remote: string;
  repo?: string;
  pointerPath: string;
  region: string;
  table: string;
  runtimeArn: string;
  profile?: string;
  output?: string;
}

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TalkPublicationVerificationError(`${name} must be an object.`);
  }
  return value as JsonObject;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TalkPublicationVerificationError(`${name} must be a non-empty string.`);
  }
  return value;
}

function digest(value: unknown, name: string): string {
  const result = string(value, name).toLowerCase();
  if (!SHA256_RE.test(result)) throw new TalkPublicationVerificationError(`${name} must be a SHA-256 digest.`);
  return result;
}

function commit(value: unknown, name: string): string {
  const result = string(value, name).toLowerCase();
  if (!COMMIT_RE.test(result)) throw new TalkPublicationVerificationError(`${name} must be a Git commit SHA.`);
  return result;
}

function arrayOfStrings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new TalkPublicationVerificationError(`${name} must be a non-empty string array.`);
  }
  return value as string[];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function run(command: string, args: string[], label: string): string {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const detail = error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr.trim() : "";
    throw new TalkPublicationVerificationError(`${label}${detail ? `: ${detail}` : "."}`);
  }
}

function parseRemoteRepository(remote: string): string | undefined {
  const match = remote.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i);
  return match?.[1];
}

export function parsePointer(value: unknown, expectedBucket?: string): QualificationPointer {
  const row = object(value, "qualification pointer");
  if (row.schemaVersion !== 1 || row.purpose !== "Phase 20 reviewed private evaluation input handoff") {
    throw new TalkPublicationVerificationError("qualification pointer is not the maintained Phase 20 handoff.");
  }
  const pointer: QualificationPointer = {
    schemaVersion: 1,
    purpose: string(row.purpose, "qualification pointer purpose"),
    bucket: string(row.bucket, "qualification pointer bucket"),
    s3Key: string(row.s3Key, "qualification pointer s3Key"),
    sha256: digest(row.sha256, "qualification pointer sha256"),
    suiteSha256: digest(row.suiteSha256, "qualification pointer suiteSha256"),
    evaluatorSha256: digest(row.evaluatorSha256, "qualification pointer evaluatorSha256"),
    caseIds: arrayOfStrings(row.caseIds, "qualification pointer caseIds"),
  };
  if (expectedBucket && pointer.bucket !== expectedBucket) {
    throw new TalkPublicationVerificationError("qualification pointer bucket differs from the fixed evidence bucket.");
  }
  if (!/^agent-evaluation\/phase18\/inputs\/[0-9a-f]{64}\/staging\.tar\.gz$/.test(pointer.s3Key)) {
    throw new TalkPublicationVerificationError("qualification pointer does not identify the content-addressed Phase 18 staging archive.");
  }
  if (pointer.s3Key.split("/")[3] !== pointer.sha256) {
    throw new TalkPublicationVerificationError("qualification pointer archive key differs from its digest.");
  }
  return pointer;
}

function listQualificationKeys(keys: string[], artifactSha256: string, manifestSha256: string): string[] {
  const prefix = `agent-evaluation/phase20/${artifactSha256}/`;
  const suffix = `/${manifestSha256}/qualification.json`;
  return keys.filter((key) => key.startsWith(prefix) && key.endsWith(suffix));
}

export function selectQualificationKey(keys: string[], artifactSha256: string, manifestSha256: string): string {
  const matches = listQualificationKeys(keys, artifactSha256, manifestSha256);
  if (matches.length !== 1) {
    throw new TalkPublicationVerificationError(
      `expected one immutable qualification receipt for artifact ${artifactSha256} and manifest ${manifestSha256}, found ${matches.length}.`,
    );
  }
  return matches[0];
}

export function validateReviewLocator(
  receipt: QualificationReceipt,
  receiptKey: string,
  manifestKey: string,
  availableKeys: string[],
  evidenceBucket: string,
): void {
  const privateReview = object(receipt.privateReview, "qualification privateReview");
  const s3Review = object(privateReview.s3, "qualification privateReview.s3");
  assertEqual(s3Review.bucket, evidenceBucket, "qualification review bucket differs from the fixed evidence bucket");
  assertEqual(s3Review.qualificationKey, receiptKey, "qualification receipt locator differs from its S3 key");
  const reviewPrefix = receiptKey.slice(0, -"/qualification.json".length);
  assertEqual(s3Review.prefix, reviewPrefix, "qualification review prefix differs from its S3 receipt prefix");
  assertEqual(s3Review.manifestKey, manifestKey, "qualification review manifest locator differs from its S3 key");
  assertEqual(manifestKey, `${reviewPrefix}/index.json`, "qualification review manifest locator is not the immutable receipt's index");
  if (!availableKeys.includes(manifestKey)) throw new TalkPublicationVerificationError("qualification review manifest is missing from the receipt prefix.");
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new TalkPublicationVerificationError(`${message}: expected ${String(expected)}, got ${String(actual)}.`);
}

function validateStringRoster(actual: string[], expected: string[], name: string): void {
  // The suite digest binds the ordered suite bytes. Case IDs are compared as
  // unique membership here because the maintained pointer and the historical
  // receipt intentionally use different orderings. Output preserves each
  // original list for the session importer.
  const actualUnique = new Set(actual);
  const expectedUnique = new Set(expected);
  if (actualUnique.size !== actual.length) {
    throw new TalkPublicationVerificationError(`${name} identity roster contains a duplicate case ID.`);
  }
  if (expectedUnique.size !== expected.length) {
    throw new TalkPublicationVerificationError(`${name} selected roster contains a duplicate case ID.`);
  }
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    throw new TalkPublicationVerificationError(`${name} identity roster does not exactly match the selected case roster.`);
  }
}

export function validateIdentityRoster(value: unknown, expected: string[], name: string): void {
  if (!Array.isArray(value)) {
    throw new TalkPublicationVerificationError(`${name} identity roster is missing.`);
  }
  const actual = value.map((entry, index) => string(object(entry, `${name} identity ${index}`).caseId, `${name} identity ${index} caseId`));
  validateStringRoster(actual, expected, name);
}

export function buildSessionBinding(args: {
  publication: AgentSelection;
  remote: RemoteEvidence;
  pointer: QualificationPointer;
  receipt: QualificationReceipt;
  receiptSha256: string;
  receiptKey: string;
  manifest: QualificationManifest;
  manifestKey: string;
  approval: ApprovalEvidence;
  evidenceBucket: string;
}): SessionBinding {
  const publication = args.publication;
  if (publication.candidateId !== "repaired") throw new TalkPublicationVerificationError("S5 requires the repaired candidate.");
  const sourceRevision = commit(publication.sourceRevision, "published sourceRevision");
  const remoteTip = commit(args.remote.gitTip, "remote demo-deploy tip");
  assertEqual(remoteTip, sourceRevision, "demo-deploy advanced beyond the published repaired source");
  assertEqual(args.remote.githubTip, remoteTip, "Git and GitHub disagree about the demo-deploy tip");

  const receipt = args.receipt;
  assertEqual(receipt.status === "review_required" || receipt.status === "eligible", true, "qualification receipt is not a successful machine handoff");
  assertEqual(receipt.candidateId, "repaired", "qualification receipt candidate differs");
  assertEqual(commit(receipt.sourceRevision, "qualification sourceRevision"), sourceRevision, "qualification source differs from the published source");
  assertEqual(digest(receipt.reviewManifestSha256, "qualification reviewManifestSha256"), digest(publication.reviewManifestSha256, "publication reviewManifestSha256"), "qualification manifest differs from publication");
  const artifact = object(receipt.artifact, "qualification artifact");
  const source = object(receipt.source, "qualification source");
  const configuration = object(receipt.configuration, "qualification configuration");
  const suite = object(receipt.suite, "qualification suite");
  const evaluator = object(receipt.evaluator, "qualification evaluator");
  const inputs = object(receipt.inputs, "qualification inputs");
  const manifestSha256 = digest(publication.reviewManifestSha256, "publication reviewManifestSha256");
  assertEqual(digest(artifact.sha256, "qualification artifact.sha256"), digest(publication.artifactSha256, "publication artifactSha256"), "qualification artifact differs from publication");
  assertEqual(digest(source.sha256, "qualification source.sha256"), digest(publication.sourceSha256, "publication sourceSha256"), "qualification source bytes differ from publication");
  assertEqual(digest(configuration.sha256, "qualification configuration.sha256"), digest(publication.configurationSha256, "publication configurationSha256"), "qualification configuration differs from publication");
  assertEqual(artifact.bucket, args.evidenceBucket, "qualification artifact bucket differs from the fixed evidence bucket");
  assertEqual(artifact.key, `agent-evaluation/phase20/${publication.artifactSha256}/runtime.zip`, "qualification artifact key is not the staged immutable ZIP");
  assertEqual(source.bucket, args.evidenceBucket, "qualification source bucket differs from the fixed evidence bucket");
  assertEqual(source.key, `agent-evaluation/phase20/${publication.artifactSha256}/prompt.py`, "qualification source key is not the staged prompt");
  assertEqual(configuration.bucket, args.evidenceBucket, "qualification configuration bucket differs from the fixed evidence bucket");
  assertEqual(configuration.key, `agent-evaluation/phase20/${publication.artifactSha256}/runtime-configuration.json`, "qualification configuration key is not the staged configuration");
  assertEqual(digest(receipt.promptSha256, "qualification promptSha256"), digest(publication.promptSha256, "publication promptSha256"), "qualification prompt differs from publication");
  assertEqual(digest(suite.sha256, "qualification suite.sha256"), digest(publication.caseSetSha256, "publication caseSetSha256"), "qualification suite differs from publication");
  assertEqual(digest(publication.reportIdentitiesSha256, "publication reportIdentitiesSha256"), digest((receipt.evaluation as JsonObject | undefined)?.reportIdentitiesSha256, "qualification reportIdentitiesSha256"), "qualification reports differ from publication");

  const manifest = args.manifest;
  assertEqual(digest(manifest.manifestSha256, "review manifest manifestSha256"), manifestSha256, "review manifest digest differs from publication");
  assertEqual(digest(manifest.artifactSha256, "review manifest artifactSha256"), digest(publication.artifactSha256, "publication artifactSha256"), "review manifest artifact differs from publication");
  assertEqual(digest(manifest.suiteSha256, "review manifest suiteSha256"), digest(suite.sha256, "qualification suite.sha256"), "review manifest suite differs from qualification");
  assertEqual(digest(manifest.evaluatorSha256, "review manifest evaluatorSha256"), digest(evaluator.sha256, "qualification evaluator.sha256"), "review manifest evaluator differs from qualification");
  const caseIds = arrayOfStrings(suite.caseIds, "qualification suite.caseIds");
  validateStringRoster(caseIds, caseIds, "qualification suite");
  assertEqual(digest(inputs.suiteSha256, "qualification inputs.suiteSha256"), digest(suite.sha256, "qualification suite.sha256"), "qualification input suite differs from the qualified suite");
  validateStringRoster(arrayOfStrings(inputs.caseIds, "qualification inputs.caseIds"), caseIds, "qualification input");
  validateStringRoster(args.pointer.caseIds, caseIds, "qualification pointer");
  assertEqual(args.pointer.suiteSha256, digest(suite.sha256, "qualification suite.sha256"), "qualification pointer suite differs from the qualified suite");
  assertEqual(args.pointer.evaluatorSha256, digest(evaluator.sha256, "qualification evaluator.sha256"), "qualification pointer evaluator differs from the qualified evaluator");
  validateIdentityRoster(manifest.caseIdentities, caseIds, "review manifest case");
  validateIdentityRoster(manifest.reportIdentities, caseIds, "review manifest report");
  const receiptGithub = receipt.github;
  if (receiptGithub && typeof receiptGithub === "object" && !Array.isArray(receiptGithub)) {
    assertEqual((receiptGithub as JsonObject).headSha, sourceRevision, "qualification receipt GitHub head differs from the published source");
  }
  if (manifest.github && typeof manifest.github === "object" && !Array.isArray(manifest.github)) {
    assertEqual((manifest.github as JsonObject).headSha, sourceRevision, "review manifest GitHub head differs from the published source");
  }

  const approval = args.approval;
  assertEqual(approval.state, "approved", "protected repaired-publication review is not approved");
  assertEqual(approval.environment, "repaired-publication", "protected review environment differs");
  assertEqual(approval.runId, string(publication.reviewRunId, "publication reviewRunId"), "protected review run differs from publication");
  assertEqual(approval.reviewer, string(publication.reviewer, "publication reviewer"), "protected reviewer differs from publication");
  assertEqual(approval.comment, `approve ${manifestSha256}`, "protected approval comment does not exactly approve the review manifest");
  assertEqual(approval.headSha, sourceRevision, "protected review run head differs from the published source");

  const publicationId = `repaired:${publication.runtimeArn}:v${publication.runtimeVersion}:${publication.artifactSha256}:${manifestSha256}`;
  const demoDeploy: SessionBinding["demoDeploy"] = {
    branch: args.remote.branch,
    qualifiedCommit: remoteTip,
    candidateId: "repaired",
    publicationId,
    sourceRevision,
    remoteTip,
    endpointName: publication.endpointName,
    endpointArn: publication.endpointArn,
    runtimeArn: publication.runtimeArn,
    runtimeVersion: publication.runtimeVersion,
    artifactSha256: publication.artifactSha256,
    artifactVersionId: publication.artifactVersionId,
    configurationSha256: publication.configurationSha256,
    ...(publication.configurationVersionId ? { configurationVersionId: publication.configurationVersionId } : {}),
    promptSha256: publication.promptSha256,
    sourceSha256: publication.sourceSha256,
    qualificationManifestSha256: manifestSha256,
    suiteSha256: digest(suite.sha256, "qualification suite.sha256"),
    evaluatorSha256: digest(evaluator.sha256, "qualification evaluator.sha256"),
  };
  return {
    schemaVersion: 1,
    kind: "phase22-s5-qualification-binding",
    checkedAt: new Date().toISOString(),
    demoDeploy,
    remote: args.remote,
    publication: {
      candidateId: publication.candidateId,
      endpointName: publication.endpointName,
      endpointArn: publication.endpointArn,
      runtimeArn: publication.runtimeArn,
      runtimeVersion: publication.runtimeVersion,
      artifactSha256: publication.artifactSha256,
      artifactVersionId: publication.artifactVersionId,
      configurationSha256: publication.configurationSha256,
      ...(publication.configurationVersionId ? { configurationVersionId: publication.configurationVersionId } : {}),
      sourceRevision,
      sourceSha256: publication.sourceSha256,
      promptSha256: publication.promptSha256,
      modelId: publication.modelId,
    },
    qualification: {
      receipt: {
        bucket: args.evidenceBucket,
        key: args.receiptKey,
        sha256: digest(args.receiptSha256, "qualification receipt sha256"),
        status: receipt.status,
        sourceRevision,
        artifactSha256: digest(artifact.sha256, "qualification artifact.sha256"),
        sourceSha256: digest(source.sha256, "qualification source.sha256"),
        configurationSha256: digest(configuration.sha256, "qualification configuration.sha256"),
        promptSha256: digest(receipt.promptSha256, "qualification promptSha256"),
        manifestSha256,
        suiteSha256: digest(suite.sha256, "qualification suite.sha256"),
        evaluatorSha256: digest(evaluator.sha256, "qualification evaluator.sha256"),
        caseIds,
      },
      reviewManifest: {
        bucket: args.evidenceBucket,
        key: args.manifestKey,
        sha256: manifestSha256,
        artifactSha256: digest(manifest.artifactSha256, "review manifest artifactSha256"),
        suiteSha256: digest(manifest.suiteSha256, "review manifest suiteSha256"),
        evaluatorSha256: digest(manifest.evaluatorSha256, "review manifest evaluatorSha256"),
        caseIds,
        reportCount: manifest.reportIdentities.length,
      },
      humanReview: {
        status: "approved",
        environment: approval.environment,
        reviewer: approval.reviewer,
        runId: approval.runId,
        manifestSha256,
        approval,
      },
      inputPointer: args.pointer,
    },
  };
}

async function bodyBytes(body: unknown): Promise<Uint8Array> {
  if (body && typeof body === "object" && "transformToByteArray" in body && typeof body.transformToByteArray === "function") {
    return await (body.transformToByteArray as () => Promise<Uint8Array>)();
  }
  if (body && typeof body === "object" && Symbol.asyncIterator in body) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    return Buffer.concat(chunks);
  }
  throw new TalkPublicationVerificationError("S3 returned an unreadable object body.");
}

async function getObject(client: S3Client, bucket: string, key: string): Promise<{ bytes: Uint8Array; versionId?: string }> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(15_000) });
  return { bytes: await bodyBytes(response.Body), ...(response.VersionId ? { versionId: response.VersionId } : {}) };
}

async function listObjects(client: S3Client, bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const response = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ...(token ? { ContinuationToken: token } : {}) }), { abortSignal: AbortSignal.timeout(15_000) });
    for (const item of response.Contents ?? []) if (item.Key) keys.push(item.Key);
    token = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

function parseJson(bytes: Uint8Array, name: string): JsonObject {
  try {
    return object(JSON.parse(Buffer.from(bytes).toString("utf8")), name);
  } catch (error) {
    if (error instanceof TalkPublicationVerificationError) throw error;
    throw new TalkPublicationVerificationError(`${name} is not valid JSON.`);
  }
}

function githubJson(repo: string, endpoint: string): unknown {
  const raw = run("gh", ["api", `repos/${repo}/${endpoint}`], `GitHub read failed for ${endpoint}`);
  try { return JSON.parse(raw); } catch { throw new TalkPublicationVerificationError(`GitHub returned invalid JSON for ${endpoint}.`); }
}

function githubGlobalJson(endpoint: string): unknown {
  const raw = run("gh", ["api", endpoint], `GitHub read failed for ${endpoint}`);
  try { return JSON.parse(raw); } catch { throw new TalkPublicationVerificationError(`GitHub returned invalid JSON for ${endpoint}.`); }
}

function githubText(repo: string, endpoint: string): string {
  return run("gh", ["api", `repos/${repo}/${endpoint}`, "--jq", ".sha"], `GitHub read failed for ${endpoint}`);
}

function readGithubPointer(repo: string, path: string, ref: string): { pointer: QualificationPointer; sha256: string } {
  const response = object(githubJson(repo, `contents/${path}?ref=${ref}`), "GitHub qualification pointer response");
  const encoded = string(response.content, "GitHub qualification pointer content").replace(/\s+/g, "");
  let bytes: Buffer;
  try { bytes = Buffer.from(encoded, "base64"); } catch { throw new TalkPublicationVerificationError("GitHub qualification pointer content is not base64."); }
  return { pointer: parsePointer(parseJson(bytes, "qualification pointer")), sha256: sha256(bytes) };
}

export function selectApproval(
  history: unknown,
  expected: { reviewerId: number; environmentId: number; manifestSha256: string },
): JsonObject {
  if (!Array.isArray(history)) throw new TalkPublicationVerificationError("GitHub approval history is not an array.");
  const expectedComment = `approve ${digest(expected.manifestSha256, "approval manifestSha256")}`;
  const approval = history.find((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const row = entry as JsonObject;
    const userRow = row.user && typeof row.user === "object" && !Array.isArray(row.user) ? row.user as JsonObject : undefined;
    const environments = Array.isArray(row.environments) ? row.environments : [];
    return row.state === "approved" && userRow?.id === expected.reviewerId && row.comment === expectedComment && environments.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const env = item as JsonObject;
      return env.id === expected.environmentId && env.name === "repaired-publication";
    });
  }) as JsonObject | undefined;
  if (!approval) throw new TalkPublicationVerificationError("no approved repaired-publication review contains the exact manifest approval comment.");
  return approval;
}

function readApprovals(repo: string, publication: AgentSelection, expectedHead: string): ApprovalEvidence {
  const runId = string(publication.reviewRunId, "publication reviewRunId");
  const reviewer = string(publication.reviewer, "publication reviewer");
  const workflowRun = object(githubJson(repo, `actions/runs/${runId}`), "GitHub workflow run");
  const head = string(workflowRun.head_sha, "GitHub workflow head");
  assertEqual(head, expectedHead, "GitHub qualification run head differs from the published source");
  const user = object(githubGlobalJson(`users/${reviewer}`), "GitHub reviewer");
  const reviewerId = user.id;
  if (typeof reviewerId !== "number") throw new TalkPublicationVerificationError("GitHub reviewer has no numeric identity.");
  const environment = object(githubJson(repo, "environments/repaired-publication"), "GitHub protected environment");
  const environmentId = environment.id;
  if (typeof environmentId !== "number") throw new TalkPublicationVerificationError("GitHub protected environment has no numeric identity.");
  const approval = selectApproval(githubJson(repo, `actions/runs/${runId}/approvals`), {
    reviewerId,
    environmentId,
    manifestSha256: string(publication.reviewManifestSha256, "publication reviewManifestSha256"),
  });
  return {
    runId,
    reviewer,
    reviewerId,
    environment: "repaired-publication",
    environmentId,
    comment: string(approval.comment, "GitHub approval comment"),
    state: "approved",
    headSha: head,
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new TalkPublicationVerificationError(`unexpected argument ${key}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new TalkPublicationVerificationError(`${key} requires a value`);
    values.set(key.slice(2), value);
  }
  const branch = values.get("branch") ?? DEFAULT_BRANCH;
  const region = values.get("region") ?? process.env.AWS_REGION ?? DEFAULT_REGION;
  const table = values.get("table") ?? process.env.CONTROLLER_RUN_TABLE ?? DEFAULT_TABLE;
  const runtimeArn = values.get("runtime-arn") ?? process.env.CONTROLLER_AGENT_RUNTIME_ARN;
  if (!runtimeArn) throw new TalkPublicationVerificationError("set CONTROLLER_AGENT_RUNTIME_ARN or pass --runtime-arn.");
  return {
    branch,
    remote: values.get("remote") ?? "origin",
    ...(values.get("repo") ? { repo: values.get("repo") } : {}),
    pointerPath: values.get("pointer") ?? DEFAULT_POINTER_PATH,
    region,
    table,
    runtimeArn,
    ...(values.get("profile") ? { profile: values.get("profile") } : {}),
    ...(values.get("output") ? { output: values.get("output") } : {}),
  };
}

function usage(): string {
  return [
    "Usage: npx tsx scripts/verify-talk-publication.ts [options]",
    "",
    "Read-only proof of the repaired S5 publication and current demo-deploy tip.",
    "The result is JSON suitable for merging into a Phase 22 session input.",
    "",
    "Options:",
    "  --profile PROFILE       AWS profile for native readback",
    "  --runtime-arn ARN       fixed AgentCore Runtime ARN (or CONTROLLER_AGENT_RUNTIME_ARN)",
    "  --table NAME            controller publication table (default: IncidentTriageDemoControllerRun)",
    "  --repo OWNER/REPO       GitHub repository (derived from origin when omitted)",
    "  --remote NAME           Git remote (default: origin)",
    "  --branch NAME           branch to compare (default: demo-deploy)",
    "  --pointer PATH          qualification pointer (default: agent/qualification-input.json)",
    "  --region REGION         AWS Region (default: us-east-1)",
    "  --output PATH           write a new JSON binding file as well as stdout",
  ].join("\n") + "\n";
}

async function verify(args: ParsedArgs): Promise<SessionBinding> {
  if (args.profile) {
    process.env.AWS_PROFILE = args.profile;
    process.env.AWS_SDK_LOAD_CONFIG = "1";
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
  }
  process.env.AWS_REGION = args.region;
  process.env.CONTROLLER_RUN_TABLE = args.table;
  process.env.CONTROLLER_AGENT_RUNTIME_ARN = args.runtimeArn;
  const { verifyAgentPublication } = await import("../controller/src/agent-readiness.js");
  const publication = await verifyAgentPublication("repaired");
  const sourceRevision = commit(publication.sourceRevision, "published sourceRevision");
  const gitTip = commit(run("git", ["ls-remote", "--heads", args.remote, `refs/heads/${args.branch}`], `Git read failed for ${args.remote}/${args.branch}`).split(/\s+/)[0], "remote demo-deploy tip");
  const repository = args.repo ?? parseRemoteRepository(run("git", ["remote", "get-url", args.remote], `Git remote ${args.remote} is unavailable`));
  if (!repository) throw new TalkPublicationVerificationError("pass --repo for a non-GitHub remote so the maintained pointer and protected review can be read.");
  const githubTip = commit(githubText(repository, `commits/${args.branch}`), "GitHub demo-deploy tip");
  const runtimeMatch = publication.runtimeArn.match(/^arn:aws:bedrock-agentcore:([^:]+):(\d{12}):runtime\//);
  if (!runtimeMatch) throw new TalkPublicationVerificationError("published Runtime ARN is malformed.");
  const evidenceBucket = `incident-triage-demo-evidence-${runtimeMatch[2]}-${runtimeMatch[1]}`;
  const pointerRead = readGithubPointer(repository, args.pointerPath, gitTip);
  const client = new S3Client({ region: args.region, maxAttempts: 1, forcePathStyle: true });
  const reviewRunId = string(publication.reviewRunId, "publication reviewRunId");
  const reviewer = string(publication.reviewer, "publication reviewer");
  const allKeys = await listObjects(client, evidenceBucket, `agent-evaluation/phase20/${publication.artifactSha256}/${reviewer}/${reviewRunId}/`);
  const receiptKey = selectQualificationKey(allKeys, publication.artifactSha256, publication.reviewManifestSha256!);
  const receiptObject = await getObject(client, evidenceBucket, receiptKey);
  const receipt = parseJson(receiptObject.bytes, "qualification receipt") as QualificationReceipt;
  const privateReview = object(receipt.privateReview, "qualification privateReview");
  const s3Review = object(privateReview.s3, "qualification privateReview.s3");
  const manifestKey = string(s3Review.manifestKey, "qualification review manifest key");
  validateReviewLocator(receipt, receiptKey, manifestKey, allKeys, evidenceBucket);
  const manifestObject = await getObject(client, evidenceBucket, manifestKey);
  const manifest = parseJson(manifestObject.bytes, "review manifest") as unknown as QualificationManifest;
  const remote: RemoteEvidence = {
    repository,
    branch: args.branch,
    gitTip,
    githubTip,
    pointerPath: args.pointerPath,
    pointerSha256: pointerRead.sha256,
  };
  const approval = readApprovals(repository, publication, sourceRevision);
  return buildSessionBinding({
    publication,
    remote,
    pointer: pointerRead.pointer,
    receipt,
    receiptSha256: sha256(receiptObject.bytes),
    receiptKey,
    manifest,
    manifestKey,
    approval,
    evidenceBucket,
  });
}

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h")) {
      process.stdout.write(usage());
      return;
    }
    const args = parseArgs(argv);
    const binding = await verify(args);
    const output = `${JSON.stringify(binding, null, 2)}\n`;
    if (args.output) {
      mkdirSync(dirname(args.output), { recursive: true });
      writeFileSync(args.output, output, { encoding: "utf8", flag: "wx" });
    }
    process.stdout.write(output);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`verify-talk-publication: ${message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
