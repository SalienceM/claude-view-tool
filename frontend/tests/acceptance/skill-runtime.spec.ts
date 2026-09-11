import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

test('complete skill import opens a confirmation-based runtime check and persists readiness', async ({ page }, testInfo) => {
  // 仅使用隔离的 HOME_QA 数据；不访问网络，不安装任何第三方包。
  const archive = execFileSync('python', ['-c', [
    'import io,zipfile,sys,json',
    'buf=io.BytesIO()',
    'z=zipfile.ZipFile(buf,"w")',
    'z.writestr("SKILL.md", "---\\nname: qa-runtime-test\\ndescription: Offline runtime acceptance skill\\n---\\nUse bundled template.")',
    'z.writestr("assets/template.txt", "fixture resource")',
    'z.writestr("awu-runtime.json", json.dumps({"version":1,"requiredFiles":["assets/template.txt"]}))',
    'z.close()',
    'sys.stdout.buffer.write(buf.getvalue())',
  ].join('\n')]);
  await page.goto('/');
  await page.getByRole('button', { name: '更多功能', exact: true }).click();
  await page.getByText('Skills 与 Prompts', { exact: true }).click();
  await page.locator('input[type="file"][accept=".awu,.zip"]').setInputFiles({ name: 'qa-runtime.zip', mimeType: 'application/zip', buffer: archive });
  const dialog = page.getByRole('dialog', { name: 'Skill 运行准备' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('文件已安装 · 待准备', { exact: true })).toBeVisible();
  const prepare = dialog.getByRole('button', { name: '确认并准备运行环境' });
  await expect(prepare).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await expect(prepare).toBeEnabled();
  await prepare.click();
  await expect(dialog.getByRole('heading', { name: '运行检查通过' })).toBeVisible();
  await expect(dialog.getByText('安装日志（尾部）')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('skill-runtime-ready.png') });
  await dialog.getByRole('button', { name: '关闭运行准备' }).click();
  await page.getByRole('button', { name: '确定', exact: true }).click();
  await page.locator('.repo-card').filter({ hasText: 'qa-runtime-test' }).getByRole('button', { name: '运行准备 / 状态' }).click();
  await expect(dialog.getByRole('heading', { name: '运行检查通过' })).toBeVisible();
});
