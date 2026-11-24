import fs from 'node:fs';
import { defineConfig } from '@playwright/test';

const systemChromePath = '/usr/bin/google-chrome';
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  (fs.existsSync(systemChromePath) ? systemChromePath : undefined);

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: ['**/fixtures/**'],
  timeout: 15_000,
  retries: 0,
  reporter: [['list']],
  use: {
    headless: true,
    launchOptions: executablePath ? { executablePath } : undefined,
  },
});
