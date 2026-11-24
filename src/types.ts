import type { BrowserContext, ConsoleMessage, Page, Request, Response } from '@playwright/test';

/**
 * String matching uses substring inclusion (`value.includes(pattern)`).
 * Use a `RegExp` for exact or complex pattern matching.
 */
export type StringPattern = string | RegExp;

export type GuardMode = 'fail' | 'warn' | 'off';

export type AttachReportMode = 'on-violation' | 'always' | 'never';

export type HttpFailRule =
  | boolean
  | '5xx'
  | '4xx+'
  | '4xx-5xx'
  | number[]
  | ((status: number, ctx: HttpErrorMatchContext) => boolean);

export interface ConsoleMatchContext {
  type: string;
  text: string;
  location: {
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  pageUrl: string;
  message?: ConsoleMessage;
}

export interface PageErrorMatchContext {
  name: string;
  message: string;
  stack?: string;
  pageUrl: string;
  error?: Error;
}

export interface HttpErrorMatchContext {
  status: number;
  statusText: string;
  method: string;
  url: string;
  resourceType: string;
  pageUrl: string;
  bodySnippet?: string;
  response?: Response;
}

export interface RequestFailedMatchContext {
  method: string;
  url: string;
  resourceType: string;
  failureText: string;
  pageUrl: string;
  request?: Request;
}

export interface ConsoleIgnoreRule {
  text?: StringPattern;
  type?: string | string[];
  locationUrl?: StringPattern;
  pageUrl?: StringPattern;
}

export type ConsoleMatcher =
  | StringPattern
  | ConsoleIgnoreRule
  | ((ctx: ConsoleMatchContext) => boolean);

export interface PageErrorIgnoreRule {
  message?: StringPattern;
  name?: StringPattern;
  stack?: StringPattern;
  pageUrl?: StringPattern;
}

export type PageErrorMatcher =
  | StringPattern
  | PageErrorIgnoreRule
  | ((ctx: PageErrorMatchContext) => boolean);

export interface HttpIgnoreRule {
  url?: StringPattern;
  status?: number | number[] | ((status: number) => boolean);
  method?: string | string[];
  resourceType?: string | string[];
  pageUrl?: StringPattern;
}

export type HttpMatcher =
  | StringPattern
  | HttpIgnoreRule
  | ((ctx: HttpErrorMatchContext) => boolean);

export interface RequestFailedIgnoreRule {
  url?: StringPattern;
  failureText?: StringPattern;
  method?: string | string[];
  resourceType?: string | string[];
  pageUrl?: StringPattern;
}

export type RequestFailedMatcher =
  | StringPattern
  | RequestFailedIgnoreRule
  | ((ctx: RequestFailedMatchContext) => boolean);

export interface GuardAllowRules {
  ignoreConsole?: ConsoleMatcher[];
  ignorePageErrors?: PageErrorMatcher[];
  ignoreHttpErrors?: HttpMatcher[];
  ignoreRequestFailed?: RequestFailedMatcher[];
}

export interface CaptureResponseBodyOptions {
  enabled?: boolean;
  maxLength?: number;
  contentTypes?: string[];
}

export interface RuntimeGuardOptions extends GuardAllowRules {
  /**
   * Enforcement mode:
   * - `'fail'`: fail the test / throw on violations (default)
   * - `'warn'`: log warnings and attach reports without failing the test
   * - `'off'`: disable capturing completely
   */
  mode?: GuardMode;

  /**
   * Fail when a console message matching `consoleTypes` is emitted.
   * @default true
   */
  failOnConsoleError?: boolean;

  /**
   * Console message types to capture (e.g. `['error']`, `['error', 'warning']`).
   * @default ['error']
   */
  consoleTypes?: string[];

  /**
   * Suppress browser-generated synthetic `"Failed to load resource: ..."` console messages
   * (such as Chromium's 4xx/5xx or `net::ERR_*` console logs) so network errors are evaluated
   * cleanly through `failOnHttpStatus` / `failOnRequestFailed` and their allowlists without duplicates.
   * @default true
   */
  dedupeBrowserResourceConsoleErrors?: boolean;

  /**
   * Fail on uncaught page exceptions (`pageerror`).
   * @default true
   */
  failOnPageError?: boolean;

  /**
   * Which HTTP status codes count as violations.
   * - `'5xx'` or `true`: status 500-599 (default)
   * - `'4xx+'` or `'4xx-5xx'`: status >= 400
   * - `number[]`: explicit status codes
   * - predicate `(status, ctx) => boolean`
   * - `false`: disabled
   * @default '5xx'
   */
  failOnHttpStatus?: HttpFailRule;

  /**
   * Fail when a network request fails (`requestfailed`, e.g. DNS/connection errors).
   * @default true
   */
  failOnRequestFailed?: boolean;

  /**
   * Include browser-aborted requests (`net::ERR_ABORTED`, `NS_BINDING_ABORTED`),
   * which normally happen during mid-flight navigation.
   * @default false
   */
  includeAbortedRequests?: boolean;

  /**
   * Capture a truncated text/JSON response body snippet for failing HTTP responses.
   * @default true
   */
  captureResponseBody?: boolean | CaptureResponseBodyOptions;

  /**
   * Automatically guard popup pages opened via `window.open` / `target="_blank"`.
   * @default true
   */
  trackPopups?: boolean;

  /**
   * When to attach JSON & Markdown reports to Playwright `testInfo`.
   * @default 'on-violation'
   */
  attachReport?: AttachReportMode;

  /**
   * Also throw `RuntimeGuardError` during teardown even when the test already failed
   * for another assertion/timeout. When `false`, the report is still attached and logged
   * without hiding the primary test error.
   * @default false
   */
  failOnAlreadyFailedTest?: boolean;

  /**
   * Optional callback invoked whenever a non-ignored violation is recorded.
   */
  onViolation?: (violation: GuardViolation) => void | Promise<void>;
}

export type ViolationKind = 'console' | 'pageerror' | 'http' | 'requestfailed';

export interface BaseViolation {
  id: string;
  kind: ViolationKind;
  timestamp: string;
  pageUrl: string;
}

export interface ConsoleViolation extends BaseViolation {
  kind: 'console';
  consoleType: string;
  text: string;
  location: {
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
}

export interface PageErrorViolation extends BaseViolation {
  kind: 'pageerror';
  name: string;
  message: string;
  stack?: string;
}

export interface HttpErrorViolation extends BaseViolation {
  kind: 'http';
  status: number;
  statusText: string;
  method: string;
  url: string;
  resourceType: string;
  bodySnippet?: string;
}

export interface RequestFailedViolation extends BaseViolation {
  kind: 'requestfailed';
  method: string;
  url: string;
  resourceType: string;
  failureText: string;
}

export type GuardViolation =
  | ConsoleViolation
  | PageErrorViolation
  | HttpErrorViolation
  | RequestFailedViolation;

export interface IgnoredViolation {
  violation: GuardViolation;
  matchedBy: string;
}

export interface GuardReportSummary {
  totalViolations: number;
  consoleErrors: number;
  pageErrors: number;
  httpErrors: number;
  requestFailures: number;
  ignoredCount: number;
}

export interface GuardReport {
  startedAt: string;
  endedAt: string;
  mode: GuardMode;
  summary: GuardReportSummary;
  violations: GuardViolation[];
  ignored: IgnoredViolation[];
}

export type GuardTarget = Page | BrowserContext;
