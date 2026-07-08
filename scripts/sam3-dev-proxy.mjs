import { appendFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from 'canvas';

const DEFAULT_PORT = 47825;
const DEFAULT_TARGET = 'http://ec2-3-19-208-185.us-east-2.compute.amazonaws.com:8000';
const DEFAULT_TIMEOUT_MS = 180000;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultEvalOut = path.join(repoRoot, 'scripts', 'boxer-evals', 'live-brush-evals.jsonl');

const port = Number.parseInt(process.env.SAM3_PROXY_PORT || String(DEFAULT_PORT), 10);
const target = new URL(process.env.SAM3_PROXY_TARGET || DEFAULT_TARGET);
const timeoutMs = Number.parseInt(process.env.SAM3_PROXY_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);
const evalOut = path.resolve(process.env.BOXER_EVAL_OUT || defaultEvalOut);
const diagnosticSampleBytes = Number.parseInt(process.env.SAM3_PROXY_DIAGNOSTIC_SAMPLE_BYTES || '300', 10);
let requestSequence = 0;

const defaultTimeoutMs = () => Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS;

const clampTimeoutMs = value => Math.max(1000, Math.min(defaultTimeoutMs(), Math.round(value)));

const requestTimeoutMs = (request, incomingUrl) => {
    const header = request.headers['x-sam3-timeout-ms'];
    const raw = Array.isArray(header) ? header[0] : header;
    const query = incomingUrl?.searchParams?.get('timeout_ms') ??
        incomingUrl?.searchParams?.get('sam3_timeout_ms');
    const parsed = Number(raw ?? query);
    return Number.isFinite(parsed) ? clampTimeoutMs(parsed) : defaultTimeoutMs();
};

const firstHeaderValue = (request, name) => {
    const value = request.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
};

const isTruthyToggle = (value) => {
    if (value === undefined || value === null) {
        return false;
    }

    const normalized = String(value).trim().toLowerCase();
    return normalized !== '' &&
        normalized !== '0' &&
        normalized !== 'false' &&
        normalized !== 'off' &&
        normalized !== 'none';
};

const requestedMaskEncoding = (request, incomingUrl) => {
    return firstHeaderValue(request, 'x-sam3-mask-encoding') ??
        incomingUrl?.searchParams?.get('mask_encoding') ??
        incomingUrl?.searchParams?.get('sam3_mask_encoding') ??
        incomingUrl?.searchParams?.get('artisanSam31MaskEncoding');
};

const shouldSendCompactRleMask = (request, incomingUrl) => {
    const encoding = String(requestedMaskEncoding(request, incomingUrl) ?? '').trim().toLowerCase();
    const compact = firstHeaderValue(request, 'x-sam3-compact-mask') ??
        incomingUrl?.searchParams?.get('compact_mask') ??
        incomingUrl?.searchParams?.get('sam3_compact_mask') ??
        incomingUrl?.searchParams?.get('artisanSam31CompactMask');
    return encoding === 'compact' ||
        encoding === 'rle-compact' ||
        isTruthyToggle(compact);
};

const pathAliases = new Map([
    ['/api/sam3d/upload', '/upload'],
    ['/api/sam3d/segment-point', '/segment_point'],
    ['/api/sam3d/segment-points', '/segment_points'],
    ['/api/sam3d/segment-frame', '/segment_frame']
]);

const allowedPaths = new Set([
    '/api/artisangs/track',
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

const makeJsonResponse = (status, body) => {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
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
            if (/^(?:image|mask|mask_image|raw_mask|rle_mask|data)$/i.test(key)) {
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

const parseBase64Image = (value) => {
    const match = String(value).match(/^data:(image\/(?:png|jpeg));base64,(.+)$/);
    const mimeType = match?.[1] === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const payload = match?.[2] ?? String(value);
    return {
        buffer: Buffer.from(payload.replace(/\s/g, ''), 'base64'),
        mimeType
    };
};

const readPngSize = (data) => {
    if (data.length < 24 || data[0] !== 0x89 || data.toString('ascii', 1, 4) !== 'PNG') {
        return null;
    }

    return {
        width: data.readUInt32BE(16),
        height: data.readUInt32BE(20)
    };
};

const readJpegSize = (data) => {
    if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
        return null;
    }

    const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;

    while (offset + 3 < data.length) {
        if (data[offset] !== 0xff) {
            offset += 1;
            continue;
        }

        const marker = data[offset + 1];
        offset += 2;
        if (marker === undefined) return null;
        if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (offset + 2 > data.length) return null;

        const length = data.readUInt16BE(offset);
        if (length < 2 || offset + length > data.length) return null;

        if (sofMarkers.has(marker)) {
            if (offset + 7 > data.length) return null;
            return {
                height: data.readUInt16BE(offset + 3),
                width: data.readUInt16BE(offset + 5)
            };
        }

        offset += length;
    }

    return null;
};

const readImageSize = data => readPngSize(data) ?? readJpegSize(data);

const normalizeMaskImage = (image) => {
    const value = String(image || '');
    const commaIndex = value.indexOf(',');
    return value.startsWith('data:') && commaIndex >= 0 ? value.slice(commaIndex + 1) : value;
};

const decodeBinaryMaskImage = async (image, width, height) => {
    const started = Date.now();
    const buffer = Buffer.from(normalizeMaskImage(image).replace(/\s/g, ''), 'base64');
    const source = await loadImage(buffer);
    const resolvedWidth = Number.isInteger(width) && width > 0 ? width : source.width;
    const resolvedHeight = Number.isInteger(height) && height > 0 ? height : source.height;
    const canvas = createCanvas(resolvedWidth, resolvedHeight);
    const context = canvas.getContext('2d');
    context.drawImage(source, 0, 0, resolvedWidth, resolvedHeight);
    const pixels = context.getImageData(0, 0, resolvedWidth, resolvedHeight).data;
    const mask = Buffer.alloc(resolvedWidth * resolvedHeight);
    for (let i = 0, j = 0; i < pixels.length; i += 4, j++) {
        const alpha = pixels[i + 3];
        const luminance = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
        const value = alpha < 255 ? alpha : luminance;
        if (value > 0) {
            mask[j] = 255;
        }
    }
    return {
        mask,
        width: resolvedWidth,
        height: resolvedHeight,
        elapsedMs: Date.now() - started
    };
};

const encodeRleMask = (mask) => {
    const started = Date.now();
    const runs = [];
    for (let i = 0; i < mask.length; i++) {
        if (mask[i] === 0) {
            continue;
        }
        const start = i;
        i += 1;
        while (i < mask.length && mask[i] > 0) {
            i += 1;
        }
        runs.push([start, i - start]);
        i -= 1;
    }

    const bytes = Buffer.alloc(runs.length * 8);
    for (let i = 0; i < runs.length; i++) {
        const offset = i * 8;
        bytes.writeUInt32LE(runs[i][0], offset);
        bytes.writeUInt32LE(runs[i][1], offset + 4);
    }

    return {
        rle_mask: bytes.toString('base64'),
        rle_encoding: 'uint32-runs-v1',
        rle_run_count: runs.length,
        elapsedMs: Date.now() - started
    };
};

const addMaskEncoding = async (data) => {
    const image = data?.mask ?? data?.mask_image;
    if (!data || typeof data !== 'object' || typeof image !== 'string' || data.rle_mask) {
        return data;
    }

    try {
        const decoded = await decodeBinaryMaskImage(image, data.width, data.height);
        const encoded = encodeRleMask(decoded.mask);
        return {
            ...data,
            width: Number.isInteger(data.width) && data.width > 0 ? data.width : decoded.width,
            height: Number.isInteger(data.height) && data.height > 0 ? data.height : decoded.height,
            rle_mask: encoded.rle_mask,
            rle_encoding: encoded.rle_encoding,
            rle_run_count: encoded.rle_run_count,
            timings: {
                ...(data.timings ?? {}),
                proxy_mask_decode_ms: decoded.elapsedMs,
                proxy_mask_rle_encode_ms: encoded.elapsedMs
            }
        };
    } catch (error) {
        console.warn(JSON.stringify({
            event: 'sam3_proxy_mask_encode_failed',
            error: error instanceof Error ? error.message : String(error)
        }));
        return data;
    }
};

const stripMaskImages = (value) => {
    if (!value || typeof value !== 'object') {
        return value;
    }

    const out = { ...value };
    delete out.mask;
    delete out.mask_image;
    delete out.raw_mask;
    return out;
};

const compactRleMaskResponse = (data) => {
    if (!data || typeof data !== 'object' || typeof data.rle_mask !== 'string') {
        return data;
    }

    const compact = stripMaskImages(data);
    compact.masks = Array.isArray(data.masks) ?
        data.masks.map((mask, index) => index === 0 ? {
            ...stripMaskImages(mask),
            width: mask.width ?? data.width,
            height: mask.height ?? data.height,
            rle_mask: data.rle_mask,
            rle_encoding: data.rle_encoding,
            rle_run_count: data.rle_run_count
        } : stripMaskImages(mask)) :
        data.masks;
    compact.timings = {
        ...(data.timings ?? {}),
        proxy_compact_rle_mask: true
    };
    return compact;
};

const normalizedToPixel = ([x, y], imageSize) => [
    Math.round(x * Math.max(0, imageSize.width - 1)),
    Math.round(y * Math.max(0, imageSize.height - 1))
];

const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);

const isPromptLabel = value => value === 0 || value === 1;

const isPoint = value => (
    Array.isArray(value) &&
    value.length === 2 &&
    isFiniteNumber(value[0]) &&
    isFiniteNumber(value[1]) &&
    value[0] >= 0 &&
    value[1] >= 0
);

const isImageSize = value => (
    value &&
    Number.isInteger(value.width) &&
    Number.isInteger(value.height) &&
    value.width > 0 &&
    value.height > 0
);

const readUpstreamBody = async (upstreamResponse) => {
    const contentType = upstreamResponse.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        return await upstreamResponse.json().catch(() => null);
    }
    return await upstreamResponse.text().catch(() => null);
};

const upstreamErrorMessage = (body, fallback) => {
    if (typeof body === 'string' && body.trim().length > 0) {
        return body;
    }
    if (body && typeof body === 'object') {
        for (const key of ['detail', 'error', 'message']) {
            const value = body[key];
            if (typeof value === 'string' && value.trim().length > 0) {
                return value;
            }
        }
    }
    return fallback;
};

const jsonErrorResponse = (body, status, fallback) => makeJsonResponse(status, {
    ok: false,
    error: upstreamErrorMessage(body, fallback)
});

const fetchSam3Upstream = async (upstreamPath, options, upstreamTimeoutMs = defaultTimeoutMs()) => {
    const upstreamUrl = new URL(upstreamPath, target);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), upstreamTimeoutMs);

    try {
        return await fetch(upstreamUrl, {
            ...options,
            signal: controller.signal
        });
    } finally {
        clearTimeout(timeout);
    }
};

const buildSam3AdapterUpstreamHeaders = (request) => {
    const headers = buildJsonUpstreamHeaders();
    for (const name of [
        'x-sam3-mask-encoding',
        'x-sam3-compact-mask',
        'x-sam3-timeout-ms'
    ]) {
        const value = firstHeaderValue(request, name);
        if (value !== undefined) {
            headers.set(name, value);
        }
    }
    return headers;
};

const proxyJsonEndpoint = async (upstreamPath, body, upstreamTimeoutMs, upstreamHeaders = buildJsonUpstreamHeaders()) => {
    const upstreamResponse = await fetchSam3Upstream(upstreamPath, {
        method: 'POST',
        headers: upstreamHeaders,
        body
    }, upstreamTimeoutMs);
    const raw = await readUpstreamBody(upstreamResponse);
    if (!upstreamResponse.ok) {
        return {
            ok: false,
            response: jsonErrorResponse(raw, upstreamResponse.status || 502, `SAM3 ${upstreamPath} failed.`)
        };
    }
    if (!raw || typeof raw !== 'object') {
        return {
            ok: false,
            response: makeJsonResponse(502, { ok: false, error: `SAM3 ${upstreamPath} returned an unexpected response.` })
        };
    }

    return { ok: true, data: raw };
};

const bestMask = (masks) => {
    if (!Array.isArray(masks) || masks.length === 0) {
        return null;
    }

    return masks.reduce((best, current) => {
        const bestConfidence = Number.isFinite(best?.confidence) ? best.confidence : -Infinity;
        const currentConfidence = Number.isFinite(current?.confidence) ? current.confidence : -Infinity;
        return currentConfidence > bestConfidence ? current : best;
    }, masks[0]);
};

const uploadImage = async (image, upstreamTimeoutMs) => {
    const extension = image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const bytes = new Uint8Array(image.buffer);
    const uploadBody = new FormData();
    uploadBody.append('image', new Blob([bytes], { type: image.mimeType }), `supersplat-sam3-view.${extension}`);

    const uploadResponse = await fetchSam3Upstream('/upload', {
        method: 'POST',
        body: uploadBody
    }, upstreamTimeoutMs);
    const uploadRaw = await readUpstreamBody(uploadResponse);

    if (!uploadResponse.ok) {
        return { ok: false, response: jsonErrorResponse(uploadRaw, uploadResponse.status || 502, 'SAM3 upload failed.') };
    }

    if (!uploadRaw || typeof uploadRaw !== 'object' || typeof uploadRaw.job_id !== 'string' || uploadRaw.job_id.length === 0) {
        return { ok: false, response: makeJsonResponse(502, { ok: false, error: 'SAM3 returned an unexpected upload response.' }) };
    }

    return { ok: true, jobId: uploadRaw.job_id };
};

const segmentSam3Prompts = async ({
    image,
    imageSize,
    jobId,
    points,
    coordinateSpace,
    upstreamTimeoutMs,
    forceMultiPointEndpoint = false
}) => {
    const firstPoint = points[0];
    if (!firstPoint) {
        return { ok: false, response: makeJsonResponse(400, { ok: false, error: 'At least one SAM point is required.' }) };
    }

    const parsedImage = image ? parseBase64Image(image) : null;
    const resolvedImageSize = parsedImage ? readImageSize(parsedImage.buffer) : (imageSize ?? null);
    const useMultiPointEndpoint = forceMultiPointEndpoint || points.length > 1;

    if (parsedImage && !resolvedImageSize) {
        return { ok: false, response: makeJsonResponse(400, { ok: false, error: 'A PNG or JPEG image, or explicit image_size, is required.' }) };
    }

    let resolvedJobId = jobId;
    let releaseAfterResponse = false;
    if (!resolvedJobId) {
        if (!parsedImage) {
            return { ok: false, response: makeJsonResponse(400, { ok: false, error: 'A SAM job_id/session_id or image is required.' }) };
        }

        const upload = await uploadImage(parsedImage, upstreamTimeoutMs);
        if (!upload.ok) return upload;
        resolvedJobId = upload.jobId;
        releaseAfterResponse = true;
    }

    if (!useMultiPointEndpoint && coordinateSpace === 'normalized' && !resolvedImageSize) {
        return {
            ok: false,
            response: makeJsonResponse(400, { ok: false, error: 'image_size is required for normalized single-point SAM prompts.' })
        };
    }

    const singlePoint = coordinateSpace === 'normalized' && resolvedImageSize ?
        normalizedToPixel(firstPoint.xy, resolvedImageSize) :
        [Math.round(firstPoint.xy[0]), Math.round(firstPoint.xy[1])];

    const segmentResponse = useMultiPointEndpoint ?
        await fetchSam3Upstream('/segment_points', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                job_id: resolvedJobId,
                points: points.map(point => point.xy),
                labels: points.map(point => point.label),
                coordinate_space: coordinateSpace,
                multimask_output: false,
                release_after_response: releaseAfterResponse
            })
        }, upstreamTimeoutMs) :
        await fetchSam3Upstream('/segment_point', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                job_id: resolvedJobId,
                x: String(singlePoint[0]),
                y: String(singlePoint[1]),
                label: String(firstPoint.label),
                release_after_response: releaseAfterResponse ? '1' : '0'
            })
        }, upstreamTimeoutMs);
    const segmentRaw = await readUpstreamBody(segmentResponse);

    if (!segmentResponse.ok) {
        return {
            ok: false,
            response: jsonErrorResponse(segmentRaw, segmentResponse.status || 502, 'SAM3 point segmentation failed.')
        };
    }

    if (!segmentRaw || typeof segmentRaw !== 'object' || !Array.isArray(segmentRaw.masks)) {
        return { ok: false, response: makeJsonResponse(502, { ok: false, error: 'SAM3 returned an unexpected segmentation response.' }) };
    }

    const selectedMask = bestMask(segmentRaw.masks);
    const selectedImage = selectedMask?.image ?? selectedMask?.mask_image;
    if (typeof selectedImage !== 'string' || selectedImage.length === 0) {
        return { ok: false, response: makeJsonResponse(502, { ok: false, error: 'SAM3 did not return a mask.' }) };
    }

    const maskImage = normalizeMaskImage(selectedImage);
    const maskSize = readImageSize(Buffer.from(maskImage, 'base64'));
    const responseSize = resolvedImageSize ?? maskSize ?? { width: 0, height: 0 };

    return {
        ok: true,
        data: {
            mask: maskImage,
            width: responseSize.width,
            height: responseSize.height,
            job_id: typeof segmentRaw.job_id === 'string' && segmentRaw.job_id.length > 0 ? segmentRaw.job_id : resolvedJobId,
            supportsPromptRefinement: useMultiPointEndpoint,
            masks: segmentRaw.masks
        }
    };
};

const parseSegmentRequest = (parsed) => {
    if (!parsed || typeof parsed !== 'object' || typeof parsed.image !== 'string' || parsed.image.length === 0) {
        return null;
    }

    const rawPoints = Array.isArray(parsed.points) && parsed.points.length > 0 ?
        parsed.points :
        [{ click_xy: parsed.click_xy, label: parsed.label ?? 1 }];
    const points = rawPoints.map(point => ({
        xy: point?.click_xy,
        label: point?.label ?? 1
    }));

    if (points.some(point => !isPoint(point.xy) || !isPromptLabel(point.label))) {
        return null;
    }

    return {
        image: parsed.image,
        jobId: typeof parsed.job_id === 'string' && parsed.job_id.length > 0 ? parsed.job_id : undefined,
        points,
        coordinateSpace: 'pixel'
    };
};

const parseRefineRequest = (parsed) => {
    if (!parsed || typeof parsed !== 'object') {
        return null;
    }
    if (parsed.clear_old_points === false) {
        return null;
    }
    if (!Array.isArray(parsed.points) || !Array.isArray(parsed.labels) || parsed.points.length === 0 || parsed.points.length !== parsed.labels.length) {
        return null;
    }
    if (parsed.coordinate_space !== undefined && parsed.coordinate_space !== 'pixel' && parsed.coordinate_space !== 'normalized') {
        return null;
    }
    if (parsed.coordinate_space === 'normalized' && parsed.points.some(point => isPoint(point) && (point[0] > 1 || point[1] > 1))) {
        return null;
    }

    const points = parsed.points.map((point, index) => ({
        xy: point,
        label: parsed.labels[index]
    }));
    if (points.some(point => !isPoint(point.xy) || !isPromptLabel(point.label))) {
        return null;
    }

    const jobId = typeof parsed.job_id === 'string' && parsed.job_id.length > 0 ?
        parsed.job_id :
        (typeof parsed.session_id === 'string' && parsed.session_id.length > 0 ? parsed.session_id : undefined);
    const image = typeof parsed.image === 'string' && parsed.image.length > 0 ? parsed.image : undefined;
    if (!image && !jobId) {
        return null;
    }

    return {
        image,
        imageSize: isImageSize(parsed.image_size) ? parsed.image_size : undefined,
        jobId,
        points,
        coordinateSpace: parsed.coordinate_space ?? 'normalized',
        objectId: parsed.object_id ?? 1,
        frameIndex: Number.isInteger(parsed.frame_index) && parsed.frame_index >= 0 ? parsed.frame_index : 0
    };
};

const writeFetchResponse = async (response, fetchResponse, headers, requestId) => {
    const body = Buffer.from(await fetchResponse.arrayBuffer());
    response.writeHead(fetchResponse.status, {
        ...headers,
        'Content-Type': fetchResponse.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store',
        'X-SAM3-Proxy-Request-Id': requestId
    });
    response.end(body);
};

const handleSam3Adapter = async (incomingUrl, request, response, headers, requestId) => {
    const started = Date.now();
    const body = await readBody(request);
    const parsed = safeJsonParse(body);
    const upstreamTimeoutMs = requestTimeoutMs(request, incomingUrl);

    console.log(JSON.stringify({
        event: 'sam3_proxy_adapter_request',
        request_id: requestId,
        path: incomingUrl.pathname,
        target: target.origin,
        timeout_ms: upstreamTimeoutMs,
        request: summarizeRequest(request, body)
    }));

    if (incomingUrl.pathname === '/api/sam3/refine') {
        const upstream = await proxyJsonEndpoint('/api/sam3/refine', body, upstreamTimeoutMs, buildSam3AdapterUpstreamHeaders(request));
        if (!upstream.ok) {
            await writeFetchResponse(response, upstream.response, headers, requestId);
            return;
        }

        const encoded = await addMaskEncoding(upstream.data);
        const dataWithMask = {
            ...encoded,
            masks: Array.isArray(encoded.masks) && encoded.rle_mask ?
                encoded.masks.map((mask, index) => index === 0 ? {
                    ...mask,
                    rle_mask: encoded.rle_mask,
                    rle_encoding: encoded.rle_encoding,
                    rle_run_count: encoded.rle_run_count
                } : mask) :
                encoded.masks,
            session_id: encoded.job_id,
            object_id: parsed?.object_id ?? 1,
            frame_index: parsed?.frame_index ?? 0,
            clear_old_points: true,
            coordinate_space: parsed?.coordinate_space ?? 'pixel'
        };
        const data = shouldSendCompactRleMask(request, incomingUrl) ?
            compactRleMaskResponse(dataWithMask) :
            dataWithMask;
        console.log(JSON.stringify({
            event: 'sam3_proxy_adapter_response',
            request_id: requestId,
            path: incomingUrl.pathname,
            status: 200,
            ok: true,
            duration_ms: Date.now() - started,
            response: summarizeJsonValue(data)
        }));
        sendJson(response, 200, data, { ...headers, 'X-SAM3-Proxy-Request-Id': requestId });
        return;
    }

    if (incomingUrl.pathname === '/api/sam3/segment') {
        const segmentRequest = parseSegmentRequest(parsed);
        if (!segmentRequest) {
            sendJson(response, 400, { ok: false, error: 'A base64 image and click_xy are required.' }, {
                ...headers,
                'X-SAM3-Proxy-Request-Id': requestId
            });
            return;
        }

        const segment = await segmentSam3Prompts({
            ...segmentRequest,
            upstreamTimeoutMs
        });
        if (!segment.ok) {
            await writeFetchResponse(response, segment.response, headers, requestId);
            return;
        }

        console.log(JSON.stringify({
            event: 'sam3_proxy_adapter_response',
            request_id: requestId,
            path: incomingUrl.pathname,
            status: 200,
            ok: true,
            duration_ms: Date.now() - started,
            response: summarizeJsonValue(segment.data)
        }));
        sendJson(response, 200, segment.data, { ...headers, 'X-SAM3-Proxy-Request-Id': requestId });
        return;
    }

    const refineRequest = parseRefineRequest(parsed);
    if (!refineRequest) {
        sendJson(response, 400, { ok: false, error: 'A SAM image/session, accumulated points, and parallel labels are required.' }, {
            ...headers,
            'X-SAM3-Proxy-Request-Id': requestId
        });
        return;
    }

    const segment = await segmentSam3Prompts({
        image: refineRequest.image,
        imageSize: refineRequest.imageSize,
        jobId: refineRequest.jobId,
        points: refineRequest.points,
        coordinateSpace: refineRequest.coordinateSpace,
        upstreamTimeoutMs,
        forceMultiPointEndpoint: true
    });
    if (!segment.ok) {
        await writeFetchResponse(response, segment.response, headers, requestId);
        return;
    }

    const data = {
        ...segment.data,
        session_id: segment.data.job_id,
        object_id: refineRequest.objectId,
        frame_index: refineRequest.frameIndex,
        clear_old_points: true,
        coordinate_space: refineRequest.coordinateSpace
    };
    console.log(JSON.stringify({
        event: 'sam3_proxy_adapter_response',
        request_id: requestId,
        path: incomingUrl.pathname,
        status: 200,
        ok: true,
        duration_ms: Date.now() - started,
        response: summarizeJsonValue(data)
    }));
    sendJson(response, 200, data, { ...headers, 'X-SAM3-Proxy-Request-Id': requestId });
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

const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
]);

const summarizeErrorCause = (error) => {
    const cause = error?.cause;
    if (!cause || typeof cause !== 'object') {
        return undefined;
    }
    return {
        name: cause.name,
        code: cause.code,
        message: cause.message
    };
};

const buildUpstreamHeaders = (request) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined) {
            continue;
        }

        const lower = name.toLowerCase();
        if (
            lower === 'host' ||
            lower === 'origin' ||
            lower === 'referer' ||
            lower === 'content-length' ||
            lower === 'accept-encoding' ||
            lower.startsWith('sec-fetch-') ||
            HOP_BY_HOP_HEADERS.has(lower)
        ) {
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

const buildJsonUpstreamHeaders = () => {
    const headers = new Headers();
    headers.set('Content-Type', 'application/json');
    headers.set('Accept', 'application/json');
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
                    mask: 'base64 png mask without data URL prefix unless compact RLE is requested',
                    width: 'mask pixel width',
                    height: 'mask pixel height',
                    rle_mask: 'base64 uint32 run pairs when available',
                    rle_encoding: 'uint32-runs-v1 when RLE is available',
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

    if (incomingUrl.pathname === '/api/sam3/refine' || incomingUrl.pathname === '/api/sam3/segment') {
        try {
            await handleSam3Adapter(incomingUrl, request, response, headers, requestId);
        } catch (error) {
            const isTimeout = error?.name === 'AbortError';
            console.warn(JSON.stringify({
                event: 'sam3_proxy_adapter_error',
                request_id: requestId,
                path: incomingUrl.pathname,
                status: isTimeout ? 504 : 502,
                error: error instanceof Error ? error.message : String(error)
            }));
            sendJson(response, isTimeout ? 504 : 502, {
                ok: false,
                request_id: requestId,
                error: isTimeout ? 'SAM3 upstream request timed out.' : (error instanceof Error ? error.message : 'SAM3 dev proxy adapter failed.')
            }, { ...headers, 'X-SAM3-Proxy-Request-Id': requestId });
        }
        return;
    }

    const upstreamPath = pathAliases.get(incomingUrl.pathname) || incomingUrl.pathname;
    const upstreamUrl = new URL(upstreamPath + incomingUrl.search, target);
    const upstreamTimeoutMs = requestTimeoutMs(request, incomingUrl);
    let timeout;

    try {
        const started = Date.now();
        const body = await readBody(request);
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), upstreamTimeoutMs);
        console.log(JSON.stringify({
            event: 'sam3_proxy_request',
            request_id: requestId,
            method: request.method,
            path: incomingUrl.pathname,
            upstream_url: upstreamUrl.href,
            timeout_ms: upstreamTimeoutMs,
            request: summarizeRequest(request, body)
        }));
        const upstreamResponse = await fetch(upstreamUrl, {
            method: request.method,
            headers: incomingUrl.pathname === '/api/artisangs/track' ? buildJsonUpstreamHeaders() : buildUpstreamHeaders(request),
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
            error: error instanceof Error ? error.message : String(error),
            cause: summarizeErrorCause(error)
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
