import { Entity, Mat4, Quat, Vec3 } from 'playcanvas';

import { Events } from '../events';
import { Pivot } from '../pivot';

// Deterministic command patterns — fast, no API call needed
const DETERMINISTIC_COMMANDS: Array<{ patterns: RegExp[]; action: (events: Events) => void; label: string }> = [
    {
        patterns: [/\bundo\b/i],
        action: events => events.fire('edit.undo'),
        label: 'undo'
    },
    {
        patterns: [/\bredo\b/i],
        action: events => events.fire('edit.redo'),
        label: 'redo'
    },
    {
        patterns: [/\b(clear|deselect)\b/i],
        action: async (events) => {
            await events.invoke('selection.dropToSurface');
            events.fire('select.none');
        },
        label: 'deselect'
    },
    {
        patterns: [/\bselect all\b/i],
        action: events => events.fire('select.all'),
        label: 'select all'
    },
    {
        patterns: [/\b(delete|remove)\b/i],
        action: events => events.fire('select.delete'),
        label: 'delete'
    },
    {
        patterns: [/\binvert\b.+\bselect/i, /\bselect\b.+\binvert/i],
        action: events => events.fire('select.invert'),
        label: 'invert selection'
    },
    {
        patterns: [/\b(use |switch to |activate )?boxer\b/i],
        action: events => events.fire('tool.boxerSelection'),
        label: 'boxer tool'
    },
    {
        patterns: [/\b(use |switch to |activate )?sam\b/i],
        action: events => events.fire('tool.sam3Selection'),
        label: 'sam3 tool'
    },
    {
        patterns: [/\b(use |switch to |activate )?rect(angle)?\b.+\bselect/i],
        action: events => events.fire('tool.rectSelection'),
        label: 'rect selection'
    },
    {
        patterns: [/\b(use |switch to |activate )?brush\b/i],
        action: events => events.fire('tool.brushSelection'),
        label: 'brush tool'
    }
];

// Tool definitions for OpenAI Chat Completions API
const TOOL_DEFINITIONS = [
    {
        type: 'function' as const,
        function: {
            name: 'translate',
            description: 'Move the current selection by a normalized offset. Use 1.0 for a normal move, 0.3 for small, 2.0 for large. The system scales to the scene automatically.',
            parameters: {
                type: 'object',
                properties: {
                    x: { type: 'number', description: 'Normalized offset along X axis (positive = right)' },
                    y: { type: 'number', description: 'Normalized offset along Y axis (positive = up)' },
                    z: { type: 'number', description: 'Normalized offset along Z axis (positive = forward/towards camera)' }
                },
                required: ['x', 'y', 'z']
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'rotate',
            description: 'Rotate the current selection. Axis is camera-relative (matches translate): x = camera-right (pitch / tilt forward-backward — positive degrees tips top away from camera, "tilt backwards"), y = world-up (yaw / turn left-right — positive degrees spins clockwise from above), z = camera-forward (roll / tilt side-to-side — positive degrees rolls clockwise when looking along camera).',
            parameters: {
                type: 'object',
                properties: {
                    axis: { type: 'string', enum: ['x', 'y', 'z'], description: 'x=camera-right (pitch), y=world-up (yaw), z=camera-forward (roll)' },
                    degrees: { type: 'number', description: 'Rotation in degrees (positive follows right-hand rule around the axis)' }
                },
                required: ['axis', 'degrees']
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'scale',
            description: 'Scale the current selection by a factor.',
            parameters: {
                type: 'object',
                properties: {
                    factor: { type: 'number', description: 'Scale multiplier (e.g., 2 = double size, 0.5 = half)' }
                },
                required: ['factor']
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'activate_tool',
            description: 'Switch to a specific editor tool.',
            parameters: {
                type: 'object',
                properties: {
                    tool: {
                        type: 'string',
                        enum: ['rect', 'brush', 'polygon', 'lasso', 'flood', 'sphere', 'box', 'boxer', 'sam', 'eyedropper', 'move', 'rotate', 'scale', 'measure'],
                        description: 'Tool to activate'
                    }
                },
                required: ['tool']
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'place_asset',
            description: 'Download a 3D model from Sketchfab matching the query and drop it at the scene center. The placed model is automatically selected with the move gizmo so the user can transform it next. Use for phrases like "place a chair", "add a table", "bring in a lamp".',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Short search query (e.g., "chair", "red sofa", "coffee table")' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'replace_asset',
            description: 'Swap out the currently selected placed asset for a different one, keeping its position and rotation. If query is provided, searches for a model matching it. If omitted, re-uses the original query and cycles to the next result. Use for phrases like "I don\'t like this chair, give me a different one", "swap this out", "use a different one", "try another".',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Optional new search query. Omit to cycle through more results for the original query.' }
                },
                required: []
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'select_object',
            description: 'Select a specific object in the scene by text description. Uses AI-powered segmentation (SAM3 by default, or Boxer if use_boxer=true) to find and select the described object. This is async — waits for the AI backend to finish before returning.',
            parameters: {
                type: 'object',
                properties: {
                    description: { type: 'string', description: 'Short description of what to select (e.g., "the can", "red chair", "table")' },
                    use_boxer: { type: 'boolean', description: 'Use Boxer (bounding box) instead of SAM3 (segmentation). Default false.' }
                },
                required: ['description']
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'editor_action',
            description: 'Perform a basic editor action.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['undo', 'redo', 'delete', 'clear', 'select_all', 'invert_selection'],
                        description: 'Action to perform'
                    }
                },
                required: ['action']
            }
        }
    }
];

const TOOL_NAME_MAP: Record<string, string> = {
    rect: 'tool.rectSelection',
    brush: 'tool.brushSelection',
    polygon: 'tool.polygonSelection',
    lasso: 'tool.lassoSelection',
    flood: 'tool.floodSelection',
    sphere: 'tool.sphereSelection',
    box: 'tool.boxSelection',
    boxer: 'tool.boxerSelection',
    sam: 'tool.sam3Selection',
    eyedropper: 'tool.eyedropperSelection',
    move: 'tool.move',
    rotate: 'tool.rotate',
    scale: 'tool.scale',
    measure: 'tool.measure'
};

const ACTION_MAP: Record<string, string> = {
    undo: 'edit.undo',
    redo: 'edit.redo',
    delete: 'select.delete',
    clear: 'select.none',
    select_all: 'select.all',
    invert_selection: 'select.invert'
};

class VoiceCommands {
    private events: Events;
    private apiKey: string;
    private proxyBaseUrl: string;

    constructor(events: Events, apiKey: string, proxyBaseUrl = '') {
        this.events = events;
        this.apiKey = apiKey;
        this.proxyBaseUrl = proxyBaseUrl.replace(/\/$/, '');
    }

    async processTranscript(transcript: string): Promise<void> {
        const text = transcript.trim();
        if (!text) return;

        console.log(`[VoiceCommands] Processing: "${text}"`);

        // Only try deterministic matching for simple single-action utterances.
        // Chain indicators (commas, "and", "then", "after") mean the user issued
        // multiple commands and we must route to the AI so the whole sequence runs.
        const looksLikeChain = /,|\band\b|\bthen\b|\bafter\b/i.test(text);
        if (!looksLikeChain) {
            for (const cmd of DETERMINISTIC_COMMANDS) {
                if (cmd.patterns.some(p => p.test(text))) {
                    console.log(`[VoiceCommands] Deterministic match: ${cmd.label}`);
                    cmd.action(this.events);
                    return;
                }
            }
        }

        // Fall back to AI tool calling
        if (!this.hasOpenAiAccess()) {
            console.warn('[VoiceCommands] No API key for AI commands');
            return;
        }

        await this.processWithAI(text);
    }

    private async processWithAI(text: string): Promise<void> {
        console.log('[VoiceCommands] Routing to AI...');

        const messages: Array<any> = [
            {
                role: 'system',
                content: `You are a voice command interpreter for a 3D Gaussian Splat editor. Convert spoken commands into tool calls.

Rules:
- Translate directions (camera-relative): left=-x, right=+x, up=+y, down=-y, forward=+z, backward=-z. Use NORMALIZED units: 1.0 = normal/default move, 0.3 = a little, 2.0 = a lot. The system scales to the scene automatically. Do NOT use tiny values like 0.05 or 0.1.
- Rotate axes (camera-relative, matching translate): x = camera-right (pitch — "tilt forward/backward"), y = world-up (yaw — "turn left/right"), z = camera-forward (roll — "lean/tilt side to side"). "Tilt backwards" = rotate({axis:'x', degrees:-45}). "Tilt forwards" = rotate({axis:'x', degrees:45}). "Turn right" = rotate({axis:'y', degrees:45}). "Turn left" = rotate({axis:'y', degrees:-45}).
- You can chain multiple tool calls for compound commands like "move left then up".
- To select a specific object by description (e.g. "select the can", "click the chair"), use select_object with a short description. This activates AI-powered segmentation (SAM3) to find and select the object. Set use_boxer=true only if the user explicitly says "boxer".
- Only use editor_action select_all when the user explicitly says "select all" or "select everything".
- For compound commands like "select the can and move it up", first call select_object, then translate. select_object waits for the AI to finish, so subsequent commands will operate on the correct selection.
- For "place a X" / "add a X" / "bring in a X", use place_asset with query=X. This drops the model at the scene center and auto-selects it.
- For "use a different one" / "I don't like this, try another" / "swap it out", use replace_asset with no query — it cycles to the next result of the original query at the same spot.
- For "replace this with a X" / "swap it for a X", use replace_asset with query=X.
- For ambiguous speech-to-text artifacts, prefer the most likely intended command.`
            },
            {
                role: 'user',
                content: text
            }
        ];

        const scale = this.getSceneScale();
        console.log(`[VoiceCommands] Scene scale: ${scale.toFixed(3)}, suggested distances: a_little=${(0.05 * scale).toFixed(3)}, default=${(0.1 * scale).toFixed(3)}, a_lot=${(0.3 * scale).toFixed(3)}`);

        // Loop up to 12 tool call rounds — long chains like
        // "select X, rotate, translate, scale, clear, select Y, delete"
        // can hit 8+ calls if the model doesn't batch
        for (let round = 0; round < 12; round++) {
            const response = await fetch(this.openAiChatUrl(), {
                method: 'POST',
                headers: this.openAiJsonHeaders(),
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages,
                    tools: TOOL_DEFINITIONS,
                    tool_choice: round === 0 ? 'required' : 'auto'
                })
            });

            if (!response.ok) {
                const errText = await response.text();
                console.error(`[VoiceCommands] API error: ${response.status}`, errText);
                return;
            }

            const data = await response.json();
            const choice = data.choices?.[0];
            if (!choice) return;

            const assistantMsg = choice.message;
            messages.push(assistantMsg);

            const toolCalls = assistantMsg.tool_calls;
            if (!toolCalls || toolCalls.length === 0) {
                // No more tool calls — done
                return;
            }

            // Execute each tool call and add results to messages
            let aborted = false;
            for (const call of toolCalls) {
                const args = JSON.parse(call.function.arguments);
                let result: string;

                if (aborted) {
                    result = 'Skipped — previous command failed';
                } else {
                    result = await this.executeTool(call.function.name, args);
                    if (result.startsWith('Selection failed') || result.startsWith('No pivot')) {
                        aborted = true;
                        console.warn(`[VoiceCommands] Aborting chain: ${result}`);
                    }
                }

                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: result
                });
            }

            if (aborted) return;
        }
    }

    private async executeTool(name: string, args: any): Promise<string> {
        console.log(`[VoiceCommands] Executing tool: ${name}`, args);

        switch (name) {
            case 'translate':
                return await this.executeTranslate(args.x, args.y, args.z);

            case 'rotate':
                return await this.executeRotate(args.axis, args.degrees);

            case 'scale':
                return await this.executeScale(args.factor);

            case 'activate_tool': {
                const eventName = TOOL_NAME_MAP[args.tool];
                if (eventName) {
                    this.events.fire(eventName);
                    return `Activated ${args.tool} tool`;
                }
                return `Unknown tool: ${args.tool}`;
            }

            case 'select_object':
                return this.executeSelectObject(args.description, args.use_boxer ?? false);

            case 'place_asset':
                this.events.fire('assetBrowser.searchAndPlace', args.query);
                return `Placing "${args.query}" at scene center`;

            case 'replace_asset':
                this.events.fire('assetBrowser.replaceSelected', args.query);
                return args.query ?
                    `Replacing with "${args.query}"` :
                    'Swapping to a different variant';

            case 'editor_action': {
                const eventName = ACTION_MAP[args.action];
                if (eventName) {
                    this.events.fire(eventName);
                    return `Executed ${args.action}`;
                }
                return `Unknown action: ${args.action}`;
            }

            default:
                return `Unknown tool: ${name}`;
        }
    }

    private waitForPivot(): Promise<void> {
        return new Promise((resolve) => {
            // Check if pivot already has a valid position (not origin)
            const pivot = this.events.invoke('pivot') as Pivot;
            if (pivot && !pivot.transform.position.equals(new Vec3(0, 0, 0))) {
                resolve();
                return;
            }

            const timeoutRef: { current?: ReturnType<typeof setTimeout> } = {};
            const onPlaced = () => {
                if (timeoutRef.current) clearTimeout(timeoutRef.current);
                this.events.off('pivot.placed', onPlaced);
                resolve();
            };

            // Wait for pivot.placed event
            timeoutRef.current = setTimeout(() => {
                this.events.off('pivot.placed', onPlaced);
                console.log('[VoiceCommands] waitForPivot timed out, proceeding anyway');
                resolve();
            }, 500);

            this.events.on('pivot.placed', onPlaced);
        });
    }

    private getSceneScale(): number {
        const scene = (window as any).scene;
        if (!scene) return 1;

        // Use scene bounding box radius as the scale reference
        try {
            const bound = scene.bound;
            if (bound) {
                const radius = bound.halfExtents.length();
                if (radius > 0) return radius;
            }
        } catch { /* fall through */ }

        // Fallback: camera distance
        try {
            const dist = scene.camera?.distance;
            if (dist > 0) return dist;
        } catch { /* fall through */ }

        return 1;
    }

    private async executeSelectObject(description: string, useBoxer: boolean): Promise<string> {
        // Try preferred tool first, fall back to the other on failure
        const tools = useBoxer ?
            [{ event: 'tool.boxerSelection', name: 'Boxer' }, { event: 'tool.sam3Selection', name: 'SAM3' }] :
            [{ event: 'tool.sam3Selection', name: 'SAM3' }, { event: 'tool.boxerSelection', name: 'Boxer' }];

        for (const tool of tools) {
            const result = await this.trySelectWithTool(tool.event, tool.name, description);
            if (!result.startsWith('Selection failed')) {
                return result;
            }
            console.log(`[VoiceCommands] ${tool.name} failed, trying fallback...`);
        }

        this.events.fire('toast', `Couldn't find "${description}" — try a different description`, 'warning');
        return `Selection failed: both SAM3 and Boxer failed for "${description}"`;
    }

    private async trySelectWithTool(toolEvent: string, toolName: string, description: string): Promise<string> {
        this.events.fire(toolEvent);

        // Wait for tool to activate
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 200);
        });

        const events = this.events;

        // Listen for completion signals before firing the query
        const result = await new Promise<string>((resolve) => {
            const timeoutRef: { current?: ReturnType<typeof setTimeout> } = {};

            function cleanup() {
                if (timeoutRef.current) clearTimeout(timeoutRef.current);
                events.off('select.byOBB', onBoxerDone);
                events.off('edit.add', onSamDone);
                events.off('toast', onError);
            }

            function onBoxerDone() {
                cleanup();
                resolve(`Selected "${description}" via Boxer`);
            }

            function onSamDone() {
                cleanup();
                resolve(`Selected "${description}" via SAM3`);
            }

            function onError(msg: string, level: string) {
                if (level === 'error' || level === 'warning') {
                    cleanup();
                    resolve(`Selection failed: ${msg}`);
                }
            }

            timeoutRef.current = setTimeout(() => {
                cleanup();
                resolve(`Selection failed: ${toolName} timed out after 30s`);
            }, 30000);

            events.on('select.byOBB', onBoxerDone);
            events.on('edit.add', onSamDone);
            events.on('toast', onError);

            // Fire the text query
            events.fire('ai.textQuery', description);
        });

        console.log(`[VoiceCommands] ${result}`);
        return result;
    }

    private async executeTranslate(x: number, y: number, z: number): Promise<string> {
        // Scale normalized values by scene size (10% of scene radius per 1.0 unit)
        const sceneFactor = this.getSceneScale() * 0.1;

        // Convert from camera-relative to world space
        // x = camera right, y = world up, z = camera forward (into screen)
        const scene = (window as any).scene;
        const offset = new Vec3();

        if (scene?.camera) {
            const wtm: Mat4 = scene.camera.worldTransform;
            const camRight = new Vec3(wtm.data[0], wtm.data[1], wtm.data[2]);
            const camForward = new Vec3(-wtm.data[8], -wtm.data[9], -wtm.data[10]);

            // Project camera right/forward onto horizontal plane (ignore vertical component)
            camRight.y = 0;
            camRight.normalize();
            camForward.y = 0;
            camForward.normalize();

            // x → camera right, z → camera forward, y → world up
            offset.add(camRight.mulScalar(x * sceneFactor));
            offset.y += y * sceneFactor;
            offset.add(camForward.mulScalar(z * sceneFactor));
        } else {
            // Fallback: world axes
            offset.set(x * sceneFactor, y * sceneFactor, z * sceneFactor);
        }

        console.log(`[VoiceCommands] Translate: normalized=(${x}, ${y}, ${z}), sceneFactor=${sceneFactor.toFixed(3)}, world offset=(${offset.x.toFixed(3)}, ${offset.y.toFixed(3)}, ${offset.z.toFixed(3)})`);

        // If a placed asset is currently selected, translate the entity directly.
        // Splat translation via pivot doesn't apply to glTF entities.
        const placedEntity = this.events.invoke('assetBrowser.selectedPlacedEntity') as Entity | null;
        if (placedEntity) {
            this.events.fire('tool.move');
            placedEntity.translate(offset.x, offset.y, offset.z);
            if (scene) scene.forceRender = true;
            console.log(`[VoiceCommands] Translate (entity): new position=${placedEntity.getPosition().toString()}`);
            return `Translated placed asset by (${offset.x.toFixed(3)}, ${offset.y.toFixed(3)}, ${offset.z.toFixed(3)})`;
        }

        // Activate move tool and wait for pivot to be placed
        this.events.fire('tool.move');
        await this.waitForPivot();

        const pivot = this.events.invoke('pivot') as Pivot;
        if (!pivot) {
            console.warn('[VoiceCommands] No pivot available');
            return 'No pivot available';
        }

        const posBefore = pivot.transform.position.clone();
        const rot = pivot.transform.rotation.clone();
        const scale = pivot.transform.scale.clone();

        const posAfter = posBefore.clone().add(offset);

        console.log(`[VoiceCommands] Translate: pivot before=${posBefore.toString()}, after=${posAfter.toString()}`);

        pivot.start();
        pivot.moveTRS(posAfter, rot, scale);
        pivot.end();

        return `Translated by world (${offset.x.toFixed(3)}, ${offset.y.toFixed(3)}, ${offset.z.toFixed(3)})`;
    }

    private async executeRotate(axis: string, degrees: number): Promise<string> {
        // Build a camera-relative axis vector in world space:
        //   x = camera-right  (pitch)
        //   y = world-up      (yaw — kept world-aligned so "turn right" feels natural regardless of camera tilt)
        //   z = camera-forward (roll)
        const worldAxis = new Vec3();
        const scene = (window as any).scene;
        if (scene?.camera && axis !== 'y') {
            const wtm: Mat4 = scene.camera.worldTransform;
            if (axis === 'x') {
                // camera right (horizontal component so pitch stays intuitive even if camera rolls)
                worldAxis.set(wtm.data[0], 0, wtm.data[2]);
                worldAxis.normalize();
            } else {
                // camera forward, horizontal
                worldAxis.set(-wtm.data[8], 0, -wtm.data[10]);
                worldAxis.normalize();
            }
        } else {
            worldAxis.set(0, 1, 0); // world up for yaw, or fallback
        }

        // Build a quaternion from (worldAxis, angle)
        const rad = degrees * Math.PI / 180;
        const half = rad * 0.5;
        const s = Math.sin(half);
        const deltaRot = new Quat(worldAxis.x * s, worldAxis.y * s, worldAxis.z * s, Math.cos(half));

        // If a placed asset is currently selected, rotate the entity directly.
        const placedEntity = this.events.invoke('assetBrowser.selectedPlacedEntity') as Entity | null;
        if (placedEntity) {
            this.events.fire('tool.rotate');
            const currentRot = placedEntity.getRotation().clone();
            const newRot = new Quat().mul2(deltaRot, currentRot);
            placedEntity.setRotation(newRot);
            if (scene) scene.forceRender = true;
            console.log(`[VoiceCommands] Rotate (entity): axis=${axis}, degrees=${degrees}`);
            return `Rotated placed asset ${degrees}° around ${axis}`;
        }

        this.events.fire('tool.rotate');
        await this.waitForPivot();

        const pivot = this.events.invoke('pivot') as Pivot;
        if (!pivot) return 'No pivot available';

        const pos = pivot.transform.position.clone();
        const rot = pivot.transform.rotation.clone();
        const scale = pivot.transform.scale.clone();

        // Apply delta in WORLD frame: newRot = deltaRot * oldRot
        const newRot = new Quat().mul2(deltaRot, rot);

        console.log(`[VoiceCommands] Rotate: axis=${axis} (${worldAxis.toString()}), degrees=${degrees}`);

        pivot.start();
        pivot.moveTRS(pos, newRot, scale);
        pivot.end();

        return `Rotated ${degrees}° around ${axis} axis`;
    }

    private async executeScale(factor: number): Promise<string> {
        // If a placed asset is currently selected, scale the entity directly.
        const scene = (window as any).scene;
        const placedEntity = this.events.invoke('assetBrowser.selectedPlacedEntity') as Entity | null;
        if (placedEntity) {
            this.events.fire('tool.scale');
            const s = placedEntity.getLocalScale();
            placedEntity.setLocalScale(s.x * factor, s.y * factor, s.z * factor);
            if (scene) scene.forceRender = true;
            console.log(`[VoiceCommands] Scale (entity): factor=${factor}, new scale=${placedEntity.getLocalScale().toString()}`);
            return `Scaled placed asset by ${factor}`;
        }

        this.events.fire('tool.scale');
        await this.waitForPivot();

        const pivot = this.events.invoke('pivot') as Pivot;
        if (!pivot) return 'No pivot available';

        const pos = pivot.transform.position.clone();
        const rot = pivot.transform.rotation.clone();
        const scale = pivot.transform.scale.clone();

        scale.mulScalar(factor);

        pivot.start();
        pivot.moveTRS(pos, rot, scale);
        pivot.end();

        return `Scaled by factor ${factor}`;
    }

    private hasOpenAiAccess() {
        return !!this.apiKey || !!this.proxyBaseUrl;
    }

    private openAiChatUrl() {
        return this.proxyBaseUrl ?
            `${this.proxyBaseUrl}/api/openai/chat/completions` :
            'https://api.openai.com/v1/chat/completions';
    }

    private openAiJsonHeaders() {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (!this.proxyBaseUrl) {
            headers.Authorization = `Bearer ${this.apiKey}`;
        }
        return headers;
    }
}

export { VoiceCommands };
