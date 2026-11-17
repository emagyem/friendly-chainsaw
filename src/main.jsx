import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/bricolage-grotesque/standard.css'
import '@fontsource-variable/instrument-sans/wdth.css'
import '@fontsource-variable/source-serif-4/opsz.css'
import './index.css'
import { loadData } from './data.js'
import { stage } from './native.js'

// Load the dataset first, then the app, so every view (and every module-level
// constant in App.jsx) sees the same, complete data.
// If anything fails before the first screen appears, say so on screen rather than leaving a blank page.
function showStartupError(e) {
  const el = document.getElementById('root')
  el.innerHTML = '<div style="font:16px system-ui;padding:max(48px,env(safe-area-inset-top)) 24px 24px;color:#10202E">' +
    '<h1 style="font-size:22px">Helixora couldn\'t start</h1><p>Check your connection and open the app again.</p>' +
    '<pre style="white-space:pre-wrap;font-size:12px;color:#5A6B76"></pre></div>'
  el.querySelector('pre').textContent = String(e && (e.stack || e.message) || e)
}
window.addEventListener('error', (ev) => { if (!document.getElementById('root').childElementCount) showStartupError(ev.error || ev.message) })

loadData()
  .then(() => { stage('Starting…'); return import('./App.jsx') })
  .then(({ default: App }) => {
    createRoot(document.getElementById('root')).render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  })
  .catch(showStartupError)
