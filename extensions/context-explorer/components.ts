/**
 * Context Explorer — TUI components
 *
 * Renders the overlay panel with context gauge, scrollable tree,
 * and keyboard navigation. Follows impeccable product-UI design:
 * restrained color, keyboard-native, dense but scannable.
 */

import { matchesKey, Key, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ContextNode, FlatNode } from "./tree-builder";
import { flattenTree, toggleNode } from "./tree-builder";
import { buildSummary, fmtPercent, fmtTokens, miniBar, type ContextSummary } from "./utils";

/* ─── constants ─── */

const BAR_WIDTH = 8;
const MIN_PANEL_WIDTH = 54;
const TREE_PAGE_SIZE = 20;

/* ─── theme stub ─── */

interface ThemeLike {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

/* ─── role display ─── */

const ROLE_STYLES: Record<string, { label: string; color: string }> = {
	user: { label: "user", color: "text" },
	assistant: { label: "assistant", color: "accent" },
	toolResult: { label: "tool", color: "muted" },
	custom: { label: "custom", color: "dim" },
};

function roleLabel(role: string | undefined): { label: string; color: string } {
	const s = ROLE_STYLES[role ?? ""];
	if (s) return s;
	return { label: role ?? "?", color: "dim" };
}

function gaugeColor(percent: number | null): string {
	if (percent === null) return "accent";
	if (percent > 95) return "error";
	if (percent > 80) return "warning";
	return "accent";
}

/* ─── overlay component ─── */

export class ContextExplorerOverlay {
	private nodes: ContextNode[];
	private contextWindow: number;
	private contextTokens: number | null;
	private contextPercent: number | null;
	private summary: ContextSummary;

	private selectedIdx = 0;
	private scrollOffset = 0;
	private flatNodes: FlatNode[] = [];
	private cachedWidth = 0;
	private cachedLines: string[] = [];
	private dirty = true;
	private theme?: ThemeLike;

	public onClose?: () => void;

	constructor(
		nodes: ContextNode[],
		contextWindow: number,
		contextTokens: number | null,
		contextPercent: number | null,
	) {
		this.nodes = nodes;
		this.contextWindow = contextWindow;
		this.contextTokens = contextTokens;
		this.contextPercent = contextPercent;
		this.summary = buildSummary(nodes);
		this.rebuildFlat();
	}

	setTheme(t: ThemeLike) {
		this.theme = t;
		this.dirty = true;
	}

	/* ─── colour shortcuts ─── */

	private C(color: string, text: string): string {
		return this.theme ? this.theme.fg(color, text) : text;
	}

	private bgC(color: string, text: string): string {
		return this.theme ? this.theme.bg(color, text) : text;
	}

	private B(text: string): string {
		return this.theme ? this.theme.bold(text) : text;
	}

	private dim(text: string): string {
		return this.C("dim", text);
	}
	private muted(text: string): string {
		return this.C("muted", text);
	}
	private accent(text: string): string {
		return this.C("accent", text);
	}
	private warn(text: string): string {
		return this.C("warning", text);
	}
	private err(text: string): string {
		return this.C("error", text);
	}
	private border(text: string): string {
		return this.C("border", text);
	}

	// Border colour used for all frame edges (horizontal + vertical)
	private BORDER_COLOR = "border";

	/** Wrap inner content between coloured "│ " … " │" borders */
	private row(content: string, w: number): string {
		const innerW = w - 4; // "│ " + " │"
		const padded =
			content +
			" ".repeat(Math.max(0, innerW - visibleWidth(content)));
		return truncateToWidth(
			this.C(this.BORDER_COLOR, "│ ") +
				padded +
				this.C(this.BORDER_COLOR, " │"),
			w,
		);
	}

	/** Border-only row: coloured horizontal bar between coloured corners */
	private hBorder(w: number): string {
		return this.C(this.BORDER_COLOR, "├" + "─".repeat(w - 2) + "┤");
	}

	private topBorder(w: number, title: string): string {
		const totalPad = w - 2 - visibleWidth(title);
		const left = Math.floor(totalPad / 2);
		const right = totalPad - left;
		return this.C(
			this.BORDER_COLOR,
			"┌" + "─".repeat(left) + title + "─".repeat(right) + "┐",
		);
	}

	private bottomBorder(w: number): string {
		return this.C(this.BORDER_COLOR, "└" + "─".repeat(w - 2) + "┘");
	}

	/* ─── tree state ─── */

	private rebuildFlat() {
		this.flatNodes = flattenTree(this.nodes);
		this.selectedIdx = Math.min(
			this.selectedIdx,
			Math.max(0, this.flatNodes.length - 1),
		);
		this.clampScroll();
	}

	private clampScroll() {
		if (this.flatNodes.length === 0) {
			this.scrollOffset = 0;
			return;
		}
		const maxOffset = Math.max(0, this.flatNodes.length - TREE_PAGE_SIZE);
		if (this.selectedIdx < this.scrollOffset) {
			this.scrollOffset = this.selectedIdx;
		} else if (this.selectedIdx >= this.scrollOffset + TREE_PAGE_SIZE) {
			this.scrollOffset = Math.min(
				this.selectedIdx - TREE_PAGE_SIZE + 1,
				maxOffset,
			);
		}
		this.scrollOffset = Math.max(
			0,
			Math.min(this.scrollOffset, maxOffset),
		);
		this.dirty = true;
	}

	private expandCurrent() {
		const fn = this.flatNodes[this.selectedIdx];
		if (!fn || fn.node.children.length === 0 || fn.node.expanded) return;
		toggleNode(this.nodes, fn.node.id);
		this.rebuildFlat();
	}

	private collapseCurrent() {
		const fn = this.flatNodes[this.selectedIdx];
		if (!fn) return;
		if (fn.node.children.length > 0 && fn.node.expanded) {
			toggleNode(this.nodes, fn.node.id);
			this.rebuildFlat();
		} else if (fn.node.depth > 0) {
			const parent = this.findParent(fn.node);
			if (parent && parent.expanded) {
				toggleNode(this.nodes, parent.id);
				this.rebuildFlat();
			}
		}
	}

	private toggleCurrent() {
		const fn = this.flatNodes[this.selectedIdx];
		if (!fn || fn.node.children.length === 0) return;
		toggleNode(this.nodes, fn.node.id);
		this.rebuildFlat();
	}

	private expandAll() {
		const walk = (ns: ContextNode[]) => {
			for (const n of ns) {
				if (n.children.length > 0) n.expanded = true;
				walk(n.children);
			}
		};
		walk(this.nodes);
		this.rebuildFlat();
	}

	private collapseAll() {
		const walk = (ns: ContextNode[]) => {
			for (const n of ns) {
				n.expanded = false;
				walk(n.children);
			}
		};
		walk(this.nodes);
		this.scrollOffset = 0;
		this.selectedIdx = 0;
		this.rebuildFlat();
	}

	private findParent(node: ContextNode): ContextNode | null {
		const walk = (
			ns: ContextNode[],
			target: ContextNode,
		): ContextNode | null => {
			for (const n of ns) {
				if (n.children.includes(target)) return n;
				const found = walk(n.children, target);
				if (found) return found;
			}
			return null;
		};
		return walk(this.nodes, node);
	}

	/* ─── public interface ─── */

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.onClose?.();
			return;
		}

		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			if (this.selectedIdx > 0) {
				this.selectedIdx--;
				this.clampScroll();
			}
			return;
		}

		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			if (this.selectedIdx < this.flatNodes.length - 1) {
				this.selectedIdx++;
				this.clampScroll();
			}
			return;
		}

		if (
			matchesKey(data, Key.right) ||
			matchesKey(data, Key.enter) ||
			matchesKey(data, "l")
		) {
			this.expandCurrent();
			return;
		}

		if (matchesKey(data, Key.left) || matchesKey(data, "h")) {
			this.collapseCurrent();
			return;
		}

		if (matchesKey(data, " ")) {
			this.toggleCurrent();
			return;
		}

		if (matchesKey(data, Key.home) || matchesKey(data, "g")) {
			this.selectedIdx = 0;
			this.scrollOffset = 0;
			this.dirty = true;
			return;
		}

		if (matchesKey(data, Key.end) || matchesKey(data, "G")) {
			this.selectedIdx = Math.max(0, this.flatNodes.length - 1);
			this.clampScroll();
			return;
		}

		if (matchesKey(data, "E")) {
			this.expandAll();
			return;
		}

		if (matchesKey(data, "C")) {
			this.collapseAll();
			return;
		}
	}

	invalidate(): void {
		this.dirty = true;
	}

	render(width: number): string[] {
		if (!this.dirty && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const w = Math.max(MIN_PANEL_WIDTH, width);
		const lines: string[] = [];

		lines.push(...this.renderHeader(w));
		lines.push(this.hBorder(w));
		lines.push(...this.renderTree(w));
		lines.push(this.hBorder(w));
		lines.push(...this.renderFooter(w));
		lines.push(this.bottomBorder(w));

		this.cachedWidth = w;
		this.cachedLines = lines.map((l) => truncateToWidth(l, w));
		this.dirty = false;
		return this.cachedLines;
	}

	/* ─── header ─── */

	private renderHeader(w: number): string[] {
		const lines: string[] = [];

		lines.push(this.topBorder(w, " Context Window "));

		// Gauge bar
		const gaugePct = this.contextPercent ?? 0;
		const filledW = Math.round((gaugePct / 100) * (w - 4));
		const emptyW = Math.max(0, w - 4 - filledW);
		const gColor = gaugeColor(this.contextPercent);

		lines.push(
			this.row(
				this.C(gColor, "█".repeat(filledW)) +
					this.dim("░".repeat(emptyW)),
				w,
			),
		);

		// Label
		const usedStr = fmtTokens(this.contextTokens);
		const maxStr = fmtTokens(this.contextWindow);
		const pctStr =
			this.contextPercent !== null
				? fmtPercent(this.contextPercent)
				: "?";
		const label = `${usedStr} / ${maxStr}  (${pctStr})`;
		const padL = Math.max(
			0,
			Math.floor((w - 4 - visibleWidth(label)) / 2),
		);
		lines.push(
			this.row(
				" ".repeat(padL) +
					this.C(gColor, this.B(label)) +
					" ".repeat(
						Math.max(0, w - 4 - padL - visibleWidth(label)),
					),
				w,
			),
		);

		// Empty spacer row
		lines.push(this.row("", w));

		return lines;
	}

	/* ─── tree body ─── */

	private renderTree(w: number): string[] {
		const lines: string[] = [];

		if (this.flatNodes.length === 0) {
			lines.push(this.row("  No messages in context yet.", w));
			for (let i = 1; i < TREE_PAGE_SIZE; i++) {
				lines.push(this.row("", w));
			}
			return lines;
		}

		const hasAbove = this.scrollOffset > 0;
		if (hasAbove) {
			lines.push(
				this.row(this.dim(`↑ ${this.scrollOffset} more above`), w),
			);
		}

		const end = Math.min(
			this.scrollOffset +
				TREE_PAGE_SIZE -
				(hasAbove ? 1 : 0),
			this.flatNodes.length,
		);
		const hasBelow = end < this.flatNodes.length;

		for (let i = this.scrollOffset; i < end; i++) {
			const fn = this.flatNodes[i]!;
			const isSelected = i === this.selectedIdx;
			lines.push(this.renderNodeRow(fn, isSelected, w));
		}

		// Fill remaining rows for stable panel height
		const used = lines.length;
		const treeCap = TREE_PAGE_SIZE + (hasAbove ? 1 : 0);
		for (let i = used; i < treeCap + (hasBelow ? 0 : 0); i++) {
			lines.push(this.row("", w));
		}

		if (hasBelow) {
			const belowCount = this.flatNodes.length - end;
			lines.push(
				this.row(this.dim(`↓ ${belowCount} more below`), w),
			);
		}

		return lines;
	}

	private renderNodeRow(
		fn: FlatNode,
		isSelected: boolean,
		w: number,
	): string {
		const { node } = fn;
		const innerW = w - 4;

		// ── left side ──
		let left = fn.prefix;

		// Expand/collapse indicator
		if (node.children.length > 0) {
			left += node.expanded ? "▾ " : "▸ ";
		} else {
			left += "  ";
		}

		// For system-prompt sub-parts (kind: "sp-sub"), no index column
		if (node.kind === "sp-sub") {
			left += "      "; // same width as index column
		} else if (node.messageIndex != null) {
			left += `[${String(node.messageIndex).padStart(3)}] `;
		} else {
			left += "      ";
		}

		// Role badge (skip for sp-sub, they have their own labels)
		if (node.kind === "sp-sub") {
			// Show the sub-part label directly
			left += this.dim(node.label.padEnd(22)) + " ";
		} else if (node.messageRole) {
			const rl = roleLabel(node.messageRole);
			left += this.C(rl.color, rl.label.padEnd(10)) + " ";
		} else if (node.kind === "system-prompt") {
			left += this.accent("system".padEnd(10)) + " ";
		} else if (node.kind === "message") {
			left += this.accent("group".padEnd(10)) + " ";
		} else {
			left += " ".repeat(11);
		}

		// Content preview / label
		let content = "";
		if (node.warning) {
			content = this.warn(`⚠ ${node.warning}`);
		} else if (
			node.kind === "message" &&
			node.messageRole === "toolResult" &&
			node.toolName
		) {
			const preview = node.preview ? ` ${node.preview}` : "";
			content = this.muted(node.toolName) + this.dim(preview);
		} else if (node.kind === "message" && node.preview) {
			content = this.dim(`"${node.preview}"`);
		} else if (node.preview) {
			content = this.dim(`"${node.preview}"`);
		} else if (node.kind === "sp-sub") {
			content = ""; // label already shown
		} else {
			content = this.dim(node.label);
		}
		left += content;

		// ── right side (metrics) ──
		const tokStr =
			(node.isEstimated ? "~" : " ") +
			fmtTokens(node.tokens).padStart(6);
		const pctStr = fmtPercent(node.percent).padStart(6);
		const barStr =
			node.percent != null
				? " " +
					miniBar(node.percent, BAR_WIDTH, {
						filled: (s) => this.C(gaugeColor(node.percent), s),
						empty: (s) => this.dim(s),
					})
				: "";

		const right =
			this.muted(tokStr) +
			" " +
			this.dim(pctStr) +
			barStr;

		// ── assemble ──
		const leftW = visibleWidth(left);
		const rightW = visibleWidth(right);
		const pad = Math.max(1, innerW - leftW - rightW);
		const fullRow = left + " ".repeat(pad) + right;
		const inner = truncateToWidth(fullRow, innerW);
		const paddedInner =
			inner +
			" ".repeat(Math.max(0, innerW - visibleWidth(inner)));

		const body = isSelected
			? this.bgC("selectedBg", paddedInner)
			: paddedInner;

		return truncateToWidth(
			this.C(this.BORDER_COLOR, "│ ") +
				body +
				this.C(this.BORDER_COLOR, " │"),
			w,
		);
	}

	/* ─── footer ─── */

	private renderFooter(w: number): string[] {
		const lines: string[] = [];
		const s = this.summary;

		// Summary stats
		const parts: string[] = [];
		parts.push(
			this.accent(`${s.totalMessages} msgs`) +
				` (${s.userMessages}U·${s.assistantMessages}A·${s.toolResults}T)`,
		);
		if (s.compactions > 0) {
			parts.push(
				this.muted(
					`${s.compactions} compaction${s.compactions > 1 ? "s" : ""}`,
				),
			);
		}
		if (s.cacheTokens > 0) {
			parts.push(this.dim(`cache: ${fmtTokens(s.cacheTokens)}`));
		}

		const summaryLine = parts.join("  ·  ");
		const slPad = Math.max(
			0,
			Math.floor((w - 4 - visibleWidth(summaryLine)) / 2),
		);
		lines.push(
			this.row(
				" ".repeat(slPad) +
					summaryLine +
					" ".repeat(
						Math.max(
							0,
							w - 4 - slPad - visibleWidth(summaryLine),
						),
					),
				w,
			),
		);

		// Keybinding help
		const help = [
			this.dim("↑↓/jk nav"),
			this.dim("←→ expand"),
			this.dim("space toggle"),
			this.dim("e all"),
			this.dim("c collapse"),
			this.dim("esc close"),
		].join("  ");
		const hPad = Math.max(
			0,
			Math.floor((w - 4 - visibleWidth(help)) / 2),
		);
		lines.push(
			this.row(
				" ".repeat(hPad) +
					help +
					" ".repeat(
						Math.max(0, w - 4 - hPad - visibleWidth(help)),
					),
				w,
			),
		);

		return lines;
	}
}
