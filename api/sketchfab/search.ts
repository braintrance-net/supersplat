import { applyCors, getEnv, getRequestUrl, handleOptions, requireAllowedProxyRequest, sendJson, sendUpstream } from '../_proxy';

const SKETCHFAB_SEARCH_URL = 'https://api.sketchfab.com/v3/search';

export default async function handler(req: any, res: any) {
    if (req.method === 'OPTIONS') {
        return handleOptions(req, res);
    }
    if (req.method !== 'GET') {
        return sendJson(req, res, 405, { error: 'Method not allowed' });
    }
    if (!requireAllowedProxyRequest(req, res)) {
        return;
    }

    const token = getEnv('SKETCHFAB_API_TOKEN')?.trim();
    if (!token) {
        return sendJson(req, res, 500, { error: 'SKETCHFAB_API_TOKEN is not configured.' });
    }

    try {
        const requestUrl = getRequestUrl(req);
        const upstreamUrl = new URL(SKETCHFAB_SEARCH_URL);
        requestUrl.searchParams.forEach((value, key) => {
            upstreamUrl.searchParams.append(key, value);
        });

        const upstream = await fetch(upstreamUrl, {
            headers: {
                Authorization: `Token ${token}`
            }
        });
        return sendUpstream(req, res, upstream);
    } catch (error) {
        applyCors(req, res);
        const message = error instanceof Error ? error.message : 'Sketchfab search proxy failed.';
        return sendJson(req, res, 500, { error: message });
    }
}
