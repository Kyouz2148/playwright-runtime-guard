import { test as vanillaTest } from '@playwright/test';
import {
  attachRuntimeGuard,
  expect,
  extendTestWithGuard,
  test,
} from '../../src/index.js';
import { startTestServer, type TestServer } from './fixtures/server.js';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server.close();
});

test('passes cleanly on pages without runtime errors', async ({ page, runtimeGuard }) => {
  await page.goto(`${server.url}/`);
  await expect(page.locator('h1')).toHaveText('Clean Page');
  expect(runtimeGuard.hasViolations()).toBe(false);
});

test('captures console.error and supports runAllowed + clear', async ({
  page,
  runtimeGuard,
}) => {
  await runtimeGuard.runAllowed({ ignoreConsole: ['Broken widget state'] }, async () => {
    await page.goto(`${server.url}/console-error`);
  });

  expect(runtimeGuard.hasViolations()).toBe(false);
  expect(runtimeGuard.getIgnored().length).toBe(1);

  runtimeGuard.pause();
  await page.goto(`${server.url}/console-error`);
  expect(runtimeGuard.hasViolations()).toBe(false);
  runtimeGuard.resume();
});

test('captures uncaught pageerror and unhandled promise rejection', async ({
  page,
  runtimeGuard,
}) => {
  runtimeGuard.allowOnce({ ignorePageErrors: ['Async uncaught boom'] });
  await page.goto(`${server.url}/page-error`);
  await page.waitForTimeout(80);
  expect(runtimeGuard.hasViolations()).toBe(false);
  expect(runtimeGuard.getIgnored().length).toBe(1);

  await runtimeGuard.runAllowed(
    { ignorePageErrors: [{ message: /Unhandled promise boom/ }] },
    async () => {
      await page.goto(`${server.url}/unhandled-rejection`);
      await page.waitForTimeout(50);
    },
  );
  expect(runtimeGuard.hasViolations()).toBe(false);
});

test('captures 500 background fetch with response body snippet', async ({
  page,
  runtimeGuard,
}) => {
  // Switch to warn mode dynamically? Better: capture via allow + inspect getIgnored,
  // or attach a second standalone guard to inspect recorded violation directly!
  const observerGuard = attachRuntimeGuard(page, {
    mode: 'warn',
    captureResponseBody: true,
  });

  runtimeGuard.allow({ ignoreHttpErrors: [{ url: '/api/boom', status: 500 }] });

  await page.goto(`${server.url}/fetch-500`);
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.url().endsWith('/api/boom')),
    page.click('#trigger'),
  ]);
  expect(response.status()).toBe(500);

  await observerGuard.flush();
  const violations = observerGuard.getViolations();
  observerGuard.dispose();

  expect(violations.length).toBe(1);
  const httpViolation = violations[0];
  expect(httpViolation?.kind).toBe('http');
  if (httpViolation?.kind === 'http') {
    expect(httpViolation.status).toBe(500);
    expect(httpViolation.method).toBe('GET');
    expect(httpViolation.bodySnippet).toContain('upstream timeout');
  }
});

test('ignores 404 by default (5xx) and ignores net::ERR_ABORTED during navigation', async ({
  page,
  runtimeGuard,
}) => {
  await page.goto(`${server.url}/fetch-404`);
  await Promise.all([
    page.waitForResponse((res) => res.url().endsWith('/api/missing')),
    page.click('#trigger'),
  ]);
  expect(runtimeGuard.hasViolations()).toBe(false);

  await page.goto(`${server.url}/fetch-aborted`);
  await page.waitForURL(`${server.url}/`);
  expect(runtimeGuard.hasViolations()).toBe(false);
});

test('tracks popup windows opened via window.open', async ({ page, runtimeGuard }) => {
  runtimeGuard.allow({ ignoreConsole: ['Broken widget state'] });

  await page.goto(`${server.url}/popup-opener`);
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.click('#open'),
  ]);
  await popup.waitForLoadState('domcontentloaded');

  expect(runtimeGuard.hasViolations()).toBe(false);
  expect(runtimeGuard.getIgnored().some((i) => i.violation.kind === 'console')).toBe(true);
});

test.describe('test.use({ guardOptions }) overrides and additive allowlists', () => {
  test.use({
    guardOptions: {
      failOnHttpStatus: '4xx+',
      ignoreHttpErrors: [
        { url: '/api/missing', status: 404 },
        { url: '/favicon.ico', status: 404 },
      ],
    },
  });

  test('applies 4xx+ rule together with describe-level allowlist', async ({
    page,
    runtimeGuard,
  }) => {
    await page.goto(`${server.url}/fetch-404`);
    await Promise.all([
      page.waitForResponse((res) => res.url().endsWith('/api/missing')),
      page.click('#trigger'),
    ]);
    expect(runtimeGuard.hasViolations()).toBe(false);
    expect(
      runtimeGuard
        .getIgnored()
        .some(
          (i) => i.violation.kind === 'http' && i.violation.url.endsWith('/api/missing'),
        ),
    ).toBe(true);
  });
});

test.describe('extendTestWithGuard preserves custom user fixtures', () => {
  const customTest = extendTestWithGuard(
    vanillaTest.extend<{ greeting: string }>({
      greeting: async ({}, use) => {
        await use('hello-guard');
      },
    }),
    { ignoreConsole: ['Broken widget state'] },
  );

  customTest('runs custom fixture alongside automatic runtimeGuard', async ({
    page,
    greeting,
    runtimeGuard,
  }) => {
    expect(greeting).toBe('hello-guard');
    await page.goto(`${server.url}/console-error`);
    expect(runtimeGuard.hasViolations()).toBe(false);
    expect(runtimeGuard.getIgnored().length).toBe(1);
  });
});
