import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RuntimeGuard, attachRuntimeGuard } from '../../src/guard.js';

class MockPage extends EventEmitter {
  private _url: string;

  constructor(url = 'http://localhost:3000/') {
    super();
    this._url = url;
  }

  url() {
    return this._url;
  }

  setUrl(url: string) {
    this._url = url;
  }

  emitConsole(type: string, text: string, locUrl = 'http://localhost:3000/app.js') {
    this.emit('console', {
      type: () => type,
      text: () => text,
      location: () => ({ url: locUrl, lineNumber: 1, columnNumber: 2 }),
    });
  }

  emitPageError(error: Error) {
    this.emit('pageerror', error);
  }

  emitResponse({
    status,
    statusText = '',
    method = 'GET',
    url = 'http://localhost:3000/api/test',
    resourceType = 'fetch',
    body = '',
    contentType = 'application/json',
  }: {
    status: number;
    statusText?: string;
    method?: string;
    url?: string;
    resourceType?: string;
    body?: string;
    contentType?: string;
  }) {
    this.emit('response', {
      status: () => status,
      statusText: () => statusText,
      url: () => url,
      allHeaders: async () => ({ 'content-type': contentType }),
      text: async () => body,
      request: () => ({
        method: () => method,
        resourceType: () => resourceType,
      }),
    });
  }

  emitRequestFailed({
    method = 'GET',
    url = 'http://localhost:3000/api/fail',
    resourceType = 'fetch',
    errorText = 'net::ERR_CONNECTION_REFUSED',
  }: {
    method?: string;
    url?: string;
    resourceType?: string;
    errorText?: string;
  }) {
    this.emit('requestfailed', {
      method: () => method,
      url: () => url,
      resourceType: () => resourceType,
      failure: () => ({ errorText }),
    });
  }
}

class MockContext extends EventEmitter {
  private _pages: MockPage[];

  constructor(pages: MockPage[] = []) {
    super();
    this._pages = pages;
  }

  pages() {
    return this._pages;
  }

  addPage(page: MockPage) {
    this._pages.push(page);
    this.emit('page', page);
  }
}

test('RuntimeGuard captures console, pageerror, 5xx, and requestfailed on Page & Context', async () => {
  const initialPage = new MockPage();
  const context = new MockContext([initialPage]);

  const guard = attachRuntimeGuard(context as never);

  initialPage.emitConsole('log', 'just info');
  initialPage.emitConsole('error', 'boom console');
  initialPage.emitPageError(new TypeError('bad state'));
  initialPage.emitResponse({
    status: 500,
    statusText: 'Internal Server Error',
    body: '{"message":"crash"}',
  });
  initialPage.emitRequestFailed({ errorText: 'net::ERR_ABORTED' }); // ignored by default
  initialPage.emitRequestFailed({ errorText: 'net::ERR_TIMED_OUT' });

  const popupPage = new MockPage('http://localhost:3000/popup');
  context.addPage(popupPage);
  popupPage.emitConsole('error', 'popup error');

  await guard.flush();
  const report = guard.getReport();

  assert.equal(report.summary.consoleErrors, 2);
  assert.equal(report.summary.pageErrors, 1);
  assert.equal(report.summary.httpErrors, 1);
  assert.equal(report.summary.requestFailures, 1);
  assert.equal(report.summary.totalViolations, 5);

  const httpViolation = report.violations.find((v) => v.kind === 'http');
  assert.ok(httpViolation && httpViolation.kind === 'http');
  assert.equal(httpViolation.bodySnippet, '{"message":"crash"}');

  guard.dispose();
  initialPage.emitConsole('error', 'after dispose');
  assert.equal(guard.getViolations().length, 5);
});

test('RuntimeGuard supports allowOnce, runAllowed, pause/resume, and clear', async () => {
  const page = new MockPage();
  const guard = new RuntimeGuard({ failOnHttpStatus: '4xx+' }).attach(page as never);

  guard.allowOnce({ ignoreHttpErrors: [{ url: '/api/retry', status: 503 }] });
  page.emitResponse({ status: 503, url: 'http://localhost:3000/api/retry' });
  page.emitResponse({ status: 503, url: 'http://localhost:3000/api/retry' });

  assert.equal(guard.getIgnored().length, 1);
  assert.equal(guard.getViolations().length, 1);

  await guard.runAllowed({ ignoreConsole: ['expected warning'] }, async () => {
    page.emitConsole('error', 'expected warning');
  });
  assert.equal(guard.getViolations().length, 1);
  assert.equal(guard.getIgnored().length, 2);

  page.emitConsole('error', 'expected warning');
  assert.equal(guard.getViolations().length, 2);

  guard.pause();
  page.emitConsole('error', 'paused error');
  assert.equal(guard.getViolations().length, 2);
  guard.resume();

  guard.clear();
  assert.equal(guard.hasViolations(), false);
  await guard.assertClean();
});
