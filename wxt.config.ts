import {defineConfig} from 'wxt';
import vue from '@vitejs/plugin-vue';
import {resolve} from 'path';
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
        permissions: ['storage', 'contextMenus', 'offscreen'],
    },
});