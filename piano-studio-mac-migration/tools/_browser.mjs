import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Find an installed Chromium browser for the Puppeteer-based project tools. */
export function resolveBrowserPath() {
  const configured = process.env.CHROME_PATH;
  if (configured) {
    if (existsSync(configured)) return configured;
    throw new Error(`CHROME_PATH 指向的浏览器不存在：${configured}`);
  }

  const appRoots = ['/Applications', path.join(os.homedir(), 'Applications')];
  const appExecutables = [
    ['Google Chrome.app', 'Contents/MacOS/Google Chrome'],
    ['Chromium.app', 'Contents/MacOS/Chromium'],
    ['Microsoft Edge.app', 'Contents/MacOS/Microsoft Edge'],
    ['Brave Browser.app', 'Contents/MacOS/Brave Browser'],
  ];
  const candidates = appRoots.flatMap((root) =>
    appExecutables.map(([app, executable]) => path.join(root, app, executable)));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    '找不到 Chrome、Chromium、Edge 或 Brave。请安装其中一个浏览器，或通过 CHROME_PATH 指定可执行文件。',
  );
}
