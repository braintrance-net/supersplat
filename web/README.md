## Web App

This is the BrainTrance website and world-generation frontend.

### Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

### Required Environment Variables

Copy `.env.example` to `.env.local` and set:

```bash
NEXT_PUBLIC_EDITOR_URL=http://localhost:3000
WORLDGEN_API_BASE_URL=http://127.0.0.1:18000/api
```

Notes:
- `NEXT_PUBLIC_EDITOR_URL` is the separately deployed editor URL.
- `WORLDGEN_API_BASE_URL` must be a real, reachable API URL in production. `localhost` only works during local development with your SSH tunnel running.

### Deploying To Vercel

This app can be deployed independently as its own Vercel project or its own GitHub repo.

Set these env vars in Vercel:

```bash
NEXT_PUBLIC_EDITOR_URL=https://your-editor-domain.example
WORLDGEN_API_BASE_URL=https://your-worldgen-api.example/api
```
