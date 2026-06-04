const EDITOR_ORIGIN_PATTERNS = [
    /^https:\/\/board-demo-editor(?:-[a-z0-9-]+)?\.vercel\.app$/i,
    /^https:\/\/board-demo-web(?:-[a-z0-9-]+)?\.vercel\.app$/i,
    /^http:\/\/localhost:\d+$/i,
    /^http:\/\/127\.0\.0\.1:\d+$/i
];

export const applyCors = (req: any, res: any) => {
    const origin = typeof req.headers?.origin === 'string' ? req.headers.origin : '';
    if (origin && EDITOR_ORIGIN_PATTERNS.some(pattern => pattern.test(origin))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
};

export const handleOptions = (req: any, res: any) => {
    applyCors(req, res);
    res.statusCode = 204;
    res.end();
};

export const getEnv = (key: string) => {
    const runtime = globalThis as unknown as { process?: { env?: Record<string, string | undefined> } };
    return runtime.process?.env?.[key];
};

const textEncoder = new TextEncoder();

const concatBytes = (chunks: Uint8Array[]) => {
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
};

export const readBody = (req: any): Promise<Uint8Array> => {
    if (req.body instanceof Uint8Array) {
        return Promise.resolve(req.body);
    }
    if (typeof req.body === 'string') {
        return Promise.resolve(textEncoder.encode(req.body));
    }
    if (req.body && typeof req.body === 'object') {
        return Promise.resolve(textEncoder.encode(JSON.stringify(req.body)));
    }

    return new Promise((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        req.on('data', (chunk: Uint8Array | string) => {
            chunks.push(typeof chunk === 'string' ? textEncoder.encode(chunk) : chunk);
        });
        req.on('end', () => resolve(concatBytes(chunks)));
        req.on('error', reject);
    });
};

export const sendJson = (req: any, res: any, statusCode: number, body: unknown) => {
    applyCors(req, res);
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
};

export const sendUpstream = async (req: any, res: any, upstream: Response) => {
    applyCors(req, res);
    res.statusCode = upstream.status;
    const contentType = upstream.headers.get('content-type');
    if (contentType) {
        res.setHeader('Content-Type', contentType);
    }
    const text = await upstream.text();
    res.end(text);
};

export const getRequestUrl = (req: any) => new URL(req.url || '/', 'https://board-demo-editor.vercel.app');
