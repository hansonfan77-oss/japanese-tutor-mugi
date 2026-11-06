## Result

Prepare Mugi for private Windows hosting and phone PWA use, repair strict builds/Linux tests, and add a renderer-independent animation core. No paid APIs were called, no production host/data was modified, and no public deployment was made.

- M0: fix NodeNext import, strict red-team test types, and platform-native VOICEVOX test fixtures without removing assertions.
- M1: built Node/Connect production host reuses guarded APIs; public-only offline notice worker; accessible mobile refinements; Windows install/start/stop supervision and private Tailscale Serve documentation.
- M2 foundation: six animation states, smooth bounded independent part transforms, existing blink/viseme reuse, reduced motion, and deterministic tests. New layered renderer is deliberately not connected to current artwork yet; existing single-image mode is preserved.
- Future learning, Ollama and asset requirements are specified without implementing those features.

## Validation

- Full Vitest run: 93 files, 1422 passed, 1 existing optional integration test skipped.
- `npm run build`: strict TypeScript + frontend bundle + production server bundle pass.
- Actual built production server: homepage, manifest, worker, offline notice, chat/TTS status, usage and health respond; no-store API headers and missing source/secret paths checked.
- New tests cover production Host/origin guards, sensitive files, static files, worker privacy, and animation state/clock behavior. Existing AI mocks remain in use.
- Windows PowerShell scripts, Android/iOS install/microphone/keyboard, Tailscale ACL/HTTPS and real AI/OAuth/VOICEVOX remain unverified on target hardware.

See docs/private-host.md, docs/animation-design.md and docs/future-spec.md. Review before deploying; do not merge automatically.
