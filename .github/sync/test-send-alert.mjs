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

test("recovery reacts to every prior failure across history pages without posting a new message", async () => {
	const { deliverSlackAlert } = await import("./slack-alert.mjs");
	const messages = [];
	const reactions = [];
	let resolving = false;
	const fakeFetch = (url, init) => {
		const method = new URL(url).pathname.split("/").at(-1);
		const body = JSON.parse(init.body);
		if (method === "auth.test") return Promise.resolve(Response.json({ ok: true, user_id: "UBOT" }));
		if (method === "conversations.history") {
			if (resolving && !body.cursor)
				return Promise.resolve(
					Response.json({ ok: true, messages: messages.slice(1), has_more: true, response_metadata: { next_cursor: "older" } })
				);
			return Promise.resolve(Response.json({ ok: true, messages: resolving ? messages.slice(0, 1) : messages, has_more: false }));
		}
		if (method === "chat.postMessage") {
			const ts = `179532000${messages.length}.000001`;
			messages.push({ ...body, ts, user: "UBOT" });
			return Promise.resolve(Response.json({ ok: true, ts }));
		}
		assert.equal(method, "reactions.add");
		reactions.push(body.timestamp);
		return Promise.resolve(Response.json({ ok: true }));
	};
	const alert = { channel: "C0CCLJ45P99", key: "updates", id: "first", occurredAt: 1795320000000, text: "failed", resolved: false };
	await deliverSlackAlert("test", alert, fakeFetch);
	await deliverSlackAlert("test", { ...alert, id: "second", occurredAt: alert.occurredAt + 1000 }, fakeFetch);
	resolving = true;
	await deliverSlackAlert("test", { ...alert, id: "success", occurredAt: alert.occurredAt + 2000, resolved: true }, fakeFetch);
	assert.deepEqual(new Set(reactions), new Set(messages.map(message => message.ts)));
	assert.equal(messages.length, 2);
});
