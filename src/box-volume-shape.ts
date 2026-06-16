import {
    BLEND_NORMAL,
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
    depthWrite: boolean;
    transparent: boolean;
};

type FaceDebug = {
    faceIndex: number;
    label: string;
    cornerIndices: readonly number[];
    relation: 'near' | 'far';
    axis: number;
    sign: 1 | -1;
    sideDot: number;
    center: [number, number, number];
    distanceToCamera: number;
    material: {
        opacity: number;
        blendType: number;
        depthWrite: boolean;
        depthTest: boolean;
        drawOrder: number;
        diffuse: [number, number, number];
    };
};

type BoxVolumeDebugSnapshot = {
    cameraPosition: [number, number, number];
    boxCenter: [number, number, number];
    cameraToCenter: [number, number, number];
    nearFaces: number[];
    farFaces: number[];
    axisSides: {
        axis: number;
        sideDot: number;
        sign: 1 | -1;
        nearFaceIndex: number;
    }[];
    faces: FaceDebug[];
    compositeRisk: {
        nearFacesAreTransparent: boolean;
        lightFillEnabled: boolean;
        farFacesAreOpaque: boolean;
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
const colorNearGlass = new Color(0.88, 0.98, 1.0, 1);
const colorVolumeFill = new Color(0.72, 0.96, 1.0, 1);
const cameraToCenter = new Vec3();
const localAxis = new Vec3();
const faceCenter = new Vec3();
const cameraPositionDebug = new Vec3();
const boxCenterDebug = new Vec3();
const cameraToCenterDebug = new Vec3();

const round = (value: number) => Number(value.toFixed(4));
const vecDebug = (value: Vec3): [number, number, number] => [round(value.x), round(value.y), round(value.z)];

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
            fillMeshInstance.drawOrder = 150 + i;
            fillMeshInstance.visible = true;

            const meshInstance = new MeshInstance(mesh, material, this.entity);
            meshInstance.cull = false;
            meshInstance.drawOrder = 100 + i;

            this.meshes.push(mesh);
            this.materials.push(material);
            this.meshInstances.push(meshInstance);
            this.fillMaterials.push(fillMaterial);
            this.fillMeshInstances.push(fillMeshInstance);
        }

        this.entity.addComponent('render', {
            meshInstances: [...this.meshInstances, ...this.fillMeshInstances],
            layers: [scene.gizmoLayer.id]
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
            nearFaces.add(nearFaceIndex);
            axisSides.push({
                axis,
                sideDot: round(side),
                sign,
                nearFaceIndex
            });
        }

        for (let faceIndex = 0; faceIndex < FACE_INDICES.length; faceIndex++) {
            const style: FaceStyle = nearFaces.has(faceIndex) ? {
                color: colorNearGlass,
                opacity: 0.3,
                depthWrite: false,
                transparent: true
            } : {
                color: colorFarGlass,
                opacity: 0.3,
                depthWrite: false,
                transparent: true
            };
            this.updateFace(faceIndex, corners, style, nearFaces.has(faceIndex));
        }

        cameraPositionDebug.copy(cameraPosition);
        boxCenterDebug.copy(center);
        cameraToCenterDebug.copy(cameraToCenter);
        this.lastDebugSnapshot = this.buildDebugSnapshot(corners, nearFaces, axisSides);
    }

    getDebugSnapshot() {
        return this.lastDebugSnapshot;
    }

    private updateFace(faceIndex: number, corners: [number, number, number][], style: FaceStyle, isNear: boolean) {
        const face = FACE_INDICES[faceIndex];
        const positions = new Float32Array(12);
        for (let i = 0; i < face.length; i++) {
            const corner = corners[face[i]];
            positions[i * 3] = corner[0];
            positions[i * 3 + 1] = corner[1];
            positions[i * 3 + 2] = corner[2];
        }
        const mesh = this.meshes[faceIndex];
        mesh.setPositions(positions);
        mesh.update(PRIMITIVE_TRIANGLES, true);

        const material = this.materials[faceIndex];
        material.diffuse.copy(style.color);
        material.emissive.copy(style.color);
        material.opacity = style.opacity;
        material.blendType = BLEND_NORMAL;
        material.depthWrite = style.depthWrite;
        material.depthTest = !style.transparent;
        material.update();

        const fillMaterial = this.fillMaterials[faceIndex];
        fillMaterial.opacity = isNear ? 0.08 : 0.05;
        fillMaterial.update();

        const fillMeshInstance = this.fillMeshInstances[faceIndex];
        fillMeshInstance.visible = true;
        fillMeshInstance.drawOrder = isNear ? 180 + faceIndex : 150 + faceIndex;

        const meshInstance = this.meshInstances[faceIndex];
        meshInstance.drawOrder = isNear ? 200 + faceIndex : 100 + faceIndex;
    }

    private buildDebugSnapshot(
        corners: [number, number, number][],
        nearFaces: Set<number>,
        axisSides: BoxVolumeDebugSnapshot['axisSides']
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
            const material = this.materials[faceIndex];
            const meshInstance = this.meshInstances[faceIndex];
            const [axis, sign] = FACE_AXIS_SIGN[faceIndex];
            const side = axisSides.find(item => item.axis === axis);

            return {
                faceIndex,
                label: FACE_LABELS[faceIndex],
                cornerIndices,
                relation: nearFaces.has(faceIndex) ? 'near' : 'far',
                axis,
                sign,
                sideDot: side?.sideDot ?? 0,
                center: vecDebug(faceCenter),
                distanceToCamera: round(faceCenter.distance(cameraPositionDebug)),
                material: {
                    opacity: round(material.opacity),
                    blendType: material.blendType,
                    depthWrite: material.depthWrite,
                    depthTest: material.depthTest,
                    drawOrder: meshInstance.drawOrder,
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
        .every(face => face.material.opacity < 1 && !face.material.depthWrite);
        const lightFillEnabled = this.fillMeshInstances.every(meshInstance => meshInstance.visible) &&
            this.fillMaterials.every(material => material.opacity > 0 && !material.depthWrite);
        const farFacesAreOpaque = faces
        .filter(face => face.relation === 'far')
        .every(face => face.material.opacity === 1 && face.material.depthWrite);
        const farFacesDepthTestEnabled = faces
        .filter(face => face.relation === 'far')
        .every(face => face.material.depthTest);

        return {
            cameraPosition: vecDebug(cameraPositionDebug),
            boxCenter: vecDebug(boxCenterDebug),
            cameraToCenter: vecDebug(cameraToCenterDebug),
            nearFaces: nearFaceIndices,
            farFaces,
            axisSides,
            faces,
            compositeRisk: {
                nearFacesAreTransparent,
                lightFillEnabled,
                farFacesAreOpaque,
                farFacesDepthTestEnabled,
                note: 'All manual box faces are drawn as translucent UI glass; a faint fill layer gives the box interior volume.'
            }
        };
    }
}

export { BoxVolumeShape, type BoxVolumeDebugSnapshot };
