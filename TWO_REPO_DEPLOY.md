## Two-Repo Deployment Plan

This codebase is now ready for the website and editor to be deployed separately.

### Repo 1: Website

Use the contents of `web/`.

What it contains:
- marketing/homepage
- upload flow for splats
- upload flow for 2D image/video world generation
- same-origin proxy routes for generated `.spz` files
- editor handoff via `NEXT_PUBLIC_EDITOR_URL`

Deploy target:
- Vercel project in your org

Required env vars:
- `NEXT_PUBLIC_EDITOR_URL`
- `WORLDGEN_API_BASE_URL`

### Repo 2: Editor

Use the editor app from the repo root.

What it contains:
- the Gaussian splat editor
- Rollup build
- static assets
- optional AI/editor backend integrations from Rollup env vars

Deploy target:
- separate Vercel project, or any static hosting/CDN

Relevant env vars for editor deployment:
- `BASE_HREF`
- `BOXER_BACKEND_URL`
- `SAM3_BACKEND_URL`
- `SKETCHFAB_API_TOKEN`
- `OPENAI_API_KEY`

### Recommended Split

If you create two GitHub repos, copy:

Website repo:
- `web/`

Editor repo:
- everything needed by the root editor app:
  - `src/`
  - `static/`
  - `package.json`
  - `package-lock.json`
  - `tsconfig.json`
  - `rollup.config.mjs`
  - `copy-and-watch.mjs`
  - `global.d.ts`
  - `eslint.config.mjs`
  - `README.md`
  - `LICENSE`

### Suggested URLs

- website: `braintrance.com` or `app.braintrance.com`
- editor: `editor.braintrance.com`

Then set:

```bash
NEXT_PUBLIC_EDITOR_URL=https://editor.braintrance.com
```

### Important Production Note

The world-generation flow will only work in production if `WORLDGEN_API_BASE_URL` points to a real reachable API URL.

It cannot remain:

```bash
http://127.0.0.1:18000/api
```

That value is local-dev only.
