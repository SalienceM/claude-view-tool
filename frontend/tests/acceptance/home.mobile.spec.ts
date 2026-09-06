import { expect, test, type Page } from '@playwright/test';

const CONTROL_URL = 'http://127.0.0.1:45423';

async function openCleanHome(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.removeItem('agent-with-u:pane-sessions');
    localStorage.removeItem('awu.connectionTarget');
    localStorage.removeItem('awu.execRoster');
  });
  await page.goto('/');
  await expect(page.getByRole('main', { name: '工作总览' })).toBeVisible();
  await expect(page.locator('.home-status-item').nth(2).locator('strong')).toHaveText('24');
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const measurements = await page.evaluate(() => {
    const dashboard = document.querySelector<HTMLElement>('.home-dashboard');
    return [
      { id: 'html', scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
      { id: 'body', scrollWidth: document.body.scrollWidth, clientWidth: document.body.clientWidth },
      {
        id: 'dashboard',
        scrollWidth: dashboard?.scrollWidth || 0,
        clientWidth: dashboard?.clientWidth || 0,
      },
    ];
  });
  for (const item of measurements) {
    expect(
      item.scrollWidth,
      `${item.id} horizontally overflows: ${item.scrollWidth} > ${item.clientWidth}`,
    ).toBeLessThanOrEqual(item.clientWidth + 1);
  }
}

test.describe.serial('small-screen touch dashboard acceptance', () => {
  test.beforeEach(async ({ request }, testInfo) => {
    test.skip(
      !['mobile-chromium', 'narrow-mobile-chromium'].includes(testInfo.project.name),
      'This suite only runs in the step 7 touch viewports.',
    );
    const backendCleanup = await request.get(`${CONTROL_URL}/backend/fixture/remove-late`);
    expect(backendCleanup.ok()).toBeTruthy();
    const cleanupResponse = await request.get(`${CONTROL_URL}/event/task/remove`);
    expect(cleanupResponse.ok()).toBeTruthy();
  });

  test.afterEach(async ({ request }) => {
    const backendCleanup = await request.get(`${CONTROL_URL}/backend/fixture/remove-late`);
    expect(backendCleanup.ok()).toBeTruthy();
    const cleanupResponse = await request.get(`${CONTROL_URL}/event/task/remove`);
    expect(cleanupResponse.ok()).toBeTruthy();
  });

  test('critical hierarchy fits the narrow layout without horizontal overflow', async ({ page }, testInfo) => {
    await openCleanHome(page);
    await assertNoHorizontalOverflow(page);

    const layout = await page.evaluate(() => {
      const rect = (selector: string) => {
        const value = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
        return value ? { top: value.top, bottom: value.bottom, width: value.width } : null;
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        status: rect('.home-module-global-status'),
        actions: rect('.home-module-quick-actions'),
        loops: rect('.home-module-loops'),
        tasks: rect('.home-module-tasks'),
        actionColumns: getComputedStyle(document.querySelector<HTMLElement>('.home-action-grid')!).gridTemplateColumns,
      };
    });
    expect(layout.status).not.toBeNull();
    expect(layout.actions).not.toBeNull();
    expect(layout.loops).not.toBeNull();
    expect(layout.tasks).not.toBeNull();
    expect(layout.status!.top).toBeLessThan(layout.actions!.top);
    expect(layout.actions!.top).toBeLessThan(layout.loops!.top);
    expect(layout.loops!.top).toBeLessThan(layout.tasks!.top);
    expect(layout.status!.width).toBeLessThanOrEqual(layout.viewport.width);
    expect(layout.actions!.width).toBeLessThanOrEqual(layout.viewport.width);
    expect(layout.actionColumns.trim().split(/\s+/)).toHaveLength(2);
    await expect(page.locator('.home-status-item')).toHaveCount(3);
    await expect(page.locator('.home-action-grid button')).toHaveCount(5);

    await testInfo.attach('mobile-layout.json', {
      body: JSON.stringify(layout, null, 2),
      contentType: 'application/json',
    });
    await page.screenshot({
      path: testInfo.outputPath('mobile-first-screen.png'),
      fullPage: false,
    });
  });

  test('visible controls have touch-safe targets and no center-point obstruction', async ({ page }, testInfo) => {
    await openCleanHome(page);
    const audit = await page.evaluate(() => {
      const controls = Array.from(document.querySelectorAll<HTMLElement>(
        '.home-dashboard button:not(:disabled), .home-dashboard input:not(:disabled)',
      )).filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
      return controls.map((element, index) => {
        const rect = element.getBoundingClientRect();
        const inViewport = rect.right > 0 && rect.left < innerWidth && rect.bottom > 0 && rect.top < innerHeight;
        const x = (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2;
        const y = (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2;
        const hit = inViewport ? document.elementFromPoint(x, y) : null;
        return {
          index,
          text: (element.innerText || element.getAttribute('aria-label') || element.getAttribute('title') || '').trim().slice(0, 80),
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
          inViewport,
          centerHit: inViewport ? Boolean(hit && (hit === element || element.contains(hit))) : null,
        };
      });
    });
    const undersized = audit.filter((item) => item.width < 44 || item.height < 44);
    const obstructed = audit.filter((item) => item.inViewport && item.centerHit === false);
    expect(undersized, `undersized controls: ${JSON.stringify(undersized)}`).toEqual([]);
    expect(obstructed, `obstructed controls: ${JSON.stringify(obstructed)}`).toEqual([]);

    await testInfo.attach('touch-target-audit.json', {
      body: JSON.stringify({ controls: audit.length, audit }, null, 2),
      contentType: 'application/json',
    });
  });

  test('all quick actions are reachable with one physical tap', async ({ context }, testInfo) => {
    const checks: Array<{
      index: number;
      id: string;
      verify: (page: Page) => Promise<void>;
    }> = [
      {
        index: 0,
        id: 'new-chat',
        verify: async (page) => expect(page.getByRole('heading', { name: 'New Session' })).toBeVisible(),
      },
      {
        index: 1,
        id: 'new-loop',
        verify: async (page) => expect(page.getByText(/Loop 策略与心智/)).toBeVisible(),
      },
      {
        index: 2,
        id: 'resume-work',
        verify: async (page) => expect(page.getByText('loopexecute', { exact: true }).first()).toBeVisible(),
      },
      {
        index: 3,
        id: 'open-tasks',
        verify: async (page) => expect(page.locator('[title="收起"]')).toBeVisible(),
      },
      {
        index: 4,
        id: 'manage-models',
        verify: async (page) => expect(page.getByRole('heading', { name: 'Backend Manager' })).toBeVisible(),
      },
    ];
    const results: Array<{ id: string; taps: number; passed: boolean }> = [];
    for (const check of checks) {
      const page = await context.newPage();
      await openCleanHome(page);
      const target = page.locator('.home-action-grid button').nth(check.index);
      await target.scrollIntoViewIfNeeded();
      const box = await target.boundingBox();
      expect(box).not.toBeNull();
      await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await check.verify(page);
      results.push({ id: check.id, taps: 1, passed: true });
      await page.screenshot({
        path: testInfo.outputPath(`touch-${check.id}.png`),
        fullPage: false,
      });
      await page.close();
    }
    await testInfo.attach('touch-action-results.json', {
      body: JSON.stringify(results, null, 2),
      contentType: 'application/json',
    });
  });

  test('new-session dialog refreshes a changed Backend inventory without reloading the page', async ({ page, request }) => {
    await openCleanHome(page);

    await page.locator('.home-action-grid button').first().click();
    const backendField = page.getByText('Backend:', { exact: true }).locator('..');
    await expect(backendField.getByText(/Backend 负责账号/)).toBeVisible();
    await expect(backendField.locator('option[value="qa-late-backend"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel' }).click();

    const addResponse = await request.get(`${CONTROL_URL}/backend/fixture/add-late`);
    expect(addResponse.ok()).toBeTruthy();

    // 页面顶层仍持有旧清单；重新打开弹窗必须向执行节点读取，而不是要求整页刷新。
    await page.locator('.home-action-grid button').first().click();
    const refreshedBackendField = page.getByText('Backend:', { exact: true }).locator('..');
    await expect(refreshedBackendField.locator('option[value="qa-late-backend"]')).toHaveCount(1);
    await expect(refreshedBackendField.getByText(/Backend 负责账号/)).toBeVisible();
  });

  test('scrolling and a live update remain stable', async ({ page, request }, testInfo) => {
    await openCleanHome(page);
    const dashboard = page.locator('.home-dashboard');
    await page.locator('.home-module-activity').scrollIntoViewIfNeeded();
    const before = await dashboard.evaluate((element) => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      bottomGap: element.scrollHeight - element.clientHeight - element.scrollTop,
    }));
    expect(before.scrollTop).toBeGreaterThan(0);
    await assertNoHorizontalOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath('mobile-scrolled-bottom.png'),
      fullPage: false,
    });

    const eventResponse = await request.get(`${CONTROL_URL}/event/task`);
    expect(eventResponse.ok()).toBeTruthy();
    await expect(page.locator('.home-status-item').nth(2).locator('strong')).toHaveText('25');
    await expect(page.locator('.home-activity li')).not.toHaveCount(0);
    const after = await dashboard.evaluate((element) => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      bottomGap: element.scrollHeight - element.clientHeight - element.scrollTop,
    }));
    // 新事件可能让状态流增高；浏览器会等量调整 scrollTop 以维持视觉锚点。
    // 因此以视口到底部的距离判断是否跳动，而不是要求 scrollTop 数字不变。
    expect(Math.abs(after.bottomGap - before.bottomGap)).toBeLessThanOrEqual(2);
    await assertNoHorizontalOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath('mobile-live-update.png'),
      fullPage: false,
    });

    await testInfo.attach('mobile-scroll-stability.json', {
      body: JSON.stringify({
        before,
        after,
        scrollTopDeltaPx: after.scrollTop - before.scrollTop,
        contentHeightDeltaPx: after.scrollHeight - before.scrollHeight,
        visualBottomGapDeltaPx: after.bottomGap - before.bottomGap,
      }, null, 2),
      contentType: 'application/json',
    });
  });
});
