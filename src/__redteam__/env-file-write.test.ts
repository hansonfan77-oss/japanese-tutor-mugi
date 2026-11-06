// Red-team: writing .env.local (server/envFile.ts) and the settings routes (server/settingsRoutes.ts). Every file here is
// a temp file under the OS temp folder: the project's .env.local is never named. A test named "[發現]" asserts the weakness
// as it is today.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyEnvUpdates, cleanValue, readEnvValue, updateEnvFile } from '../../server/envFile.ts';
import { formatUsd, handleSettingsApi, keyUpdatesFrom, parseBudget, type SettingsDeps } from '../../server/settingsRoutes.ts';
import { guardApi } from '../../server/apiGuard.ts';

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mugi-redteam-env-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const tmpEnv = (name = '.env.local') => path.join(dir, name);

describe('值的檢查：換行、等號、井字號、引號、Unicode 隱形字元一律拒絕', () => {
  it.each([
    'abc\nANTHROPIC_MODEL=evil',
    'abc\rX=1',
    'abc=def',
    'abc#comment',
    'ab"c',
    "ab'c",
    'ab c',
    'ab\tc',
    'ab​c', // zero-width space
    'ab﻿c', // BOM inside a value
    'ab‮c', // right-to-left override
    'ab＝c', // full-width equals
    'ab\u0000c',
    '`whoami`',
    '$(id)',
  ])('拒絕值 %j', (v) => {
    expect(() => cleanValue('ANTHROPIC_API_KEY', v)).toThrow();
    expect(() => applyEnvUpdates('', { ANTHROPIC_API_KEY: v })).toThrow();
  });

  it('長度：300 字可以，301 字拒絕', () => {
    expect(cleanValue('ANTHROPIC_API_KEY', 'a'.repeat(300))).toHaveLength(300);
    expect(() => cleanValue('ANTHROPIC_API_KEY', 'a'.repeat(301))).toThrow();
  });

  it('[發現·資訊] 前後空白與結尾換行會被 trim 掉後才寫入（不會注入，但值與輸入不一致）', () => {
    expect(cleanValue('ANTHROPIC_API_KEY', '  abc\n')).toBe('abc');
  });

  it('區域名稱只接受小寫英數字（不能含 / . 等）', () => {
    expect(cleanValue('AZURE_SPEECH_REGION', 'eastasia')).toBe('eastasia');
    expect(() => cleanValue('AZURE_SPEECH_REGION', 'eastasia.evil.com')).toThrow();
    expect(() => cleanValue('AZURE_SPEECH_REGION', 'east/asia')).toThrow();
    expect(() => cleanValue('AZURE_SPEECH_REGION', 'EASTASIA')).toThrow();
  });
});

describe('額外的鍵與原型污染', () => {
  it('只能寫六個白名單名稱；其他名稱、小寫名稱、換行注入的鍵名都拒絕', () => {
    expect(() => applyEnvUpdates('', { ['NODE_OPTIONS' as never]: '--inspect' })).toThrow();
    expect(() => applyEnvUpdates('', { ['anthropic_api_key' as never]: 'abc' })).toThrow();
    expect(() => applyEnvUpdates('', { ['MUGI_CHAT_PER_MINUTE' as never]: '0' })).toThrow();
    expect(() => applyEnvUpdates('', { ['__proto__' as never]: 'x' })).toThrow();
  });

  it('keyUpdatesFrom 只看五個欄位：多餘鍵與 __proto__ 被忽略，不污染原型', () => {
    const body = JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"x":1}},"anthropicKey":"abc123","NODE_OPTIONS":"--x"}');
    const updates = keyUpdatesFrom(body);
    expect(updates).toEqual({ ANTHROPIC_API_KEY: 'abc123' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('欄位型別錯誤（數字、陣列、物件）→ 拒絕', () => {
    expect(() => keyUpdatesFrom({ anthropicKey: 12 })).toThrow();
    expect(() => keyUpdatesFrom({ anthropicKey: ['a'] })).toThrow();
    expect(() => keyUpdatesFrom({ anthropicKey: { x: 1 } })).toThrow();
  });

  it('預算：NaN、Infinity、負數、超過 100、三位小數都拒絕', () => {
    for (const v of [NaN, Infinity, -1, 100.01, 1.234, '2', null]) {
      expect(() => parseBudget(v)).toThrow();
    }
    expect(parseBudget(0)).toBe(0);
    expect(formatUsd(parseBudget(0.1 + 0.2))).toBe('0.3');
  });
});

describe('寫入的正確性（既有行、註解、BOM、CRLF）', () => {
  it('取代所有同名的行（包括重複的），註解行不被當成設定', () => {
    const before = '# ANTHROPIC_API_KEY=old-commented\r\nANTHROPIC_API_KEY=one\r\nANTHROPIC_API_KEY=two\r\n';
    const after = applyEnvUpdates(before, { ANTHROPIC_API_KEY: 'newkey1' });
    expect(after).toBe('# ANTHROPIC_API_KEY=old-commented\r\nANTHROPIC_API_KEY=newkey1\r\nANTHROPIC_API_KEY=newkey1\r\n');
    expect(readEnvValue(after, 'ANTHROPIC_API_KEY')).toBe('newkey1');
  });

  it('BOM 與 CRLF 保留，新增的行用 CRLF；沒有結尾換行的最後一行會補上', () => {
    const before = '﻿GOOGLE_TTS_API_KEY=g1\r\nOTHER=keepme';
    const after = applyEnvUpdates(before, { AZURE_SPEECH_KEY: 'azkey' });
    expect(after.startsWith('﻿')).toBe(true);
    expect(after).toBe('﻿GOOGLE_TTS_API_KEY=g1\r\nOTHER=keepme\r\nAZURE_SPEECH_KEY=azkey\r\n');
    expect(after.replace(/\r\n/g, '')).not.toMatch(/\n/);
  });

  it('null 會移除該鍵的所有行，其他行原樣保留', () => {
    const after = applyEnvUpdates('A=1\nANTHROPIC_API_KEY=x\nANTHROPIC_API_KEY=y\nB=2\n', { ANTHROPIC_API_KEY: null });
    expect(after).toBe('A=1\nB=2\n');
  });

  it('同一批次內的多個更新互不影響', () => {
    const after = applyEnvUpdates('', { ANTHROPIC_API_KEY: 'a1', AZURE_SPEECH_REGION: 'eastasia', MUGI_DAILY_USD: '2' });
    expect(readEnvValue(after, 'ANTHROPIC_API_KEY')).toBe('a1');
    expect(readEnvValue(after, 'AZURE_SPEECH_REGION')).toBe('eastasia');
    expect(readEnvValue(after, 'MUGI_DAILY_USD')).toBe('2');
  });

  it('超長的既有檔（含 300 字以上的其他行）與長值寫入：寫入成功、其他行不被截斷', () => {
    const long = `OTHER=${'x'.repeat(5000)}\n`;
    const after = applyEnvUpdates(long, { GOOGLE_TTS_API_KEY: 'g'.repeat(300) });
    expect(after.startsWith(long)).toBe(true);
    expect(readEnvValue(after, 'GOOGLE_TTS_API_KEY')).toHaveLength(300);
  });
});

describe('寫入檔案（updateEnvFile）：臨時檔、失敗時不洩漏值', () => {
  it('寫入成功並可讀回；臨時檔不殘留', () => {
    const p = tmpEnv();
    updateEnvFile(p, { ANTHROPIC_API_KEY: 'test-key-ABC_123' });
    expect(readEnvValue(fs.readFileSync(p, 'utf8'), 'ANTHROPIC_API_KEY')).toBe('test-key-ABC_123');
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('寫入失敗（資料夾不存在）時，錯誤訊息只有中文說明，不含值', () => {
    const p = path.join(dir, 'no-such-dir', '.env.local');
    let msg = '';
    try { updateEnvFile(p, { ANTHROPIC_API_KEY: 'SECRET-VALUE-123' }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/無法寫入/);
    expect(msg).not.toContain('SECRET-VALUE-123');
  });

  it('兩個更新依序（同步）執行，互不遺失：一個是同步的 read-modify-write', () => {
    const p = tmpEnv();
    updateEnvFile(p, { ANTHROPIC_API_KEY: 'k1' });
    updateEnvFile(p, { GOOGLE_TTS_API_KEY: 'g1' });
    const text = fs.readFileSync(p, 'utf8');
    expect(readEnvValue(text, 'ANTHROPIC_API_KEY')).toBe('k1');
    expect(readEnvValue(text, 'GOOGLE_TTS_API_KEY')).toBe('g1');
  });

  // Windows needs developer mode or a privilege to create symlinks; the probe decides whether this runs.
  const canSymlink = (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mugi-redteam-sym-'));
    try {
      fs.writeFileSync(path.join(d, 't'), 'x');
      fs.symlinkSync(path.join(d, 't'), path.join(d, 'l'));
      return true;
    } catch {
      return false;
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  })();
  it.runIf(canSymlink)('[已修] 符號連結的 .env.local：寫入被拒絕（「.env.local 是捷徑，請改成一般檔案」），連結與目標檔都不變', () => {
    const target = tmpEnv('real-target.env');
    fs.writeFileSync(target, 'OTHER=1\n');
    const link = tmpEnv('.env.local');
    fs.symlinkSync(target, link);
    expect(() => updateEnvFile(link, { ANTHROPIC_API_KEY: 'zz9' })).toThrow('.env.local 是捷徑，請改成一般檔案');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('OTHER=1\n'); // the target is untouched
  });
});

// ---------------------------------------------------------------- the settings routes, with a temp .env.local

function fakeReq(url: string, method: string, headers: Record<string, string>, body?: unknown): IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(req, { url, method, headers: { 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  return req;
}
function fakeRes() {
  const out = { status: 0, body: '' };
  const res = {
    writeHead(status: number) { out.status = status; return res; },
    end(d?: string) { out.body = d ?? ''; return res; },
  };
  return { res: res as unknown as ServerResponse, out };
}
const deps = (envPath: string): SettingsDeps => ({
  envPath, guard: { allowedHosts: [] }, readUsd: () => 2, spentTodayUsd: () => 0,
});

describe('設定路由（臨時 .env.local）', () => {
  it('信任的 Host 可以寫入臨時檔（這是唯一被接受的寫入）', async () => {
    const p = tmpEnv();
    const { res, out } = fakeRes();
    const handled = await handleSettingsApi(fakeReq('/keys', 'POST', { host: '127.0.0.1:3110' }, { googleKey: 'gk-test-1' }), res, deps(p));
    expect(handled).toBe(true);
    expect(out.status).toBe(200);
    expect(readEnvValue(fs.readFileSync(p, 'utf8'), 'GOOGLE_TTS_API_KEY')).toBe('gk-test-1');
    expect(out.body).not.toContain('gk-test-1'); // the status shows the last four characters only
  });

  it('不信任的 Host（evil.com、IP）或跨站請求：403，檔案不變', async () => {
    const p = tmpEnv();
    fs.writeFileSync(p, 'GOOGLE_TTS_API_KEY=orig1\n');
    const before = fs.readFileSync(p, 'utf8');
    // through guardApi, as the dev server mounts it (the cross-site and Host refusals are the guard's, not the route's)
    const guarded = guardApi((req, res) => handleSettingsApi(req, res, deps(p)), { allowedHosts: [] });
    for (const headers of [{ host: 'evil.com' }, { host: '192.168.1.10:3110' }, { host: '127.0.0.1:3110', 'sec-fetch-site': 'cross-site' }] as Record<string, string>[]) {
      const { res, out } = fakeRes();
      await guarded(fakeReq('/keys', 'POST', headers, { googleKey: 'hacked' }), res);
      expect(out.status).toBe(403);
    }
    expect(fs.readFileSync(p, 'utf8')).toBe(before);
  });

  it('信任的 Host 但值不合格（換行注入）：400，檔案不變', async () => {
    const p = tmpEnv();
    fs.writeFileSync(p, 'OTHER=1\n');
    const { res, out } = fakeRes();
    await handleSettingsApi(fakeReq('/keys', 'POST', { host: 'localhost:3110' }, { googleKey: 'a\nMUGI_DAILY_USD=0' }), res, deps(p));
    expect(out.status).toBe(400);
    expect(fs.readFileSync(p, 'utf8')).toBe('OTHER=1\n');
  });

  it('信任的 Host 但預算超過 100：400，檔案不變；預算 0 只有本機會被接受（關閉每日上限，只能在電腦上做）', async () => {
    const p = tmpEnv();
    const { res: r1, out: o1 } = fakeRes();
    await handleSettingsApi(fakeReq('/budget', 'POST', { host: 'localhost:3110' }, { usd: 101 }), r1, deps(p));
    expect(o1.status).toBe(400);
    expect(fs.existsSync(p)).toBe(false);
    const { res: r2, out: o2 } = fakeRes();
    await handleSettingsApi(fakeReq('/budget', 'POST', { host: 'localhost:3110' }, { usd: 0 }), r2, deps(p));
    expect(o2.status).toBe(200);
    expect(readEnvValue(fs.readFileSync(p, 'utf8'), 'MUGI_DAILY_USD')).toBe('0');
  });

  it('[發現·資訊] GET /keys 回傳每個鍵的末四碼（不回全值）；任何通過 Host 規則的 GET 都能讀到', async () => {
    const p = tmpEnv();
    fs.writeFileSync(p, 'ANTHROPIC_API_KEY=sk-test-ABCD1234\n');
    const { res, out } = fakeRes();
    await handleSettingsApi(fakeReq('/keys', 'GET', { host: 'localhost:3110' }), res, deps(p));
    expect(out.status).toBe(200);
    expect(out.body).toContain('1234');
    expect(out.body).not.toContain('sk-test-ABCD');
  });
});
