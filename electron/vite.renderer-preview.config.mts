import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Opens the renderer in a plain browser with the development mock of the
// preload bridge: `npx vite --config vite.renderer-preview.config.mts`.
export default defineConfig({ root: 'src/renderer', plugins: [react()], server: { port: 5173, strictPort: true } })
