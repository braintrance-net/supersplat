import { readFileSync } from 'node:fs';
import { deliverSlackAlert } from './slack-alert.mjs';

export function notification(env, details) {
    const { RUN, GITHUB_REF_NAME, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, RUN_STARTED_AT, LANDED, FAILED, BEHIND } = env;
    if (!RUN?.startsWith('https://github.com/braintrance-net/supersplat/actions/runs/') || !GITHUB_REF_NAME || !GITHUB_RUN_ID || !RUN_STARTED_AT) {
        throw new Error('Missing trusted workflow context');
    }
    const resolved = FAILED === 'false' && (LANDED === 'yes' || BEHIND === 'false');
    const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return {
        channel: 'C0CCLJ45P99', key: `supersplat-sync:${GITHUB_REF_NAME}`,
        id: `${GITHUB_RUN_ID}:${GITHUB_RUN_ATTEMPT}`, occurredAt: Date.parse(RUN_STARTED_AT),
        resolved, missingWarning: "ignore",
        text: `:warning: *SuperSplat upstream sync*\n*Status:* ${LANDED === 'yes' ? 'Landed, but a workflow step failed' : 'Failed or held for review'}\n*Branch:* ${escape(GITHUB_REF_NAME)}\n*Run:* <${RUN}|Sync with Upstream>\n${details.text}`
    };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
    const token = process.env.SLACK_ALERTS_BOT_TOKEN;
    if (!token) throw new Error('Missing Slack bot token');
    await deliverSlackAlert(token, notification(process.env, JSON.parse(readFileSync(process.argv[2], 'utf8'))));
}
