import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACTIVE_AGENT_MODEL_ID,
  HISTORICAL_AGENT_MODEL_ID,
  preserveAgentModelSeed,
} from "../scripts/preserve-agent-model-seed.mjs";

function template(model) {
  return {
    Resources: {
      Runtime: {
        Type: "AWS::BedrockAgentCore::Runtime",
        Properties: {
          EnvironmentVariables: {
            AGENT_MODEL_ID: model,
            AGENT_ENDPOINT_NAME: "faulty",
            AGENT_CANDIDATE_ID: "faulty",
          },
          AgentRuntimeName: "IncidentTriageDemoAgent",
          AgentRuntimeArtifact: { CodeConfiguration: { Runtime: "PYTHON_3_13" } },
        },
      },
      PublisherFaulty: { Type: "AWS::CloudFormation::WaitConditionHandle" },
      PublisherRepaired: { Type: "AWS::CloudFormation::WaitConditionHandle" },
    },
    Outputs: {
      FaultyEndpointArn: { Value: "runtime-endpoint/faulty" },
      RepairedEndpointArn: { Value: "runtime-endpoint/repaired" },
    },
  };
}

test("existing infrastructure reconciliation preserves only the historic Sonnet model seed", () => {
  const previous = template(HISTORICAL_AGENT_MODEL_ID);
  const candidate = template(ACTIVE_AGENT_MODEL_ID);
  const result = preserveAgentModelSeed(previous, candidate);
  assert.equal(result.Resources.Runtime.Properties.EnvironmentVariables.AGENT_MODEL_ID, HISTORICAL_AGENT_MODEL_ID);
  const expected = structuredClone(candidate);
  expected.Resources.Runtime.Properties.EnvironmentVariables.AGENT_MODEL_ID = HISTORICAL_AGENT_MODEL_ID;
  assert.deepEqual(result, expected);
  assert.deepEqual(result.Outputs, candidate.Outputs,
    "faulty and repaired publisher endpoint identities remain unchanged");
  assert.equal(candidate.Resources.Runtime.Properties.EnvironmentVariables.AGENT_MODEL_ID, ACTIVE_AGENT_MODEL_ID,
    "the checked candidate is not mutated");
});

test("active Opus and fresh checked templates remain byte-equivalent", () => {
  const candidate = template(ACTIVE_AGENT_MODEL_ID);
  assert.deepEqual(preserveAgentModelSeed(candidate, candidate), candidate);
  assert.equal(candidate.Resources.Runtime.Properties.EnvironmentVariables.AGENT_MODEL_ID, ACTIVE_AGENT_MODEL_ID);
});

test("unsupported or nonliteral model seeds are rejected", () => {
  assert.throws(() => preserveAgentModelSeed(template("another-model"), template(ACTIVE_AGENT_MODEL_ID)), /unsupported previous/);
  assert.throws(() => preserveAgentModelSeed(template(HISTORICAL_AGENT_MODEL_ID), template(HISTORICAL_AGENT_MODEL_ID)), /candidate Runtime/);
  const intrinsic = template(ACTIVE_AGENT_MODEL_ID);
  intrinsic.Resources.Runtime.Properties.EnvironmentVariables.AGENT_MODEL_ID = { Ref: "Model" };
  assert.throws(() => preserveAgentModelSeed(template(HISTORICAL_AGENT_MODEL_ID), intrinsic), /literal string/);
});

test("deployment shell invokes preservation only in existing infrastructure-only mode", () => {
  const deploy = readFileSync(new URL("../scripts/deploy-agent.sh", import.meta.url), "utf8");
  assert.match(deploy, /infrastructure_only" == true && "\$fresh_stack" == false/);
  assert.match(deploy, /get-template --stack-name "\$stack" --template-stage Original/);
  assert.match(deploy, /preserve-agent-model-seed\.mjs/);
  assert.match(deploy, /if \[\[ "\$infrastructure_only" == true && "\$fresh_stack" == false \]\]/);
});

test("CLI preserves a live template's model seed without changing named publisher outputs", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-model-seed-"));
  try {
    const previousPath = join(directory, "previous.json");
    const candidatePath = join(directory, "candidate.json");
    writeFileSync(previousPath, JSON.stringify(template(HISTORICAL_AGENT_MODEL_ID)));
    writeFileSync(candidatePath, JSON.stringify(template(ACTIVE_AGENT_MODEL_ID)));
    const helper = fileURLToPath(new URL("../scripts/preserve-agent-model-seed.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [helper, previousPath, candidatePath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const preserved = JSON.parse(result.stdout);
    assert.equal(preserved.Resources.Runtime.Properties.EnvironmentVariables.AGENT_MODEL_ID, HISTORICAL_AGENT_MODEL_ID);
    assert.deepEqual(preserved.Outputs, template(ACTIVE_AGENT_MODEL_ID).Outputs);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
