import { Events } from './events';
import { Scene } from './scene';
import { BufferWriter } from './serialize/writer';
import { serializePly } from './splat-serialize';

/**
 * Checks if the app is running inside an iframe
 */
const isInIframe = (): boolean => {
    try {
        return window.self !== window.top;
    } catch (e) {
        return true;
    }
};

/**
 * Creates the Submit/Cancel buttons for iframe mode
 */
const createIframeControls = (events: Events, scene: Scene): { submit: HTMLButtonElement, cancel: HTMLButtonElement } => {
    const submitButton = document.createElement('button');
    submitButton.id = 'submit-splat-button';
    submitButton.textContent = 'Submit';
    submitButton.className = 'iframe-control-button';

    const cancelButton = document.createElement('button');
    cancelButton.id = 'cancel-splat-button';
    cancelButton.textContent = 'Cancel';
    cancelButton.className = 'iframe-control-button';

    document.body.appendChild(cancelButton);
    document.body.appendChild(submitButton);

    return { submit: submitButton, cancel: cancelButton };
};

/**
 * Captures a thumbnail using the render.offscreen() API
 */
const captureThumbnail = async (scene: Scene): Promise<Blob | null> => {
    try {
        const width = 512;
        const height = 512;

        // Use the render.offscreen() API to capture the current viewport
        const pixels = await scene.events.invoke('render.offscreen', width, height);

        if (!pixels) {
            console.error('[IframeIntegration] Failed to capture pixels from render.offscreen()');
            return null;
        }

        // Convert pixels to PNG blob
        return new Promise((resolve) => {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');

            if (!ctx) {
                resolve(null);
                return;
            }

            const imageData = ctx.createImageData(width, height);
            imageData.data.set(pixels);
            ctx.putImageData(imageData, 0, 0);

            canvas.toBlob((blob) => {
                resolve(blob);
            }, 'image/png');
        });
    } catch (error) {
        console.error('[IframeIntegration] Error capturing thumbnail:', error);
        return null;
    }
};

/**
 * Exports the PLY file from the scene
 */
const exportPly = async (events: Events): Promise<{ filename: string, data: ArrayBuffer } | null> => {
    try {
        // Get all splats from the scene
        const splats = events.invoke('scene.splats');

        if (!splats || splats.length === 0) {
            console.error('[IframeIntegration] No splats found in scene');
            return null;
        }

        // Use BufferWriter to capture PLY data in memory (no download)
        const bufferWriter = new BufferWriter();

        // Serialize PLY directly without showing popup
        await serializePly(splats, { maxSHBands: 3 }, bufferWriter);

        // Get the buffers and concatenate into a single ArrayBuffer
        const buffers = bufferWriter.close();

        // Calculate total size
        const totalSize = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);

        // Concatenate all buffers into one ArrayBuffer
        const arrayBuffer = new ArrayBuffer(totalSize);
        const uint8View = new Uint8Array(arrayBuffer);
        let offset = 0;
        for (const buf of buffers) {
            uint8View.set(buf, offset);
            offset += buf.byteLength;
        }

        // Get the filename from the first splat
        const filename = splats[0].filename || 'edited.ply';

        return {
            filename,
            data: arrayBuffer
        };
    } catch (error) {
        console.error('[IframeIntegration] Error exporting PLY:', error);
        return null;
    }
};

/**
 * Initializes iframe integration if running in an iframe
 */
export const initIframeIntegration = (events: Events, scene: Scene) => {
    if (!isInIframe()) {
        console.log('[IframeIntegration] Not in iframe, skipping integration');
        return;
    }

    console.log('[IframeIntegration] Detected iframe mode, initializing controls');

    const { submit, cancel } = createIframeControls(events, scene);

    // Handle Cancel button
    cancel.addEventListener('click', () => {
        console.log('[IframeIntegration] Cancel clicked');
        window.parent.postMessage({ type: 'splat-editor-cancel' }, '*');
    });

    // Handle Submit button
    submit.addEventListener('click', async () => {
        console.log('[IframeIntegration] Submit clicked, capturing thumbnail and exporting PLY');

        submit.disabled = true;
        cancel.disabled = true;
        submit.textContent = 'Processing...';

        try {
            // Capture thumbnail
            const thumbnail = await captureThumbnail(scene);
            if (!thumbnail) {
                throw new Error('Failed to capture thumbnail');
            }

            // Export PLY
            const plyData = await exportPly(events);
            if (!plyData) {
                throw new Error('Failed to export PLY');
            }

            // Send both to parent window
            window.parent.postMessage({
                type: 'splat-editor-submit',
                data: {
                    thumbnail: thumbnail,
                    plyFile: plyData.data,
                    filename: plyData.filename
                }
            }, '*');

            console.log('[IframeIntegration] Successfully sent thumbnail and PLY to parent');
        } catch (error) {
            console.error('[IframeIntegration] Error during submit:', error);
            window.parent.postMessage({
                type: 'splat-editor-error',
                error: error.message
            }, '*');

            submit.disabled = false;
            cancel.disabled = false;
            submit.textContent = 'Submit';
        }
    });

    // Notify parent that editor is ready
    window.parent.postMessage({ type: 'splat-editor-ready' }, '*');
    console.log('[IframeIntegration] Sent ready message to parent');
};
