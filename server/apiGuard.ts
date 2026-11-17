// Request guard for every /api route of the dev server (claudeChat.ts, tts.ts, usage.ts). Every route is mounted through
// guardApi; a request is refused (403 or 415) when:
//   - the Host header names a host that is not allowed: only localhost, 127.0.0.1, ::1 and the names in server.allowedHosts
//     (an entry that starts with "." also allows its subdomains). IP addresses are refused unless MUGI_LAN=1, and the port
//     after the name must be digits 1 to 65535. Vite's own check accepts every IP address as a Host, so this check is the one
//     that matters for DNS rebinding;
//   - the connection is not from this PC: a request whose socket address is not loopback (127.0.0.1, ::1, ::ffff:127.0.0.1),
//     or a LAN request (MUGI_LAN=1, Host is a raw IP address other than loopback), carries no valid pairing code in the
//     X-Mugi-Pair header (403, error "pair_required"). The code is printed once when the server starts (pairingCode).
//     The Host header never makes a request local or trusted by itself: that is decided by the socket (see settingsAccess.ts
//     and openai/routes.ts), so a LAN client that sends Host 127.0.0.1 gets no more than a pairing-code request;
//   - the browser says it came from another site: Sec-Fetch-Site must be same-origin or none (or absent);
//   - it carries an Origin whose scheme is http or https and whose host and port are the Host the request was sent to
//     (Origin 'null' and every other value refused). A Tailscale Serve https Origin matches its ts.net Host this way;
//   - it is a POST, PUT or DELETE whose Content-Type is application/json (optionally with a charset parameter). A plain
//     HTML form or a text/plain fetch cannot send that type without a CORS preflight. This server sends no CORS headers, so
//     the browser stops at the preflight and never sends the body.
// The Origin and Sec-Fetch-Site rules rely on the browser sending those headers. A client that sends neither (curl, the
// Vite proxy, a same-origin GET) passes them, but the Host, pairing and Content-Type rules still apply to it.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ViteDevServer } from 'vite';

export type GuardHeaders = Record<string, string | string[] | undefined>;
/** the part of a request that says where it came from: the socket it arrived on (req.socket in Node) */
export type SocketLike = { socket?: { remoteAddress?: string | undefined } | null };
export type GuardRequest = SocketLike & { method?: string; headers: GuardHeaders };

/**
 * true when the request arrived on a loopback socket (remote address 127.0.0.1, ::1 or ::ffff:127.0.0.1): it comes from this PC
 * or from a proxy on this PC (Tailscale Serve connects from 127.0.0.1). The Host header is the client's own text, so it never
 * decides this alone. A request with no socket counts as not loopback.
 */
export function isLoopbackSocket(req: SocketLike): boolean {
  const a = req.socket?.remoteAddress;
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** the headers a reverse proxy (Tailscale Serve and the like) adds: a request that carries one came through a proxy */
export const PROXY_HEADER_NAMES = ['tailscale-user-login', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'] as const;

/** true when the request carries a proxy header */
export function hasProxyHeader(headers: GuardHeaders): boolean {
  return PROXY_HEADER_NAMES.some((h) => headers[h] !== undefined);
}
export type GuardResult = { ok: true } | { ok: false; status: number; message: string; code?: string };

/** the header a LAN client sends its pairing code in */
export const PAIR_HEADER = 'x-mugi-pair';
export const PAIR_REQUIRED_MESSAGE = '區網連線需要配對碼';

/**
 * What the Host rule accepts beyond the loopback names. `allowedHosts` is server.allowedHosts from vite.config.ts (a list;
 * an entry starting with "." covers its subdomains). When Vite has it set to `true`, no names are added here: this server's
 * own list is then the only extra permission. `lan` (MUGI_LAN=1) also accepts IP addresses; `pairToken` is the code a LAN
 * request must send (it is required for every raw-IP Host).
 */
export type GuardOptions = { allowedHosts?: readonly string[]; lan?: boolean; pairToken?: string };

/** the first value of a header (lower-case name), or undefined */
function header(h: GuardHeaders, name: string): string | undefined {
  const v = h[name];
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * The host name of a Host header value, without the port, lower-case: `localhost:3004` → `localhost`, `[::1]:3004` → `[::1]`,
 * `::1` → `::1`. null when the value is not a host (empty, a bad port, an unbracketed IPv6 address with a port).
 */
export function hostNameOf(host: string): string | null {
  const h = host.trim().toLowerCase();
  if (!h) return null;
  if (isIP(h) === 6) return h; // a bare IPv6 literal has no port
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end === -1) return null;
    const rest = h.slice(end + 1);
    if (rest !== '' && !/^:\d*$/.test(rest)) return null;
    return h.slice(0, end + 1);
  }
  const colons = h.split(':').length - 1;
  if (colons > 1) return null;
  if (colons === 0) return h;
  const i = h.indexOf(':');
  const name = h.slice(0, i);
  if (!name || !/^\d*$/.test(h.slice(i + 1))) return null;
  return name;
}

/** true when the Host header's port (if it has one) is digits 1 to 65535; a Host with no port is fine */
export function hostPortOk(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (isIP(h) === 6) return true; // a bare IPv6 literal has no port
  const from = h.startsWith('[') ? h.indexOf(']') + 1 : 0;
  const colon = h.indexOf(':', from);
  if (colon === -1) return true;
  const port = h.slice(colon + 1);
  return /^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** true for an IP address Host that is not loopback: a LAN address (MUGI_LAN=1 only) */
export function isRawIpName(name: string): boolean {
  if (LOOPBACK_NAMES.has(name)) return false;
  const bare = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
  return isIP(bare) !== 0;
}

/** true when the host name may be used to reach this server */
export function hostAllowed(name: string, opts: GuardOptions = {}): boolean {
  if (LOOPBACK_NAMES.has(name)) return true;
  for (const entry of opts.allowedHosts ?? []) {
    const e = entry.trim().toLowerCase();
    if (!e) continue;
    if (e.startsWith('.')) {
      if (name === e.slice(1) || name.endsWith(e)) return true;
    } else if (name === e) {
      return true;
    }
  }
  if (opts.lan && isRawIpName(name)) return true;
  return false;
}

/** the pairing code of this server process (see pairingCode) */
let pairing: string | null = null;

/**
 * The LAN pairing code: 16 random bytes as hex, made once per server process. The first call prints it in the dev-server
 * console (once), so the owner can type it into the phone. Only guardOptionsFrom calls this, and only with MUGI_LAN=1.
 */
export function pairingCode(): string {
  if (pairing === null) {
    pairing = randomBytes(16).toString('hex');
    console.log(`MUGI_LAN 配對碼：${pairing}`);
  }
  return pairing;
}

/** true when the request carries the pairing code (constant-time compare) */
function pairOk(h: GuardHeaders, token: string | undefined): boolean {
  const given = header(h, PAIR_HEADER);
  if (!token || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** a Content-Type that is exactly application/json, optionally with a charset parameter */
function isJsonContentType(ct: string | undefined): boolean {
  if (ct === undefined) return false;
  const [type, ...params] = ct.split(';').map((s) => s.trim().toLowerCase());
  if (type !== 'application/json') return false;
  return params.every((p) => /^charset=("?)[a-z0-9_-]+\1$/.test(p));
}

/**
 * The browser-header rules alone (Sec-Fetch-Site and Origin against the Host), for a route that wants them again inside
 * (defence in depth). Returns null when they pass, or the refusal.
 */
export function browserHeadersRefusal(headers: GuardHeaders): GuardResult | null {
  const hostHeader = header(headers, 'host') ?? '';
  const site = header(headers, 'sec-fetch-site');
  if (site !== undefined && site.trim().toLowerCase() !== 'same-origin' && site.trim().toLowerCase() !== 'none') {
    return { ok: false, status: 403, message: '不接受其他網站發出的請求' };
  }
  const origin = header(headers, 'origin');
  if (origin !== undefined) {
    let same = false;
    try {
      const u = new URL(origin);
      same = (u.protocol === 'http:' || u.protocol === 'https:') && u.host.toLowerCase() === hostHeader.trim().toLowerCase();
    } catch {
      same = false; // 'null' and anything else that is not a URL
    }
    if (!same) return { ok: false, status: 403, message: '只能從這個伺服器的頁面使用' };
  }
  return null;
}

/** Host and socket/pairing boundary shared by APIs and public document navigation. Pure: no I/O. */
export function checkRequestHost(req: GuardRequest, opts: GuardOptions = {}): GuardResult {
  const h = req.headers;
  const hostHeader = header(h, 'host');
  const hostName = hostHeader === undefined ? null : hostNameOf(hostHeader);
  if (hostHeader === undefined || hostName === null || !hostPortOk(hostHeader) || !hostAllowed(hostName, opts)) {
    return { ok: false, status: 403, message: '這個主機名稱不被允許（見 vite.config.ts 的 server.allowedHosts 與 MUGI_LAN）' };
  }
  // a connection that is not from this PC (any socket but loopback), and a raw-IP Host, need the pairing code
  if ((!isLoopbackSocket(req) || isRawIpName(hostName)) && !pairOk(h, opts.pairToken)) {
    return { ok: false, status: 403, message: PAIR_REQUIRED_MESSAGE, code: 'pair_required' };
  }
  return { ok: true };
}

/** Decides whether an /api request may run. Public navigation exceptions do not apply here. */
export function checkApiRequest(req: GuardRequest, opts: GuardOptions = {}): GuardResult {
  const host = checkRequestHost(req, opts);
  if (!host.ok) return host;
  const h = req.headers;
  const browser = browserHeadersRefusal(h);
  if (browser) return browser;
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    if (!isJsonContentType(header(h, 'content-type'))) {
      return { ok: false, status: 415, message: '請求的 Content-Type 必須是 application/json' };
    }
  }
  return { ok: true };
}

/**
 * The guard options of this dev server: server.allowedHosts (as Vite resolved it) and MUGI_LAN, read from the process
 * environment when the server starts (the value in .env.local does not count: Vite reads .env files only for the app).
 * With MUGI_LAN=1 the options carry the pairing code (pairingCode).
 */
export function guardOptionsFrom(server: Pick<ViteDevServer, 'config'>): GuardOptions {
  const allowed = server.config.server.allowedHosts;
  const lan = process.env.MUGI_LAN === '1';
  return {
    allowedHosts: allowed === true ? [] : [...allowed],
    lan,
    pairToken: lan ? pairingCode() : undefined,
  };
}

/**
 * Wraps a route handler: a refused request gets the JSON error and the handler never runs; an allowed one goes straight
 * to the handler. Mount every /api route through this, with the options of guardOptionsFrom(server).
 */
export function guardApi(
  handler: (req: IncomingMessage, res: ServerResponse) => unknown,
  opts: GuardOptions = {},
): (req: IncomingMessage, res: ServerResponse) => unknown {
  return (req, res) => {
    const r = checkApiRequest(req, opts);
    if (!r.ok) {
      res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: r.code ?? 'forbidden', message: r.message }));
      return undefined;
    }
    return handler(req, res);
  };
}
