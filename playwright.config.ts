import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const cachedChromePath = path.join(
  os.homedir(),
  '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'
);
const executablePath = fs.existsSync(cachedChromePath) ? cachedChromePath : undefined;

const e2ePort = 3456;
const e2eDataDir = path.join(os.tmpdir(), `thevoid-e2e-pgdata-${process.pid}`);

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: {
    timeout: 10_000
  },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${e2ePort}`,
    headless: true,
    viewport: { width: 1366, height: 820 },
    launchOptions: executablePath
      ? {
          executablePath,
          args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
      : {
          args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
  },
  webServer: {
    command: 'node dist/server/server/index.js',
    url: `http://127.0.0.1:${e2ePort}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: String(e2ePort),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      PGLITE_DATA_DIR: e2eDataDir,
      SEED_INITIAL_OBJECT: 'false',
      RATE_LIMIT_CREATES_PER_MIN: '200',
      RATE_LIMIT_MUTATIONS_PER_MIN: '500',
      RATE_LIMIT_DELETES_PER_MIN: '200'
    }
  }
});
