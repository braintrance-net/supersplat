import { WebPCodec } from '@playcanvas/splat-transform';
import { Color, createGraphicsDevice, Vec3 } from 'playcanvas';

import { registerArtisanGsLocalEvents } from './artisan-gs-local';
import { registerCameraPosesEvents } from './camera-poses';
import { registerDocEvents } from './doc';
import { EditHistory } from './edit-history';
import { registerEditorEvents } from './editor';
import { Events } from './events';
import { initFileHandler } from './file-handler';
import { registerIframeApi } from './iframe-api';
import { registerPlySequenceEvents } from './ply-sequence';
import { registerPointCloudBoundaryEvents } from './point-cloud-boundary-controller';
import { registerPublishEvents } from './publish';
import { registerRenderEvents } from './render';
import { Scene } from './scene';
import { getSceneConfig } from './scene-config';
import { registerSelectionEvents } from './selection';
import { registerSemanticAnnotationEvents } from './semantic-annotations';
import { registerSemanticPreprocessEvents } from './semantic-preprocess';
import { registerSemanticScanEvents } from './semantic-scan';
import { ShortcutManager } from './shortcut-manager';
import { registerTimelineEvents } from './timeline';
import { ArtisanBrushSelection } from './tools/artisan-brush-selection';
import { ArtisanClickSelection } from './tools/artisan-click-selection';
import { BoxSelection } from './tools/box-selection';
import { BoxVolumeTool } from './tools/box-volume-tool';
import { BoxerSelection } from './tools/boxer-selection';
import { BrushSelection } from './tools/brush-selection';
import { EyedropperSelection } from './tools/eyedropper-selection';
import { FloodSelection } from './tools/flood-selection';
import { LassoSelection } from './tools/lasso-selection';
import { LocalSegmentSelection } from './tools/local-segment-selection';
import { MeasureTool } from './tools/measure-tool';
import { MoveTool } from './tools/move-tool';
import { MultiViewRefineSelection } from './tools/multi-view-refine-selection';
import { PlaceTool } from './tools/place-tool';
import { PolygonSelection } from './tools/polygon-selection';
import { RectSelection } from './tools/rect-selection';
import { RotateTool } from './tools/rotate-tool';
import { Sam3Selection } from './tools/sam3-selection';
import { ScaleTool } from './tools/scale-tool';
import { SphereSelection } from './tools/sphere-selection';
import { ToolManager } from './tools/tool-manager';
import { WalkTool } from './tools/walk-tool';
import { registerTransformHandlerEvents } from './transform-handler';
import { EditorUI } from './ui/editor';
import { EvalCasePanel } from './ui/eval-case-panel';
import { localizeInit } from './ui/localization';
import { SemanticAnnotationOverlay } from './ui/semantic-annotation-overlay';
import { registerCollisionSurfaceLoader } from './utils/collision-surface';
import { VoiceController } from './voice/voice-controller';

type DebugCameraState = {
    position: { x: number, y: number, z: number };
    target: { x: number, y: number, z: number };
    fov: number;
    azim: number;
    elevation: number;
    distance: number;
    ortho: boolean;
};

declare global {
    interface LaunchParams {
        readonly files: FileSystemFileHandle[];
    }

    interface Window {
        launchQueue: {
            setConsumer: (callback: (launchParams: LaunchParams) => void) => void;
        };
        scene: Scene;
        supersplatConfig?: {
            defaultLoadUrl?: string;
            defaultCamera?: {
                position: { x: number, y: number, z: number };
                target: { x: number, y: number, z: number };
                fov?: number;
                ortho?: boolean;
            };
            boxerBackendUrl?: string;
            boxerGpuDepth?: boolean;
            sam3BackendUrl?: string;
            artisanGsBackendUrl?: string;
            semanticScanBackendUrl?: string;
            sketchfabProxyBaseUrl?: string;
            openAiProxyBaseUrl?: string;
            enableDevTools?: boolean;
            artisanPreserveDrawingBuffer?: boolean;
            sketchfabApiToken?: string;
            openaiApiKey?: string;
        };
        supersplatDebug?: {
            getCameraState: () => DebugCameraState;
            setCameraState: (camera: DebugCameraState) => DebugCameraState;
            copyCameraState: () => Promise<string>;
            getPresetState: () => {
                camera: DebugCameraState;
                splatTransform: {
                    position: { x: number, y: number, z: number };
                    rotationEuler: { x: number, y: number, z: number };
                    scale: { x: number, y: number, z: number };
                } | null;
            };
            copyPresetState: () => Promise<string>;
            runBoxerEvalCase: (evalCase: unknown) => Promise<unknown>;
            runBoxerEvalFusion: (payload: unknown) => Promise<unknown>;
            runBoxerDetectAll: () => Promise<unknown>;
            copyBoxerEvalCase: (payload?: unknown) => Promise<unknown>;
            copyBoxerClickTestCase: (payload?: unknown) => Promise<unknown>;
            getLastBrushBoxerPrompt: () => unknown;
            runLastBrushBoxer: (payload?: unknown) => Promise<unknown>;
            copyLastBrushBoxerEvalCase: (payload?: unknown) => Promise<unknown>;
            getLiveBrushFusionViews: () => unknown;
            getLiveBrushFusionStatus: () => unknown;
            clearLiveBrushFusion: () => unknown;
            getBrushSelectionRadius: () => unknown;
            setBrushSelectionRadius: (value: number) => unknown;
            setBoxerEvalTarget: (payload?: unknown) => unknown;
            getBoxerEvalTarget: () => unknown;
            clearBoxerEvalTarget: () => unknown;
            getBoxSelectionState: () => unknown;
            getBoxSelectionTarget: () => unknown;
            setBoxSelectionTarget: (payload?: unknown) => unknown;
            confirmBoxSelectionTarget: () => unknown;
            getBoxVolumeState: () => unknown;
            getBoxVolumeTarget: () => unknown;
            getSceneSplatSummary: () => unknown;
            selectFirstSplat: () => unknown;
            getArtisanDebugViews: () => unknown;
            getArtisanStatus: () => unknown;
            cancelArtisanRun: () => unknown;
            showArtisanDebugViews: () => unknown;
            hideArtisanDebugViews: () => unknown;
            getArtisanClickConfig: () => unknown;
            setArtisanClickConfig: (patch?: unknown) => unknown;
            runArtisanClick: (options?: {
                click_xy?: [number, number];
                x?: number;
                y?: number;
                selectionMode?: 'set' | 'add' | 'remove' | 'intersect';
                runLocal?: boolean;
                reviewSeedMask?: boolean;
                localOptions?: Record<string, unknown>;
                includeReview?: boolean;
                includeImages?: boolean;
            }) => Promise<unknown>;
            runArtisanDebugPlan: (options?: { frameCount?: number; candidateCheckBudget?: number; targetBounds?: unknown }) => Promise<unknown>;
            exportArtisanDebugReview: (options?: { includeImages?: boolean; includeEvalCase?: boolean }) => unknown;
            exportArtisanTestSuite: (options?: { includeImages?: boolean; includeEvalCase?: boolean; allowSyntheticTarget?: boolean; primarySelection?: unknown; primary_selection?: unknown }) => unknown;
            downloadArtisanTestSuite: (options?: { includeImages?: boolean; includeEvalCase?: boolean; allowSyntheticTarget?: boolean; primarySelection?: unknown; primary_selection?: unknown }) => unknown;
            exportArtisanEvalCase: (options?: {
                includeReview?: boolean;
                includeImages?: boolean;
                target?: unknown;
                thresholds?: unknown;
                primarySelection?: 'editor_state' | 'object_selected' | 'target_bounded_posterior' | 'target_bounded_adaptive' | 'target_bounded_base' | 'target_bounded_loose' | 'target_volume' | 'final_thresholded' | 'all_voted' | 'confidence_thresholded' | 'posterior_filtered';
                primary_selection?: 'editor_state' | 'object_selected' | 'target_bounded_posterior' | 'target_bounded_adaptive' | 'target_bounded_base' | 'target_bounded_loose' | 'target_volume' | 'final_thresholded' | 'all_voted' | 'confidence_thresholded' | 'posterior_filtered';
            }) => unknown;
            getArtisanEvalTarget: (options?: unknown) => unknown;
            setArtisanEvalTarget: (payload?: unknown) => unknown;
            clearArtisanEvalTarget: () => unknown;
            useKnownDeskCanEvalTarget: () => unknown;
            prepareArtisanManualBoxEvalSuiteDownload: () => unknown;
            startArtisanFourClickEvalBox: (options?: { downloadSuite?: boolean; download_suite?: boolean; includeImages?: boolean; includeEvalCase?: boolean; editAfterCapture?: boolean; edit_after_capture?: boolean; projectionMode?: 'frustum' | 'surface' | 'connected-surface'; projection_mode?: 'frustum' | 'surface' | 'connected-surface'; points?: [number, number][] }) => Promise<unknown>;
            restoreArtisanActiveObject: (options?: { mode?: 'final' | 'voted' | 'confidence' | 'posterior' | 'target_bounded_adaptive' | 'target_bounded_base' | 'target_bounded_loose' | 'target_volume' }) => Promise<unknown>;
            getArtisanSelectionDiagnostics: (options?: { thresholds?: number[] }) => unknown;
            runArtisanEvalCase: (evalCase: unknown, options?: {
                includeImages?: boolean;
                restoreCamera?: boolean;
                allowUnreadyTarget?: boolean;
                localOptions?: Record<string, unknown>;
            }) => Promise<unknown>;
            backtestArtisanDebugReview: (review: unknown, options?: { frameCount?: number; candidateCheckBudget?: number }) => Promise<unknown>;
            getWalkCollisionDebug: () => unknown;
            getVoxelMeshVisualization: () => unknown;
            setWalkInput: (input?: Record<string, unknown>) => void;
            clearWalkInput: () => void;
            probeVisibleCanvasCapture: (options?: { includeStats?: boolean; mimeType?: string; quality?: number }) => Promise<unknown>;
            getLocalSegmentStatus: () => unknown;
            getLastSegmentationCompare: () => unknown;
            getSegmentationCompareBundles: () => unknown;
            getPointCloudBoundary: () => unknown;
            setPointCloudBoundary: (settings: unknown) => unknown;
            getPointCloudBoundaryDiagnostics: () => unknown;
            benchmarkPointCloudBoundary: (options?: { samples?: number }) => Promise<unknown>;
        };
    }
}

const getURLArgs = () => {
    // extract settings from command line in non-prod builds only
    const config = {};

    const apply = (key: string, value: string) => {
        let obj: any = config;
        key.split('.').forEach((k, i, a) => {
            if (i === a.length - 1) {
                obj[k] = value;
            } else {
                if (!obj.hasOwnProperty(k)) {
                    obj[k] = {};
                }
                obj = obj[k];
            }
        });
    };

    const params = new URLSearchParams(window.location.search.slice(1));
    params.forEach((value: string, key: string) => {
        apply(key, value);
    });

    return config;
};

const getFilenameFromUrl = (value: string) => {
    const pathname = new URL(value, window.location.href).pathname;
    const filename = pathname.split('/').pop();
    return filename || 'default.ply';
};

const truthyUrlFlag = (value: string | null) => {
    return value === '' || value === '1' || value === 'true' || value === 'yes';
};

const main = async () => {
    // root events object
    const events = new Events();
    events.function('tool.active', () => null);

    // url
    const url = new URL(window.location.href);
    const devConfig = window.supersplatConfig ?? {};

    // edit history
    const editHistory = new EditHistory(events);

    // init localization
    await localizeInit();

    // Configure WebP WASM for SOG format (used for both reading and writing)
    WebPCodec.wasmUrl = new URL('static/lib/webp/webp.wasm', document.baseURI).toString();

    // register events that only need the events object (before UI is created)
    registerTimelineEvents(events);
    registerCameraPosesEvents(events);
    registerTransformHandlerEvents(events);
    registerPlySequenceEvents(events);
    registerPublishEvents(events);
    registerSemanticAnnotationEvents(events);

    // initialize shortcuts
    const shortcutManager = new ShortcutManager(events);
    events.function('shortcutManager', () => shortcutManager);

    // editor ui
    const editorUI = new EditorUI(events);

    events.function('config.devToolsEnabled', () => !!devConfig.enableDevTools);
    const preserveDrawingBufferParam = url.searchParams.get('artisanPreserveDrawingBuffer');
    const preserveDrawingBuffer = devConfig.artisanPreserveDrawingBuffer === true ||
        truthyUrlFlag(preserveDrawingBufferParam) ||
        truthyUrlFlag(url.searchParams.get('artisanDirectPngCapture')) ||
        truthyUrlFlag(url.searchParams.get('artisanVisibleCapture'));
    events.function('config.artisanPreserveDrawingBuffer', () => preserveDrawingBuffer);

    // create the graphics device
    const graphicsDeviceOptions = {
        deviceTypes: ['webgl2'],
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer,
        xrCompatible: false,
        powerPreference: 'high-performance'
    } as Parameters<typeof createGraphicsDevice>[1] & { preserveDrawingBuffer?: boolean };
    const graphicsDevice = await createGraphicsDevice(editorUI.canvas, graphicsDeviceOptions);

    const overrides = [
        getURLArgs()
    ];

    // resolve scene config
    const sceneConfig = getSceneConfig(overrides);

    // construct the manager
    const scene = new Scene(
        events,
        sceneConfig,
        editorUI.canvas,
        graphicsDevice
    );
    registerPointCloudBoundaryEvents(events, scene);
    registerArtisanGsLocalEvents(events, scene);

    // colors
    const bgClr = new Color();
    const selectedClr = new Color();
    const unselectedClr = new Color();
    const lockedClr = new Color();

    const setClr = (target: Color, value: Color, event: string) => {
        if (!target.equals(value)) {
            target.copy(value);
            events.fire(event, target);
        }
    };

    const setBgClr = (clr: Color) => {
        setClr(bgClr, clr, 'bgClr');
    };
    const setSelectedClr = (clr: Color) => {
        setClr(selectedClr, clr, 'selectedClr');
    };
    const setUnselectedClr = (clr: Color) => {
        setClr(unselectedClr, clr, 'unselectedClr');
    };
    const setLockedClr = (clr: Color) => {
        setClr(lockedClr, clr, 'lockedClr');
    };

    events.on('setBgClr', (clr: Color) => {
        setBgClr(clr);
    });
    events.on('setSelectedClr', (clr: Color) => {
        setSelectedClr(clr);
    });
    events.on('setUnselectedClr', (clr: Color) => {
        setUnselectedClr(clr);
    });
    events.on('setLockedClr', (clr: Color) => {
        setLockedClr(clr);
    });

    events.function('bgClr', () => {
        return bgClr;
    });
    events.function('selectedClr', () => {
        return selectedClr;
    });
    events.function('unselectedClr', () => {
        return unselectedClr;
    });
    events.function('lockedClr', () => {
        return lockedClr;
    });

    events.on('bgClr', (clr: Color) => {
        const cnv = (v: number) => `${Math.max(0, Math.min(255, (v * 255))).toFixed(0)}`;
        document.body.style.backgroundColor = `rgba(${cnv(clr.r)},${cnv(clr.g)},${cnv(clr.b)},1)`;
    });
    events.on('selectedClr', (clr: Color) => {
        scene.forceRender = true;
    });
    events.on('unselectedClr', (clr: Color) => {
        scene.forceRender = true;
    });
    events.on('lockedClr', (clr: Color) => {
        scene.forceRender = true;
    });

    // initialize colors from application config
    const toColor = (value: { r: number, g: number, b: number, a: number }) => {
        return new Color(value.r, value.g, value.b, value.a);
    };
    setBgClr(toColor(sceneConfig.bgClr));
    setSelectedClr(toColor(sceneConfig.selectedClr));
    setUnselectedClr(toColor(sceneConfig.unselectedClr));
    setLockedClr(toColor(sceneConfig.lockedClr));

    // create the mask selection canvas
    const maskCanvas = document.createElement('canvas');
    const maskContext = maskCanvas.getContext('2d');
    maskCanvas.setAttribute('id', 'mask-canvas');
    maskContext.globalCompositeOperation = 'copy';

    const mask = {
        canvas: maskCanvas,
        context: maskContext
    };

    // load collision surface sidecars for brush/boxer 3D anchoring
    registerCollisionSurfaceLoader(events, scene);

    // dev-only eval case browser/editor
    if (devConfig.enableDevTools) {
        const evalCasePanel = new EvalCasePanel(events);
        events.function('evalCasePanel', () => evalCasePanel);
    }

    // tool manager
    const toolManager = new ToolManager(events);
    toolManager.register('rectSelection', new RectSelection(events, editorUI.toolsContainer.dom));
    toolManager.register('brushSelection', new BrushSelection(events, editorUI.toolsContainer.dom, mask));
    toolManager.register('artisanBrushSelection', new ArtisanBrushSelection(events, scene, editorUI.toolsContainer.dom, mask));
    toolManager.register('floodSelection', new FloodSelection(events, editorUI.toolsContainer.dom, mask, editorUI.canvasContainer));
    toolManager.register('polygonSelection', new PolygonSelection(events, editorUI.toolsContainer.dom, mask));
    toolManager.register('lassoSelection', new LassoSelection(events, editorUI.toolsContainer.dom, mask));
    toolManager.register('sphereSelection', new SphereSelection(events, scene, editorUI.canvasContainer));
    toolManager.register('boxSelection', new BoxSelection(events, scene, editorUI.canvasContainer));
    toolManager.register('boxVolume', new BoxVolumeTool(events, scene, editorUI.canvasContainer));
    toolManager.register('boxerSelection', new BoxerSelection(events, scene, editorUI.canvasContainer.dom));
    toolManager.register('sam3Selection', new Sam3Selection(events, scene, editorUI.canvasContainer.dom));
    toolManager.register('localSegmentSelection', new LocalSegmentSelection(events, scene, editorUI.canvasContainer.dom));
    toolManager.register('artisanClickSelection', new ArtisanClickSelection(events, scene, editorUI.canvasContainer.dom));
    toolManager.register('multiViewRefineSelection', new MultiViewRefineSelection(events, scene, editorUI.canvasContainer.dom));
    toolManager.register('eyedropperSelection', new EyedropperSelection(events, editorUI.toolsContainer.dom, editorUI.canvasContainer));
    toolManager.register('move', new MoveTool(events, scene));
    toolManager.register('rotate', new RotateTool(events, scene));
    toolManager.register('scale', new ScaleTool(events, scene));
    toolManager.register('measure', new MeasureTool(events, scene, editorUI.toolsContainer.dom, editorUI.canvasContainer));
    toolManager.register('walk', new WalkTool(events, scene, editorUI.canvasContainer.dom));
    toolManager.register('place', new PlaceTool(events, scene, editorUI.canvasContainer.dom));

    editorUI.toolsContainer.dom.appendChild(maskCanvas);
    const semanticAnnotationOverlay = new SemanticAnnotationOverlay(events, scene, editorUI.canvasContainer.dom);

    // Walk mode is the default tool
    events.fire('tool.walk');

    window.scene = scene;

    // register events that need scene or other dependencies
    registerEditorEvents(events, editHistory, scene);
    registerSelectionEvents(events, scene);
    registerDocEvents(scene, events);
    registerRenderEvents(scene, events);
    registerSemanticScanEvents(events, scene);
    registerSemanticPreprocessEvents(events, scene);
    initFileHandler(scene, events, editorUI.appContainer.dom);

    const getCameraState = () => {
        return events.invoke('camera.debugState') as DebugCameraState;
    };
    const setCameraState = (camera: DebugCameraState) => {
        scene.camera.setPose(
            new Vec3(camera.position.x, camera.position.y, camera.position.z),
            new Vec3(camera.target.x, camera.target.y, camera.target.z),
            0
        );
        events.fire('camera.setFov', camera.fov);
        scene.camera.ortho = camera.ortho;
        scene.camera.onUpdate(0);
        scene.forceRender = true;
        return getCameraState();
    };

    const getPresetState = () => {
        const splats = events.invoke('scene.splats') as Array<any>;
        const splat = splats?.[0];

        return {
            camera: getCameraState(),
            splatTransform: splat ? {
                position: (() => {
                    const value = splat.entity.getLocalPosition();
                    return { x: value.x, y: value.y, z: value.z };
                })(),
                rotationEuler: (() => {
                    const value = splat.entity.getLocalEulerAngles();
                    return { x: value.x, y: value.y, z: value.z };
                })(),
                scale: (() => {
                    const value = splat.entity.getLocalScale();
                    return { x: value.x, y: value.y, z: value.z };
                })()
            } : null
        };
    };
    const getSceneSplats = () => (events.invoke('scene.splats') as Array<any> | undefined) ?? [];
    const summarizeSceneSplat = (splat: any, index: number, selected: any) => ({
        index,
        selected: splat === selected,
        visible: splat?.visible !== false,
        name: splat?.name ?? null,
        filename: splat?.filename ?? null,
        num_splats: splat?.splatData?.numSplats ?? null
    });
    const getSceneSplatSummary = () => {
        const splats = getSceneSplats();
        const selected = events.invoke('selection') as any;
        return {
            count: splats.length,
            selected_index: splats.indexOf(selected),
            splats: splats.map((splat, index) => summarizeSceneSplat(splat, index, selected))
        };
    };
    const selectFirstSplat = () => {
        const splats = getSceneSplats();
        const splat = splats.find(candidate => candidate?.visible !== false);
        if (!splat) {
            return { ok: false, error: 'No splat loaded.' };
        }

        events.fire('selection', splat);
        return {
            ok: true,
            selected: summarizeSceneSplat(splat, splats.indexOf(splat), splat),
            summary: getSceneSplatSummary()
        };
    };

    events.function('preset.debugState', () => {
        return getPresetState();
    });

    window.supersplatDebug = {
        getCameraState,
        setCameraState,
        copyCameraState: async () => {
            const json = JSON.stringify(getCameraState(), null, 2);
            console.log('SuperSplat camera state\n', json);
            await navigator.clipboard.writeText(json).catch(() => {});
            return json;
        },
        getPresetState,
        copyPresetState: async () => {
            const json = JSON.stringify(getPresetState(), null, 2);
            console.log('SuperSplat preset state\n', json);
            await navigator.clipboard.writeText(json).catch(() => {});
            return json;
        },
        runBoxerEvalCase: (evalCase: unknown) => {
            return events.invoke('boxer.runEvalCase', evalCase);
        },
        runBoxerEvalFusion: (payload: unknown) => {
            return events.invoke('boxer.runEvalFusion', payload);
        },
        runBoxerDetectAll: () => {
            return events.invoke('boxer.runDetectAll');
        },
        copyBoxerEvalCase: (payload?: unknown) => {
            return events.invoke('boxer.copyEvalCase', payload);
        },
        copyBoxerClickTestCase: (payload?: unknown) => {
            return events.invoke('boxer.copyClickTestCase', payload);
        },
        getLastBrushBoxerPrompt: () => {
            return events.invoke('boxer.getLastBrushPrompt');
        },
        runLastBrushBoxer: (payload?: unknown) => {
            return events.invoke('boxer.runLastBrush', payload);
        },
        copyLastBrushBoxerEvalCase: (payload?: unknown) => {
            return events.invoke('boxer.copyLastBrushEvalCase', payload);
        },
        getLiveBrushFusionViews: () => {
            return events.invoke('boxer.getLiveBrushFusionViews');
        },
        getLiveBrushFusionStatus: () => {
            return events.invoke('boxer.getLiveBrushFusionStatus');
        },
        clearLiveBrushFusion: () => {
            return events.invoke('boxer.clearLiveBrushFusion');
        },
        getBrushSelectionRadius: () => {
            return events.invoke('brushSelection.getRadius');
        },
        setBrushSelectionRadius: (value: number) => {
            return events.invoke('brushSelection.setRadius', value);
        },
        setBoxerEvalTarget: (payload?: unknown) => {
            return events.invoke('boxer.setStickyEvalTarget', payload);
        },
        getBoxerEvalTarget: () => {
            return events.invoke('boxer.currentEvalTarget');
        },
        clearBoxerEvalTarget: () => {
            return events.invoke('boxer.clearEvalTarget');
        },
        getBoxSelectionState: () => {
            return events.invoke('boxSelection.state');
        },
        getBoxSelectionTarget: () => {
            return events.invoke('boxSelection.currentBox');
        },
        setBoxSelectionTarget: (payload?: unknown) => {
            return events.invoke('boxSelection.setCurrentBoxTarget', payload);
        },
        confirmBoxSelectionTarget: () => {
            return events.invoke('boxSelection.confirmEvalTarget');
        },
        getBoxVolumeState: () => {
            return events.invoke('boxVolume.state');
        },
        getBoxVolumeTarget: () => {
            return events.invoke('boxVolume.currentBox');
        },
        getSceneSplatSummary,
        selectFirstSplat,
        getArtisanDebugViews: () => {
            return events.invoke('artisan.local.debugViews');
        },
        getArtisanStatus: () => {
            return events.invoke('artisan.local.status');
        },
        cancelArtisanRun: () => {
            return events.invoke('artisan.local.cancel');
        },
        showArtisanDebugViews: () => {
            return events.invoke('artisan.local.showDebugViews');
        },
        hideArtisanDebugViews: () => {
            return events.invoke('artisan.local.hideDebugViews');
        },
        getArtisanClickConfig: () => {
            return events.invoke('artisan.clickSelection.config');
        },
        setArtisanClickConfig: (patch?: unknown) => {
            return events.invoke('artisan.clickSelection.setConfig', patch);
        },
        runArtisanClick: (options?: {
            click_xy?: [number, number];
            x?: number;
            y?: number;
            selectionMode?: 'set' | 'add' | 'remove' | 'intersect';
            runLocal?: boolean;
            reviewSeedMask?: boolean;
            localOptions?: Record<string, unknown>;
            includeReview?: boolean;
            includeImages?: boolean;
        }) => {
            return events.invoke('artisan.clickSelection.debugRun', options) as Promise<unknown>;
        },
        runArtisanDebugPlan: (options?: { frameCount?: number; candidateCheckBudget?: number; targetBounds?: unknown }) => {
            return events.invoke('artisan.local.debugPlan', options) as Promise<unknown>;
        },
        exportArtisanDebugReview: (options?: { includeImages?: boolean; includeEvalCase?: boolean }) => {
            return events.invoke('artisan.local.exportDebugReview', options);
        },
        exportArtisanTestSuite: (options?: { includeImages?: boolean; includeEvalCase?: boolean; allowSyntheticTarget?: boolean; primarySelection?: unknown; primary_selection?: unknown }) => {
            return events.invoke('artisan.local.exportTestSuite', options);
        },
        downloadArtisanTestSuite: (options?: { includeImages?: boolean; includeEvalCase?: boolean; allowSyntheticTarget?: boolean; primarySelection?: unknown; primary_selection?: unknown }) => {
            return events.invoke('artisan.local.downloadTestSuite', options);
        },
        exportArtisanEvalCase: (options?: {
            includeReview?: boolean;
            includeImages?: boolean;
            target?: unknown;
            thresholds?: unknown;
            primarySelection?: 'editor_state' | 'object_selected' | 'target_bounded_posterior' | 'target_bounded_adaptive' | 'target_bounded_base' | 'target_bounded_loose' | 'target_volume' | 'final_thresholded' | 'all_voted' | 'confidence_thresholded' | 'posterior_filtered';
            primary_selection?: 'editor_state' | 'object_selected' | 'target_bounded_posterior' | 'target_bounded_adaptive' | 'target_bounded_base' | 'target_bounded_loose' | 'target_volume' | 'final_thresholded' | 'all_voted' | 'confidence_thresholded' | 'posterior_filtered';
        }) => {
            return events.invoke('artisan.local.exportEvalCase', options);
        },
        getArtisanEvalTarget: (options?: unknown) => {
            return events.invoke('artisan.local.evalTarget', options);
        },
        setArtisanEvalTarget: (payload?: unknown) => {
            return events.invoke('artisan.local.setEvalTarget', payload);
        },
        clearArtisanEvalTarget: () => {
            return events.invoke('artisan.local.clearEvalTarget');
        },
        useKnownDeskCanEvalTarget: () => {
            return events.invoke('artisan.local.useKnownDeskCanEvalTarget');
        },
        prepareArtisanManualBoxEvalSuiteDownload: () => {
            return events.invoke('artisan.local.prepareManualBoxEvalSuiteDownload');
        },
        startArtisanFourClickEvalBox: (options?: { downloadSuite?: boolean; download_suite?: boolean; includeImages?: boolean; includeEvalCase?: boolean; editAfterCapture?: boolean; edit_after_capture?: boolean; projectionMode?: 'frustum' | 'surface' | 'connected-surface'; projection_mode?: 'frustum' | 'surface' | 'connected-surface'; points?: [number, number][] }) => {
            return events.invoke('artisan.local.startFourClickEvalBox', options) as Promise<unknown>;
        },
        restoreArtisanActiveObject: (options?: { mode?: 'final' | 'voted' | 'confidence' | 'posterior' | 'target_bounded_adaptive' | 'target_bounded_base' | 'target_bounded_loose' | 'target_volume' }) => {
            return events.invoke('artisan.local.restoreActiveObject', options) as Promise<unknown>;
        },
        getArtisanSelectionDiagnostics: (options?: { thresholds?: number[] }) => {
            return events.invoke('artisan.local.selectionDiagnostics', options);
        },
        runArtisanEvalCase: (evalCase: unknown, options?: {
            includeImages?: boolean;
            restoreCamera?: boolean;
            allowUnreadyTarget?: boolean;
            allowSyntheticTarget?: boolean;
            localOptions?: Record<string, unknown>;
        }) => {
            return events.invoke('artisan.local.runEvalCase', evalCase, options) as Promise<unknown>;
        },
        backtestArtisanDebugReview: (review: unknown, options?: { frameCount?: number; candidateCheckBudget?: number }) => {
            return events.invoke('artisan.local.backtestDebugReview', review, options) as Promise<unknown>;
        },
        getWalkCollisionDebug: () => {
            return events.invoke('walk.collisionDebugBundle');
        },
        getVoxelMeshVisualization: () => {
            return events.invoke('walk.collisionMeshVisualization');
        },
        setWalkInput: (input: Record<string, unknown> = {}) => {
            events.fire('walk.input', input);
        },
        clearWalkInput: () => {
            events.fire('walk.input', {});
        },
        probeVisibleCanvasCapture: (options?: { includeStats?: boolean; mimeType?: string; quality?: number }) => {
            return events.invoke('render.visibleCanvasProbe', options) as Promise<unknown>;
        },
        getLocalSegmentStatus: () => {
            return events.invoke('localSegment.status');
        },
        getLastSegmentationCompare: () => {
            return events.invoke('segmentationCompare.lastBundle');
        },
        getSegmentationCompareBundles: () => {
            return events.invoke('segmentationCompare.bundles');
        },
        getPointCloudBoundary: () => {
            return events.invoke('pointCloudBoundary.settings');
        },
        setPointCloudBoundary: (settings: unknown) => {
            events.fire('pointCloudBoundary.set', settings);
            return events.invoke('pointCloudBoundary.settings');
        },
        getPointCloudBoundaryDiagnostics: () => {
            return events.invoke('pointCloudBoundary.diagnostics');
        },
        benchmarkPointCloudBoundary: (options?: { samples?: number }) => {
            return events.invoke('pointCloudBoundary.benchmark', options) as Promise<unknown>;
        }
    };

    registerIframeApi(events);

    // voice controller
    const voiceController = new VoiceController(events);

    // load async models
    scene.start();

    // handle load params
    const loadList = url.searchParams.getAll('load');
    const filenameList = url.searchParams.getAll('filename');
    const skipDefault = url.searchParams.has('skipDefault');
    const useDefaultLoad = loadList.length === 0 && !skipDefault && !!devConfig.defaultLoadUrl;
    if (useDefaultLoad) {
        loadList.push(devConfig.defaultLoadUrl);
    }

    for (const [i, value] of loadList.entries()) {
        const decoded = decodeURIComponent(value);
        const filename = i < filenameList.length ?
            decodeURIComponent(filenameList[i]) :
            getFilenameFromUrl(decoded);

        events.fire('progressStart', useDefaultLoad ? 'Loading demo scene...' : `Loading ${filename}...`);
        events.fire('progressUpdate', {
            text: filename,
            progress: loadList.length > 1 ? (i / loadList.length) * 100 : 0
        });
        if (useDefaultLoad && i === 0) {
            events.fire('toast', 'Loading demo scene...', 'info', 2500);
        }

        try {
            await events.invoke('import', [{
                filename,
                url: decoded
            }]);
            events.fire('progressUpdate', {
                text: filename,
                progress: ((i + 1) / loadList.length) * 100
            });
        } finally {
            events.fire('progressEnd');
        }
    }

    if (useDefaultLoad) {
        const defaultCamera = devConfig.defaultCamera;
        if (defaultCamera) {
            scene.camera.setPose(
                new Vec3(defaultCamera.position.x, defaultCamera.position.y, defaultCamera.position.z),
                new Vec3(defaultCamera.target.x, defaultCamera.target.y, defaultCamera.target.z),
                0
            );

            if (typeof defaultCamera.fov === 'number') {
                events.fire('camera.setFov', defaultCamera.fov);
            }

            if (typeof defaultCamera.ortho === 'boolean') {
                scene.camera.ortho = defaultCamera.ortho;
            }
        } else {
            scene.camera.focus();
        }
    }

    const requestedCameraMode = url.searchParams.get('cameraMode') ?? url.searchParams.get('controlMode');
    if (requestedCameraMode === 'orbit' || requestedCameraMode === 'fly') {
        events.fire('camera.setControlMode', requestedCameraMode);
    }

    const requestedTool = url.searchParams.get('tool') ?? url.searchParams.get('startTool');
    if (requestedTool) {
        if (requestedTool === 'none') {
            events.fire('tool.deactivate');
        } else if (toolManager.get(requestedTool)) {
            events.fire('tool.deactivate');
            events.fire(`tool.${requestedTool}`);
        } else {
            console.warn(`[SuperSplat] Unknown startup tool "${requestedTool}"`);
        }
    }


    // handle OS-based file association in PWA mode
    if ('launchQueue' in window) {
        window.launchQueue.setConsumer(async (launchParams: LaunchParams) => {
            for (const file of launchParams.files) {
                await events.invoke('import', [{
                    filename: file.name,
                    contents: await file.getFile()
                }]);
            }
        });
    }
};

export { main };
