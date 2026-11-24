import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAbortedFailureText,
  isSyntheticResourceConsoleError,
  matchesConsoleRule,
  matchesHttpErrorRule,
  matchesPageErrorRule,
  matchesRequestFailedRule,
  matchesStringPattern,
  mergeGuardOptions,
  parseEnvGuardMode,
  shouldFailOnHttpStatus,
} from '../../src/matchers.js';

test('matchesStringPattern handles substrings and global RegExp safely', () => {
  assert.equal(matchesStringPattern('ResizeObserver loop limit exceeded', 'ResizeObserver'), true);
  assert.equal(matchesStringPattern('Hello world', 'missing'), false);

  const globalRegex = /error-\d+/g;
  assert.equal(matchesStringPattern('fatal error-123', globalRegex), true);
  assert.equal(matchesStringPattern('fatal error-123', globalRegex), true);
  assert.equal(matchesStringPattern('no match', globalRegex), false);
});

test('matchesConsoleRule supports string, RegExp, rule object, and predicate', () => {
  const ctx = {
    type: 'error',
    text: 'Failed to load resource: net::ERR_FAILED',
    location: { url: 'https://cdn.example.com/widget.js', lineNumber: 10, columnNumber: 4 },
    pageUrl: 'https://app.example.com/dashboard',
  };

  assert.equal(matchesConsoleRule(ctx, 'ERR_FAILED'), true);
  assert.equal(matchesConsoleRule(ctx, /Failed to load/i), true);
  assert.equal(
    matchesConsoleRule(ctx, { type: 'error', locationUrl: 'cdn.example.com' }),
    true,
  );
  assert.equal(
    matchesConsoleRule(ctx, { type: 'warning', text: 'ERR_FAILED' }),
    false,
  );
  assert.equal(
    matchesConsoleRule(ctx, (c) => c.pageUrl.endsWith('/dashboard')),
    true,
  );
});

test('matchesPageErrorRule matches name, message, stack, and pageUrl', () => {
  const ctx = {
    name: 'TypeError',
    message: 'Cannot read properties of undefined',
    stack: 'TypeError: Cannot read properties of undefined\n    at Widget.render (widget.js:12:3)',
    pageUrl: 'https://app.example.com/settings',
  };

  assert.equal(matchesPageErrorRule(ctx, 'Cannot read properties'), true);
  assert.equal(matchesPageErrorRule(ctx, /^TypeError: Cannot read/), true);
  assert.equal(matchesPageErrorRule(ctx, { name: 'TypeError', stack: 'Widget.render' }), true);
  assert.equal(matchesPageErrorRule(ctx, { name: 'ReferenceError' }), false);
});

test('matchesHttpErrorRule matches URL, status, method, and resourceType', () => {
  const ctx = {
    status: 404,
    statusText: 'Not Found',
    method: 'GET',
    url: 'https://app.example.com/favicon.ico',
    resourceType: 'other',
    pageUrl: 'https://app.example.com/',
  };

  assert.equal(matchesHttpErrorRule(ctx, '/favicon.ico'), true);
  assert.equal(
    matchesHttpErrorRule(ctx, { url: '/favicon.ico', status: 404, method: 'get' }),
    true,
  );
  assert.equal(
    matchesHttpErrorRule(ctx, { status: [404, 410], resourceType: ['image', 'other'] }),
    true,
  );
  assert.equal(matchesHttpErrorRule(ctx, { status: 500 }), false);
});

test('matchesRequestFailedRule matches failureText, url, and method', () => {
  const ctx = {
    method: 'POST',
    url: 'https://telemetry.example.com/collect',
    resourceType: 'fetch',
    failureText: 'net::ERR_CONNECTION_REFUSED',
    pageUrl: 'https://app.example.com/',
  };

  assert.equal(matchesRequestFailedRule(ctx, 'telemetry.example.com'), true);
  assert.equal(
    matchesRequestFailedRule(ctx, { method: 'post', failureText: 'ERR_CONNECTION_REFUSED' }),
    true,
  );
  assert.equal(
    matchesRequestFailedRule(ctx, { method: 'GET', failureText: 'ERR_CONNECTION_REFUSED' }),
    false,
  );
});

test('shouldFailOnHttpStatus handles default 5xx, 4xx+, status array, and predicates', () => {
  const dummy = {
    status: 500,
    statusText: 'Internal Server Error',
    method: 'GET',
    url: 'http://localhost/api',
    resourceType: 'fetch',
    pageUrl: 'http://localhost/',
  };

  assert.equal(shouldFailOnHttpStatus(404, { ...dummy, status: 404 }, '5xx'), false);
  assert.equal(shouldFailOnHttpStatus(503, { ...dummy, status: 503 }, '5xx'), true);
  assert.equal(shouldFailOnHttpStatus(404, { ...dummy, status: 404 }, '4xx+'), true);
  assert.equal(shouldFailOnHttpStatus(200, { ...dummy, status: 200 }, '4xx+'), false);
  assert.equal(shouldFailOnHttpStatus(429, { ...dummy, status: 429 }, [429, 503]), true);
  assert.equal(shouldFailOnHttpStatus(500, dummy, false), false);
  assert.equal(
    shouldFailOnHttpStatus(418, { ...dummy, status: 418 }, (s) => s === 418),
    true,
  );
});

test('isAbortedFailureText detects common browser cancellation messages', () => {
  assert.equal(isAbortedFailureText('net::ERR_ABORTED'), true);
  assert.equal(isAbortedFailureText('NS_BINDING_ABORTED'), true);
  assert.equal(isAbortedFailureText('net::ERR_CONNECTION_REFUSED'), false);
});

test('isSyntheticResourceConsoleError detects browser network console logs without swallowing app logs', () => {
  assert.equal(
    isSyntheticResourceConsoleError(
      'Failed to load resource: the server responded with a status of 404 (Not Found)',
    ),
    true,
  );
  assert.equal(
    isSyntheticResourceConsoleError('Failed to load resource: net::ERR_CONNECTION_REFUSED'),
    true,
  );
  assert.equal(
    isSyntheticResourceConsoleError('Failed to load resource: custom application failure'),
    false,
  );
  assert.equal(isSyntheticResourceConsoleError('Uncaught TypeError: boom'), false);
});

test('parseEnvGuardMode and mergeGuardOptions behave cleanly', () => {
  assert.equal(parseEnvGuardMode('WARN'), 'warn');
  assert.equal(parseEnvGuardMode('off'), 'off');
  assert.equal(parseEnvGuardMode('invalid'), undefined);

  const merged = mergeGuardOptions(
    {
      mode: 'fail',
      ignoreConsole: ['legacy-1'],
      ignoreHttpErrors: ['/favicon.ico'],
    },
    {
      mode: 'warn',
      ignoreConsole: ['local-2'],
    },
  );

  assert.equal(merged.mode, 'warn');
  assert.deepEqual(merged.ignoreConsole, ['legacy-1', 'local-2']);
  assert.deepEqual(merged.ignoreHttpErrors, ['/favicon.ico']);
});
