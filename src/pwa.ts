/** Register only built deployments; development/HMR never installs a worker. */
export async function registerPwa() {
  if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
    try { await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }); }
    catch { console.warn('[pwa] offline support unavailable'); }
  }
}
