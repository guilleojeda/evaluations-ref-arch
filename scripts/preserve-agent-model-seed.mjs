import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HISTORICAL_AGENT_MODEL_ID = "us.anthropic.claude-sonnet-4-6";
export const ACTIVE_AGENT_MODEL_ID = "us.anthropic.claude-opus-5-5";

function runtimeModel(template, label) {
  const value = template?.Resources?.Runtime?.Properties?.EnvironmentVariables?.AGENT_MODEL_ID;
  if (typeof value !== "string") {
    throw new Error(`${label} Runtime AGENT_MODEL_ID must be a literal string`);
  }
  return value;
}

/**
 * Keep an existing Runtime's literal model seed stable during an
 * infrastructure-only reconciliation.  The active synthesized template is
 * Opus; a legacy stack may still carry the reviewed Sonnet seed.  No other
 * model transition is accepted, and no property other than this seed is
 * changed.
 */
export function preserveAgentModelSeed(previousTemplate, candidateTemplate) {
  const previousModel = runtimeModel(previousTemplate, "previous");
  const candidateModel = runtimeModel(candidateTemplate, "candidate");
  if (candidateModel !== ACTIVE_AGENT_MODEL_ID) {
    throw new Error(`candidate Runtime AGENT_MODEL_ID must be ${ACTIVE_AGENT_MODEL_ID}`);
  }
  if (previousModel !== HISTORICAL_AGENT_MODEL_ID && previousModel !== ACTIVE_AGENT_MODEL_ID) {
    throw new Error(`unsupported previous Runtime AGENT_MODEL_ID ${JSON.stringify(previousModel)}`);
  }

  const preserved = structuredClone(candidateTemplate);
  if (previousModel === HISTORICAL_AGENT_MODEL_ID) {
    preserved.Resources.Runtime.Properties.EnvironmentVariables.AGENT_MODEL_ID = previousModel;
  }
  return preserved;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${label} template ${path}: ${error.message}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [previousPath, candidatePath] = process.argv.slice(2);
  if (!previousPath || !candidatePath || process.argv.length !== 4) {
    console.error("Usage: node scripts/preserve-agent-model-seed.mjs <previous-template> <candidate-template>");
    process.exit(1);
  }
  try {
    process.stdout.write(`${JSON.stringify(preserveAgentModelSeed(
      readJson(previousPath, "previous"),
      readJson(candidatePath, "candidate"),
    ), null, 2)}\n`);
  } catch (error) {
    console.error(`Rejected agent Runtime model seed: ${error.message}`);
    process.exit(1);
  }
}
