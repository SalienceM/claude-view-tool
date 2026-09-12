import { test, expect, type Locator } from '@playwright/test';
import { uiDensityCss } from '../../src/utils/uiDensity';

const measure = (locator: Locator) => locator.evaluate(node => {
  const css = getComputedStyle(node);
  const bounds = node.getBoundingClientRect();
  return { height: bounds.height, width: bounds.width, fontSize: css.fontSize,
    paddingX: parseFloat(css.paddingLeft), paddingY: parseFloat(css.paddingTop) };
});

for (const theme of ['dark', 'light']) {
  test(`${theme}: compact desktop chrome preserves text size; touch layouts keep their spacing`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    // 仅设置隔离 QA 浏览器的外观偏好，不读写用户实际窗口配置。
    await page.addInitScript(value => localStorage.setItem('agent-with-u:appearance:v1:local:local', JSON.stringify({
      version: 1, theme: value, bgOpacity: .3, uiOpacity: 1, background: 'none',
    })), theme);
    await page.goto('/');
    await expect(page.locator('.home-status-item').nth(2).locator('strong')).toHaveText('24');
    const compact = await page.evaluate(() => matchMedia('(min-width:769px) and (pointer:fine)').matches);
    const home = await measure(page.locator('.home-shell'));
    if (compact) { expect(home.paddingX).toBe(20); expect(home.paddingY).toBe(16); }
    await page.screenshot({ path: info.outputPath(`density-home-${theme}.png`), fullPage: false });

    const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
    if (await opener.isVisible()) await opener.click();
    const row = page.locator('.awu-sidebar').getByText(/^客户工作会话 \d+$/).first()
      .locator('xpath=ancestor::div[@aria-haspopup="menu"][1]');
    const rowSize = await measure(row);
    await row.click();
    const pane = page.locator('[data-session-tab-panel]:visible');
    await expect(pane.locator('.message-bubble-wrapper')).toBeVisible();
    const topbar = page.locator('.awu-topbar');
    const tab = page.getByRole('tab', { selected: true });
    const composer = pane.locator('.awu-composer');
    const bubble = pane.locator('.message-bubble-wrapper').first();
    const input = pane.locator('.chat-textarea');
    const actual = { header: await measure(topbar), tab: await measure(tab), row: rowSize,
      composer: await measure(composer), bubble: await measure(bubble), input: await measure(input) };
    if (compact) {
      expect(actual.header.height).toBeLessThanOrEqual(40);
      expect(actual.tab.height).toBe(30);
      expect(actual.row.height).toBeLessThanOrEqual(30);
      expect(actual.composer.paddingX).toBe(12);
      expect(actual.bubble.paddingX).toBe(10);
    } else {
      expect(actual.header.height).toBeGreaterThanOrEqual(48);
      expect(actual.tab.height).toBe(40);
      expect(actual.row.height).toBeGreaterThanOrEqual(36);
      expect(actual.composer.paddingX).toBe(18);
      expect(actual.bubble.paddingX).toBe(14);
      expect((await opener.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    // 清除尺寸变量以对比原有控件 fallback。只改变测试页 CSS，不修改业务配置。
    const names = [...new Set(uiDensityCss.match(/--ui-[\w-]+(?=:)/g))];
    const baselineStyle = await page.addStyleTag({ content: `.app-root { ${names.map(name => `${name}:initial!important`).join(';')} }` });
    const original = { header: await measure(topbar), tab: await measure(tab),
      composer: await measure(composer), bubble: await measure(bubble), input: await measure(input) };
    expect(actual.bubble.fontSize).toBe(original.bubble.fontSize);
    expect(actual.input.fontSize).toBe(original.input.fontSize);
    if (compact) {
      expect(actual.header.height).toBeLessThan(original.header.height);
      expect(actual.composer.height).toBeLessThan(original.composer.height);
      expect(actual.tab.height).toBeLessThan(original.tab.height);
    }
    await baselineStyle.evaluate(node => node.remove());
    await page.screenshot({ path: info.outputPath(`density-chat-${theme}.png`), fullPage: false });

    await page.getByRole('button', { name: /^用户与设置：/ }).click();
    const navigation = page.getByRole('navigation', { name: '设置分类' });
    await expect(navigation).toBeVisible();
    const content = navigation.locator('..').getByRole('main');
    const settings = await measure(content);
    if (compact) { expect(settings.paddingX).toBe(16); expect(settings.paddingY).toBe(12); }
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`density-settings-${theme}.png`), fullPage: false });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
    await info.attach('density-metrics.json', { body: JSON.stringify({ compact, home, actual, original, settings }, null, 2), contentType: 'application/json' });
  });
}

test('LOOP header keeps Kit and Token controls separate and reachable', async ({ page }, info) => {
  await page.goto('/');
  const opener = page.getByRole('button', { name: '打开会话列表', exact: true });
  if (await opener.isVisible()) await opener.click();
  await page.locator('.awu-sidebar').getByText('首页交付 Loop 1', { exact: true }).click();
  const pane = page.locator('[data-session-tab-panel]:visible');
  await expect(pane.getByText('loopexecute', { exact: true }).first()).toBeVisible();
  const kit = pane.getByTitle('Workspace Kits · Session 标准配件（实验）');
  const token = pane.getByRole('button', { name: /累计.*Token/ });
  const a = (await kit.boundingBox())!;
  const b = (await token.boundingBox())!;
  const overlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  expect(overlap).toBe(0);
  await token.click();
  await expect(page.getByRole('dialog', { name: '本会话 Token 使用情况' })).toBeVisible();
  await page.keyboard.press('Escape');
  await kit.click();
  await expect(page.locator('.awu-kits-panel')).toBeVisible();
  await page.locator('.awu-kits-panel').getByRole('button', { name: '关闭', exact: true }).click();
  await page.screenshot({ path: info.outputPath('density-loop-header.png'), fullPage: false });
});
