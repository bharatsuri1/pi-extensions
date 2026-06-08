# Statusline extension review

_Date: 2026-06-07_

Reviewed implementation copied from `~/.pi/agent/extensions/statusline.ts` into `extensions/statusline.ts`.

## Scope

This review covers the current pi statusline extension against the TODO backlog:

- theme-aware rendering instead of hard-coded Rosé Pine ANSI colors
- compact/responsive rendering for narrow terminals
- `/statusline` toggle behavior and default footer restoration
- lifecycle/resource cleanup
- git detection robustness
- safe usage aggregation
- future Codex usage integration

## Findings

### 1. Usage aggregation can throw on partial assistant usage

**Location:** `extensions/statusline.ts`, `recomputeCosts()`

The implementation assumes every assistant message has complete usage data:

```ts
input += m.usage.input;
output += m.usage.output;
cost += m.usage.cost.total;
```

If an assistant message has missing or partial `usage`, footer refresh can throw and stop the statusline from updating.

**Suggested fix:** use optional chaining and numeric defaults:

```ts
input += m.usage?.input ?? 0;
output += m.usage?.output ?? 0;
cost += m.usage?.cost?.total ?? 0;
```

### 2. Git dirty detection is fragile

**Location:** `extensions/statusline.ts`, `updateGitInfo()`

The current cache probes `cwd/.git/index` directly. This fails or becomes inaccurate for:

- working from a subdirectory inside a repo
- worktrees, where `.git` is usually a file
- nested repos
- repos where the git dir is elsewhere

The command also uses `git status --porcelain -uno`, so untracked files are intentionally excluded. That may be the desired behavior, but it should be a documented choice.

**Suggested fix:** use git itself to resolve repository state:

- `git rev-parse --show-toplevel`
- `git rev-parse --git-path index`
- then stat the resolved index path for caching

Also cache the resolved repo root/index path per cwd and avoid repeated git calls when outside a repo.

### 3. Dirty-cache logic still polls repeatedly while dirty

**Location:** `extensions/statusline.ts`, `updateGitInfo()`

This condition skips `git status` only when the repo was previously clean:

```ts
if (stat.mtimeMs === lastIndexMtime && lastGitChanged === 0) return;
```

If the index mtime is unchanged but the repo remains dirty, the extension keeps running `git status` every slow poll.

**Suggested fix:** if the resolved index mtime is unchanged, reuse the last dirty count regardless of whether it is zero. If untracked files are included later, add a separate slower refresh path because untracked-only changes may not update the index.

### 4. Rendering ignores pi theme

**Location:** `extensions/statusline.ts`, Rosé Pine `rp` palette and `renderFooter(width, _theme)`

The footer hard-codes truecolor Rosé Pine ANSI escapes and ignores the `theme` object passed by pi. This can clash with user-selected pi themes, light terminal themes, and future theme customization.

**Suggested fix:** replace `rp.*` with a small theme adapter using pi theme roles:

- text: `theme.fg("text", s)`
- muted/subtle: `theme.fg("muted", s)` / `theme.fg("dim", s)`
- highlights: `theme.fg("accent", s)`
- warnings: `theme.fg("warning", s)`
- errors/limits: `theme.fg("error", s)`

### 5. Narrow terminal output is technically bounded but not responsive

**Location:** `extensions/statusline.ts`, `renderFooter()`

The footer uses `truncateToWidth()` at the end, so lines should not overflow. However, for narrow terminals the current layout can truncate the most useful information unpredictably because it always builds the wide layout first.

**Suggested fix:** add rendering tiers:

- **Wide:** current two-line rich layout.
- **Medium:** shorten model/cwd, reduce git details, keep core metrics.
- **Narrow:** one compact line with only cwd/repo, model, context percent, cost, and active tools.

### 6. Toggle restores default footer, but cleanup should be centralized

**Location:** `extensions/statusline.ts`, `/statusline` handler and footer `dispose()`

The TODO item “restore the default footer when disabled” is mostly already satisfied because disabling calls:

```ts
ctx.ui.setFooter(undefined);
```

However, cleanup is split across command handling and footer `dispose()`. Pending debounce timers are not cleared, and async git polling can still update shared state after a footer replacement.

**Suggested fix:** add helpers such as:

- `clearQueuedRender()`
- `resetFooterState()` / `teardownFooter()`
- increment `footerGeneration` on teardown and check it after awaited git operations

### 7. In-flight async git polling can race footer replacement

**Location:** `extensions/statusline.ts`, slow git poll and event handlers

`updateGitInfo()` awaits filesystem/git operations and then updates module-level state. If the footer is replaced or disabled while a git update is in flight, the update can still write stale data.

**Suggested fix:** pass or capture a generation token around async work and discard results if the generation changed.

### 8. Future Codex usage segment should be external/shared state, not direct footer fetches

**Location:** future integration

The statusline should not fetch Codex usage from the footer render path or on every poll.

**Suggested approach:** build the Codex cache in `codex-usage`, then expose compact cached status to the footer via shared module state or extension status. The statusline should render stale/error/fresh states without blocking.

## Proposed implementation sequence

### Commit 1 — Import statusline into repo and document review

Files:

- `extensions/statusline.ts`
- `docs/statusline-review.md`
- optionally update `TODO.md`

Purpose:

- make the repository the canonical source for the current statusline implementation
- preserve the exact existing implementation before behavior changes
- record review findings and planned changes

### Commit 2 — Harden statusline lifecycle and usage safety

Files:

- `extensions/statusline.ts`

Changes:

- safe optional usage aggregation
- clear queued render timers on dispose/disable
- guard async updates with footer generation
- remove redundant disabled-render path if footer is restored by `setFooter(undefined)`

### Commit 3 — Improve git detection and caching

Files:

- `extensions/statusline.ts`

Changes:

- resolve repo root and git index path with `git rev-parse`
- support subdirectories and worktrees
- cache outside-repo state
- document and keep/adjust tracked-only dirty count behavior

### Commit 4 — Make statusline theme-aware

Files:

- `extensions/statusline.ts`

Changes:

- replace hard-coded Rosé Pine ANSI palette with pi theme roles
- keep semantic colors for warnings/high context usage
- verify with at least one dark and one light theme if available

### Commit 5 — Add responsive render tiers

Files:

- `extensions/statusline.ts`

Changes:

- wide, medium, and narrow footer layouts
- keep all rendered lines within terminal width
- prioritize useful information under truncation

### Later commit — Codex usage status segment

Files:

- `extensions/statusline.ts`
- `extensions/codex-usage.ts`

Changes:

- add cached Codex quota state
- render compact statusline segment without blocking
- add `/codex-usage refresh` for forced refresh

## Current symlink state

The current goal is for production-ready extensions to live in this repository and be symlinked back into `~/.pi/agent/extensions/` for pi auto-discovery.

After import, `~/.pi/agent/extensions/statusline.ts` should point to:

```text
/Users/bharatsuri/Code/personal/pi-extensions/extensions/statusline.ts
```
