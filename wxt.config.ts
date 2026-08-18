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
  vite: () => ({
    plugins: [vue()],
    define: {
      'process.env.VUE_APP_VERSION': JSON.stringify(packageJson.version),
    },
    build: {
      minify: isDebug ? false : undefined,
      sourcemap: isDebug ? 'inline' : undefined,
    },
  }),
  manifest: {
    name: '喵喵阅读',
    description: '一款 AI 驱动的开源浏览器翻译插件，带来母语般的双语阅读体验',
    permissions: ['storage', 'contextMenus', 'offscreen'],
    web_accessible_resources: [
      {
        resources: ['icon/*.png'],
        matches: ['<all_urls>'],
      },
    ],
  },
});
