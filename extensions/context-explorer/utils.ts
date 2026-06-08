/**
 * Context Explorer — utility helpers
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { ContextNode } from "./tree-builder";

/* ─── token estimation ─── */

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
	return Math.max(1, Math.round(text.length / CHARS_PER_TOKEN));
}

export function fmtTokens(n: number | null): string {
	if (n === null || n === undefined) return "?";
	if (n < 1000) return `${n}`;
	return `${(n / 1000).toFixed(1)}K`;
}

export function fmtPercent(n: number | null): string {
	if (n === null || n === undefined) return "?%";
	if (n < 0.1) return "<0.1%";
	return `${n.toFixed(1)}%`;
}

/* ─── string display ─── */

export function truncateTo(
	str: string,
	maxWidth: number,
): string {
	if (visibleWidth(str) <= maxWidth) return str;
	// Walk backwards to find a fit
	let result = "";
	let w = 0;
	for (const ch of str) {
		const cw = visibleWidth(ch);
		if (w + cw + 1 > maxWidth) {
			result += "…";
			break;
		}
		result += ch;
		w += cw;
	}
	return result || "…";
}

/** Extract a short preview from a message content value */
export function messagePreview(content: unknown, maxLen = 48): string {
	let text = "";
	if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		for (const block of content) {
			if (
				block &&
				typeof block === "object" &&
				"type" in block &&
				block.type === "text" &&
				"text" in block &&
				typeof block.text === "string"
			) {
				text += block.text;
				if (text.length > maxLen * 2) break; // enough
			}
		}
	}
	return truncateTo(text.replace(/\s+/g, " ").trim(), maxLen);
}

/** Shorten a path for display */
export function shortenPath(p: string, maxLen = 32): string {
	if (p.length <= maxLen) return p;
	const parts = p.split("/");
	if (parts.length <= 2) return truncateTo(p, maxLen);
	return truncateTo("…/" + parts.slice(-2).join("/"), maxLen);
}

/* ─── mini progress bar ─── */

/**
 * Render a compact progress bar using block chars.
 * Returns an array of styled segments suitable for concatenation.
 */
export interface MiniBarStyle {
	filled: (s: string) => string;
	empty: (s: string) => string;
}

export function miniBar(
	percent: number,
	width: number,
	style: MiniBarStyle,
): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * width);
	const empty = width - filled;
	if (filled === 0 && empty === 0) return "";
	return style.filled("█".repeat(filled)) + style.empty("░".repeat(empty));
}

/* ─── summary counters ─── */

export interface ContextSummary {
	totalMessages: number;
	userMessages: number;
	assistantMessages: number;
	toolResults: number;
	compactions: number;
	cacheTokens: number;
}

export function buildSummary(nodes: ContextNode[]): ContextSummary {
	let totalMessages = 0;
	let userMessages = 0;
	let assistantMessages = 0;
	let toolResults = 0;
	let compactions = 0;
	let cacheTokens = 0;

	function walk(ns: typeof nodes) {
		for (const n of ns) {
			if (n.kind === "message") {
				totalMessages++;
				if (n.messageRole === "user") userMessages++;
				else if (n.messageRole === "assistant") {
					assistantMessages++;
					if (n.cacheTokens) cacheTokens += n.cacheTokens;
				} else if (n.messageRole === "toolResult") toolResults++;
			} else if (n.kind === "compaction") {
				compactions++;
			}
			if (n.children) walk(n.children);
		}
	}

	walk(nodes);
	return { totalMessages, userMessages, assistantMessages, toolResults, compactions, cacheTokens };
}
