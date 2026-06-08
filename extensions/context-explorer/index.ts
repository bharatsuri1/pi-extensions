/**
 * Context Explorer — pi extension
 *
 * /context — Opens a TUI overlay showing a collapsible tree breakdown
 *            of the pi coding agent's context window.
 *
 * Design: Impeccable product-UI. Restrained color, keyboard-native,
 *         dense but scannable diagnostic tool for developers.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ContextExplorerOverlay } from "./components";
import { buildContextTree, type SystemPromptParts } from "./tree-builder";

/* ─── captured system prompt metadata ─── */

let lastPromptParts: SystemPromptParts | null = null;

/** Build prompt-parts from whatever is available right now */
function snapshotPromptParts(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	enrich?: Partial<SystemPromptParts>,
): SystemPromptParts {
	const allTools = pi.getAllTools();
	const activeNames = pi.getActiveTools();

	return {
		fullPrompt: ctx.getSystemPrompt(),
		customPrompt: enrich?.customPrompt,
		toolSnippets: enrich?.toolSnippets ?? [],
		promptGuidelines: enrich?.promptGuidelines ?? [],
		appendSystemPrompt: enrich?.appendSystemPrompt,
		cwd: ctx.cwd,
		contextFiles: enrich?.contextFiles ?? [],
		skills: enrich?.skills ?? [],
		activeTools: allTools
			.filter((t) => activeNames.includes(t.name))
			.map((t) => ({
				name: t.name,
				description: t.description ?? "",
				schemaJson: JSON.stringify(t.parameters ?? {}),
			})),
	};
}

export default function contextExplorer(pi: ExtensionAPI) {
	/* ─── capture on startup (tools only) ─── */

	pi.on("session_start", async (_event, ctx) => {
		lastPromptParts = snapshotPromptParts(pi, ctx);
	});

	/* ─── enrich on each agent turn (adds skills, context files, etc.) ─── */

	pi.on("before_agent_start", async (event, ctx) => {
		const opts = event.systemPromptOptions;
		if (!opts) return;

		lastPromptParts = snapshotPromptParts(pi, ctx, {
			customPrompt: opts.customPrompt ?? undefined,
			toolSnippets: opts.toolSnippets ?? [],
			promptGuidelines: opts.promptGuidelines ?? [],
			appendSystemPrompt: opts.appendSystemPrompt ?? undefined,
			contextFiles: (opts.contextFiles ?? []).map(
				(f: { path?: string; content?: string; name?: string }) => ({
					path: f.path ?? f.name ?? "unknown",
					content: f.content ?? "",
				}),
			),
			skills: (opts.skills ?? []).map(
				(s: { name?: string; content?: string; location?: string }) => ({
					name: s.name ?? "unknown",
					content: s.content ?? "",
				}),
			),
		});
	});

	/* ─── helpers ─── */

	function gatherContextData(ctx: ExtensionContext) {
		const usage = ctx.getContextUsage();
		const contextTokens = usage?.tokens ?? null;
		const contextPercent = usage?.percent ?? null;
		const contextWindow =
			usage?.contextWindow ??
			ctx.model?.contextWindow ??
			200_000;

		const nodes = buildContextTree(
			ctx,
			contextWindow,
			contextTokens,
			lastPromptParts,
		);

		return { nodes, contextWindow, contextTokens, contextPercent };
	}

	/* ─── text fallback for non-interactive modes ─── */

	function showTextSummary(ctx: ExtensionCommandContext) {
		const { nodes, contextWindow, contextTokens, contextPercent } =
			gatherContextData(ctx);

		const lines: string[] = [];
		lines.push("=== Context Window ===");
		lines.push(
			`Used: ${contextTokens ?? "?"} / ${contextWindow}  (${contextPercent?.toFixed(1) ?? "?"}%)`,
		);
		lines.push("");

		function walk(ns: typeof nodes, indent: number) {
			const pre = "  ".repeat(indent);
			for (const node of ns) {
				const preview = node.preview ? ` "${node.preview}"` : "";
				const flag = node.isEstimated ? "~" : " ";
				const pct = node.percent != null ? ` (${node.percent.toFixed(1)}%)` : "";
				const children = node.children.length > 0 ? ` [+${node.children.length}]` : "";
				lines.push(
					`${pre}${node.label.padEnd(30)} ${flag}${node.tokens ?? "?"} tok${pct}${children}${preview}`,
				);
				if (node.children.length > 0) {
					walk(node.children, indent + 1);
				}
			}
		}

		walk(nodes, 0);

		ctx.ui.notify(lines.join("\n"), "info");
	}

	/* ─── TUI overlay ─── */

	async function showOverlay(ctx: ExtensionCommandContext) {
		const { nodes, contextWindow, contextTokens, contextPercent } =
			gatherContextData(ctx);

		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			const overlay = new ContextExplorerOverlay(
				nodes,
				contextWindow,
				contextTokens,
				contextPercent,
			);
			overlay.setTheme(theme);
			overlay.onClose = () => done(undefined);

			return {
				render(width: number) {
					return overlay.render(width);
				},
				invalidate() {
					overlay.invalidate();
				},
				handleInput(data: string) {
					overlay.handleInput(data);
					tui.requestRender();
				},
			};
		}, { overlay: true });
	}

	/* ─── register command ─── */

	pi.registerCommand("context", {
		description: "Show context window breakdown as a tree overlay",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				showTextSummary(ctx);
				return;
			}

			await showOverlay(ctx);
		},
	});
}
