import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Only compare the same artifact: an upgrade may legitimately change platform support.
export function checkPlatforms(before, after) {
    for (const [path, original] of Object.entries(before.packages ?? {})) {
        const current = after.packages?.[path];
        if (!path || !current || !original.integrity ||
            ['version', 'resolved', 'integrity'].some(key => original[key] !== current[key])) continue;
        for (const key of ['os', 'cpu', 'libc']) {
            if (original[key] === undefined) continue;
            assert.deepEqual(current[key]?.slice().sort(), original[key].slice().sort(),
                `${path}: regeneration changed ${key} constraints for an unchanged artifact`);
        }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [before, after] = process.argv.slice(2).map(path => JSON.parse(readFileSync(path, 'utf8')));
    checkPlatforms(before, after);
}
