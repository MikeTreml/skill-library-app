# Skill & Agent Library — v3 Redesign (UX reimagining)

_Date: 2026-06-21 · Builds on [v1 spec](2026-06-18-skill-library-app-design.md) and
[v2 design](2026-06-20-skill-library-v2-design.md). M1–M5 shipped (scan/import,
classify/dedup, refactor, merge/archive, sync). This doc does not change the
backend contracts — it reimagines the **frontend IA and layout** and proposes
**new features** on top of the existing Rust core._

## Why v3

M1–M5 delivered every planned capability, but the UI grew as a single 3-column
frame (sidebar filters / item list / detail pane) with features bolted on as
toggled sub-views (Duplicates, Archived, Deleted) inside that same frame. That
worked for a cataloguer. It doesn't scale to the actual job: **triaging and
cleaning a 2,000+ item library**, where the daily workflow is bulk review, not
single-item browsing. v3 reframes the app around that job.

## Design principles

1. **Dashboard-first, not list-first.** Landing screen answers "how messy is my
   library right now and what should I do next," not a raw item dump.
2. **Modes, not toggled views.** Browse / Triage / Merge / Refactor / Deploy are
   distinct workspaces, each laid out for its own task — not one cramped frame
   wearing five hats.
3. **Selection is a persistent cart.** A staging tray survives across modes —
   select in Browse, act in Merge — instead of a selection bar that resets when
   you navigate.
4. **Bulk is the default posture.** At this scale, single-item flows are the
   exception; batch review queues (triage cards, approve/reject after batch AI
   jobs) are the norm.
5. **Trust through visibility.** Every AI action and every write to a real
   location shows a diff, queues as a trackable job, and is undoable from a
   visible action log — not just a backup folder you have to know to go dig in.
6. **Command palette over menus.** `Cmd+K`: jump to any item, run any action,
   search by tool name — necessary once item count is in the thousands.

## New information architecture

```
Top bar:  ⌘K search/command   |   [Dashboard] [Browse] [Triage] [Merge] [Refactor] [Deploy] [Settings]
Body:     mode-specific workspace (layout owned by the mode, not shared chrome)
Dock:     🧺 staging tray (persistent across modes, collapsible)
              N selected · [Merge] [Refactor] [Deploy] [Archive] [Delete] [Clear]
```

This replaces the current `sidebar / items list / dupes panel / detail aside`
frame that's reused (and increasingly overloaded) for every view.

---

## Modes

### Dashboard (new)

Landing screen. Proactive, not passive.

- **Health strip**: total items · % classified · duplicate clusters · items
  drifted · items never synced · items unused/stale (see Data model additions).
- **Top duplicate clusters** (largest first), "Review" jumps into Triage
  pre-loaded with that cluster.
- **Recent activity feed** — imports, merges, refactors, syncs (new: currently
  no audit trail exists at all).
- **Quick actions** — Scan & Import, Classify N unclassified, Resolve N sync
  conflicts.

### Browse

Reworked version of today's library view.

- **Left rail**: facets — Object›Sub tree, type, status (in_sync / drifted /
  missing / untriaged / archived), *new facets*: tool usage (`Bash`,
  `mcp__*`, …), source location, last modified.
- **Center**: dense sortable/groupable table (name, object/verb/qualifier
  chips, type, status dot, source count, last synced) — card view stays
  available as a toggle for people who prefer it.
- **Right**: tabbed preview — Content / Sync status / History (new) / Variants.
- **Search bar doubles as the command palette** — matches name, description,
  tool names, verb, *and* surfaces actions ("merge duplicates of X").

### Triage (new — promotes Duplicates + Untriaged to a first-class mode)

The actual daily workflow at this scale.

- **Cluster board**: duplicate/near-duplicate clusters as swipe-through cards
  (email-triage style), each showing members side-by-side with diff
  highlighting — not a flat scrolling list.
2. One-click resolutions per cluster: **Merge all**, **Keep newest / keep
   richest** (heuristic auto-pick), **Dismiss as not a duplicate** (implemented:
   persisted via a `dismissed_clusters` table so Triage doesn't re-surface a
   dismissed cluster after an app restart — `commands::dismiss_cluster` /
   `list_duplicates` filters server-side).
- **Untriaged queue** lives here as another queue type: shows the AI's best
  guess + confidence per item so the user corrects rather than starts blind.
- Keyboard-driven: `j`/`k` move, `m` merge, `d` dismiss.

### Merge (elevated from a review screen to a workbench)

- **Left**: sources from the staging tray, reorderable, one markable primary.
- **Center**: N-way diff — what each source contributed, not just
  merged-vs-primary.
- **Right**: directive panel — merge strategy (union/dedupe/prefer-primary),
  format normalization, tool reconciliation (union of `allowed-tools` with
  add/remove checkboxes).
- **Bottom**: Re-merge (retry / different model), Edit manually, Save as new /
  Replace & archive sources — gated by a confirmation summary ("merges 3
  items, deletes 1 duplicate, keeps 1 new item").
- **Merge history log** — inspect past merges to answer "where did skill X go."

### Refactor

- Same directive-checkbox + diff pattern, but operates on the **staging tray
  batch**: queue one AI job across N items, then review results one-by-one in
  a lightweight approve/reject queue instead of a single-item modal loop.
- Live token/cost estimate before running a batch.

### Deploy (renamed from Sync — reframed as an outbound action)

- **Map view**: one card per location (Claude skills, Codex, per-project dirs,
  marketplaces) with in_sync/drifted/missing counts — bird's-eye instead of
  digging per item.
- **Conflict inbox** (new, closes a known v1 gap): dedicated queue for true
  conflicts (both sides changed since last common sync) with a proper 3-way
  diff and explicit resolution, instead of folding conflicts into per-item
  drift status.
- **Deploy plan**: batch preview — "push these 12 refactored items" reviewed
  and applied as one operation, not 12 individual clicks.
- **Export** (new): package selected items as a `.zip`/tarball to hand to
  another person or machine. Full multi-machine sync stays out of scope (per
  v1 non-goals); manual export/import is cheap and closes a real gap.

---

## New cross-cutting features

1. **Usage/staleness tracking** — ingest invocation signals if available
   (Claude Code/Codex logs), or a manual "mark as used" fallback, to power a
   "candidates for deletion" queue. Highest-leverage addition at this scale —
   nothing today tells you what's dead weight.
2. **In-app API key management** — settings panel to set/rotate
   `OPENAI_API_KEY` via OS keychain (flagged as an open question in v1, never
   closed) without editing env vars and restarting. Also model selection per
   action type (cost/quality tradeoff).
3. **Job queue / activity log** — every AI batch op (classify-all, batch
   refactor, batch merge) becomes a trackable background job: progress,
   cancel, persistent log. Replaces today's blocking "Merging…" status string.
4. **Undo stack** — surface the existing `_refine_backups/` / `_sync_backups/`
   / `_deleted_backups/` folders as a visible "last 20 actions" list with
   one-click undo, instead of requiring users to know to dig into a folder.
5. **Tags/favorites** — user-defined tags orthogonal to the AI taxonomy (e.g.
   "core", "experimental", "client-x-only").
6. **Verb taxonomy governance UI** — surface AI-flagged "uncanonical" verbs in
   one place with one-click "promote to canonical," instead of editing the
   synonym table blind.
7. **Onboarding wizard** — first-run flow: pick scan locations (sensible
   defaults pre-checked), set API key, run first scan+classify.
8. **Command palette (`Cmd+K`)** — jump to any item, run any action, search by
   tool name. Single highest-impact addition regardless of how the rest of the
   layout evolves.

## Data model additions (backend)

- **`activity_log`** — `id, kind (import|classify|refactor|merge|sync|archive|delete), item_ids, summary, created_at` — powers Dashboard feed + undo stack surfacing.
- **`dismissed_pairs`** — `id, item_id_a, item_id_b, created_at` — Triage "dismiss as not duplicate" feedback, excluded from future `dedup.rs` grouping.
- **`usage_signal`** — `id, item_id, source (log|manual), last_used_at` — optional/best-effort, powers staleness.
- **`tags`** / **`item_tags`** — simple many-to-many, independent of `taxonomy`.
- **`jobs`** — `id, kind, status (queued|running|done|error), progress, total, created_at, finished_at` — backs the job queue UI for batch classify/refactor/merge.

None of these require touching the existing `items`/`locations`/`placements`/`variants`/`taxonomy` tables or their derivation logic — additive only.

## Phased build order

1. **Shell rework** — top-bar mode switcher + persistent staging tray, replacing the current sidebar/list/detail frame. No new backend yet; re-skins existing views into Dashboard-lite/Browse/Triage/Merge/Refactor/Deploy.
2. **Dashboard + activity_log** — health strip, recent activity, quick actions. Small new table, read-only.
3. **Triage mode + dismissed_pairs** — cluster-card UI, dismiss feedback loop wired into `dedup.rs`.
4. **Job queue** — generalize existing async import pattern to cover classify/refactor/merge batches; add `jobs` table + progress UI.
5. **Command palette** — client-side search index over items + a static action registry.
6. **Deploy mode + conflict inbox** — closes the v1 conflict-detection gap with a real "last common sync point" hash per placement.
7. **Settings: API key + model picker** — OS keychain integration.
8. **Usage tracking + tags** — lowest priority, highest effort-to-signal-quality ratio; ship after the above prove out.

Each phase is independently shippable and testable, matching the discipline of the v1/v2 milestone docs.

## Open questions

- **Usage signal source**: is there an accessible invocation log from Claude
  Code/Codex, or does this stay manual-only (lower value, but zero-dependency)?
- **Command palette scope**: client-side fuzzy search is enough at ~2–3k
  items; revisit if the library grows an order of magnitude.
- **Conflict "last common sync point"**: needs a stored hash per placement at
  time of last successful sync — a small schema addition to `placements`,
  deferred in v1; should land with the Deploy mode conflict inbox (phase 6).
