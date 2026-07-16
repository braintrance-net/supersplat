import { encodeSegmentationFramePng } from './frame';
import {
    validateSegmentationResult,
    type SegmentationProvider,
    type SegmentationRequest,
    type SegmentationResult
} from './provider';
import {
    maskPngToArray,
    normalizePromptPoint,
    rleMaskToArray
} from '../tools/artisan-selection';

const DEFAULT_SAM3_BACKEND_URL = 'http://3.19.208.185:8000';
const DEFAULT_TIMEOUT_MS = 60000;

type CloudSam3Response = {
    mask?: string;
    rle_mask?: string;
    rle_encoding?: string;
    rle_run_count?: number;
    width?: number;
    height?: number;
    job_id?: string;
    supportsPromptRefinement?: boolean;
    provider?: string;
    model?: string;
    model_digest?: string;
    error?: string;
};

class CloudSam3Error extends Error {
    status?: number;
    phase: string;

    constructor(phase: string, message: string, status?: number) {
        super(message);
        this.name = 'CloudSam3Error';
        this.phase = phase;
        this.status = status;
    }
}

const getBackendUrl = () => window.supersplatConfig?.sam3BackendUrl?.trim() || DEFAULT_SAM3_BACKEND_URL;
const getCredentials = (backendUrl: string): 'same-origin' | 'omit' => {
    try {
        return new URL(backendUrl, window.location.href).origin === window.location.origin ? 'same-origin' : 'omit';
    } catch {
        return 'same-origin';
    }
};

class CloudSam3Provider implements SegmentationProvider {
    readonly id = 'cloud-sam3' as const;
    private timeoutMs: number;

    constructor(timeoutMs = DEFAULT_TIMEOUT_MS) {
        this.timeoutMs = Math.max(1000, Math.min(180000, Math.round(timeoutMs)));
    }

    async segment(request: SegmentationRequest): Promise<SegmentationResult> {
        if (request.prompts.length === 0) throw new CloudSam3Error('request', 'At least one prompt is required.');
        if (request.signal.aborted) throw new DOMException('Cloud SAM3 request cancelled.', 'AbortError');
        const startedAt = performance.now();
        const encodeStartedAt = performance.now();
        const image = encodeSegmentationFramePng(request.frame);
        const encodeMs = performance.now() - encodeStartedAt;
        const requestController = new AbortController();
        let timedOut = false;
        const relayCancellation = () => requestController.abort(request.signal.reason);
        request.signal.addEventListener('abort', relayCancellation, { once: true });
        const timeout = window.setTimeout(() => {
            timedOut = true;
            requestController.abort(new DOMException('Cloud SAM3 timed out.', 'TimeoutError'));
        }, this.timeoutMs);
        const backendUrl = getBackendUrl();
        const points = request.prompts.map(prompt => ({
            click_xy: [prompt.x, prompt.y] as [number, number],
            label: prompt.label
        }));
        const primary = points[points.length - 1]!;
        const refineBody = {
            image,
            session_id: request.sessionId,
            job_id: request.sessionId,
            object_id: 1,
            frame_index: 0,
            clear_old_points: true,
            coordinate_space: 'normalized',
            image_size: { width: request.frame.width, height: request.frame.height },
            points: points.map(point => normalizePromptPoint(point, {
                width: request.frame.width,
                height: request.frame.height
            })),
            labels: points.map(point => point.label)
        };
        const segmentBody = {
            image,
            click_xy: primary.click_xy,
            label: primary.label,
            job_id: request.sessionId,
            points,
            image_size: { width: request.frame.width, height: request.frame.height }
        };
        const fetchEndpoint = (endpoint: string, body: unknown, compactMask: boolean) => {
            const url = new URL(endpoint, backendUrl);
            url.searchParams.set('timeout_ms', String(this.timeoutMs));
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'X-SAM3-Timeout-Ms': String(this.timeoutMs)
            };
            if (compactMask) {
                headers['X-SAM3-Mask-Encoding'] = 'rle-compact';
                headers['X-SAM3-Compact-Mask'] = '1';
            }
            return fetch(url, {
                method: 'POST',
                headers,
                credentials: getCredentials(backendUrl),
                body: JSON.stringify(body),
                signal: requestController.signal
            });
        };

        try {
            const networkStartedAt = performance.now();
            let response = await fetchEndpoint('/api/sam3/refine', refineBody, true);
            let fallbackFromStatus: number | undefined;
            if (response.status === 404 || response.status === 405 || response.status === 501) {
                fallbackFromStatus = response.status;
                response = await fetchEndpoint('/api/sam3/segment', segmentBody, false);
            }
            const responseJsonStartedAt = performance.now();
            const data = await response.json().catch(() => ({})) as CloudSam3Response;
            const responseJsonMs = performance.now() - responseJsonStartedAt;
            const networkMs = performance.now() - networkStartedAt;
            if (!response.ok) {
                throw new CloudSam3Error('network', data.error || response.statusText, response.status);
            }
            if (request.prompts.length > 1 && data.supportsPromptRefinement !== true) {
                throw new CloudSam3Error('contract', 'Cloud SAM3 did not confirm prompt refinement support.');
            }
            if (!data.width || !data.height || (!data.mask && !data.rle_mask)) {
                throw new CloudSam3Error('contract', 'Cloud SAM3 returned no dimension-declared mask.');
            }
            const frameAspect = request.frame.width / request.frame.height;
            const maskAspect = data.width / data.height;
            if (Math.abs(frameAspect - maskAspect) / frameAspect > 0.02) {
                throw new CloudSam3Error('contract', 'Cloud SAM3 mask aspect does not match the canonical frame.');
            }
            const decodeStartedAt = performance.now();
            const mask = data.rle_mask ?
                rleMaskToArray(data.rle_mask, data.width, data.height, data.rle_run_count, data.rle_encoding) :
                await maskPngToArray(data.mask!, data.width, data.height);
            const decodeMs = performance.now() - decodeStartedAt;
            return validateSegmentationResult({
                provider: this.id,
                model: data.model || 'sam3-server',
                modelDigest: data.model_digest || 'unreported',
                runtime: data.provider || 'remote',
                executionProvider: 'remote',
                cacheState: 'network',
                sessionId: data.job_id,
                mask: {
                    data: mask,
                    width: data.width,
                    height: data.height,
                    frameToMask: {
                        scaleX: data.width / request.frame.width,
                        scaleY: data.height / request.frame.height,
                        offsetX: 0,
                        offsetY: 0
                    }
                },
                timings: {
                    totalMs: performance.now() - startedAt,
                    encodeMs,
                    networkMs,
                    responseJsonMs,
                    decodeMs,
                    fallbackFromStatus: fallbackFromStatus ?? 0
                }
            });
        } catch (error) {
            if (timedOut) throw new CloudSam3Error('timeout', `Cloud SAM3 exceeded ${this.timeoutMs}ms.`);
            throw error;
        } finally {
            window.clearTimeout(timeout);
            request.signal.removeEventListener('abort', relayCancellation);
        }
    }
}

export { CloudSam3Error, CloudSam3Provider };
