import {
    ADDRESS_CLAMP_TO_EDGE,
    BlendState,
    Layer,
    PIXELFORMAT_RGBA8,
    RenderTarget,
    Texture
} from 'playcanvas';

import { Element, ElementType } from './element';
import { vertexShader, fragmentShader } from './shaders/outline-shader';
import { ShaderQuad, SimpleRenderPass } from './utils/simple-render-pass';

class Outline extends Element {
    shaderQuad: ShaderQuad;
    renderPass: SimpleRenderPass;
    enabled = true;
    sceneCopyTexture: Texture = null;
    sceneCopyTarget: RenderTarget = null;

    constructor() {
        super(ElementType.other);
    }

    add() {
        const device = this.scene.app.graphicsDevice;

        this.shaderQuad = new ShaderQuad(device, vertexShader, fragmentShader, 'apply-outline');
        this.renderPass = new SimpleRenderPass(device, this.shaderQuad, {
            blendState: BlendState.ALPHABLEND
        });

        const clr = [1, 1, 1, 1];

        const { camera, events } = this.scene;

        camera.camera.on('postRenderLayer', (layer: Layer, transparent: boolean) => {
            // only apply when outline mode is enabled
            if (!this.enabled || !events.invoke('view.outlineSelection')) {
                return;
            }

            // apply at the end of the gizmo layer (after overlay renders)
            if (layer !== this.scene.gizmoLayer || !transparent) {
                return;
            }

            events.invoke('selectedClr').toArray(clr);

            // copy the current scene to a separate texture to avoid feedback loop
            const mainBuffer = camera.mainTarget.colorBuffer;
            if (!this.sceneCopyTexture || this.sceneCopyTexture.width !== mainBuffer.width || this.sceneCopyTexture.height !== mainBuffer.height) {
                this.sceneCopyTexture?.destroy();
                this.sceneCopyTarget?.destroy();

                this.sceneCopyTexture = new Texture(device, {
                    name: 'sceneCopy',
                    width: mainBuffer.width,
                    height: mainBuffer.height,
                    format: PIXELFORMAT_RGBA8,
                    addressU: ADDRESS_CLAMP_TO_EDGE,
                    addressV: ADDRESS_CLAMP_TO_EDGE,
                    mipmaps: false
                });

                this.sceneCopyTarget = new RenderTarget({
                    colorBuffer: this.sceneCopyTexture,
                    depth: false
                });
            }

            // blit scene to copy
            this.scene.dataProcessor.copyRt(camera.mainTarget, this.sceneCopyTarget);

            this.renderPass.execute({
                srcTexture: camera.workTarget.colorBuffer,
                sceneTexture: this.sceneCopyTexture,
                alphaCutoff: events.invoke('camera.mode') === 'rings' ? 0.0 : 0.8,
                clr
            });
        });
    }

    remove() {
        this.sceneCopyTexture?.destroy();
        this.sceneCopyTarget?.destroy();
    }

    onPreRender() {
        // no longer need to manage a separate camera
    }
}

export { Outline };
