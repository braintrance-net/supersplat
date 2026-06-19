import {
    BLEND_NONE,
    BLEND_NORMAL,
    CULLFACE_BACK,
    CULLFACE_FRONT,
    CULLFACE_NONE,
    Color,
    Entity,
    Mesh,
    MeshInstance,
    PRIMITIVE_TRIANGLES,
    StandardMaterial,
    Vec3
} from 'playcanvas';

import { Element, ElementType } from './element';

type FaceStyle = {
    color: Color;
    opacity: number;
    blendType: number;
    depthWrite: boolean;
    depthTest: boolean;
    cull: number;
    visible: boolean;
    inset: number;
    fillOpacity: number;
    fillVisible: boolean;
};

type FaceDebug = {
    faceIndex: number;
    label: string;
    cornerIndices: readonly number[];
    relation: 'near' | 'far';
    distanceRank: number;
    axis: number;
    sign: 1 | -1;
    sideDot: number;
    normal: [number, number, number];
    facingDot: number;
    sideFacingCamera: 'outside/front' | 'inside/back';
    windingFacingCamera: 'front-winding' | 'back-winding';
    outsideNormal: [number, number, number];
    outsideFacingDot: number;
    geometricSideFacingCamera: 'outside' | 'inside';
    center: [number, number, number];
    distanceToCamera: number;
    material: {
        opacity: number;
        blendType: number;
        depthWrite: boolean;
        depthTest: boolean;
        drawOrder: number;
        drawBucket: number;
        visible: boolean;
        cull: number;
        doubleSided: boolean;
        inset: number;
        renderLayer: 'boxVolume';
        renderedWindingSide: 'front-winding only' | 'back-winding only' | 'dual-sided' | 'none';
        renderedGeometricSide: 'inside only' | 'outside only' | 'dual-sided' | 'none' | 'unknown';
        diffuse: [number, number, number];
    };
};

type BoxVolumeDebugSnapshot = {
    cameraPosition: [number, number, number];
    boxCenter: [number, number, number];
    cameraToCenter: [number, number, number];
    basisHandedness: number;
    frontWindingIsOutside: boolean;
    insideCull: number;
    nearFaces: number[];
    farFaces: number[];
    axisSides: {
        axis: number;
        sideDot: number;
        sign: 1 | -1;
        nearFaceIndex: number;
        farFaceIndex: number;
    }[];
    faces: FaceDebug[];
    compositeRisk: {
        nearFacesAreTransparent: boolean;
        lightFillEnabled: boolean;
        farFacesAreOpaque: boolean;
        farFacesUseOpaqueGreenHighlight: boolean;
        farFacesRenderBeforeSelectionUnderlay: boolean;
        farFacesDepthTestEnabled: boolean;
        note: string;
    };
};

const FACE_INDICES = [
    [0, 1, 2, 3],
    [4, 7, 6, 5],
    [0, 4, 5, 1],
    [1, 5, 6, 2],
    [2, 6, 7, 3],
    [3, 7, 4, 0]
] as const;

const FACE_BY_AXIS_SIGN = new Map<string, number>([
    ['1:-1', 0],
    ['1:1', 1],
    ['2:-1', 2],
    ['0:1', 3],
    ['2:1', 4],
    ['0:-1', 5]
]);

const FACE_LABELS = ['bottom', 'top', 'depth-', 'width+', 'depth+', 'width-'];
const FACE_AXIS_SIGN: [number, 1 | -1][] = [
    [1, -1],
    [1, 1],
    [2, -1],
    [0, 1],
    [2, 1],
    [0, -1]
];

const TRIANGLE_INDICES = [0, 1, 2, 0, 2, 3];
const colorFarGlass = new Color(0.19, 0.84, 1.0, 1);
const farFaceColors = [
    new Color(0.02, 0.34, 0.14, 1),
    new Color(0.02, 0.34, 0.14, 1),
    new Color(0.02, 0.34, 0.14, 1),
    new Color(0.02, 0.34, 0.14, 1),
    new Color(0.02, 0.34, 0.14, 1),
    new Color(0.02, 0.34, 0.14, 1)
];
const colorNearGlass = new Color(0.88, 0.98, 1.0, 1);
const colorVolumeFill = new Color(0.72, 0.96, 1.0, 1);
const NEAR_FACE_OPACITY = 0;
const FAR_FACE_OPACITY = 1;
const FAR_FACE_INSET = 1;
const BOX_VOLUME_FACE_DRAW_BUCKET = 129;
const cameraToCenter = new Vec3();
const localAxis = new Vec3();
const rankedFaceCenter = new Vec3();
const faceCenter = new Vec3();
const faceNormal = new Vec3();
const outsideFaceNormal = new Vec3();
const cameraPositionDebug = new Vec3();
const boxCenterDebug = new Vec3();
const cameraToCenterDebug = new Vec3();

const round = (value: number) => Number(value.toFixed(4));
const vecDebug = (value: Vec3): [number, number, number] => [round(value.x), round(value.y), round(value.z)];
const renderedWindingSide = (cull: number) => {
    if (cull === CULLFACE_NONE) return 'dual-sided';
    if (cull === CULLFACE_FRONT) return 'back-winding only';
    if (cull === CULLFACE_BACK) return 'front-winding only';
    return 'none';
};
const renderedGeometricSide = (cull: number, insideCull: number, outsideCull: number) => {
    if (cull === CULLFACE_NONE) return 'dual-sided';
    if (cull === insideCull) return 'inside only';
    if (cull === outsideCull) return 'outside only';
    return 'unknown';
};

class BoxVolumeShape extends Element {
    entity: Entity;
    meshes: Mesh[] = [];
    materials: StandardMaterial[] = [];
    meshInstances: MeshInstance[] = [];
    fillMaterials: StandardMaterial[] = [];
    fillMeshInstances: MeshInstance[] = [];
    initialized = false;
    private lastDebugSnapshot: BoxVolumeDebugSnapshot | null = null;

    constructor() {
        super(ElementType.debug);
        this.entity = new Entity('boxVolumeShape');
    }

    add() {
        const scene = this.scene;
        if (this.initialized) {
            scene.contentRoot.addChild(this.entity);
            return;
        }
        const device = scene.graphicsDevice;

        for (let i = 0; i < 6; i++) {
            const mesh = new Mesh(device);
            mesh.setPositions(new Float32Array(12));
            mesh.setIndices(TRIANGLE_INDICES);
            mesh.update(PRIMITIVE_TRIANGLES, true);

            const material = new StandardMaterial();
            material.useLighting = false;
            material.cull = CULLFACE_NONE;
            material.depthTest = true;
            material.diffuse.copy(colorFarGlass);
            material.emissive.copy(colorFarGlass);
            material.opacity = 0.3;
            material.blendType = BLEND_NORMAL;
            material.depthWrite = false;
            material.update();

            const fillMaterial = new StandardMaterial();
            fillMaterial.useLighting = false;
            fillMaterial.cull = CULLFACE_NONE;
            fillMaterial.depthTest = false;
            fillMaterial.depthWrite = false;
            fillMaterial.diffuse.copy(colorVolumeFill);
            fillMaterial.emissive.copy(colorVolumeFill);
            fillMaterial.opacity = 0.1;
            fillMaterial.blendType = BLEND_NORMAL;
            fillMaterial.update();

            const fillMeshInstance = new MeshInstance(mesh, fillMaterial, this.entity);
            fillMeshInstance.cull = false;
            fillMeshInstance.drawBucket = BOX_VOLUME_FACE_DRAW_BUCKET;
            fillMeshInstance.drawOrder = 150 + i;
            fillMeshInstance.visible = true;

            const meshInstance = new MeshInstance(mesh, material, this.entity);
            meshInstance.cull = false;
            meshInstance.drawBucket = BOX_VOLUME_FACE_DRAW_BUCKET;
            meshInstance.drawOrder = 100 + i;

            this.meshes.push(mesh);
            this.materials.push(material);
            this.meshInstances.push(meshInstance);
            this.fillMaterials.push(fillMaterial);
            this.fillMeshInstances.push(fillMeshInstance);
        }

        this.entity.addComponent('render', {
            meshInstances: [...this.meshInstances, ...this.fillMeshInstances],
            layers: [scene.boxVolumeLayer.id]
        });
        scene.contentRoot.addChild(this.entity);
        this.initialized = true;
    }

    remove() {
        this.entity.remove();
    }

    destroy() {
        this.entity.destroy();
    }

    setVisible(visible: boolean) {
        this.entity.enabled = visible;
    }

    update(corners: [number, number, number][], axes: Vec3[], center: Vec3, cameraPosition: Vec3) {
        cameraToCenter.sub2(cameraPosition, center);
        const nearFaces = new Set<number>();
        const axisSides: BoxVolumeDebugSnapshot['axisSides'] = [];
        for (let axis = 0; axis < 3; axis++) {
            localAxis.copy(axes[axis]);
            const side = cameraToCenter.dot(localAxis);
            const sign = side >= 0 ? 1 : -1;
            const nearFaceIndex = FACE_BY_AXIS_SIGN.get(`${axis}:${sign}`)!;
            const farFaceIndex = FACE_BY_AXIS_SIGN.get(`${axis}:${sign === 1 ? -1 : 1}`)!;
            nearFaces.add(nearFaceIndex);
            axisSides.push({
                axis,
                sideDot: round(side),
                sign,
                nearFaceIndex,
                farFaceIndex
            });
        }
        const faceDistanceRanks = FACE_INDICES
        .map((cornerIndices, faceIndex) => {
            rankedFaceCenter.set(0, 0, 0);
            for (const cornerIndex of cornerIndices) {
                const corner = corners[cornerIndex];
                rankedFaceCenter.x += corner[0];
                rankedFaceCenter.y += corner[1];
                rankedFaceCenter.z += corner[2];
            }
            rankedFaceCenter.mulScalar(1 / cornerIndices.length);
            const dx = rankedFaceCenter.x - cameraPosition.x;
            const dy = rankedFaceCenter.y - cameraPosition.y;
            const dz = rankedFaceCenter.z - cameraPosition.z;
            return {
                faceIndex,
                distanceSq: dx * dx + dy * dy + dz * dz
            };
        })
        .sort((a, b) => b.distanceSq - a.distanceSq)
        .map((face, index) => ({ ...face, rank: index + 1 }));
        const distanceRankByFace = new Map(faceDistanceRanks.map(face => [face.faceIndex, face.rank]));
        const farFaces = new Set(faceDistanceRanks.slice(0, 3).map(face => face.faceIndex));
        const basisHandedness =
            (axes[0].y * axes[1].z - axes[0].z * axes[1].y) * axes[2].x +
            (axes[0].z * axes[1].x - axes[0].x * axes[1].z) * axes[2].y +
            (axes[0].x * axes[1].y - axes[0].y * axes[1].x) * axes[2].z;
        const frontWindingIsOutside = basisHandedness > 0;
        const insideCull = frontWindingIsOutside ? CULLFACE_FRONT : CULLFACE_BACK;

        for (let faceIndex = 0; faceIndex < FACE_INDICES.length; faceIndex++) {
            const isFar = farFaces.has(faceIndex);
            const style: FaceStyle = isFar ? {
                color: farFaceColors[faceIndex] ?? colorFarGlass,
                opacity: FAR_FACE_OPACITY,
                blendType: BLEND_NONE,
                depthWrite: false,
                depthTest: true,
                cull: insideCull,
                visible: true,
                inset: FAR_FACE_INSET,
                fillOpacity: 0,
                fillVisible: false
            } : {
                color: colorNearGlass,
                opacity: NEAR_FACE_OPACITY,
                blendType: BLEND_NONE,
                depthWrite: false,
                depthTest: true,
                cull: insideCull,
                visible: false,
                inset: 1,
                fillOpacity: 0,
                fillVisible: false
            };
            this.updateFace(faceIndex, corners, style, !isFar);
        }

        cameraPositionDebug.copy(cameraPosition);
        boxCenterDebug.copy(center);
        cameraToCenterDebug.copy(cameraToCenter);
        this.lastDebugSnapshot = this.buildDebugSnapshot(corners, axes, nearFaces, farFaces, axisSides, {
            basisHandedness,
            frontWindingIsOutside,
            insideCull,
            distanceRankByFace
        });
    }

    getDebugSnapshot() {
        return this.lastDebugSnapshot;
    }

    private updateFace(faceIndex: number, corners: [number, number, number][], style: FaceStyle, isNear: boolean) {
        const face = FACE_INDICES[faceIndex];
        const positions = new Float32Array(12);
        let centerX = 0;
        let centerY = 0;
        let centerZ = 0;
        for (const cornerIndex of face) {
            const corner = corners[cornerIndex];
            centerX += corner[0];
            centerY += corner[1];
            centerZ += corner[2];
        }
        centerX /= face.length;
        centerY /= face.length;
        centerZ /= face.length;
        for (let i = 0; i < face.length; i++) {
            const corner = corners[face[i]];
            positions[i * 3] = centerX + (corner[0] - centerX) * style.inset;
            positions[i * 3 + 1] = centerY + (corner[1] - centerY) * style.inset;
            positions[i * 3 + 2] = centerZ + (corner[2] - centerZ) * style.inset;
        }
        const mesh = this.meshes[faceIndex];
        mesh.setPositions(positions);
        mesh.update(PRIMITIVE_TRIANGLES, true);

        const material = this.materials[faceIndex];
        material.diffuse.copy(style.color);
        material.emissive.copy(style.color);
        material.opacity = style.opacity;
        material.blendType = style.blendType;
        material.depthWrite = style.depthWrite;
        material.depthTest = style.depthTest;
        material.cull = style.cull;
        material.update();

        const fillMaterial = this.fillMaterials[faceIndex];
        fillMaterial.opacity = style.fillOpacity;
        fillMaterial.update();

        const fillMeshInstance = this.fillMeshInstances[faceIndex];
        fillMeshInstance.visible = style.fillVisible;
        fillMeshInstance.drawOrder = isNear ? 180 + faceIndex : 150 + faceIndex;

        const meshInstance = this.meshInstances[faceIndex];
        meshInstance.visible = style.visible;
        meshInstance.drawOrder = isNear ? 200 + faceIndex : 120 + faceIndex;
    }

    private buildDebugSnapshot(
        corners: [number, number, number][],
        axes: Vec3[],
        nearFaces: Set<number>,
        farFacesSet: Set<number>,
        axisSides: BoxVolumeDebugSnapshot['axisSides'],
        basis: Pick<BoxVolumeDebugSnapshot, 'basisHandedness' | 'frontWindingIsOutside' | 'insideCull'> & {
            distanceRankByFace: Map<number, number>;
        }
    ): BoxVolumeDebugSnapshot {
        const faces = FACE_INDICES.map((cornerIndices, faceIndex) => {
            faceCenter.set(0, 0, 0);
            for (const cornerIndex of cornerIndices) {
                const corner = corners[cornerIndex];
                faceCenter.x += corner[0];
                faceCenter.y += corner[1];
                faceCenter.z += corner[2];
            }
            faceCenter.mulScalar(1 / cornerIndices.length);
            const a = corners[cornerIndices[0]];
            const b = corners[cornerIndices[1]];
            const c = corners[cornerIndices[2]];
            const abx = b[0] - a[0];
            const aby = b[1] - a[1];
            const abz = b[2] - a[2];
            const acx = c[0] - a[0];
            const acy = c[1] - a[1];
            const acz = c[2] - a[2];
            faceNormal.set(
                aby * acz - abz * acy,
                abz * acx - abx * acz,
                abx * acy - aby * acx
            );
            if (faceNormal.lengthSq() > 0) {
                faceNormal.normalize();
            }
            const facingDot = faceNormal.x * (cameraPositionDebug.x - faceCenter.x) +
                faceNormal.y * (cameraPositionDebug.y - faceCenter.y) +
                faceNormal.z * (cameraPositionDebug.z - faceCenter.z);
            const material = this.materials[faceIndex];
            const meshInstance = this.meshInstances[faceIndex];
            const [axis, sign] = FACE_AXIS_SIGN[faceIndex];
            const side = axisSides.find(item => item.axis === axis);
            outsideFaceNormal.copy(axes[axis]).mulScalar(sign);
            if (outsideFaceNormal.lengthSq() > 0) {
                outsideFaceNormal.normalize();
            }
            const outsideFacingDot = outsideFaceNormal.x * (cameraPositionDebug.x - faceCenter.x) +
                outsideFaceNormal.y * (cameraPositionDebug.y - faceCenter.y) +
                outsideFaceNormal.z * (cameraPositionDebug.z - faceCenter.z);
            const outsideCull = basis.insideCull === CULLFACE_FRONT ? CULLFACE_BACK : CULLFACE_FRONT;

            return {
                faceIndex,
                label: FACE_LABELS[faceIndex],
                cornerIndices,
                relation: farFacesSet.has(faceIndex) ? 'far' : 'near',
                distanceRank: basis.distanceRankByFace.get(faceIndex) ?? 0,
                axis,
                sign,
                sideDot: side?.sideDot ?? 0,
                normal: vecDebug(faceNormal),
                facingDot: round(facingDot),
                sideFacingCamera: facingDot >= 0 ? 'outside/front' : 'inside/back',
                windingFacingCamera: facingDot >= 0 ? 'front-winding' : 'back-winding',
                outsideNormal: vecDebug(outsideFaceNormal),
                outsideFacingDot: round(outsideFacingDot),
                geometricSideFacingCamera: outsideFacingDot >= 0 ? 'outside' : 'inside',
                center: vecDebug(faceCenter),
                distanceToCamera: round(faceCenter.distance(cameraPositionDebug)),
                material: {
                    opacity: round(material.opacity),
                    blendType: material.blendType,
                    depthWrite: material.depthWrite,
                    depthTest: material.depthTest,
                    drawOrder: meshInstance.drawOrder,
                    drawBucket: meshInstance.drawBucket,
                    visible: meshInstance.visible,
                    cull: material.cull,
                    doubleSided: material.cull === CULLFACE_NONE,
                    inset: meshInstance.visible ? FAR_FACE_INSET : 1,
                    renderLayer: 'boxVolume',
                    renderedWindingSide: renderedWindingSide(material.cull),
                    renderedGeometricSide: renderedGeometricSide(material.cull, basis.insideCull, outsideCull),
                    diffuse: [
                        round(material.diffuse.r),
                        round(material.diffuse.g),
                        round(material.diffuse.b)
                    ]
                }
            } satisfies FaceDebug;
        });

        const farFaces = faces.filter(face => face.relation === 'far').map(face => face.faceIndex);
        const nearFaceIndices = faces.filter(face => face.relation === 'near').map(face => face.faceIndex);
        const nearFacesAreTransparent = faces
        .filter(face => face.relation === 'near')
        .every(face => face.material.opacity === 0 && !face.material.visible);
        const lightFillEnabled = this.fillMeshInstances.every(meshInstance => meshInstance.visible) &&
            this.fillMaterials.every(material => material.opacity > 0 && !material.depthWrite);
        const farFacesAreOpaque = faces
        .filter(face => face.relation === 'far')
        .every(face => face.material.opacity === 1 &&
            face.material.blendType === BLEND_NONE &&
            face.material.visible);
        const farFacesUseOpaqueGreenHighlight = faces
        .filter(face => face.relation === 'far')
        .every(face => face.material.opacity === FAR_FACE_OPACITY &&
            face.material.blendType === BLEND_NONE &&
            face.material.visible &&
            face.material.inset === FAR_FACE_INSET &&
            !face.material.depthWrite &&
            face.material.depthTest);
        const farFacesDepthTestEnabled = faces
        .filter(face => face.relation === 'far')
        .every(face => face.material.depthTest);

        return {
            cameraPosition: vecDebug(cameraPositionDebug),
            boxCenter: vecDebug(boxCenterDebug),
            cameraToCenter: vecDebug(cameraToCenterDebug),
            basisHandedness: round(basis.basisHandedness),
            frontWindingIsOutside: basis.frontWindingIsOutside,
            insideCull: basis.insideCull,
            nearFaces: nearFaceIndices,
            farFaces,
            axisSides,
            faces,
            compositeRisk: {
                nearFacesAreTransparent,
                lightFillEnabled,
                farFacesAreOpaque,
                farFacesUseOpaqueGreenHighlight,
                farFacesRenderBeforeSelectionUnderlay: true,
                farFacesDepthTestEnabled,
                note: 'The three farthest faces are full-size, non-blended dark green WebGL panels in the BoxVolume pass. The selected-gaussian underlay draws after them in the Gizmo pass, so selected gaussians remain visible over the back faces.'
            }
        };
    }
}

export { BoxVolumeShape, type BoxVolumeDebugSnapshot };
