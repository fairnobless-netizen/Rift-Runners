import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const ARTIFACTS_DIR = path.join(process.cwd(), 'artifacts', 'ui');

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(outPath: string, data: unknown) {
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf-8');
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
  // Avoid networkidle flakiness with websockets/telemetry
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // Wait for layout + arena presence
  await page.waitForSelector('.playfield-shell', { timeout: 30000 });
  await page.waitForSelector('.game-canvas', { timeout: 30000 });

  // Give Phaser a moment to settle
  await page.waitForTimeout(800);
}

async function screenshot(page: any, outPath: string) {
  await page.screenshot({ path: outPath, fullPage: true });
}

async function getArenaBox(page: any) {
  const arena = await page.$('.game-canvas');
  expect(arena, 'Expected .game-canvas to exist').not.toBeNull();

  const box = await arena!.boundingBox();
  expect(box, 'Expected boundingBox for .game-canvas').not.toBeNull();

  return box!;
}

async function assertArenaRectangular(page: any) {
  const box = await getArenaBox(page);
  const ratio = box.width / box.height;

  // Must be clearly not square in landscape
  expect(
    ratio,
    `Expected rectangular arena in landscape, got ratio=${ratio.toFixed(3)} (w=${box.width.toFixed(
      1
    )}, h=${box.height.toFixed(1)})`
  ).toBeGreaterThan(1.15);

  return { box, ratio };
}

async function tryMaxZoomOutOnArena(page: any) {
  const box = await getArenaBox(page);

  // Move mouse into arena center
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  // Focus/click so wheel is captured by the canvas
  await page.mouse.down();
  await page.mouse.up();

  // Zoom-out attempts (single direction, deterministic)
  for (let i = 0; i < 18; i++) {
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(50);
  }

  // Let camera settle
  await page.waitForTimeout(350);
}

async function runScenario(browser: any, scenarioName: string, viewport: { width: number; height: number }) {
  const context = await browser.newContext({
    viewport,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });

  const page = await context.newPage();
  await prepareInitScripts(page);

  await gotoAndStabilize(page);

  const outDir = path.join(ARTIFACTS_DIR, scenarioName);
  ensureDir(outDir);

  // Assert + write meta before screenshots
  const { box, ratio } = await assertArenaRectangular(page);
  writeJson(path.join(outDir, 'meta.json'), {
    scenario: scenarioName,
    viewport,
    arena: {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      ratio,
    },
  });

  await screenshot(page, path.join(outDir, '01_start.png'));

  await tryMaxZoomOutOnArena(page);
  await screenshot(page, path.join(outDir, '02_zoomout.png'));

  await context.close();
}

test.describe('Mobile Landscape UI proof (start + max zoom-out)', () => {
  test('iPhone 15 Pro-ish landscape', async ({ browser }) => {
    // Landscape-ish viewport close to iPhone 15 Pro
    await runScenario(browser, 'iphone15pro_landscape', { width: 852, height: 393 });
  });

  test('Pixel 7-ish landscape', async ({ browser }) => {
    // Landscape-ish viewport close to Pixel 7
    await runScenario(browser, 'pixel7_landscape', { width: 915, height: 412 });
  });
});
