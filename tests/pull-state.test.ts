import test from 'node:test';
import assert from 'node:assert/strict';
import { canRecoverReturn, onlyPull, pullStartBlockers } from '@client/pull-state';

const P = 'parent-1';
const ok = {receipts: [], readable: true, parentOperationId: P, reviewed: true, candidateBlocker: null, submittedOperationId: undefined, startErrored: false, hasSecureId: true};

test('fresh review, readable empty receipts, no blocker: Start allowed', () => {
  assert.deepEqual(pullStartBlockers(ok), []);
});

test('an existing return for the parent blocks in any state; other parents do not', () => {
  for (const state of ['ready', 'failed', 'canceled', 'blocked']) assert.ok(pullStartBlockers({...ok, receipts: [{id: 'r', state, parentOperationId: P}]}).length);
  assert.deepEqual(pullStartBlockers({...ok, receipts: [{id: 'r', state: 'ready', parentOperationId: 'other'}]}), []);
});

test('unknown or failed receipt reads, missing review, candidate blocker and missing id all block', () => {
  assert.ok(pullStartBlockers({...ok, readable: false}).length);
  assert.ok(pullStartBlockers({...ok, receipts: undefined}).length);
  assert.ok(pullStartBlockers({...ok, reviewed: false}).length);
  assert.ok(pullStartBlockers({...ok, parentOperationId: null}).length);
  assert.deepEqual(pullStartBlockers({...ok, candidateBlocker: 'Source is archived.'})[0], 'Source is archived.');
  assert.ok(pullStartBlockers({...ok, hasSecureId: false}).length);
});

test('errored Start blocks until its exact receipt appears (then the existing-return rule takes over)', () => {
  const errored = {...ok, startErrored: true, submittedOperationId: 'op-1'};
  assert.ok(pullStartBlockers(errored).some(b => b.includes('unknown')));
  assert.ok(!pullStartBlockers({...errored, receipts: [{id: 'op-1', state: 'ready', parentOperationId: 'other'}]}).some(b => b.includes('unknown')));
});

test('durable recovery survives remount but never retries allocated destination creation', () => {
  for (const state of ['failed', 'unverified']) {
    assert.equal(canRecoverReturn({id: 'op-1', state}), true);
    assert.equal(canRecoverReturn({id: 'op-1', state, destinationAgentId: 'a'}), false);
  }
  for (const state of ['queued', 'capturing', 'activating', 'ready', 'canceled'])
    assert.equal(canRecoverReturn({id: 'op-1', state}), false);
});

test('only pull receipts are listed', () => {
  assert.deepEqual(onlyPull([{id: 'a', state: 'ready', direction: 'push'}, {id: 'b', state: 'ready', direction: 'pull'}, {id: 'c', state: 'ready'}])?.map(o => o.id), ['b']);
});
