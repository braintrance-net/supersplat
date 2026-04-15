import { Quat, Vec3 } from 'playcanvas';

import { Events } from '../events';
import { Pivot } from '../pivot';

type ToolCallResult = { name: string; result: string };

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

// Tool definitions for OpenAI Responses API
const TOOL_DEFINITIONS = [
    {
        type: 'function' as const,
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
    },
    {
        type: 'function' as const,
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
    },
    {
        type: 'function' as const,
        name: 'scale',
        description: 'Scale the current selection by a factor.',
        parameters: {
            type: 'object',
            properties: {
                factor: { type: 'number', description: 'Scale multiplier (e.g., 2 = double size, 0.5 = half)' }
            },
            required: ['factor']
        }
    },
    {
        type: 'function' as const,
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
    },
    {
        type: 'function' as const,
        name: 'search_and_place_asset',
        description: 'Search for a 3D model and place it in the scene.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query for the 3D model (e.g., "chair", "table")' }
            },
            required: ['query']
        }
    },
    {
        type: 'function' as const,
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

        const messages: Array<{ role: string; content: string }> = [
            {
                role: 'system',
                content: `You are a voice command interpreter for a 3D Gaussian Splat editor. Convert spoken commands into tool calls. For directional commands: left=-x, right=+x, up=+y, down=-y, forward=+z, backward=-z. Default movement distance is 0.5 units. You can chain multiple tool calls for complex commands like "move left then up".`
            },
            {
                role: 'user',
                content: text
            }
        ];

        let toolCallResults: ToolCallResult[] = [];

        // Loop up to 6 tool call rounds
        for (let round = 0; round < 6; round++) {
            const body: any = {
                model: 'gpt-4o-mini',
                input: [...messages, ...toolCallResults.map(r => ({
                    type: 'function_call_output',
                    call_id: r.name,
                    output: r.result
                }))],
                tools: TOOL_DEFINITIONS
            };

            // On first round, just use input directly
            if (round === 0) {
                body.input = messages;
            }

            const response = await fetch('https://api.openai.com/v1/responses', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                console.error(`[VoiceCommands] API error: ${response.status}`);
                return;
            }

            const data = await response.json();
            const output = data.output || [];

            // Find tool calls in the output
            const toolCalls = output.filter((item: any) => item.type === 'function_call');

            if (toolCalls.length === 0) {
                // No more tool calls — done
                return;
            }

            // Execute each tool call sequentially
            toolCallResults = [];
            for (const call of toolCalls) {
                const args = JSON.parse(call.arguments);
                const result = await this.executeTool(call.name, args);
                toolCallResults.push({ name: call.call_id, result });
            }

            // Build up message history for next round
            messages.push({ role: 'assistant' as const, content: JSON.stringify(output) });
            for (const r of toolCallResults) {
                messages.push({ role: 'user' as const, content: `Tool ${r.name} returned: ${r.result}` });
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
