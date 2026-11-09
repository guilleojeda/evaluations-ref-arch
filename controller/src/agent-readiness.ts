import {
  BedrockAgentCoreControlClient,
  GetAgentRuntimeEndpointCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { AgentEndpointObservation } from "./types.js";

const client = new BedrockAgentCoreControlClient({ maxAttempts: 1 });
const timeout = () => ({ abortSignal: AbortSignal.timeout(3_000) });
const runtimeArnPattern = /^arn:aws:bedrock-agentcore:([a-z0-9-]+):(\d{12}):runtime\/([A-Za-z0-9_-]+)$/;
const endpointArnPattern = /^arn:aws:bedrock-agentcore:([a-z0-9-]+):(\d{12}):runtime\/([A-Za-z0-9_-]+)\/runtime-endpoint\/([A-Za-z0-9_-]+)$/;

function clean(value: string | undefined, maximum = 512): string | undefined {
  if (!value) return undefined;
  const safe = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return safe ? safe.slice(0, maximum) : undefined;
}

function configuredIdentity() {
  const runtimeArn = process.env.CONTROLLER_AGENT_RUNTIME_ARN?.trim();
  const endpointArn = process.env.CONTROLLER_AGENT_ENDPOINT_ARN?.trim();
  const name = process.env.CONTROLLER_AGENT_ENDPOINT_NAME?.trim();
  const runtimeMatch = runtimeArn?.match(runtimeArnPattern);
  const endpointMatch = endpointArn?.match(endpointArnPattern);
  if (!runtimeArn || !endpointArn || !name || name.length > 128 || !runtimeMatch || !endpointMatch ||
      endpointMatch[1] !== runtimeMatch[1] || endpointMatch[2] !== runtimeMatch[2] ||
      endpointMatch[3] !== runtimeMatch[3] || endpointMatch[4] !== name) {
    return undefined;
  }
  return { runtimeArn, endpointArn, name, runtimeId: runtimeMatch[3] };
}

/** Read-only control-plane observation. An unavailable endpoint never blocks the application alarm read. */
export async function readAgentEndpoint(): Promise<AgentEndpointObservation> {
  const observedAt = new Date().toISOString();
  const configured = configuredIdentity();
  if (!configured) return { state: "unconfigured", observedAt };

  try {
    const endpoint = await client.send(new GetAgentRuntimeEndpointCommand({
      agentRuntimeId: configured.runtimeId,
      endpointName: configured.name,
    }), timeout());
    const identityMatches = endpoint.agentRuntimeArn === configured.runtimeArn &&
      endpoint.agentRuntimeEndpointArn === configured.endpointArn && endpoint.name === configured.name;
    return {
      state: identityMatches && endpoint.status === "READY" ? "ready" : "not_ready",
      name: configured.name,
      runtimeArn: configured.runtimeArn,
      endpointArn: configured.endpointArn,
      ...(clean(endpoint.liveVersion, 64) ? { liveVersion: clean(endpoint.liveVersion, 64) } : {}),
      ...(clean(endpoint.targetVersion, 64) ? { targetVersion: clean(endpoint.targetVersion, 64) } : {}),
      ...(!identityMatches ? { failureReason: "The control-plane endpoint identity did not match the configured runtime." }
        : endpoint.status !== "READY" ? { failureReason: clean(endpoint.failureReason) ?? `Endpoint status is ${clean(endpoint.status, 64) ?? "unknown"}.` }
          : {}),
      observedAt,
    };
  } catch {
    return {
      state: "unavailable",
      name: configured.name,
      runtimeArn: configured.runtimeArn,
      endpointArn: configured.endpointArn,
      observedAt,
    };
  }
}
