/** Real Chromium + the built server/worker, disposable fixtures only. Run after npm run build.
 * No OAuth, AI or speech calls. The two origins are loopback; never use a personal browser profile.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { productionApp } from '../dist-server/production.js';

const executablePath = process.env.MUGI_BROWSER_PATH || [
  '/usr/bin/google-chrome', '/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(existsSync);

test('cold reopen through the installed worker serves HTML and keeps API isolation', { timeout: 60_000 }, async () => {
  assert.ok(executablePath, 'Set MUGI_BROWSER_PATH to an installed Chromium/Chrome executable');
  const scratch = await mkdtemp(join(tmpdir(), 'mugi-pwa-browser-'));
  const checkout = join(scratch, 'checkout');
  const dist = join(checkout, 'dist');
  await mkdir(dist, { recursive: true });
  // Use a tiny public shell to isolate the navigation guard from UI, AI and audio behavior.
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>Mugi navigation fixture</title><p>public home</p><script>navigator.serviceWorker.register("/sw.js")</script>');
  for (const name of ['sw.js', 'offline.html', 'icon-192.png', 'icon-512.png']) {
    await copyFile(resolve('dist', name), join(dist, name));
  }
  const app = productionApp(checkout, [], { mode: 'acceptance', acceptanceRoot: join(scratch, 'data') });
  // Only method, fixed path, Fetch Metadata and response status are recorded. No full headers/query/body logging.
  const seen = [];
  const server = createServer((req, res) => {
    if (req.url === '/launcher' && req.headers.host === `127.0.0.1:${server.address().port}`) {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<a href="http://localhost:${server.address().port}/">Launch</a><a href="http://localhost:${server.address().port}/api/runtime">API</a>`);
      return;
    }
    if (req.url === '/') {
      const row = { method: req.method, path: '/', site: req.headers['sec-fetch-site'], mode: req.headers['sec-fetch-mode'], dest: req.headers['sec-fetch-dest'] };
      res.on('finish', () => { row.status = res.statusCode; seen.push(row); });
    }
    app(req, res);
  });
  let context;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const launch = () => chromium.launchPersistentContext(join(scratch, 'profile'), {
      executablePath, headless: true, timeout: 20_000,
      env: { ...process.env, XDG_CACHE_HOME: join(scratch, 'cache'), XDG_CONFIG_HOME: join(scratch, 'config') },
    });
    context = await launch();
    let page = await context.newPage();
    const enter = async () => {
      await page.goto(`http://127.0.0.1:${port}/launcher`);
      const response = page.waitForResponse(r => r.url() === `http://localhost:${port}/`);
      await page.getByText('Launch', { exact: true }).click();
      return response;
    };
    assert.equal((await enter()).status(), 200);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 10_000 });
    await page.evaluate(() => localStorage.setItem('fixture-preference', 'yui/classroom'));
    assert.deepEqual(seen[0], { method: 'GET', path: '/', site: 'cross-site', mode: 'navigate', dest: 'document', status: 200 });
    // Close the entire browser and reopen its disposable profile: the installed worker survives, the page does not.
    await context.close(); context = undefined;
    context = await launch();
    page = await context.newPage();
    const response = await enter();
    console.log('Cold reopen metadata:', JSON.stringify(seen.at(-1)));
    assert.equal(response.fromServiceWorker(), true, 'Cold reopen must actually pass through the installed worker');
    assert.equal(response.status(), 200);
    assert.match(response.headers()['content-type'], /text\/html/);
    assert.equal(response.headers()['cache-control'], 'no-store');
    assert.equal(response.headers()['x-frame-options'], 'DENY');
    assert.equal(response.headers()['access-control-allow-origin'], undefined);
    assert.equal(await page.locator('p').innerText(), 'public home');
    assert.equal(await page.evaluate(() => localStorage.getItem('fixture-preference')), 'yui/classroom');
    // Chromium releases differ: some preserve document, others forward empty. Both must serve the shell.
    // HTTP regression tests require empty to work even on a browser that preserves document.
    const { dest, ...metadata } = seen.at(-1);
    assert.ok(['document', 'empty'].includes(dest), `Unexpected navigation destination: ${dest}`);
    assert.deepEqual(metadata, { method: 'GET', path: '/', site: 'cross-site', mode: 'navigate', status: 200 });
    const runtime = await page.evaluate(async () => (await fetch('/api/runtime')).json());
    assert.equal(runtime.mode, 'acceptance');
    assert.equal(runtime.externalServices, false);
    assert.equal(runtime.browserSpeech, false);
    await page.goto(`http://127.0.0.1:${port}/launcher`);
    const denied = page.waitForResponse(r => r.url() === `http://localhost:${port}/api/runtime`);
    await page.getByText('API', { exact: true }).click();
    assert.equal((await denied).status(), 403);
    assert.match(await page.locator('body').innerText(), /不接受其他網站發出的請求/);
  } finally {
    await context?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  }
});
