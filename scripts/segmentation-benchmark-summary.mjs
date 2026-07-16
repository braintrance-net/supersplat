import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
};
const outputPath = option('--out');
const inputs = [];
for (let index = 0; index < args.length; index++) {
    if (args[index] === '--out') {
        index++;
    } else if (!args[index].startsWith('--')) {
        inputs.push(args[index]);
    }
}
const requiredCategories = ['thin', 'adjacent', 'cluttered', 'translucent', 'occluded', 'wide-aspect'];

if (inputs.length === 0) {
    throw new Error('Pass one or more comparison bundle files or directories.');
}

const collectJson = async (path) => {
    const absolute = resolve(path);
    const details = await stat(absolute);
    if (details.isFile()) return absolute.endsWith('.json') ? [absolute] : [];
    const children = await readdir(absolute, { withFileTypes: true });
    const nested = await Promise.all(children.map(child => collectJson(resolve(absolute, child.name))));
    return nested.flat();
};

const percentile = (values, fraction) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};

const summarizeRuns = (runs) => {
    const successful = runs.filter(run => run.ok).map(run => run.totalMs);
    return {
        runs: runs.length,
        successes: successful.length,
        failures: runs.length - successful.length,
        failureRate: runs.length === 0 ? 0 : (runs.length - successful.length) / runs.length,
        p50Ms: percentile(successful, 0.5),
        p95Ms: percentile(successful, 0.95)
    };
};

const files = (await Promise.all(inputs.map(collectJson))).flat();
const bundles = (await Promise.all(files.map(async (file) => {
    const value = JSON.parse(await readFile(file, 'utf8'));
    return (Array.isArray(value) ? value : [value]).map(bundle => ({ ...bundle, sourceFile: file }));
}))).flat();

const providerRuns = { 'local-sam2': [], 'cloud-sam3': [] };
const concurrentRuns = [];
const grades = {
    mask: { 'local-sam2': 0, 'cloud-sam3': 0, tie: 0, ungraded: 0 },
    cut: { 'local-sam2': 0, 'cloud-sam3': 0, tie: 0, ungraded: 0 }
};
const environments = new Map();
const categories = new Set();

for (const bundle of bundles) {
    concurrentRuns.push({ ok: !!bundle.local && !!bundle.cloud, totalMs: Number(bundle.totalMs) || 0 });
    for (const key of ['local', 'cloud']) {
        const candidate = bundle[key];
        const provider = candidate?.provider ?? (key === 'local' ? 'local-sam2' : 'cloud-sam3');
        providerRuns[provider]?.push({
            ok: !!candidate && !candidate.error && Number.isFinite(candidate.timings?.totalMs),
            totalMs: Number(candidate?.timings?.totalMs) || 0
        });
    }
    const environmentKey = `${bundle.userAgent ?? 'unknown'}|${bundle.gpu ?? 'unknown'}|${bundle.viewport ?? 'unknown'}|${bundle.devicePixelRatio ?? 'unknown'}`;
    environments.set(environmentKey, (environments.get(environmentKey) ?? 0) + 1);
    if (bundle.golden?.category) categories.add(bundle.golden.category);
    for (const kind of ['mask', 'cut']) {
        const grade = bundle.grades?.[kind];
        if (!grade) {
            grades[kind].ungraded++;
        } else if (grade === 'tie') {
            grades[kind].tie++;
        } else {
            const provider = bundle.mapping?.[grade];
            if (provider in grades[kind]) grades[kind][provider]++;
            else grades[kind].ungraded++;
        }
    }
}

const missingCategories = requiredCategories.filter(category => !categories.has(category));
const report = {
    generatedAt: new Date().toISOString(),
    bundleCount: bundles.length,
    providers: Object.fromEntries(Object.entries(providerRuns).map(([provider, runs]) => [provider, summarizeRuns(runs)])),
    concurrentProductTiming: summarizeRuns(concurrentRuns),
    blindGrades: grades,
    goldenCategories: [...categories].sort(),
    missingGoldenCategories: missingCategories,
    environments: [...environments.entries()].map(([identity, runs]) => ({ identity, runs }))
};

if (flag('--require-graded') && bundles.some(bundle => !bundle.grades?.mask || !bundle.grades?.cut)) {
    throw new Error('At least one comparison bundle is missing both blind grades.');
}
if (flag('--require-real-gpu') && bundles.some(bundle => !bundle.gpu || /swiftshader|llvmpipe|software/i.test(bundle.gpu))) {
    throw new Error('At least one comparison bundle is missing a hardware GPU identity.');
}
if (flag('--require-golden-categories') && missingCategories.length > 0) {
    throw new Error(`Missing golden categories: ${missingCategories.join(', ')}`);
}

const output = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) await writeFile(resolve(outputPath), output);
else process.stdout.write(output);
