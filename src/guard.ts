import type { BrowserContext, ConsoleMessage, Page, Request, Response } from '@playwright/test';
import { RuntimeGuardError } from './formatter.js';
import {
  describeMatcher,
  isAbortedFailureText,
  isSyntheticResourceConsoleError,
  matchesConsoleRule,
  matchesHttpErrorRule,
  matchesPageErrorRule,
  matchesRequestFailedRule,
  parseEnvGuardMode,
  shouldFailOnHttpStatus,
} from './matchers.js';
import type {
  CaptureResponseBodyOptions,
  ConsoleMatchContext,
  ConsoleMatcher,
  ConsoleViolation,
  GuardAllowRules,
  GuardMode,
  GuardReport,
  GuardTarget,
  GuardViolation,
  HttpErrorMatchContext,
  HttpErrorViolation,
  HttpMatcher,
  IgnoredViolation,
  PageErrorMatchContext,
  PageErrorMatcher,
  PageErrorViolation,
  RequestFailedMatchContext,
  RequestFailedMatcher,
  RequestFailedViolation,
  RuntimeGuardOptions,
} from './types.js';

const DEFAULT_TEXT_CONTENT_TYPES = [
  'application/json',
  'application/problem+json',
  'application/xml',
  'text/',
];

interface OneShotRule<T> {
  matcher: T;
  consumed: boolean;
}

interface ScopedRules {
  rules: GuardAllowRules;
}

function isBrowserContext(target: GuardTarget): target is BrowserContext {
  return typeof (target as BrowserContext).pages === 'function';
}

function resolveBodyCaptureOptions(
  opt: RuntimeGuardOptions['captureResponseBody'],
): Required<CaptureResponseBodyOptions> {
  if (opt === false) {
    return {
      enabled: false,
      maxLength: 0,
      contentTypes: DEFAULT_TEXT_CONTENT_TYPES,
    };
  }
  if (opt === true || opt === undefined) {
    return {
      enabled: true,
      maxLength: 500,
      contentTypes: DEFAULT_TEXT_CONTENT_TYPES,
    };
  }
  return {
    enabled: opt.enabled ?? true,
    maxLength: opt.maxLength ?? 500,
    contentTypes: opt.contentTypes ?? DEFAULT_TEXT_CONTENT_TYPES,
  };
}

function safePageUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

export class RuntimeGuard {
  readonly mode: GuardMode;
  private readonly options: RuntimeGuardOptions;
  private readonly bodyOptions: Required<CaptureResponseBodyOptions>;
  private readonly consoleTypes: Set<string>;
  private readonly startedAt: string;

  private readonly persistentAllow: Required<GuardAllowRules>;
  private readonly oneShotAllow: {
    ignoreConsole: Array<OneShotRule<ConsoleMatcher>>;
    ignorePageErrors: Array<OneShotRule<PageErrorMatcher>>;
    ignoreHttpErrors: Array<OneShotRule<HttpMatcher>>;
    ignoreRequestFailed: Array<OneShotRule<RequestFailedMatcher>>;
  };
  private readonly scopedAllowStack: ScopedRules[] = [];

  private readonly violations: GuardViolation[] = [];
  private readonly ignored: IgnoredViolation[] = [];
  private readonly attachedPages = new WeakSet<Page>();
  private readonly cleanupFns: Array<() => void> = [];
  private readonly pendingTasks = new Set<Promise<void>>();

  private seq = 0;
  private paused = false;
  private disposed = false;

  constructor(options: RuntimeGuardOptions = {}) {
    this.options = options;
    this.mode =
      options.mode ?? parseEnvGuardMode(process.env.PW_GUARD_MODE) ?? 'fail';
    this.bodyOptions = resolveBodyCaptureOptions(options.captureResponseBody);
    this.consoleTypes = new Set(options.consoleTypes ?? ['error']);
    this.startedAt = new Date().toISOString();

    this.persistentAllow = {
      ignoreConsole: [...(options.ignoreConsole ?? [])],
      ignorePageErrors: [...(options.ignorePageErrors ?? [])],
      ignoreHttpErrors: [...(options.ignoreHttpErrors ?? [])],
      ignoreRequestFailed: [...(options.ignoreRequestFailed ?? [])],
    };

    this.oneShotAllow = {
      ignoreConsole: [],
      ignorePageErrors: [],
      ignoreHttpErrors: [],
      ignoreRequestFailed: [],
    };
  }

  /**
   * Attach this guard to a Playwright `Page` or `BrowserContext`.
   */
  attach(target: GuardTarget): this {
    if (this.disposed || this.mode === 'off') {
      return this;
    }

    if (isBrowserContext(target)) {
      for (const existingPage of target.pages()) {
        this.attachPage(existingPage);
      }
      const onPage = (page: Page) => {
        this.attachPage(page);
      };
      target.on('page', onPage);
      this.cleanupFns.push(() => {
        target.off('page', onPage);
      });
    } else {
      this.attachPage(target);
    }

    return this;
  }

  private attachPage(page: Page): void {
    if (this.disposed || this.mode === 'off' || this.attachedPages.has(page)) {
      return;
    }
    this.attachedPages.add(page);

    const onConsole = (msg: ConsoleMessage) => {
      this.handleConsole(page, msg);
    };
    const onPageError = (error: Error) => {
      this.handlePageError(page, error);
    };
    const onResponse = (response: Response) => {
      this.handleResponse(page, response);
    };
    const onRequestFailed = (request: Request) => {
      this.handleRequestFailed(page, request);
    };

    page.on('console', onConsole);
    page.on('pageerror', onPageError);
    page.on('response', onResponse);
    page.on('requestfailed', onRequestFailed);

    let onPopup: ((popup: Page) => void) | undefined;
    if (this.options.trackPopups !== false) {
      onPopup = (popup: Page) => {
        this.attachPage(popup);
      };
      page.on('popup', onPopup);
    }

    this.cleanupFns.push(() => {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
      if (onPopup) {
        page.off('popup', onPopup);
      }
    });
  }

  /**
   * Add allowlist rules for the remainder of the test / guard lifetime.
   */
  allow(rules: GuardAllowRules): this {
    if (rules.ignoreConsole) {
      this.persistentAllow.ignoreConsole.push(...rules.ignoreConsole);
    }
    if (rules.ignorePageErrors) {
      this.persistentAllow.ignorePageErrors.push(...rules.ignorePageErrors);
    }
    if (rules.ignoreHttpErrors) {
      this.persistentAllow.ignoreHttpErrors.push(...rules.ignoreHttpErrors);
    }
    if (rules.ignoreRequestFailed) {
      this.persistentAllow.ignoreRequestFailed.push(...rules.ignoreRequestFailed);
    }
    return this;
  }

  /**
   * Add one-shot allowlist rules. Each rule ignores at most one matching event.
   */
  allowOnce(rules: GuardAllowRules): this {
    if (rules.ignoreConsole) {
      for (const matcher of rules.ignoreConsole) {
        this.oneShotAllow.ignoreConsole.push({ matcher, consumed: false });
      }
    }
    if (rules.ignorePageErrors) {
      for (const matcher of rules.ignorePageErrors) {
        this.oneShotAllow.ignorePageErrors.push({ matcher, consumed: false });
      }
    }
    if (rules.ignoreHttpErrors) {
      for (const matcher of rules.ignoreHttpErrors) {
        this.oneShotAllow.ignoreHttpErrors.push({ matcher, consumed: false });
      }
    }
    if (rules.ignoreRequestFailed) {
      for (const matcher of rules.ignoreRequestFailed) {
        this.oneShotAllow.ignoreRequestFailed.push({ matcher, consumed: false });
      }
    }
    return this;
  }

  /**
   * Execute an async action with temporary allowlist rules scoped only to that action.
   */
  async runAllowed<T>(rules: GuardAllowRules, fn: () => Promise<T> | T): Promise<T> {
    const scope: ScopedRules = { rules };
    this.scopedAllowStack.push(scope);
    try {
      const result = await fn();
      await this.flush(200);
      return result;
    } finally {
      const idx = this.scopedAllowStack.lastIndexOf(scope);
      if (idx !== -1) {
        this.scopedAllowStack.splice(idx, 1);
      }
    }
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  isPaused(): boolean {
    return this.paused;
  }

  clear(): void {
    this.violations.length = 0;
    this.ignored.length = 0;
  }

  async flush(timeoutMs = 500): Promise<void> {
    if (this.pendingTasks.size === 0) return;
    const tasks = Promise.allSettled(Array.from(this.pendingTasks));
    if (timeoutMs <= 0) {
      await tasks;
      return;
    }
    await Promise.race([
      tasks,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  getViolations(): GuardViolation[] {
    return [...this.violations];
  }

  getIgnored(): IgnoredViolation[] {
    return [...this.ignored];
  }

  hasViolations(): boolean {
    return this.violations.length > 0;
  }

  getReport(): GuardReport {
    let consoleErrors = 0;
    let pageErrors = 0;
    let httpErrors = 0;
    let requestFailures = 0;

    for (const v of this.violations) {
      if (v.kind === 'console') consoleErrors++;
      else if (v.kind === 'pageerror') pageErrors++;
      else if (v.kind === 'http') httpErrors++;
      else if (v.kind === 'requestfailed') requestFailures++;
    }

    return {
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      mode: this.mode,
      summary: {
        totalViolations: this.violations.length,
        consoleErrors,
        pageErrors,
        httpErrors,
        requestFailures,
        ignoredCount: this.ignored.length,
      },
      violations: [...this.violations],
      ignored: [...this.ignored],
    };
  }

  async assertClean(messagePrefix?: string): Promise<void> {
    await this.flush();
    if (this.violations.length > 0) {
      throw new RuntimeGuardError(this.getReport(), messagePrefix);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanupFns) {
      try {
        cleanup();
      } catch {
        // Ignore teardown listener cleanup errors on already-closed pages.
      }
    }
    this.cleanupFns.length = 0;
  }

  private nextId(): string {
    this.seq += 1;
    return `rg-${this.seq}`;
  }

  private recordViolation(violation: GuardViolation): void {
    this.violations.push(violation);
    if (this.options.onViolation) {
      try {
        const res = this.options.onViolation(violation);
        if (res && typeof (res as Promise<void>).then === 'function') {
          this.trackPending(
            Promise.resolve(res).catch(() => {
              // Do not crash Playwright event loop if user callback throws.
            }),
          );
        }
      } catch {
        // Ignore synchronous errors from user telemetry callback.
      }
    }
  }

  private recordIgnored(violation: GuardViolation, matchedBy: string): void {
    this.ignored.push({ violation, matchedBy });
  }

  private trackPending(promise: Promise<void>): void {
    this.pendingTasks.add(promise);
    void promise.finally(() => {
      this.pendingTasks.delete(promise);
    });
  }

  private findMatchedConsoleRule(ctx: ConsoleMatchContext): string | undefined {
    for (const matcher of this.persistentAllow.ignoreConsole) {
      if (matchesConsoleRule(ctx, matcher)) {
        return describeMatcher(matcher);
      }
    }
    for (const scope of this.scopedAllowStack) {
      for (const matcher of scope.rules.ignoreConsole ?? []) {
        if (matchesConsoleRule(ctx, matcher)) {
          return `scoped:${describeMatcher(matcher)}`;
        }
      }
    }
    for (const entry of this.oneShotAllow.ignoreConsole) {
      if (!entry.consumed && matchesConsoleRule(ctx, entry.matcher)) {
        entry.consumed = true;
        return `once:${describeMatcher(entry.matcher)}`;
      }
    }
    return undefined;
  }

  private findMatchedPageErrorRule(ctx: PageErrorMatchContext): string | undefined {
    for (const matcher of this.persistentAllow.ignorePageErrors) {
      if (matchesPageErrorRule(ctx, matcher)) {
        return describeMatcher(matcher);
      }
    }
    for (const scope of this.scopedAllowStack) {
      for (const matcher of scope.rules.ignorePageErrors ?? []) {
        if (matchesPageErrorRule(ctx, matcher)) {
          return `scoped:${describeMatcher(matcher)}`;
        }
      }
    }
    for (const entry of this.oneShotAllow.ignorePageErrors) {
      if (!entry.consumed && matchesPageErrorRule(ctx, entry.matcher)) {
        entry.consumed = true;
        return `once:${describeMatcher(entry.matcher)}`;
      }
    }
    return undefined;
  }

  private findMatchedHttpRule(ctx: HttpErrorMatchContext): string | undefined {
    for (const matcher of this.persistentAllow.ignoreHttpErrors) {
      if (matchesHttpErrorRule(ctx, matcher)) {
        return describeMatcher(matcher);
      }
    }
    for (const scope of this.scopedAllowStack) {
      for (const matcher of scope.rules.ignoreHttpErrors ?? []) {
        if (matchesHttpErrorRule(ctx, matcher)) {
          return `scoped:${describeMatcher(matcher)}`;
        }
      }
    }
    for (const entry of this.oneShotAllow.ignoreHttpErrors) {
      if (!entry.consumed && matchesHttpErrorRule(ctx, entry.matcher)) {
        entry.consumed = true;
        return `once:${describeMatcher(entry.matcher)}`;
      }
    }
    return undefined;
  }

  private findMatchedRequestFailedRule(
    ctx: RequestFailedMatchContext,
  ): string | undefined {
    for (const matcher of this.persistentAllow.ignoreRequestFailed) {
      if (matchesRequestFailedRule(ctx, matcher)) {
        return describeMatcher(matcher);
      }
    }
    for (const scope of this.scopedAllowStack) {
      for (const matcher of scope.rules.ignoreRequestFailed ?? []) {
        if (matchesRequestFailedRule(ctx, matcher)) {
          return `scoped:${describeMatcher(matcher)}`;
        }
      }
    }
    for (const entry of this.oneShotAllow.ignoreRequestFailed) {
      if (!entry.consumed && matchesRequestFailedRule(ctx, entry.matcher)) {
        entry.consumed = true;
        return `once:${describeMatcher(entry.matcher)}`;
      }
    }
    return undefined;
  }

  private handleConsole(page: Page, msg: ConsoleMessage): void {
    if (this.disposed || this.paused || this.options.failOnConsoleError === false) {
      return;
    }

    const type = msg.type();
    if (!this.consoleTypes.has(type)) {
      return;
    }

    const text = msg.text();
    if (
      this.options.dedupeBrowserResourceConsoleErrors !== false &&
      type === 'error' &&
      isSyntheticResourceConsoleError(text)
    ) {
      return;
    }

    const location = msg.location();
    const pageUrl = safePageUrl(page);

    const ctx: ConsoleMatchContext = {
      type,
      text,
      location: {
        url: location.url ?? '',
        lineNumber: location.lineNumber ?? -1,
        columnNumber: location.columnNumber ?? -1,
      },
      pageUrl,
      message: msg,
    };

    const violation: ConsoleViolation = {
      id: this.nextId(),
      kind: 'console',
      timestamp: new Date().toISOString(),
      pageUrl,
      consoleType: type,
      text,
      location: ctx.location,
    };

    const matchedBy = this.findMatchedConsoleRule(ctx);
    if (matchedBy) {
      this.recordIgnored(violation, matchedBy);
      return;
    }

    this.recordViolation(violation);
  }

  private handlePageError(page: Page, error: Error): void {
    if (this.disposed || this.paused || this.options.failOnPageError === false) {
      return;
    }

    const pageUrl = safePageUrl(page);
    const name = error?.name || 'Error';
    const message = error?.message || String(error);
    const stack = error?.stack;

    const ctx: PageErrorMatchContext = {
      name,
      message,
      stack,
      pageUrl,
      error,
    };

    const violation: PageErrorViolation = {
      id: this.nextId(),
      kind: 'pageerror',
      timestamp: new Date().toISOString(),
      pageUrl,
      name,
      message,
      stack,
    };

    const matchedBy = this.findMatchedPageErrorRule(ctx);
    if (matchedBy) {
      this.recordIgnored(violation, matchedBy);
      return;
    }

    this.recordViolation(violation);
  }

  private handleResponse(page: Page, response: Response): void {
    if (this.disposed || this.paused) {
      return;
    }

    const status = response.status();
    const request = response.request();
    const method = request.method();
    const url = response.url();
    const resourceType = request.resourceType();
    const pageUrl = safePageUrl(page);
    const statusText = response.statusText();

    const ctx: HttpErrorMatchContext = {
      status,
      statusText,
      method,
      url,
      resourceType,
      pageUrl,
      response,
    };

    if (!shouldFailOnHttpStatus(status, ctx, this.options.failOnHttpStatus ?? '5xx')) {
      return;
    }

    const violation: HttpErrorViolation = {
      id: this.nextId(),
      kind: 'http',
      timestamp: new Date().toISOString(),
      pageUrl,
      status,
      statusText,
      method,
      url,
      resourceType,
    };

    const matchedBy = this.findMatchedHttpRule(ctx);
    if (matchedBy) {
      this.recordIgnored(violation, matchedBy);
      return;
    }

    this.recordViolation(violation);

    if (this.bodyOptions.enabled) {
      this.trackPending(this.captureBodySnippet(response, violation));
    }
  }

  private async captureBodySnippet(
    response: Response,
    violation: HttpErrorViolation,
  ): Promise<void> {
    try {
      const headers = await response.allHeaders();
      const contentType = (headers['content-type'] ?? '').toLowerCase();
      if (
        contentType &&
        !this.bodyOptions.contentTypes.some((ct) => contentType.includes(ct.toLowerCase()))
      ) {
        return;
      }
      const text = await response.text();
      if (text) {
        violation.bodySnippet =
          text.length > this.bodyOptions.maxLength
            ? `${text.slice(0, this.bodyOptions.maxLength)}...`
            : text;
      }
    } catch {
      // Response body may be unavailable if page closed or response was empty/redirected.
    }
  }

  private handleRequestFailed(page: Page, request: Request): void {
    if (this.disposed || this.paused || this.options.failOnRequestFailed === false) {
      return;
    }

    const failureText = request.failure()?.errorText ?? 'Unknown request failure';
    if (!this.options.includeAbortedRequests && isAbortedFailureText(failureText)) {
      return;
    }

    const method = request.method();
    const url = request.url();
    const resourceType = request.resourceType();
    const pageUrl = safePageUrl(page);

    const ctx: RequestFailedMatchContext = {
      method,
      url,
      resourceType,
      failureText,
      pageUrl,
      request,
    };

    const violation: RequestFailedViolation = {
      id: this.nextId(),
      kind: 'requestfailed',
      timestamp: new Date().toISOString(),
      pageUrl,
      method,
      url,
      resourceType,
      failureText,
    };

    const matchedBy = this.findMatchedRequestFailedRule(ctx);
    if (matchedBy) {
      this.recordIgnored(violation, matchedBy);
      return;
    }

    this.recordViolation(violation);
  }
}

/**
 * Create and attach a `RuntimeGuard` to a Playwright `Page` or `BrowserContext`.
 */
export function attachRuntimeGuard(
  target: GuardTarget,
  options: RuntimeGuardOptions = {},
): RuntimeGuard {
  return new RuntimeGuard(options).attach(target);
}
