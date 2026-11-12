import { defineConfig } from 'vite'

export default defineConfig({
  // host: true binds 0.0.0.0 so the phone can load the dev server over LAN (QR sideload).
  server: { host: true, port: 5173, strictPort: true },
  build: { target: 'esnext', outDir: 'dist', emptyOutDir: true },
})
