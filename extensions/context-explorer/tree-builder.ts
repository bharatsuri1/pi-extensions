/**
 * Context Explorer — tree builder
 *
 * Walks the session branch entries and builds a hierarchical
 * ContextNode tree enriched with token estimates.
 *
 * System prompt is broken down into sub-parts using metadata
 * captured from before_agent_start.
 */

import type {
	AssistantMessage,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { estimateTokens, messagePreview } from "./utils";

/* ─── node types ─── */

export type ContextNodeKind =
	| "system-prompt"
	| "message"
	| "compaction"
	| "branch-summary"
	| "sp-sub"; // system-prompt sub-part

export type MessageRole = "user" | "assistant" | "toolResult" | "custom";

export interface ContextNode {
	id: string;
	kind: ContextNodeKind;
	label: string;
	tokens: number | null;
	isEstimated: boolean;
	percent: number | null;
	children: ContextNode[];
	expanded: boolean;
	depth: number;

	// Message-specific
	messageRole?: MessageRole;
	messageIndex?: number;
	toolName?: string;
	preview?: string;
	cacheTokens?: number;

	// Warnings
	warning?: string;
}

/* ─── system prompt metadata (from before_agent_start) ─── */

export interface SystemPromptParts {
	fullPrompt: string;
	customPrompt?: string;
	toolSnippets: string[];
	promptGuidelines: string[];
	appendSystemPrompt?: string;
	cwd: string;
	contextFiles: Array<{ path: string; content: string }>;
	skills: Array<{ name: string; content: string }>;
	activeTools: Array<{
		name: string;
		description: string;
		schemaJson: string;
	}>;
}

/* ─── extraction helpers ─── */

function getTextFromBlocks(
	content: string | Array<{ type: string; text?: string }>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

function getToolCallSummary(
	content: Array<{
		type: string;
		name?: string;
		arguments?: Record<string, unknown>;
	}>,
): { name: string; preview: string } | null {
	if (!Array.isArray(content)) return null;
	const toolCalls = content.filter((c) => c.type === "toolCall");
	if (toolCalls.length === 0) return null;

	const tc = toolCalls[0]!;
	const name = tc.name ?? "unknown";
	let argsPreview = "";
	if (tc.arguments) {
		const entries = Object.entries(tc.arguments).filter(
			([, v]) => v !== undefined && v !== null,
		);
		if (entries.length === 1) {
			const val = String(entries[0]![1]);
			argsPreview = val.length > 30 ? val.slice(0, 27) + "…" : val;
		} else if (entries.length > 1) {
			argsPreview = `${entries[0]![0]}=…`;
		}
	}
	return { name, preview: argsPreview };
}

/* ─── system prompt breakdown ─── */

function buildSystemPromptNodes(
	parts: SystemPromptParts | null,
	sysPromptStr: string,
	contextWindow: number,
): ContextNode[] {
	if (!parts) {
		return [];
	}

	const totalSysTokens = estimateTokens(sysPromptStr);
	const children: ContextNode[] = [];
	let accountedTokens = 0;

	// --- Tool definitions ---
	if (parts.activeTools.length > 0) {
		let toolTokens = 0;
		const toolChildren: ContextNode[] = [];

		for (const tool of parts.activeTools) {
			const text =
				tool.description +
				"\n" +
				tool.schemaJson +
				"\n";
			const t = estimateTokens(text);
			toolTokens += t;

			toolChildren.push({
				id: `sp-tool-${tool.name}`,
				kind: "sp-sub",
				label: tool.name,
				tokens: t,
				isEstimated: true,
				percent: contextWindow > 0 ? (t / contextWindow) * 100 : null,
				children: [],
				expanded: false,
				depth: 3,
				preview: tool.description.slice(0, 60),
			});
		}

		accountedTokens += toolTokens;
		children.push({
			id: "sp-tools",
			kind: "sp-sub",
			label: `Tool Definitions (${parts.activeTools.length})`,
			tokens: toolTokens,
			isEstimated: true,
			percent: contextWindow > 0 ? (toolTokens / contextWindow) * 100 : null,
			children: toolChildren,
			expanded: true,
			depth: 2,
		});
	}

	// --- Skills ---
	if (parts.skills.length > 0) {
		let skillTokens = 0;
		const skillChildren: ContextNode[] = [];

		for (const skill of parts.skills) {
			const t = estimateTokens(skill.content);
			skillTokens += t;

			skillChildren.push({
				id: `sp-skill-${skill.name}`,
				kind: "sp-sub",
				label: skill.name,
				tokens: t,
				isEstimated: true,
				percent: contextWindow > 0 ? (t / contextWindow) * 100 : null,
				children: [],
				expanded: false,
				depth: 3,
			});
		}

		accountedTokens += skillTokens;
		children.push({
			id: "sp-skills",
			kind: "sp-sub",
			label: `Skills (${parts.skills.length})`,
			tokens: skillTokens,
			isEstimated: true,
			percent:
				contextWindow > 0 ? (skillTokens / contextWindow) * 100 : null,
			children: skillChildren,
			expanded: false,
			depth: 2,
		});
	}

	// --- Context files (AGENTS.md etc.) ---
	if (parts.contextFiles.length > 0) {
		let fileTokens = 0;
		const fileChildren: ContextNode[] = [];

		for (const cf of parts.contextFiles) {
			const t = estimateTokens(cf.content);
			fileTokens += t;

			const shortPath =
				cf.path.length > 40
					? "…" + cf.path.slice(-37)
					: cf.path;
			fileChildren.push({
				id: `sp-file-${cf.path}`,
				kind: "sp-sub",
				label: shortPath,
				tokens: t,
				isEstimated: true,
				percent:
					contextWindow > 0 ? (t / contextWindow) * 100 : null,
				children: [],
				expanded: false,
				depth: 3,
			});
		}

		accountedTokens += fileTokens;
		children.push({
			id: "sp-files",
			kind: "sp-sub",
			label: `Context Files (${parts.contextFiles.length})`,
			tokens: fileTokens,
			isEstimated: true,
			percent:
				contextWindow > 0 ? (fileTokens / contextWindow) * 100 : null,
			children: fileChildren,
			expanded: false,
			depth: 2,
		});
	}

	// --- Custom system prompt ---
	if (parts.customPrompt && parts.customPrompt.trim().length > 0) {
		const ct = estimateTokens(parts.customPrompt);
		accountedTokens += ct;
		children.push({
			id: "sp-custom",
			kind: "sp-sub",
			label: "Custom System Prompt",
			tokens: ct,
			isEstimated: true,
			percent: contextWindow > 0 ? (ct / contextWindow) * 100 : null,
			children: [],
			expanded: false,
			depth: 2,
			preview: parts.customPrompt.slice(0, 60),
		});
	}

	// --- Append system prompt ---
	if (
		parts.appendSystemPrompt &&
		parts.appendSystemPrompt.trim().length > 0
	) {
		const at = estimateTokens(parts.appendSystemPrompt);
		accountedTokens += at;
		children.push({
			id: "sp-append",
			kind: "sp-sub",
			label: "Appended Prompt",
			tokens: at,
			isEstimated: true,
			percent: contextWindow > 0 ? (at / contextWindow) * 100 : null,
			children: [],
			expanded: false,
			depth: 2,
			preview: parts.appendSystemPrompt.slice(0, 60),
		});
	}

	// --- Guidelines ---
	if (parts.promptGuidelines.length > 0) {
		const glText = parts.promptGuidelines.join("\n");
		const gt = estimateTokens(glText);
		accountedTokens += gt;
		children.push({
			id: "sp-guidelines",
			kind: "sp-sub",
			label: `Guidelines (${parts.promptGuidelines.length})`,
			tokens: gt,
			isEstimated: true,
			percent: contextWindow > 0 ? (gt / contextWindow) * 100 : null,
			children: [],
			expanded: false,
			depth: 2,
		});
	}

	// --- Tool snippets ---
	if (parts.toolSnippets.length > 0) {
		const tsText = parts.toolSnippets.join("\n");
		const tst = estimateTokens(tsText);
		accountedTokens += tst;
		children.push({
			id: "sp-snippets",
			kind: "sp-sub",
			label: "Tool Snippets",
			tokens: tst,
			isEstimated: true,
			percent:
				contextWindow > 0 ? (tst / contextWindow) * 100 : null,
			children: [],
			expanded: false,
			depth: 2,
		});
	}

	// --- Core agent instructions (remainder) ---
	const coreTokens = Math.max(
		0,
		totalSysTokens - accountedTokens,
	);

	children.unshift({
		id: "sp-core",
		kind: "sp-sub",
		label: "Agent Instructions",
		tokens: coreTokens,
		isEstimated: true,
		percent:
			contextWindow > 0 ? (coreTokens / contextWindow) * 100 : null,
		children: [],
		expanded: false,
		depth: 2,
	});

	return children;
}

/* ─── tree construction ─── */

export function buildContextTree(
	ctx: ExtensionContext,
	contextWindow: number,
	contextTokens: number | null,
	promptParts: SystemPromptParts | null,
): ContextNode[] {
	const nodes: ContextNode[] = [];
	let messageIndex = 0;

	// 1. System prompt node (with breakdown)
	const systemPrompt = ctx.getSystemPrompt();
	const sysChildren = promptParts
		? buildSystemPromptNodes(promptParts, systemPrompt, contextWindow)
		: [];

	// Parent token = sum of children, or estimate from raw string if no breakdown
	const sysTokens = sysChildren.length > 0
		? sysChildren.reduce((sum, c) => sum + (c.tokens ?? 0), 0)
		: estimateTokens(systemPrompt);
	const sysPercent =
		contextWindow > 0 ? (sysTokens / contextWindow) * 100 : null;

	nodes.push({
		id: "system-prompt",
		kind: "system-prompt",
		label: "System Prompt",
		tokens: sysTokens,
		isEstimated: true,
		percent: sysPercent,
		children: sysChildren,
		expanded: false,
		depth: 0,
	});

	// 2. Walk the branch entries
	const branch = ctx.sessionManager.getBranch();

	const messageGroup: ContextNode = {
		id: "messages-group",
		kind: "message",
		label: "Messages",
		tokens: 0,
		isEstimated: false,
		percent: null,
		children: [],
		expanded: false,
		depth: 0,
	};
	let groupTokens = 0;

	for (const entry of branch) {
		if (entry.type !== "message") continue;

		const msg = (entry as { message: unknown }).message;
		if (!msg || typeof msg !== "object") continue;

		const role = (msg as { role?: string }).role;
		if (!role) continue;

		messageIndex++;

		if (role === "user") {
			const um = msg as UserMessage;
			const text = getTextFromBlocks(um.content);
			const tokens = estimateTokens(text);
			const preview = messagePreview(text, 48);
			groupTokens += tokens;

			messageGroup.children.push({
				id: entry.id,
				kind: "message",
				label: "user",
				tokens,
				isEstimated: true,
				percent: contextWindow > 0 ? (tokens / contextWindow) * 100 : null,
				children: [],
				expanded: false,
				depth: 1,
				messageRole: "user",
				messageIndex,
				preview,
			});
		} else if (role === "assistant") {
			const am = msg as AssistantMessage;
			// Use output tokens only — input includes system prompt + prior
			// messages already counted elsewhere in the tree.
			const tokens = am.usage?.output ?? null;
			const cacheRead = am.usage?.cacheRead ?? 0;
			const cacheWrite = am.usage?.cacheWrite ?? 0;
			const cacheTokens = cacheRead + cacheWrite;
			const isEstimated = tokens === null;

			const resolvedTokens =
				tokens ?? estimateTokens(getTextFromBlocks(am.content));
			groupTokens += resolvedTokens;

			const preview = messagePreview(am.content, 48);
			const toolSummary = getToolCallSummary(am.content);

			const label = toolSummary
				? `assistant → ${toolSummary.name}`
				: preview
					? `assistant "${preview}"`
					: "assistant";

			messageGroup.children.push({
				id: entry.id,
				kind: "message",
				label,
				tokens: resolvedTokens,
				isEstimated,
				percent:
					contextWindow > 0
						? (resolvedTokens / contextWindow) * 100
						: null,
				children: [],
				expanded: false,
				depth: 1,
				messageRole: "assistant",
				messageIndex,
				preview,
				cacheTokens: cacheTokens > 0 ? cacheTokens : undefined,
			});
		} else if (role === "toolResult") {
			const tr = msg as ToolResultMessage;
			const text = getTextFromBlocks(tr.content);
			const tokens = estimateTokens(text);
			const warning =
				tokens > 5000
					? "Large result — consider truncation"
					: undefined;
			groupTokens += tokens;

			messageGroup.children.push({
				id: entry.id,
				kind: "message",
				label: tr.toolName || "toolResult",
				tokens,
				isEstimated: true,
				percent:
					contextWindow > 0 ? (tokens / contextWindow) * 100 : null,
				children: [],
				expanded: false,
				depth: 1,
				messageRole: "toolResult",
				messageIndex,
				toolName: tr.toolName,
				preview: messagePreview(text, 40),
				warning,
			});
		}
	}

	messageGroup.tokens = groupTokens;
	messageGroup.percent =
		contextWindow > 0 ? (groupTokens / contextWindow) * 100 : null;
	messageGroup.label = `Messages (${messageGroup.children.length})`;

	if (messageGroup.children.length > 0) {
		nodes.push(messageGroup);
	}

	return nodes;
}

/* ─── flatten / toggle ─── */

export interface FlatNode {
	node: ContextNode;
	flatIndex: number;
	prefix: string;
}

export function flattenTree(nodes: ContextNode[]): FlatNode[] {
	const result: FlatNode[] = [];
	let idx = 0;

	function walk(children: ContextNode[], depth: number, parentPrefix: string) {
		for (let i = 0; i < children.length; i++) {
			const node = children[i]!;
			const isLast = i === children.length - 1;
			const connector = isLast ? "└─ " : "├─ ";
			const prefix = depth === 0 ? "" : parentPrefix + connector;

			result.push({ node, flatIndex: idx++, prefix });

			if (node.expanded && node.children.length > 0) {
				const childParentPrefix =
					depth === 0
						? ""
						: parentPrefix + (isLast ? "   " : "│  ");
				walk(node.children, depth + 1, childParentPrefix);
			}
		}
	}

	walk(nodes, 0, "");
	return result;
}

export function toggleNode(nodes: ContextNode[], nodeId: string): ContextNode[] {
	function walk(ns: ContextNode[]): boolean {
		for (const n of ns) {
			if (n.id === nodeId) {
				n.expanded = !n.expanded;
				return true;
			}
			if (walk(n.children)) return true;
		}
		return false;
	}
	walk(nodes);
	return nodes;
}
