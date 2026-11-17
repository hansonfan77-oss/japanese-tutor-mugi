/** Fail closed until the application has fetched an explicit server policy. Never stored in browser settings. */
let speechAllowed = false;
export const browserSpeechAllowed = () => speechAllowed;
export function configureBrowserRuntime(mode: 'acceptance' | 'normal' | 'unknown') {
  speechAllowed = mode === 'normal';
}
