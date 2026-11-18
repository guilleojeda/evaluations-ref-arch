import { createHash } from "node:crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import {
  BedrockAgentCoreControlClient,
  GetAgentRuntimeCommand,
  GetAgentRuntimeEndpointCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type {
  AgentCandidateId,
  AgentEndpointObservation,
  AgentPublication,
  AgentSelection,
} from "./types.js";

const control = new BedrockAgentCoreControlClient({ maxAttempts: 1 });
const dynamo = new DynamoDBClient({ maxAttempts: 1 });
const s3 = new S3Client({ maxAttempts: 1, forcePathStyle: true });
const timeout = () => ({ abortSignal: AbortSignal.timeout(4_000) });
const selectionKey = "AGENT_SELECTION";
const candidateIds = new Set<AgentCandidateId>(["faulty", "repaired"]);
const runtimeArnPattern = /^arn:aws:bedrock-agentcore:([a-z0-9-]+):(\d{12}):runtime\/([A-Za-z0-9_-]+)$/;
const endpointArnPattern = /^arn:aws:bedrock-agentcore:([a-z0-9-]+):(\d{12}):runtime\/([A-Za-z0-9_-]+)\/runtime-endpoint\/([A-Za-z0-9_-]+)$/;
const sha256Pattern = /^[0-9a-f]{64}$/i;
const revisionPattern = /^[0-9a-f]{40}$/i;
const maxConfigurationBytes = 64_000;

export class AgentReadinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentReadinessError";
  }
}

/** A native response was received, but it definitively cannot serve the tuple. */
class AgentObservationMismatchError extends AgentReadinessError {
  constructor(message: string, readonly observed?: { liveVersion?: string; targetVersion?: string }) {
    super(message);
    this.name = "AgentObservationMismatchError";
  }
}

function table(): string {
  const name = process.env.CONTROLLER_RUN_TABLE?.trim();
  if (!name) throw new AgentReadinessError("The controller table is unavailable.");
  return name;
}

function text(value: unknown, max = 512): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function requiredText(value: unknown, field: string, max = 512): string {
  const result = text(value, max);
  if (!result) throw new AgentReadinessError(`The prepared AgentCore publication is missing ${field}.`);
  return result;
}

function configuredRuntimeArn(): string | undefined {
  const value = process.env.CONTROLLER_AGENT_RUNTIME_ARN?.trim();
  return value && runtimeArnPattern.test(value) ? value : undefined;
}

function parseRuntimeArn(value: string): { region: string; account: string; runtimeId: string } {
  const match = value.match(runtimeArnPattern);
  if (!match) throw new AgentReadinessError("The prepared AgentCore Runtime ARN is invalid.");
  return { region: match[1], account: match[2], runtimeId: match[3] };
}

function parseEndpointArn(value: string): { region: string; account: string; runtimeId: string; endpointName: string } {
  const match = value.match(endpointArnPattern);
  if (!match) throw new AgentReadinessError("The prepared AgentCore endpoint ARN is invalid.");
  return { region: match[1], account: match[2], runtimeId: match[3], endpointName: match[4] };
}

function publicationFor(value: unknown, candidate: AgentCandidateId): AgentPublication {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentReadinessError(`The ${candidate} AgentCore publication is missing.`);
  }
  const row = value as Record<string, unknown>;
  if (Object.hasOwn(row, "configurationBucket") || Object.hasOwn(row, "configurationKey")) {
    throw new AgentReadinessError("The Runtime configuration locator is server-derived and cannot be overridden by a publication row.");
  }
  const status = row.status === "reference" || row.status === "published" ? row.status : undefined;
  const endpointName = row.endpointName === candidate ? candidate : undefined;
  const runtimeArn = requiredText(row.runtimeArn, "runtimeArn", 256);
  const endpointArn = requiredText(row.endpointArn, "endpointArn", 512);
  const runtime = parseRuntimeArn(runtimeArn);
  const endpoint = parseEndpointArn(endpointArn);
  if (row.pk !== `AGENT_PUBLICATION#${candidate}` || row.candidateId !== candidate ||
      !status || (candidate === "faulty" ? status !== "reference" : status !== "published") ||
      !endpointName || endpoint.region !== runtime.region || endpoint.account !== runtime.account ||
      endpoint.runtimeId !== runtime.runtimeId || endpoint.endpointName !== candidate) {
    throw new AgentReadinessError(`The ${candidate} AgentCore publication identity is invalid.`);
  }
  const runtimeVersion = requiredText(row.runtimeVersion, "runtimeVersion", 64);
  const artifactSha256 = requiredText(row.artifactSha256, "artifactSha256", 128);
  const artifactVersionId = requiredText(row.artifactVersionId, "artifactVersionId", 256);
  const configurationSha256 = requiredText(row.configurationSha256, "configurationSha256", 128);
  const sourceRevision = requiredText(row.sourceRevision, "sourceRevision", 128);
  const sourceSha256 = requiredText(row.sourceSha256, "sourceSha256", 128);
  const promptSha256 = requiredText(row.promptSha256, "promptSha256", 128);
  const modelId = requiredText(row.modelId, "modelId", 256);
  const alarmArn = requiredText(row.alarmArn, "alarmArn", 512);
  const adapterArn = requiredText(row.adapterArn, "adapterArn", 512);
  const adapterCodeSha256 = requiredText(row.adapterCodeSha256, "adapterCodeSha256", 128);
  if (!/^[1-9]\d*$/.test(runtimeVersion) || !sha256Pattern.test(artifactSha256) || !sha256Pattern.test(configurationSha256) ||
      !sha256Pattern.test(sourceSha256) || !sha256Pattern.test(promptSha256) || !sha256Pattern.test(adapterCodeSha256) ||
      !revisionPattern.test(sourceRevision)) {
    throw new AgentReadinessError(`The ${candidate} AgentCore publication contains an invalid digest or version.`);
  }
  const optional = (field: keyof AgentPublication, max = 512): string | undefined => {
    const value = row[field];
    return value === undefined ? undefined : requiredText(value, field, max);
  };
  const sourceManifestSha256 = optional("sourceManifestSha256", 128);
  if (candidate === "faulty" && (!sourceManifestSha256 || !sha256Pattern.test(sourceManifestSha256))) {
    throw new AgentReadinessError("The faulty publication has no valid source manifest identity.");
  }
  const caseSetSha256 = optional("caseSetSha256", 128);
  const reportIdentitiesSha256 = optional("reportIdentitiesSha256", 128);
  const experimentId = optional("experimentId", 256);
  const reviewEnvironment = optional("reviewEnvironment", 256);
  const reviewRunId = optional("reviewRunId", 256);
  const reviewManifestSha256 = optional("reviewManifestSha256", 128);
  const reviewer = optional("reviewer", 256);
  if (candidate === "repaired" && (!caseSetSha256 || !reportIdentitiesSha256 || !experimentId || !reviewEnvironment ||
      !reviewRunId || !reviewManifestSha256 || !reviewer || !sha256Pattern.test(caseSetSha256) ||
      !sha256Pattern.test(reportIdentitiesSha256) || !sha256Pattern.test(reviewManifestSha256))) {
    throw new AgentReadinessError("The repaired publication is missing its qualification or review identity.");
  }
  const configurationVersionId = row.configurationVersionId === undefined
    ? undefined : requiredText(row.configurationVersionId, "configurationVersionId", 256);
  return {
    pk: `AGENT_PUBLICATION#${candidate}`,
    candidateId: candidate,
    status,
    endpointName: candidate,
    endpointArn,
    runtimeArn,
    runtimeVersion,
    artifactSha256,
    artifactVersionId,
    ...(configurationVersionId ? { configurationVersionId } : {}),
    configurationSha256,
    sourceRevision,
    sourceSha256,
    promptSha256,
    modelId,
    alarmArn,
    adapterArn,
    adapterCodeSha256,
    ...(sourceManifestSha256 ? { sourceManifestSha256 } : {}),
    ...(caseSetSha256 ? { caseSetSha256 } : {}),
    ...(reportIdentitiesSha256 ? { reportIdentitiesSha256 } : {}),
    ...(experimentId ? { experimentId } : {}),
    ...(reviewEnvironment ? { reviewEnvironment } : {}),
    ...(reviewRunId ? { reviewRunId } : {}),
    ...(reviewManifestSha256 ? { reviewManifestSha256 } : {}),
    ...(reviewer ? { reviewer } : {}),
  };
}

function selectionFor(value: unknown): AgentSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentReadinessError("The selected AgentCore publication is missing.");
  }
  const row = value as Record<string, unknown>;
  const candidate = row.candidateId === "faulty" || row.candidateId === "repaired" ? row.candidateId : undefined;
  if (!candidate || row.pk !== selectionKey) throw new AgentReadinessError("The selected AgentCore publication is malformed.");
  const publication = publicationFor({ ...row, pk: `AGENT_PUBLICATION#${candidate}`, status: candidate === "faulty" ? "reference" : "published" }, candidate);
  const selectedAt = requiredText(row.selectedAt, "selectedAt", 64);
  if (!Number.isFinite(Date.parse(selectedAt))) throw new AgentReadinessError("The selected AgentCore publication timestamp is invalid.");
  return { ...publication, pk: selectionKey, selectedAt };
}

async function readRow(pk: string): Promise<Record<string, unknown> | undefined> {
  const response = await dynamo.send(new GetItemCommand({
    TableName: table(), Key: { pk: { S: pk } }, ConsistentRead: true,
  }), timeout());
  return response.Item ? unmarshall(response.Item) as Record<string, unknown> : undefined;
}

export async function readAgentSelection(): Promise<AgentSelection | undefined> {
  const row = await readRow(selectionKey);
  return row ? selectionFor(row) : undefined;
}

export async function readAgentPublication(candidate: AgentCandidateId): Promise<AgentPublication> {
  const row = await readRow(`AGENT_PUBLICATION#${candidate}`);
  return publicationFor(row, candidate);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([key, item]) => !((key === "port" && item === 8080) || (key === "path" && item === "/invocations")))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function agentSelectionTuple(value: AgentPublication | AgentSelection | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const { pk: _pk, status: _status, selectedAt: _selectedAt, ...tuple } = value as AgentPublication & AgentSelection;
  return tuple;
}

export function sameAgentSelection(a: AgentPublication | AgentSelection | undefined, b: AgentPublication | AgentSelection | undefined): boolean {
  return canonical(agentSelectionTuple(a)) === canonical(agentSelectionTuple(b));
}

function approvedConfiguration(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentReadinessError("The Runtime configuration object is invalid.");
  const source = value as Record<string, unknown>;
  const config = source.runtimeConfiguration && typeof source.runtimeConfiguration === "object" && !Array.isArray(source.runtimeConfiguration)
    ? source.runtimeConfiguration as Record<string, unknown> : source;
  const names = ["agentRuntimeArtifact", "environmentVariables", "lifecycleConfiguration", "metadataConfiguration",
    "networkConfiguration", "protocolConfiguration", "roleArn"] as const;
  if (names.some((name) => !(name in config))) throw new AgentReadinessError("The Runtime configuration omits an approved member.");
  return Object.fromEntries(names.map((name) => [name, config[name]]));
}

async function bodyBytes(body: unknown): Promise<Uint8Array> {
  if (body && typeof body === "object" && "transformToByteArray" in body && typeof body.transformToByteArray === "function") {
    return await body.transformToByteArray() as Uint8Array;
  }
  if (body && typeof body === "object" && Symbol.asyncIterator in body) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    return Buffer.concat(chunks);
  }
  throw new AgentReadinessError("The Runtime configuration object body is unavailable.");
}

function configurationLocator(publication: AgentPublication): { bucket: string; key: string; versionId?: string } {
  const runtimeIdentity = parseRuntimeArn(publication.runtimeArn);
  const bucket = publication.candidateId === "faulty"
    ? `cdk-evaltalk-assets-${runtimeIdentity.account}-${runtimeIdentity.region}`
    : `incident-triage-demo-evidence-${runtimeIdentity.account}-${runtimeIdentity.region}`;
  const key = publication.candidateId === "faulty"
    ? `agent-reference/${publication.configurationSha256}.json`
    : `agent-evaluation/phase20/${publication.artifactSha256}/runtime-configuration.json`;
  if (!/^[A-Za-z0-9._-]{3,255}$/.test(bucket) || !key || key.length > 1_024 || key.startsWith("/") || key.includes("..")) {
    throw new AgentReadinessError("The Runtime configuration locator is invalid.");
  }
  return { bucket, key, ...(publication.configurationVersionId ? { versionId: publication.configurationVersionId } : {}) };
}

function servingLocator(publication: AgentPublication, runtime: Record<string, unknown>): void {
  const artifact = runtime.agentRuntimeArtifact;
  const codeConfiguration = artifact && typeof artifact === "object" && !Array.isArray(artifact)
    ? (artifact as Record<string, unknown>).codeConfiguration : undefined;
  const code = codeConfiguration && typeof codeConfiguration === "object" && !Array.isArray(codeConfiguration)
    ? (codeConfiguration as Record<string, unknown>).code : undefined;
  const s3Object = code && typeof code === "object" && !Array.isArray(code)
    ? (code as Record<string, unknown>).s3 : undefined;
  if (!s3Object || typeof s3Object !== "object" || Array.isArray(s3Object)) throw new AgentReadinessError("The Runtime serving locator is missing.");
  const locator = s3Object as Record<string, unknown>;
  const bucket = requiredText(locator.bucket, "Runtime serving bucket", 255);
  const key = requiredText(locator.prefix ?? locator.key, "Runtime serving key", 1_024);
  const versionId = requiredText(locator.versionId, "Runtime serving VersionId", 256);
  const identity = parseRuntimeArn(publication.runtimeArn);
  const expectedBucket = `cdk-evaltalk-assets-${identity.account}-${identity.region}`;
  const expectedKey = `${publication.candidateId === "faulty" ? "agent-reference" : "agent-qualified"}/${publication.artifactSha256}.zip`;
  if (bucket !== expectedBucket || key !== expectedKey || versionId !== publication.artifactVersionId) {
    throw new AgentReadinessError("The Runtime does not serve the published immutable artifact.");
  }
}

function expectedEnvironment(publication: AgentPublication, environment: unknown): void {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) throw new AgentReadinessError("The Runtime environment is unavailable.");
  const vars = environment as Record<string, unknown>;
  for (const [key, expected] of Object.entries({
    AGENT_CANDIDATE_ID: publication.candidateId,
    AGENT_ENDPOINT_NAME: publication.endpointName,
    AGENT_ARTIFACT_SHA256: publication.artifactSha256,
    AGENT_SOURCE_REVISION: publication.sourceRevision,
    AGENT_MODEL_ID: publication.modelId,
    AGENT_ALARM_ARN: publication.alarmArn,
  })) {
    if (vars[key] !== expected) throw new AgentReadinessError(`The Runtime environment member ${key} differs from the publication.`);
  }
}

function normalizeServingArtifact(configuration: Record<string, unknown>, runtime: Record<string, unknown>): Record<string, unknown> {
  const normalized = structuredClone(configuration);
  const configuredArtifact = normalized.agentRuntimeArtifact as Record<string, unknown>;
  const configuredCodeConfiguration = configuredArtifact.codeConfiguration as Record<string, unknown>;
  const configuredCode = configuredCodeConfiguration.code as Record<string, unknown>;
  const nativeArtifact = runtime.agentRuntimeArtifact as Record<string, unknown>;
  const nativeCodeConfiguration = nativeArtifact.codeConfiguration as Record<string, unknown>;
  const nativeCode = nativeCodeConfiguration.code as Record<string, unknown>;
  configuredCode.s3 = structuredClone(nativeCode.s3);
  return normalized;
}

function configuredArtifactLocator(publication: AgentPublication, configuration: Record<string, unknown>): void {
  const artifact = configuration.agentRuntimeArtifact;
  const codeConfiguration = artifact && typeof artifact === "object" && !Array.isArray(artifact)
    ? (artifact as Record<string, unknown>).codeConfiguration : undefined;
  const code = codeConfiguration && typeof codeConfiguration === "object" && !Array.isArray(codeConfiguration)
    ? (codeConfiguration as Record<string, unknown>).code : undefined;
  const s3Object = code && typeof code === "object" && !Array.isArray(code)
    ? (code as Record<string, unknown>).s3 : undefined;
  if (!s3Object || typeof s3Object !== "object" || Array.isArray(s3Object)) throw new AgentReadinessError("The original Runtime configuration has no artifact locator.");
  const locator = s3Object as Record<string, unknown>;
  const identity = parseRuntimeArn(publication.runtimeArn);
  const expectedBucket = publication.candidateId === "faulty"
    ? `cdk-evaltalk-assets-${identity.account}-${identity.region}`
    : `incident-triage-demo-evidence-${identity.account}-${identity.region}`;
  const expectedKey = publication.candidateId === "faulty"
    ? `agent-reference/${publication.artifactSha256}.zip`
    : `agent-evaluation/phase20/${publication.artifactSha256}/runtime.zip`;
  if (locator.bucket !== expectedBucket || (locator.prefix ?? locator.key) !== expectedKey ||
      (publication.candidateId === "faulty" && locator.versionId !== publication.artifactVersionId) ||
      (publication.candidateId === "repaired" && locator.versionId !== undefined)) {
    throw new AgentReadinessError("The original Runtime configuration is not bound to the approved staged artifact.");
  }
}

async function readNativeEndpoint(publication: Pick<AgentPublication, "runtimeArn" | "endpointName" | "endpointArn" | "runtimeVersion">): Promise<Record<string, unknown>> {
  const runtime = parseRuntimeArn(publication.runtimeArn);
  const endpoint = await control.send(new GetAgentRuntimeEndpointCommand({
    agentRuntimeId: runtime.runtimeId, endpointName: publication.endpointName,
  }), timeout()) as unknown as Record<string, unknown>;
  if (endpoint.agentRuntimeArn !== publication.runtimeArn || endpoint.agentRuntimeEndpointArn !== publication.endpointArn ||
      endpoint.name !== publication.endpointName || endpoint.status !== "READY" || endpoint.liveVersion !== publication.runtimeVersion ||
      (endpoint.targetVersion !== undefined && endpoint.targetVersion !== endpoint.liveVersion)) {
    throw new AgentObservationMismatchError("The AgentCore endpoint is not READY on the published immutable Runtime version.", {
      ...(typeof endpoint.liveVersion === "string" ? { liveVersion: endpoint.liveVersion } : {}),
      ...(typeof endpoint.targetVersion === "string" ? { targetVersion: endpoint.targetVersion } : {}),
    });
  }
  return endpoint;
}

async function readNativeRuntime(publication: AgentPublication): Promise<Record<string, unknown>> {
  const runtimeIdentity = parseRuntimeArn(publication.runtimeArn);
  const runtime = await control.send(new GetAgentRuntimeCommand({
    agentRuntimeId: runtimeIdentity.runtimeId, agentRuntimeVersion: publication.runtimeVersion,
  }), timeout()) as unknown as Record<string, unknown>;
  if (runtime.agentRuntimeArn !== publication.runtimeArn || runtime.agentRuntimeVersion !== publication.runtimeVersion ||
      runtime.status !== "READY") throw new AgentObservationMismatchError("The AgentCore Runtime version is not READY or has the wrong identity.");
  try {
    servingLocator(publication, runtime);
    expectedEnvironment(publication, runtime.environmentVariables);
  } catch (error) {
    if (error instanceof AgentReadinessError) throw new AgentObservationMismatchError(error.message);
    throw error;
  }
  const locator = configurationLocator(publication);
  const object = await s3.send(new GetObjectCommand({ Bucket: locator.bucket, Key: locator.key, Range: `bytes=0-${maxConfigurationBytes - 1}`,
    ...(locator.versionId ? { VersionId: locator.versionId } : {}) }), timeout());
  if (object.ContentLength !== undefined && object.ContentLength > maxConfigurationBytes) {
    throw new AgentReadinessError("The Runtime configuration object exceeds the bounded read limit.");
  }
  const bytes = await bodyBytes(object.Body);
  if (bytes.byteLength > maxConfigurationBytes) throw new AgentReadinessError("The Runtime configuration object exceeds the bounded read limit.");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== publication.configurationSha256.toLowerCase()) throw new AgentObservationMismatchError("The Runtime configuration original bytes differ from the publication digest.");
  if (locator.versionId && object.VersionId !== locator.versionId) throw new AgentObservationMismatchError("The Runtime configuration VersionId changed during readback.");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new AgentObservationMismatchError("The Runtime configuration is invalid JSON."); }
  try {
    const configured = approvedConfiguration(parsed);
    const actual = approvedConfiguration(runtime);
    configuredArtifactLocator(publication, configured);
    if (canonical(normalizeServingArtifact(configured, runtime)) !== canonical(actual)) {
      throw new AgentObservationMismatchError("The Runtime configuration differs from native readback.");
    }
  } catch (error) {
    if (error instanceof AgentObservationMismatchError) throw error;
    if (error instanceof AgentReadinessError) throw new AgentObservationMismatchError(error.message);
    throw error;
  }
  return runtime;
}

/** Verify a publication and its native serving state without invoking or repinning an agent. */
export async function verifyAgentPublication(candidate: AgentCandidateId): Promise<AgentSelection> {
  if (!candidateIds.has(candidate)) throw new AgentReadinessError("The requested AgentCore candidate is not allowed.");
  const publication = await readAgentPublication(candidate);
  const configured = configuredRuntimeArn();
  if (!configured) throw new AgentReadinessError("The fixed configured AgentCore Runtime is unavailable.");
  if (configured !== publication.runtimeArn) throw new AgentReadinessError("The publication Runtime differs from the fixed configured Runtime.");
  await readNativeEndpoint(publication);
  await readNativeRuntime(publication);
  return { ...publication, pk: selectionKey, selectedAt: new Date().toISOString() };
}

/** Read the selected tuple and the endpoint it names; never fall back to legacy environment routing. */
export async function readAgentEndpoint(): Promise<AgentEndpointObservation> {
  const observedAt = new Date().toISOString();
  let selectedForObservation: AgentSelection | undefined;
  try {
    const selected = await readAgentSelection();
    if (!selected) return { state: "unconfigured", observedAt, failureReason: "No verified AgentCore selection is configured." };
    selectedForObservation = selected;
    const configured = configuredRuntimeArn();
    if (!configured) throw new AgentReadinessError("The fixed configured AgentCore Runtime is unavailable.");
    if (configured !== selected.runtimeArn) throw new AgentReadinessError("The selected Runtime differs from the fixed configured Runtime.");
    const publication = await readAgentPublication(selected.candidateId);
    if (!sameAgentSelection(selected, publication)) throw new AgentReadinessError("The selected AgentCore tuple differs from its publisher-owned record.");
    const endpoint = await readNativeEndpoint(publication);
    await readNativeRuntime(publication);
    return {
      state: "ready", name: selected.endpointName, runtimeArn: selected.runtimeArn, endpointArn: selected.endpointArn,
      liveVersion: selected.runtimeVersion,
      ...(typeof endpoint.targetVersion === "string" ? { targetVersion: endpoint.targetVersion } : {}),
      selectedAgent: selected,
      observedAt,
    };
  } catch (error) {
    if (error instanceof AgentObservationMismatchError) {
      return {
        state: "not_ready",
        ...(selectedForObservation ? {
          name: selectedForObservation.endpointName,
          runtimeArn: selectedForObservation.runtimeArn,
          endpointArn: selectedForObservation.endpointArn,
        } : {}),
        ...(error.observed?.liveVersion ? { liveVersion: error.observed.liveVersion } : {}),
        ...(error.observed?.targetVersion ? { targetVersion: error.observed.targetVersion } : {}),
        observedAt,
        failureReason: error.message,
      };
    }
    return { state: "unavailable", observedAt, failureReason: error instanceof Error ? error.message : "The selected AgentCore endpoint could not be observed." };
  }
}
