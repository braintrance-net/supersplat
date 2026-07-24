// Post-build step: replace SuperSplat's cache-first service worker with a killswitch.
//
// The editor build emits a cache-first worker (src/sw.ts -> dist/sw.js) plus its registration in
// dist/index.html. Downstream the web app vendors this dist/ into apps/web/public/splat-editor/,
// where that worker serves stale cached editor bundles and breaks the share-page editor/viewer
// handoff. Shipping the killswitch in dist/ means every consumer of the build gets it without a
// separate post-vendor patch (original fix: commit 2e859a582, "fix: clear stale splat editor
// service worker", PR #1271).
//
// Plain .mjs rather than scripts/*.ts + tsx: this runs with bare Node right after rollup, before
// (and independently of) any TS toolchain.
import { readFileSync, rmSync, writeFileSync } from "node:fs";

const editorDir = new URL("../dist/", import.meta.url);

const KILLSWITCH_SW = `self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter(name => name.startsWith('superSplat-')).map(name => caches.delete(name)));
        await self.clients.claim();
        await self.registration.unregister();
    })());
});
`;

const KILLSWITCH_REGISTRATION = `<!-- Clear the old cache-first editor service worker. The app shell is small,
             and stale editor bundles break the share-page editor/viewer handoff. -->
        <script>
            const sw = navigator.serviceWorker;
            if (sw) {
                sw.getRegistrations()
                    .then(registrations => {
                        registrations
                            .filter(reg => reg.scope === new URL('./', window.location.href).href)
                            .forEach(reg => reg.unregister());
                    })
                    .catch(err => console.log('failed to unregister service worker', err));
            }

            if (window.caches) {
                caches.keys()
                    .then(names => {
                        names
                            .filter(name => name.startsWith('superSplat-'))
                            .forEach(name => caches.delete(name));
                    })
                    .catch(err => console.log('failed to clear service worker cache', err));
            }
        </script>`;

writeFileSync(new URL("sw.js", editorDir), KILLSWITCH_SW);
rmSync(new URL("sw.js.map", editorDir), { force: true });

const indexPath = new URL("index.html", editorDir);
const html = readFileSync(indexPath, "utf8");
const upstreamRegistrationBlock = /<!-- Service worker -->\s*<script>[\s\S]*?<\/script>/;

if (upstreamRegistrationBlock.test(html)) {
	writeFileSync(indexPath, html.replace(upstreamRegistrationBlock, KILLSWITCH_REGISTRATION));
	process.stdout.write("patch-splat-editor-sw: replaced service-worker registration in index.html\n");
} else if (html.includes("failed to unregister service worker")) {
	process.stdout.write("patch-splat-editor-sw: index.html already carries the killswitch; nothing to do\n");
} else {
	// The build restructured index.html and this patch no longer matches - fail the build loudly
	// instead of shipping a silently re-enabled cache-first worker.
	process.stderr.write(
		"patch-splat-editor-sw: no service-worker block found in index.html; update this script for the new build layout\n"
	);
	process.exit(1);
}
