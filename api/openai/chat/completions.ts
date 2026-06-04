import { getEnv, handleOptions, readBody, requireAllowedProxyRequest, sendJson, sendUpstream } from '../../_proxy';

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const ALLOWED_MODELS = new Set(['gpt-4o-mini']);

export default async function handler(req: any, res: any) {
    if (req.method === 'OPTIONS') {
        return handleOptions(req, res);
    }
    if (req.method !== 'POST') {
        return sendJson(req, res, 405, { error: 'Method not allowed' });
    }
    if (!requireAllowedProxyRequest(req, res)) {
        return;
    }

    const apiKey = getEnv('OPENAI_API_KEY')?.trim();
    if (!apiKey) {
        return sendJson(req, res, 500, { error: 'OPENAI_API_KEY is not configured.' });
    }

    try {
        const rawBody = await readBody(req);
        const body = JSON.parse(new TextDecoder().decode(rawBody));
        const model = typeof body?.model === 'string' && ALLOWED_MODELS.has(body.model) ? body.model : 'gpt-4o-mini';
        const upstreamBody = {
            model,
            messages: Array.isArray(body?.messages) ? body.messages : [],
            tools: Array.isArray(body?.tools) ? body.tools : undefined,
            tool_choice: body?.tool_choice ?? undefined
        };

        if (upstreamBody.messages.length === 0) {
            return sendJson(req, res, 400, { error: 'messages are required.' });
        }

        const upstream = await fetch(OPENAI_CHAT_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(upstreamBody)
        });
        return sendUpstream(req, res, upstream);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'OpenAI chat proxy failed.';
        return sendJson(req, res, 500, { error: message });
    }
}
