import {
  expect,
  test as baseTest,
  type TestType,
  type PlaywrightTestArgs,
  type PlaywrightTestOptions,
  type PlaywrightWorkerArgs,
  type PlaywrightWorkerOptions,
} from '@playwright/test';
import {
  RuntimeGuardError,
  formatGuardReport,
  formatMarkdownReport,
} from './formatter.js';
import { RuntimeGuard } from './guard.js';
import { mergeGuardOptions } from './matchers.js';
import type { RuntimeGuardOptions } from './types.js';

export interface RuntimeGuardFixtures {
  /**
   * Per-file or per-describe options for `runtimeGuard`, configurable via `test.use({ guardOptions: ... })`.
   */
  guardOptions: RuntimeGuardOptions;

  /**
   * Automatically attached `RuntimeGuard` instance for the current test's `BrowserContext`.
   */
  runtimeGuard: RuntimeGuard;
}

/**
 * Extend any Playwright `test` instance (including your own custom fixture `test`)
 * with the automatic `runtimeGuard` and `guardOptions` fixtures.
 */
export function extendTestWithGuard<
  TestArgs extends PlaywrightTestArgs & PlaywrightTestOptions,
  WorkerArgs extends PlaywrightWorkerArgs & PlaywrightWorkerOptions,
>(
  base: TestType<TestArgs, WorkerArgs>,
  defaultOptions: RuntimeGuardOptions = {},
): TestType<TestArgs & RuntimeGuardFixtures, WorkerArgs> {
  const typedBase = base as unknown as TestType<
    PlaywrightTestArgs & PlaywrightTestOptions,
    PlaywrightWorkerArgs & PlaywrightWorkerOptions
  >;

  return typedBase.extend<RuntimeGuardFixtures>({
    guardOptions: [{}, { option: true }],

    runtimeGuard: [
      async ({ context, guardOptions }, use, testInfo) => {
        const mergedOptions = mergeGuardOptions(defaultOptions, guardOptions);
        const guard = new RuntimeGuard(mergedOptions).attach(context);

        try {
          await use(guard);
        } finally {
          await guard.flush(500);
          guard.dispose();

          const report = guard.getReport();
          const attachMode = mergedOptions.attachReport ?? 'on-violation';
          const shouldAttach =
            attachMode === 'always' ||
            (attachMode === 'on-violation' && report.violations.length > 0);

          if (shouldAttach) {
            await Promise.allSettled([
              testInfo.attach('runtime-guard-report.json', {
                body: Buffer.from(JSON.stringify(report, null, 2), 'utf8'),
                contentType: 'application/json',
              }),
              testInfo.attach('runtime-guard-report.md', {
                body: Buffer.from(formatMarkdownReport(report), 'utf8'),
                contentType: 'text/markdown',
              }),
            ]);
          }

          if (report.violations.length > 0) {
            const testAlreadyFailed =
              testInfo.error !== undefined ||
              (testInfo.status !== undefined &&
                testInfo.status !== testInfo.expectedStatus);

            if (guard.mode === 'warn') {
              console.warn(formatGuardReport(report));
              testInfo.annotations.push({
                type: 'runtime-guard',
                description: `${report.summary.totalViolations} violation(s) detected (warn mode)`,
              });
            } else if (guard.mode === 'fail') {
              if (!testAlreadyFailed || mergedOptions.failOnAlreadyFailedTest) {
                throw new RuntimeGuardError(report);
              }
              console.error(
                formatGuardReport(report, {
                  messagePrefix:
                    '[runtime-guard] Runtime violations also detected during failed test',
                }),
              );
              testInfo.annotations.push({
                type: 'runtime-guard',
                description: `${report.summary.totalViolations} runtime violation(s) captured`,
              });
            }
          }
        }
      },
      { auto: true },
    ],
  }) as unknown as TestType<TestArgs & RuntimeGuardFixtures, WorkerArgs>;
}

/**
 * Create a Playwright `{ test, expect }` pair pre-configured with default `RuntimeGuardOptions`.
 */
export function createGuardTest(defaultOptions: RuntimeGuardOptions = {}) {
  const test = extendTestWithGuard(baseTest, defaultOptions);
  return { test, expect };
}

const defaultExport = createGuardTest();

/**
 * Pre-configured Playwright `test` with automatic `runtimeGuard` enabled.
 */
export const test = defaultExport.test;

export { expect };
