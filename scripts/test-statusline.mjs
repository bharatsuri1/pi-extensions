#!/usr/bin/env node

/**
 * Smoke-test and preview the statusline extension without launching pi.
 *
 * Usage:
 *   node scripts/test-statusline.mjs
 *   node scripts/test-statusline.mjs --widths=80,120
 *   node scripts/test-statusline.mjs --plain
 *   node scripts/test-statusline.mjs --scenario=active-queued
 */

import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);

const PI_ROOT = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const PI_NODE_MODULES = `${PI_ROOT}/node_modules`;
process.env.NODE_PATH = [PI_NODE_MODULES, "/opt/homebrew/lib/node_modules", process.env.NODE_PATH]
	.filter(Boolean)
	.join(":");
require("node:module").Module._initPaths();

const { createJiti } = require(`${PI_NODE_MODULES}/jiti`);
const { visibleWidth } = require(`${PI_NODE_MODULES}/@earendil-works/pi-tui`);

const args = new Map(
	process.argv.slice(2).map((arg) => {
		const [key, ...rest] = arg.replace(/^--/, "").split("=");
		return [key, rest.length ? rest.join("=") : "true"];
	})
);

const widths = (args.get("widths") ?? "80,100,120")
	.split(",")
	.map((value) => Number(value.trim()))
	.filter((value) => Number.isFinite(value) && value > 0);
const plain = args.has("plain") || args.has("no-color");
const scenarioFilter = args.get("scenario");

const stripAnsi = (value) => value.replace(/\x1b\[[0-9;]*m/g, "");
const output = (value) => (plain ? stripAnsi(value) : value);

const extensionPath = new URL("../extensions/statusline.ts", import.meta.url).pathname;
const statuslineExtension = createJiti(process.cwd() + "/")(extensionPath).default;

const scenarios = [
	{
		id: "active-queued",
		label: "active agent, queued message, git branch",
		idle: false,
		queued: true,
		branch: "feature/statusline",
		contextPercent: 71,
	},
	{
		id: "inactive",
		label: "inactive agent, no queue, git branch",
		idle: true,
		queued: false,
		branch: "main",
		contextPercent: 24,
	},
	{
		id: "no-git-critical",
		label: "active agent, no git branch, critical context",
		idle: false,
		queued: false,
		branch: null,
		contextPercent: 93,
	},
].filter((scenario) => !scenarioFilter || scenario.id === scenarioFilter);

if (scenarios.length === 0) {
	console.error(`Unknown scenario: ${scenarioFilter}`);
	process.exit(1);
}

function makeHarness(scenario) {
	const handlers = new Map();
	let footer = null;
	let execCalled = false;
	let idle = scenario.idle;

	const pi = {
		exec() {
			execCalled = true;
			throw new Error("statusline should not call pi.exec during preview");
		},
		getThinkingLevel() {
			return "high";
		},
		getActiveTools() {
			return Array.from({ length: 9 }, (_, index) => ({ name: `tool${index + 1}` }));
		},
		registerCommand() {},
		on(name, handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
	};

	statuslineExtension(pi);

	const ctx = {
		model: { id: "anthropic/claude-sonnet-4-20250514", provider: "anthropic" },
		cwd: process.cwd(),
		isIdle() {
			return idle;
		},
		getContextUsage() {
			return { tokens: Math.round((scenario.contextPercent / 100) * 200_000), contextWindow: 200_000, percent: scenario.contextPercent };
		},
		hasPendingMessages() {
			return scenario.queued;
		},
		sessionManager: {
			getBranch() {
				return [
					{ type: "message", message: { role: "user" } },
					{ type: "message", message: { role: "assistant", usage: { input: 12_345, output: 6_789, cost: { total: 0.0123 } } } },
				];
			},
		},
		ui: {
			setFooter(factory) {
				if (!factory) {
					footer = null;
					return;
				}
				footer = factory(
					{ requestRender() {} },
					{},
					{
						getGitBranch() {
							return scenario.branch;
						},
						onBranchChange() {
							return () => {};
						},
					}
				);
			},
			notify() {},
		},
	};

	async function emit(name, event = {}) {
		for (const handler of handlers.get(name) ?? []) {
			await handler({ type: name, ...event }, ctx);
		}
	}

	return {
		async start() {
			await emit("session_start");
			if (scenario.idle) {
				await emit("agent_end");
			} else {
				idle = false;
				await emit("agent_start");
			}
		},
		render(width) {
			if (!footer) throw new Error("Footer was not installed");
			return footer.render(width);
		},
		dispose() {
			footer?.dispose?.();
		},
		get execCalled() {
			return execCalled;
		},
	};
}

let failed = false;

for (const scenario of scenarios) {
	const harness = makeHarness(scenario);
	await harness.start();

	console.log(`\n${scenario.id}: ${scenario.label}`);
	for (const width of widths) {
		const lines = harness.render(width);
		const widthsRendered = lines.map((line) => visibleWidth(line));
		const overflow = widthsRendered.some((lineWidth) => lineWidth > width);
		if (overflow) failed = true;

		console.log(`\nwidth ${width} ${overflow ? "OVERFLOW" : "ok"}`);
		for (const line of lines) {
			console.log(`${output(line)} ${plain ? `(${visibleWidth(line)}/${width})` : ""}`);
		}
	}

	if (harness.execCalled) {
		failed = true;
		console.error("pi.exec was called. Git rendering is no longer instant.");
	}
	harness.dispose();
}

process.exitCode = failed ? 1 : 0;
