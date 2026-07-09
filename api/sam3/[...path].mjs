// Same-origin SAM3 proxy for the hosted editor.
//
// The browser (HTTPS vercel.app) can't call the SAM model server directly because it's
// http://ec2-…:8000 (mixed-content blocked). This serverless function runs SERVER-SIDE, so it
// forwards /api/sam3/* to the HTTP EC2 verbatim — same pattern the monorepo web app uses. The
// editor points its SAM3 backend at its own origin in production (see getSam3BackendUrl), so
// requests land here. Locally the dev build talks to the IP/dev-proxy directly and never hits this.
//
// SAM inference can take several seconds per view; maxDuration must cover it (needs a Vercel plan
// that allows >10s — Pro/Enterprise).
export const config = { maxDuration: 60 };

const UPSTREAM = (process.env.SAM3_UPSTREAM || 'http://ec2-3-19-208-185.us-east-2.compute.amazonaws.com:8000').replace(/\/$/, '');

// Hop-by-hop / connection headers must not be forwarded.
const STRIP_REQUEST_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding']);
const STRIP_RESPONSE_HEADERS = new Set(['content-encoding', 'transfer-encoding', 'connection', 'content-length']);

const readBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    return chunks.length ? Buffer.concat(chunks) : undefined;
};

export default async function handler(req, res) {
    try {
        // Derive the sub-path robustly from req.url (req.query.path is not reliably populated for
        // catch-all functions across runtimes). req.url may or may not include the /api/sam3 prefix.
        const parsed = new URL(req.url, 'http://internal');
        const sub = parsed.pathname.replace(/^\/api\/sam3/, '').replace(/^\/+/, '');
        const upstreamUrl = `${UPSTREAM}/api/sam3/${sub}${parsed.search}`;

        const headers = {};
        for (const [key, value] of Object.entries(req.headers)) {
            if (STRIP_REQUEST_HEADERS.has(key.toLowerCase())) {
                continue;
            }
            if (value !== undefined) {
                headers[key] = Array.isArray(value) ? value.join(', ') : value;
            }
        }

        const method = req.method || 'GET';
        const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);

        const upstreamRes = await fetch(upstreamUrl, { method, headers, body });

        res.statusCode = upstreamRes.status;
        upstreamRes.headers.forEach((value, key) => {
            if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
                res.setHeader(key, value);
            }
        });
        const buffer = Buffer.from(await upstreamRes.arrayBuffer());
        res.end(buffer);
    } catch (err) {
        res.statusCode = 502;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'sam3-proxy-failed', detail: String(err?.message ?? err) }));
    }
}
