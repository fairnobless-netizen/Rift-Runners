import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const ARTIFACTS_DIR = path.join(process.cwd(), 'artifacts', 'ui');

type Scenario = {
  name: string;
  viewport: { width: number; height: number };
};

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

async function prepareInitScripts(page: Page) {
  // Collapse WS debug overlay tray so it doesn't block UI.
  await page.addInitScript(() => {
    localStorage.setItem('ws-debug-overlay-collapsed', '1');
  });
}

async function gotoAndStabilize(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.playfield-shell', { timeout: 30000 });
  await page.waitForSelector('.game-canvas', { timeout: 30000 });
  await page.waitForTimeout(700);
}

async function screenshot(page: Page, outPath: string) {
  await page.screenshot({ path: outPath, fullPage: true });
}

async function readArenaMetrics(page: Page) {
  const arena = page.locator('.game-canvas').first();
  const box = await arena.boundingBox();

  expect(box, 'Expected .game-canvas bounding box to be available').not.toBeNull();

  const ratio = (box?.width ?? 0) / (box?.height ?? 1);
  const stretch = ratio >= 1 ? ratio : 1 / ratio;

  expect(stretch).toBeGreaterThan(1.15);

  return {
    x: box?.x ?? 0,
    y: box?.y ?? 0,
    width: box?.width ?? 0,
    height: box?.height ?? 0,
    ratio,
    stretch,
  };
}

async function writeMeta(outDir: string, scenario: Scenario, page: Page) {
  const arena = await readArenaMetrics(page);
  fs.writeFileSync(
    path.join(outDir, 'meta.json'),
    JSON.stringify(
      {
        scenario: scenario.name,
        viewport: scenario.viewport,
        arena,
      },
      null,
      2,
    ),
  );
}

async function deterministicMaxZoomOut(page: Page) {
  const arena = page.locator('.game-canvas').first();
  const box = await arena.boundingBox();
  expect(box, 'Expected .game-canvas bounding box before zoom-out').not.toBeNull();

  const centerX = (box?.x ?? 0) + (box?.width ?? 0) / 2;
  const centerY = (box?.y ?? 0) + (box?.height ?? 0) / 2;

  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.up();

  for (let i = 0; i < 16; i++) {
    await page.mouse.wheel(0, 480);
    await page.waitForTimeout(55);
  }

  await page.waitForTimeout(325);
}

async function runScenario(browserContextFactory: () => Promise<BrowserContext>, scenario: Scenario) {
  const context = await browserContextFactory();
  const page = await context.newPage();

  await prepareInitScripts(page);
  await gotoAndStabilize(page);

  const outDir = path.join(ARTIFACTS_DIR, scenario.name);
  ensureDir(outDir);

  await screenshot(page, path.join(outDir, '01_start.png'));
  await deterministicMaxZoomOut(page);
  await screenshot(page, path.join(outDir, '02_zoomout.png'));
  await writeMeta(outDir, scenario, page);

  await context.close();
}

test.describe('Mobile Landscape UI proof', () => {
  test('iPhone 15 Pro landscape: start + zoom-out', async ({ browser }) => {
    const scenario: Scenario = {
      name: 'iphone15pro_landscape',
      viewport: { width: 852, height: 393 },
    };

    await runScenario(
      () =>
        browser.newContext({
          viewport: scenario.viewport,
          isMobile: true,
          hasTouch: true,
          deviceScaleFactor: 3,
        }),
      scenario,
    );
  });

  test('Pixel 7 landscape: start + zoom-out', async ({ browser }) => {
    const scenario: Scenario = {
      name: 'pixel7_landscape',
      viewport: { width: 915, height: 412 },
    };

    await runScenario(
      () =>
        browser.newContext({
          viewport: scenario.viewport,
          isMobile: true,
          hasTouch: true,
          deviceScaleFactor: 3,
        }),
      scenario,
    );
  });
});
