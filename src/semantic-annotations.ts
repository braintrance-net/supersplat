import { Events } from './events';

type SemanticAnnotationCamera = {
    position: [number, number, number];
    target: [number, number, number];
    fov: number;
    ortho?: boolean;
    viewMatrix?: number[];
};

type SemanticAnnotationSource = {
    provider: string;
    model: string;
    screenPoint: [number, number];
    captureSize: [number, number];
    camera: SemanticAnnotationCamera;
    capturedAt: string;
    confidence?: number;
};

type SemanticAnnotation = {
    id: string;
    label: string;
    description: string;
    position: [number, number, number];
    color?: string;
    radius?: number;
    targetImage?: {
        src: string;
        maskSrc?: string;
        fullSrc?: string;
        fullMaskSrc?: string;
        fullWidth?: number;
        fullHeight?: number;
        width: number;
        height: number;
        points?: Array<{ xy: [number, number], label: 0 | 1 }>;
        jobId?: string;
    };
    presetId?: string;
    order?: number;
    difficulty?: 'easy' | 'medium' | 'hard';
    createdAt?: string;
    updatedAt?: string;
    authoringVersion?: number;
    source: SemanticAnnotationSource;
};

type SemanticLayer = {
    version: 1;
    annotations: SemanticAnnotation[];
};

const isFiniteTuple3 = (value: unknown): value is [number, number, number] => (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(item => typeof item === 'number' && Number.isFinite(item))
);

const isFiniteTuple2 = (value: unknown): value is [number, number] => (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(item => typeof item === 'number' && Number.isFinite(item))
);

const isFiniteNumberArray = (value: unknown, length: number): value is number[] => (
    Array.isArray(value) &&
    value.length === length &&
    value.every(item => typeof item === 'number' && Number.isFinite(item))
);

const isPromptPoint = (value: unknown): value is { xy: [number, number], label: 0 | 1 } => {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const point = value as { xy?: unknown, label?: unknown };
    return isFiniteTuple2(point.xy) && (point.label === 0 || point.label === 1);
};

const isTargetImage = (value: unknown): value is NonNullable<SemanticAnnotation['targetImage']> => {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const image = value as NonNullable<SemanticAnnotation['targetImage']>;
    return (
        typeof image.src === 'string' &&
        (!image.maskSrc || typeof image.maskSrc === 'string') &&
        (!image.fullSrc || typeof image.fullSrc === 'string') &&
        (!image.fullMaskSrc || typeof image.fullMaskSrc === 'string') &&
        (!image.fullWidth || (Number.isInteger(image.fullWidth) && image.fullWidth > 0)) &&
        (!image.fullHeight || (Number.isInteger(image.fullHeight) && image.fullHeight > 0)) &&
        Number.isInteger(image.width) &&
        image.width > 0 &&
        Number.isInteger(image.height) &&
        image.height > 0 &&
        (!image.points || (Array.isArray(image.points) && image.points.every(isPromptPoint))) &&
        (!image.jobId || typeof image.jobId === 'string')
    );
};

const isSemanticAnnotation = (value: unknown): value is SemanticAnnotation => {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const annotation = value as SemanticAnnotation;
    return (
        typeof annotation.id === 'string' &&
        typeof annotation.label === 'string' &&
        typeof annotation.description === 'string' &&
        isFiniteTuple3(annotation.position) &&
        (!annotation.color || typeof annotation.color === 'string') &&
        (!annotation.radius || typeof annotation.radius === 'number') &&
        (!annotation.targetImage || isTargetImage(annotation.targetImage)) &&
        (!annotation.presetId || typeof annotation.presetId === 'string') &&
        (!annotation.order || typeof annotation.order === 'number') &&
        (!annotation.difficulty || annotation.difficulty === 'easy' || annotation.difficulty === 'medium' || annotation.difficulty === 'hard') &&
        (!annotation.createdAt || typeof annotation.createdAt === 'string') &&
        (!annotation.updatedAt || typeof annotation.updatedAt === 'string') &&
        (!annotation.authoringVersion || typeof annotation.authoringVersion === 'number') &&
        !!annotation.source &&
        typeof annotation.source.provider === 'string' &&
        typeof annotation.source.model === 'string' &&
        isFiniteTuple2(annotation.source.screenPoint) &&
        isFiniteTuple2(annotation.source.captureSize) &&
        !!annotation.source.camera &&
        isFiniteTuple3(annotation.source.camera.position) &&
        isFiniteTuple3(annotation.source.camera.target) &&
        typeof annotation.source.camera.fov === 'number' &&
        (!annotation.source.camera.viewMatrix || isFiniteNumberArray(annotation.source.camera.viewMatrix, 16)) &&
        typeof annotation.source.capturedAt === 'string'
    );
};

const cloneAnnotation = (annotation: SemanticAnnotation): SemanticAnnotation => ({
    ...annotation,
    position: [...annotation.position],
    targetImage: annotation.targetImage ? {
        ...annotation.targetImage,
        points: annotation.targetImage.points?.map(point => ({
            xy: [...point.xy],
            label: point.label
        }))
    } : undefined,
    source: {
        ...annotation.source,
        screenPoint: [...annotation.source.screenPoint],
        captureSize: [...annotation.source.captureSize],
        camera: {
            ...annotation.source.camera,
            position: [...annotation.source.camera.position],
            target: [...annotation.source.camera.target],
            viewMatrix: annotation.source.camera.viewMatrix ? [...annotation.source.camera.viewMatrix] : undefined
        }
    }
});

const registerSemanticAnnotationEvents = (events: Events) => {
    let annotations: SemanticAnnotation[] = [];

    const list = () => annotations.map(cloneAnnotation);

    const getLayer = (): SemanticLayer => ({
        version: 1,
        annotations: list()
    });

    const emitChanged = () => {
        events.fire('semanticAnnotations.changed', list());
    };

    const add = (annotation: SemanticAnnotation) => {
        annotations = [...annotations.filter(item => item.id !== annotation.id), cloneAnnotation(annotation)];
        emitChanged();
    };

    const load = (nextAnnotations: SemanticAnnotation[] = []) => {
        annotations = nextAnnotations.filter(isSemanticAnnotation).map(cloneAnnotation);
        emitChanged();
    };

    const loadLayer = (layer?: Partial<SemanticLayer> | null) => {
        load(Array.isArray(layer?.annotations) ? layer.annotations : []);
    };

    const remove = (id: string) => {
        const nextAnnotations = annotations.filter(annotation => annotation.id !== id);
        if (nextAnnotations.length !== annotations.length) {
            annotations = nextAnnotations;
            emitChanged();
        }
    };

    const clear = () => {
        if (annotations.length > 0) {
            annotations = [];
            emitChanged();
        }
    };

    events.function('semanticAnnotations.list', list);
    events.function('semanticAnnotations.layer', getLayer);
    events.function('semanticAnnotations.add', add);
    events.function('semanticAnnotations.load', load);
    events.function('semanticAnnotations.loadLayer', loadLayer);
    events.function('semanticAnnotations.remove', remove);
    events.function('semanticAnnotations.clear', clear);
    events.function('docSerialize.semantics', getLayer);
    events.function('docDeserialize.semantics', loadLayer);

    events.on('semanticAnnotations.add', add);
    events.on('semanticAnnotations.load', load);
    events.on('semanticAnnotations.loadLayer', loadLayer);
    events.on('semanticAnnotations.remove', remove);
    events.on('semanticAnnotations.clear', clear);
    events.on('scene.clear', clear);
};

export { registerSemanticAnnotationEvents };
export type { SemanticAnnotation, SemanticAnnotationCamera, SemanticAnnotationSource, SemanticLayer };
