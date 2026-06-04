import { getEnv, getRequestUrl, handleOptions, requireAllowedProxyRequest, sendJson, sendUpstream } from '../../../_proxy';

const getUid = (req: any) => {
    const queryUid = req.query?.uid;
    if (Array.isArray(queryUid)) {
        return queryUid[0];
    }
    if (typeof queryUid === 'string') {
        return queryUid;
    }

    const pathname = getRequestUrl(req).pathname;
    const match = pathname.match(/\/api\/sketchfab\/models\/([^/]+)\/download$/);
    return match ? decodeURIComponent(match[1]) : '';
};

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

    const uid = getUid(req);
    if (!uid || !/^[a-z0-9_-]+$/i.test(uid)) {
        return sendJson(req, res, 400, { error: 'A valid Sketchfab model uid is required.' });
    }

    try {
        const upstream = await fetch(`https://api.sketchfab.com/v3/models/${encodeURIComponent(uid)}/download`, {
            headers: {
                Authorization: `Token ${token}`
            }
        });
        return sendUpstream(req, res, upstream);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Sketchfab download proxy failed.';
        return sendJson(req, res, 500, { error: message });
    }
}
