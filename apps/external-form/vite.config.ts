import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

/**
 * The page is served at `<base>/f/<token>` and `<base>/i/<token>`, its files at
 * `<base>/assets/form/…` (README.md). So the HTML points one level up (`../assets/form/x.js`
 * from `/f/<token>`), whatever `<base>` is (`https://<id>.relay` or `https://relay/x/<id>`);
 * files referenced from the scripts and styles resolve next to them.
 */
export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname),
  base: './',
  experimental: {
    renderBuiltUrl(filename, { hostType }) {
      if (hostType === 'html') return `../${filename}`
      return { relative: true }
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    assetsDir: 'assets/form',
    // No inline scripts (the page's CSP is `default-src 'self'`), and nothing to preload.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
    target: 'es2019',
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/form/form-[hash].js',
        chunkFileNames: 'assets/form/[name]-[hash].js',
        assetFileNames: 'assets/form/[name]-[hash][extname]',
      },
    },
  },
  server: { port: 5178 },
})
