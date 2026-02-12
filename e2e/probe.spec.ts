import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

test('runs Probe 20 moves and stores screenshot + json artifact', async ({ page }) => {
  mkdirSync('artifacts', { recursive: true });

  await page.goto('http://127.0.0.1:5173/');

  await page.getByTestId('probe-btn').click();

  const summary = page.getByTestId('probe-summary');
  await expect(summary).toContainText(/Probe result:\s+(PASS|FAIL)/, { timeout: 20_000 });

  await page.screenshot({ path: 'artifacts/probe_screenshot.png', fullPage: true });

  const payload = await page.evaluate(() => {
    return window.__probeLastResult ?? null;
  });

  if (!payload) {
    throw new Error('window.__probeLastResult is empty after Probe run');
  }

  writeFileSync('artifacts/probe_result.json', `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
});
