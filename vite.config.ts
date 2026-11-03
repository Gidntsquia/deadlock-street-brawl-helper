import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron';

// https://vite.dev/config/
// Dev tooling (debug panel, session recorder, perf timing, test-mode video, e2e hooks) is compiled in only for dev
// runs, vitest, pre-release versions (`-rc`) and builds that ask for it (`BRAWL_DEVTOOLS=1`, which the win:* harness
// scripts set). A plain production build defines it false, so the bundler drops all of it.
const version: string = JSON.parse(readFileSync('package.json', 'utf8')).version;
const isPre = /^\d+\.\d+\.\d+-[0-9A-Za-z]/.test(version);

export default defineConfig(({ mode, command }) => {
  const devTools =
    command === 'serve' || mode === 'test' || !!process.env.VITEST || isPre || process.env.BRAWL_DEVTOOLS === '1';
  const defs = {
    __APP_VERSION__: JSON.stringify(version),
    __DEV_TOOLS__: JSON.stringify(devTools),
    // Harness switch: a plain build never reads it, so every BRAWL_E2E branch folds away.
    ...(devTools ? {} : { 'process.env.BRAWL_E2E': 'undefined' }),
  };
  return {
    // Electron loads dist/index.html via loadFile (no server), so assets must resolve relative to the
    // file, not from the site root; the browser dev server still needs the root-relative default.
    base: process.env.BASE_PATH ?? (mode === 'electron' ? './' : '/'),
    define: defs,
    plugins: [
      react(),
      mode === 'electron' &&
        electron([
          {
            entry: 'electron/main.ts',
            vite: { define: defs, build: { outDir: 'electron-dist', rollupOptions: { external: ['koffi'] } } },
          },
          {
            entry: 'electron/preload.ts',
            // Electron's sandboxed preload loader rejects ESM ("Cannot use import statement outside a
            // module"); package.json has "type": "module" so vite-plugin-electron's default output would
            // otherwise emit ESM. Force CommonJS and name the file .cjs so Node/Electron never guesses ESM
            // from the package type.
            vite: {
              define: defs,
              build: {
                outDir: 'electron-dist',
                lib: { entry: 'electron/preload.ts', formats: ['cjs'], fileName: () => 'preload.cjs' },
                rollupOptions: { output: { format: 'cjs' } },
              },
            },
          },
        ]),
    ],
    server: { host: true },
    test: {
      // jsdom component tests take 6-8 s when the whole suite runs in parallel (pass in ~1 s alone)
      testTimeout: 20000,
      environmentMatchGlobs: [['src/components/**', 'jsdom']],
      setupFiles: ['scripts/__tests__/setup-reader.ts'],
    },
  };
});
