import { ReadFileSystem } from '@playcanvas/splat-transform';
import { GSplatData } from 'playcanvas';

const RAD_MAGIC = 'RAD0';
const RAD_CHUNK_MAGIC = 'RADC';
const SH_C0 = 0.28209479177387814;

type RadProperty = {
    property?: string;
    encoding?: string;
    compression?: string;
    offset?: number;
    bytes?: number;
    min?: number;
    max?: number;
};

type RadChunkMeta = {
    base?: number;
    count?: number;
    properties?: RadProperty[];
};

type RadMeta = {
    count?: number;
    chunks?: Array<{
        filename?: string;
        offset?: number;
        bytes?: number;
    }>;
};

class RadDecodeState {
    count: number;
    positions: Float32Array;
    scales: Float32Array;
    quatsXyzw: Float32Array;
    colors: Float32Array;
    opacities: Float32Array;
    childCount: Uint16Array | null = null;
    childCountWritten: Uint8Array | null = null;
    shDirect = new Map<string, Float32Array>();
    shCodebooks = new Map<string, Float32Array>();
    shLabels: Uint32Array | null = null;

    constructor(count: number) {
        this.count = count;
        this.positions = new Float32Array(count * 3);
        this.scales = new Float32Array(count * 3).fill(1);
        this.quatsXyzw = new Float32Array(count * 4);
        this.colors = new Float32Array(count * 3);
        this.opacities = new Float32Array(count);

        for (let i = 0; i < count; i++) {
            this.quatsXyzw[i * 4 + 3] = 1;
        }
    }

    ensureChildCount() {
        if (!this.childCount) {
            this.childCount = new Uint16Array(this.count);
            this.childCountWritten = new Uint8Array(this.count);
        }
        return this.childCount;
    }

    ensureShDirect(name: string, elements: number) {
        let value = this.shDirect.get(name);
        if (!value) {
            value = new Float32Array(this.count * elements);
            this.shDirect.set(name, value);
        }
        return value;
    }

    ensureShLabels() {
        if (!this.shLabels) {
            this.shLabels = new Uint32Array(this.count);
        }
        return this.shLabels;
    }
}

const fourCc = (data: Uint8Array) => String.fromCharCode(data[0], data[1], data[2], data[3]);
const roundUp8 = (size: number) => (size + 7) & ~7;

const requireNumber = (value: unknown, name: string) => {
    if (typeof value !== 'number') {
        throw new Error(`RAD property missing numeric ${name}`);
    }
    return value;
};

const readFileBytes = async (fileSystem: ReadFileSystem, filename: string): Promise<Uint8Array> => {
    const source = await fileSystem.createSource(filename);
    try {
        return await source.read().readAll();
    } finally {
        source.close();
    }
};

const decompressRadProperty = async (property: RadProperty, data: Uint8Array): Promise<Uint8Array> => {
    if (!property.compression) {
        return data;
    }
    if (property.compression !== 'gz') {
        throw new Error(`Unsupported RAD compression: ${property.compression}`);
    }

    const DecompressionStreamCtor = globalThis.DecompressionStream;
    if (!DecompressionStreamCtor) {
        throw new Error('RAD compressed chunks require DecompressionStream support');
    }

    for (const format of ['deflate', 'deflate-raw'] as const) {
        try {
            const copy = new Uint8Array(data.byteLength);
            copy.set(data);
            const stream = new Blob([copy.buffer]).stream().pipeThrough(new DecompressionStreamCtor(format));
            return new Uint8Array(await new Response(stream).arrayBuffer());
        } catch {
            // Try the other zlib framing.
        }
    }

    throw new Error('Unable to decompress RAD property payload');
};

const decodeFloat16 = (bits: number) => {
    const sign = (bits & 0x8000) ? -1 : 1;
    const exponent = (bits >> 10) & 0x1f;
    const mantissa = bits & 0x03ff;

    if (exponent === 0) {
        return sign * (mantissa / 1024) * 2 ** -14;
    }
    if (exponent === 31) {
        return mantissa ? NaN : sign * Infinity;
    }
    return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
};

const decodePlaneF32 = (data: Uint8Array, dims: number, count: number) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const result = new Float32Array(count * dims);
    for (let dim = 0; dim < dims; dim++) {
        for (let row = 0; row < count; row++) {
            result[row * dims + dim] = view.getFloat32((dim * count + row) * 4, true);
        }
    }
    return result;
};

const decodePlaneF16 = (data: Uint8Array, dims: number, count: number) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const result = new Float32Array(count * dims);
    for (let dim = 0; dim < dims; dim++) {
        for (let row = 0; row < count; row++) {
            result[row * dims + dim] = decodeFloat16(view.getUint16((dim * count + row) * 2, true));
        }
    }
    return result;
};

const decodeLittleEndianBytes = (data: Uint8Array, dims: number, count: number, byteCount: 2 | 4) => {
    const packed = new Uint8Array(count * dims * byteCount);
    const stride = dims * count;
    for (let byteIndex = 0; byteIndex < byteCount; byteIndex++) {
        const byteOffset = byteIndex * stride;
        for (let dim = 0; dim < dims; dim++) {
            const planeOffset = byteOffset + dim * count;
            for (let row = 0; row < count; row++) {
                packed[(row * dims + dim) * byteCount + byteIndex] = data[planeOffset + row];
            }
        }
    }
    return byteCount === 4 ? new Float32Array(packed.buffer) : decodePlaneF16(packed, dims, count);
};

const decodeUnsignedInts = (data: Uint8Array, dims: number, count: number, byteCount: 2 | 4) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const result = byteCount === 2 ? new Uint16Array(count * dims) : new Uint32Array(count * dims);
    for (let dim = 0; dim < dims; dim++) {
        for (let row = 0; row < count; row++) {
            const offset = (dim * count + row) * byteCount;
            result[row * dims + dim] = byteCount === 2 ? view.getUint16(offset, true) : view.getUint32(offset, true);
        }
    }
    return result;
};

const decodeQuatOct88r8 = (data: Uint8Array, count: number) => {
    const result = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
        let x = data[i * 3] / 255 * 2 - 1;
        let y = data[i * 3 + 1] / 255 * 2 - 1;
        const z = 1 - Math.abs(x) - Math.abs(y);
        const t = Math.max(-z, 0);
        x = x >= 0 ? x - t : x + t;
        y = y >= 0 ? y - t : y + t;

        const length = Math.hypot(x, y, z) || 1;
        const halfTheta = data[i * 3 + 2] / 255 * 0.5 * Math.PI;
        const sinHalfTheta = Math.sin(halfTheta);
        result[i * 4] = x / length * sinHalfTheta;
        result[i * 4 + 1] = y / length * sinHalfTheta;
        result[i * 4 + 2] = z / length * sinHalfTheta;
        result[i * 4 + 3] = Math.cos(halfTheta);
    }
    return result;
};

const decodeRadProperty = (property: RadProperty, data: Uint8Array, dims: number, count: number) => {
    switch (property.encoding) {
        case 'f32':
            return decodePlaneF32(data, dims, count);
        case 'f16':
            return decodePlaneF16(data, dims, count);
        case 'f32_lebytes':
            return decodeLittleEndianBytes(data, dims, count, 4);
        case 'f16_lebytes':
            return decodeLittleEndianBytes(data, dims, count, 2);
        case 'r8': {
            const min = requireNumber(property.min, 'min');
            const max = requireNumber(property.max, 'max');
            const range = max - min;
            const result = new Float32Array(count * dims);
            for (let dim = 0; dim < dims; dim++) {
                for (let row = 0; row < count; row++) {
                    result[row * dims + dim] = data[dim * count + row] / 255 * range + min;
                }
            }
            return result;
        }
        case 'r8_delta': {
            const min = requireNumber(property.min, 'min');
            const max = requireNumber(property.max, 'max');
            const range = max - min;
            const result = new Float32Array(count * dims);
            for (let dim = 0; dim < dims; dim++) {
                let value = 0;
                for (let row = 0; row < count; row++) {
                    value = (value + data[dim * count + row]) & 0xff;
                    result[row * dims + dim] = value / 255 * range + min;
                }
            }
            return result;
        }
        case 's8': {
            const max = requireNumber(property.max, 'max');
            const result = new Float32Array(count * dims);
            for (let dim = 0; dim < dims; dim++) {
                for (let row = 0; row < count; row++) {
                    const value = data[dim * count + row];
                    result[row * dims + dim] = (value > 127 ? value - 256 : value) / 127 * max;
                }
            }
            return result;
        }
        case 's8_delta': {
            const max = requireNumber(property.max, 'max');
            const result = new Float32Array(count * dims);
            for (let dim = 0; dim < dims; dim++) {
                let value = 0;
                for (let row = 0; row < count; row++) {
                    value = (value + data[dim * count + row]) & 0xff;
                    result[row * dims + dim] = (value > 127 ? value - 256 : value) / 127 * max;
                }
            }
            return result;
        }
        case 'ln_0r8': {
            const min = requireNumber(property.min, 'min');
            const max = requireNumber(property.max, 'max');
            const step = (max - min) / 254;
            const result = new Float32Array(count * dims);
            for (let dim = 0; dim < dims; dim++) {
                for (let row = 0; row < count; row++) {
                    const value = data[dim * count + row];
                    result[row * dims + dim] = value === 0 ? 0 : Math.exp(min + (value - 1) * step);
                }
            }
            return result;
        }
        case 'ln_f16': {
            const result = decodePlaneF16(data, dims, count);
            for (let i = 0; i < result.length; i++) {
                result[i] = Math.exp(result[i]);
            }
            return result;
        }
        default:
            throw new Error(`Unsupported RAD property encoding: ${property.encoding}`);
    }
};

const copyRows = (source: Float32Array, dims: number, target: Float32Array, targetStride: number, base: number, count: number) => {
    for (let row = 0; row < count; row++) {
        for (let dim = 0; dim < dims; dim++) {
            target[(base + row) * targetStride + dim] = source[row * dims + dim];
        }
    }
};

const decodeRadChunkIntoState = async (chunkBytes: Uint8Array, state: RadDecodeState | null): Promise<RadDecodeState> => {
    if (chunkBytes.byteLength < 16 || fourCc(chunkBytes) !== RAD_CHUNK_MAGIC) {
        throw new Error('Invalid RAD chunk magic');
    }

    const view = new DataView(chunkBytes.buffer, chunkBytes.byteOffset, chunkBytes.byteLength);
    const metaLength = view.getUint32(4, true);
    const metaEnd = 8 + roundUp8(metaLength);
    if (chunkBytes.byteLength < metaEnd + 8) {
        throw new Error('Incomplete RAD chunk header');
    }

    const chunkMeta = JSON.parse(new TextDecoder().decode(chunkBytes.subarray(8, 8 + metaLength))) as RadChunkMeta;
    const payloadBytes = Number(view.getBigUint64(metaEnd, true));
    const payloadStart = metaEnd + 8;
    if (chunkBytes.byteLength < payloadStart + payloadBytes) {
        throw new Error('Incomplete RAD chunk payload');
    }

    let base = chunkMeta.base ?? 0;
    const count = chunkMeta.count ?? 0;
    if (!state) {
        state = new RadDecodeState(count);
        base = 0;
    }
    if (count < 0 || base < 0 || base + count > state.count) {
        throw new Error(`Invalid RAD chunk range base=${base} count=${count} total=${state.count}`);
    }
    if (!Array.isArray(chunkMeta.properties)) {
        throw new Error('RAD chunk missing properties');
    }

    for (const property of chunkMeta.properties) {
        const offset = property.offset ?? 0;
        const bytes = property.bytes ?? 0;
        const raw = chunkBytes.subarray(payloadStart + offset, payloadStart + offset + bytes);
        const data = await decompressRadProperty(property, raw);

        switch (property.property) {
            case 'center':
                copyRows(decodeRadProperty(property, data, 3, count), 3, state.positions, 3, base, count);
                break;
            case 'alpha':
                copyRows(decodeRadProperty(property, data, 1, count), 1, state.opacities, 1, base, count);
                break;
            case 'rgb':
                copyRows(decodeRadProperty(property, data, 3, count), 3, state.colors, 3, base, count);
                break;
            case 'scales':
                copyRows(decodeRadProperty(property, data, 3, count), 3, state.scales, 3, base, count);
                break;
            case 'orientation': {
                if (property.encoding === 'oct88r8') {
                    copyRows(decodeQuatOct88r8(data, count), 4, state.quatsXyzw, 4, base, count);
                } else {
                    const values = decodeRadProperty(property, data, 3, count);
                    for (let i = 0; i < count; i++) {
                        const x = values[i * 3];
                        const y = values[i * 3 + 1];
                        const z = values[i * 3 + 2];
                        state.quatsXyzw[(base + i) * 4] = x;
                        state.quatsXyzw[(base + i) * 4 + 1] = y;
                        state.quatsXyzw[(base + i) * 4 + 2] = z;
                        state.quatsXyzw[(base + i) * 4 + 3] = Math.sqrt(Math.max(1 - x * x - y * y - z * z, 0));
                    }
                }
                break;
            }
            case 'sh1':
            case 'sh2':
            case 'sh3':
            case 'sh1_code':
            case 'sh2_code':
            case 'sh3_code': {
                const name = property.property.replace('_code', '');
                const elements = { sh1: 9, sh2: 15, sh3: 21 }[name as 'sh1' | 'sh2' | 'sh3'];
                const values = decodeRadProperty(property, data, elements, count);
                if (property.property.endsWith('_code')) {
                    state.shCodebooks.set(name, values);
                } else {
                    copyRows(values, elements, state.ensureShDirect(name, elements), elements, base, count);
                }
                break;
            }
            case 'sh_label': {
                let labels: Uint16Array | Uint32Array;
                if (property.encoding === 'u16') {
                    labels = decodeUnsignedInts(data, 1, count, 2) as Uint16Array;
                } else if (property.encoding === 'u32') {
                    labels = decodeUnsignedInts(data, 1, count, 4) as Uint32Array;
                } else {
                    throw new Error(`Unsupported RAD SH label encoding: ${property.encoding}`);
                }
                state.ensureShLabels().set(labels, base);
                break;
            }
            case 'child_count': {
                if (property.encoding !== 'u16') {
                    throw new Error(`Unsupported RAD child_count encoding: ${property.encoding}`);
                }
                state.ensureChildCount().set(decodeUnsignedInts(data, 1, count, 2) as Uint16Array, base);
                state.childCountWritten?.fill(1, base, base + count);
                break;
            }
            case 'child_start':
                break;
            default:
                throw new Error(`Unsupported RAD property: ${property.property}`);
        }
    }

    return state;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const logit = (value: number) => {
    const clamped = Math.max(1e-6, Math.min(0.999999, value));
    return Math.log(clamped / (1 - clamped));
};

const sourceIndex = (leafIndices: number[] | null, index: number) => {
    return leafIndices ? leafIndices[index] : index;
};

const getLeafIndices = (state: RadDecodeState) => {
    if (!state.childCount) {
        return null;
    }
    if (!state.childCountWritten) {
        throw new Error('RAD LOD child_count did not cover every splat');
    }

    const leafIndices: number[] = [];
    for (let i = 0; i < state.count; i++) {
        if (!state.childCountWritten[i]) {
            throw new Error('RAD LOD child_count did not cover every splat');
        }
        if (state.childCount[i] === 0) {
            leafIndices.push(i);
        }
    }

    if (leafIndices.length === 0) {
        throw new Error('RAD LOD tree has no leaf splats');
    }
    return leafIndices;
};

const buildShRestProps = (state: RadDecodeState, leafIndices: number[] | null, count: number) => {
    const props: Array<{ name: string, storage: Float32Array }> = [];
    let propIndex = 0;

    for (const [name, coeffCount] of [['sh1', 3], ['sh2', 5], ['sh3', 7]] as const) {
        const elements = coeffCount * 3;
        let values = state.shDirect.get(name);

        if (!values && state.shLabels && state.shCodebooks.has(name)) {
            const codebook = state.shCodebooks.get(name)!;
            values = new Float32Array(state.count * elements);
            for (let i = 0; i < state.count; i++) {
                const label = state.shLabels[i];
                if (label * elements + elements > codebook.length) {
                    throw new Error(`RAD SH label references ${label}, but ${name} codebook has ${codebook.length / elements} entries`);
                }
                values.set(codebook.subarray(label * elements, label * elements + elements), i * elements);
            }
        }

        if (values) {
            for (let element = 0; element < elements; element++) {
                const storage = new Float32Array(count);
                for (let i = 0; i < count; i++) {
                    storage[i] = values[sourceIndex(leafIndices, i) * elements + element];
                }
                props.push({ name: `f_rest_${propIndex++}`, storage });
            }
        }
    }

    return props;
};

const stateToGSplatData = (state: RadDecodeState) => {
    const leafIndices = getLeafIndices(state);
    const count = leafIndices ? leafIndices.length : state.count;

    const x = new Float32Array(count);
    const y = new Float32Array(count);
    const z = new Float32Array(count);
    const scale0 = new Float32Array(count);
    const scale1 = new Float32Array(count);
    const scale2 = new Float32Array(count);
    const rot0 = new Float32Array(count);
    const rot1 = new Float32Array(count);
    const rot2 = new Float32Array(count);
    const rot3 = new Float32Array(count);
    const fdc0 = new Float32Array(count);
    const fdc1 = new Float32Array(count);
    const fdc2 = new Float32Array(count);
    const opacity = new Float32Array(count);

    for (let i = 0; i < count; i++) {
        const src = sourceIndex(leafIndices, i);
        const pos = src * 3;
        const quat = src * 4;

        x[i] = state.positions[pos];
        y[i] = state.positions[pos + 1];
        z[i] = state.positions[pos + 2];
        scale0[i] = Math.log(Math.max(state.scales[pos], 1e-8));
        scale1[i] = Math.log(Math.max(state.scales[pos + 1], 1e-8));
        scale2[i] = Math.log(Math.max(state.scales[pos + 2], 1e-8));

        const qx = state.quatsXyzw[quat];
        const qy = state.quatsXyzw[quat + 1];
        const qz = state.quatsXyzw[quat + 2];
        const qw = state.quatsXyzw[quat + 3];
        const length = Math.hypot(qx, qy, qz, qw) || 1;
        rot0[i] = qw / length;
        rot1[i] = qx / length;
        rot2[i] = qy / length;
        rot3[i] = qz / length;

        fdc0[i] = (clamp01(state.colors[pos]) - 0.5) / SH_C0;
        fdc1[i] = (clamp01(state.colors[pos + 1]) - 0.5) / SH_C0;
        fdc2[i] = (clamp01(state.colors[pos + 2]) - 0.5) / SH_C0;
        opacity[i] = logit(clamp01(state.opacities[src]));
    }

    const shRestProps = buildShRestProps(state, leafIndices, count);
    const properties = [
        { type: 'float', name: 'x', storage: x, byteSize: 4 },
        { type: 'float', name: 'y', storage: y, byteSize: 4 },
        { type: 'float', name: 'z', storage: z, byteSize: 4 },
        { type: 'float', name: 'f_dc_0', storage: fdc0, byteSize: 4 },
        { type: 'float', name: 'f_dc_1', storage: fdc1, byteSize: 4 },
        { type: 'float', name: 'f_dc_2', storage: fdc2, byteSize: 4 },
        ...shRestProps.map(prop => ({ type: 'float', name: prop.name, storage: prop.storage, byteSize: 4 })),
        { type: 'float', name: 'opacity', storage: opacity, byteSize: 4 },
        { type: 'float', name: 'scale_0', storage: scale0, byteSize: 4 },
        { type: 'float', name: 'scale_1', storage: scale1, byteSize: 4 },
        { type: 'float', name: 'scale_2', storage: scale2, byteSize: 4 },
        { type: 'float', name: 'rot_0', storage: rot0, byteSize: 4 },
        { type: 'float', name: 'rot_1', storage: rot1, byteSize: 4 },
        { type: 'float', name: 'rot_2', storage: rot2, byteSize: 4 },
        { type: 'float', name: 'rot_3', storage: rot3, byteSize: 4 }
    ];

    return new GSplatData([{
        name: 'vertex',
        count,
        properties
    }]);
};

const loadRadGSplatData = async (filename: string, fileSystem: ReadFileSystem): Promise<GSplatData> => {
    const bytes = await readFileBytes(fileSystem, filename);
    if (bytes.byteLength < 8) {
        throw new Error('Incomplete RAD artifact');
    }

    const magic = fourCc(bytes);
    if (magic === RAD_CHUNK_MAGIC) {
        return stateToGSplatData(await decodeRadChunkIntoState(bytes, null));
    }
    if (magic !== RAD_MAGIC) {
        throw new Error('Invalid RAD magic');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const metaLength = view.getUint32(4, true);
    const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + metaLength))) as RadMeta;
    if (!Array.isArray(meta.chunks)) {
        throw new Error('RAD header missing chunks');
    }

    let state = new RadDecodeState(meta.count ?? 0);
    const chunksStart = 8 + roundUp8(metaLength);
    for (const chunk of meta.chunks) {
        let chunkBytes: Uint8Array;
        if (chunk.filename) {
            chunkBytes = await readFileBytes(fileSystem, chunk.filename);
        } else {
            const offset = chunk.offset ?? 0;
            const length = chunk.bytes ?? 0;
            chunkBytes = bytes.subarray(chunksStart + offset, chunksStart + offset + length);
        }
        state = await decodeRadChunkIntoState(chunkBytes, state);
    }

    return stateToGSplatData(state);
};

export { loadRadGSplatData };
