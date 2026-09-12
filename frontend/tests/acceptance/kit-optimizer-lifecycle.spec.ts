import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';

async function optimizerFixture(page: Page) {
  const kit = {
    id: 'optimizer-qa', title: '启动 ActiveDraw Tauri 版', description: '',
    objective: '测试优化恢复', successCriteria: '', safetyConstraints: '', references: [],
    implementationSummary: '', generationWarnings: [], generatedByAi: false,
    executionTarget: 'executor', command: 'Write-Output fixture', shell: 'powershell', cwd: '.',
    timeoutSeconds: 300, inputs: [], assertions: [], outputs: [], dependencies: [], steps: [],
    schedule: { mode: 'manual', intervalSeconds: 300, nextRunAt: null },
    view: { default: 'summary', showLogs: true, showData: true, showTerminal: true },
    enabled: false, controlMode: 'shared', lastRunId: '', activeVersionId: 'v1',
    versions: [{ id: 'v1', version: '1.0', source: 'create', isActive: true, createdAt: 100 }],
    createdAt: 100, updatedAt: 300,
  };
  const messages: any[] = [
    { id: 'old-user', role: 'user', content: '原来的优化要求：增加启动后的复核', status: 'done', createdAt: 100 },
    { id: 'old-assistant', role: 'assistant', content: '此前的讨论仍然保留。', status: 'done', createdAt: 101 },
  ];
  let running = false;
  let sessionId = '';
  let holdHistory = false;
  let holdBackends = false;
  let failStart = false;
  const historyReplies: (() => void)[] = [];
  const backendReplies: (() => void)[] = [];
  const sockets: WebSocketRoute[] = [];
  const starts: any[] = [];
  const forbidden: string[] = [];
  const snapshot = () => JSON.parse(JSON.stringify({ status: 'ok', running, backendId: '', messages }));
  const state = () => ({
    status: 'ok', sessionId, kits: [{
      ...kit, optimizationRunning: running, optimizationMessageCount: messages.length,
      optimizationRevision: `${messages.at(-1)?.id}:${messages.at(-1)?.status}`,
    }], runs: [], artifacts: [], dataMarket: [], terminalConnectedKitIds: [],
  });
  const emit = () => sockets.forEach(socket => socket.send(JSON.stringify({ event: 'kitUpdated', data: JSON.stringify(state()) })));
  await page.routeWebSocket(/.*/, socket => {
    sockets.push(socket);
    const server = socket.connectToServer();
    socket.onMessage(raw => {
      let frame: any;
      try { frame = JSON.parse(String(raw)); } catch { server.send(raw); return; }
      const reply = (result: any) => socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify(result) }));
      if (frame.method === 'kitGetState') {
        sessionId = frame.params[0]; reply(state());
      } else if (frame.method === 'kitGenerationGet') {
        reply({ status: 'ok', job: null });
      } else if (frame.method === 'kitOptimizeGet') {
        const captured = snapshot();
        if (holdHistory) historyReplies.push(() => reply(captured));
        else reply(captured);
      } else if (frame.method === 'getBackends' && holdBackends) {
        backendReplies.push(() => socket.send(JSON.stringify({ id: frame.id, error: 'QA Backend list unavailable' })));
      } else if (frame.method === 'getBackends') {
        reply([{ id: 'fake-review', label: 'QA 评审 Backend', type: 'openai-compatible', enabled: true }]);
      } else if (frame.method === 'kitOptimizeStart') {
        if (failStart) { reply({ status: 'error', message: 'QA 提交失败，请重试' }); return; }
        if (running) { reply({ status: 'busy', message: 'Already running' }); return; }
        starts.push(frame.params);
        messages.push(
          { id: 'new-user', role: 'user', content: frame.params[2], status: 'done', createdAt: 200 },
          { id: 'new-assistant', role: 'assistant', content: '', status: 'answering', backendId: frame.params[3], createdAt: 201 },
        );
        running = true;
        emit();
        reply({ ...snapshot(), status: 'queued' });
      } else if (/^(kit|sendMessage)/.test(frame.method)) {
        // 所有优化提交都由上面的受控模型替身接收，绝不执行真实 Kit/发布/聊天。
        forbidden.push(frame.method);
        reply({ status: 'error', message: 'Blocked in QA' });
      } else server.send(raw);
    });
  });
  await page.goto('/');
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).first().click();
  await page.getByTitle('Workspace Kits · Session 标准配件（实验）').click();
  const panel = page.locator('.awu-kits-panel');
  await expect(panel.getByRole('button', { name: '✨ 优化', exact: true })).toBeVisible();
  return {
    starts, forbidden, historyReplies, backendReplies,
    open: () => panel.getByRole('button', { name: '✨ 优化', exact: true }).click(),
    holdHistory: (hold: boolean) => { holdHistory = hold; },
    holdBackends: (hold: boolean) => { holdBackends = hold; },
    failStart: (fail: boolean) => { failStart = fail; },
    emit,
    releaseHistory: () => { holdHistory = false; historyReplies.splice(0).forEach(reply => reply()); },
    releaseBackends: () => { holdBackends = false; backendReplies.splice(0).forEach(reply => reply()); },
    complete: () => {
      running = false;
      Object.assign(messages.at(-1), {
        status: 'done', content: '关闭窗口期间已生成完整候选。', ready: true,
        proposal: { command: 'Write-Output fixture-candidate' },
      });
      emit();
    },
  };
}

test('optimizer closes only with X, restores drafts and background results', async ({ page }, testInfo) => {
  const fixture = await optimizerFixture(page);
  await fixture.open();
  const dialog = page.getByRole('dialog', { name: '优化 Kit：启动 ActiveDraw Tauri 版' });
  const composer = dialog.getByPlaceholder('继续描述你不满意的地方、希望增加的步骤或更严格的成功标准…');
  const send = dialog.getByRole('button', { name: '发送并生成候选' });
  const close = dialog.getByRole('button', { name: '关闭优化窗口' });
  await expect(dialog.getByText('此前的讨论仍然保留。')).toBeVisible();
  await composer.fill('保持同一次优化，不重新开对话');
  await dialog.getByLabel('优化 Backend', { exact: true }).selectOption('fake-review');
  // 左侧遮罩仍在，不应误关闭；只通过关闭按钮退出。
  await page.locator('.awu-kit-optimizer-overlay').click({ position: { x: 2, y: 200 } });
  await expect(dialog).toBeVisible();
  await close.click();
  await expect(dialog).toBeHidden();
  await fixture.open();
  await expect(composer).toHaveValue('保持同一次优化，不重新开对话');
  await expect(dialog.getByLabel('优化 Backend', { exact: true })).toHaveValue('fake-review');
  await expect(send).toBeEnabled();
  await send.click();
  await expect(dialog.getByText('AI 正在后台生成候选，关闭窗口不会中断；再次打开可查看进度和结果。')).toBeVisible();
  await expect(composer).toHaveValue('');
  await composer.fill('下一条还没有提交的补充');
  await close.click();
  await fixture.open();
  await expect(dialog.getByText('保持同一次优化，不重新开对话', { exact: true })).toBeVisible();
  await expect(send).toBeDisabled();
  await expect(composer).toHaveValue('下一条还没有提交的补充');
  await expect(dialog.getByText('从当前生效 DSL 继续优化', { exact: true })).toHaveCount(0);
  const size = await dialog.evaluate(element => ({ scroll: element.scrollWidth, width: element.clientWidth }));
  expect(size.scroll).toBeLessThanOrEqual(size.width + 1);
  await page.screenshot({ path: testInfo.outputPath('optimizer-running-restored.png'), fullPage: true });
  await close.click();
  // 连整个 Kits 面板也关闭；生成的结果仍在执行端替身中保存。
  await page.locator('.awu-kits-panel').getByRole('button', { name: '关闭', exact: true }).click();
  fixture.complete();
  await page.getByTitle('Workspace Kits · Session 标准配件（实验）').click();
  await fixture.open();
  await expect(dialog.getByText('关闭窗口期间已生成完整候选。', { exact: true })).toBeVisible();
  await expect(send).toBeEnabled();
  await expect(composer).toHaveValue('下一条还没有提交的补充');
  await expect(dialog.getByRole('button', { name: '＋ 保存为候选版本' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('optimizer-result-restored.png'), fullPage: true });
  expect(fixture.starts).toHaveLength(1);
  expect(fixture.forbidden).toEqual([]);
});

test('history restores independently of Backend list; stale replies and errors preserve state', async ({ page }) => {
  const fixture = await optimizerFixture(page);
  fixture.holdBackends(true);
  fixture.holdHistory(true);
  await fixture.open();
  const dialog = page.getByRole('dialog', { name: '优化 Kit：启动 ActiveDraw Tauri 版' });
  const composer = dialog.locator('textarea');
  const send = dialog.getByRole('button', { name: '发送并生成候选' });
  await expect(dialog.getByText('正在恢复优化对话…')).toBeVisible();
  await expect(dialog.getByText('从当前生效 DSL 继续优化', { exact: true })).toHaveCount(0);
  await composer.fill('延迟情况下也不能丢失');
  await expect(send).toBeDisabled();
  await expect.poll(() => fixture.historyReplies.length).toBeGreaterThan(0);
  fixture.releaseHistory();
  await expect(dialog.getByText('此前的讨论仍然保留。')).toBeVisible();
  await expect(send).toBeEnabled();
  await expect.poll(() => fixture.backendReplies.length).toBeGreaterThan(0);
  fixture.releaseBackends();
  await expect(dialog.getByText('此前的讨论仍然保留。')).toBeVisible();
  fixture.failStart(true);
  await send.click();
  await expect(dialog.getByText(/QA 提交失败/)).toBeVisible();
  await expect(composer).toHaveValue('延迟情况下也不能丢失');
  await expect(send).toBeEnabled();
  fixture.failStart(false);
  // 保留一份发送之前的旧快照，再发送；旧回复不能覆盖已接受的消息/运行态。
  fixture.holdHistory(true);
  fixture.emit();
  await expect.poll(() => fixture.historyReplies.length).toBeGreaterThan(0);
  await send.click();
  await expect(dialog.getByText('延迟情况下也不能丢失', { exact: true })).toBeVisible();
  fixture.releaseHistory();
  await composer.fill('未发送的下一条');
  await expect(send).toBeDisabled();
  await expect(dialog.getByText('AI 正在后台生成候选，关闭窗口不会中断；再次打开可查看进度和结果。')).toBeVisible();
  fixture.complete();
  await expect(dialog.getByText('关闭窗口期间已生成完整候选。', { exact: true })).toBeVisible();
  await expect(send).toBeEnabled();
  expect(fixture.starts).toHaveLength(1);
  expect(fixture.forbidden).toEqual([]);
});
