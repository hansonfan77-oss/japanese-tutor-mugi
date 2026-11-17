// Real built UI, in a disposable Acceptance checkout and a mobile-sized Chromium context.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { productionApp } from '../dist-server/production.js';

test('mobile tutor entry completes a simulated cafe order under Acceptance', { timeout: 150_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'mugi-cafe-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const checkout = join(scratch, 'checkout');
  await cp(resolve('dist'), join(checkout, 'dist'), { recursive: true });
  const app = productionApp(checkout, [], { mode: 'acceptance', acceptanceRoot: join(scratch, 'data') });
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.MUGI_BROWSER_PATH || ['/usr/bin/google-chrome', '/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
  assert.ok(executablePath, 'Set MUGI_BROWSER_PATH to an installed Chromium/Chrome executable');
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const violations = [];
  page.on('pageerror', error => violations.push(error.message));
  const statusPaths = new Set(['/api/runtime', '/api/chat/status', '/api/openai/status', '/api/tts/status']);
  let inPractice = false;
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin || req.method() !== 'GET' ||
        (url.pathname.startsWith('/api/') && (inPractice || !statusPaths.has(url.pathname)))) {
      violations.push(req.method() + ' ' + url.pathname);
      return route.abort();
    }
    return route.continue();
  });
  await page.addInitScript(() => {
    localStorage.setItem('mugi.tutor.v1', JSON.stringify({ activeId: 'yui', background: 'black' }));
    window.forbiddenMedia = [];
    const deny = () => { window.forbiddenMedia.push('media'); throw new Error('Unexpected speech or capture'); };
    window.SpeechRecognition = window.webkitSpeechRecognition = class { constructor() { deny(); } };
    navigator.mediaDevices.getUserMedia = deny;
    window.speechSynthesis.speak = deny;
  });
  await page.clock.install();
  await page.goto(origin, { waitUntil: 'networkidle' });
  const entry = page.getByRole('button', { name: '咖啡店語音練習' });
  await page.getByText('結衣', { exact: true }).waitFor();
  assert.match(await page.locator('.acceptance-banner').innerText(), /外部 AI／雲端語音已停用/);
  inPractice = true;
  await entry.click();
  const panel = page.getByRole('dialog', { name: '咖啡店點餐' });
  const click = name => panel.getByRole('button', { name, exact: true }).click();
  const status = name => panel.getByRole('status').getByText(name, { exact: true }).waitFor();
  await panel.getByText('語音模擬 · 無收音與聲音').waitFor();
  await panel.locator('img[src$="/mugi/body.webp"]').waitFor();
  assert.match(await panel.locator('.cafe-scene').evaluate(el => getComputedStyle(el).backgroundImage), /classroom.webp/);
  await click('模擬說這句');
  await status('聆聽中');
  await page.clock.fastForward(800);
  await panel.getByText('店内で…', { exact: true }).waitFor();
  await page.clock.fastForward(1500);
  await status('Mugi 思考中');
  await click('取消這一輪');
  await page.clock.fastForward(8000);
  await status('已取消這一輪');
  await click('重試這一輪');
  await page.clock.fastForward(3600);
  await status('Mugi 播放中');
  const mouth = panel.locator('.tutor-mouth');
  await mouth.waitFor();
  assert.match(await mouth.getAttribute('src'), /mouth-1-[aeioum]\.webp$/);
  await click('打斷並重說');
  await status('已打斷播放，重新聆聽中');
  await mouth.waitFor({ state: 'detached' });
  // Simulate Android visibility notifications; a device verifies OS lifecycle separately.
  const visible = hidden => page.evaluate(hidden => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await visible(true);
  await status('練習已暫停');
  const pausedTime = await panel.locator('time').innerText();
  await page.clock.fastForward(310_000);
  await visible(false);
  await status('練習已暫停');
  assert.equal(await panel.locator('time').innerText(), pausedTime);
  await click('繼續練習');
  for (let turn = 1; turn <= 5; turn++) {
    await panel.getByText(`第 ${turn} / 5 輪`).waitFor();
    if (turn > 1) await click('模擬說這句');
    await page.clock.fastForward(7100);
  }
  await status('點餐完成');
  assert.equal(await panel.locator('details[open] li').count(), 5);
  await panel.getByText('ありがとうございます。こちらの番号札をお持ちください。').waitFor();
  await click('離開練習');
  await page.getByText('結衣', { exact: true }).waitFor();
  for (const name of ['速查', '小提醒筆記本', '人物', '送出']) {
    await page.getByRole('button', { name, exact: true }).waitFor();
  }
  await entry.click();
  await click('模擬說這句');
  await page.clock.fastForward(301_000);
  await status('五分鐘練習結束');
  assert.equal(await panel.locator('time').innerText(), '0:00');
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.forbiddenMedia), []);
  assert.deepEqual(violations, []);
});
