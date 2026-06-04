import path from 'path';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

import alias from '@rollup/plugin-alias';
import image from '@rollup/plugin-image';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import strip from '@rollup/plugin-strip';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import autoprefixer from 'autoprefixer';
import postcss from 'postcss';
import scss from 'rollup-plugin-scss';
import sass from 'sass';

import copyAndWatch from './copy-and-watch.mjs';

// prod is release build
if (process.env.BUILD_TYPE === 'prod') {
    process.env.BUILD_TYPE = 'release';
}
// debug, profile, release
const BUILD_TYPE = process.env.BUILD_TYPE || 'release';
const ENGINE_DIR = path.resolve(`node_modules/playcanvas/build/playcanvas${BUILD_TYPE === 'debug' ? '.dbg' : ''}/src/index.js`);
const PCUI_DIR = path.resolve('node_modules/@playcanvas/pcui');
const HREF = process.env.BASE_HREF || '';

const parseVec3 = (value) => {
    if (!value) {
        return undefined;
    }

    const numbers = value.split(',').map(v => parseFloat(v.trim()));
    if (numbers.length !== 3 || numbers.some(v => !Number.isFinite(v))) {
        return undefined;
    }

    return {
        x: numbers[0],
        y: numbers[1],
        z: numbers[2]
    };
};

const parseNumber = (value) => {
    if (value === undefined) {
        return undefined;
    }

    const result = parseFloat(value);
    return Number.isFinite(result) ? result : undefined;
};

const defaultCameraPosition = parseVec3(process.env.DEFAULT_CAMERA_POSITION);
const defaultCameraTarget = parseVec3(process.env.DEFAULT_CAMERA_TARGET);
const defaultCamera = defaultCameraPosition && defaultCameraTarget ? {
    position: defaultCameraPosition,
    target: defaultCameraTarget,
    fov: parseNumber(process.env.DEFAULT_CAMERA_FOV),
    ortho: process.env.DEFAULT_CAMERA_ORTHO === undefined ? undefined : process.env.DEFAULT_CAMERA_ORTHO === 'true'
} : undefined;
const exposeClientApiKeys = process.env.EXPOSE_CLIENT_API_KEYS === 'true';

const SUPERSPLAT_CONFIG = JSON.stringify({
    defaultLoadUrl: process.env.DEFAULT_SPLAT_URL || '',
    defaultCamera,
    boxerBackendUrl: process.env.BOXER_BACKEND_URL || '',
    sam3BackendUrl: process.env.SAM3_BACKEND_URL || '',
    sketchfabProxyBaseUrl: process.env.SKETCHFAB_PROXY_BASE_URL || '',
    openAiProxyBaseUrl: process.env.OPENAI_PROXY_BASE_URL || '',
    enableDevTools: process.env.DEV_TOOLS === 'true',
    sketchfabApiToken: exposeClientApiKeys ? process.env.SKETCHFAB_API_TOKEN || '' : '',
    openaiApiKey: exposeClientApiKeys ? process.env.OPENAI_API_KEY || '' : ''
}).replace(/</g, '\\u003c');

const outputHeader = () => {
    const BLUE_OUT = '\x1b[34m';
    const BOLD_OUT = '\x1b[1m';
    const REGULAR_OUT = '\x1b[22m';
    const RESET_OUT = '\x1b[0m';

    const title = [
        'Building SuperSplat',
        `type ${BOLD_OUT}${BUILD_TYPE}${REGULAR_OUT}`
    ].map(l => `${BLUE_OUT}${l}`).join('\n');
    console.log(`${BLUE_OUT}${title}${RESET_OUT}\n`);
};

outputHeader();

const application = {
    input: 'src/index.ts',
    output: {
        dir: 'dist',
        format: 'esm',
        sourcemap: true
    },
    plugins: [
        copyAndWatch({
            targets: [
                {
                    src: 'src/index.html',
                    transform: (contents, filename) => {
                        return contents.toString()
                        .replace('__BASE_HREF__', HREF)
                        .replace('__SUPERSPLAT_CONFIG__', SUPERSPLAT_CONFIG);
                    }
                },
                { src: 'src/manifest.json' },
                { src: 'static/images', dest: 'static' },
                { src: 'static/icons', dest: 'static' },
                { src: 'static/lib', dest: 'static' },
                { src: 'static/locales', dest: 'static' },
                { src: 'static/dev-assets', dest: 'static' },
                { src: 'static/env/VertebraeHDRI_v1_512.png', dest: 'static/env' }
            ]
        }),
        alias({
            entries: {
                'playcanvas': ENGINE_DIR,
                '@playcanvas/pcui': PCUI_DIR
            }
        }),
        typescript({
            tsconfig: './tsconfig.json'
        }),
        resolve(),
        image({ dom: false }),
        json(),
        scss({
            sourceMap: true,
            runtime: sass,
            processor: (css) => {
                return postcss([autoprefixer])
                .process(css, { from: undefined })
                .then(result => result.css);
            },
            fileName: 'index.css',
            includePaths: [`${PCUI_DIR}/dist`],
            watch: 'src/ui/scss'
        }),
        BUILD_TYPE === 'release' &&
        strip({
            include: ['**/*.ts'],
            functions: ['Debug.exec']
        }),
        BUILD_TYPE !== 'debug' && terser()
    ],
    treeshake: 'smallest',
    cache: false
};

export default [
    application
];
