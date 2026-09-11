import { test, expect } from '@playwright/test';

test('mobile conversion dialog stays above drawer and Kits uses a full-width detail page', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes('mobile'));
  await page.goto('/');
  await page.getByRole('button', { name: '打开会话列表', exact: true }).click();
  const row = page.locator('.awu-sidebar [aria-haspopup="menu"]').filter({ hasNotText: '🔁' }).last();
  await expect(row).toBeVisible();
  await row.click({ button: 'right' });
  await page.getByText('转为 LOOP…', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '🔁 转为 LOOP' });
  await expect(dialog).toBeVisible();
  const unobstructed = await dialog.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  });
  expect(unobstructed).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile-conversion.png') });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await row.click();
  await page.getByTitle('Workspace Kits · Session 标准配件（实验）').click();
  const panel = page.locator('.awu-kits-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: /新建 Kit/ }).click();
  await expect(panel.getByRole('button', { name: '← 返回列表' })).toBeVisible();
  await expect(panel.locator('.awu-kits-detail-sidebar')).toBeHidden();
  const dimensions = await panel.evaluate(element => ({
    width: element.getBoundingClientRect().width, viewport: innerWidth,
    scroll: element.scrollWidth, client: element.clientWidth,
    background: getComputedStyle(element).backgroundColor,
  }));
  expect(dimensions.width).toBe(dimensions.viewport);
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1);
  expect(dimensions.background).toMatch(/^rgb\(/);
  await page.screenshot({ path: testInfo.outputPath('mobile-kits-editor.png') });
  await panel.getByRole('button', { name: '← 返回列表' }).click();
  await expect(panel.getByRole('button', { name: /新建 Kit/ })).toBeVisible();
});
