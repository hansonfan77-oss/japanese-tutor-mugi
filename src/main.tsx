import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initViewport } from './viewport'

// standalone (home-screen) app: tag <html> and size #root to the real screen height (see viewport.ts); ?vp=1 = debug overlay
initViewport()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

import { registerPwa } from './pwa';
void registerPwa();
