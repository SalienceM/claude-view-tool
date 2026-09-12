import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';

async function selectSession(page: Page, index: number) {
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  const row = page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).nth(index);
  const title = (await row.textContent())!;
  await row.click();
  const tab = page.getByRole('tab', { name: title, exact: true });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  return { title, tab };
}

test('Session tabs reuse mounted conversations, retain drafts and close without deleting or aborting', async ({ page }, info) => {
  const forbidden: string[] = [];
  const historyReads: string[] = [];
  const errors: string[] = [];
  const sockets: WebSocketRoute[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket(/.*/, socket => {
    sockets.push(socket);
    const server = socket.connectToServer();
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (['loadSession', 'loadSessionMessages'].includes(frame.method)) historyReads.push(frame.params[0]);
      if (['sendMessage', 'abortMessage', 'deleteSession', 'seqtaskTakeNext', 'loopRunIteration'].includes(frame.method)) {
        forbidden.push(frame.method);
        socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify({ status: 'error', message: 'Blocked in QA' }) }));
      } else server.send(message);
    });
  });
  await page.goto('/');
  const a = await selectSession(page, 0);
  const inputA = page.locator('[data-session-tab-panel]:visible .chat-textarea');
  await expect(inputA).toBeVisible();
  await inputA.fill('Session A 的独立草稿');
  const originalA = await inputA.elementHandle();
  const panelA = page.locator('[data-session-tab-panel]:visible');
  const idA = (await panelA.getAttribute('data-session-tab-panel'))!;
  await expect.poll(() => historyReads.filter(id => id === idA).length).toBeGreaterThan(0);
  const aReads = historyReads.filter(id => id === idA).length;
  const b = await selectSession(page, 1);
  const inputB = page.locator('[data-session-tab-panel]:visible .chat-textarea');
  await expect(inputB).toBeVisible();
  await inputB.fill('Session B 的独立草稿');
  const originalB = await inputB.elementHandle();
  expect(await originalA!.evaluate(node => node.isConnected)).toBe(true);
  await a.tab.click();
  await expect(page.locator('[data-session-tab-panel]:visible .chat-textarea')).toHaveValue('Session A 的独立草稿');
  expect(await originalA!.evaluate(node => node === document.querySelector('[data-session-tab-panel]:not([hidden]) .chat-textarea'))).toBe(true);
  await selectSession(page, 0);
  await expect(a.tab).toHaveCount(1);
  expect(historyReads.filter(id => id === idA).length).toBe(aReads);
  await b.tab.click();
  await expect(page.locator('[data-session-tab-panel]:visible .chat-textarea')).toHaveValue('Session B 的独立草稿');
  expect(await originalB!.evaluate(node => node.isConnected)).toBe(true);
  await page.screenshot({ path: info.outputPath('session-tabs.png'), fullPage: true });
  // 未选中的 A 收到后台状态，不应把注意力从 B 拉走，也不启动任何真实模型。
  sockets.forEach(socket => socket.send(JSON.stringify({ event: 'streamDelta', data: JSON.stringify({
    sessionId: idA, messageId: 'qa-background', type: 'text_delta', text: '后台任务仍在执行',
  }) })));
  await expect(a.tab).toHaveAttribute('title', /正在运行/);
  await expect(b.tab).toHaveAttribute('aria-selected', 'true');
  sockets.forEach(socket => socket.send(JSON.stringify({ event: 'streamDelta', data: JSON.stringify({
    sessionId: idA, messageId: 'qa-background', type: 'done',
  }) })));
  await expect(a.tab).toHaveAttribute('title', /已完成，待查看/);
  await a.tab.click();
  await expect(a.tab).not.toHaveAttribute('title', /已完成，待查看/);
  await b.tab.click();
  await page.getByRole('button', { name: `关闭${a.title}`, exact: true }).click();
  await expect(a.tab).toHaveCount(0);
  await expect(b.tab).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: `关闭${b.title}`, exact: true }).click();
  await expect(page.getByRole('tab', { name: '工作总览', exact: true })).toHaveAttribute('aria-selected', 'true');
  await selectSession(page, 1);
  await expect(page.locator('[data-session-tab-panel]:visible .chat-textarea')).toHaveValue('Session B 的独立草稿');
  await selectSession(page, 0);
  await expect(page.locator('[data-session-tab-panel]:visible .chat-textarea')).toHaveValue('Session A 的独立草稿');
  expect(forbidden).toEqual([]);
  expect(errors).toEqual([]);
});

test('tab overflow and keyboard navigation work on narrow screens; active close selects neighbor', async ({ page }, info) => {
  await page.goto('/');
  const opened = [];
  for (let index = 0; index < 6; index++) opened.push(await selectSession(page, index));
  const last = opened.at(-1)!;
  const bar = page.getByRole('tablist', { name: '工作区标签页' });
  const box = (await bar.boundingBox())!;
  const activeBox = (await last.tab.boundingBox())!;
  expect(activeBox.x).toBeGreaterThanOrEqual(box.x - 1);
  expect(activeBox.x + activeBox.width).toBeLessThanOrEqual(box.x + box.width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await last.tab.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(opened[4].tab).toBeFocused();
  await expect(opened[4].tab).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: `关闭${opened[4].title}`, exact: true }).click();
  await expect(opened[3].tab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-session-tab-panel]:visible')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('session-tabs-overflow.png'), fullPage: true });
});

test('restored split layout has one instance per Session and tab selection focuses the existing pane', async ({ page }, info) => {
  test.skip(info.project.name.includes('mobile'));
  // 隔离 QA 标签页的布局偏好，不读取或操作用户配置。
  await page.addInitScript(() => localStorage.setItem('agent-with-u:layout', '1x2'));
  await page.goto('/');
  const a = await selectSession(page, 0);
  const left = page.locator('[data-session-tab-panel]:visible');
  await expect(left).toHaveCount(1);
  const aId = (await left.getAttribute('data-session-tab-panel'))!;
  await page.getByRole('heading', { name: '工作总览', exact: true }).click();
  const b = await selectSession(page, 1);
  await expect(page.locator('[data-session-tab-panel]:visible')).toHaveCount(2);
  await a.tab.click();
  await expect(page.locator(`[data-session-tab-panel="${aId}"]`)).toHaveCount(1);
  await expect(page.locator('[data-session-tab-panel]:visible')).toHaveCount(2);
  await expect(a.tab).toHaveAttribute('aria-selected', 'true');
  await b.tab.click();
  await expect(page.locator('[data-session-tab-panel]:visible')).toHaveCount(2);
  await page.screenshot({ path: info.outputPath('session-tabs-split.png'), fullPage: true });
});

test('Session rename and remote deletion update tabs without rebuilding the other conversation', async ({ page }) => {
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/.*/, socket => { sockets.push(socket); socket.connectToServer(); });
  const emit = (data: object) => sockets.forEach(socket => socket.send(JSON.stringify({ event: 'sessionUpdated', data: JSON.stringify(data) })));
  await page.goto('/');
  const a = await selectSession(page, 0);
  const inputA = await page.locator('[data-session-tab-panel]:visible .chat-textarea').elementHandle();
  const b = await selectSession(page, 1);
  const panelB = page.locator('[data-session-tab-panel]:visible');
  const sid = (await panelB.getAttribute('data-session-tab-panel'))!;
  const originalB = await panelB.elementHandle();
  emit({ type: 'session_renamed', sessionId: sid, title: '改名后的 Session', summary: { id: sid, title: '改名后的 Session' } });
  await expect(b.tab).toHaveCount(0);
  const renamed = page.getByRole('tab', { name: '改名后的 Session', exact: true });
  await expect(renamed).toHaveAttribute('aria-selected', 'true');
  expect(await originalB!.evaluate(node => node.isConnected)).toBe(true);
  emit({ type: 'session_deleted', sessionId: sid });
  await expect(renamed).toHaveCount(0);
  await expect(a.tab).toHaveAttribute('aria-selected', 'true');
  expect(await inputA!.evaluate(node => node.isConnected)).toBe(true);
  await expect(page.locator(`[data-session-tab-panel="${sid}"]`)).toHaveCount(0);
});

test('returning to a Session restores the reading position without another history fetch', async ({ page }) => {
  await page.routeWebSocket(/.*/, socket => {
    const histories = new Set<string>();
    const server = socket.connectToServer();
    socket.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      if (frame.method === 'loadSession' || frame.method === 'loadSessionMessages') histories.add(frame.id);
      server.send(raw);
    });
    server.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      if (histories.has(frame.id)) {
        const result = JSON.parse(frame.result);
        if (result?.messages?.[0]) result.messages[0].content = Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 段较长的历史内容，用于验证阅读位置。`).join('\n\n');
        frame.result = JSON.stringify(result);
        socket.send(JSON.stringify(frame));
      } else socket.send(raw);
    });
  });
  await page.goto('/');
  const a = await selectSession(page, 0);
  const scroll = page.locator('[data-session-tab-panel]:visible .awu-message-scroll');
  await expect.poll(() => scroll.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(500);
  await scroll.evaluate(node => { node.scrollTop = 100; node.dispatchEvent(new Event('scroll')); });
  await selectSession(page, 1);
  await a.tab.click();
  await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBe(100);
});

test('Session-owned portals hide with their retained tab', async ({ page }) => {
  await page.goto('/');
  const a = await selectSession(page, 0);
  const b = await selectSession(page, 1);
  await a.tab.click();
  await page.locator('[data-session-tab-panel]:visible').getByRole('button', { name: /累计.*Token/ }).click();
  const dialog = page.getByRole('dialog', { name: '本会话 Token 使用情况', includeHidden: true });
  await expect(dialog).toBeVisible();
  const instance = await dialog.elementHandle();
  // 模拟应用级导航，避开 modal 的指针遮罩，验证 Portal 不受普通父 DOM 的 hidden 保护。
  await b.tab.dispatchEvent('click');
  await expect(dialog).toBeHidden();
  expect(await instance!.evaluate(node => node.isConnected)).toBe(true);
  await a.tab.dispatchEvent('click');
  await expect(dialog).toBeVisible();
});
