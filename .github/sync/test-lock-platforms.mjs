import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPlatforms } from './check-lock-platforms.mjs';

const path = 'node_modules/@rollup/rollup-linux-x64-gnu';
const artifact = { version: '1', resolved: 'https://registry.example/package.tgz',
    integrity: 'sha512-example', os: ['linux'], cpu: ['x64'], libc: ['glibc'] };
const lock = entry => ({ packages: { [path]: entry } });

for (const field of ['os', 'cpu', 'libc']) {
    test(`rejects deleted or changed ${field} constraints on the same artifact`, () => {
        const removed = { ...artifact };
        delete removed[field];
        assert.throws(() => checkPlatforms(lock(artifact), lock(removed)), /constraints/);
        assert.throws(() => checkPlatforms(lock(artifact), lock({ ...artifact, [field]: ['other'] })), /constraints/);
    });
}

test('accepts preserved constraints and ignores array order', () => {
    checkPlatforms(lock(artifact), lock({ ...artifact, dev: true }));
    checkPlatforms(lock({ ...artifact, os: ['linux', 'darwin'] }),
        lock({ ...artifact, os: ['darwin', 'linux'] }));
});

test('allows removed dependencies and changed artifacts', () => {
    checkPlatforms(lock(artifact), lock(undefined));
    checkPlatforms(lock(artifact), lock({ version: '2', integrity: 'sha512-new' }));
});
