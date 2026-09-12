import { test, expect } from '@playwright/test';

test('one reusable chain card shows both original run histories', async ({ page }, testInfo) => {
  const title = 'Chat 顺序执行 · 完整打包 → 发布稳定包';
  const kit = {
    id: 'chain-canonical', title, description: '相同流程复用，每次执行单独留存',
    objective: '', successCriteria: '', safetyConstraints: '', references: [],
    implementationSummary: '', generationWarnings: [], generatedByAi: false, chatChain: true,
    executionTarget: 'executor', command: '', shell: 'powershell', cwd: '.', timeoutSeconds: 300,
    inputs: [], assertions: [], outputs: [], dependencies: [],
    steps: [{ id: '1', type: 'kit_call', kitId: 'build' }, { id: '2', type: 'kit_call', kitId: 'publish' }],
    schedule: { mode: 'manual', intervalSeconds: 300, nextRunAt: null },
    view: { default: 'summary', showLogs: true, showData: true, showTerminal: true },
    enabled: true, controlMode: 'shared', lastRunId: 'second-run',
    versions: [], activeVersionId: '', createdAt: 100, updatedAt: 300,
  };
  const runs = ['chain-canonical', 'archived-duplicate'].map((kitId, index) => ({
    id: index ? 'second-run' : 'first-run', kitId, canonicalKitId: kit.id,
    status: 'succeeded', verdict: 'passed', trigger: 'manual', owner: 'ai', inputs: {},
    steps: [], currentStep: 0, artifactIds: [], assertions: [], assertionResults: [],
    stdout: index ? '第二次执行的日志' : '第一次执行的日志', stderr: '', error: '', exitCode: 0,
    createdAt: 1789170000 + index * 100, startedAt: 1789170000 + index * 100,
    endedAt: 1789170050 + index * 100,
  }));
  const mutations: string[] = [];
  // 仅测试服务端投影的消费；不存在真实发布、Shell 或模型调用。
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      let frame: any;
      try { frame = JSON.parse(String(message)); } catch { server.send(message); return; }
      if (frame.method === 'kitGetState') {
        const sessionId = frame.params[0];
        socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify({
          status: 'ok', sessionId, kits: [kit], runs: runs.map(run => ({ ...run, sessionId })),
          artifacts: [], dataMarket: [], terminalConnectedKitIds: [],
        }) }));
      } else if (/^(kitRun|kitResume|kitCapabilityRespond|kitTerminalCommand|sendMessage)$/.test(frame.method)) {
        mutations.push(frame.method);
        socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify({ status: 'error', message: 'Blocked in QA' }) }));
      } else server.send(message);
    });
  });
  await page.goto('/');
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).first().click();
  await page.getByTitle('Workspace Kits · Session 标准配件（实验）').click();
  const panel = page.locator('.awu-kits-panel');
  await expect(panel.getByTitle(title, { exact: true })).toHaveCount(1);
  await expect(panel.getByRole('button', { name: '详情', exact: true })).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('single-chain-card.png'), fullPage: true });
  await panel.getByRole('button', { name: '详情', exact: true }).click();
  await expect(panel.getByText('第二次执行的日志', { exact: true })).toBeVisible();
  const history = panel.locator('section').filter({ hasText: '最近运行' });
  await expect(history.getByText(/manual ·/)).toHaveCount(2);
  await history.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('combined-chain-history.png'), fullPage: true });
  expect(mutations).toEqual([]);
});
