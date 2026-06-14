/**
 * Pi Setup — pi extension
 *
 * /inspect opens a diagnostic panel with the current pi runtime setup:
 * extensions, skills, active model/provider, tools, context files, and session basics.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

type Section = { title: string; summary: string; rows: string[] };
type SetupSnapshot = { generatedAt: string; sections: Section[] };

const HOME = os.homedir();
const GLOBAL_EXT_DIR = path.join(HOME, ".pi", "agent", "extensions");
const GLOBAL_SKILL_DIR = path.join(HOME, ".pi", "agent", "skills");

async function exists(p: string) {
	try { await fs.access(p); return true; } catch { return false; }
}

async function readJson(p: string): Promise<any | null> {
	try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}

async function listExtensionEntries(dir: string) {
	if (!(await exists(dir))) return [];
	const entries = await fs.readdir(dir, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() || entry.isSymbolicLink() ? /\.[cm]?tsx?$/.test(entry.name) : entry.isDirectory())
		.map((entry) => path.join(dir, entry.name));
}

async function listSkillDirs(dir: string) {
	if (!(await exists(dir))) return [];
	const entries = await fs.readdir(dir, { withFileTypes: true });
	return entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => path.join(dir, entry.name));
}

function asArray<T = any>(value: unknown): T[] {
	return Array.isArray(value) ? value as T[] : [];
}

function modelRows(ctx: ExtensionCommandContext): string[] {
	const model = ctx.model as any;
	if (!model) return ["No active model selected"];
	const fields = [
		["Provider", model.provider],
		["Model", model.id],
		["Context", model.contextWindow?.toLocaleString?.() ?? model.contextWindow],
		["Max output", model.maxTokens?.toLocaleString?.() ?? model.maxTokens],
		["Reasoning", model.reasoning == null ? undefined : String(model.reasoning)],
	].filter(([, v]) => v != null && v !== "");
	return fields.map(([k, v]) => `${k}: ${v}`);
}

function uniqueNames(values: string[]) {
	return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function toolContributionChars(tool: any) {
	const parts = [
		tool.promptSnippet,
		...(Array.isArray(tool.promptGuidelines) ? tool.promptGuidelines : []),
	].filter(Boolean);
	return parts.join("\n").length;
}

async function buildSnapshot(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<SetupSnapshot> {
	const opts = ctx.getSystemPromptOptions?.() ?? {};
	const cwd = ctx.cwd;
	const projectExtDir = path.join(cwd, ".pi", "extensions");
	const projectSkillDir = path.join(cwd, ".agents", "skills");
	const globalSettingsPath = path.join(HOME, ".pi", "agent", "settings.json");
	const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
	const [globalExts, projectExts, globalSkills, projectSkills, globalSettings, projectSettings] = await Promise.all([
		listExtensionEntries(GLOBAL_EXT_DIR),
		listExtensionEntries(projectExtDir),
		listSkillDirs(GLOBAL_SKILL_DIR),
		listSkillDirs(projectSkillDir),
		readJson(globalSettingsPath),
		readJson(projectSettingsPath),
	]);

	const configuredExts = [...asArray<string>(globalSettings?.extensions), ...asArray<string>(projectSettings?.extensions)];
	const packages = [...asArray<string>(globalSettings?.packages), ...asArray<string>(projectSettings?.packages)];
	const loadedSkills = asArray<any>(opts.skills);
	const contextFiles = asArray<any>(opts.contextFiles);
	const tools = pi.getAllTools() as any[];
	const activeTools = new Set(pi.getActiveTools());
	const usage = ctx.getContextUsage();
	const sessionFile = ctx.sessionManager.getSessionFile?.();
	const model = ctx.model as any;
	const globalExtensionNames = uniqueNames(globalExts.map((p) => path.basename(p)));
	const projectExtensionNames = uniqueNames(projectExts.map((p) => path.basename(p)));
	const settingsExtensionNames = uniqueNames(configuredExts.map((p) => path.basename(p)));
	const packageNames = uniqueNames(packages.map((p) => p.replace(/^.*[:/]([^/@]+)(?:@.*)?$/, "$1")));
	const extensionCount = globalExtensionNames.length + projectExtensionNames.length + settingsExtensionNames.length + packageNames.length;
	const globalSkillNames = uniqueNames(globalSkills.map((p) => path.basename(p)));
	const projectSkillNames = uniqueNames(projectSkills.map((p) => path.basename(p)));
	const skillCount = projectSkillNames.length + globalSkillNames.length;

	return {
		generatedAt: new Date().toLocaleString(),
		sections: [
			{
				title: "Extensions",
				summary: `${extensionCount} active/configured`,
				rows: [
					...(projectExtensionNames.length ? [`Project (${projectExtensionNames.length})`, ...projectExtensionNames.map((name) => `  • ${name}`)] : []),
					...(globalExtensionNames.length ? [`Global (${globalExtensionNames.length})`, ...globalExtensionNames.map((name) => `  • ${name}`)] : []),
					...(settingsExtensionNames.length ? [`Settings (${settingsExtensionNames.length})`, ...settingsExtensionNames.map((name) => `  • ${name}`)] : []),
					...(packageNames.length ? [`Packages (${packageNames.length})`, ...packageNames.map((name) => `  • ${name}`)] : []),
				],
			},
			{
				title: "Skills",
				summary: `${skillCount} available`,
				rows: [
					...(projectSkillNames.length ? [`Project (${projectSkillNames.length})`, ...projectSkillNames.map((name) => `  • ${name}`)] : []),
					...(globalSkillNames.length ? [`Global (${globalSkillNames.length})`, ...globalSkillNames.map((name) => `  • ${name}`)] : []),
				],
			},
			{ title: "Model", summary: model ? `${model.provider}/${model.id}` : "none", rows: modelRows(ctx) },
			{
				title: "Tools",
				summary: `${activeTools.size}/${tools.length} active`,
				rows: tools.map((t) => `${activeTools.has(t.name) ? "●" : "○"} ${t.name} · ${toolContributionChars(t).toLocaleString()} chars`),
			},
			{
				title: "Context",
				summary: `${contextFiles.length} files · ${usage?.tokens?.toLocaleString?.() ?? "?"} tokens`,
				rows: [
					`Project trusted: ${ctx.isProjectTrusted?.() ? "yes" : "no"}`,
					`System prompt: ${ctx.getSystemPrompt().length.toLocaleString()} chars`,
					`Context usage: ${usage ? `${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} (${usage.percent.toFixed(1)}%)` : "unknown"}`,
					...contextFiles.map((f) => `• ${path.basename(f.path ?? f.name ?? "unknown")} · ${(f.content ?? "").length.toLocaleString()} chars`),
				],
			},
			{
				title: "Session",
				summary: `${ctx.sessionManager.getEntries().length} entries`,
				rows: [`Mode: ${ctx.mode}`, `Session: ${sessionFile ? path.basename(sessionFile) : "ephemeral"}`, `Leaf: ${ctx.sessionManager.getLeafId?.() ?? "unknown"}`],
			},
		],
	};
}

class SetupPanel {
	private theme?: ThemeLike;
	private selected = 0;
	private scroll = 0;
	public onClose?: () => void;
	constructor(private snapshot: SetupSnapshot, private requestRender: () => void) {}
	setTheme(theme: ThemeLike) { this.theme = theme; }
	invalidate() {}
	private rp(rgb: [number, number, number], text: string) { return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[0m`; }
	private B(text: string) { return this.theme ? this.theme.bold(text) : text; }
	private border(text: string) { return this.rp([82, 79, 103], text); }
	private muted(text: string) { return this.rp([144, 140, 170], text); }
	private dim(text: string) { return this.rp([110, 106, 134], text); }
	private accent(text: string) { return this.rp([196, 167, 231], text); }
	private good(text: string) { return this.rp([156, 207, 216], text); }
	private row(content: string, width: number) {
		const inner = Math.max(1, width - 4);
		const padded = content + " ".repeat(Math.max(0, inner - visibleWidth(content)));
		return truncateToWidth(this.border("│ ") + padded + this.border(" │"), width, "");
	}
	handleInput(data: string) {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") return this.onClose?.();
		if (matchesKey(data, Key.up) || data === "k") this.scroll = Math.max(0, this.scroll - 1);
		if (matchesKey(data, Key.down) || data === "j") this.scroll += 1;
		if (matchesKey(data, Key.left) || data === "h") { this.selected = Math.max(0, this.selected - 1); this.scroll = 0; }
		if (matchesKey(data, Key.right) || data === "l") { this.selected = Math.min(this.snapshot.sections.length - 1, this.selected + 1); this.scroll = 0; }
		if (matchesKey(data, Key.home)) this.scroll = 0;
		this.requestRender();
	}
	render(width: number): string[] {
		const w = Math.max(50, width);
		const section = this.snapshot.sections[this.selected];
		const lines: string[] = [];
		const title = " Pi Setup ";
		const fill = Math.max(0, w - 2 - visibleWidth(title));
		const left = Math.floor(fill / 2);
		lines.push(this.border("┌" + "─".repeat(left)) + this.accent(this.B(title)) + this.border("─".repeat(fill - left) + "┐"));
		lines.push(this.row(`${this.good(section.title)} ${this.dim("·")} ${section.summary}`, w));
		const tabs = this.snapshot.sections.map((s, i) => i === this.selected ? this.accent(this.B(` ${s.title} `)) : this.muted(` ${s.title} `)).join(this.dim(" "));
		lines.push(this.row(tabs, w));
		lines.push(this.border("├" + "─".repeat(Math.max(0, w - 2)) + "┤"));
		const viewport = 18;
		const rows = section.rows.length ? section.rows : ["No data"];
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - viewport)));
		for (const row of rows.slice(this.scroll, this.scroll + viewport)) lines.push(this.row(truncateToWidth(row, w - 6, "…"), w));
		while (lines.length < 24) lines.push(this.row("", w));
		lines.push(this.border("├" + "─".repeat(Math.max(0, w - 2)) + "┤"));
		const footerLeft = this.dim("h/l sections · ↑↓ scroll · q close");
		const footerRight = this.dim(this.snapshot.generatedAt);
		const footerGap = " ".repeat(Math.max(1, w - 4 - visibleWidth(footerLeft) - visibleWidth(footerRight)));
		lines.push(this.row(`${footerLeft}${footerGap}${footerRight}`, w));
		lines.push(this.border("└" + "─".repeat(Math.max(0, w - 2)) + "┘"));
		return lines;
	}
}

function snapshotText(snapshot: SetupSnapshot) {
	return snapshot.sections.flatMap((section) => [`## ${section.title} — ${section.summary}`, ...section.rows, ""]).join("\n");
}

export default function piSetup(pi: ExtensionAPI) {
	pi.registerCommand("inspect", {
		description: "Inspect the current pi setup",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const snapshot = await buildSnapshot(pi, ctx);
			if (ctx.mode !== "tui") return ctx.ui.notify(snapshotText(snapshot), "info");
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const panel = new SetupPanel(snapshot, () => tui.requestRender());
				panel.setTheme(theme);
				panel.onClose = () => done(undefined);
				return { render: (width) => panel.render(width), invalidate: () => panel.invalidate(), handleInput: (data) => panel.handleInput(data) };
			}, { overlay: true, overlayOptions: { anchor: "center", width: "72%", minWidth: 78, maxHeight: "88%", margin: 1 } });
		},
	});
}
