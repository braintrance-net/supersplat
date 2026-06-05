import http from 'node:http';

const DEFAULT_PORT = 47824;
const DEFAULT_TARGET = 'https://sam3.4dream.app';
const DEFAULT_TIMEOUT_MS = 15000;

const port = Number.parseInt(process.env.SAM3_PROXY_PORT || String(DEFAULT_PORT), 10);
const target = new URL(process.env.SAM3_PROXY_TARGET || DEFAULT_TARGET);
const timeoutMs = Number.parseInt(process.env.SAM3_PROXY_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);

const pathAliases = new Map([
    ['/api/sam3d/upload', '/upload'],
    ['/api/sam3d/segment-point', '/segment_point']
]);

const allowedPaths = new Set([
    '/api/sam3/refine',
    '/api/sam3/segment',
    '/api/sam3/segment-text',
    '/upload',
    '/segment_point',
    ...pathAliases.keys()
]);

const isLocalOrigin = (origin) => {
    if (!origin) {
        return false;
    }

    try {
        const url = new URL(origin);
        return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    } catch {
        return false;
    }
};

const corsHeaders = (request) => {
    const origin = request.headers.origin;
    const allowLocalOrigin = isLocalOrigin(origin);
    return {
        'Access-Control-Allow-Origin': allowLocalOrigin ? origin : '*',
        ...(allowLocalOrigin ? { 'Access-Control-Allow-Credentials': 'true' } : {}),
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': request.headers['access-control-request-headers'] || 'Content-Type',
        'Access-Control-Max-Age': '86400'
    };
};

const sendJson = (response, status, body, headers = {}) => {
    response.writeHead(status, {
        'Content-Type': 'application/json',
        ...headers
    });
    response.end(JSON.stringify(body));
};

const readBody = (request) => {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks)));
        request.on('error', reject);
    });
};

const buildUpstreamHeaders = (request) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined) {
            continue;
        }

        const lower = name.toLowerCase();
        if (lower === 'host' || lower === 'origin' || lower === 'referer' || lower === 'content-length') {
            continue;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                headers.append(name, item);
            }
        } else {
            headers.set(name, value);
        }
    }
    return headers;
};

const server = http.createServer(async (request, response) => {
    const headers = corsHeaders(request);

    if (request.method === 'OPTIONS') {
        response.writeHead(204, headers);
        response.end();
        return;
    }

    const incomingUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (incomingUrl.pathname === '/healthz') {
        sendJson(response, 200, { ok: true, target: target.origin }, headers);
        return;
    }

    if (request.method !== 'POST' || !allowedPaths.has(incomingUrl.pathname)) {
        sendJson(response, 404, { ok: false, error: 'Unknown SAM3 dev proxy route.' }, headers);
        return;
    }

    const upstreamPath = pathAliases.get(incomingUrl.pathname) || incomingUrl.pathname;
    const upstreamUrl = new URL(upstreamPath + incomingUrl.search, target);
    let timeout;

    try {
        const started = Date.now();
        const body = await readBody(request);
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS);
        console.log(`${request.method} ${incomingUrl.pathname} -> ${upstreamUrl.href}`);
        const upstreamResponse = await fetch(upstreamUrl, {
            method: request.method,
            headers: buildUpstreamHeaders(request),
            body,
            signal: controller.signal
        });
        const upstreamBody = Buffer.from(await upstreamResponse.arrayBuffer());
        console.log(`${upstreamResponse.status} ${incomingUrl.pathname} ${Date.now() - started}ms`);

        response.writeHead(upstreamResponse.status, {
            ...headers,
            'Content-Type': upstreamResponse.headers.get('content-type') || 'application/octet-stream',
            'Cache-Control': 'no-store'
        });
        response.end(upstreamBody);
    } catch (error) {
        console.warn(`${request.method} ${incomingUrl.pathname} failed`, error instanceof Error ? error.message : error);
        sendJson(response, 502, {
            ok: false,
            error: error instanceof Error ? error.message : 'SAM3 dev proxy request failed.'
        }, headers);
    } finally {
        clearTimeout(timeout);
    }
});

server.listen(port, () => {
    console.log(`SAM3 dev proxy listening on http://localhost:${port}`);
    console.log(`Forwarding SAM3 requests to ${target.origin}`);
    console.log(`SAM3 upstream timeout ${Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS}ms`);
});
