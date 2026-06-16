#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const args = {
    url: 'http://127.0.0.1:48012/',
    file: 'scripts/boxer-evals/live-brush-evals.jsonl',
    caseIndex: 0,
    outDir: '/tmp/da3-proof-frame'
};
for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--url') args.url = process.argv[++i];
    else if (process.argv[i] === '--file') args.file = process.argv[++i];
    else if (process.argv[i] === '--case-index') args.caseIndex = Number(process.argv[++i]);
    else if (process.argv[i] === '--out-dir') args.outDir = process.argv[++i];
}

const loadCases = (file) => {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('.jsonl')) return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
    return JSON.parse(text);
};

const tryLoadPlaywright = () => {
    for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright', '/tmp/boxer-playwright/node_modules/playwright'].filter(Boolean)) {
        try {
            return require(candidate);
        } catch {
            // Try next candidate.
        }
    }
    throw new Error('Could not load Playwright. Set PLAYWRIGHT_MODULE or npm install playwright.');
};

const evalCases = loadCases(args.file);
const evalCase = evalCases[args.caseIndex];
if (!evalCase) throw new Error(`No case ${args.caseIndex} in ${args.file}`);

const replayUrl = new URL(args.url);
replayUrl.searchParams.set('da3_export', Date.now().toString());

const { chromium } = tryLoadPlaywright();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: evalCase.frame?.image_width ?? 1600, height: evalCase.frame?.image_height ?? 900 } });
try {
    await page.addInitScript(() => {
        window.__boxerExportFullFrame = true;
    });
    await page.goto(replayUrl.href, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.evaluate(() => {
        window.__boxerExportFullFrame = true;
    });
    await page.waitForFunction(() => !!window.supersplatDebug?.runBoxerEvalCase, null, { timeout: 90000 });
    await page.waitForFunction(() => {
        const splats = window.supersplatDebug?.scene?.splats?.();
        return Array.isArray(splats) && splats.length > 0;
    }, null, { timeout: 90000 }).catch(() => {});
    const result = await page.evaluate(async (input) => {
        const replay = await window.supersplatDebug.runBoxerEvalCase(input);
        return { replay, frame: window.__lastBoxerFrameRaw ?? null };
    }, evalCase);
    if (!result.frame?.image) throw new Error('Replay did not expose __lastBoxerFrameRaw.image');
    await mkdir(args.outDir, { recursive: true });
    await writeFile(path.join(args.outDir, 'frame.png'), Buffer.from(result.frame.image, 'base64'));
    await writeFile(path.join(args.outDir, 'depth.float32.b64'), result.frame.depth);
    await writeFile(path.join(args.outDir, 'metadata.json'), JSON.stringify({
        source_file: args.file,
        case_index: args.caseIndex,
        metrics: result.replay.metrics ?? null,
        frame: {
            intrinsics: result.frame.intrinsics,
            extrinsics: result.frame.extrinsics,
            image_width: result.frame.image_width,
            image_height: result.frame.image_height,
            depth_width: result.frame.depth_width,
            depth_height: result.frame.depth_height,
            depth_valid_ratio: result.frame.depth_valid_ratio,
            depth_min: result.frame.depth_min,
            depth_max: result.frame.depth_max,
            depth_source: result.frame.depth_source
        },
        prompt: evalCase.prompt,
        target: evalCase.target ?? null
    }, null, 2));
    console.log(`Exported DA3 proof frame to ${args.outDir}`);
} finally {
    await browser.close();
}
