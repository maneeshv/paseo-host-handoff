import test from 'node:test';
import assert from 'node:assert/strict';
import {captureError} from '@server/capture-error';
test('capture failures expose only fixed categories, never arbitrary content or paths',()=>{
  for(const message of ['provider leaked PRIVATE_SENTINEL','Blocked: PRIVATE_SENTINEL','Credential-like tracked path PRIVATE_SENTINEL','Source identity changed PRIVATE_SENTINEL','anything exceeds a limit PRIVATE_SENTINEL'])assert(!captureError(Error(message)).includes('PRIVATE_SENTINEL'));
  assert.match(captureError(Error('Curated chat contains a potential secret.')),/Curated chat triggered/);
  assert.match(captureError(Error('Potential secret detected; content hidden')),/Repository content/);
  assert.match(captureError(Error('Chat history incomplete.')),/incomplete/);
  assert.match(captureError(Error('Git prerequisite or snapshot check failed')),/lazy fetching remains disabled/);
});
