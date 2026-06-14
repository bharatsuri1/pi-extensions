/**
 * Git Quick — pi extension
 *
 * /git opens a compact, read-only git panel focused on working tree state
 * and a quick stash glance.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";

interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

type StatusGroup = "staged" | "modified" | "untracked" | "deleted" | "renamed" | "other";

type StatusFile = {
	path: string;
	xy: string;
	group: StatusGroup;
};

type GitState = {
	branch: string;
	aheadBehind: string;
	files: StatusFile[];
	stashes: string[];
	exitCode: number;
	stderr: string;
	durationMs: number;
};

const GROUPS: Array<{ id: StatusGroup; label: string; color: string; empty: string }> = [
	{ id: "staged", label: "Staged", color: "success", empty: "Nothing staged" },
	{ id: "modified", label: "Modified", color: "warning", empty: "No modified files" },
	{ id: "untracked", label: "Untracked", color: "accent", empty: "No untracked files" },
	{ id: "deleted", label: "Deleted", color: "error", empty: "No deleted files" },
	{ id: "renamed", label: "Renamed", color: "rose", empty: "No renamed files" },
	{ id: "other", label: "Other", color: "pine", empty: "No other changes" },
];

function runGitRaw(ctx: ExtensionCommandContext, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve) => {
		execFile(
			"git",
			args,
			{
				cwd: ctx.cwd,
				env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
				maxBuffer: 1024 * 1024 * 4,
				timeout: 15_000,
			},
			(error, stdout, stderr) => {
				const exitCode = typeof (error as { code?: unknown } | null)?.code === "number"
					? (error as { code: number }).code
					: error
						? 1
						: 0;
				resolve({ stdout: stdout || "", stderr: stderr || "", exitCode });
			},
		);
	});
}

function parseBranch(line: string | undefined): { branch: string; aheadBehind: string } {
	if (!line?.startsWith("## ")) return { branch: "unknown", aheadBehind: "" };
	const raw = line.slice(3).trim();
	const match = raw.match(/^([^\.\[]+|[^\[]+?)(?:\.\.\.[^\[]+)?(?:\s+(\[.*\]))?$/);
	return {
		branch: (match?.[1] ?? raw).trim(),
		aheadBehind: (match?.[2] ?? "").replace(/^\[|\]$/g, ""),
	};
}

function classify(xy: string): StatusGroup {
	const index = xy[0] ?? " ";
	const worktree = xy[1] ?? " ";
	if (xy === "??") return "untracked";
	if (index === "R" || worktree === "R") return "renamed";
	if (index === "D" || worktree === "D") return "deleted";
	if (index !== " " && index !== "?") return "staged";
	if (worktree !== " ") return "modified";
	return "other";
}

function parseStatus(output: string): { branch: string; aheadBehind: string; files: StatusFile[] } {
	const lines = output.split(/\r?\n/).filter(Boolean);
	const { branch, aheadBehind } = parseBranch(lines.find((line) => line.startsWith("## ")));
	const files = lines
		.filter((line) => !line.startsWith("## "))
		.map((line) => {
			const xy = line.slice(0, 2);
			const path = line.slice(3).trim();
			return { path, xy, group: classify(xy) };
		});
	return { branch, aheadBehind, files };
}

async function loadGitState(ctx: ExtensionCommandContext): Promise<GitState> {
	const started = Date.now();
	const [status, stash] = await Promise.all([
		runGitRaw(ctx, ["status", "--short", "--branch"]),
		runGitRaw(ctx, ["stash", "list", "--date=relative", "--pretty=%gd%x09%cr%x09%s"]),
	]);
	const parsed = parseStatus(status.stdout);
	return {
		...parsed,
		stashes: stash.stdout.split(/\r?\n/).filter(Boolean),
		exitCode: status.exitCode || stash.exitCode,
		stderr: [status.stderr, stash.stderr].filter(Boolean).join("\n"),
		durationMs: Date.now() - started,
	};
}

class GitPanel {
	private ctx: ExtensionCommandContext;
	private theme?: ThemeLike;
	private state: GitState | null = null;
	private loading = true;
	private selectedTab: "status" | "stash" = "status";
	private scroll = 0;
	private requestRender: () => void;
	public onClose?: () => void;

	constructor(ctx: ExtensionCommandContext, requestRender: () => void) {
		this.ctx = ctx;
		this.requestRender = requestRender;
		void this.refresh();
	}

	setTheme(theme: ThemeLike) { this.theme = theme; }
	invalidate() {}

	private C(color: string, text: string): string { return this.theme ? this.theme.fg(color, text) : text; }
	private B(text: string): string { return this.theme ? this.theme.bold(text) : text; }
	private rp(rgb: [number, number, number], text: string): string { return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[0m`; }
	private border(text: string) { return this.rp([82, 79, 103], text); }
	private muted(text: string) { return this.rp([144, 140, 170], text); }
	private dim(text: string) { return this.rp([110, 106, 134], text); }
	private accent(text: string) { return this.rp([196, 167, 231], text); }
	private title(text: string) { return this.rp([235, 188, 186], text); }
	private color(color: string, text: string) {
		const rosePine: Record<string, [number, number, number]> = {
			success: [156, 207, 216],
			warning: [246, 193, 119],
			error: [235, 111, 146],
			accent: [196, 167, 231],
			rose: [235, 188, 186],
			pine: [49, 116, 143],
			muted: [144, 140, 170],
			dim: [110, 106, 134],
		};
		return this.rp(rosePine[color] ?? [224, 222, 244], text);
	}

	private row(content: string, width: number): string {
		const inner = Math.max(1, width - 4);
		const padded = content + " ".repeat(Math.max(0, inner - visibleWidth(content)));
		return truncateToWidth(this.border("│ ") + padded + this.border(" │"), width, "");
	}

	private divider(width: number): string {
		return this.border("├" + "─".repeat(Math.max(0, width - 2)) + "┤");
	}

	private async refresh() {
		this.loading = true;
		this.requestRender();
		this.state = await loadGitState(this.ctx);
		this.loading = false;
		this.scroll = 0;
		this.requestRender();
	}

	handleInput(data: string) {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") return this.onClose?.();
		if (matchesKey(data, Key.left) || matchesKey(data, Key.right) || data === "h" || data === "l") {
			this.selectedTab = this.selectedTab === "status" ? "stash" : "status";
			this.scroll = 0;
		}
		if (matchesKey(data, Key.up) || data === "k") this.scroll = Math.max(0, this.scroll - 1);
		if (matchesKey(data, Key.down) || data === "j") this.scroll += 1;
		if (matchesKey(data, Key.home)) this.scroll = 0;
		if (matchesKey(data, Key.enter) || data === "r") void this.refresh();
		this.requestRender();
	}

	private count(group: StatusGroup): number {
		return this.state?.files.filter((file) => file.group === group).length ?? 0;
	}

	private buildStatusRows(width: number): string[] {
		const state = this.state;
		if (!state || state.files.length === 0) return [this.color("success", "Clean working tree"), this.dim("No modified or untracked files")];

		const rows: string[] = [];
		for (const group of GROUPS) {
			const files = state.files.filter((file) => file.group === group.id);
			if (files.length === 0) continue;
			if (rows.length > 0) rows.push(this.dim(""));
			rows.push(`${this.color(group.color, this.B(group.label))} ${this.dim(`(${files.length})`)}`);
			for (const file of files) {
				const marker = this.color(group.color, file.xy.padEnd(2));
				rows.push(`${marker}  ${truncateToWidth(file.path, width - 10, "…")}`);
			}
		}
		return rows;
	}

	private buildStashRows(width: number): string[] {
		const stashes = this.state?.stashes ?? [];
		if (stashes.length === 0) return [this.dim("No stashed work")];
		return stashes.map((stash) => {
			const [name, age, ...message] = stash.split("\t");
			return `${this.accent(name ?? "stash")} ${this.dim(age ?? "")}  ${truncateToWidth(message.join(" "), width - 26, "…")}`;
		});
	}

	render(width: number): string[] {
		const w = Math.max(24, width);
		const lines: string[] = [];
		const title = " Git ";
		const fill = Math.max(0, w - 2 - visibleWidth(title));
		const left = Math.floor(fill / 2);
		lines.push(this.border("┌" + "─".repeat(left)) + this.title(this.B(title)) + this.border("─".repeat(fill - left) + "┐"));

		if (this.loading && !this.state) {
			lines.push(this.row(`${this.color("warning", "●")} ${this.muted("reading working tree and stash")}`, w));
			lines.push(this.border("└" + "─".repeat(Math.max(0, w - 2)) + "┘"));
			return lines;
		}

		const state = this.state;
		const total = state?.files.length ?? 0;
		const branch = state ? `${this.color("success", this.B(state.branch))}${state.aheadBehind ? ` ${this.muted(state.aheadBehind)}` : ""}` : this.dim("unknown");
		const freshness = this.loading ? this.color("warning", "refreshing") : this.dim(`${state?.durationMs ?? 0}ms`);
		lines.push(this.row(`${branch} ${this.dim("·")} ${total === 0 ? this.color("success", "clean tree") : this.color("warning", `${total} changed`)} ${this.dim("·")} ${freshness}`, w));

		const tabStatus = this.selectedTab === "status" ? this.accent(this.B(` Status ${total} `)) : this.muted(` Status ${total} `);
		const tabStash = this.selectedTab === "stash" ? this.accent(this.B(` Stash ${state?.stashes.length ?? 0} `)) : this.muted(` Stash ${state?.stashes.length ?? 0} `);
		lines.push(this.row(`${tabStatus}${this.dim(" · ")}${tabStash}`, w));
		lines.push(this.divider(w));

		const viewport = 15;
		const bodyRows = this.selectedTab === "status"
			? this.buildStatusRows(w)
			: this.buildStashRows(w);
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, bodyRows.length - viewport)));
		for (const row of bodyRows.slice(this.scroll, this.scroll + viewport)) lines.push(this.row(row, w));
		while (lines.length < 23) lines.push(this.row("", w));

		if (state?.stderr) lines.push(this.row(this.color("error", truncateToWidth(state.stderr, w - 4, "…")), w));
		lines.push(this.divider(w));
		lines.push(this.row(this.dim("h/l switch · ↑↓ scroll · r refresh · q close"), w));
		lines.push(this.border("└" + "─".repeat(Math.max(0, w - 2)) + "┘"));
		return lines.map((line) => truncateToWidth(line, w, ""));
	}
}

async function showGit(ctx: ExtensionCommandContext) {
	await ctx.waitForIdle();

	if (ctx.mode !== "tui") {
		const state = await loadGitState(ctx);
		const lines = [`${state.branch}${state.aheadBehind ? ` (${state.aheadBehind})` : ""}`];
		for (const group of GROUPS) {
			const files = state.files.filter((file) => file.group === group.id);
			if (files.length > 0) lines.push(`${group.label}: ${files.length}`);
		}
		lines.push(`Stash: ${state.stashes.length}`);
		ctx.ui.notify(lines.join("\n"), state.exitCode === 0 ? "info" : "error");
		return;
	}

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const panel = new GitPanel(ctx, () => tui.requestRender());
		panel.setTheme(theme);
		panel.onClose = () => done(undefined);
		return {
			render: (width: number) => panel.render(width),
			invalidate: () => panel.invalidate(),
			handleInput: (data: string) => panel.handleInput(data),
		};
	}, {
		overlay: true,
		overlayOptions: { anchor: "center", width: "64%", minWidth: 68, maxHeight: "84%", margin: 1 },
	});
}

export default function gitQuick(pi: ExtensionAPI) {
	pi.registerCommand("git", {
		description: "Open a focused git status and stash panel",
		handler: async (_args, ctx) => showGit(ctx),
	});
}
