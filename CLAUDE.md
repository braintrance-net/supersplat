# SuperSplat Editor (Board Meeting Prototype)

Fork of [PlayCanvas SuperSplat](https://github.com/playcanvas/supersplat) — a browser-based 3D Gaussian Splat editor. This fork adds AI-powered selection tools (Boxer, SAM3) and UI customizations.

## Quick Start

```bash
# Install dependencies
npm install

# Dev with hosted AI backends + test asset
npm run develop:desk:ai:hosted

# Dev with local Boxer backend
npm run develop:desk:boxer

# Plain dev (no AI, no test asset)
npm run develop

# Production build
npm run build

# Lint
npm run lint
```

Dev server runs at http://localhost:3000.

## Key npm Scripts

| Script | Description |
|--------|-------------|
| `develop` | Debug build + watch + serve |
| `develop:desk` | + desk.ply test asset + dev tools |
| `develop:desk:boxer` | + local Boxer backend (localhost:47823) |
| `develop:desk:boxer:hosted` | + hosted Boxer (boxer.4dream.app) |
| `develop:desk:ai:hosted` | + hosted Boxer AND SAM3 backends |
| `build` | Production rollup build |
| `lint` | ESLint check |

## Environment Variables

Set via `cross-env` in npm scripts or shell:

| Variable | Purpose | Default fallback |
|----------|---------|-----------------|
| `BUILD_TYPE` | `debug`, `profile`, or `release` | `release` |
| `BOXER_BACKEND_URL` | Boxer AI backend | Runtime config from board-demo web or `https://boxer.4dream.app` |
| `SAM3_BACKEND_URL` | SAM3 AI backend | `http://3.19.208.185:8000` |
| `DEFAULT_SPLAT_URL` | Auto-load splat file on startup | none |
| `DEFAULT_CAMERA_POSITION` | Comma-separated x,y,z | none |
| `DEFAULT_CAMERA_TARGET` | Comma-separated x,y,z | none |
| `DEFAULT_CAMERA_FOV` | Field of view degrees | none |
| `DEV_TOOLS` | Enable dev menu actions | `false` |
| `BASE_HREF` | Subdirectory deployment path | `''` |

These get injected into `window.supersplatConfig` via rollup at build time.

## Tech Stack

- **TypeScript** (ES2022 target, ESM)
- **Rollup** — bundler (outputs to `dist/`)
- **PlayCanvas Engine** v2.16 — 3D rendering
- **@playcanvas/pcui** — UI component library
- **SCSS** — styling with `sass` + PostCSS autoprefixer
- **i18next** — localization (9 languages in `static/locales/`)

## Source Structure

```
src/
├── main.ts              # App init, tool registration, event wiring
├── editor.ts            # Editor event handlers (largest file)
├── scene.ts             # PlayCanvas scene manager
├── splat.ts             # Splat entity representation
├── events.ts            # Central event bus (extends PlayCanvas EventHandler)
├── index.html           # HTML template (config injected by rollup)
├── sw.ts                # Service worker (PWA)
├── tools/
│   ├── tool-manager.ts  # Tool registration and switching
│   ├── rect-selection.ts, brush-selection.ts, polygon-selection.ts, ...
│   ├── boxer-selection.ts   # AI bounding box detection (custom)
│   ├── sam3-selection.ts    # AI segmentation (custom)
│   ├── move-tool.ts, rotate-tool.ts, scale-tool.ts
│   └── measure-tool.ts
├── ui/
│   ├── editor.ts        # Main UI container
│   ├── bottom-toolbar.ts # Selection tool buttons
│   ├── right-toolbar.ts  # Camera/view controls
│   ├── menu.ts          # Menu bar (File/Render/Select/Help)
│   ├── svg/             # SVG icons (38x38, use fill="currentColor")
│   ├── scss/            # Stylesheets (25 files)
│   │   ├── colors.scss  # Theme variables ($clr-default, $bcg-primary, etc.)
│   │   ├── style.scss   # Main import file
│   │   └── ...
│   └── [panels, dialogs, components]
├── shaders/             # WebGL shaders (11 files)
├── data-processor/      # GPU-accelerated data ops
├── io/                  # File read/write (PLY, SPZ formats)
├── anim/                # Animation/spline system
└── utils/               # Helpers
```

## Architecture

### Event System
Central `Events` class. Tools and UI communicate via named events:
- `events.fire('tool.rectSelection')` — activate a tool
- `events.on('tool.activated', (name) => ...)` — react to tool changes
- `events.function('name', handler)` / `events.invoke('name')` — request/response pattern

### Tool System
Tools registered in `main.ts` via `toolManager.register(name, instance)`. Each tool extends a base pattern with activate/deactivate lifecycle. Bottom toolbar buttons fire `tool.<name>` events.

### SVG Icons
Icons in `src/ui/svg/` are imported as data URIs by `@rollup/plugin-image` (`dom: false`). Parsed back to DOM via:
```typescript
const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};
```
Icons must use `fill="currentColor"` to inherit CSS color. ViewBox should be `0 0 38 38` to match button size.

### SCSS Theming
Colors defined in `src/ui/scss/colors.scss`. Key variables:
- `$clr-default: #1a1a1a` — icon/text default color
- `$clr-active: white` — active tool icon color
- `$clr-disabled: #999999`
- `$bcg-primary: #FCFCFF` — main background
- `$clr-hilight: #000000` — active tool background
- Imports `pcui-theme-grey.scss` from PCUI

### AI Tools (Custom)
- **Boxer** (`boxer-selection.ts`) — Captures scene screenshot, sends to backend for oriented bounding box detection. Renders OBB visualization in cyan.
- **SAM3** (`sam3-selection.ts`) — Captures scene, sends click point to backend for segmentation mask. Projects mask onto splats via depth filtering.

Both extract camera intrinsics/extrinsics from PlayCanvas camera and fall back to hosted backends if no env var set.

## Build Output

Rollup outputs to `dist/`:
- `index.html` — with injected config
- `index.js` + `index.js.map` — bundled app
- `index.css` — compiled SCSS
- `static/` — copied assets (images, icons, locales, env, lib)

## Branches

- `main` — upstream SuperSplat sync point
- `local/braintrance-ui-dev` — active UI development
- `origin/boxer-ziyang`, `origin/sam3-ziyang` — AI tool feature branches

## Reference Directories

`simple-splat-reference/` and `spark-reference/` contain reference implementations (not part of the build). Useful for understanding alternative approaches.

## Common Tasks

**Adding a new toolbar icon**: Create SVG in `src/ui/svg/`, use `viewBox="0 0 38 38"`, `fill="currentColor"` on all paths. Import in the toolbar file, append via `createSvg()`.

**Adding a new tool**: Create tool class in `src/tools/`, register in `main.ts` via `toolManager.register()`, add button in `bottom-toolbar.ts`, add event handler in `editor.ts`.

**Changing theme colors**: Edit `src/ui/scss/colors.scss`.

**Testing with a splat file**: Place `.ply` in `static/dev-assets/`, reference via `DEFAULT_SPLAT_URL` env var.
