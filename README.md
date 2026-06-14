# pi-extensions

Personal pi extensions, kept in source control and symlinked into `~/.pi/agent/extensions/` for hot reload.

## Extensions

- `extensions/statusline.ts` — Rosé Pine statusline with session, model, context, and git branch awareness.
- `extensions/context-explorer/` — `/context` overlay for inspecting prompt and session context usage.
- `extensions/codex-usage.ts` — `/codex-usage` command and tool for Codex usage inspection.
- `extensions/git-quick.ts` — `/git`, a focused TUI for working tree status and stash inspection.

## Git Quick

Run `/git` to open a compact git panel with two tabs:

- Status: one color-split list for staged, modified, untracked, deleted, and renamed files.
- Stash: a quick list of saved stash entries.

Keys: `h/l` switch tabs, `↑↓` or `j/k` scroll, `r` refreshes, `q` or `esc` closes.
