import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { MemoryReadFileSystem, ZipReadFileSystem, readSog } from '@playcanvas/splat-transform';

const defaultManifest = '../../../board-demo-web/public/worlds/meeting-prototype-room/manifest.json';
const defaultAssetRoot = '../../../board-demo-web/public';
const defaultOutput = 'static/dev-assets/collision/meeting-prototype-room-splat-voxel-v1.collision.glb';
const defaultBounds = [-8.5, -0.5, -11.5, 12.5, 4.8, 25];

const args = parseArgs(process.argv.slice(2));
const manifestPath = resolve(args.manifest ?? defaultManifest);
const assetRoot = resolve(args.assetRoot ?? defaultAssetRoot);
const outputPath = resolve(args.output ?? defaultOutput);
const voxelSize = positiveNumber(args.voxelSize, 0.18);
const opacityThreshold = positiveNumber(args.opacityThreshold, 0.02);
const dilationSteps = Math.max(0, Math.floor(positiveNumber(args.dilate, 1)));
const floorFill = args.floorFill ?? 'rect';
const bounds = parseBounds(args.bounds ?? defaultBounds.join(','));

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const grid = createGrid(bounds, voxelSize);
const stats = {
    manifest: manifestPath,
    assetRoot,
    output: outputPath,
    voxelSize,
    opacityThreshold,
    dilationSteps,
    floorFill,
    bounds,
    grid: { nx: grid.nx, ny: grid.ny, nz: grid.nz, voxels: grid.occupancy.length },
    layers: [],
    totalSplats: 0,
    keptSplats: 0,
    markedSplats: 0
};

for (const layer of manifest.layers) {
    const layerStats = await voxelizeLayer(layer, assetRoot, grid, opacityThreshold);
    stats.layers.push(layerStats);
    stats.totalSplats += layerStats.rows;
    stats.keptSplats += layerStats.kept;
    stats.markedSplats += layerStats.marked;
    console.log(`${layer.id}: rows=${layerStats.rows} kept=${layerStats.kept} marked=${layerStats.marked}`);
}

stats.occupiedBeforeDilation = countOccupied(grid.occupancy);
dilateOccupancy(grid, dilationSteps);
stats.occupiedAfterDilation = countOccupied(grid.occupancy);
stats.floorFill = applyFloorFill(grid, floorFill);

const mesh = buildVoxelMesh(grid);
stats.quads = mesh.quads;
stats.triangles = mesh.indices.length / 3;
stats.vertices = mesh.positions.length / 3;

const glb = writeGlb(mesh.positions, mesh.indices);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, glb);
stats.bytes = glb.byteLength;
console.log(JSON.stringify(stats, null, 2));

function parseArgs(argv) {
    const parsed = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith('--')) {
            continue;
        }
        const key = arg.slice(2);
        const next = argv[i + 1];
        parsed[key] = next && !next.startsWith('--') ? argv[++i] : '1';
    }
    return parsed;
}

function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function parseBounds(value) {
    const numbers = String(value).split(',').map(Number);
    if (numbers.length !== 6 || numbers.some(number => !Number.isFinite(number))) {
        throw new Error(`Invalid bounds '${value}'. Expected minX,minY,minZ,maxX,maxY,maxZ.`);
    }
    const [minX, minY, minZ, maxX, maxY, maxZ] = numbers;
    if (minX >= maxX || minY >= maxY || minZ >= maxZ) {
        throw new Error(`Invalid bounds '${value}'. Min values must be below max values.`);
    }
    return { minX, minY, minZ, maxX, maxY, maxZ };
}

function createGrid(bounds, size) {
    const nx = Math.ceil((bounds.maxX - bounds.minX) / size);
    const ny = Math.ceil((bounds.maxY - bounds.minY) / size);
    const nz = Math.ceil((bounds.maxZ - bounds.minZ) / size);
    return {
        ...bounds,
        size,
        nx,
        ny,
        nz,
        occupancy: new Uint8Array(nx * ny * nz)
    };
}

async function readSogTable(path) {
    const memoryFs = new MemoryReadFileSystem();
    memoryFs.set('scene.sog', await readFile(path));
    const source = await memoryFs.createSource('scene.sog');
    const zipFs = new ZipReadFileSystem(source);
    try {
        return await readSog(zipFs, 'meta.json');
    } finally {
        zipFs.close();
    }
}

async function voxelizeLayer(layer, assetRoot, grid, opacityThreshold) {
    const table = await readSogTable(resolve(assetRoot, layer.assetUrl.replace(/^\//, '')));
    const transform = layer.docTransform;
    if (!transform) {
        throw new Error(`Layer '${layer.id}' is missing docTransform.`);
    }

    const xs = table.getColumnByName('x').data;
    const ys = table.getColumnByName('y').data;
    const zs = table.getColumnByName('z').data;
    const opacities = table.getColumnByName('opacity').data;
    const rows = xs.length;
    let kept = 0;
    let marked = 0;

    for (let i = 0; i < rows; i += 1) {
        if (sigmoid(opacities[i]) < opacityThreshold) {
            continue;
        }
        kept += 1;

        const point = transformPoint(transform, xs[i], ys[i], zs[i]);
        const ix = Math.floor((point[0] - grid.minX) / grid.size);
        const iy = Math.floor((point[1] - grid.minY) / grid.size);
        const iz = Math.floor((point[2] - grid.minZ) / grid.size);
        if (ix < 0 || ix >= grid.nx || iy < 0 || iy >= grid.ny || iz < 0 || iz >= grid.nz) {
            continue;
        }

        grid.occupancy[indexOf(grid, ix, iy, iz)] = 1;
        marked += 1;
    }

    return { id: layer.id, rows, kept, marked };
}

function sigmoid(value) {
    return 1 / (1 + Math.exp(-value));
}

function transformPoint(transform, x, y, z) {
    const scaled = [
        x * transform.scale[0],
        y * transform.scale[1],
        z * transform.scale[2]
    ];
    const rotated = rotateByQuaternion(transform.rotation, scaled);
    return [
        rotated[0] + transform.position[0],
        rotated[1] + transform.position[1],
        rotated[2] + transform.position[2]
    ];
}

function rotateByQuaternion(quaternion, value) {
    const [x, y, z, w] = quaternion;
    const vx = value[0];
    const vy = value[1];
    const vz = value[2];
    const tx = 2 * (y * vz - z * vy);
    const ty = 2 * (z * vx - x * vz);
    const tz = 2 * (x * vy - y * vx);
    return [
        vx + w * tx + (y * tz - z * ty),
        vy + w * ty + (z * tx - x * tz),
        vz + w * tz + (x * ty - y * tx)
    ];
}

function indexOf(grid, x, y, z) {
    return x + grid.nx * (y + grid.ny * z);
}

function isSolid(grid, x, y, z, occupancy = grid.occupancy) {
    if (x < 0 || x >= grid.nx || y < 0 || y >= grid.ny || z < 0 || z >= grid.nz) {
        return false;
    }
    return occupancy[indexOf(grid, x, y, z)] !== 0;
}

function countOccupied(occupancy) {
    let count = 0;
    for (let i = 0; i < occupancy.length; i += 1) {
        count += occupancy[i] ? 1 : 0;
    }
    return count;
}

function dilateOccupancy(grid, steps) {
    for (let step = 0; step < steps; step += 1) {
        const source = grid.occupancy;
        const next = new Uint8Array(source);
        for (let z = 0; z < grid.nz; z += 1) {
            for (let y = 0; y < grid.ny; y += 1) {
                for (let x = 0; x < grid.nx; x += 1) {
                    if (!isSolid(grid, x, y, z, source)) {
                        continue;
                    }
                    for (let dz = -1; dz <= 1; dz += 1) {
                        for (let dy = -1; dy <= 1; dy += 1) {
                            for (let dx = -1; dx <= 1; dx += 1) {
                                const nx = x + dx;
                                const ny = y + dy;
                                const nz = z + dz;
                                if (nx >= 0 && nx < grid.nx && ny >= 0 && ny < grid.ny && nz >= 0 && nz < grid.nz) {
                                    next[indexOf(grid, nx, ny, nz)] = 1;
                                }
                            }
                        }
                    }
                }
            }
        }
        grid.occupancy = next;
    }
}

function applyFloorFill(grid, mode) {
    if (mode === 'none' || mode === '0' || mode === 'false') {
        grid.floorFillMask = null;
        return { enabled: false };
    }

    const columnCount = grid.nx * grid.nz;
    const lowest = new Int16Array(columnCount);
    lowest.fill(-1);
    const histogram = new Map();

    for (let z = 0; z < grid.nz; z += 1) {
        for (let x = 0; x < grid.nx; x += 1) {
            for (let y = 0; y < grid.ny; y += 1) {
                if (!isSolid(grid, x, y, z)) {
                    continue;
                }
                const column = x + grid.nx * z;
                lowest[column] = y;
                const worldY = grid.minY + (y + 1) * grid.size;
                if (worldY >= -0.35 && worldY <= 0.35) {
                    histogram.set(y, (histogram.get(y) ?? 0) + 1);
                }
                break;
            }
        }
    }

    let floorIndex = -1;
    let floorVotes = 0;
    for (const [index, votes] of histogram) {
        if (votes > floorVotes) {
            floorIndex = index;
            floorVotes = votes;
        }
    }

    if (floorIndex < 0) {
        grid.floorFillMask = null;
        return { enabled: false, reason: 'no-low-floor-band' };
    }

    const evidence = [];
    for (let z = 0; z < grid.nz; z += 1) {
        for (let x = 0; x < grid.nx; x += 1) {
            const y = lowest[x + grid.nx * z];
            if (y >= 0 && y <= floorIndex + 2) {
                evidence.push([x, z]);
            }
        }
    }

    if (!evidence.length) {
        grid.floorFillMask = null;
        return { enabled: false, reason: 'no-floor-evidence' };
    }

    let minX = grid.nx;
    let maxX = -1;
    let minZ = grid.nz;
    let maxZ = -1;
    for (const [x, z] of evidence) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
    }

    const mask = new Uint8Array(columnCount);
    if (mode === 'mask') {
        for (const [x, z] of evidence) {
            mask[x + grid.nx * z] = 1;
        }
    } else {
        for (let z = minZ; z <= maxZ; z += 1) {
            for (let x = minX; x <= maxX; x += 1) {
                mask[x + grid.nx * z] = 1;
            }
        }
    }

    grid.floorFillMask = mask;
    grid.floorFillY = grid.minY + (floorIndex + 1) * grid.size;
    return {
        enabled: true,
        mode,
        floorIndex,
        floorY: grid.floorFillY,
        votes: floorVotes,
        evidenceColumns: evidence.length,
        filledColumns: countOccupied(mask),
        xRange: [grid.minX + minX * grid.size, grid.minX + (maxX + 1) * grid.size],
        zRange: [grid.minZ + minZ * grid.size, grid.minZ + (maxZ + 1) * grid.size]
    };
}

function buildVoxelMesh(grid) {
    const positions = [];
    const indices = [];
    let quads = 0;

    const addQuad = (a, b, c, d) => {
        const base = positions.length / 3;
        positions.push(...a, ...b, ...c, ...d);
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        quads += 1;
    };

    const world = (x, y, z) => [
        grid.minX + x * grid.size,
        grid.minY + y * grid.size,
        grid.minZ + z * grid.size
    ];

    if (grid.floorFillMask && Number.isFinite(grid.floorFillY)) {
        greedyMask(grid.nx, grid.nz, (x, z) => (
            grid.floorFillMask[x + grid.nx * z] !== 0
        ), (x, z, w, h) => {
            const y = grid.floorFillY;
            addQuad(
                [grid.minX + x * grid.size, y, grid.minZ + z * grid.size],
                [grid.minX + x * grid.size, y, grid.minZ + (z + h) * grid.size],
                [grid.minX + (x + w) * grid.size, y, grid.minZ + (z + h) * grid.size],
                [grid.minX + (x + w) * grid.size, y, grid.minZ + z * grid.size]
            );
        });
    }

    // Top faces are walkable surfaces. Bottom faces are skipped so ceilings do not create extra floors.
    for (let y = 0; y < grid.ny; y += 1) {
        greedyMask(grid.nx, grid.nz, (x, z) => (
            isSolid(grid, x, y, z) && !isSolid(grid, x, y + 1, z)
        ), (x, z, w, h) => {
            const yTop = y + 1;
            addQuad(
                world(x, yTop, z),
                world(x, yTop, z + h),
                world(x + w, yTop, z + h),
                world(x + w, yTop, z)
            );
        });
    }

    for (let x = 0; x < grid.nx; x += 1) {
        greedyMask(grid.nz, grid.ny, (z, y) => (
            isSolid(grid, x, y, z) && !isSolid(grid, x + 1, y, z)
        ), (z, y, w, h) => {
            const xSide = x + 1;
            addQuad(
                world(xSide, y, z),
                world(xSide, y + h, z),
                world(xSide, y + h, z + w),
                world(xSide, y, z + w)
            );
        });
        greedyMask(grid.nz, grid.ny, (z, y) => (
            isSolid(grid, x, y, z) && !isSolid(grid, x - 1, y, z)
        ), (z, y, w, h) => {
            addQuad(
                world(x, y, z),
                world(x, y, z + w),
                world(x, y + h, z + w),
                world(x, y + h, z)
            );
        });
    }

    for (let z = 0; z < grid.nz; z += 1) {
        greedyMask(grid.nx, grid.ny, (x, y) => (
            isSolid(grid, x, y, z) && !isSolid(grid, x, y, z + 1)
        ), (x, y, w, h) => {
            const zSide = z + 1;
            addQuad(
                world(x, y, zSide),
                world(x + w, y, zSide),
                world(x + w, y + h, zSide),
                world(x, y + h, zSide)
            );
        });
        greedyMask(grid.nx, grid.ny, (x, y) => (
            isSolid(grid, x, y, z) && !isSolid(grid, x, y, z - 1)
        ), (x, y, w, h) => {
            addQuad(
                world(x, y, z),
                world(x, y + h, z),
                world(x + w, y + h, z),
                world(x + w, y, z)
            );
        });
    }

    return {
        positions: new Float32Array(positions),
        indices: new Uint32Array(indices),
        quads
    };
}

function greedyMask(width, height, faceAt, emit) {
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            mask[x + width * y] = faceAt(x, y) ? 1 : 0;
        }
    }

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (!mask[x + width * y]) {
                continue;
            }

            let w = 1;
            while (x + w < width && mask[x + w + width * y]) {
                w += 1;
            }

            let h = 1;
            outer:
            while (y + h < height) {
                for (let dx = 0; dx < w; dx += 1) {
                    if (!mask[x + dx + width * (y + h)]) {
                        break outer;
                    }
                }
                h += 1;
            }

            for (let dy = 0; dy < h; dy += 1) {
                for (let dx = 0; dx < w; dx += 1) {
                    mask[x + dx + width * (y + dy)] = 0;
                }
            }

            emit(x, y, w, h);
        }
    }
}

function writeGlb(positions, indices) {
    const positionBuffer = Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength);
    const indexBuffer = Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength);
    const bin = pad4(Buffer.concat([positionBuffer, indexBuffer]));
    const positionBounds = boundsForPositions(positions);

    const json = {
        asset: {
            version: '2.0',
            generator: 'generate-meeting-splat-collision'
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
                count: positions.length / 3,
                type: 'VEC3',
                min: positionBounds.min,
                max: positionBounds.max
            },
            {
                bufferView: 1,
                componentType: 5125,
                count: indices.length,
                type: 'SCALAR',
                min: [0],
                max: [positions.length / 3 - 1]
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

    return Buffer.concat([header, jsonHeader, jsonBuffer, binHeader, bin]);
}

function boundsForPositions(positions) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
        for (let axis = 0; axis < 3; axis += 1) {
            min[axis] = Math.min(min[axis], positions[i + axis]);
            max[axis] = Math.max(max[axis], positions[i + axis]);
        }
    }
    return { min, max };
}

function pad4(buffer, fill = 0) {
    const padding = (4 - buffer.length % 4) % 4;
    return padding ? Buffer.concat([buffer, Buffer.alloc(padding, fill)]) : buffer;
}
