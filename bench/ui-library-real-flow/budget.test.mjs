import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Budget, createBroker, SCOPE, verifyApproval } from './budget.mjs';

// Synthetic records only; these are not live authorization.
const records = () => [
  { kind: 'question', id: 'q', scope: SCOPE, provenance: 'execution-history', reference: 'synthetic:q', options: [{ id: 'yes', caps: { runs: 2, requests: 3, tokens: 100 } }] },
  { kind: 'answer', id: 'a', questionId: 'q', selectedOption: 'yes', actor: 'human', approved: true, scope: SCOPE, provenance: 'execution-history', reference: 'synthetic:a' },
];

for (const [name, transform] of [
  ['missing', () => undefined],
  ['ambiguous', (r) => [...r, r[1]]],
  ['withdrawn', (r) => [...r, { kind: 'withdrawal', scope: SCOPE }]],
  ['changed', (r) => [...r, { kind: 'change', scope: SCOPE }]],
  ['plan-only', (r) => r.map((v) => ({ ...v, provenance: 'plan' }))],
  ['summary-only', (r) => r.map((v) => ({ ...v, provenance: 'summary' }))],
  ['automated reviewer', (r) => [r[0], { ...r[1], actor: 'automated-reviewer' }]],
  ['missing question', (r) => [r[1]]],
  ['missing cap', (r) => [{ ...r[0], options: [{ id: 'yes', caps: { runs: 2 } }] }, r[1]]],
]) {
  test(`rejects ${name} with zero transport calls`, async () => {
    let calls = 0;
    await assert.rejects(async () => {
      const broker = createBroker({ enabled: true, records: transform(records()), transport: async () => { calls++; } });
      await broker.request({ runId: 1, reserveTokens: 20, body: {} });
    });
    assert.equal(calls, 0);
  });
}

test('disabled by default even with synthetic valid records', async () => {
  let calls = 0;
  const broker = createBroker({ records: records(), transport: () => { calls++; } });
  await assert.rejects(broker.request({}), /disabled/);
  assert.equal(calls, 0);
});

test('copies exact caps and approval references', () => {
  assert.deepEqual(verifyApproval(records()), { caps: { runs: 2, requests: 3, tokens: 100 }, references: ['synthetic:q', 'synthetic:a'] });
});

test('reserves concurrent usage and retains interrupted attempts', async () => {
  let calls = 0;
  const broker = createBroker({ enabled: true, records: records(), transport: async () => { calls++; throw new Error('interrupted'); } });
  const runId = broker.budget.startRun();
  await assert.rejects(broker.request({ runId, reserveTokens: 60, body: {} }), /interrupted/);
  await assert.rejects(broker.request({ runId, reserveTokens: 60, body: {} }), /exhausted/);
  assert.equal(calls, 1);
  assert.equal(broker.budget.ledger.requests[0].state, 'interrupted');
});

test('counts all requests and usage categories; enforces per-run and global caps', async () => {
  let calls = 0;
  const broker = createBroker({ enabled: true, records: records(), transport: async () => { calls++; return { usage: { input: 1, cacheRead: 2, output: 3 } }; } });
  const runId = broker.budget.startRun({ maxRequests: 1 });
  await broker.request({ runId, reserveTokens: 20, body: {} });
  await assert.rejects(broker.request({ runId, reserveTokens: 20, body: {} }), /exhausted/);
  const second = broker.budget.startRun();
  await broker.request({ runId: second, reserveTokens: 20, body: {} });
  await broker.request({ runId: second, reserveTokens: 20, body: {} });
  await assert.rejects(broker.request({ runId: second, reserveTokens: 20, body: {} }), /exhausted/);
  assert.throws(() => broker.budget.startRun(), /exhausted/);
  assert.equal(calls, 3);
  assert.equal(broker.budget.ledger.reservedTokens, 18);
});

test('unknown usage retains full reservation and expired runs cannot dispatch', () => {
  const budget = new Budget(records());
  const id = budget.startRun();
  budget.settle(budget.reserve(id, 80));
  assert.equal(budget.ledger.reservedTokens, 80);
  budget.ledger.runs[0].deadline = 0;
  assert.throws(() => budget.reserve(id, 1), /expired/);
});
