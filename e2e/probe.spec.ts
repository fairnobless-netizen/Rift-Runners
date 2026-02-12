import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('Probe 20 moves produces PASS/FAIL summary and JSON artifact', async ({ page }) => {
  const artifactsDir = path.resolve(process.cwd(), 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });

  await page.goto('/');

  await page.getByTestId('probe-btn').click();

  const summary = page.getByTestId('probe-summary');
  await expect(summary).toBeVisible({ timeout: 30_000 });
  await expect(summary).toContainText(/Probe result:/);

  await page.screenshot({
    path: path.join(artifactsDir, 'probe_screenshot.png'),
    fullPage: true,
  });

  const payload = await page.evaluate(() => (window as any).__probeLastResult ?? null);
  expect(payload).not.toBeNull();

  fs.writeFileSync(
    path.join(artifactsDir, 'probe_result.json'),
    JSON.stringify(payload, null, 2),
    'utf-8',
  );
});
