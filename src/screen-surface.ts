import {
    ADDRESS_CLAMP_TO_EDGE,
    CULLFACE_NONE,
    FILTER_LINEAR,
    PIXELFORMAT_RGBA8,
    PRIMITIVE_TRIANGLES,
    Color,
    Entity,
    Mesh,
    MeshInstance,
    StandardMaterial,
    Texture
} from 'playcanvas';

import { Element, ElementType } from './element';

type Corner = { x: number; y: number; z: number };

type ScreenCorners = {
    topLeft: Corner;
    topRight: Corner;
    bottomLeft: Corner;
};

// Cyan stand-in shown on the plane before any video frame lands, so the surface
// placement is visible (and debuggable) even if frame upload is unavailable.
const debugColor = new Color(0.1, 0.85, 0.78);

// Renders the live screen-share video on a quad placed in the splat world.
// Driven from the meeting page via the iframe API: `screen.surface` sets the
// plane corners, `screen.frame` uploads a captured video frame, `screen.clear`
// hides it. The fourth corner is derived as topRight + (bottomLeft - topLeft)
// so the parent only has to calibrate three points.
class ScreenSurface extends Element {
    entity: Entity;
    mesh: Mesh;
    material: StandardMaterial;
    texture: Texture | null = null;
    meshInstance: MeshInstance;
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D | null;
    visible = false;
    hasFrame = false;

    constructor() {
        super(ElementType.debug);
    }

    add() {
        const device = this.scene.graphicsDevice;

        this.canvas = document.createElement('canvas');
        this.canvas.width = 16;
        this.canvas.height = 9;
        this.context = this.canvas.getContext('2d');

        // Unlit material. Starts as a solid debug color; swaps to the video texture
        // once frames arrive.
        this.material = new StandardMaterial();
        this.material.useLighting = false;
        this.material.diffuse = new Color(0, 0, 0);
        this.material.emissive = debugColor;
        this.material.cull = CULLFACE_NONE;
        this.material.update();

        this.mesh = new Mesh(device);
        this.writeQuad({ topLeft: { x: 0, y: 0, z: 0 }, topRight: { x: 0, y: 0, z: 0 }, bottomLeft: { x: 0, y: 0, z: 0 } });

        this.meshInstance = new MeshInstance(this.mesh, this.material);
        this.meshInstance.cull = false;

        this.entity = new Entity('screenShareSurface');
        this.entity.addComponent('render', {
            meshInstances: [this.meshInstance],
            layers: [this.scene.worldLayer.id]
        });
        this.entity.enabled = false;
        this.scene.contentRoot.addChild(this.entity);

        const { events } = this.scene;
        events.on('screen.surface', (corners: ScreenCorners | null) => this.setSurface(corners));
        events.on('screen.frame', (bitmap: ImageBitmap) => this.setFrame(bitmap));
        events.on('screen.clear', () => this.clear());
    }

    // Quad vertex order: topLeft, topRight, bottomRight, bottomLeft. The top edge
    // samples the top of the frame (V=0) so the video reads upright.
    writeQuad(corners: ScreenCorners) {
        const bottomRight = {
            x: corners.topRight.x + (corners.bottomLeft.x - corners.topLeft.x),
            y: corners.topRight.y + (corners.bottomLeft.y - corners.topLeft.y),
            z: corners.topRight.z + (corners.bottomLeft.z - corners.topLeft.z)
        };

        this.mesh.setPositions([
            corners.topLeft.x, corners.topLeft.y, corners.topLeft.z,
            corners.topRight.x, corners.topRight.y, corners.topRight.z,
            bottomRight.x, bottomRight.y, bottomRight.z,
            corners.bottomLeft.x, corners.bottomLeft.y, corners.bottomLeft.z
        ]);
        this.mesh.setUvs(0, [0, 0, 1, 0, 1, 1, 0, 1]);
        this.mesh.setIndices([0, 1, 2, 0, 2, 3]);
        this.mesh.update(PRIMITIVE_TRIANGLES);
    }

    setSurface(corners: ScreenCorners | null) {
        if (!corners) {
            this.clear();
            return;
        }

        this.writeQuad(corners);
        this.visible = true;
        this.entity.enabled = true;
        this.scene.forceRender = true;
    }

    // (Re)allocate the texture to match the incoming frame size. Reusing a
    // wrong-sized texture causes a texSubImage size-mismatch and an empty plane.
    private ensureTexture(width: number, height: number) {
        if (this.texture && this.texture.width === width && this.texture.height === height) {
            if (this.material.emissiveMap !== this.texture) {
                this.material.emissive = new Color(1, 1, 1);
                this.material.emissiveMap = this.texture;
                this.material.update();
            }
            return;
        }

        this.texture?.destroy();
        this.texture = new Texture(this.scene.graphicsDevice, {
            name: 'screenShareSurface',
            width,
            height,
            format: PIXELFORMAT_RGBA8,
            mipmaps: false,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE,
            minFilter: FILTER_LINEAR,
            magFilter: FILTER_LINEAR
        });
        this.material.emissive = new Color(1, 1, 1);
        this.material.emissiveMap = this.texture;
        this.material.update();
    }

    setFrame(bitmap: ImageBitmap) {
        if (!bitmap || !this.context) return;

        const width = bitmap.width;
        const height = bitmap.height;
        if (width === 0 || height === 0) {
            bitmap.close?.();
            return;
        }

        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
        this.context.drawImage(bitmap, 0, 0);
        bitmap.close?.();

        this.ensureTexture(width, height);
        this.texture?.setSource(this.canvas);
        this.hasFrame = true;

        if (this.visible) {
            this.scene.forceRender = true;
        }
    }

    clear() {
        this.visible = false;
        this.hasFrame = false;
        if (this.entity) {
            this.entity.enabled = false;
        }
        // Reset to the debug colour so a re-share is visible before frames resume.
        this.material.emissive = debugColor;
        this.material.emissiveMap = null;
        this.material.update();
        this.scene.forceRender = true;
    }

    destroy() {
        this.entity?.destroy();
        this.texture?.destroy();
    }
}

export { ScreenSurface };
