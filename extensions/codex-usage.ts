/**
 * Codex Usage Extension - shows OpenAI Codex usage limits and remaining quota.
 *
 * Fetches data from ChatGPT backend API using the existing OAuth token.
 *
 * Usage: pi --extension ./codex-usage.ts
 * Then use `/codex-usage` command in the TUI.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface ChatGPTUsageResponse {
	user_id: string;
	account_id: string;
	email: string;
	plan_type: string;
	rate_limit: {
		allowed: boolean;
		limit_reached: boolean;
		primary_window: {
			used_percent: number;
			limit_window_seconds: number;
			reset_after_seconds: number;
			reset_at: number;
		};
		secondary_window: {
			used_percent: number;
			limit_window_seconds: number;
			reset_after_seconds: number;
			reset_at: number;
		};
	};
	code_review_rate_limit: null | object;
	additional_rate_limits: null | object;
	credits: {
		has_credits: boolean;
		unlimited: boolean;
		overage_limit_reached: boolean;
		balance: string;
		approx_local_messages: number[];
		approx_cloud_messages: number[];
	};
	spend_control: {
		reached: boolean;
		individual_limit: null | object;
	};
	rate_limit_reached_type: null | string;
	promo: null | object;
	referral_beacon: null | object;
	rate_limit_reset_credits: {
		available_count: number;
	};
}

function getAgentDir(): string {
	// Check environment variable first
	if (process.env.PI_CONFIG_DIR) {
		return process.env.PI_CONFIG_DIR;
	}
	// Default to ~/.pi/agent
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) {
		throw new Error("Could not determine home directory");
	}
	return join(home, ".pi", "agent");
}

function loadAuthToken(): string | null {
	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");

	try {
		const content = readFileSync(authPath, "utf-8");
		const auth = JSON.parse(content);
		const codexAuth = auth["openai-codex"];
		if (codexAuth?.type === "oauth" && codexAuth.access) {
			return codexAuth.access;
		}
	} catch {
		// File doesn't exist or invalid JSON
	}
	return null;
}

function formatDuration(seconds: number): string {
	const mins = Math.floor(seconds / 60);
	if (mins < 60) {
		return `${mins}m`;
	}
	const hours = Math.floor(mins / 60);
	const remainingMins = mins % 60;
	if (remainingMins === 0) {
		return `${hours}h`;
	}
	return `${hours}h ${remainingMins}m`;
}

function formatResetTime(resetAt: number): string {
	const resetDate = new Date(resetAt * 1000);
	const now = new Date();
	const diffMs = resetDate.getTime() - now.getTime();

	if (diffMs <= 0) {
		return "now";
	}

	const diffMins = Math.ceil(diffMs / 60000);
	const diffHours = Math.floor(diffMins / 60);
	const remainingMins = diffMins % 60;

	if (diffHours === 0) {
		return `${remainingMins}m`;
	}
	if (remainingMins === 0) {
		return `${diffHours}h`;
	}
	return `${diffHours}h ${remainingMins}m`;
}

function formatPercent(percent: number): string {
	return `${Math.round(percent)}%`;
}

function createProgressBar(percentUsed: number, width = 20): string {
	const filled = Math.round((percentUsed / 100) * width);
	const empty = width - filled;
	return "█".repeat(filled) + "░".repeat(empty);
}

async function fetchCodexUsage(accessToken: string): Promise<ChatGPTUsageResponse | null> {
	const accountId = extractAccountId(accessToken);
	if (!accountId) {
		throw new Error("Failed to extract account ID from token");
	}

	const url = "https://chatgpt.com/backend-api/wham/usage";

	const response = await fetch(url, {
		method: "GET",
		headers: {
			"Authorization": `Bearer ${accessToken}`,
			"chatgpt-account-id": accountId,
			"originator": "pi",
			"User-Agent": "pi-coding-agent",
			"accept": "application/json",
		},
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Failed to fetch usage: ${response.status} ${response.statusText} - ${errorText}`);
	}

	return response.json() as Promise<ChatGPTUsageResponse>;
}

function extractAccountId(token: string): string | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = JSON.parse(atob(parts[1]));
		const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return accountId || null;
	} catch {
		return null;
	}
}

function renderUsage(response: ChatGPTUsageResponse): string {
	const lines: string[] = [];
	const rl = response.rate_limit;
	const credits = response.credits;

	lines.push("");
	lines.push("╭────────────────────────────────────────────────────────────────╮");
	lines.push("│                    Codex Usage Limits                          │");
	lines.push("╰────────────────────────────────────────────────────────────────╯");
	lines.push("");

	// Account info
	lines.push(`  Account: ${response.email} (${response.plan_type})`);
	lines.push("");

	// Primary window (5-hour rolling window)
	const primary = rl.primary_window;
	const primaryUsed = primary.used_percent;
	const primaryRemaining = Math.max(0, 100 - primaryUsed);
	const primaryWindowMins = Math.floor(primary.limit_window_seconds / 60);

	lines.push(`  5-Hour Rolling Window`);
	lines.push(`    Used:   ${formatPercent(primaryUsed)} ${createProgressBar(primaryUsed)}`);
	lines.push(`    Left:   ${formatPercent(primaryRemaining)} (resets in ${formatResetTime(primary.reset_at)})`);
	lines.push(`    Window: ${formatDuration(primary.limit_window_seconds)}`);
	lines.push("");

	// Secondary window (weekly)
	const secondary = rl.secondary_window;
	const secondaryUsed = secondary.used_percent;
	const secondaryRemaining = Math.max(0, 100 - secondaryUsed);
	const secondaryWindowMins = Math.floor(secondary.limit_window_seconds / 60);

	lines.push(`  Weekly Window`);
	lines.push(`    Used:   ${formatPercent(secondaryUsed)} ${createProgressBar(secondaryUsed)}`);
	lines.push(`    Left:   ${formatPercent(secondaryRemaining)} (resets in ${formatResetTime(secondary.reset_at)})`);
	lines.push(`    Window: ${formatDuration(secondary.limit_window_seconds)}`);
	lines.push("");

	// Credits
	if (credits.has_credits) {
		if (credits.unlimited) {
			lines.push(`  Credits: Unlimited`);
		} else if (credits.balance) {
			lines.push(`  Credits: ${credits.balance}`);
		}
		lines.push("");
	}

	// Spend control
	if (response.spend_control.individual_limit) {
		lines.push(`  Monthly Spend Limit: Configured`);
		lines.push("");
	}

	// Rate limit reached
	if (rl.limit_reached || response.rate_limit_reached_type) {
		lines.push(`  ⚠ Limit reached: ${response.rate_limit_reached_type || "usage limit"}`);
		lines.push("");
	}

	// Promo message
	if (response.promo) {
		lines.push(`  Promo: ${JSON.stringify(response.promo)}`);
		lines.push("");
	}

	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	// Register the /codex-usage command
	pi.registerCommand("codex-usage", {
		description: "Show OpenAI Codex usage limits and remaining quota",
		handler: async (_args, ctx: ExtensionContext) => {
			ctx.ui.notify("Fetching Codex usage...", "info");

			const accessToken = loadAuthToken();
			if (!accessToken) {
				ctx.ui.notify(
					"No OpenAI Codex OAuth token found. Run `/login` with Codex provider first.",
					"error"
				);
				return;
			}

			try {
				const response = await fetchCodexUsage(accessToken);
				const output = renderUsage(response);
				ctx.ui.setEditorText(output);
				ctx.ui.notify("Codex usage loaded in editor", "info");

			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to fetch Codex usage: ${message}`, "error");
			}
		},
	});

	// Also register a tool for programmatic access
	pi.registerTool({
		name: "codex_get_usage",
		label: "Get Codex Usage",
		description: "Fetch current OpenAI Codex usage limits from ChatGPT backend",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _onUpdate, _ctx, _signal) {
			const accessToken = loadAuthToken();
			if (!accessToken) {
				return {
					content: [{ type: "text", text: "Error: No OpenAI Codex OAuth token found. Please login first." }],
					details: { error: "no_token" },
				};
			}

			try {
				const response = await fetchCodexUsage(accessToken);
				const output = renderUsage(response);

				return {
					content: [{ type: "text", text: output }],
					details: { response },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Error fetching Codex usage: ${message}` }],
					details: { error: message },
				};
			}
		},
	});
}