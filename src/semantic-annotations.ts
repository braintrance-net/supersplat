import { Events } from './events';

type SemanticAnnotationCamera = {
    position: [number, number, number];
    target: [number, number, number];
    fov: number;
    ortho?: boolean;
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
        !!annotation.source &&
        typeof annotation.source.provider === 'string' &&
        typeof annotation.source.model === 'string' &&
        isFiniteTuple2(annotation.source.screenPoint) &&
        isFiniteTuple2(annotation.source.captureSize) &&
        !!annotation.source.camera &&
        isFiniteTuple3(annotation.source.camera.position) &&
        isFiniteTuple3(annotation.source.camera.target) &&
        typeof annotation.source.camera.fov === 'number' &&
        typeof annotation.source.capturedAt === 'string'
    );
};

const cloneAnnotation = (annotation: SemanticAnnotation): SemanticAnnotation => ({
    ...annotation,
    position: [...annotation.position],
    source: {
        ...annotation.source,
        screenPoint: [...annotation.source.screenPoint],
        captureSize: [...annotation.source.captureSize],
        camera: {
            ...annotation.source.camera,
            position: [...annotation.source.camera.position],
            target: [...annotation.source.camera.target]
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
