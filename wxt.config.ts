import { defineConfig } from 'wxt';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import fs from 'fs';

const packageJson = JSON.parse(fs.readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
const isDebug = process.env.WXT_DEBUG === 'true';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/webextension-polyfill'],
  imports: {
    addons: {
      vueTemplate: true,
    },
  },
  vite: ({ browser }) => ({
    plugins: [vue()],
    define: {
      'process.env.VUE_APP_VERSION': JSON.stringify(packageJson.version),
      // Content scripts run in an isolated world and must not register policies against the page CSP.
      'window.trustedTypes': 'undefined',
    },
    build: {
      // Mozilla reviewers rebuild and compare bundles. Disabling minification
      // for Firefox keeps output reviewable and independent of absolute build
      // paths while Chrome retains its existing optimized production build.
      minify: isDebug || browser === 'firefox' ? false : undefined,
      sourcemap: isDebug ? 'inline' : undefined,
    },
  }),
  manifest: ({ browser }) => {
    const isFirefox = browser === 'firefox';

    return {
      name: '喵喵阅读',
      description: '一款 AI 驱动的开源浏览器翻译插件，带来母语般的双语阅读体验',
      permissions: [
        'storage',
        'contextMenus',
        ...(isFirefox ? [] : ['offscreen']),
        'unlimitedStorage',
      ],
      // Firefox MV2 needs explicit origins for background requests to Google
      // Translate and user-configured OpenAI-compatible endpoints.
      host_permissions: isFirefox ? ['<all_urls>'] : undefined,
      // Translation text and optional API credentials leave the browser only
      // for the translation provider selected by the user.
      browser_specific_settings: isFirefox
        ? ({
            gecko: {
              id: 'catgirl-read@icewithcola.github.io',
              strict_min_version: '140.0',
              data_collection_permissions: {
                required: ['websiteContent', 'authenticationInfo'],
              },
            },
            gecko_android: {
              strict_min_version: '142.0',
            },
          } as any)
        : undefined,
      // Translation results are cached locally. Keeping the extension out of
      // private windows prevents private-session content from being persisted.
      incognito: isFirefox ? 'not_allowed' : undefined,
      web_accessible_resources: [
        {
          resources: ['icon/*.png'],
          matches: ['<all_urls>'],
        },
      ],
    };
  },
  zip: {
    sourcesTemplate: '{{name}}-{{version}}-firefox-sources.zip',
    // WXT excludes skipped entrypoint descriptors from source ZIPs by default.
    // Keep this one so the review build discovers and skips the same entrypoint,
    // preserving deterministic Rollup chunk order and hashes.
    includeSources: ['misc/approve.jpg', 'entrypoints/offscreen/index.html'],
    excludeSources: [
      'docs/**',
      'misc/**',
      'output/**',
      'FIREFOX_PUBLISH_PLAN.md',
      'CHANGELOG.md',
    ],
  },
});
