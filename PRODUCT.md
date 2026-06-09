# Product

## Register

product

## Users

Pi users and coding-agent power users who want polished, shareable extensions that improve day-to-day terminal workflow. The primary context is an active coding session where the interface must stay readable, information-dense, and calm without distracting from the work.

## Product Purpose

This repository is the public source of truth for high-quality pi extensions. The statusline extension gives users immediate session awareness: workspace, git state, model, thinking level, usage, context, tools, queue, and conversation progress. Success means the footer feels native, premium, fast, reliable, and useful enough that other pi users want to install it.

## Brand Personality

Calm, sharp, premium. Stylish and technical, with a Rosé Pine-inspired visual identity and Nerd Font glyphs as a deliberate requirement rather than an optional fallback.

## Anti-references

Avoid generic terminal clutter, mismatched theme behavior, fragile fallbacks, washed-out low-contrast text, noisy dashboards, and default-looking status bars. Do not dilute the identity with ASCII-only fallbacks or generic icon substitutes; Nerd Font support is expected.

## Design Principles

- Show the session state at a glance, prioritizing the few signals that change decisions.
- Feel crafted and composed, not like a dump of metrics.
- Preserve a calm premium tone even when showing warnings, dirty state, queue state, or high context usage.
- Keep the extension reliable under reloads, narrow terminals, worktrees, subdirectories, and partial usage data.
- Use Rosé Pine color semantics and Nerd Font glyphs as part of the product identity.

## Accessibility & Inclusion

Maintain readable contrast across Rosé Pine surfaces and semantic warning/error states. Keep line lengths bounded to terminal width. Avoid animation-dependent or rapidly changing affordances. Since Nerd Font glyphs are required, document the dependency clearly for users.
