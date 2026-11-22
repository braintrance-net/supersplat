import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notification } from './send-alert.mjs';
const env = { RUN: 'https://github.com/braintrance-net/supersplat/actions/runs/1', GITHUB_REF_NAME: 'main', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', RUN_STARTED_AT: '2026-11-22T06:00:00Z', FAILED: 'false' };
test('only verified landing or clean no-change resolves, not hold or partial failure', () => {
    for (const [extra, expected] of [[{LANDED:'yes'},true],[{BEHIND:'false'},true],[{LANDED:'yes',FAILED:'true'},false],[{BEHIND:'true'},false],[{BEHIND:'false',FAILED:'true'},false]]) {
        const result = notification({...env, ...extra}, {text:'Candidate notes'});
        assert.equal(result.resolved, expected);
        assert.match(result.text, /\*Branch:\* main/);
        assert.match(result.text, /\|Sync with Upstream>/);
    }
});
