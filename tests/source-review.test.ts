import test from 'node:test';
import assert from 'node:assert/strict';
import { revisionStatus } from '@client/source-review';

const saved = {attention: null, savedSource: true, checking: true};

test('saved check hydration closed -> initializing -> idle keeps one revision status', () => {
  const seen = [
    revisionStatus({...saved, status: 'closed', inactive: true}),
    revisionStatus({...saved, status: 'initializing', inactive: false}),
    revisionStatus({...saved, status: 'idle', inactive: true}),
  ];
  assert.deepEqual(seen, ['inactive', 'inactive', 'inactive']);
});

test('initializing outside an explicit saved check invalidates', () => {
  assert.equal(revisionStatus({...saved, status: 'initializing', inactive: false, checking: false}), 'initializing');
  assert.equal(revisionStatus({...saved, status: 'initializing', inactive: false, savedSource: false}), 'initializing');
  assert.equal(revisionStatus({...saved, status: 'initializing', inactive: false, attention: 'permission'}), 'initializing');
});

test('busy, error and permission states invalidate even during a saved check', () => {
  for (const status of ['running', 'error', 'closed', 'idle']) {
    assert.equal(revisionStatus({...saved, status, inactive: false}), status);
  }
  assert.equal(revisionStatus({...saved, status: 'idle', inactive: false, attention: 'permission'}), 'idle');
});
