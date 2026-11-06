// The files the dev server never serves to the browser (vite.config.ts → server.fs.deny). Vite matches a pattern that has no
// "/" in it as "**/<pattern>", but a pattern that contains "/" is matched as written, against the absolute path. So the
// folders of this project must be written as "**/<folder>/**"; ".usage/**" alone matches nothing and the files were served.
// The first entries are Vite's own defaults (fs.deny is replaced when set, so they are repeated here).
// tests: src/game/__tests__/fsDeny.test.ts checks these with Vite's isFileServingAllowed.
export const FS_DENY: string[] = [
  '.env',
  '.env.*',
  '*.{crt,pem,key,p12,pfx,cer,der}',
  '.npmrc',
  '.yarnrc.yml',
  '**/.git/**',
  // this project's own folders: usage counts, the speech cache (kept and cached audio), the local VOICEVOX engine
  '**/.runtime/**',
  '**/.usage/**',
  '**/.tts-cache/**',
  '**/.tts-keep/**',
  '**/voicevox_engine/**',
  // the Claude Code settings and local logs (a log can hold a request or a path)
  '**/.claude/**',
  '**/*.log',
];
