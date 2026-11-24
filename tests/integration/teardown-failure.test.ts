import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface PlaywrightJsonReport {
  suites: Array<{
    suites?: PlaywrightJsonReport['suites'];
    specs: Array<{
      title: string;
      ok: boolean;
      tests: Array<{
        annotations: Array<{ type: string; description?: string }>;
        results: Array<{
          status: string;
          error?: { message?: string };
          attachments: Array<{ name: string; contentType: string; path?: string }>;
        }>;
      }>;
    }>;
  }>;
}

function collectSpecs(
  suites: PlaywrightJsonReport['suites'],
): PlaywrightJsonReport['suites'][number]['specs'] {
  const specs: PlaywrightJsonReport['suites'][number]['specs'] = [];
  for (const suite of suites) {
    if (suite.specs) specs.push(...suite.specs);
    if (suite.suites) specs.push(...collectSpecs(suite.suites));
  }
  return specs;
}

test('Playwright auto-fixture fails tests on teardown with RuntimeGuardError and attachments', () => {
  const tempConfigPath = path.resolve('tests/e2e/fixtures/temp-playwright.config.mjs');
  const systemChromePath = '/usr/bin/google-chrome';
  const executableLine = fs.existsSync(systemChromePath)
    ? `executablePath: ${JSON.stringify(systemChromePath)},`
    : '';

  fs.writeFileSync(
    tempConfigPath,
    `export default {
      testDir: '.',
      testMatch: ['failing-cases.spec.ts'],
      timeout: 15000,
      retries: 0,
      reporter: [['json']],
      use: {
        headless: true,
        launchOptions: { ${executableLine} },
      },
    };\n`,
    'utf8',
  );

  try {
    const result = spawnSync(
      'npx',
      ['playwright', 'test', '--config', tempConfigPath],
      {
        encoding: 'utf8',
        env: { ...process.env, FORCE_COLOR: '0' },
      },
    );

    assert.equal(result.status, 1, `Expected Playwright to exit with 1, got ${result.status}`);
    const report = JSON.parse(result.stdout) as PlaywrightJsonReport;
    const specs = collectSpecs(report.suites);

    const byTitle = new Map(specs.map((s) => [s.title, s]));

    const consoleSpec = byTitle.get('fails on unignored console.error');
    assert.ok(consoleSpec, 'consoleSpec missing');
    assert.equal(consoleSpec.ok, false);
    const consoleRes = consoleSpec.tests[0]?.results[0];
    assert.match(consoleRes?.error?.message ?? '', /Console Errors \(1\)/);
    assert.match(consoleRes?.error?.message ?? '', /Broken widget state/);
    assert.ok(
      consoleRes?.attachments.some((a) => a.name === 'runtime-guard-report.json'),
      'Expected runtime-guard-report.json attachment',
    );
    assert.ok(
      consoleRes?.attachments.some((a) => a.name === 'runtime-guard-report.md'),
      'Expected runtime-guard-report.md attachment',
    );

    const fetchSpec = byTitle.get('fails on unignored 500 background fetch');
    assert.ok(fetchSpec, 'fetchSpec missing');
    assert.equal(fetchSpec.ok, false);
    const fetchErr = fetchSpec.tests[0]?.results[0]?.error?.message ?? '';
    assert.match(fetchErr, /HTTP Error Responses \(1\)/);
    assert.match(fetchErr, /500 Internal Server Error GET .*\/api\/boom/);
    assert.match(fetchErr, /upstream timeout/);

    const pageErrorSpec = byTitle.get('fails on unignored pageerror');
    assert.ok(pageErrorSpec, 'pageErrorSpec missing');
    assert.equal(pageErrorSpec.ok, false);
    const pageErrMsg = pageErrorSpec.tests[0]?.results[0]?.error?.message ?? '';
    assert.match(pageErrMsg, /Uncaught Page Exceptions \(1\)/);
    assert.match(pageErrMsg, /Async uncaught boom/);

    const warnSpec = byTitle.get('passes in warn mode despite console error');
    assert.ok(warnSpec, 'warnSpec missing');
    assert.equal(warnSpec.ok, true);
    assert.ok(
      warnSpec.tests[0]?.annotations.some((a) => a.type === 'runtime-guard'),
      'Expected runtime-guard annotation in warn mode',
    );
  } finally {
    if (fs.existsSync(tempConfigPath)) {
      fs.unlinkSync(tempConfigPath);
    }
  }
});
