import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { resolve } from 'node:path';
import {
  adapterArn,
  alarmArn,
  appRevision,
  createPhase21Context,
  operatorBearer,
  repairedEndpoint,
  runtimeArn,
  selectorAdapterCodeSha256,
  selectionKey,
} from './support/phase21-agent-selection-fixture.mjs';

const auth = { authorization: `Bearer ${operatorBearer}`, accept: 'application/json' };

function event(method, path, body, { query = '', headers = auth } = {}) {
  return {
    version: '2.0', rawPath: path, rawQueryString: query, headers,
    requestContext: { requestId: `phase21-${randomUUID()}`, http: { method, path } },
    isBase64Encoded: false,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function json(response) {
  return JSON.parse(response.body);
}

async function submit(context, candidateId, { id = randomUUID(), body = {}, query = '', headers = auth } = {}) {
  const command = { kind: 'select_agent', candidateId, ...body };
  const response = await context.api.handler(event('PUT', `/api/actions/${id}`, command, { query, headers }));
  return { id, response, body: await json(response) };
}

async function readAction(context, id) {
  const response = await context.api.handler(event('GET', `/api/actions/${id}`));
  assert.equal(response.statusCode, 200, response.body);
  return (await json(response)).action;
}

async function runSelection(context, candidateId, options = {}) {
  const accepted = await submit(context, candidateId, options);
  assert.equal(accepted.response.statusCode, 202, accepted.response.body);
  await context.worker.handler({ actionId: accepted.id });
  return { ...accepted, action: await readAction(context, accepted.id) };
}

function selectionWrites(context) {
  return context.fixture.writes.filter(({ type, body, row }) => {
    if (type === 'put') return row?.pk === selectionKey;
    return type === 'transaction' && (body.TransactItems ?? []).some((item) => {
      const key = item.Put?.Item?.pk?.S;
      return key === selectionKey;
    });
  });
}

function latestSelectionItem(context) {
  for (const write of [...context.fixture.writes].reverse()) {
    const items = write.type === 'transaction' ? (write.body.TransactItems ?? [])
      : write.type === 'put' ? [{ Put: { Item: write.rawItem } }] : [];
    const item = items.find((operation) => operation.Put?.Item?.pk?.S === selectionKey)?.Put?.Item;
    if (item) return item;
  }
  assert.fail('the fixture has no raw low-level AGENT_SELECTION DynamoDB Item');
}

function verifyAdapterHandoff(context, candidateId, publication) {
  const helper = resolve(new URL('.', import.meta.url).pathname, 'support/phase21-read-selection.py');
  assert.ok(existsSync(helper), 'the shared Phase 21 Python adapter handoff helper is required');
  const root = resolve(new URL('..', import.meta.url).pathname);
  const venvPython = resolve(root, 'agent/.venv/bin/python');
  const command = existsSync(venvPython) ? venvPython : 'uv';
  const args = existsSync(venvPython)
    ? [helper]
    : ['run', '--offline', '--project', 'agent', '--locked', 'python', helper];
  execFileSync(command, args, {
    cwd: root,
    input: JSON.stringify({ candidateId, item: latestSelectionItem(context), publication }),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 20_000,
  });
}

function selectedTuple(context) {
  const selected = context.fixture.selected;
  assert.ok(selected, 'the selected-publication record should be durable');
  return Object.fromEntries([
    'candidateId', 'endpointName', 'endpointArn', 'runtimeArn', 'runtimeVersion', 'artifactSha256',
    'artifactVersionId', 'configurationSha256', 'sourceRevision', 'sourceSha256', 'promptSha256', 'modelId',
    'alarmArn', 'adapterArn', 'adapterCodeSha256', 'sourceManifestSha256', 'caseSetSha256',
    'reportIdentitiesSha256', 'experimentId', 'reviewEnvironment', 'reviewRunId', 'reviewManifestSha256', 'reviewer',
    'selectedAt',
  ].filter((key) => Object.hasOwn(selected, key)).map((key) => [key, selected[key]]));
}

function assertActionReadback(action, expected) {
  assert.equal(action.status, 'completed', action.error);
  assert.equal(action.configurationOutcome, expected.outcome ?? 'applied');
  assert.deepEqual(action.agentSelection, expected.tuple,
    'the completed public action must expose the server-verified selected tuple');
}

test('Phase 21 authenticated AgentCore candidate selection is a verified, fail-closed controller action', async (t) => {
  const context = await createPhase21Context(t);
  const failures = [];
  async function check(label, run) {
    try { await run(); }
    catch (error) { failures.push(`${label}: ${error instanceof Error ? error.stack : String(error)}`); }
  }

  await check('selects both prepared publication schemas and returns strong selected readback', async () => {
    for (const [candidateId, prior] of [['faulty', 'repaired'], ['repaired', 'faulty']]) {
      context.reset({ selectedCandidate: prior });
      const expectedPublication = context.fixture.publications[candidateId];
      const publicationBefore = structuredClone(context.fixture.rows.get(`AGENT_PUBLICATION#${candidateId}`));
      const result = await runSelection(context, candidateId);
      const tuple = selectedTuple(context);
      for (const field of ['candidateId', 'endpointName', 'endpointArn', 'runtimeArn', 'runtimeVersion',
        'artifactSha256', 'artifactVersionId', 'configurationSha256', 'sourceRevision', 'sourceSha256',
        'promptSha256', 'modelId', 'alarmArn', 'adapterArn', 'adapterCodeSha256']) {
        assert.equal(tuple[field], expectedPublication[field], `${candidateId} selected tuple preserves ${field}`);
      }
      if (candidateId === 'faulty') {
        assert.equal(tuple.sourceManifestSha256, expectedPublication.sourceManifestSha256);
        assert.equal(tuple.reviewManifestSha256, undefined, 'reference tuple has no human review identity');
      } else {
        for (const field of ['caseSetSha256', 'reportIdentitiesSha256', 'experimentId', 'reviewEnvironment', 'reviewRunId', 'reviewManifestSha256', 'reviewer']) {
          assert.equal(tuple[field], expectedPublication[field], `repaired tuple preserves ${field}`);
        }
      }
      assertActionReadback(result.action, { tuple });
      assert.equal(Object.hasOwn(context.fixture.endpoints[candidateId], 'targetVersion'), false,
        'the authentic settled AgentCore endpoint shape omits targetVersion');
      assert.ok(context.fixture.endpointReads.includes(candidateId));
      assert.ok(context.fixture.runtimeReads.includes(candidateId));
      assert.ok(context.fixture.strongReads >= 3, 'publication and selected records use strong readback');
      assert.ok(selectionWrites(context).length >= 1, 'selection must be persisted under AGENT_SELECTION');
      assert.equal(context.fixture.publications[candidateId].candidateId, candidateId,
        'publisher-owned candidate rows remain distinct from the selected record');
      assert.deepEqual(context.fixture.rows.get(`AGENT_PUBLICATION#${candidateId}`), publicationBefore,
        'controller selection is read-only against the publisher-owned candidate row');
      assert.ok(context.fixture.s3Reads.some((key) => candidateId === 'faulty'
        ? key.includes(expectedPublication.configurationSha256)
        : key.includes(expectedPublication.artifactSha256)),
      'verified readback must consume the candidate-bound configuration object');
      if (candidateId === 'repaired') {
        assert.ok(context.fixture.s3Reads.some((key) => key.includes(expectedPublication.artifactSha256) && key.endsWith('/runtime-configuration.json')),
          'repaired configuration read uses the staged object path derived from the artifact digest');
        assert.ok(!context.fixture.s3Reads.some((key) => key.includes(expectedPublication.configurationSha256) && key.endsWith('/runtime-configuration.json')),
          'repaired configuration path is not incorrectly derived from its configuration digest');
      }
      verifyAdapterHandoff(context, candidateId, expectedPublication);
    }
  });

  await check('repeating the current verified selection is a no-op', async () => {
    context.reset({ selectedCandidate: 'faulty' });
    const before = structuredClone(selectedTuple(context));
    const result = await runSelection(context, 'faulty');
    assertActionReadback(result.action, { outcome: 'no_change', tuple: before });
    assert.deepEqual(selectedTuple(context), before);
    assert.equal(selectionWrites(context).length, 0, 'a repeated current selection must not write AGENT_SELECTION');
  });

  await check('missing initial selection can explicitly choose faulty', async () => {
    context.reset({ selectedCandidate: null });
    const result = await runSelection(context, 'faulty');
    const tuple = selectedTuple(context);
    assertActionReadback(result.action, { tuple });
    assert.equal(tuple.candidateId, 'faulty');
    assert.equal(selectionWrites(context).length, 1);
  });

  await check('same ID and same payload replay the saved result; changed payload conflicts', async () => {
    context.reset({ selectedCandidate: 'faulty' });
    const id = randomUUID();
    const first = await runSelection(context, 'repaired', { id });
    const firstCalls = context.fixture.invocations.length;
    const replay = await submit(context, 'repaired', { id });
    assert.equal(replay.response.statusCode, 200, replay.response.body);
    assert.deepEqual(replay.body.action, first.action, 'same ID/same payload returns the exact saved action');
    assert.equal(context.fixture.invocations.length, firstCalls, 'same ID replay does not dispatch another worker');

    await runSelection(context, 'faulty');
    const historical = await submit(context, 'repaired', { id });
    assert.equal(historical.response.statusCode, 200, historical.response.body);
    assert.deepEqual(historical.body.action, first.action, 'completed UUID remains a historical result after a later switch');
    assert.equal(selectedTuple(context).candidateId, 'faulty', 'historical retry cannot rewrite current selection');

    const conflict = await submit(context, 'faulty', { id });
    assert.equal(conflict.response.statusCode, 409, conflict.response.body);
    assert.equal(selectedTuple(context).candidateId, 'faulty');
  });

  await check('reconciles an ambiguous selected-record write through strong readback', async () => {
    context.reset({ selectedCandidate: 'faulty' });
    context.fixture.loseSelectionResponse = true;
    const result = await runSelection(context, 'repaired');
    assert.equal(result.action.status, 'completed', result.action.error);
    assert.equal(result.action.configurationOutcome, 'applied');
    assert.equal(selectedTuple(context).candidateId, 'repaired');
    assert.ok(selectionWrites(context).length >= 1);
    assert.ok(context.fixture.writes.some(({ type, body }) => type === 'transaction' &&
      (body.TransactItems ?? []).some((item) => item.Put?.Item?.pk?.S === selectionKey)),
    'the durable write and later strong readback are observable even when its response is lost');
  });

  await check('accepts only an authenticated candidate label and rejects query/tuple injection', async () => {
    context.reset({ selectedCandidate: 'faulty' });
    const beforeCalls = context.fixture.calls.length;
    const unauthenticated = await submit(context, 'repaired', { headers: { authorization: 'Bearer wrong' } });
    assert.equal(unauthenticated.response.statusCode, 401);
    assert.equal(context.fixture.calls.length - beforeCalls, 1, 'auth rejection only reads the operator secret');
    assert.equal(selectionWrites(context).length, 0, 'auth rejection cannot write a selection');

    const extraTuple = await submit(context, 'repaired', {
      body: { endpointArn: `${runtimeArn}/runtime-endpoint/repaired`, runtimeVersion: '20' },
    });
    assert.equal(extraTuple.response.statusCode, 400, extraTuple.response.body);
    assert.equal(selectionWrites(context).length, 0);

    const query = await submit(context, 'repaired', { query: 'candidateId=repaired' });
    assert.equal(query.response.statusCode, 400, query.response.body);
    assert.equal(selectionWrites(context).length, 0);
  });

  await check('rejects unknown, DEFAULT, and empty candidate labels without a publication lookup', async () => {
    for (const candidateId of ['unknown', 'DEFAULT', '']) {
      context.reset({ selectedCandidate: 'faulty' });
      const result = await submit(context, candidateId);
      assert.ok([400, 404].includes(result.response.statusCode), `${candidateId || '<empty>'}: ${result.response.body}`);
      assert.equal(selectionWrites(context).length, 0);
      assert.equal(context.fixture.endpointReads.length, 0);
      assert.equal(context.fixture.runtimeReads.length, 0);
    }
  });

  await check('rejects no active work, unresolved requests, unhealthy baseline, and native non-OK alarm before writing', async () => {
    const blockedStates = [
      ['active action', () => {
        const actionId = randomUUID();
        context.fixture.rows.set(`ACTION#${actionId}`, {
          pk: `ACTION#${actionId}`, revision: 1, data: {
            id: actionId, kind: 'traffic', command: { kind: 'traffic' }, status: 'running',
            claimBy: Date.now() + 10_000, deadlineAt: Date.now() + 60_000, discardAfter: Date.now() + 90_000,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), requests: [],
          },
        });
        const state = context.fixture.rows.get('STATE');
        state.data.currentActionId = actionId;
      }],
      ['unresolved checkout', () => { context.fixture.rows.get('STATE').data.unresolved = [{ checkoutId: 'pending-1', status: 'unknown' }]; }],
      ['unhealthy baseline', () => { context.fixture.rows.get('STATE').data.baseline = null; }],
      ['native non-OK alarm', () => { context.fixture.alarmState = 'ALARM'; }],
    ];
    for (const [label, prepare] of blockedStates) {
      await check(label, async () => {
        context.reset({ selectedCandidate: 'faulty' });
        prepare();
        const result = await submit(context, 'repaired');
        assert.equal(result.response.statusCode, 409, `${label}: ${result.response.body}`);
        assert.equal(selectionWrites(context).length, 0, `${label}: no selection write`);
        assert.equal(context.fixture.invocations.length, 0, `${label}: no worker dispatch`);
      });
    }
  });

  await check('keeps the previous selection when readiness is uncertain or a native identity is stale', async () => {
    const cases = [
      ['endpoint not ready', () => { context.fixture.endpoints.repaired.status = 'CREATING'; }],
      ['endpoint live version differs', () => { context.fixture.endpoints.repaired.liveVersion = '19'; }],
      ['endpoint ARN differs', () => { context.fixture.endpoints.repaired.agentRuntimeEndpointArn = `${repairedEndpoint}-stale`; }],
      ['endpoint target version diverges', () => { context.fixture.endpoints.repaired.targetVersion = '19'; }],
      ['publication runtime version is stale', () => { context.fixture.rows.get('AGENT_PUBLICATION#repaired').runtimeVersion = '21'; }],
      ['publication source identity is stale', () => { context.fixture.rows.get('AGENT_PUBLICATION#repaired').sourceRevision = 'f'.repeat(40); }],
      ['Runtime environment candidate identity is stale', () => { context.fixture.runtimes.repaired.environmentVariables.AGENT_CANDIDATE_ID = 'faulty'; }],
      ['Runtime non-environment configuration is stale', () => { context.fixture.runtimes.repaired.lifecycleConfiguration.maxLifetime = 601; }],
      ['native artifact VersionId is stale', () => { context.fixture.runtimes.repaired.agentRuntimeArtifact.codeConfiguration.code.s3.versionId = 'wrong-version'; }],
    ];
    for (const [label, prepare] of cases) {
      await check(label, async () => {
        context.reset({ selectedCandidate: 'faulty' });
        prepare();
        const before = structuredClone(selectedTuple(context));
        const result = await runSelection(context, 'repaired');
        assert.ok(['failed', 'incomplete'].includes(result.action.status), `${label}: ${result.action.status}`);
        assert.equal(result.action.configurationOutcome, 'unknown', `${label}: uncertain state is not applied`);
        assert.deepEqual(selectedTuple(context), before, `${label}: previous selection is retained`);
        assert.equal(selectionWrites(context).length, 0, `${label}: no selected record write`);
      });
    }
  });

  await check('a same-label selection still validates changed publication and native identities', async () => {
    context.reset({ selectedCandidate: 'repaired' });
    context.fixture.rows.get('AGENT_PUBLICATION#repaired').runtimeVersion = '21';
    const before = structuredClone(selectedTuple(context));
    const result = await runSelection(context, 'repaired');
    assert.ok(['failed', 'incomplete'].includes(result.action.status));
    assert.notEqual(result.action.configurationOutcome, 'no_change', 'changed identity cannot take the no-op shortcut');
    assert.deepEqual(selectedTuple(context), before);
    assert.equal(selectionWrites(context).length, 0);
  });

  await check('fails closed on absent or unavailable prepared/readiness records', async () => {
    const cases = [
      ['missing publication', () => { context.fixture.publications.repaired = undefined; context.fixture.rows.delete('AGENT_PUBLICATION#repaired'); }],
      ['endpoint read unavailable', () => { context.fixture.endpointMode = 'unavailable'; }],
      ['Runtime read unavailable', () => { context.fixture.runtimeMode = 'unavailable'; }],
      ['selected read unavailable after write', () => { context.fixture.selectionReadMode = 'unavailable-after-write'; }],
      ['selected readback has a mismatched candidate', () => { context.fixture.selectionReadbackOverride = { pk: selectionKey, candidateId: 'faulty', endpointName: 'faulty' }; }],
      ['tampered original configuration bytes', () => {
        const key = [...context.fixture.s3Objects.keys()].find((value) => value.includes('runtime-configuration.json') && value.includes('1f8e45fedee78cc9cc60c8b777c2b3ef51eee53ac00909a3bbf499c78de28cf7'));
        assert.ok(key);
        context.fixture.s3Objects.get(key).body = '{}';
      }],
    ];
    for (const [label, prepare] of cases) {
      await check(label, async () => {
        context.reset({ selectedCandidate: 'faulty' });
        prepare();
        const before = structuredClone(selectedTuple(context));
        const result = await runSelection(context, 'repaired');
        assert.ok(['failed', 'incomplete'].includes(result.action.status), `${label}: ${result.action.status}`);
        assert.notEqual(result.action.configurationOutcome, 'applied');
        if (label.includes('selected read')) {
          assert.notEqual(result.action.status, 'completed', `${label}: mismatched/unavailable readback cannot claim completion`);
        } else {
          assert.deepEqual(selectedTuple(context), before);
        }
        if (label.includes('selected read')) assert.equal(selectionWrites(context).length, 1);
        else assert.equal(selectionWrites(context).length, 0);
      });
    }
  });

  await check('never calls AgentCore inference or changes an endpoint', async () => {
    context.reset({ selectedCandidate: 'faulty' });
    const result = await runSelection(context, 'repaired');
    assert.equal(result.action.status, 'completed', result.action.error);
    assert.equal(context.fixture.invocations.length, 1, 'only the normal queued controller-worker delivery is invoked');
    assert.ok(context.fixture.calls.every(({ target, method }) => !/InvokeAgentRuntime|UpdateAgentRuntimeEndpoint|CreateAgentRuntimeEndpoint/.test(`${target} ${method}`)),
      'selection must not invoke or repin an AgentCore endpoint');
    assert.ok(context.fixture.calls.every(({ target, method }) => !/UpdateFunctionConfiguration|UpdateAlias/.test(`${target} ${method}`)),
      'selection must not repin the alarm adapter or application aliases');
  });

  await check('a queued selection fails closed if the alarm becomes ALARM before worker claim', async () => {
    context.reset({ selectedCandidate: 'faulty' });
    const before = structuredClone(selectedTuple(context));
    const accepted = await submit(context, 'repaired');
    assert.equal(accepted.response.statusCode, 202, accepted.response.body);
    context.fixture.alarmState = 'ALARM';
    await context.worker.handler({ actionId: accepted.id });
    const action = await readAction(context, accepted.id);
    assert.ok(['failed', 'incomplete'].includes(action.status));
    assert.notEqual(action.configurationOutcome, 'applied');
    assert.deepEqual(selectedTuple(context), before);
    assert.equal(selectionWrites(context).length, 0);
  });

  await check('GET /api/alarm remains read-only and observes the selected endpoint after a switch', async () => {
    context.reset({ selectedCandidate: 'faulty' });
    await runSelection(context, 'repaired');
    const writesBefore = context.fixture.writes.length;
    const response = await context.api.handler(event('GET', '/api/alarm'));
    assert.equal(response.statusCode, 200, response.body);
    const body = await json(response);
    assert.equal(body.alarm.state, 'OK');
    assert.equal(body.agentEndpoint.endpointArn, context.fixture.endpoints.repaired.agentRuntimeEndpointArn);
    assert.equal(context.fixture.writes.length, writesBefore, 'alarm read must not mutate selected or publisher records');
    assert.equal(context.fixture.invocations.length, 1, 'alarm read must not invoke the agent');
    context.fixture.endpoints.repaired.status = 'CREATING';
    const notReady = await context.api.handler(event('GET', '/api/alarm'));
    assert.equal(notReady.statusCode, 200, notReady.body);
    assert.equal((await json(notReady)).agentEndpoint.state, 'not_ready', 'a native non-READY response is definitive, not an unavailable read');
    context.fixture.endpoints.repaired.status = 'READY';
    context.fixture.endpointMode = 'unavailable';
    const unavailable = await context.api.handler(event('GET', '/api/alarm'));
    assert.equal(unavailable.statusCode, 200, unavailable.body);
    assert.equal((await json(unavailable)).agentEndpoint.state, 'unavailable', 'a failed native read remains unavailable');
    const adapterRead = context.fixture.calls.findLast(({ target }) => target.endsWith('GetFunctionConfiguration'));
    if (adapterRead) {
      assert.deepEqual(adapterRead.body, {
        FunctionName: adapterArn,
      });
      assert.notEqual(selectorAdapterCodeSha256, context.fixture.publications.repaired.adapterCodeSha256,
        'the current selector adapter release is distinct from historical publisher adapter provenance');
    }
  });

  if (failures.length) assert.fail(failures.join('\n\n'));
});

