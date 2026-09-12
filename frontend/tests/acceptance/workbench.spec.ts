import { test, expect } from '@playwright/test';

const item = (id: string, sourceId: string, stars?: number) => ({
  id, sourceId, name: id, sourceName: sourceId, repository: `demo/${sourceId}`, ref: 'main', path: `skills/${id}`,
  homepage: `https://github.com/demo/${sourceId}`, official: false, description: `${id} example skill`,
  digest: '0123456789abcdef0123456789abcdef', version: id === 'alpha' ? '1.2.3' : '',
  fileNames: ['SKILL.md'], fileCount: 1, size: 128, risk: { level: 'low', flags: [] }, warnings: [],
  preview: `# ${id}`, installed: false, sameSource: false, localModified: false, updateAvailable: false, conflict: false,
  repositoryInfo: { stars, pushedAt: '2026-09-01T00:00:00Z', latestRelease: 'repo-v9' },
});

test('activity rail and persistent workspace tabs; market filtering, versions and responsive layout', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // 拦截测试市场目录，避免验收时访问 GitHub 或安装外部内容。
  await page.routeWebSocket(/.*/, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      let frame: any;
      try { frame = JSON.parse(String(message)); } catch { server.send(message); return; }
      if (frame.method === 'skillMarketList') {
        socket.send(JSON.stringify({ id: frame.id, result: JSON.stringify({ status: 'ok',
          sources: ['one', 'two'].map(id => ({ id, name: id, repository: `demo/${id}`, homepage: `https://github.com/demo/${id}`, skillCount: 2 })),
          directories: [], items: [item('alpha', 'one', 30), item('beta', 'two', 200), item('gamma', 'two')],
        }) }));
      } else server.send(message);
    });
  });
  await page.goto('/');
  if (await page.getByRole('button', { name: '打开会话列表', exact: true }).isVisible()) {
    await page.getByRole('button', { name: '打开会话列表', exact: true }).click();
  }
  const rail = page.getByRole('navigation', { name: '功能栏' });
  await expect(rail).toBeVisible();
  const sessionButton = rail.getByRole('button', { name: 'Session 会话', exact: true });
  const filesButton = rail.getByRole('button', { name: '文件目录（本地 ⇄ 远端）', exact: true });
  const extensionsButton = rail.getByRole('button', { name: '扩展', exact: true });
  const boxes = await Promise.all([sessionButton.boundingBox(), filesButton.boundingBox(), extensionsButton.boundingBox()]);
  expect(boxes[0]!.y).toBeLessThan(boxes[1]!.y);
  expect(boxes[1]!.y).toBeLessThan(boxes[2]!.y);
  await extensionsButton.click();
  await page.locator('.awu-sidebar').getByRole('button', { name: /扩展市场/ }).click();
  const market = page.getByRole('tabpanel', { name: '扩展市场' });
  await expect(market).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(market.getByRole('heading', { name: 'alpha', exact: true })).toBeVisible();
  await market.getByRole('combobox', { name: '扩展排序' }).selectOption('stars');
  await expect(market.locator('.skill-market-item').first()).toContainText('beta');
  await market.getByRole('combobox', { name: '扩展来源筛选' }).selectOption('one');
  await expect(market.locator('.skill-market-item')).toHaveCount(1);
  await expect(market.locator('.skill-market-item').first()).toContainText('alpha');
  await market.getByRole('combobox', { name: '扩展来源筛选' }).selectOption('');
  await market.getByRole('textbox', { name: '搜索扩展' }).fill('beta');
  await expect(market.getByRole('heading', { name: 'beta', exact: true })).toBeVisible();
  await expect(market.getByText('作者未声明', { exact: true })).toBeVisible();
  await expect(market.getByText('repo-v9', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '扩展市场', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: '工作总览', exact: true })).toBeFocused();
  await expect(market).toBeHidden();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '扩展市场', exact: true })).toBeFocused();
  await expect(market.getByRole('textbox', { name: '搜索扩展' })).toHaveValue('beta');
  await market.getByRole('textbox', { name: '搜索扩展' }).fill('no-such-skill');
  await expect(market.getByRole('heading', { name: 'beta', exact: true })).toHaveCount(0);
  await expect(market.getByRole('button', { name: '安装到 Skill 库', exact: true })).toHaveCount(0);
  await market.getByRole('textbox', { name: '搜索扩展' }).fill('alpha');
  await expect(market.getByText('1.2.3', { exact: true })).toBeVisible();
  const bounds = await market.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  const install = market.getByRole('button', { name: '安装到 Skill 库', exact: true });
  await install.scrollIntoViewIfNeeded();
  await expect(install).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('workbench-market.png'), fullPage: true });
  await page.getByRole('button', { name: '更多功能', exact: true }).click();
  await page.getByRole('menuitem', { name: /Skills 与 Prompts/ }).click();
  await expect(page.getByRole('tabpanel', { name: 'Skills 与 Prompts' })).toBeVisible();
  await page.getByRole('button', { name: '新建 Prompt', exact: true }).click();
  await page.getByPlaceholder('Prompt 名称', { exact: true }).fill('保留草稿');
  await page.getByPlaceholder('输入 Prompt 模板内容…', { exact: true }).fill('标签切换不能丢失此内容');
  await page.getByRole('tab', { name: '扩展市场', exact: true }).click();
  await page.getByRole('tab', { name: /Skills 与 Prompts/ }).click();
  await expect(page.getByPlaceholder('Prompt 名称', { exact: true })).toHaveValue('保留草稿');
  await page.getByRole('button', { name: '关闭Skills 与 Prompts', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: /Skills 与 Prompts/ })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '关闭Skills 与 Prompts', exact: true }).click();
  await expect(market).toBeVisible();
  await page.getByRole('button', { name: '关闭扩展市场', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: '工作总览', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('opening an extension tab keeps the existing chat mounted and preserves its draft', async ({ page }) => {
  await page.goto('/');
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).first().click();
  const input = page.locator('.chat-textarea');
  await expect(input).toBeVisible();
  await input.fill('未发送的聊天草稿');
  const original = await input.elementHandle();
  await page.getByRole('button', { name: '更多功能', exact: true }).click();
  await page.getByRole('menuitem', { name: /Skills 与 Prompts/ }).click();
  await expect(input).toBeHidden();
  expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  await page.getByRole('tab', { name: /^客户工作会话 \d+$/ }).click();
  await expect(input).toHaveValue('未发送的聊天草稿');
  expect(await original!.evaluate(node => node === document.querySelector('.chat-textarea'))).toBe(true);
});
