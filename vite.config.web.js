// @ts-nocheck
const Path = require('path');
const vuePlugin = require('@vitejs/plugin-vue')
const { version } = require('./package.json');

const { defineConfig } = require('vite');

const config = defineConfig({
    root: Path.join(__dirname, 'src', 'renderer'),
    publicDir: 'public',
    server: {
        port: 8080,
    },
    open: false,
    build: {
        outDir: Path.join(__dirname, 'build', 'web'),
        emptyOutDir: true,
    },
    plugins: [vuePlugin()],
    define: {
        '__PLATFORM__': JSON.stringify('web'),
        '__APP_PLATFORM__': JSON.stringify('web'),
        '__APP_VERSION__': JSON.stringify(version)
    },
    resolve: {
        alias: {
            '@renderer': Path.resolve(__dirname, 'src/renderer'),
            '@shared': Path.resolve(__dirname, 'src/shared'),
            '@main': Path.resolve(__dirname, 'src/main'),
            '@root': Path.resolve(__dirname, 'src'),
            '@': Path.resolve(__dirname, 'src/renderer'),
            '~': Path.resolve(__dirname, 'src/renderer'),
        }
    }
});

module.exports = config;

