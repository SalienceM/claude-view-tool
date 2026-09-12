import { test, expect } from '@playwright/test';

test('Kit delegation is an explicit one-send flag, never inferred or carried to another session', async ({ page }, testInfo) => {
  const sent: any[] = [];
  let finish: (() => void) | undefined;
  // 所有聊天发送被拦截；验收不调用模型，也不执行任何真实 Kit / 发布。
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      let frame: any;
      try { frame = JSON.parse(String(message)); } catch { server.send(message); return; }
      if (frame.method === 'seqtaskGet') {
        socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify({ status: 'ok', seqTasks: [], seqAuto: false }) }));
      } else if (frame.method === 'sendMessage') {
        const payload = JSON.parse(frame.params[0]);
        sent.push(payload);
        finish = () => {
          for (const type of ['text_delta', 'done']) socket.send(JSON.stringify({ event: 'streamDelta', data: JSON.stringify({
            sessionId: payload.sessionId, messageId: payload.messageId, type, text: type === 'text_delta' ? '隔离测试完成' : '',
          }) }));
        };
      } else server.send(message);
    });
  });
  const openSidebar = async () => {
    const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
    if (await opener.isVisible()) await opener.click();
  };
  await page.goto('/');
  await openSidebar();
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).first().click();
  const optIn = page.getByRole('checkbox', { name: '本次允许 Kit 代确认' });
  const input = page.locator('.chat-textarea');
  await expect(optIn).not.toBeChecked();
  await expect(optIn).toBeEnabled();
  await input.fill('我授权你代确认（正文不等于开关）');
  await input.press('Enter');
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].kitApprovalDelegation).toBe(false);
  await expect(optIn).toBeDisabled();
  finish!();
  await expect(optIn).toBeEnabled();

  await optIn.check();
  await input.fill('按顺序打包并发布，请核对本次发布计划');
  await page.screenshot({ path: testInfo.outputPath('kit-delegation-opt-in.png'), fullPage: true });
  await input.press('Enter');
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1].kitApprovalDelegation).toBe(true);
  await expect(optIn).not.toBeChecked();
  await expect(optIn).toBeDisabled();
  finish!();
  await expect(optIn).toBeEnabled();

  await input.fill('普通后续消息');
  await input.press('Enter');
  await expect.poll(() => sent.length).toBe(3);
  expect(sent[2].kitApprovalDelegation).toBe(false);
  finish!();
  await expect(optIn).toBeEnabled();
  await optIn.check();
  await openSidebar();
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).nth(1).click();
  await expect(optIn).not.toBeChecked();
  expect(sent).toHaveLength(3);
});
