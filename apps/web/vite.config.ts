import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The dev server proxies the API rather than the app knowing an absolute URL.
 *
 * That keeps every request same-origin in development, which is what production looks like
 * when the server serves the built bundle — so cookies, CORS and the WebAuthn origin all
 * behave in development the way they will in production, instead of being three things that
 * only break once deployed.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.PASSVAULT_SERVER ?? 'http://127.0.0.1:8080',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
