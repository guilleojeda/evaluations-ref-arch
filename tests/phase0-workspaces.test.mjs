import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = join(ROOT, ".artifacts");
const ACCOUNT = "027224425948";
const REGION = "us-east-1";
const TARGET = `aws://${ACCOUNT}/${REGION}`;
const STACK_ARTIFACT_TYPE = "aws:cloudformation:stack";
const COMPONENTS = ["app", "controller", "agent"];
const stackIdentities = new Map();

function commandFailure(command, result) {
  const output = [result.error?.message, result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .trim()
    .slice(-2_000);
  const status = result.status === null ? `signal ${result.signal ?? "unknown"}` : `exit ${result.status}`;
  return `${command} failed (${status})${output ? `:\n${output}` : "."}`;
}

function runCheck(component) {
  const command = `npm run check -- ${component}`;
  const result = spawnSync("npm", ["run", "check", "--", component], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CI: "1", npm_config_color: "false", AWS_PAGER: "" },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 5 * 60_000,
  });
  assert.equal(result.error, undefined, commandFailure(command, result));
  assert.equal(result.status, 0, commandFailure(command, result));
}

function readJson(path, label) {
  assert.ok(existsSync(path), `${label} is missing: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    assert.fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function assertStackManifest(component) {
  const cdkRoot = join(ARTIFACTS, component, "cdk");
  const manifestPath = join(cdkRoot, "manifest.json");
  const manifest = readJson(manifestPath, `${component} CDK manifest`);
  const artifacts = Object.entries(manifest.artifacts ?? {});
  const stacks = artifacts.filter(([, artifact]) => artifact?.type === STACK_ARTIFACT_TYPE);

  assert.equal(stacks.length, 1, `${component} synthesis must contain exactly one stack artifact`);
  const [manifestId, stack] = stacks[0];
  assert.equal(stack.environment, TARGET, `${component} stack must target ${TARGET}`);

  // CDK normally exposes stackName through the artifact API; the manifest's stable
  // artifact ID is the fallback when that field is not serialized.
  const stackIdentity = stack.stackName ?? stack.properties?.stackName ?? manifestId;
  assert.equal(typeof stackIdentity, "string", `${component} stack must expose a stable identity`);
  assert.ok(stackIdentity, `${component} stack must expose a non-empty identity`);
  for (const [otherComponent, otherIdentity] of stackIdentities) {
    assert.notEqual(
      stackIdentity,
      otherIdentity,
      `${component} and ${otherComponent} must synthesize distinct CloudFormation stack identities`,
    );
  }
  stackIdentities.set(component, stackIdentity);
  return { cdkRoot, manifest };
}

function resolveLocalAsset(webRoot, source) {
  const pathWithoutQuery = source.split(/[?#]/, 1)[0];
  assert.ok(pathWithoutQuery, "browser script source must not be empty");
  assert.doesNotMatch(pathWithoutQuery, /^(?:[a-z][a-z\d+.-]*:|\/\/)/i, `script source must be local: ${source}`);

  let decoded;
  try {
    decoded = decodeURIComponent(pathWithoutQuery);
  } catch (error) {
    assert.fail(`browser script source is not a valid local path (${source}): ${error.message}`);
  }
  assert.equal(decoded.includes("\\"), false, `browser script source must use POSIX-relative path syntax: ${source}`);

  const candidate = resolve(webRoot, decoded.replace(/^\/+/, ""));
  assert.ok(
    candidate === webRoot || candidate.startsWith(`${webRoot}${sep}`),
    `browser script source escapes ${webRoot}: ${source}`,
  );
  assert.notEqual(candidate, webRoot, `browser script source must name an asset: ${source}`);
  return candidate;
}

function assertBrowserBundle(component) {
  const webRoot = join(ARTIFACTS, component, "web");
  const indexPath = join(webRoot, "index.html");
  assert.ok(existsSync(indexPath), `${component} browser build is missing: ${indexPath}`);
  const html = readFileSync(indexPath, "utf8");
  assert.ok(html.trim(), `${component} browser entry is empty: ${indexPath}`);

  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map((match) => match[1]);
  assert.ok(scripts.length > 0, `${component} browser entry must reference a built JavaScript asset`);

  const assets = scripts.map((source) => resolveLocalAsset(webRoot, source));
  const javascriptAssets = assets.filter((asset) => /\.(?:m?js)$/i.test(asset));
  assert.ok(javascriptAssets.length > 0, `${component} browser entry must reference a local .js asset`);
  for (const asset of javascriptAssets) {
    assert.ok(existsSync(asset), `${component} browser asset is missing: ${relative(ROOT, asset)}`);
    assert.ok(statSync(asset).isFile(), `${component} browser asset is not a file: ${relative(ROOT, asset)}`);
    assert.ok(statSync(asset).size > 0, `${component} browser asset is empty: ${relative(ROOT, asset)}`);
  }
}

function zipCommand(args, artifactPath) {
  const result = spawnSync("unzip", [...args, artifactPath], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, commandFailure(`unzip ${args.join(" ")} ${artifactPath}`, result));
  assert.equal(result.status, 0, commandFailure(`unzip ${args.join(" ")} ${artifactPath}`, result));
  return result.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertAgentAssetManifest(manifest, cdkRoot, runtimePath) {
  const assetArtifacts = Object.values(manifest.artifacts ?? {}).filter((artifact) =>
    artifact?.type === "aws:cdk:asset-manifest" || artifact?.type === "cdk:asset-manifest",
  );
  assert.ok(assetArtifacts.length > 0, "agent CDK manifest must reference an asset manifest");
  const assetFile = assetArtifacts.find((artifact) => typeof artifact.properties?.file === "string")?.properties.file;
  assert.ok(assetFile, "agent asset manifest reference must name a manifest file");
  const assetManifestPath = resolve(cdkRoot, assetFile);
  assert.ok(
    assetManifestPath.startsWith(`${cdkRoot}${sep}`),
    "agent asset manifest reference must stay within the CDK assembly",
  );
  const assetManifest = readJson(assetManifestPath, "agent asset manifest");
  const runtimeHash = sha256(runtimePath);
  const runtimeAsset = Object.entries(assetManifest.files ?? {}).find(([, entry]) => {
    if (entry?.source?.packaging !== "file" || typeof entry.source.path !== "string") return false;
    const stagedPath = resolve(cdkRoot, entry.source.path);
    return existsSync(stagedPath) && statSync(stagedPath).isFile() && sha256(stagedPath) === runtimeHash;
  });
  assert.ok(runtimeAsset, "agent asset manifest must bind the actual runtime ZIP as a file asset");

  // CDK fingerprints the source for its asset ID. Its fingerprint can differ from the ZIP's byte hash.
  const [assetId, runtimeEntry] = runtimeAsset;
  assert.match(assetId, /^[a-f0-9]{64}$/i, "agent runtime file asset must use a CDK asset hash");
  const destinations = Object.values(runtimeEntry.destinations ?? {});
  const objectKey = destinations.find((destination) => typeof destination?.objectKey === "string")?.objectKey;
  assert.ok(objectKey, "agent runtime file asset must have an S3 object key");
  assert.match(objectKey, /\.zip$/i, "agent runtime object key must preserve the ZIP artifact");
  assert.ok(objectKey.includes(assetId), "agent runtime object key must include the CDK asset hash");
}

function assertAgentBundle(manifest, cdkRoot) {
  const artifactPath = join(ARTIFACTS, "agent", "runtime.zip");
  assert.ok(existsSync(artifactPath), `agent runtime bundle is missing: ${artifactPath}`);
  assert.ok(statSync(artifactPath).isFile(), `agent runtime bundle is not a file: ${artifactPath}`);
  assert.ok(statSync(artifactPath).size > 0, "agent runtime bundle is empty");

  assertAgentAssetManifest(manifest, cdkRoot, artifactPath);

  // AgentCore direct deployment needs the entrypoint and installed packages at the ZIP root.
  zipCommand(["-tqq"], artifactPath);
  const entries = zipCommand(["-Z1"], artifactPath);
  assert.ok(entries.includes("main.py"), "agent runtime bundle must contain root main.py");
  assert.ok(entries.some((entry) => /^strands(?:\/|$)/.test(entry)), "agent runtime bundle must include installed strands");
  assert.ok(
    entries.every((entry) => !entry.startsWith("/") && !entry.split("/").includes("..")),
    "agent runtime bundle must not contain absolute or parent-traversing paths",
  );
}

for (const component of COMPONENTS) {
  test(`${component} workspace check produces its CDK and runtime artifacts`, () => {
    runCheck(component);
    const { cdkRoot, manifest } = assertStackManifest(component);
    if (component === "agent") assertAgentBundle(manifest, cdkRoot);
    else assertBrowserBundle(component);
  });
}
