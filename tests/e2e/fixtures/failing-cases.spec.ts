import { expect, test } from '../../../dist/fixture.js';
import { startTestServer, type TestServer } from './server.js';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server.close();
});

test('fails on unignored console.error', async ({ page }) => {
  await page.goto(`${server.url}/console-error`);
  await expect(page.locator('h1')).toHaveText('Console Error Page');
});

test('fails on unignored 500 background fetch', async ({ page }) => {
  await page.goto(`${server.url}/fetch-500`);
  await Promise.all([
    page.waitForResponse((res) => res.url().endsWith('/api/boom')),
    page.click('#trigger'),
  ]);
});

test('fails on unignored pageerror', async ({ page }) => {
  await page.goto(`${server.url}/page-error`);
  await page.waitForTimeout(80);
});

test.describe('warn mode', () => {
  test.use({
    guardOptions: {
      mode: 'warn',
    },
  });

  test('passes in warn mode despite console error', async ({ page }) => {
    await page.goto(`${server.url}/console-error`);
    await expect(page.locator('h1')).toHaveText('Console Error Page');
  });
});
