import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readlink, lstat, rename, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect, capture, restore, git, safePath, secretPath, scanBytes, requireUnchanged, requireReturnUnchanged } from '@server/git-state';

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), 'paseo-handoff-test-'));
  const root = path.join(base, 'source'); await mkdir(root);
  await git(root, 'init', '--initial-branch=main');
  await git(root, 'config', 'user.name', 'Handoff fixture'); await git(root, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(root, 'file.txt'), 'base\n'); await writeFile(path.join(root, 'removed.txt'), 'remove me\n');
  await writeFile(path.join(root, '.gitignore'), 'ignored/\n.env\n');
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'test: initial fixture');
  return {base, root};
}
test('round trip preserves staged, unstaged, deletion, binary, executable, untracked and relative cwd', async () => {
  const {base, root} = await fixture();
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'ignored'));
  await writeFile(path.join(root, 'ignored', 'private.txt'), 'excluded');
  await writeFile(path.join(root, 'file.txt'), 'staged\n'); await git(root, 'add', 'file.txt');
  await writeFile(path.join(root, 'file.txt'), 'staged\nunstaged\n');
  await git(root, 'rm', 'removed.txt');
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([0,1,128,255])); await git(root, 'add', 'binary.bin');
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([0,2,129,255]));
  await writeFile(path.join(root, 'src', 'run.sh'), '#!/bin/sh\necho fixture\n'); await chmod(path.join(root, 'src', 'run.sh'), 0o755);
  const before = await inspect(path.join(root, 'src'));
  assert.deepEqual(before.counts, {staged: 3, unstaged: 2, untracked: 1});
  assert.deepEqual(before.ignored, ['ignored/private.txt']);
  const pkg = await capture(path.join(root, 'src'), path.join(base, 'capture'), before);
  const result = await restore(pkg, path.join(base, 'destination'));
  assert.equal(result.fingerprint, before.fingerprint);
  assert.equal(result.relativeCwd, 'src');
  assert.deepEqual(await readFile(path.join(result.root, 'binary.bin')), Buffer.from([0,2,129,255]));
  requireUnchanged(before, await inspect(path.join(root, 'src')));
  await assert.rejects(restore(pkg, path.join(base, 'destination')), /EEXIST/);
});
test('snapshot detects edits since review and stops return divergence', async () => {
  const {base, root} = await fixture(); const before = await inspect(root);
  await writeFile(path.join(root, 'file.txt'), 'edited\n'); const after = await inspect(root);
  assert.throws(() => requireUnchanged(before, after), /changed/);
  assert.throws(() => requireReturnUnchanged(before, after), /divergence/);
  await assert.rejects(capture(root, path.join(base, 'capture'), before), /changed/);
});
test('reject traversal, control, git metadata, absolute and nonportable paths', () => {
  for (const p of ['../x','/tmp/x','a/../../x','.git/config','x/.GIT/HEAD','x\\y','x\nq','a//b','a/./b','x:stream','a.','cafe\u0301']) assert.throws(() => safePath(p));
  safePath('nested/a file.txt');
});
test('unsafe untracked and staged symlinks identify the blocked path', async () => {
  const {root} = await fixture(); await symlink('/tmp', path.join(root, 'link'));
  await assert.rejects(inspect(root), /link is an untracked symlink/); await git(root, 'add', 'link');
  await assert.rejects(inspect(root), /link has an absolute/);
});
test('tracked symlinks retain target bytes, mode and staged/unstaged distinction through restore', async () => {
  const {root,base} = await fixture();
  await symlink('file.txt',path.join(root,'AGENTS.md'));await git(root,'add','.');await git(root,'commit','-m','test: tracked link');
  await rename(path.join(root,'AGENTS.md'),path.join(base,'old-link'));await symlink('removed.txt',path.join(root,'AGENTS.md'));await git(root,'add','AGENTS.md');
  await rename(path.join(root,'AGENTS.md'),path.join(base,'staged-link'));await symlink('file.txt',path.join(root,'AGENTS.md'));
  const before=await inspect(root);
  assert.deepEqual(before.files.find(f=>f.path==='AGENTS.md'),{path:'AGENTS.md',hash:(await import('@server/git-state')).hash('file.txt'),size:8,mode:0o120000,linkTarget:'file.txt'});
  assert.deepEqual(before.counts,{staged:1,unstaged:1,untracked:0});
  const restored=await restore(await capture(root,path.join(base,'capture'),before),path.join(base,'destination'));
  assert.equal(restored.fingerprint,before.fingerprint);assert((await lstat(path.join(restored.root,'AGENTS.md'))).isSymbolicLink());
  assert.equal(await readlink(path.join(restored.root,'AGENTS.md')),'file.txt');
  requireUnchanged(before,await inspect(root));
});
test('reject tracked symlink escapes, chains, directories, dangling and ignored targets', async () => {
  for(const target of ['../file.txt','/tmp/file.txt','missing.txt','.env','folder','second']) {
    const {root}=await fixture();await mkdir(path.join(root,'folder'));await writeFile(path.join(root,'folder','file'),'ok');
    await symlink('file.txt',path.join(root,'second'));await symlink(target,path.join(root,'link'));await git(root,'add','.');
    await assert.rejects(inspect(root),/Blocked: link/);
  }
});
test('reject symlink ancestors and unsafe link introduced only in unstaged state', async()=>{
  const {root,base}=await fixture();await mkdir(path.join(root,'folder'));await writeFile(path.join(root,'folder','file'),'ok');await git(root,'add','.');
  await rename(path.join(root,'folder'),path.join(base,'original-folder'));await symlink(base,path.join(root,'folder'));
  await assert.rejects(inspect(root),/folder/);
  await rename(path.join(root,'folder'),path.join(base,'unsafe-link'));await rename(path.join(base,'original-folder'),path.join(root,'folder'));
  await rename(path.join(root,'file.txt'),path.join(base,'original-file'));await symlink('/etc/passwd',path.join(root,'file.txt'));
  await assert.rejects(inspect(root),/file.txt has an absolute/);
});
test('secret file names and content block; ignored secrets excluded', async () => {
  const {root} = await fixture(); await writeFile(path.join(root, '.env'), 'secret value not transferred');
  const s = await inspect(root); assert.deepEqual(s.ignored, ['.env']);
  await writeFile(path.join(root, 'key.pem'), 'fixture'); await assert.rejects(inspect(root), /Credential/);
  assert(secretPath('.aws/credentials')); assert(!secretPath('.env.example'));
  assert.throws(() => scanBytes(Buffer.from('-----BEGIN ' + 'PRIVATE KEY-----')), /secret/);
});
test('historical secrets block bundle even after deletion', async () => {
  const {root, base} = await fixture(); await writeFile(path.join(root, 'credentials.json'), '{}');
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'test: historical credential path');
  await git(root, 'rm', 'credentials.json'); await git(root, 'commit', '-m', 'test: removed');
  await assert.rejects(capture(root, path.join(base, 'capture'), await inspect(root)), /history/);
});
test('history audits every filename even when credential and safe paths share a blob', async () => {
  const {root, base} = await fixture();
  await writeFile(path.join(root, 'credentials.json'), 'base\n');
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'test: shared historical blob');
  await git(root, 'rm', 'credentials.json'); await git(root, 'commit', '-m', 'test: removed alias');
  await assert.rejects(capture(root, path.join(base, 'capture'), await inspect(root)), /history/);
});
test('assume-unchanged and intent-to-add fail explicitly', async () => {
  const {root} = await fixture(); await git(root, 'update-index', '--assume-unchanged', 'file.txt');
  await assert.rejects(inspect(root), /index flags/);
  await git(root, 'update-index', '--no-assume-unchanged', 'file.txt');
  await writeFile(path.join(root, 'new.txt'), 'new'); await git(root, 'add', '-N', 'new.txt');
  await assert.rejects(inspect(root), /Intent-to-add/);
});
test('LFS pointers and sparse checkout blocked', async () => {
  const {root} = await fixture(); await git(root, 'config', 'core.sparseCheckout', 'true');
  await assert.rejects(inspect(root), /Sparse/);
  assert.throws(() => scanBytes(Buffer.from('version https://git-lfs.github.com/spec/v1\n')), /LFS/);
});
test('tampered bundle rejected before destination creation', async () => {
  const {root, base} = await fixture(); const pkg = await capture(root, path.join(base, 'capture'), await inspect(root));
  await assert.rejects(restore({...pkg, bundleHash: 'incorrect'}, path.join(base, 'destination')), /checksum/);
  await assert.rejects(restore({...pkg, snapshot:{...pkg.snapshot,head:'--help'}}, path.join(base,'bad-commit')), /Invalid snapshot commit/);
});
test('local Git filters cannot execute during preview', async () => {
  const {root} = await fixture();
  await git(root, 'config', 'filter.test.clean', 'false');
  await assert.rejects(inspect(root), /Git filters/);
});
test('included and worktree Git filters are rejected before content conversion', async () => {
  for (const scope of ['include', 'worktree']) {
    const {root, base} = await fixture();
    if (scope === 'include') {
      await writeFile(path.join(base, 'included.config'), '[filter "probe"]\nclean = false\n');
      await git(root, 'config', 'include.path', path.join(base, 'included.config'));
    } else {
      await git(root, 'config', 'extensions.worktreeConfig', 'true');
      await git(root, 'config', '--worktree', 'filter.probe.clean', 'false');
    }
    await assert.rejects(inspect(root), /Git filters/);
  }
});
test('binary staged secrets cannot hide behind safe unstaged bytes', async () => {
  const {root} = await fixture();
  await writeFile(path.join(root, 'binary.bin'), Buffer.from('\0-----BEGIN ' + 'PRIVATE KEY-----\0'));
  await git(root, 'add', 'binary.bin');
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
  await assert.rejects(inspect(root), /Potential secret/);
});
