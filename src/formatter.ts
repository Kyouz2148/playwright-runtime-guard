import type {
  ConsoleViolation,
  GuardReport,
  GuardViolation,
  HttpErrorViolation,
  PageErrorViolation,
  RequestFailedViolation,
} from './types.js';

export class RuntimeGuardError extends Error {
  readonly report: GuardReport;
  readonly violations: GuardViolation[];

  constructor(report: GuardReport, messagePrefix?: string) {
    const formatted = formatGuardReport(report, { messagePrefix });
    super(formatted);
    this.name = 'RuntimeGuardError';
    this.report = report;
    this.violations = report.violations;
  }
}

export interface FormatReportOptions {
  messagePrefix?: string;
  maxItemsPerSection?: number;
}

function truncate(value: string, maxLength = 300): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 3)}...`;
}

function formatLocation(loc: ConsoleViolation['location']): string {
  if (!loc.url) return '';
  const line = loc.lineNumber >= 0 ? `:${loc.lineNumber + 1}` : '';
  const col = loc.columnNumber >= 0 ? `:${loc.columnNumber + 1}` : '';
  return `${loc.url}${line}${col}`;
}

export function formatGuardReport(
  report: GuardReport,
  options: FormatReportOptions = {},
): string {
  const maxItems = options.maxItemsPerSection ?? 20;
  const { summary, violations } = report;
  const header =
    options.messagePrefix ??
    `[runtime-guard] Detected ${summary.totalViolations} runtime violation(s)`;

  if (violations.length === 0) {
    return `${header} (0 violations, ${summary.ignoredCount} ignored).`;
  }

  const lines: string[] = [
    `${header} (console: ${summary.consoleErrors}, pageerror: ${summary.pageErrors}, http: ${summary.httpErrors}, requestfailed: ${summary.requestFailures}, ignored: ${summary.ignoredCount})`,
  ];

  const consoleItems = violations.filter(
    (v): v is ConsoleViolation => v.kind === 'console',
  );
  const pageErrorItems = violations.filter(
    (v): v is PageErrorViolation => v.kind === 'pageerror',
  );
  const httpItems = violations.filter(
    (v): v is HttpErrorViolation => v.kind === 'http',
  );
  const reqFailedItems = violations.filter(
    (v): v is RequestFailedViolation => v.kind === 'requestfailed',
  );

  if (consoleItems.length > 0) {
    lines.push('', `Console Errors (${consoleItems.length}):`);
    for (const item of consoleItems.slice(0, maxItems)) {
      const loc = formatLocation(item.location);
      const locSuffix = loc ? ` (${loc})` : '';
      lines.push(`  - [${item.consoleType}] ${truncate(item.text, 400)}${locSuffix}`);
      if (item.pageUrl) {
        lines.push(`    page: ${item.pageUrl}`);
      }
    }
    if (consoleItems.length > maxItems) {
      lines.push(`  ... and ${consoleItems.length - maxItems} more console violation(s)`);
    }
  }

  if (pageErrorItems.length > 0) {
    lines.push('', `Uncaught Page Exceptions (${pageErrorItems.length}):`);
    for (const item of pageErrorItems.slice(0, maxItems)) {
      const title = item.name ? `${item.name}: ${item.message}` : item.message;
      lines.push(`  - ${truncate(title, 400)}`);
      if (item.pageUrl) {
        lines.push(`    page: ${item.pageUrl}`);
      }
      if (item.stack) {
        const firstStackLines = item.stack
          .split('\n')
          .slice(0, 4)
          .map((l) => `      ${l.trim()}`);
        lines.push(...firstStackLines);
      }
    }
    if (pageErrorItems.length > maxItems) {
      lines.push(`  ... and ${pageErrorItems.length - maxItems} more pageerror(s)`);
    }
  }

  if (httpItems.length > 0) {
    lines.push('', `HTTP Error Responses (${httpItems.length}):`);
    for (const item of httpItems.slice(0, maxItems)) {
      const statusText = item.statusText ? ` ${item.statusText}` : '';
      lines.push(
        `  - ${item.status}${statusText} ${item.method} ${item.url} [${item.resourceType}]`,
      );
      if (item.pageUrl) {
        lines.push(`    page: ${item.pageUrl}`);
      }
      if (item.bodySnippet) {
        lines.push(`    body: ${truncate(item.bodySnippet, 300)}`);
      }
    }
    if (httpItems.length > maxItems) {
      lines.push(`  ... and ${httpItems.length - maxItems} more HTTP violation(s)`);
    }
  }

  if (reqFailedItems.length > 0) {
    lines.push('', `Failed Network Requests (${reqFailedItems.length}):`);
    for (const item of reqFailedItems.slice(0, maxItems)) {
      lines.push(
        `  - ${item.method} ${item.url} [${item.resourceType}] -> ${item.failureText}`,
      );
      if (item.pageUrl) {
        lines.push(`    page: ${item.pageUrl}`);
      }
    }
    if (reqFailedItems.length > maxItems) {
      lines.push(
        `  ... and ${reqFailedItems.length - maxItems} more failed request(s)`,
      );
    }
  }

  return lines.join('\n');
}

export function formatMarkdownReport(report: GuardReport): string {
  const { summary, violations, ignored } = report;
  const lines: string[] = [
    '# Playwright Runtime Guard Report',
    '',
    `- **Mode:** \`${report.mode}\``,
    `- **Window:** \`${report.startedAt}\` → \`${report.endedAt}\``,
    `- **Total violations:** ${summary.totalViolations}`,
    `- **Breakdown:** console=${summary.consoleErrors}, pageerror=${summary.pageErrors}, http=${summary.httpErrors}, requestfailed=${summary.requestFailures}`,
    `- **Ignored by allowlist:** ${summary.ignoredCount}`,
  ];

  if (violations.length > 0) {
    lines.push('', '## Violations', '');
    for (const v of violations) {
      if (v.kind === 'console') {
        const loc = formatLocation(v.location);
        lines.push(
          `- **[console:${v.consoleType}]** \`${truncate(v.text, 500)}\`${loc ? ` — \`${loc}\`` : ''} (page: \`${v.pageUrl || 'unknown'}\`)`,
        );
      } else if (v.kind === 'pageerror') {
        lines.push(
          `- **[pageerror]** \`${v.name}: ${truncate(v.message, 500)}\` (page: \`${v.pageUrl || 'unknown'}\`)`,
        );
      } else if (v.kind === 'http') {
        lines.push(
          `- **[http ${v.status}]** \`${v.method} ${v.url}\` (\`${v.resourceType}\`, page: \`${v.pageUrl || 'unknown'}\`)`,
        );
        if (v.bodySnippet) {
          lines.push(`  - Body: \`${truncate(v.bodySnippet, 300)}\``);
        }
      } else if (v.kind === 'requestfailed') {
        lines.push(
          `- **[requestfailed]** \`${v.method} ${v.url}\` → \`${v.failureText}\` (\`${v.resourceType}\`, page: \`${v.pageUrl || 'unknown'}\`)`,
        );
      }
    }
  }

  if (ignored.length > 0) {
    lines.push('', '## Ignored Entries', '');
    for (const entry of ignored) {
      lines.push(
        `- **[${entry.violation.kind}]** matched \`${entry.matchedBy}\` (page: \`${entry.violation.pageUrl || 'unknown'}\`)`,
      );
    }
  }

  return lines.join('\n');
}
