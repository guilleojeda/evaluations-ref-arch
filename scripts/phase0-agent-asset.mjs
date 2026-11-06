#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.artifacts/agent/cdk');
const runtimePath = resolve(process.argv[3] ?? '.artifacts/agent/runtime.zip');
const expectedBucket = process.argv[4] ?? process.env.PHASE0_ASSET_BUCKET;
const manifestPath = resolve(root, 'manifest.json');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(path, label) {
  if (!existsSync(path)) fail(`${label} is missing: ${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${requireSeparator()}`));
}

function requireSeparator() {
  return process.platform === 'win32' ? '\\' : '/';
}

if (!existsSync(runtimePath) || !statSync(runtimePath).isFile()) {
  fail(`Agent runtime ZIP is missing or not a file: ${runtimePath}`);
}

const manifest = readJson(manifestPath, 'Agent CDK manifest');
const runtimeHash = createHash('sha256').update(readFileSync(runtimePath)).digest('hex');
const assetArtifacts = Object.values(manifest.artifacts ?? {}).filter((artifact) =>
  artifact?.type === 'aws:cdk:asset-manifest' || artifact?.type === 'cdk:asset-manifest',
);

let match;
for (const artifact of assetArtifacts) {
  if (typeof artifact.properties?.file !== 'string') continue;
  const assetManifestPath = resolve(root, artifact.properties.file);
  if (!inside(root, assetManifestPath)) continue;
  const assetManifest = readJson(assetManifestPath, 'Agent CDK asset manifest');
  for (const [assetHash, entry] of Object.entries(assetManifest.files ?? {})) {
    if (entry?.source?.packaging !== 'file' || typeof entry.source.path !== 'string') continue;
    const stagedPath = resolve(root, entry.source.path);
    if (!inside(root, stagedPath) || !existsSync(stagedPath) || !statSync(stagedPath).isFile()) continue;
    const stagedHash = createHash('sha256').update(readFileSync(stagedPath)).digest('hex');
    if (stagedHash !== runtimeHash) continue;
    const targets = Object.values(entry.destinations ?? {}).filter((destination) =>
      typeof destination?.bucketName === 'string' && typeof destination?.objectKey === 'string',
    );
    const target = targets.find((destination) => destination.bucketName === expectedBucket) ?? targets[0];
    if (!target) fail('Agent runtime asset has no S3 bucket and object key destination');
    if (!expectedBucket || target.bucketName !== expectedBucket) {
      fail(`Agent runtime asset points at unexpected bucket: ${target.bucketName}`);
    }
    if (!/^[a-f0-9]{64}$/i.test(assetHash)
      || target.objectKey !== `${assetHash}.zip`) {
      fail(`Agent runtime asset does not use its content-addressed ZIP key: ${target.objectKey}`);
    }
    match = {
      assetHash,
      bucketName: target.bucketName,
      objectKey: target.objectKey,
      runtimePath,
      runtimeSha256: runtimeHash,
      stagedPath,
    };
    break;
  }
  if (match) break;
}

if (!match) fail('Agent CDK asset manifest does not bind the checked runtime ZIP as a file asset');
console.log(JSON.stringify(match));
