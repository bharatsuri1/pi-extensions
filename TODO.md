# pi-extensions TODO

_Last reviewed: 2026-06-07_

## Goal

Make this repository the source of truth for personal pi extensions. Current working implementations live in `~/.pi/agent/extensions/`; after review and hardening, migrate them into this repo and symlink the auto-discovered extension paths back to the repo.

## Current inventory reviewed

- `~/.pi/agent/extensions/statusline.ts`
  - Rich custom footer for cwd, git branch/dirty count, model, thinking level, cost/tokens, context usage, active tools, queue, message/turn counts.
- `~/.pi/agent/extensions/context-explorer/`
  - `/context` overlay with context-window gauge and collapsible tree for system prompt, tools, skills, context files, and session messages.
- `~/.pi/agent/extensions/codex-usage.ts`
  - `/codex-usage` command and `codex_get_usage` tool for OpenAI Codex usage via ChatGPT backend OAuth token.
- `~/.pi/agent/extensions/tsconfig.json`
  - Local TypeScript config pointing at the globally installed pi packages.

## Repository setup

- [x] Import current implementations into repo and symlink global runtime to repo:
  - [x] `extensions/statusline.ts`
  - [x] `extensions/context-explorer/index.ts`
  - [x] `extensions/context-explorer/components.ts`
  - [x] `extensions/context-explorer/tree-builder.ts`
  - [x] `extensions/context-explorer/utils.ts`
  - [x] `extensions/codex-usage.ts`
  - [x] `extensions/tsconfig.json`
- [ ] Add repo-level TypeScript/tooling:
  - [ ] `package.json` with `typecheck`, `format`, and `lint` scripts.
  - [ ] `typescript` and `@types/node` dev dependencies.
  - [ ] Strict `tsconfig.json` for repo sources.
- [ ] Add an install/symlink script that is safe by default:
  - [ ] Detect existing non-symlink files in `~/.pi/agent/extensions` and refuse to overwrite unless `--force` is provided.
  - [ ] Back up existing global extensions before replacing.
  - [ ] Symlink extension files/directories from this repo into `~/.pi/agent/extensions/`.
- [ ] Document repo workflow in `README.md`:
  - [ ] edit in repo → typecheck → reload pi → test command → commit → symlink/update.
  - [ ] list slash commands and expected behavior.

## Extension hardening backlog

### 1. Statusline for pi

- [ ] Keep statusline as a production-quality custom footer, but make it theme-aware instead of hard-coded Rosé Pine ANSI colors.
- [ ] Add compact/responsive render modes for narrow terminals.
- [ ] Make `/statusline` toggling restore the default footer when disabled; avoid installing a blank custom footer.
- [ ] Confirm session reload/shutdown disposes intervals and pending render timers cleanly.
- [ ] Improve git detection:
  - [ ] support nested repo paths and worktrees where `.git` is a file;
  - [ ] decide whether untracked files should count;
  - [ ] avoid repeated `git status` when outside a repo.
- [ ] Guard usage aggregation against missing/partial `usage` fields.
- [ ] Add optional Codex usage segment once `codex-usage` has caching.

### 2. Context view for pi

- [ ] Keep `/context` as the primary context explorer command.
- [ ] Use `ctx.mode === "tui"` for overlay mode; provide useful fallback for RPC/JSON/print modes.
- [ ] Ensure rendered overlay lines never exceed the terminal width; current minimum-width behavior can violate TUI render rules on very narrow terminals.
- [ ] Fix help/key mismatch: footer says `e all` / `c collapse`, handler currently uses uppercase `E` / `C`.
- [ ] Correct summary counts so container/group nodes are not counted as messages.
- [ ] Add branch-summary and compaction entries if exposed in session branch data.
- [ ] Improve token accounting:
  - [ ] distinguish exact provider usage from estimates;
  - [ ] show image/tool-call/schema contribution where possible;
  - [ ] document estimation caveats.
- [ ] Consider commands/options:
  - [ ] `/context` opens overlay;
  - [ ] `/context summary` inserts or displays text summary;
  - [ ] `/context copy` copies markdown report to editor/clipboard if supported.

### 3. OpenAI Codex usage

- [ ] Fix custom tool `execute` signature to match pi docs: `(toolCallId, params, signal, onUpdate, ctx)`.
- [ ] Replace `atob` JWT decoding with `Buffer.from(..., "base64url")` for Node robustness.
- [ ] Remove unused imports/variables and tighten types.
- [ ] Add cache layer:
  - [ ] TTL-based in-memory cache for statusline reads;
  - [ ] force refresh via `/codex-usage refresh`;
  - [ ] stale/error state surfaced without blocking footer rendering.
- [ ] Add statusline integration:
  - [ ] compact quota segment, e.g. `Codex 5h 42% · wk 18%`;
  - [ ] color thresholds for approaching limits;
  - [ ] do not fetch on every render.
- [ ] Improve on-demand slash command:
  - [ ] `/codex-usage` uses cache when fresh;
  - [ ] `/codex-usage refresh` bypasses cache;
  - [ ] output as notification/overlay/editor based on mode and size.
- [ ] Decide error semantics for tool calls: throw on real fetch failures vs. return structured non-fatal status for missing login.
- [ ] Verify OAuth refresh behavior; current code only reads the stored access token.
- [ ] Treat backend endpoint as unofficial/private; document risks and avoid logging tokens/account IDs.

## Validation checklist before symlinking

- [ ] `npm run typecheck` passes.
- [ ] `npm run lint` passes, or lint intentionally deferred and documented.
- [ ] Start pi with repo extension paths via `pi -e ./extensions/statusline.ts -e ./extensions/codex-usage.ts -e ./extensions/context-explorer/index.ts`.
- [ ] `/reload` works without duplicate timers or stale UI.
- [ ] `/statusline` toggles on/off cleanly.
- [ ] `/context` opens, navigates, expands/collapses, and closes cleanly.
- [ ] `/codex-usage` works when logged in and fails safely when not logged in.
- [x] Existing global extension sources are symlinked into `~/.pi/agent/extensions/`.
  - [x] `statusline.ts` → `extensions/statusline.ts`
  - [x] `codex-usage.ts` → `extensions/codex-usage.ts`
  - [x] `context-explorer` → `extensions/context-explorer`
  - [x] `tsconfig.json` → `extensions/tsconfig.json`
- [ ] Confirm auto-discovery after reload/startup.

## Notes from initial review

- Pi auto-discovers global extensions from `~/.pi/agent/extensions/*.ts` and `~/.pi/agent/extensions/*/index.ts`; symlinks should preserve one of those shapes.
- `ctx.ui.setFooter()` replaces the built-in footer entirely, so statusline should remain the single owner of the footer and pull in other extension status via shared state/events where needed.
- `ctx.ui.custom()` is TUI-specific; `ctx.hasUI` is also true in RPC mode, so use `ctx.mode` for terminal overlays.
- Custom component `render(width)` must return lines no wider than `width`.
- Typecheck was attempted against the global extension directory, but this repo does not yet have local TypeScript tooling. Add repo tooling before treating typecheck as authoritative.
