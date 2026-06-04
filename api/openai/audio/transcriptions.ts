import { getEnv, handleOptions, readBody, sendJson, sendUpstream } from '../../_proxy';

const OPENAI_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';

export const config = {
    api: {
        bodyParser: false
    }
};

export default async function handler(req: any, res: any) {
    if (req.method === 'OPTIONS') {
        return handleOptions(req, res);
    }
    if (req.method !== 'POST') {
        return sendJson(req, res, 405, { error: 'Method not allowed' });
    }

    const apiKey = getEnv('OPENAI_API_KEY')?.trim();
    if (!apiKey) {
        return sendJson(req, res, 500, { error: 'OPENAI_API_KEY is not configured.' });
    }

    const contentType = req.headers?.['content-type'];
    if (typeof contentType !== 'string' || !contentType.includes('multipart/form-data')) {
        return sendJson(req, res, 400, { error: 'multipart/form-data is required.' });
    }

    try {
        const body = await readBody(req);
        const uploadBody = new Uint8Array(body.byteLength);
        uploadBody.set(body);
        const upstream = await fetch(OPENAI_TRANSCRIPTIONS_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': contentType
            },
            body: uploadBody.buffer
        });
        return sendUpstream(req, res, upstream);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'OpenAI transcription proxy failed.';
        return sendJson(req, res, 500, { error: message });
    }
}
