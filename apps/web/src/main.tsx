import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

/**
 * The service worker, registered after the page is up.
 *
 * Deliberately not awaited and deliberately silent on failure: an installation served over plain
 * HTTP has no service worker available at all, and that has to be a slower app rather than a
 * blank screen. What it buys is the shell loading without a network — the state of every venue
 * with a concrete roof — and nothing of the API is ever cached, which is the rule the worker is
 * written around.
 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined)
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
