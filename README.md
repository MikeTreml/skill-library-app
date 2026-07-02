# Skill & Agent Library

## What it is

A Tauri 2 desktop app that consolidates the Claude and Codex skills and agents
scattered across your machine into one canonical, SQLite-backed library — then
helps you classify, de-duplicate, refactor, merge, tag, and deploy them back
out to their real locations.

The scanner discovers items in `~/.claude/{skills,agents}`,
`~/.claude/plugins/marketplaces`, `~/.codex/skills`, project
`.claude/{skills,agents}` folders, plus any custom directories you add. Each
item is copied into the library and content-hashed for drift detection.

Built with Tauri 2 (Rust core, vanilla-TypeScript frontend), SQLite via
`rusqlite` (bundled), and the OpenAI API (`gpt-4o-mini`) for AI features.

## Features

- **Dashboard** — landing screen with library health stats (totals, %
  classified, exact/near duplicate clusters, variants), the top duplicate
  clusters with jump-to-Triage, a recent-activity feed, a staleness section
  (items never marked used = candidates for deletion), and quick actions
  (Scan & Import, Classify, Go to Triage).
- **Browse** — the main library view with type (skill/agent), object-taxonomy,
  and tag filters. Multi-select opens a bulk action bar: **Merge → New**,
  **Merge → Delete** (merge then delete sources), **Classify**, **Refactor**,
  **Archive**, **Export…** (shareable `.tar.gz`), and **Delete**.
- **Triage** — duplicate clusters as reviewable cards plus an untriaged queue.
  Per cluster: merge all members or dismiss as not-a-duplicate (persisted, so
  dismissed clusters don't resurface). Keyboard-driven: `j`/`k` to move, `m`
  to merge, `d` to dismiss.
- **Deploy** — bird's-eye sync map with one card per tracked location
  (in-sync/drifted/missing counts), per-item diff/push/pull from the Browse
  detail pane, and a conflict inbox for 3-way conflicts (both sides changed
  since the last common sync) resolved with **Keep library** or
  **Keep deployed**.
- **AI features** (OpenAI `gpt-4o-mini`) — classify items into a canonical
  `Object › Sub — Verb · Qualifier` taxonomy, refactor/refine with directive
  checkboxes and diff review, and merge multiple items into one.
- **Verb-taxonomy governance** — a controlled vocabulary of 13 canonical verbs
  with an editable synonym map. Uncanonical verbs found on items are surfaced
  for one-click promotion: map to an existing canonical verb (as a synonym) or
  adopt as new canonical, then re-normalize matching items.
- **Tags** — user-defined tags orthogonal to the AI taxonomy, with a tag
  filter in the sidebar.
- **Usage tracking** — mark items as used; items never marked used appear in
  the Dashboard staleness section as candidates for deletion.
- **Settings** — in-app OpenAI API key storage (see below), with status
  display and clear/rotate.
- **First-run onboarding wizard** — guides initial setup (scan locations, API
  key, first scan) on first launch.
- **Activity log** — imports, classifies, merges, refactors, and syncs are
  recorded and shown in the Dashboard feed.
- **Soft-delete with restore** — deleting moves library copies to
  `_deleted_backups/` and tombstones the record so a re-scan won't
  re-import it; a Deleted view restores items. Source files at their real
  locations are never touched by delete.

## Getting started

Prerequisites: [Rust](https://rustup.rs), Node.js, and the
[Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```sh
npm install
npm run tauri dev        # run in development
npm run tauri build      # produce an installable build (.msi/.exe on Windows)
```

App data lives in the OS app-data dir under `com.miket.app/skill-library/`:
`catalog.db` (the index), `library/` (canonical copies), and the
`_refine_backups/`, `_sync_backups/`, `_deleted_backups/` recovery folders.
The catalog is a rebuildable index — if it is ever corrupted, delete it and
re-import.

> Close the app with the window ✕ or Ctrl+C — never force-kill it, as that can
> interrupt a SQLite checkpoint and corrupt the catalog.

## API key setup

AI features (Classify, Refactor, Merge) need an OpenAI API key. Two options:

1. **In-app (preferred)** — open **⚙ Settings** and save a key. It is stored
   locally in the app's database and takes effect immediately.
2. **Environment** — set `OPENAI_API_KEY` before launching. Used as a fallback
   when no key is stored in-app.

Without a key, AI actions are disabled; everything else works.

## Development

```sh
npm run build                                   # type-check + bundle the frontend
cargo test --manifest-path src-tauri/Cargo.toml # Rust backend tests
```

CI (`.github/workflows/ci.yml`) runs both on every push and pull request.

### Layout

- `src/` — frontend (`main.ts`, `api.ts`, `styles.css`)
- `src-tauri/` — Rust core: `commands.rs` (Tauri commands), `db.rs` (SQLite),
  `importer.rs`, `scanner.rs`, `ai.rs`, `dedup.rs`, `taxonomy.rs`, `model.rs`
- `docs/` — design specs and milestone plans (the
  [v3 redesign](docs/2026-06-21-skill-library-v3-redesign.md) is the best
  feature overview)
