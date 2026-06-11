#!/usr/bin/env node
// Tiny localhost-only write endpoint for the in-editor eval case editor.
// The static `serve` can't accept writes, and the File System Access picker
// is too fragile for a save loop, so the panel POSTs here instead.
//
//   node scripts/eval-save-server.mjs [port]
//
// POST /save  { name: "desk-can-brush-human-v1.json", content: "..." }
//   -> writes scripts/boxer-evals/<basename(name)> (basename only; no paths)
// GET  /health -> { ok: true }

import { appendFile, readFile, writeFile, rename } from 'node:fs/promises';
import http from 'node:http';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2]) || 48013;
const evalsDir = join(dirname(fileURLToPath(import.meta.url)), 'boxer-evals');

const respond = (res, status, body) => {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        respond(res, 204, {});
        return;
    }
    if (req.method === 'GET' && req.url === '/health') {
        respond(res, 200, { ok: true, evals_dir: evalsDir });
        return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/file?')) {
        try {
            const name = new URL(req.url, 'http://localhost').searchParams.get('name') ?? '';
            const safeName = basename(name);
            if (!/\.(json|jsonl)$/.test(safeName)) {
                respond(res, 400, { error: 'name must be a .json or .jsonl basename' });
                return;
            }
            const content = await readFile(join(evalsDir, safeName), 'utf8');
            respond(res, 200, { ok: true, name: safeName, content });
        } catch (err) {
            respond(res, 404, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
    }
    if (req.method === 'POST' && req.url === '/append') {
        let raw = '';
        req.on('data', (chunk) => {
            raw += chunk;
            if (raw.length > 64 * 1024 * 1024) req.destroy();
        });
        req.on('end', async () => {
            try {
                const { name, eval_case: evalCase } = JSON.parse(raw);
                const safeName = basename(String(name ?? 'live-brush-evals.jsonl'));
                if (!safeName.endsWith('.jsonl')) {
                    respond(res, 400, { error: 'append target must be a .jsonl basename' });
                    return;
                }
                if (!evalCase || typeof evalCase !== 'object') {
                    respond(res, 400, { error: 'eval_case must be an object' });
                    return;
                }
                const target = join(evalsDir, safeName);
                await appendFile(target, `${JSON.stringify(evalCase)}\n`);
                console.log(`[eval-save] appended case to ${target}`);
                respond(res, 200, { ok: true, file: target });
            } catch (err) {
                respond(res, 400, { error: err instanceof Error ? err.message : String(err) });
            }
        });
        return;
    }
    if (req.method === 'POST' && req.url === '/save') {
        let raw = '';
        req.on('data', (chunk) => {
            raw += chunk;
            if (raw.length > 64 * 1024 * 1024) req.destroy();
        });
        req.on('end', async () => {
            try {
                const { name, content } = JSON.parse(raw);
                const safeName = basename(String(name ?? ''));
                if (!safeName || !/\.(json|jsonl)$/.test(safeName)) {
                    respond(res, 400, { error: 'name must be a .json or .jsonl basename' });
                    return;
                }
                if (typeof content !== 'string' || content.length === 0) {
                    respond(res, 400, { error: 'content must be a non-empty string' });
                    return;
                }
                // sanity: must parse in the format the extension implies
                if (safeName.endsWith('.jsonl')) {
                    content.split('\n').filter(line => line.trim()).forEach(line => JSON.parse(line));
                } else {
                    JSON.parse(content);
                }
                const target = join(evalsDir, safeName);
                const tmp = `${target}.tmp-${process.pid}`;
                await writeFile(tmp, content);
                await rename(tmp, target);
                console.log(`[eval-save] wrote ${target} (${content.length} bytes)`);
                respond(res, 200, { ok: true, path: target });
            } catch (err) {
                respond(res, 400, { error: err instanceof Error ? err.message : String(err) });
            }
        });
        return;
    }
    respond(res, 404, { error: 'not found' });
});

server.listen(port, '127.0.0.1', () => {
    console.log(`[eval-save] listening on http://127.0.0.1:${port} -> ${evalsDir}`);
});
