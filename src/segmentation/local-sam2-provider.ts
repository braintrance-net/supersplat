import * as ort from 'onnxruntime-web/all';

import {
    validateSegmentationResult,
    type FrameToMaskTransform,
    type SegmentationCacheState,
    type SegmentationProvider,
    type SegmentationRequest,
    type SegmentationResult,
    type SegmentationTimings
} from './provider';

const MODEL_SIZE = 1024;
const MASK_SIZE = 256;
const ORT_VERSION = '1.27.0';
const MODEL_REVISION = '1e59700f8fa9efd6099df0a0c5a8cf602ccb2835';
const MODEL_DIGEST = 'sha256:54e9ee80bd43e36da6c7cd33031a525bb1d70577eadb31190a28999250b13dfe+' +
    '4a4c8a8a53d9722834b66d8ced88770e2cc783e367965ba62a13be3ab5f1ba89';
const MODEL_CACHE = `supersplat-sam2-tiny-${MODEL_REVISION.slice(0, 12)}`;

type ArtifactName = 'encoder' | 'decoder';
type ModelArtifact = {
    name: ArtifactName;
    url: string;
    bytes: number;
    sha256: string;
};
type LocalSam2Progress = {
    phase: 'cache' | 'download' | 'verify' | 'initialize' | 'ready';
    artifact?: ArtifactName;
    loadedBytes: number;
    totalBytes: number;
    cacheState?: SegmentationCacheState;
    executionProvider?: string;
};
type LetterboxTransform = {
    scale: number;
    offsetX: number;
    offsetY: number;
    frameToMask: FrameToMaskTransform;
};

const ARTIFACTS: ModelArtifact[] = [
    {
        name: 'encoder',
        url: `https://huggingface.co/g-ronimo/sam2-tiny/resolve/${MODEL_REVISION}/sam2_hiera_tiny_encoder.with_runtime_opt.ort`,
        bytes: 134736672,
        sha256: '54e9ee80bd43e36da6c7cd33031a525bb1d70577eadb31190a28999250b13dfe'
    },
    {
        name: 'decoder',
        url: `https://huggingface.co/g-ronimo/sam2-tiny/resolve/${MODEL_REVISION}/sam2_hiera_tiny_decoder_pr1.onnx`,
        bytes: 16531241,
        sha256: '4a4c8a8a53d9722834b66d8ced88770e2cc783e367965ba62a13be3ab5f1ba89'
    }
];
const TOTAL_MODEL_BYTES = ARTIFACTS.reduce((total, artifact) => total + artifact.bytes, 0);

class LocalSam2Error extends Error {
    phase: string;

    constructor(phase: string, message: string, cause?: unknown) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'LocalSam2Error';
        this.phase = phase;
    }
}

const throwIfAborted = (signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException('Local SAM2 request cancelled.', 'AbortError');
};

const calculateLetterboxTransform = (width: number, height: number): LetterboxTransform => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new LocalSam2Error('preprocess', 'Frame dimensions must be positive.');
    }
    const scale = Math.min(MODEL_SIZE / width, MODEL_SIZE / height);
    const offsetX = (MODEL_SIZE - width * scale) * 0.5;
    const offsetY = (MODEL_SIZE - height * scale) * 0.5;
    const maskScale = MASK_SIZE / MODEL_SIZE;
    return {
        scale,
        offsetX,
        offsetY,
        frameToMask: {
            scaleX: scale * maskScale,
            scaleY: scale * maskScale,
            offsetX: offsetX * maskScale,
            offsetY: offsetY * maskScale
        }
    };
};

const digestHex = async (buffer: ArrayBuffer) => {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, '0')).join('');
};

const tensorData = async (tensor: ort.Tensor) => {
    if (tensor.data instanceof Float32Array) return tensor.data;
    const data = await tensor.getData();
    return data instanceof Float32Array ? data : Float32Array.from(data as ArrayLike<number>);
};

class LocalSam2Provider implements SegmentationProvider {
    readonly id = 'local-sam2' as const;
    private encoder: ort.InferenceSession | null = null;
    private decoder: ort.InferenceSession | null = null;
    private executionProvider = 'uninitialized';
    private cacheState: SegmentationCacheState = 'empty';
    private readyPromise: Promise<void> | null = null;
    private embeddingKey = '';
    private embeddings: Record<string, ort.Tensor> | null = null;
    private inferenceCount = 0;
    private onProgress: (progress: LocalSam2Progress) => void;

    constructor(onProgress: (progress: LocalSam2Progress) => void = () => {}) {
        this.onProgress = onProgress;
    }

    private progress(progress: Omit<LocalSam2Progress, 'totalBytes'>) {
        this.onProgress({ ...progress, totalBytes: TOTAL_MODEL_BYTES });
    }

    private async fetchArtifact(
        artifact: ModelArtifact,
        signal: AbortSignal,
        completedBytes: number
    ): Promise<{ buffer: ArrayBuffer; state: SegmentationCacheState }> {
        throwIfAborted(signal);
        this.progress({ phase: 'cache', artifact: artifact.name, loadedBytes: completedBytes });
        let cache: Cache | null = null;
        try {
            cache = 'caches' in window ? await caches.open(MODEL_CACHE) : null;
        } catch (error) {
            console.warn('[Local SAM2] Persistent model cache is unavailable; continuing in memory.', error);
        }
        const cached = await cache?.match(artifact.url);
        if (cached) {
            const buffer = await cached.arrayBuffer();
            if (buffer.byteLength === artifact.bytes && await digestHex(buffer) === artifact.sha256) {
                this.progress({
                    phase: 'verify',
                    artifact: artifact.name,
                    loadedBytes: completedBytes + artifact.bytes,
                    cacheState: 'persistent'
                });
                return { buffer, state: 'persistent' };
            }
            await cache?.delete(artifact.url);
        }

        const response = await fetch(artifact.url, { signal, mode: 'cors' });
        if (!response.ok || !response.body) {
            throw new LocalSam2Error('download', `Could not download ${artifact.name} (${response.status}).`);
        }
        const declaredLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength !== artifact.bytes) {
            throw new LocalSam2Error('download', `${artifact.name} declared an unexpected byte length.`);
        }
        const bytes = new Uint8Array(artifact.bytes);
        const reader = response.body.getReader();
        let offset = 0;
        while (true) {
            throwIfAborted(signal);
            const { done, value } = await reader.read();
            if (done) break;
            if (offset + value.byteLength > bytes.byteLength) {
                throw new LocalSam2Error('download', `${artifact.name} exceeded its pinned byte length.`);
            }
            bytes.set(value, offset);
            offset += value.byteLength;
            this.progress({
                phase: 'download',
                artifact: artifact.name,
                loadedBytes: completedBytes + offset,
                cacheState: 'network'
            });
        }
        if (offset !== artifact.bytes) {
            throw new LocalSam2Error('download', `${artifact.name} download was incomplete.`);
        }
        this.progress({
            phase: 'verify',
            artifact: artifact.name,
            loadedBytes: completedBytes + artifact.bytes,
            cacheState: 'network'
        });
        const buffer = bytes.buffer;
        if (await digestHex(buffer) !== artifact.sha256) {
            throw new LocalSam2Error('verify', `${artifact.name} failed SHA-256 verification.`);
        }
        try {
            await cache?.put(artifact.url, new Response(buffer, {
                headers: {
                    'Content-Length': String(artifact.bytes),
                    'X-SuperSplat-SHA256': artifact.sha256
                }
            }));
        } catch (error) {
            console.warn(`[Local SAM2] ${artifact.name} is usable but could not be persisted.`, error);
        }
        return { buffer, state: 'network' };
    }

    private async createSessions(encoderBuffer: ArrayBuffer, decoderBuffer: ArrayBuffer, signal: AbortSignal) {
        throwIfAborted(signal);
        ort.env.wasm.wasmPaths = new URL('static/lib/onnxruntime/', document.baseURI).toString();
        ort.env.wasm.numThreads = crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1)) : 1;
        const gpu = (navigator as unknown as {
            gpu?: { requestAdapter: (options: { powerPreference: 'high-performance' }) => Promise<unknown> };
        }).gpu;
        const adapter = gpu ? await gpu.requestAdapter({ powerPreference: 'high-performance' }).catch((): null => null) : null;
        const providers = adapter ? ['webgpu', 'wasm'] : ['wasm'];
        let lastError: unknown;
        for (const provider of providers) {
            throwIfAborted(signal);
            this.progress({
                phase: 'initialize',
                loadedBytes: TOTAL_MODEL_BYTES,
                cacheState: this.cacheState,
                executionProvider: provider
            });
            try {
                const options: ort.InferenceSession.SessionOptions = {
                    executionProviders: [provider],
                    graphOptimizationLevel: 'all'
                };
                this.encoder = await ort.InferenceSession.create(encoderBuffer, options);
                throwIfAborted(signal);
                this.decoder = await ort.InferenceSession.create(decoderBuffer, options);
                throwIfAborted(signal);
                this.executionProvider = provider;
                return;
            } catch (error) {
                lastError = error;
                await this.encoder?.release().catch(() => {});
                await this.decoder?.release().catch(() => {});
                this.encoder = null;
                this.decoder = null;
                if (error instanceof DOMException && error.name === 'AbortError') throw error;
                console.warn(`[Local SAM2] ${provider} initialization failed; trying fallback.`, error);
            }
        }
        throw new LocalSam2Error('initialize', 'Local SAM2 could not initialize WebGPU or WASM.', lastError);
    }

    async ensureReady(signal: AbortSignal) {
        if (this.encoder && this.decoder) {
            return;
        }
        if (!this.readyPromise) {
            this.readyPromise = (async () => {
                const loaded: Record<ArtifactName, ArrayBuffer | null> = { encoder: null, decoder: null };
                let completedBytes = 0;
                let state: SegmentationCacheState = 'persistent';
                for (const artifact of ARTIFACTS) {
                    const artifactResult = await this.fetchArtifact(artifact, signal, completedBytes);
                    loaded[artifact.name] = artifactResult.buffer;
                    completedBytes += artifact.bytes;
                    if (artifactResult.state === 'network') state = 'network';
                }
                this.cacheState = state;
                await this.createSessions(loaded.encoder!, loaded.decoder!, signal);
                this.progress({
                    phase: 'ready',
                    loadedBytes: TOTAL_MODEL_BYTES,
                    cacheState: state,
                    executionProvider: this.executionProvider
                });
            })().catch((error) => {
                this.readyPromise = null;
                throw error;
            });
        }
        await this.readyPromise;
    }

    private preprocess(frame: SegmentationRequest['frame'], transform = calculateLetterboxTransform(frame.width, frame.height)) {
        if (frame.rgba.length !== frame.width * frame.height * 4) {
            throw new LocalSam2Error('preprocess', 'RGBA storage does not match frame dimensions.');
        }
        const source = document.createElement('canvas');
        source.width = frame.width;
        source.height = frame.height;
        const sourceContext = source.getContext('2d');
        if (!sourceContext) throw new LocalSam2Error('preprocess', '2D canvas is unavailable.');
        const sourceImage = sourceContext.createImageData(frame.width, frame.height);
        sourceImage.data.set(frame.rgba);
        sourceContext.putImageData(sourceImage, 0, 0);

        const canvas = document.createElement('canvas');
        canvas.width = MODEL_SIZE;
        canvas.height = MODEL_SIZE;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new LocalSam2Error('preprocess', '2D canvas is unavailable.');
        context.fillStyle = '#000';
        context.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);
        context.drawImage(
            source,
            transform.offsetX,
            transform.offsetY,
            frame.width * transform.scale,
            frame.height * transform.scale
        );
        const rgba = context.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
        const planeSize = MODEL_SIZE * MODEL_SIZE;
        const data = new Float32Array(planeSize * 3);
        for (let pixel = 0; pixel < planeSize; pixel++) {
            const rgbaIndex = pixel * 4;
            data[pixel] = rgba[rgbaIndex] / 255;
            data[planeSize + pixel] = rgba[rgbaIndex + 1] / 255;
            data[planeSize * 2 + pixel] = rgba[rgbaIndex + 2] / 255;
        }
        return {
            tensor: new ort.Tensor('float32', data, [1, 3, MODEL_SIZE, MODEL_SIZE]),
            transform
        };
    }

    async segment(request: SegmentationRequest): Promise<SegmentationResult> {
        if (request.prompts.length === 0) {
            throw new LocalSam2Error('request', 'At least one prompt is required.');
        }
        const startedAt = performance.now();
        const timings: SegmentationTimings = { totalMs: 0 };
        const readyStartedAt = performance.now();
        await this.ensureReady(request.signal);
        timings.initializeMs = performance.now() - readyStartedAt;
        throwIfAborted(request.signal);
        const transform = calculateLetterboxTransform(request.frame.width, request.frame.height);

        if (this.embeddingKey !== request.frame.key || !this.embeddings) {
            const preprocessStartedAt = performance.now();
            const { tensor } = this.preprocess(request.frame, transform);
            timings.preprocessMs = performance.now() - preprocessStartedAt;
            const encoderStartedAt = performance.now();
            const encoded = await this.encoder!.run({ image: tensor }).finally(() => tensor.dispose());
            const names = this.encoder!.outputNames;
            const previousEmbeddings = this.embeddings;
            this.embeddings = {
                high_res_feats_0: encoded.high_res_feats_0 ?? encoded[names[0]],
                high_res_feats_1: encoded.high_res_feats_1 ?? encoded[names[1]],
                image_embed: encoded.image_embed ?? encoded[names[2]]
            };
            if (previousEmbeddings) {
                for (const embedding of new Set(Object.values(previousEmbeddings))) embedding.dispose();
            }
            this.embeddingKey = request.frame.key;
            timings.encoderMs = performance.now() - encoderStartedAt;
        } else {
            timings.preprocessMs = 0;
            timings.encoderMs = 0;
        }
        throwIfAborted(request.signal);

        const coords = request.prompts.flatMap((prompt) => {
            return [
                prompt.x * transform.scale + transform.offsetX,
                prompt.y * transform.scale + transform.offsetY
            ];
        });
        const labels = request.prompts.map(prompt => prompt.label);
        const priorMask = request.priorMask && request.priorMask.length === MASK_SIZE * MASK_SIZE ?
            request.priorMask : new Float32Array(MASK_SIZE * MASK_SIZE);
        const hasPriorMask = request.priorMask && request.priorMask.length === MASK_SIZE * MASK_SIZE ? 1 : 0;
        const decoderStartedAt = performance.now();
        const decoded = await this.decoder!.run({
            ...this.embeddings,
            point_coords: new ort.Tensor('float32', Float32Array.from(coords), [1, request.prompts.length, 2]),
            point_labels: new ort.Tensor('float32', Float32Array.from(labels), [1, request.prompts.length]),
            mask_input: new ort.Tensor('float32', priorMask, [1, 1, MASK_SIZE, MASK_SIZE]),
            has_mask_input: new ort.Tensor('float32', Float32Array.from([hasPriorMask]), [1])
        });
        timings.decoderMs = performance.now() - decoderStartedAt;
        if (request.signal.aborted) {
            for (const output of new Set(Object.values(decoded))) output.dispose();
        }
        throwIfAborted(request.signal);

        const postprocessStartedAt = performance.now();
        const masks = decoded.masks ?? decoded[this.decoder!.outputNames.find(name => name.includes('mask'))!];
        const scores = decoded.iou_predictions ?? decoded[this.decoder!.outputNames.find(name => name.includes('iou'))!];
        if (!masks || !scores || masks.dims.length !== 4) {
            throw new LocalSam2Error('postprocess', 'SAM2 decoder returned an unexpected output contract.');
        }
        const maskData = await tensorData(masks);
        const scoreData = await tensorData(scores);
        const maskHeight = masks.dims[2];
        const maskWidth = masks.dims[3];
        const pixelsPerMask = maskWidth * maskHeight;
        let bestMask = 0;
        for (let index = 1; index < scoreData.length; index++) {
            if (scoreData[index] > scoreData[bestMask]) bestMask = index;
        }
        const start = bestMask * pixelsPerMask;
        const logits = maskData.slice(start, start + pixelsPerMask);
        const binary = new Uint8Array(pixelsPerMask);
        for (let index = 0; index < binary.length; index++) binary[index] = logits[index] > 0 ? 1 : 0;
        for (const output of new Set(Object.values(decoded))) output.dispose();
        timings.postprocessMs = performance.now() - postprocessStartedAt;
        timings.totalMs = performance.now() - startedAt;
        const cacheState = this.inferenceCount === 0 ? this.cacheState : 'memory';
        this.inferenceCount++;
        return validateSegmentationResult({
            provider: this.id,
            model: 'sam2-hiera-tiny',
            modelDigest: MODEL_DIGEST,
            runtime: `onnxruntime-web@${ORT_VERSION}`,
            executionProvider: this.executionProvider,
            cacheState,
            mask: {
                data: binary,
                width: maskWidth,
                height: maskHeight,
                frameToMask: transform.frameToMask,
                logits
            },
            timings
        });
    }
}

export {
    ARTIFACTS,
    LocalSam2Error,
    LocalSam2Provider,
    MODEL_DIGEST,
    MODEL_REVISION,
    TOTAL_MODEL_BYTES,
    calculateLetterboxTransform
};
export type { LocalSam2Progress };
