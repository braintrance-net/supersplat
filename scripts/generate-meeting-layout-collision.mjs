import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const outputPath = resolve('static/dev-assets/collision/meeting-prototype-room-layout-fallback-v1.collision.glb');

const vertices = [];
const indices = [];

const addVertex = (x, y, z) => {
    vertices.push(x, y, z);
    return vertices.length / 3 - 1;
};

const addBox = ({ min, max }) => {
    const base = vertices.length / 3;
    const corners = [
        [min[0], min[1], min[2]],
        [max[0], min[1], min[2]],
        [max[0], max[1], min[2]],
        [min[0], max[1], min[2]],
        [min[0], min[1], max[2]],
        [max[0], min[1], max[2]],
        [max[0], max[1], max[2]],
        [min[0], max[1], max[2]]
    ];
    for (const corner of corners) {
        addVertex(corner[0], corner[1], corner[2]);
    }
    indices.push(
        base + 0, base + 2, base + 1, base + 0, base + 3, base + 2,
        base + 4, base + 5, base + 6, base + 4, base + 6, base + 7,
        base + 0, base + 1, base + 5, base + 0, base + 5, base + 4,
        base + 3, base + 6, base + 2, base + 3, base + 7, base + 6,
        base + 1, base + 2, base + 6, base + 1, base + 6, base + 5,
        base + 0, base + 4, base + 7, base + 0, base + 7, base + 3
    );
};

const addCenteredBox = ({ x, z, width, depth, minY, maxY }) => {
    addBox({
        min: [x - width / 2, minY, z - depth / 2],
        max: [x + width / 2, maxY, z + depth / 2]
    });
};

addBox({ min: [-5.5, -0.22, -3.7], max: [5.5, -0.08, 7.0] });

addBox({ min: [-5.6, -0.1, -3.7], max: [-5.35, 2.8, 7.0] });
addBox({ min: [5.35, -0.1, -3.7], max: [5.6, 2.8, 7.0] });
addBox({ min: [-5.5, -0.1, -3.7], max: [5.5, 2.8, -3.45] });
addBox({ min: [-5.5, -0.1, 6.75], max: [5.5, 2.8, 7.0] });

[
    { x: 0.59, z: -0.18, width: 0.9, depth: 0.9 },
    { x: 1.35, z: 2.87, width: 0.95, depth: 0.95 },
    { x: -0.72, z: 3.21, width: 0.95, depth: 0.95 },
    { x: 0.3, z: 3.15, width: 0.95, depth: 0.95 },
    { x: 2.86, z: 2.62, width: 0.95, depth: 0.95 }
].forEach((chair) => {
    addCenteredBox({ ...chair, minY: -0.05, maxY: 0.38 });
});

addCenteredBox({ x: -1.83, z: -2.08, width: 2.6, depth: 0.35, minY: -0.05, maxY: 2.35 });

const positionBuffer = Buffer.alloc(vertices.length * 4);
vertices.forEach((value, index) => positionBuffer.writeFloatLE(value, index * 4));

const indexBuffer = Buffer.alloc(indices.length * 2);
indices.forEach((value, index) => indexBuffer.writeUInt16LE(value, index * 2));

const pad4 = (buffer, fill = 0) => {
    const padding = (4 - buffer.length % 4) % 4;
    return padding ? Buffer.concat([buffer, Buffer.alloc(padding, fill)]) : buffer;
};

const bin = pad4(Buffer.concat([positionBuffer, indexBuffer]));
const positionMin = [Infinity, Infinity, Infinity];
const positionMax = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < vertices.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
        positionMin[axis] = Math.min(positionMin[axis], vertices[i + axis]);
        positionMax[axis] = Math.max(positionMax[axis], vertices[i + axis]);
    }
}

const json = {
    asset: {
        version: '2.0',
        generator: 'generate-meeting-layout-collision'
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{
        primitives: [{
            attributes: { POSITION: 0 },
            indices: 1
        }]
    }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positionBuffer.length },
        { buffer: 0, byteOffset: positionBuffer.length, byteLength: indexBuffer.length }
    ],
    accessors: [
        {
            bufferView: 0,
            componentType: 5126,
            count: vertices.length / 3,
            type: 'VEC3',
            min: positionMin,
            max: positionMax
        },
        {
            bufferView: 1,
            componentType: 5123,
            count: indices.length,
            type: 'SCALAR',
            min: [0],
            max: [Math.max(...indices)]
        }
    ]
};

const jsonBuffer = pad4(Buffer.from(JSON.stringify(json)), 0x20);
const totalLength = 12 + 8 + jsonBuffer.length + 8 + bin.length;
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(totalLength, 8);

const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(jsonBuffer.length, 0);
jsonHeader.writeUInt32LE(0x4e4f534a, 4);

const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(bin.length, 0);
binHeader.writeUInt32LE(0x004e4942, 4);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, Buffer.concat([header, jsonHeader, jsonBuffer, binHeader, bin]));
console.log(`Wrote ${outputPath} (${vertices.length / 3} vertices, ${indices.length / 3} triangles)`);
