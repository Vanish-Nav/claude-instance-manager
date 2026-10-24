import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// `electron-vite dev --rendererOnly` opens the UI in a browser without the
// preload bridge; a development mock stands in for it there.
if (import.meta.env.DEV && !('manager' in window)) {
  await import('./mock-manager')
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
