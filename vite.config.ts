import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { appRuntimePlugin } from './server/appRuntime.ts'
import { readRunMode } from './server/runtimePolicy.ts'
import { FS_DENY } from './server/fsDeny.ts'

// Dev server. By default it listens on 127.0.0.1 only: this PC can reach it, nothing else can.
// MUGI_LAN=1 (set in the shell that starts the server, read here at startup) listens on all network interfaces, so a
// phone on the same network can reach it (http://<your-PC-ip>:3004). Risk: anyone on that network can then use the
// Claude key and the speech services through this server. Prefer Tailscale Serve (see README, 安全性 / Security).
// Vite refuses a Host name it does not know: it accepts localhost, *.localhost, IP addresses and the names listed in
// server.allowedHosts. The /api routes check the Host again (server/apiGuard.ts): only localhost, 127.0.0.1, ::1 and the
// names in allowedHosts are accepted, and IP addresses only with MUGI_LAN=1. To reach the dev server under another name
// (for example a VPN or a custom DNS name), add that host to server.allowedHosts and preview.allowedHosts, e.g.
// allowedHosts: ['.example.com'] (a leading dot also covers subdomains), or set MUGI_ALLOWED_HOSTS in that shell to a
// comma-separated list (e.g. a Tailscale Serve name, my-pc.tailnet-name.ts.net); the server still listens on 127.0.0.1 only.
const LAN = process.env.MUGI_LAN === '1';
const host = LAN ? true : '127.0.0.1';
const EXTRA_HOSTS = (process.env.MUGI_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'test' ? [] : [appRuntimePlugin()])],
  envDir: readRunMode() === 'acceptance' ? false : undefined,
  test: { setupFiles: ['./src/testSetup.ts'] },
  server: {
    host,
    port: 3004,
    strictPort: true,
    allowedHosts: EXTRA_HOSTS,
    // fs.deny is replaced, not merged, when set: server/fsDeny.ts repeats Vite 8's defaults (.env, .env.*, keys, .npmrc,
    // .git), then adds this project's own folders. Its patterns must be "**/…" (see that file).
    fs: { deny: FS_DENY },
  },
  preview: { host, port: 4173, allowedHosts: EXTRA_HOSTS },
  build: {
    rolldownOptions: {
      output: {
        // soundtouchjs (LGPL) goes into its own file, so a user can replace or relink it
        manualChunks(id: string) {
          if (id.includes('soundtouchjs')) return 'soundtouch';
          return undefined;
        },
      },
    },
  },
}))
