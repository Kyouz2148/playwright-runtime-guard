import type {
  ConsoleMatchContext,
  ConsoleMatcher,
  GuardAllowRules,
  GuardMode,
  HttpErrorMatchContext,
  HttpFailRule,
  HttpMatcher,
  PageErrorMatchContext,
  PageErrorMatcher,
  RequestFailedMatchContext,
  RequestFailedMatcher,
  RuntimeGuardOptions,
  StringPattern,
} from './types.js';

const ABORTED_FAILURE_PATTERNS = [
  'net::ERR_ABORTED',
  'NS_BINDING_ABORTED',
  'cancelled',
  'canceled',
];

const SYNTHETIC_RESOURCE_CONSOLE_REGEX =
  /^Failed to load resource:\s*(?:the server responded with a status of \d+|net::[A-Z0-9_]+|cancelled|The request timed out)/i;

export function isSyntheticResourceConsoleError(text: string): boolean {
  return SYNTHETIC_RESOURCE_CONSOLE_REGEX.test(text.trim());
}

export function matchesStringPattern(value: string, pattern: StringPattern): boolean {
  if (typeof pattern === 'string') {
    return value.includes(pattern);
  }
  if (pattern.global || pattern.sticky) {
    pattern.lastIndex = 0;
  }
  return pattern.test(value);
}

function matchesOneOrMany(
  actual: string,
  expected: string | string[],
  caseInsensitive = false,
): boolean {
  const values = Array.isArray(expected) ? expected : [expected];
  if (caseInsensitive) {
    const normalized = actual.toUpperCase();
    return values.some((item) => item.toUpperCase() === normalized);
  }
  return values.includes(actual);
}

function describeStringPattern(pattern: StringPattern): string {
  return typeof pattern === 'string' ? JSON.stringify(pattern) : pattern.toString();
}

export function describeMatcher(matcher: unknown): string {
  if (typeof matcher === 'string') {
    return JSON.stringify(matcher);
  }
  if (matcher instanceof RegExp) {
    return matcher.toString();
  }
  if (typeof matcher === 'function') {
    return matcher.name ? `fn:${matcher.name}` : 'fn:<predicate>';
  }
  if (matcher && typeof matcher === 'object') {
    try {
      return JSON.stringify(matcher, (_k, v) => (v instanceof RegExp ? v.toString() : v));
    } catch {
      return '[rule-object]';
    }
  }
  return String(matcher);
}

export function matchesConsoleRule(
  ctx: ConsoleMatchContext,
  matcher: ConsoleMatcher,
): boolean {
  if (typeof matcher === 'function') {
    return Boolean(matcher(ctx));
  }
  if (typeof matcher === 'string' || matcher instanceof RegExp) {
    return matchesStringPattern(ctx.text, matcher);
  }
  if (matcher.type !== undefined && !matchesOneOrMany(ctx.type, matcher.type)) {
    return false;
  }
  if (matcher.text !== undefined && !matchesStringPattern(ctx.text, matcher.text)) {
    return false;
  }
  if (
    matcher.locationUrl !== undefined &&
    !matchesStringPattern(ctx.location.url, matcher.locationUrl)
  ) {
    return false;
  }
  if (matcher.pageUrl !== undefined && !matchesStringPattern(ctx.pageUrl, matcher.pageUrl)) {
    return false;
  }
  return (
    matcher.type !== undefined ||
    matcher.text !== undefined ||
    matcher.locationUrl !== undefined ||
    matcher.pageUrl !== undefined
  );
}

export function matchesPageErrorRule(
  ctx: PageErrorMatchContext,
  matcher: PageErrorMatcher,
): boolean {
  if (typeof matcher === 'function') {
    return Boolean(matcher(ctx));
  }
  if (typeof matcher === 'string' || matcher instanceof RegExp) {
    const combined = ctx.name ? `${ctx.name}: ${ctx.message}` : ctx.message;
    return (
      matchesStringPattern(ctx.message, matcher) ||
      matchesStringPattern(combined, matcher)
    );
  }
  if (matcher.name !== undefined && !matchesStringPattern(ctx.name, matcher.name)) {
    return false;
  }
  if (matcher.message !== undefined && !matchesStringPattern(ctx.message, matcher.message)) {
    return false;
  }
  if (
    matcher.stack !== undefined &&
    !matchesStringPattern(ctx.stack ?? '', matcher.stack)
  ) {
    return false;
  }
  if (matcher.pageUrl !== undefined && !matchesStringPattern(ctx.pageUrl, matcher.pageUrl)) {
    return false;
  }
  return (
    matcher.name !== undefined ||
    matcher.message !== undefined ||
    matcher.stack !== undefined ||
    matcher.pageUrl !== undefined
  );
}

export function matchesHttpErrorRule(
  ctx: HttpErrorMatchContext,
  matcher: HttpMatcher,
): boolean {
  if (typeof matcher === 'function') {
    return Boolean(matcher(ctx));
  }
  if (typeof matcher === 'string' || matcher instanceof RegExp) {
    return matchesStringPattern(ctx.url, matcher);
  }
  if (matcher.url !== undefined && !matchesStringPattern(ctx.url, matcher.url)) {
    return false;
  }
  if (matcher.status !== undefined) {
    if (typeof matcher.status === 'function') {
      if (!matcher.status(ctx.status)) return false;
    } else if (Array.isArray(matcher.status)) {
      if (!matcher.status.includes(ctx.status)) return false;
    } else if (matcher.status !== ctx.status) {
      return false;
    }
  }
  if (
    matcher.method !== undefined &&
    !matchesOneOrMany(ctx.method, matcher.method, true)
  ) {
    return false;
  }
  if (
    matcher.resourceType !== undefined &&
    !matchesOneOrMany(ctx.resourceType, matcher.resourceType)
  ) {
    return false;
  }
  if (matcher.pageUrl !== undefined && !matchesStringPattern(ctx.pageUrl, matcher.pageUrl)) {
    return false;
  }
  return (
    matcher.url !== undefined ||
    matcher.status !== undefined ||
    matcher.method !== undefined ||
    matcher.resourceType !== undefined ||
    matcher.pageUrl !== undefined
  );
}

export function matchesRequestFailedRule(
  ctx: RequestFailedMatchContext,
  matcher: RequestFailedMatcher,
): boolean {
  if (typeof matcher === 'function') {
    return Boolean(matcher(ctx));
  }
  if (typeof matcher === 'string' || matcher instanceof RegExp) {
    return matchesStringPattern(ctx.url, matcher);
  }
  if (matcher.url !== undefined && !matchesStringPattern(ctx.url, matcher.url)) {
    return false;
  }
  if (
    matcher.failureText !== undefined &&
    !matchesStringPattern(ctx.failureText, matcher.failureText)
  ) {
    return false;
  }
  if (
    matcher.method !== undefined &&
    !matchesOneOrMany(ctx.method, matcher.method, true)
  ) {
    return false;
  }
  if (
    matcher.resourceType !== undefined &&
    !matchesOneOrMany(ctx.resourceType, matcher.resourceType)
  ) {
    return false;
  }
  if (matcher.pageUrl !== undefined && !matchesStringPattern(ctx.pageUrl, matcher.pageUrl)) {
    return false;
  }
  return (
    matcher.url !== undefined ||
    matcher.failureText !== undefined ||
    matcher.method !== undefined ||
    matcher.resourceType !== undefined ||
    matcher.pageUrl !== undefined
  );
}

export function shouldFailOnHttpStatus(
  status: number,
  ctx: HttpErrorMatchContext,
  rule: HttpFailRule = '5xx',
): boolean {
  if (rule === false) return false;
  if (rule === true || rule === '5xx') {
    return status >= 500 && status <= 599;
  }
  if (rule === '4xx+' || rule === '4xx-5xx') {
    return status >= 400;
  }
  if (Array.isArray(rule)) {
    return rule.includes(status);
  }
  if (typeof rule === 'function') {
    return Boolean(rule(status, ctx));
  }
  return status >= 500 && status <= 599;
}

export function isAbortedFailureText(failureText: string): boolean {
  const normalized = failureText.toLowerCase();
  return ABORTED_FAILURE_PATTERNS.some((pattern) =>
    normalized.includes(pattern.toLowerCase()),
  );
}

export function parseEnvGuardMode(rawValue: string | undefined): GuardMode | undefined {
  if (!rawValue) return undefined;
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === 'fail' || normalized === 'warn' || normalized === 'off') {
    return normalized;
  }
  return undefined;
}

export function mergeAllowRules(
  base: GuardAllowRules = {},
  extra: GuardAllowRules = {},
): GuardAllowRules {
  return {
    ignoreConsole: [...(base.ignoreConsole ?? []), ...(extra.ignoreConsole ?? [])],
    ignorePageErrors: [...(base.ignorePageErrors ?? []), ...(extra.ignorePageErrors ?? [])],
    ignoreHttpErrors: [...(base.ignoreHttpErrors ?? []), ...(extra.ignoreHttpErrors ?? [])],
    ignoreRequestFailed: [
      ...(base.ignoreRequestFailed ?? []),
      ...(extra.ignoreRequestFailed ?? []),
    ],
  };
}

export function mergeGuardOptions(
  base: RuntimeGuardOptions = {},
  override: RuntimeGuardOptions = {},
): RuntimeGuardOptions {
  const mergedAllow = mergeAllowRules(base, override);
  return {
    ...base,
    ...override,
    ...mergedAllow,
    consoleTypes: override.consoleTypes ?? base.consoleTypes,
  };
}

export { describeStringPattern };
