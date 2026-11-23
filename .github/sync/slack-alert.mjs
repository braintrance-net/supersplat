// Vendored from lookleft/apps/cloud-agent/slack-alert.ts; keep lifecycle semantics in sync.
import { createHash } from "node:crypto";

                             
	                
	            
	           
	                   
	             
	                  
	                          
	                                       
	                          
 

const channelId = /^C[A-Z0-9]+$/;
const millisecondsPerSecond = 1000;
const hoursPerDay = 24;
const daysOfHistory = 30;
const requestTimeoutMs = 10_000;
const pageSize = 200;
const timestamp = /^\d+\.\d+$/;
const maxPages = 50;
const deliveryClockSlackMs = 60_000;
const historyWindowMs = daysOfHistory * hoursPerDay * 60 * 60 * millisecondsPerSecond;

                          
	           
	                   
	                
 

function warningReceipts(messages           , user        , marker        , cutoff        )                   {
	const matches                   = [];
	for (const message of messages) {
		if (
			typeof message !== "object" ||
			message === null ||
			!("user" in message) ||
			message.user !== user ||
			!("ts" in message) ||
			typeof message.ts !== "string" ||
			!timestamp.test(message.ts) ||
			!("blocks" in message) ||
			!Array.isArray(message.blocks)
		) {
			continue;
		}
		const blocks            = message.blocks;
		for (const block of blocks) {
			if (
				typeof block !== "object" ||
				block === null ||
				!("block_id" in block) ||
				typeof block.block_id !== "string" ||
				!block.block_id.startsWith(marker)
			) {
				continue;
			}
			const occurredAt = Number(block.block_id.slice(marker.length).split(":")[0]);
			if (Number.isFinite(occurredAt) && occurredAt <= cutoff) {
				matches.push({ ts: message.ts, occurredAt, receipt: block.block_id });
			}
		}
	}
	return matches;
}

                        
	                
	                 
	                                       
 
                      
	              
	                                             
	                                           
 
                                            
                   
	                                 
	                 
	                                                                                                       
	                                                                                 
                                                                         

function createSlackClient(token        , fetchImpl              )            {
	return async (method        , body              ) => {
		const response = await fetchImpl(`https://slack.com/api/${method}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": body instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json"
			},
			body: body instanceof URLSearchParams ? body.toString() : JSON.stringify(body),
			redirect: "error",
			signal: AbortSignal.timeout(requestTimeoutMs)
		});
		if (!response.ok) {
			throw new Error(`Slack ${method} returned HTTP ${response.status}`);
		}
		const value          = await response.json();
		if (
			typeof value !== "object" ||
			value === null ||
			!("ok" in value) ||
			(value.ok !== true && !(method === "reactions.add" && "error" in value && value.error === "already_reacted"))
		) {
			throw new Error(`Slack rejected ${method}`);
		}
		return value;
	};
}

async function findWarnings(call           , alert            , user        , marker        ) {
	let cursor = "";
	const cursors = new Set        ();
	const matches                   = [];
	for (let page = 0; page < maxPages; page++) {
		// biome-ignore lint/performance/noAwaitInLoops: Each history page depends on the previous cursor.
		const history = await call("conversations.history", {
			channel: alert.channel,
			oldest: String((alert.occurredAt - (alert.resolved ? historyWindowMs : deliveryClockSlackMs)) / millisecondsPerSecond),
			limit: pageSize,
			cursor
		});
		if (!("messages" in history) || !Array.isArray(history.messages)) {
			throw new Error("Invalid Slack history");
		}
		matches.push(...warningReceipts(history.messages, user, marker, alert.occurredAt));
		if (!("has_more" in history) || typeof history.has_more !== "boolean") {
			throw new Error("Incomplete Slack history");
		}
		if (!history.has_more) {
			break;
		}
		const metadata = "response_metadata" in history ? history.response_metadata : undefined;
		cursor =
			typeof metadata === "object" && metadata !== null && "next_cursor" in metadata && typeof metadata.next_cursor === "string"
				? metadata.next_cursor
				: "";
		if (!cursor || cursors.has(cursor) || page === maxPages - 1) {
			throw new Error("Incomplete Slack history");
		}
		cursors.add(cursor);
	}
	return matches;
}

function tableBlock(rows                    )             {
	return {
		type: "table",
		rows: [["Field", "Value"], ...rows].map(row => row.map(text => ({ type: "raw_text", text }))),
		column_settings: [{ is_wrapped: true }, { is_wrapped: true }]
	};
}

const filenameHashLength = 16;

async function shareJson(
	call           ,
	fetchImpl              ,
	alert                                                          ,
	section              ,
	user        ,
	marker        ,
	receipt        
) {
	const filename = `alert-${createHash("sha256").update(alert.id).digest("hex").slice(0, filenameHashLength)}.json`;
	const upload = await call("files.getUploadURLExternal", new URLSearchParams({ filename, length: String(Buffer.byteLength(alert.json)) }));
	if (!("upload_url" in upload) || typeof upload.upload_url !== "string" || !("file_id" in upload) || typeof upload.file_id !== "string") {
		throw new Error("Missing Slack file upload receipt");
	}
	const uploadUrl = new URL(upload.upload_url);
	if (uploadUrl.protocol !== "https:" || !uploadUrl.hostname.endsWith(".slack.com")) {
		throw new Error("Invalid Slack file upload URL");
	}
	const uploaded = await fetchImpl(uploadUrl, {
		method: "POST",
		body: alert.json,
		redirect: "error",
		signal: AbortSignal.timeout(requestTimeoutMs)
	});
	if (!uploaded.ok) {
		throw new Error("Slack JSON upload failed");
	}
	const table = tableBlock(alert.table);
	await call("files.completeUploadExternal", {
		files: [{ id: upload.file_id, title: filename }],
		channel_id: alert.channel,
		blocks: JSON.stringify([section, table])
	});
	const history = await call("conversations.history", {
		channel: alert.channel,
		limit: pageSize,
		oldest: String(alert.occurredAt / millisecondsPerSecond)
	});
	if (!("messages" in history) || !Array.isArray(history.messages)) {
		throw new Error("Invalid Slack file message history");
	}
	const original = warningReceipts(history.messages, user, marker, alert.occurredAt).find(match => match.receipt === receipt);
	if (!original) {
		throw new Error("Slack file message receipt was not found");
	}
	return original.ts;
}

/** Slack's warning is the receipt: retries find it again, and recovery only adds a reaction. */
export async function deliverSlackAlert(token        , alert            , fetchImpl               = fetch) {
	if (!channelId.test(alert.channel) || !alert.key || !alert.id || !Number.isFinite(alert.occurredAt) || alert.occurredAt <= 0) {
		throw new Error("Invalid Slack alert identity");
	}
	const marker = `lookleft:${createHash("sha256").update(alert.key).digest("hex")}:`;
	const receipt = `${marker}${alert.occurredAt}:${createHash("sha256").update(alert.id).digest("hex")}`;
	const call = createSlackClient(token, fetchImpl);
	const identity = await call("auth.test", {});
	if (!("user_id" in identity) || typeof identity.user_id !== "string") {
		throw new Error("Missing Slack bot identity");
	}
	const matches = await findWarnings(call, alert, identity.user_id, marker);
	const link = (ts        ) => `https://braintrance.slack.com/archives/${alert.channel}/p${ts.replace(".", "")}`;
	if (alert.resolved) {
		const [original] = matches.sort((a, b) => b.occurredAt - a.occurredAt || Number(b.ts) - Number(a.ts));
		if (!original) {
			if (alert.missingWarning === "ignore") {
				return "";
			}
			throw new Error("Original warning not found; resolution was not posted");
		}
		for (const warning of matches) {
			await call("reactions.add", { channel: alert.channel, timestamp: warning.ts, name: "white_check_mark" });
		}
		return link(original.ts);
	}
	const previous = matches.find(match => match.receipt === receipt);
	if (previous) {
		return link(previous.ts);
	}
	const section               = { type: "section", block_id: receipt, text: { type: "mrkdwn", text: alert.text } };
	if (alert.json !== undefined && alert.table !== undefined) {
		const ts = await shareJson(
			call,
			fetchImpl,
			{ ...alert, json: alert.json, table: alert.table },
			section,
			identity.user_id,
			marker,
			receipt
		);
		return link(ts);
	}
	const blocks               = [section];
	if (alert.table) {
		blocks.push(tableBlock(alert.table));
	}
	const posted = await call("chat.postMessage", {
		channel: alert.channel,
		text: alert.text,
		unfurl_links: false,
		unfurl_media: false,
		blocks
	});
	if (!("ts" in posted) || typeof posted.ts !== "string" || !timestamp.test(posted.ts)) {
		throw new Error("Missing Slack warning receipt");
	}
	return link(posted.ts);
}
