import { copyFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { crx, type ManifestV3Export } from '@crxjs/vite-plugin';

const ROOT = import.meta.dirname;
const require = createRequire(import.meta.url);
const MANIFEST_PATH = resolve(ROOT, 'src/manifest.json');
const manifest = require('./src/manifest.json') as { version: string };
const DIST = resolve(ROOT, 'dist');

function manifestVersion(): string {
  return (JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { version: string }).version;
}

const copyLicense: Plugin = {
  name: 'copy-license',
  apply: 'build',
  closeBundle() {
    copyFileSync(resolve(ROOT, 'LICENSE'), resolve(DIST, 'LICENSE'));
  },
};

// Stamp the options page with the extension version from manifest.json so the
// badge stays in sync without a runtime script (MV3 pages block inline JS).
// Read manifest on each transform — dev watch keeps vite.config cached, so a
// one-time require() would keep stamping the old version after a bump.
const injectManifestVersion: Plugin = {
  name: 'inject-manifest-version',
  enforce: 'post',
  transformIndexHtml(html) {
    return html.replaceAll('%MANIFEST_VERSION%', manifestVersion());
  },
};

export default defineConfig({
  plugins: [
    crx({
      manifest: manifest as unknown as ManifestV3Export,
      // One self-contained IIFE instead of a loader that import()s the real
      // script from chrome-extension://. Chrome blocks that import in some
      // throwaway iframes (e.g. hidden probe frames pages create and remove),
      // which showed up as "Unsafe attempt to load URL" extension errors.
      contentScripts: { standaloneFiles: ['src/content/core.ts'] },
    }),
    injectManifestVersion,
    copyLicense,
  ],
  css: {
    preprocessorOptions: {
      scss: { quietDeps: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
