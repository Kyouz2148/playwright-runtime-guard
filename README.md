# playwright-runtime-guard

Automatic **Console & Network Guard** for Playwright.

Stop shipping green E2E tests that hide `console.error`, uncaught exceptions (`pageerror`), background `5xx` responses, or failed network requests. `playwright-runtime-guard` hooks into your Playwright `BrowserContext` (including popups and extra tabs) via an `auto: true` fixture or standalone helper and fails the test with an actionable report when unexpected runtime errors occur.

## Features

- **Zero-boilerplate auto-fixture**: Drop-in replacement `{ test, expect }` from `playwright-runtime-guard` or `extendTestWithGuard(yourCustomTest)`.
- **Four runtime signals covered**:
  - `console` errors (configurable `consoleTypes`, e.g. `['error', 'warning']`)
  - Uncaught `pageerror` exceptions and unhandled promise rejections
  - HTTP error responses (defaults to `5xx`; configurable to `'4xx+'`, status arrays, or custom predicates) with optional truncated JSON/text body snippet capture
  - Failed network requests (`requestfailed`), automatically ignoring benign browser navigation cancellations (`net::ERR_ABORTED`) unless `includeAbortedRequests: true`
- **Granular allowlists**: Match by substring, `RegExp`, structured rule objects (`url`, `status`, `method`, `resourceType`, `locationUrl`, `pageUrl`), or predicate functions.
- **Scoped & one-shot exceptions**: Use `runtimeGuard.runAllowed(...)`, `runtimeGuard.allowOnce(...)`, or `runtimeGuard.allow(...)` inside individual test steps that intentionally trigger errors.
- **Popup & multi-tab tracking**: Attaches at the `BrowserContext` level (and listens for `popup` events) so errors in new tabs or `window.open()` windows are never missed.
- **Playwright HTML Report attachments**: Automatically attaches `runtime-guard-report.json` and `runtime-guard-report.md` on violations.
- **Non-intrusive on existing test failures**: When a test already failed on a locator/assertion timeout, `runtime-guard` attaches the report and logs the violations without masking the original error (configurable via `failOnAlreadyFailedTest: true`).

## Installation

```bash
npm install -D playwright-runtime-guard
```

> Peer dependency: `@playwright/test >= 1.40.0`

## Quick Start

### 1. Drop-in fixture (`test` & `expect`)

```ts
import { test, expect } from 'playwright-runtime-guard';

test('checkout page loads cleanly', async ({ page }) => {
  await page.goto('/checkout');
  await expect(page.getByRole('heading', { name: 'Checkout' })).toBeVisible();
  // Automatically fails in teardown if console.error, pageerror, 5xx, or requestfailed occurred!
});
```

### 2. Custom project defaults (`createGuardTest` or `extendTestWithGuard`)

Create a shared `fixtures.ts` in your test suite:

```ts
// tests/fixtures.ts
import { test as base } from '@playwright/test';
import { extendTestWithGuard } from 'playwright-runtime-guard';

const myBaseTest = base.extend<{ loggedInUser: string }>({
  loggedInUser: async ({}, use) => {
    await use('alice@example.com');
  },
});

export const test = extendTestWithGuard(myBaseTest, {
  failOnHttpStatus: '4xx+',
  ignoreHttpErrors: [
    { url: '/favicon.ico', status: 404 },
    { url: /\/api\/feature-flags/, status: [404, 503] },
  ],
  ignoreConsole: [
    'ResizeObserver loop completed with undelivered notifications',
    /Download the React DevTools/,
  ],
});

export { expect } from '@playwright/test';
```

### 3. Per-file or per-describe overrides (`test.use`)

Ignore lists passed via `test.use({ guardOptions })` are merged **additively** with your global defaults, while scalar options (`mode`, `failOnHttpStatus`, etc.) override them:

```ts
import { test, expect } from './fixtures';

test.describe('legacy billing page', () => {
  test.use({
    guardOptions: {
      ignoreConsole: ['Legacy chart deprecation warning'],
      ignoreHttpErrors: [{ url: '/api/legacy-metrics', status: 500 }],
    },
  });

  test('renders billing summary', async ({ page }) => {
    await page.goto('/billing');
    await expect(page.getByText('Invoices')).toBeVisible();
  });
});
```

### 4. Scoped or one-shot allowlists inside a test

When a test step intentionally triggers an error (such as submitting an invalid form or testing retry behavior):

```ts
test('shows error banner on invalid coupon', async ({ page, runtimeGuard }) => {
  await page.goto('/cart');

  await runtimeGuard.runAllowed(
    {
      ignoreHttpErrors: [{ url: '/api/coupon', status: 422, method: 'POST' }],
      ignoreConsole: ['Coupon validation failed'],
    },
    async () => {
      await page.fill('#coupon', 'INVALID');
      await page.click('#apply-coupon');
      await expect(page.getByText('Invalid coupon')).toBeVisible();
    },
  );
});

test('retries once after 503', async ({ page, runtimeGuard }) => {
  // Consumes at most ONE 503 response on /api/orders; a second 503 still fails the test.
  runtimeGuard.allowOnce({
    ignoreHttpErrors: [{ url: '/api/orders', status: 503 }],
  });

  await page.goto('/orders');
});
```

### 5. Standalone usage (without fixture)

```ts
import { test } from '@playwright/test';
import { attachRuntimeGuard } from 'playwright-runtime-guard';

test('manual guard', async ({ page }) => {
  const guard = attachRuntimeGuard(page, {
    failOnHttpStatus: '5xx',
  });

  await page.goto('/dashboard');
  await guard.assertClean();
  guard.dispose();
});
```

## Configuration Options

| Option | Default | Description |
| --- | --- | --- |
| `mode` | `'fail'` (or `PW_GUARD_MODE`) | `'fail'` throws `RuntimeGuardError`, `'warn'` logs + annotates, `'off'` disables guard. |
| `failOnConsoleError` | `true` | Capture and fail on matching console messages. |
| `consoleTypes` | `['error']` | Console event types to capture (e.g., `['error', 'warning']`). |
| `dedupeBrowserResourceConsoleErrors` | `true` | Suppress synthetic `"Failed to load resource: ..."` console errors so network status/failure rules & allowlists aren't bypassed or duplicated. |
| `failOnPageError` | `true` | Capture uncaught exceptions and unhandled promise rejections. |
| `failOnHttpStatus` | `'5xx'` | `'5xx'` / `true`, `'4xx+'`, `number[]`, `(status, ctx) => boolean`, or `false`. |
| `failOnRequestFailed` | `true` | Capture network-level request failures (`net::ERR_CONNECTION_REFUSED`, etc.). |
| `includeAbortedRequests` | `false` | Include `net::ERR_ABORTED` / `NS_BINDING_ABORTED` navigation cancellations. |
| `captureResponseBody` | `true` | Capture up to 500 chars of JSON/text error response bodies. |
| `trackPopups` | `true` | Automatically guard popups (`window.open`) and extra context pages. |
| `attachReport` | `'on-violation'` | Attach `runtime-guard-report.json` and `.md` (`'on-violation' \| 'always' \| 'never'`). |
| `failOnAlreadyFailedTest` | `false` | If `false`, attaches/logs violations without replacing a prior assertion/timeout error. |
| `ignoreConsole` | `[]` | Allowlist rules for console messages. |
| `ignorePageErrors` | `[]` | Allowlist rules for uncaught page errors. |
| `ignoreHttpErrors` | `[]` | Allowlist rules for HTTP error responses. |
| `ignoreRequestFailed` | `[]` | Allowlist rules for failed network requests. |
| `onViolation` | `undefined` | Callback invoked on each unignored violation. |

## Example Failure Output

When a violation slips into a test, `playwright-runtime-guard` fails the test with a grouped summary and attaches `runtime-guard-report.json` and `runtime-guard-report.md` to the Playwright HTML Report:

```text
Error: [runtime-guard] Detected 2 runtime violation(s) (console: 1, pageerror: 0, http: 1, requestfailed: 0, ignored: 1)

Console Errors (1):
  - [error] Broken widget state (http://127.0.0.1:41203/app.js:18:9)
    page: http://127.0.0.1:41203/checkout

HTTP Error Responses (1):
  - 500 Internal Server Error POST http://127.0.0.1:41203/api/orders [fetch]
    page: http://127.0.0.1:41203/checkout
    body: {"error":"upstream timeout"}
```

## Environment Variable

Temporarily switch enforcement mode across an entire run without editing code:

```bash
PW_GUARD_MODE=warn npx playwright test
PW_GUARD_MODE=off npx playwright test
```

## Development

```bash
npm install
npm test
```

## License

MIT
