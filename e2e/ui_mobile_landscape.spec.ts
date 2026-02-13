import { test, expect, devices } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const ARTIFACTS_DIR = path.join(process.cwd(), 'artifacts', 'ui');

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

async function prepareInitScripts(page: any) {
  // Collapse WS debug overlay tray so it doesn't block UI
  await page.addInitScript(() => {
    try {
      localStorage.setItem('ws-debug-overlay-collapsed', '1');
    } catch {}
  });
}

async function gotoAndStabilize(page: any) {
  await page.goto('/', { waitUntil: 'networkidle' });

  // Wait for layout + arena presence
  await page.waitForSelector('.playfield-shell', { timeout: 30000 });
  await page.waitForSelector('.game-canvas', { timeout: 30000 });

  // Give Phaser a moment to settle
  await page.waitForTimeout(700);
}

async function screenshot(page: any, outPath: string) {
  await page.screenshot({ path: outPath, fullPage: true });
}

async function tryMaxZoomOutOnArena(page: any) {
  const arena = await page.$('.game-canvas');
  if (!arena) return;

  const box = await arena.boundingBox();
  if (!box) return;

  // Move mouse into arena center
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  // Attempt zoom-out in one direction
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 450);
    await page.waitForTimeout(60);
  }

  // Then also attempt the opposite direction (some implementations invert)
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, -450);
    await page.waitForTimeout(60);
  }

  // Let camera settle
  await page.waitForTimeout(300);
}

const iphone = devices['iPhone 15 Pro'];
const pixel = devices['Pixel 7'];

test.describe('Mobile Landscape UI proof', () => {
  test('iPhone 15 Pro landscape: start + zoom-out', async ({ browser }) => {
    const context = await browser.newContext({
      ...iphone,
      viewport: iphone.viewport,
      isMobile: true,
    });

    const page = await context.newPage();
    await prepareInitScripts(page);

    // Force landscape by setting viewport swapped (landscape)
    await page.setViewportSize({ width: 852, height: 393 });

    await gotoAndStabilize(page);

    const outDir = path.join(ARTIFACTS_DIR, 'iphone15pro_landscape');
    ensureDir(outDir);

    await screenshot(page, path.join(outDir, '01_start.png'));

    await tryMaxZoomOutOnArena(page);
    await screenshot(page, path.join(outDir, '02_zoomout.png'));

    await context.close();
  });

  test('Pixel 7 landscape: start + zoom-out', async ({ browser }) => {
    const context = await browser.newContext({
      ...pixel,
      viewport: pixel.viewport,
      isMobile: true,
    });

    const page = await context.newPage();
    await prepareInitScripts(page);

    // Landscape viewport for Pixel 7-ish
    await page.setViewportSize({ width: 915, height: 412 });

    await gotoAndStabilize(page);

    const outDir = path.join(ARTIFACTS_DIR, 'pixel7_landscape');
    ensureDir(outDir);

    await screenshot(page, path.join(outDir, '01_start.png'));

    await tryMaxZoomOutOnArena(page);
    await screenshot(page, path.join(outDir, '02_zoomout.png'));

    await context.close();
  });
});
