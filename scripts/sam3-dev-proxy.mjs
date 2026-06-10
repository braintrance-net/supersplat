import http from 'node:http';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 47824;
const DEFAULT_TARGET = 'https://sam3.4dream.app';
const DEFAULT_TIMEOUT_MS = 15000;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultEvalOut = path.join(repoRoot, 'scripts', 'boxer-evals', 'live-brush-evals.jsonl');

const port = Number.parseInt(process.env.SAM3_PROXY_PORT || String(DEFAULT_PORT), 10);
const target = new URL(process.env.SAM3_PROXY_TARGET || DEFAULT_TARGET);
const timeoutMs = Number.parseInt(process.env.SAM3_PROXY_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);
const evalOut = path.resolve(process.env.BOXER_EVAL_OUT || defaultEvalOut);
const diagnosticSampleBytes = Number.parseInt(process.env.SAM3_PROXY_DIAGNOSTIC_SAMPLE_BYTES || '300', 10);
let requestSequence = 0;

const pathAliases = new Map([
    ['/api/sam3d/upload', '/upload'],
    ['/api/sam3d/segment-point', '/segment_point'],
    ['/api/sam3d/segment-points', '/segment_points'],
    ['/api/sam3d/segment-frame', '/segment_frame']
]);

const allowedPaths = new Set([
    '/api/sam3/refine',
    '/api/sam3/segment',
    '/api/sam3/segment-text',
    '/api/boxer-evals/append',
    '/upload',
    '/segment_frame',
    '/segment_point',
    '/segment_points',
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

const safeJsonParse = (body) => {
    try {
        return JSON.parse(body.toString('utf8'));
    } catch {
        return null;
    }
};

const summarizeJsonValue = (value) => {
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value === 'string') {
        return value.length > 120 ? `[string:${value.length}]` : value;
    }
    if (Array.isArray(value)) {
        return value.length > 8 ? { length: value.length, sample: value.slice(0, 3).map(summarizeJsonValue) } : value.map(summarizeJsonValue);
    }
    if (typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (/^(?:image|mask|mask_image|data)$/i.test(key)) {
                out[key] = typeof item === 'string' ? `[base64:${item.length}]` : `[${typeof item}]`;
            } else {
                out[key] = summarizeJsonValue(item);
            }
        }
        return out;
    }
    return value;
};

const summarizeRequest = (request, body) => {
    const contentType = request.headers['content-type'] || '';
    const summary = {
        content_type: contentType,
        content_length: request.headers['content-length'] ? Number(request.headers['content-length']) : body.length
    };
    if (String(contentType).includes('application/json')) {
        const parsed = safeJsonParse(body);
        if (parsed) {
            summary.json = summarizeJsonValue(parsed);
        }
    } else if (String(contentType).includes('multipart/form-data')) {
        summary.body = `[multipart:${body.length}]`;
    } else if (body.length > 0 && Number.isFinite(diagnosticSampleBytes) && diagnosticSampleBytes > 0) {
        summary.body_prefix = body.subarray(0, diagnosticSampleBytes).toString('utf8');
    }
    return summary;
};

const summarizeResponse = (headers, body) => {
    const contentType = headers.get('content-type') || '';
    const summary = {
        content_type: contentType,
        content_length: body.length
    };
    if (contentType.includes('application/json')) {
        const parsed = safeJsonParse(body);
        if (parsed && typeof parsed === 'object') {
            summary.json = summarizeJsonValue(parsed);
            summary.contract = {
                has_mask: typeof parsed.mask === 'string' || Array.isArray(parsed.masks),
                width: parsed.width,
                height: parsed.height,
                supports_prompt_refinement: parsed.supportsPromptRefinement
            };
        }
    } else if (body.length > 0 && Number.isFinite(diagnosticSampleBytes) && diagnosticSampleBytes > 0) {
        summary.body_prefix = body.subarray(0, diagnosticSampleBytes).toString('utf8');
    }
    return summary;
};

const readBody = (request) => {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks)));
        request.on('error', reject);
    });
};

const extractEvalCase = (parsed) => {
    if (!parsed || typeof parsed !== 'object') {
        return null;
    }
    return parsed.eval_case || parsed.case || parsed;
};

const handleEvalAppend = async (request, response, headers, requestId) => {
    if (!isLocalOrigin(request.headers.origin) && request.headers.host && !/^localhost:|^127\.0\.0\.1:/.test(request.headers.host)) {
        sendJson(response, 403, {
            ok: false,
            error: 'Local eval append only accepts localhost callers.'
        }, { ...headers, 'X-SAM3-Proxy-Request-Id': requestId });
        return;
    }

    const body = await readBody(request);
    const parsed = safeJsonParse(body);
    const evalCase = extractEvalCase(parsed);
    if (!evalCase || evalCase.schema !== 'boxer-eval-case/v1') {
        sendJson(response, 400, {
            ok: false,
            error: 'Expected boxer-eval-case/v1 JSON.'
        }, { ...headers, 'X-SAM3-Proxy-Request-Id': requestId });
        return;
    }
    if (evalCase.prompt?.type !== 'client_brush') {
        sendJson(response, 400, {
            ok: false,
            error: 'Expected a client_brush eval case.'
        }, { ...headers, 'X-SAM3-Proxy-Request-Id': requestId });
        return;
    }

    await mkdir(path.dirname(evalOut), { recursive: true });
    await appendFile(evalOut, `${JSON.stringify(evalCase)}\n`, 'utf8');
    sendJson(response, 200, {
        ok: true,
        file: path.relative(repoRoot, evalOut),
        path: evalOut,
        captured_at: evalCase.captured_at ?? null
    }, { ...headers, 'X-SAM3-Proxy-Request-Id': requestId });
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
    const requestId = `sam3-${Date.now().toString(36)}-${++requestSequence}`;

    if (request.method === 'OPTIONS') {
        response.writeHead(204, headers);
        response.end();
        return;
    }

    const incomingUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (incomingUrl.pathname === '/healthz') {
        sendJson(response, 200, {
            ok: true,
            target: target.origin,
            timeout_ms: Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS,
            allowed_paths: Array.from(allowedPaths).sort(),
            aliases: Object.fromEntries(pathAliases.entries()),
            boxer_eval_append: {
                endpoint: '/api/boxer-evals/append',
                file: evalOut,
                format: 'jsonl'
            },
            proof_gate_contract: {
                preferred_endpoint: '/api/sam3/refine',
                required_response: {
                    mask: 'base64 png mask without data URL prefix',
                    width: 'mask pixel width',
                    height: 'mask pixel height',
                    supportsPromptRefinement: 'true when more than one prompt point was applied'
                }
            }
        }, { ...headers, 'X-SAM3-Proxy-Request-Id': requestId });
        return;
    }

    if (incomingUrl.pathname === '/api/boxer-evals/append') {
        if (request.method !== 'POST') {
            sendJson(response, 405, {
                ok: false,
                error: 'Use POST for Boxer eval append.'
            }, { ...headers, 'X-SAM3-Proxy-Request-Id': requestId });
            return;
        }

        try {
            await handleEvalAppend(request, response, headers, requestId);
        } catch (error) {
            console.warn(JSON.stringify({
                event: 'boxer_eval_append_error',
                request_id: requestId,
                error: error instanceof Error ? error.message : String(error)
            }));
            sendJson(response, 500, {
                ok: false,
                error: error instanceof Error ? error.message : 'Boxer eval append failed.'
            }, { ...headers, 'X-SAM3-Proxy-Request-Id': requestId });
        }
        return;
    }

    if (request.method !== 'POST' || !allowedPaths.has(incomingUrl.pathname)) {
        sendJson(response, 404, {
            ok: false,
            error: 'Unknown SAM3 dev proxy route.',
            allowed_paths: Array.from(allowedPaths).sort()
        }, { ...headers, 'X-SAM3-Proxy-Request-Id': requestId });
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
        console.log(JSON.stringify({
            event: 'sam3_proxy_request',
            request_id: requestId,
            method: request.method,
            path: incomingUrl.pathname,
            upstream_url: upstreamUrl.href,
            timeout_ms: Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS,
            request: summarizeRequest(request, body)
        }));
        const upstreamResponse = await fetch(upstreamUrl, {
            method: request.method,
            headers: buildUpstreamHeaders(request),
            body,
            signal: controller.signal
        });
        const upstreamBody = Buffer.from(await upstreamResponse.arrayBuffer());
        console.log(JSON.stringify({
            event: 'sam3_proxy_response',
            request_id: requestId,
            path: incomingUrl.pathname,
            upstream_path: upstreamPath,
            status: upstreamResponse.status,
            ok: upstreamResponse.ok,
            duration_ms: Date.now() - started,
            response: summarizeResponse(upstreamResponse.headers, upstreamBody)
        }));

        response.writeHead(upstreamResponse.status, {
            ...headers,
            'Content-Type': upstreamResponse.headers.get('content-type') || 'application/octet-stream',
            'Cache-Control': 'no-store',
            'X-SAM3-Proxy-Request-Id': requestId
        });
        response.end(upstreamBody);
    } catch (error) {
        const isTimeout = error?.name === 'AbortError';
        console.warn(JSON.stringify({
            event: 'sam3_proxy_error',
            request_id: requestId,
            path: incomingUrl.pathname,
            status: isTimeout ? 504 : 502,
            error: error instanceof Error ? error.message : String(error)
        }));
        sendJson(response, isTimeout ? 504 : 502, {
            ok: false,
            request_id: requestId,
            error: isTimeout ? 'SAM3 upstream request timed out.' : (error instanceof Error ? error.message : 'SAM3 dev proxy request failed.')
        }, { ...headers, 'X-SAM3-Proxy-Request-Id': requestId });
    } finally {
        clearTimeout(timeout);
    }
});

server.listen(port, () => {
    console.log(`SAM3 dev proxy listening on http://localhost:${port}`);
    console.log(`Forwarding SAM3 requests to ${target.origin}`);
    console.log(`SAM3 upstream timeout ${Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS}ms`);
});
