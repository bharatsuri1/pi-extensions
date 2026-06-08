/**
 * Statusline Extension
 *
 * A rich, fast footer statusline showing:
 *   - cwd (shortened)
 *   - git branch + changed file count (fast porcelain)
 *   - model / provider
 *   - thinking level
 *   - running cost & token usage
 *   - context window usage (%)
 *   - active tool count
 *   - pending message queue indicator
 *   - message count & turn count
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
import * as fs from "fs";

export default function statuslineExtension(pi: ExtensionAPI) {
	let enabled = true;
	let requestRender: (() => void) | null = null;

	/* ─── cached state ─── */
	let currentModel = { id: "no-model", provider: "no-provider" };
	let thinkingLevel = "off";
	let turnCount = 0;
	let totalCost = 0;
	let totalInput = 0;
	let totalOutput = 0;
	let activeToolCount = 0;
	let gitChanged = 0;
	let gitBranch: string | null = null;
	let contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } = {
		tokens: 0,
		contextWindow: 0,
		percent: 0,
	};
	let cwd = "";
	let pendingMessages = false;
	let messageCount = 0;
	let lastIndexMtime = 0;
	let lastGitChanged = 0;
	let footerGeneration = 0;
	let renderTimer: ReturnType<typeof setTimeout> | null = null;

	function queueRender() {
		const gen = footerGeneration;
		if (renderTimer) clearTimeout(renderTimer);
		renderTimer = setTimeout(() => {
			renderTimer = null;
			if (footerGeneration !== gen) return;
			if (requestRender) requestRender();
		}, 50);
	}

	/* ─── nerd font icons (current defaults; swap glyphs to match your Nerd Font) ─── */
	const ICON_MODEL = "󰚩 ";
	const ICON_THINKING = "󰧑 ";
	const ICON_COST = " ";
	const ICON_TOKENS_UP = "󰅶 ";
	const ICON_TOKENS_DOWN = "󰅵 ";
	const ICON_CONTEXT = "󰆌 ";
	const ICON_TOOLS = " ";
	const ICON_QUEUE = "󰔝 ";
	const ICON_MESSAGES = "󰍡 ";
	const ICON_TURN = " ";
	const ICON_GIT_BRANCH = "󰘬 ";
	const ICON_GIT_DIRTY = " ";
	const ICON_DIR = "󰉋 ";

	/* ─── helpers ─── */
	const fmtK = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

	function shortenCwd(cwdPath: string, maxLen?: number): string {
		const home = os.homedir();
		if (cwdPath.startsWith(home)) {
			cwdPath = "~" + cwdPath.slice(home.length);
		}
		const limit = maxLen ?? 30;
		if (cwdPath.length > limit) {
			const parts = cwdPath.split(path.sep);
			if (parts.length > 2) {
				cwdPath = "…" + path.sep + parts.slice(-2).join(path.sep);
			}
		}
		return cwdPath;
	}

	async function updateGitInfo() {
		try {
			const indexPath = path.join(cwd, ".git", "index");
			const stat = await fs.promises.stat(indexPath);
			if (stat.mtimeMs === lastIndexMtime && lastGitChanged === 0) {
				return; // index unchanged since last clean check, skip git spawn
			}
			lastIndexMtime = stat.mtimeMs;
			const { stdout } = await pi.exec("git", ["status", "--porcelain", "-uno"]);
			lastGitChanged = stdout.split("\n").filter((l) => l.trim().length > 0).length;
			gitChanged = lastGitChanged;
		} catch {
			gitChanged = 0;
			lastGitChanged = 0;
			lastIndexMtime = 0;
		}
	}

	function recomputeCosts(ctx: ExtensionContext) {
		let input = 0,
			output = 0,
			cost = 0;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") {
				const m = e.message as AssistantMessage;
				input += m.usage.input;
				output += m.usage.output;
				cost += m.usage.cost.total;
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
		const usage = ctx.getContextUsage();
		contextUsage = usage ?? { tokens: 0, contextWindow: 0, percent: 0 };
		activeToolCount = pi.getActiveTools().length;
		recomputeCosts(ctx);
		const branch = ctx.sessionManager.getBranch();
		messageCount = branch.filter((e) => e.type === "message").length;
		turnCount = branch.filter((e) => e.type === "message" && e.message.role === "user").length;
		cwd = ctx.cwd;
		pendingMessages = ctx.hasPendingMessages();
	}

	/* ─── rose pine colors ─── */
	const rp = {
		base:   (s: string) => `\x1b[38;2;231;224;216m${s}\x1b[0m`,   /* text        */
		surface:(s: string) => `\x1b[38;2;144;140;170m${s}\x1b[0m`,   /* subtle      */
		overlay:(s: string) => `\x1b[38;2;112;106;134m${s}\x1b[0m`,   /* muted       */
		love:   (s: string) => `\x1b[38;2;235;111;146m${s}\x1b[0m`,   /* love        */
		gold:   (s: string) => `\x1b[38;2;246;193;119m${s}\x1b[0m`,   /* gold        */
		rose:   (s: string) => `\x1b[38;2;235;188;186m${s}\x1b[0m`,   /* rose        */
		pine:   (s: string) => `\x1b[38;2;49;116;143m${s}\x1b[0m`,   /* pine        */
		foam:   (s: string) => `\x1b[38;2;156;207;216m${s}\x1b[0m`,   /* foam        */
		iris:   (s: string) => `\x1b[38;2;196;167;231m${s}\x1b[0m`,   /* iris        */
	};

	/* ─── render ─── */
	function renderFooter(width: number, _theme: any): string[] {
		if (!enabled) {
			return ["", ""];
		}

		/* ── Line 1: workspace + config ── */
		const right1Parts: string[] = [];
		right1Parts.push(rp.foam(ICON_MODEL) + rp.surface(`${currentModel.provider}/${currentModel.id}`));
		right1Parts.push(rp.pine(ICON_THINKING) + rp.surface(thinkingLevel));
		const right1 = right1Parts.join(" | ");
		const right1Width = visibleWidth(right1);

		let gitIndicator = "";
		if (gitBranch) {
			gitIndicator = rp.overlay(`${ICON_GIT_BRANCH}${gitBranch}`);
			if (gitChanged > 0) {
				gitIndicator += " " + rp.love(`${ICON_GIT_DIRTY}${gitChanged}`);
			}
		}
		const gitWidth = visibleWidth(gitIndicator);
		const sepWidth = gitIndicator ? visibleWidth(" | ") : 0;
		const iconWidth = visibleWidth(ICON_DIR);
		const cwdMaxLen = Math.max(10, width - right1Width - iconWidth - gitWidth - sepWidth - 2);

		const left1Parts: string[] = [];
		left1Parts.push(rp.iris(ICON_DIR) + rp.surface(shortenCwd(cwd, cwdMaxLen)));
		if (gitIndicator) {
			left1Parts.push(gitIndicator);
		}
		const left1 = left1Parts.join(" | ");

		const pad1Len = Math.max(0, width - visibleWidth(left1) - visibleWidth(right1));
		const line1 = left1 + " ".repeat(pad1Len) + right1;

		/* ── Line 2: session metrics ── */
		const left2Parts: string[] = [];
		left2Parts.push(rp.gold(ICON_COST) + rp.surface(totalCost.toFixed(3)));

		const ctxPercent = contextUsage.percent;
		if (ctxPercent != null && ctxPercent > 90) {
			left2Parts.push(rp.love(ICON_CONTEXT) + rp.love(`${Math.round(ctxPercent)}%`));
		} else if (ctxPercent != null && ctxPercent > 70) {
			left2Parts.push(rp.gold(ICON_CONTEXT) + rp.gold(`${Math.round(ctxPercent)}%`));
		} else {
			// ctxTokens is only used as a fallback when percentage is unavailable
			const ctxTokens = contextUsage.tokens ?? 0;
			left2Parts.push(
				ctxPercent != null
					? rp.iris(ICON_CONTEXT) + rp.surface(`${Math.round(ctxPercent)}%`)
					: rp.iris(ICON_CONTEXT) + rp.surface(fmtK(ctxTokens))
			);
		}

		left2Parts.push(rp.rose(ICON_TOOLS) + rp.surface(`${activeToolCount}`));
		const left2 = left2Parts.join(" | ");

		const right2Parts: string[] = [];
		right2Parts.push(
			rp.love(ICON_TOKENS_UP) + rp.surface(fmtK(totalInput)) +
			" " +
			rp.foam(ICON_TOKENS_DOWN) + rp.surface(fmtK(totalOutput))
		);
		if (pendingMessages) {
			right2Parts.push(rp.love(ICON_QUEUE) + rp.love("queue"));
		}
		right2Parts.push(rp.base(ICON_MESSAGES) + rp.surface(`${messageCount}`));
		right2Parts.push(rp.overlay(ICON_TURN) + rp.overlay(`${turnCount}`));
		const right2 = right2Parts.join(" | ");

		const pad2Len = Math.max(0, width - visibleWidth(left2) - visibleWidth(right2));
		const line2 = left2 + " ".repeat(pad2Len) + right2;

		return [
			truncateToWidth(line1, width),
			truncateToWidth(line2, width),
		];
	}

	/* ─── footer lifecycle ─── */
	let footerCtx: ExtensionContext | null = null;

	function setupFooter(ctx: ExtensionContext) {
		footerGeneration++;
		footerCtx = ctx;
		ctx.ui.setFooter((tui, theme, footerData) => {
			gitBranch = footerData.getGitBranch();
			requestRender = () => tui.requestRender();

			// Fast render poll: cwd, pending, branch — no git spawn
			const renderInterval = setInterval(() => {
				if (footerCtx) {
					cwd = footerCtx.cwd;
					pendingMessages = footerCtx.hasPendingMessages();
					gitBranch = footerData.getGitBranch();
					if (!gitBranch) gitChanged = 0;
				}
				if (requestRender) requestRender();
			}, 2000);

			// Slow git poll: only spawns git when index mtime changed
			const gitPollInterval = setInterval(async () => {
				await updateGitInfo();
				if (requestRender) requestRender();
			}, 15000);

			const unsubBranch = footerData.onBranchChange(() => {
				gitBranch = footerData.getGitBranch();
				if (requestRender) requestRender();
			});

			return {
				invalidate() {},
				render(width: number) {
					return renderFooter(width, theme);
				},
				dispose() {
					clearInterval(renderInterval);
					clearInterval(gitPollInterval);
					unsubBranch();
					requestRender = null;
					footerCtx = null;
				},
			};
		});
	}

	/* ─── commands ─── */
	pi.registerCommand("statusline", {
		description: "Toggle statusline footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			ctx.ui.notify(enabled ? "Statusline enabled" : "Statusline disabled", "info");
			if (enabled) {
				setupFooter(ctx);
			} else {
				ctx.ui.setFooter(undefined);
				requestRender = null;
			}
		},
	});

	/* ─── events ─── */
	pi.on("session_start", async (_event, ctx) => {
		refreshState(ctx);
		await updateGitInfo();
		setupFooter(ctx);
	});

	pi.on("model_select", async (event, _ctx) => {
		currentModel = { id: event.model.id, provider: event.model.provider };
		if (requestRender) requestRender();
	});

	pi.on("thinking_level_select", async (event, _ctx) => {
		thinkingLevel = event.level;
		if (requestRender) requestRender();
	});

	pi.on("turn_end", async (_event, ctx) => {
		refreshState(ctx);
		await updateGitInfo();
		if (requestRender) requestRender();
	});

	pi.on("session_tree", async (_event, ctx) => {
		refreshState(ctx);
		await updateGitInfo();
		queueRender();
	});
}
