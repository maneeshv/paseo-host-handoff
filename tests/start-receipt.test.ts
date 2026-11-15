import test from 'node:test';
import assert from 'node:assert/strict';
import { receiptStartBlocker, hasReceiptFor, receiptPollMs } from '@client/start-receipt';

const idle = {pending: false, errored: false, operationId: undefined};

test('polls while Start is pending even with an empty receipt list', () => {
  assert.equal(receiptPollMs([], {...idle, pending: true, operationId: 'op-1'}), 2000);
  assert.equal(receiptPollMs(undefined, {...idle, pending: true, operationId: 'op-1'}), 2000);
});

test('after a Start RPC error, polls until that exact receipt appears, ignoring unrelated old receipts', () => {
  const errored = {pending: false, errored: true, operationId: 'op-1'};
  assert.equal(receiptPollMs([{id: 'old', state: 'ready'}], errored), 2000);
  assert.equal(receiptPollMs([{id: 'op-1', state: 'ready'}], errored), false);
  assert.equal(receiptPollMs([{id: 'op-1', state: 'restoring'}], errored), 2000);
});

test('keeps existing queued/active polling and stops when settled', () => {
  for (const state of ['queued', 'checking', 'capturing', 'restoring', 'verifying', 'activating']) assert.equal(receiptPollMs([{id: 'a', state}], idle), 2000);
  for (const state of ['ready', 'failed', 'unverified', 'blocked', 'canceled', 'needs_review']) assert.equal(receiptPollMs([{id: 'a', state}], idle), false);
});

test('receipt for the submitted operation wins only on exact id match', () => {
  assert.equal(hasReceiptFor([{id: 'old', state: 'ready'}], 'op-1'), false);
  assert.equal(hasReceiptFor([{id: 'op-1', state: 'ready'}], 'op-1'), true);
  assert.equal(hasReceiptFor([{id: 'op-1', state: 'ready'}], undefined), false);
});

test('active and unverified receipts block a new Start even after the exact receipt arrives', () => {
  for (const state of ['checking','capturing','restoring','verifying','activating','unverified']) {
    const receipts=[{id:'submitted',state}];
    assert.equal(hasReceiptFor(receipts,'submitted'),true);
    assert.ok(receiptStartBlocker(receipts,true));
  }
  for (const state of ['queued', 'ready', 'failed']) assert.equal(receiptStartBlocker([{id: 'a', state}],true), null);
});

test('loading or failed receipt reads cannot clear the durable operation guard', () => {
  assert.ok(receiptStartBlocker(undefined,false));
  assert.ok(receiptStartBlocker(undefined,true));
  assert.ok(receiptStartBlocker([],false));
  assert.ok(receiptStartBlocker([{id:'old',state:'ready'}],false));
  assert.equal(receiptStartBlocker([],true),null);
});
