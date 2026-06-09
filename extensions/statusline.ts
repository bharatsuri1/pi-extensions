/**
 * Statusline Extension
 *
 * A polished Rosé Pine footer statusline showing:
 *   - cwd (shortened)
 *   - git branch
 *   - model / provider
 *   - thinking level
 *   - running cost & token usage
 *   - context window usage
 *   - tools included in the prompt
 *   - message count
 *   - agent active/inactive state
 *   - pending message queue indicator
 *
 * Usage:
 *   pi --extension pi-extensions/statusline.ts
 *   /statusline          # toggle on/off
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as path from "path";
import * as os from "os";

export default function statuslineExtension(pi: ExtensionAPI) {
	let enabled = true;
	let requestRender: (() => void) | null = null;
	let footerCtx: ExtensionContext | null = null;

	/* ─── cached state ─── */
	let currentModel = { id: "no-model", provider: "no-provider" };
	let thinkingLevel = "off";
	let totalCost = 0;
	let totalInput = 0;
	let totalOutput = 0;
	let promptToolCount = 0;
	let agentActive = false;
	let gitBranch: string | null = null;
	let contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } = {
		tokens: 0,
		contextWindow: 0,
		percent: 0,
	};
	let cwd = "";
	let pendingMessages = false;
	let messageCount = 0;
	let footerGeneration = 0;
	let renderTimer: ReturnType<typeof setTimeout> | null = null;

	/* ─── nerd font icons ─── */
	const ICON_MODEL = "";
	const ICON_THINKING = "";
	const ICON_COST = "";
	const ICON_TOKENS_UP = "";
	const ICON_TOKENS_DOWN = "";
	const ICON_CONTEXT = "";
	const ICON_TOOLS = "";
	const ICON_QUEUE = "";
	const ICON_MESSAGES = "";
	const ICON_STATUS = "●";
	const ICON_GIT_BRANCH = "";
	const ICON_DIR = "";

	/* ─── Rosé Pine foreground palette ─── */
	const ansi = (rgb: [number, number, number]) => (s: string) => `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}\x1b[0m`;
	const rp = {
		text: ansi([224, 222, 244]),
		subtle: ansi([144, 140, 170]),
		muted: ansi([110, 106, 134]),
		love: ansi([235, 111, 146]),
		gold: ansi([246, 193, 119]),
		rose: ansi([235, 188, 186]),
		pine: ansi([49, 116, 143]),
		foam: ansi([156, 207, 216]),
		mint: ansi([137, 221, 181]),
		iris: ansi([196, 167, 231]),
	};

	/* ─── helpers ─── */
	const fmtK = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
	const sep = () => rp.muted(" │ ");
	const hair = () => rp.muted(" · ");

	function queueRender() {
		const gen = footerGeneration;
		if (renderTimer) clearTimeout(renderTimer);
		renderTimer = setTimeout(() => {
			renderTimer = null;
			if (footerGeneration !== gen) return;
			requestRender?.();
		}, 50);
	}

	function clearQueuedRender() {
		if (renderTimer) clearTimeout(renderTimer);
		renderTimer = null;
	}

	function iconText(icon: string, text: string, iconColor: (s: string) => string, textColor = rp.subtle) {
		return iconColor(icon) + " " + textColor(text);
	}

	function shortenCwd(cwdPath: string, maxLen = 30): string {
		if (!cwdPath) return "~";

		const home = os.homedir();
		const inHome = cwdPath === home || cwdPath.startsWith(home + path.sep);
		if (cwdPath === home) return "~";

		const prefix = inHome ? "~" : "";
		const relativePath = inHome ? cwdPath.slice(home.length + 1) : cwdPath.replace(/^\/+/, "");
		const parts = relativePath.split(path.sep).filter(Boolean);

		let display: string;
		if (parts.length === 0) {
			display = prefix || cwdPath;
		} else if (parts.length <= 2) {
			display = prefix ? `${prefix}/${parts.join("/")}` : parts.join("/");
		} else {
			display = prefix ? `${prefix}/.../${parts.slice(-2).join("/")}` : `.../${parts.slice(-2).join("/")}`;
		}

		if (visibleWidth(display) <= maxLen) return display;
		const leaf = parts.at(-1) ?? display;
		const compact = prefix ? `${prefix}/.../${leaf}` : `.../${leaf}`;
		return truncateToWidth(compact, maxLen);
	}

	function shortenModel(id: string, maxLen = 26): string {
		return truncateToWidth(id.replace(/^models\//, ""), maxLen);
	}

	function modelDisplay(maxLen = 34): string {
		const id = currentModel.id.replace(/^models\//, "");
		const value = id.startsWith(`${currentModel.provider}/`) ? id : `${currentModel.provider}/${id}`;
		return truncateToWidth(value, maxLen);
	}

	function formatMoney(cost: number): string {
		if (cost <= 0) return "$0";
		if (cost < 0.01) return `$${cost.toFixed(4)}`;
		if (cost < 1) return `$${cost.toFixed(3)}`;
		return `$${cost.toFixed(2)}`;
	}

	function contextTone(): (s: string) => string {
		const pct = contextUsage.percent;
		if (pct == null) return rp.iris;
		if (pct >= 95) return rp.love;
		if (pct >= 70) return rp.rose;
		if (pct >= 50) return rp.gold;
		if (pct >= 25) return rp.foam;
		return rp.iris;
	}

	function contextText(): string {
		const pct = contextUsage.percent;
		if (pct != null) return `${Math.round(pct)}%`;
		return fmtK(contextUsage.tokens ?? 0);
	}

	function contextLabel(): string {
		const pct = contextUsage.percent;
		if (pct == null) return "ctx";
		if (pct >= 90) return "critical";
		if (pct >= 70) return "tight";
		if (pct >= 45) return "busy";
		return "calm";
	}

	function toolText(): string {
		return `${promptToolCount}`;
	}

	function agentStatusText(): string {
		return agentActive ? "active" : "inactive";
	}

	function renderAgentStatus(label = agentStatusText()): string {
		const color = agentActive ? rp.mint : rp.muted;
		return `${color(ICON_STATUS)} ${color(label)}`;
	}

	function renderQueue(): string {
		return pendingMessages ? `${rp.gold(ICON_QUEUE)} ${rp.gold("queued")}` : "";
	}

	function renderGit(): string {
		if (!gitBranch) return "";
		return iconText(ICON_GIT_BRANCH, truncateToWidth(gitBranch, 28), rp.pine, rp.pine);
	}

	function alignLine(left: string, right: string, width: number): string {
		const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		return truncateToWidth(left + " ".repeat(gap) + right, width);
	}

	function joinSegments(segments: string[]): string {
		return segments.filter(Boolean).join(sep());
	}

	function padRight(value: string, width: number): string {
		return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
	}

	function padLeft(value: string, width: number): string {
		return " ".repeat(Math.max(0, width - visibleWidth(value))) + value;
	}

	function tableRows(columns: Array<{ top: string; bottom: string }>, align: "left" | "right" = "left"): [string, string] {
		const visibleColumns = columns.filter((column) => column.top || column.bottom);
		const widths = visibleColumns.map((column) => Math.max(visibleWidth(column.top), visibleWidth(column.bottom)));
		const pad = align === "right" ? padLeft : padRight;
		const top = visibleColumns.map((column, index) => pad(column.top, widths[index])).join(sep());
		const bottom = visibleColumns.map((column, index) => pad(column.bottom, widths[index])).join(sep());
		return [top, bottom];
	}

	function alignTables(left: [string, string], right: [string, string], width: number): string[] {
		return [
			alignLine(left[0], right[0], width),
			alignLine(left[1], right[1], width),
		];
	}

	function invalidateFooterState() {
		footerGeneration++;
		clearQueuedRender();
		requestRender = null;
		footerCtx = null;
	}

	function recomputeCosts(ctx: ExtensionContext) {
		let input = 0;
		let output = 0;
		let cost = 0;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") {
				const m = e.message as AssistantMessage;
				input += m.usage?.input ?? 0;
				output += m.usage?.output ?? 0;
				cost += m.usage?.cost?.total ?? 0;
			}
		}
		totalInput = input;
		totalOutput = output;
		totalCost = cost;
	}

	function refreshState(ctx: ExtensionContext) {
		const m = ctx.model;
		if (m) {
			currentModel = { id: m.id || "unknown", provider: m.provider || "unknown" };
		}
		thinkingLevel = pi.getThinkingLevel();
		contextUsage = ctx.getContextUsage() ?? { tokens: 0, contextWindow: 0, percent: 0 };
		promptToolCount = pi.getActiveTools().length;
		agentActive = !ctx.isIdle();
		recomputeCosts(ctx);
		const branch = ctx.sessionManager.getBranch();
		messageCount = branch.filter((e) => e.type === "message").length;
		cwd = ctx.cwd;
		pendingMessages = ctx.hasPendingMessages();
	}

	/* ─── render tiers ─── */
	function renderWide(width: number): string[] {
		const ctxTone = contextTone();
		const tokens = rp.love(ICON_TOKENS_UP) + " " + rp.love(fmtK(totalInput)) + hair() + rp.foam(ICON_TOKENS_DOWN) + " " + rp.foam(fmtK(totalOutput));

		let dirBudget = Math.min(34, Math.max(18, Math.floor(width * 0.3)));
		let modelBudget = Math.min(44, Math.max(24, Math.floor(width * 0.34)));

		for (let attempt = 0; attempt < 28; attempt++) {
			const left = tableRows([
				{ top: iconText(ICON_DIR, shortenCwd(cwd, dirBudget), rp.iris), bottom: renderQueue() },
				{ top: iconText(ICON_COST, formatMoney(totalCost), rp.gold, rp.gold), bottom: iconText(ICON_CONTEXT, contextText(), ctxTone, ctxTone) },
				{ top: iconText(ICON_TOOLS, toolText(), rp.rose, rp.rose), bottom: iconText(ICON_MESSAGES, `${messageCount}`, rp.text) },
				{ top: renderAgentStatus(), bottom: renderGit() },
			]);
			const right = tableRows([
				{ top: joinSegments([iconText(ICON_MODEL, modelDisplay(modelBudget), rp.foam, rp.subtle), iconText(ICON_THINKING, thinkingLevel, rp.pine, rp.pine)]), bottom: tokens },
			], "right");
			const rowWidth = Math.max(
				visibleWidth(left[0]) + 1 + visibleWidth(right[0]),
				visibleWidth(left[1]) + 1 + visibleWidth(right[1])
			);
			if (rowWidth <= width) return alignTables(left, right, width);
			if (modelBudget > 24 && modelBudget >= dirBudget) modelBudget -= 2;
			else if (dirBudget > 18) dirBudget -= 2;
			else if (modelBudget > 18) modelBudget -= 2;
			else break;
		}

		return renderMedium(width);
	}

	function renderMedium(width: number): string[] {
		const ctxTone = contextTone();
		let dirBudget = Math.min(28, Math.max(16, Math.floor(width * 0.34)));
		let modelBudget = Math.min(26, Math.max(18, Math.floor(width * 0.28)));

		for (let attempt = 0; attempt < 20; attempt++) {
			const left = tableRows([
				{ top: iconText(ICON_DIR, shortenCwd(cwd, dirBudget), rp.iris), bottom: renderQueue() },
				{ top: iconText(ICON_COST, formatMoney(totalCost), rp.gold, rp.gold), bottom: iconText(ICON_CONTEXT, contextText(), ctxTone, ctxTone) },
				{ top: iconText(ICON_TOOLS, toolText(), rp.rose, rp.rose), bottom: iconText(ICON_MESSAGES, `${messageCount}`, rp.text) },
				{ top: renderAgentStatus(), bottom: renderGit() },
			]);
			const right = tableRows([
				{ top: iconText(ICON_MODEL, modelDisplay(modelBudget), rp.foam), bottom: iconText(ICON_THINKING, thinkingLevel, rp.pine, rp.pine) },
			], "right");
			const rowWidth = Math.max(
				visibleWidth(left[0]) + 1 + visibleWidth(right[0]),
				visibleWidth(left[1]) + 1 + visibleWidth(right[1])
			);
			if (rowWidth <= width) return alignTables(left, right, width);
			if (dirBudget > 16 && dirBudget >= modelBudget) dirBudget -= 2;
			else if (modelBudget > 16) modelBudget -= 2;
			else break;
		}

		const left = tableRows([
			{ top: iconText(ICON_DIR, shortenCwd(cwd, 16), rp.iris), bottom: renderQueue() },
			{ top: iconText(ICON_COST, formatMoney(totalCost), rp.gold, rp.gold), bottom: iconText(ICON_CONTEXT, contextText(), ctxTone, ctxTone) },
			{ top: iconText(ICON_TOOLS, toolText(), rp.rose, rp.rose), bottom: iconText(ICON_MESSAGES, `${messageCount}`, rp.text) },
			{ top: renderAgentStatus(), bottom: renderGit() },
		]);
		const right = tableRows([
			{ top: iconText(ICON_MODEL, modelDisplay(16), rp.foam), bottom: iconText(ICON_THINKING, thinkingLevel, rp.pine, rp.pine) },
		], "right");
		return alignTables(left, right, width);
	}

	function renderNarrow(width: number): string[] {
		const spacer = rp.muted("  ");
		const git = gitBranch ? rp.pine(ICON_GIT_BRANCH) + " " + rp.pine(truncateToWidth(gitBranch, 12)) : "";
		const ctxTone = contextTone();
		const cwdSegment = rp.iris(ICON_DIR) + " " + rp.subtle(shortenCwd(cwd, Math.max(10, Math.floor(width * 0.34))));
		const ctxSegment = ctxTone(ICON_CONTEXT) + " " + ctxTone(contextText());
		const candidates = [
			git,
			renderAgentStatus(),
			rp.gold(ICON_COST) + " " + rp.gold(formatMoney(totalCost)),
			rp.foam(ICON_MODEL) + " " + rp.subtle(modelDisplay(16)),
			width >= 58 ? rp.pine(ICON_THINKING) + " " + rp.pine(thinkingLevel) : "",
			width >= 60 ? rp.rose(ICON_TOOLS) + " " + rp.rose(toolText()) : "",
			width >= 66 ? rp.text(ICON_MESSAGES) + " " + rp.subtle(`${messageCount}`) : "",
			width >= 68 ? renderQueue() : "",
		].filter(Boolean);

		const parts = [cwdSegment];
		for (const candidate of candidates) {
			const attempt = [...parts, candidate, ctxSegment].join(spacer);
			if (visibleWidth(attempt) <= width) parts.push(candidate);
		}
		parts.push(ctxSegment);
		return [truncateToWidth(parts.join(spacer), width)];
	}

	function renderFooter(width: number): string[] {
		if (width <= 0) return [""];
		if (width < 72) return renderNarrow(width);
		if (width < 110) return renderMedium(width);
		return renderWide(width);
	}

	/* ─── footer lifecycle ─── */
	function setupFooter(ctx: ExtensionContext) {
		const setupGen = ++footerGeneration;
		footerCtx = ctx;
		ctx.ui.setFooter((tui, _theme, footerData) => {
			gitBranch = footerData.getGitBranch();
			requestRender = () => tui.requestRender();

			// Fast render poll: cwd, pending, agent state, tools, and cached branch. No git spawn.
			const renderInterval = setInterval(() => {
				if (footerGeneration !== setupGen) return;
				if (footerCtx) {
					cwd = footerCtx.cwd;
					pendingMessages = footerCtx.hasPendingMessages();
					agentActive = !footerCtx.isIdle();
					promptToolCount = pi.getActiveTools().length;
					gitBranch = footerData.getGitBranch();
				}
				requestRender?.();
			}, 2000);

			const unsubBranch = footerData.onBranchChange(() => {
				if (footerGeneration !== setupGen) return;
				gitBranch = footerData.getGitBranch();
				requestRender?.();
			});

			return {
				invalidate() {},
				render(width: number) {
					return renderFooter(width);
				},
				dispose() {
					clearInterval(renderInterval);
					unsubBranch();
					if (footerGeneration === setupGen) {
						invalidateFooterState();
					}
				},
			};
		});
	}

	function disableFooter(ctx: ExtensionContext) {
		ctx.ui.setFooter(undefined);
		invalidateFooterState();
	}

	/* ─── commands ─── */
	pi.registerCommand("statusline", {
		description: "Toggle statusline footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			ctx.ui.notify(enabled ? "Statusline enabled" : "Statusline disabled", "info");
			if (enabled) {
				refreshState(ctx);
				setupFooter(ctx);
			} else {
				disableFooter(ctx);
			}
		},
	});

	/* ─── events ─── */
	pi.on("session_start", async (_event, ctx) => {
		refreshState(ctx);
		if (enabled) setupFooter(ctx);
	});

	pi.on("model_select", async (event, _ctx) => {
		currentModel = { id: event.model.id, provider: event.model.provider };
		requestRender?.();
	});

	pi.on("thinking_level_select", async (event, _ctx) => {
		thinkingLevel = event.level;
		requestRender?.();
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		refreshState(ctx);
		agentActive = true;
		requestRender?.();
	});

	pi.on("agent_start", async (_event, ctx) => {
		refreshState(ctx);
		agentActive = true;
		requestRender?.();
	});

	pi.on("agent_end", async (_event, ctx) => {
		refreshState(ctx);
		agentActive = false;
		requestRender?.();
	});

	pi.on("turn_start", async (_event, ctx) => {
		refreshState(ctx);
		agentActive = true;
		requestRender?.();
	});

	pi.on("turn_end", async (_event, ctx) => {
		refreshState(ctx);
		requestRender?.();
	});

	pi.on("session_tree", async (_event, ctx) => {
		refreshState(ctx);
		queueRender();
	});
}
