import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import electron from 'vite-plugin-electron'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  base: process.env.BASE_PATH ?? '/',
  plugins: [
    react(),
    mode === 'electron' && electron([
      { entry: 'electron/main.ts', vite: { build: { outDir: 'electron-dist', rollupOptions: { external: ['koffi'] } } } },
      { entry: 'electron/preload.ts', vite: { build: { outDir: 'electron-dist' } } },
    ]),
  ],
  server: { host: true },
}))
