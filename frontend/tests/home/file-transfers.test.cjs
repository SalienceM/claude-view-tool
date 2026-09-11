const assert = require('node:assert/strict');
const { test } = require('node:test');
const { FileTransferManager } = require('../../.home-test-dist/utils/fileTransfers.js');

test('deletion locks workspace transfers and cannot pretend to cancel remote deletion', () => {
  const manager = new FileTransferManager();
  const job = manager.start('node:/workspace', 'session A', 'delete', 'directory');
  assert.equal(manager.start('node:/workspace', 'session B', 'push', 'file'), undefined);
  manager.cancel(job);
  assert.equal(job.abort.current, false);
  manager.finish(job, 'deleted');
  assert.ok(manager.start('node:/workspace', 'session B', 'push', 'file'));
});

test('transfer survives panel unsubscribe and is visible after subscribing again', async () => {
  const manager = new FileTransferManager();
  let notifications = 0;
  const unsubscribe = manager.subscribe(() => notifications++);
  const job = manager.start('node:/workspace', 'session A', 'push', 'file.bin');
  unsubscribe();
  await Promise.resolve();
  manager.progress(job, { ...job.progress, doneBytes: 32, totalBytes: 64 });
  assert.equal(notifications, 1);
  assert.equal(manager.active('node:/workspace'), job);
  assert.equal(manager.getSnapshot()[0].progress.doneBytes, 32);
  manager.subscribe(() => notifications++);
  manager.finish(job, 'uploaded');
  assert.equal(notifications, 2);
  assert.equal(job.status, 'done');
  assert.equal(manager.active('node:/workspace'), undefined);
});

test('same workspace cannot overlap while another executor can transfer', () => {
  const manager = new FileTransferManager();
  const original = manager.start('nodeA:/work', 'session A', 'push', 'file');
  assert.equal(manager.start('nodeA:/work', 'session B', 'pull', 'file'), undefined);
  assert.ok(manager.start('nodeB:/work', 'session C', 'push', 'file'));
  manager.cancel(original);
  assert.equal(original.abort.current, true);
  assert.equal(manager.start('nodeA:/work', 'session B', 'push', 'file'), undefined);
  manager.finish(original, 'cancelled', true);
  assert.equal(original.status, 'cancelled');
  assert.ok(manager.start('nodeA:/work', 'session B', 'push', 'file'));
});

test('completion status stays visible until dismissed and active jobs cannot be dismissed', () => {
  const manager = new FileTransferManager();
  const job = manager.start('node:/work', 'session', 'pull', 'file');
  const previousSnapshot = manager.getSnapshot();
  manager.dismiss(job);
  assert.equal(manager.getSnapshot().length, 1);
  manager.finish(job, 'connection lost', true);
  assert.notEqual(manager.getSnapshot(), previousSnapshot);
  assert.equal(job.status, 'error');
  manager.dismiss(job);
  assert.equal(manager.getSnapshot().length, 0);
});
