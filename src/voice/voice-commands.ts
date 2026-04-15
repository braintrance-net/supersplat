import { Quat, Vec3 } from 'playcanvas';

import { Events } from '../events';
import { Pivot } from '../pivot';

// Deterministic command patterns — fast, no API call needed
const DETERMINISTIC_COMMANDS: Array<{ patterns: RegExp[]; action: (events: Events) => void; label: string }> = [
    {
        patterns: [/\bundo\b/i],
        action: (events) => events.fire('edit.undo'),
        label: 'undo'
    },
    {
        patterns: [/\bredo\b/i],
        action: (events) => events.fire('edit.redo'),
        label: 'redo'
    },
    {
        patterns: [/\b(clear|deselect)\b/i],
        action: (events) => events.fire('select.none'),
        label: 'deselect'
    },
    {
        patterns: [/\bselect all\b/i],
        action: (events) => events.fire('select.all'),
        label: 'select all'
    },
    {
        patterns: [/\b(delete|remove)\b/i],
        action: (events) => events.fire('select.delete'),
        label: 'delete'
    },
    {
        patterns: [/\binvert\b.*\bselect/i, /\bselect\b.*\binvert/i],
        action: (events) => events.fire('select.invert'),
        label: 'invert selection'
    },
    {
        patterns: [/\b(use |switch to |activate )?boxer\b/i],
        action: (events) => events.fire('tool.boxerSelection'),
        label: 'boxer tool'
    },
    {
        patterns: [/\b(use |switch to |activate )?sam\b/i],
        action: (events) => events.fire('tool.sam3Selection'),
        label: 'sam3 tool'
    },
    {
        patterns: [/\b(use |switch to |activate )?rect(angle)?\b.*\bselect/i],
        action: (events) => events.fire('tool.rectSelection'),
        label: 'rect selection'
    },
    {
        patterns: [/\b(use |switch to |activate )?brush\b/i],
        action: (events) => events.fire('tool.brushSelection'),
        label: 'brush tool'
    }
];

// Tool definitions for OpenAI Chat Completions API
const TOOL_DEFINITIONS = [
    {
        type: 'function' as const,
        function: {
            name: 'translate',
            description: 'Move the current selection by an offset in 3D space. Units are scene units (roughly meters).',
            parameters: {
                type: 'object',
                properties: {
                    x: { type: 'number', description: 'Offset along X axis (positive = right)' },
                    y: { type: 'number', description: 'Offset along Y axis (positive = up)' },
                    z: { type: 'number', description: 'Offset along Z axis (positive = forward/towards camera)' }
                },
                required: ['x', 'y', 'z']
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'rotate',
            description: 'Rotate the current selection around an axis.',
            parameters: {
                type: 'object',
                properties: {
                    axis: { type: 'string', enum: ['x', 'y', 'z'], description: 'Axis to rotate around' },
                    degrees: { type: 'number', description: 'Rotation in degrees' }
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
            name: 'search_and_place_asset',
            description: 'Search for a 3D model and place it in the scene.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query for the 3D model (e.g., "chair", "table")' }
                },
                required: ['query']
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

    constructor(events: Events, apiKey: string) {
        this.events = events;
        this.apiKey = apiKey;
    }

    async processTranscript(transcript: string): Promise<void> {
        const text = transcript.trim();
        if (!text) return;

        console.log(`[VoiceCommands] Processing: "${text}"`);

        // Try deterministic match first
        for (const cmd of DETERMINISTIC_COMMANDS) {
            if (cmd.patterns.some(p => p.test(text))) {
                console.log(`[VoiceCommands] Deterministic match: ${cmd.label}`);
                cmd.action(this.events);
                return;
            }
        }

        // Fall back to AI tool calling
        if (!this.apiKey) {
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
- Directions: left=-x, right=+x, up=+y, down=-y, forward=+z, backward=-z. Default distance is 0.5 units.
- You can chain multiple tool calls for compound commands like "move left then up".
- To select a specific object by description (e.g. "select the can", "click the chair"), use select_object with a short description. This activates AI-powered segmentation (SAM3) to find and select the object. Set use_boxer=true only if the user explicitly says "boxer".
- Only use editor_action select_all when the user explicitly says "select all" or "select everything".
- For compound commands like "select the can and move it up", first call select_object, then translate. select_object waits for the AI to finish, so subsequent commands will operate on the correct selection.
- For ambiguous speech-to-text artifacts, prefer the most likely intended command.`
            },
            {
                role: 'user',
                content: text
            }
        ];

        // Loop up to 6 tool call rounds
        for (let round = 0; round < 6; round++) {
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
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
            for (const call of toolCalls) {
                const args = JSON.parse(call.function.arguments);
                const result = await this.executeTool(call.function.name, args);
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: result
                });
            }
        }
    }

    private async executeTool(name: string, args: any): Promise<string> {
        console.log(`[VoiceCommands] Executing tool: ${name}`, args);

        switch (name) {
            case 'translate':
                return this.executeTranslate(args.x, args.y, args.z);

            case 'rotate':
                return this.executeRotate(args.axis, args.degrees);

            case 'scale':
                return this.executeScale(args.factor);

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

            case 'search_and_place_asset':
                this.events.fire('assetBrowser.searchAndPlace', args.query);
                return `Searching for "${args.query}"...`;

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

    private async executeSelectObject(description: string, useBoxer: boolean): Promise<string> {
        const toolEvent = useBoxer ? 'tool.boxerSelection' : 'tool.sam3Selection';
        const toolName = useBoxer ? 'Boxer' : 'SAM3';

        this.events.fire(toolEvent);

        // Wait for tool to activate
        await new Promise(resolve => setTimeout(resolve, 200));

        // Listen for completion signals before firing the query
        const result = await new Promise<string>((resolve) => {
            const timeout = setTimeout(() => {
                cleanup();
                resolve(`${toolName} timed out after 30s`);
            }, 30000);

            const cleanup = () => {
                clearTimeout(timeout);
                this.events.off('select.byOBB', onBoxerDone);
                this.events.off('edit.add', onSamDone);
                this.events.off('toast', onError);
            };

            const onBoxerDone = () => {
                cleanup();
                resolve(`Selected "${description}" via Boxer`);
            };

            const onSamDone = () => {
                cleanup();
                resolve(`Selected "${description}" via SAM3`);
            };

            const onError = (msg: string, level: string) => {
                if (level === 'error' || level === 'warning') {
                    cleanup();
                    resolve(`Selection failed: ${msg}`);
                }
            };

            this.events.on('select.byOBB', onBoxerDone);
            this.events.on('edit.add', onSamDone);
            this.events.on('toast', onError);

            // Fire the text query
            this.events.fire('ai.textQuery', description);
        });

        console.log(`[VoiceCommands] ${result}`);
        return result;
    }

    private executeTranslate(x: number, y: number, z: number): string {
        // Activate move tool first, then use pivot to transform
        this.events.fire('tool.move');

        const pivot = this.events.invoke('pivot') as Pivot;
        if (!pivot) return 'No pivot available';

        const pos = pivot.transform.position.clone();
        const rot = pivot.transform.rotation.clone();
        const scale = pivot.transform.scale.clone();

        pos.add(new Vec3(x, y, z));

        pivot.start();
        pivot.moveTRS(pos, rot, scale);
        pivot.end();

        return `Translated by (${x}, ${y}, ${z})`;
    }

    private executeRotate(axis: string, degrees: number): string {
        this.events.fire('tool.rotate');

        const pivot = this.events.invoke('pivot') as Pivot;
        if (!pivot) return 'No pivot available';

        const pos = pivot.transform.position.clone();
        const rot = pivot.transform.rotation.clone();
        const scale = pivot.transform.scale.clone();

        const deltaRot = new Quat();
        switch (axis) {
            case 'x': deltaRot.setFromEulerAngles(degrees, 0, 0); break;
            case 'y': deltaRot.setFromEulerAngles(0, degrees, 0); break;
            case 'z': deltaRot.setFromEulerAngles(0, 0, degrees); break;
        }
        rot.mul(deltaRot);

        pivot.start();
        pivot.moveTRS(pos, rot, scale);
        pivot.end();

        return `Rotated ${degrees}° around ${axis} axis`;
    }

    private executeScale(factor: number): string {
        this.events.fire('tool.scale');

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
}

export { VoiceCommands };
