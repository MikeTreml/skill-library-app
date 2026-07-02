import { dismissCluster as dismissClusterApi, type DupGroup, type Item } from "../api";
import { dupesEl, statusEl } from "../dom";
import { renderMain } from "../main";
import { S, itemById } from "../state";
import { esc } from "../util";
import { itemRow } from "./browse";
import { startMerge } from "./detail";
// ---------- triage (duplicate clusters + untriaged queue) ----------
// dismissedKeys is a client-side optimistic cache mirroring the durable
// `dismissed_clusters` DB table (see dismissCluster below and
// commands::dismiss_cluster) — the backend is now the source of truth and
// `list_duplicates` already filters dismissed clusters server-side, so this
// Set only smooths the UI between a click and the next `load()`.
export const dismissedKeys = new Set<string>();
export let triageIndex = 0;

export function visibleClusters(): DupGroup[] {
  const rank = { exact: 0, near: 1 } as const;
  return [...S.dupGroups]
    .filter((g) => !dismissedKeys.has(g.key))
    .sort((a, b) => rank[a.kind] - rank[b.kind] || b.item_ids.length - a.item_ids.length);
}

export function clusterCard(g: DupGroup, idx: number): string {
  const members = g.item_ids
    .map(itemById)
    .filter((x): x is Item => !!x)
    .map((it) => itemRow(it, { select: true }))
    .join("");
  return (
    `<div class="tri-card${idx === triageIndex ? " focused" : ""}" data-idx="${idx}" data-key="${esc(g.key)}">` +
    `<div class="dup-head"><span class="chip ${g.kind === "exact" ? "warn" : "verb"}">${g.kind}</span> <b>${esc(g.key)}</b> <span class="count">${g.item_ids.length} items</span>` +
    `<div class="tri-actions">` +
    `<button class="add-btn tri-merge" data-key="${esc(g.key)}" title="Select all members and open Merge → New">Merge all</button>` +
    `<button class="add-btn tri-dismiss" data-key="${esc(g.key)}" title="Not actually a duplicate — hide this cluster for this session">Dismiss</button>` +
    `</div></div>` +
    `<ul class="items">${members}</ul></div>`
  );
}

export function renderTriage() {
  const clusters = visibleClusters();
  const untriagedItems = S.allItems.filter((i) => !i.object);

  const clusterSection = !S.dupGroups.length
    ? `<p class="empty">No duplicates yet — run <b>Classify</b> first.</p>`
    : !clusters.length
      ? `<p class="empty">All clusters resolved or dismissed for this session. 🎉</p>`
      : `<div class="tri-hint">Keyboard: <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>m</kbd> merge all · <kbd>d</kbd> dismiss</div>` +
        `<div class="tri-board">${clusters.map((g, i) => clusterCard(g, i)).join("")}</div>`;

  const untriagedSection = untriagedItems.length
    ? `<h2 class="dash-h">Untriaged (${untriagedItems.length})</h2>` +
      `<p class="nav-note">No confident AI classification yet. Select and re-run Classify, or fix manually via Refactor.</p>` +
      `<ul class="items">${untriagedItems.map((it) => itemRow(it, { select: true })).join("")}</ul>`
    : "";

  dupesEl.innerHTML =
    `<h2 class="dash-h">Duplicate &amp; similar clusters (${clusters.length})</h2>${clusterSection}` +
    untriagedSection;

  for (const b of dupesEl.querySelectorAll<HTMLButtonElement>(".tri-merge"))
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      mergeCluster(b.dataset.key!);
    });
  for (const b of dupesEl.querySelectorAll<HTMLButtonElement>(".tri-dismiss"))
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      dismissCluster(b.dataset.key!);
    });
  statusEl.textContent = S.dupGroups.length
    ? `${clusters.length} of ${S.dupGroups.length} cluster(s) · ${untriagedItems.length} untriaged`
    : "";
}

export function mergeCluster(key: string) {
  const g = S.dupGroups.find((d) => d.key === key);
  if (!g) return;
  S.selection.clear();
  for (const id of g.item_ids) S.selection.add(id);
  renderMain();
  startMerge("create");
}

export function dismissCluster(key: string) {
  // Optimistic UI: hide immediately, then persist. `S.dupGroups` (the source list)
  // is also refreshed on next `load()` since the backend now filters dismissed
  // clusters out of `list_duplicates` itself — this local Set just avoids a
  // flash/round-trip before that refresh happens.
  dismissedKeys.add(key);
  const clusters = visibleClusters();
  if (triageIndex >= clusters.length) triageIndex = Math.max(0, clusters.length - 1);
  renderMain();
  dismissClusterApi(key).catch((e: unknown) => {
    statusEl.textContent = `Error persisting dismiss: ${e}`;
  });
}

export function onTriageKey(e: KeyboardEvent) {
  if (S.view !== "duplicates") return;
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return; // don't steal keys from search/text fields
  const clusters = visibleClusters();
  if (!clusters.length) return;
  if (e.key === "j") {
    triageIndex = Math.min(triageIndex + 1, clusters.length - 1);
    renderTriage();
    document.querySelector(".tri-card.focused")?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "k") {
    triageIndex = Math.max(triageIndex - 1, 0);
    renderTriage();
    document.querySelector(".tri-card.focused")?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "m") {
    mergeCluster(clusters[triageIndex].key);
  } else if (e.key === "d") {
    dismissCluster(clusters[triageIndex].key);
  }
}
document.addEventListener("keydown", onTriageKey);

