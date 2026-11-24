import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RuntimeGuardError,
  formatGuardReport,
  formatMarkdownReport,
} from '../../src/formatter.js';
import type { GuardReport } from '../../src/types.js';

const sampleReport: GuardReport = {
  startedAt: '2026-11-24T10:00:00.000Z',
  endedAt: '2026-11-24T10:00:05.000Z',
  mode: 'fail',
  summary: {
    totalViolations: 4,
    consoleErrors: 1,
    pageErrors: 1,
    httpErrors: 1,
    requestFailures: 1,
    ignoredCount: 1,
  },
  violations: [
    {
      id: 'rg-1',
      kind: 'console',
      timestamp: '2026-11-24T10:00:01.000Z',
      pageUrl: 'http://localhost:3000/home',
      consoleType: 'error',
      text: 'Uncaught invariant violation',
      location: { url: 'http://localhost:3000/app.js', lineNumber: 41, columnNumber: 9 },
    },
    {
      id: 'rg-2',
      kind: 'pageerror',
      timestamp: '2026-11-24T10:00:02.000Z',
      pageUrl: 'http://localhost:3000/home',
      name: 'TypeError',
      message: 'x is not a function',
      stack: 'TypeError: x is not a function\n    at main (app.js:10:2)',
    },
    {
      id: 'rg-3',
      kind: 'http',
      timestamp: '2026-11-24T10:00:03.000Z',
      pageUrl: 'http://localhost:3000/home',
      status: 500,
      statusText: 'Internal Server Error',
      method: 'POST',
      url: 'http://localhost:3000/api/orders',
      resourceType: 'fetch',
      bodySnippet: '{"error":"database unavailable"}',
    },
    {
      id: 'rg-4',
      kind: 'requestfailed',
      timestamp: '2026-11-24T10:00:04.000Z',
      pageUrl: 'http://localhost:3000/home',
      method: 'GET',
      url: 'http://localhost:9999/health',
      resourceType: 'xhr',
      failureText: 'net::ERR_CONNECTION_REFUSED',
    },
  ],
  ignored: [
    {
      matchedBy: '"/favicon.ico"',
      violation: {
        id: 'rg-0',
        kind: 'http',
        timestamp: '2026-11-24T10:00:00.500Z',
        pageUrl: 'http://localhost:3000/home',
        status: 404,
        statusText: 'Not Found',
        method: 'GET',
        url: 'http://localhost:3000/favicon.ico',
        resourceType: 'other',
      },
    },
  ],
};

test('formatGuardReport renders all violation categories cleanly', () => {
  const output = formatGuardReport(sampleReport);
  assert.match(output, /Detected 4 runtime violation\(s\)/);
  assert.match(output, /Console Errors \(1\):/);
  assert.match(output, /\[error\] Uncaught invariant violation \(http:\/\/localhost:3000\/app\.js:42:10\)/);
  assert.match(output, /Uncaught Page Exceptions \(1\):/);
  assert.match(output, /TypeError: x is not a function/);
  assert.match(output, /HTTP Error Responses \(1\):/);
  assert.match(output, /500 Internal Server Error POST http:\/\/localhost:3000\/api\/orders/);
  assert.match(output, /database unavailable/);
  assert.match(output, /Failed Network Requests \(1\):/);
  assert.match(output, /net::ERR_CONNECTION_REFUSED/);
});

test('formatMarkdownReport and RuntimeGuardError expose structured report', () => {
  const md = formatMarkdownReport(sampleReport);
  assert.match(md, /# Playwright Runtime Guard Report/);
  assert.match(md, /\*\*Total violations:\*\* 4/);
  assert.match(md, /## Ignored Entries/);

  const err = new RuntimeGuardError(sampleReport);
  assert.equal(err.name, 'RuntimeGuardError');
  assert.equal(err.violations.length, 4);
  assert.equal(err.report.summary.ignoredCount, 1);
});
