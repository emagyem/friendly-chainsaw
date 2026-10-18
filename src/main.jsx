import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/bricolage-grotesque/standard.css'
import '@fontsource-variable/instrument-sans/wdth.css'
import './index.css'
import { loadData } from './data.js'

// Load the dataset first, then the app, so every view (and every module-level
// constant in App.jsx) sees the same, complete data.
loadData()
  .then(() => import('./App.jsx'))
  .then(({ default: App }) => {
    createRoot(document.getElementById('root')).render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  })
