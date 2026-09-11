const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildLocalManifestTree } = require('../../.home-test-dist/utils/localFileTree.js');

test('large local tree yields to UI and retains every file', async () => {
  const manifest = {};
  for (let index = 0; index < 10000; index++) manifest['dir/file' + index] = { size: index };
  let ticked = false;
  setTimeout(() => { ticked = true; }, 0);
  const tree = await buildLocalManifestTree(manifest, new AbortController().signal);
  assert.equal(ticked, true);
  assert.equal(tree.dir.length, 10000);
  assert.equal(tree[''].length, 1);
});

test('leaving panel cancels a pending tree build', async () => {
  const controller = new AbortController();
  const manifest = {};
  for (let index = 0; index < 1000; index++) manifest['file' + index] = { size: 1 };
  const pending = buildLocalManifestTree(manifest, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
