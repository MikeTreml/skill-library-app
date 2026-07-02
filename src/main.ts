import {
  addScanDir,
  addSynonym,
  addItemTag,
  aiAvailable,
  apiKeyStatus,
  setApiKey,
  applyRefinement,
  applyRefinementAsNew,
  archiveItem,
  cancelImport,
  classifyAll,
  deleteItems,
  deployStatus,
  exportItems,
  isOnboarded,
  setOnboarded,
  markUsed,
  dismissCluster as dismissClusterApi,
  getItemContent,
  itemSync,
  listArchived,
  listDeleted,
  listDuplicates,
  listItems,
  listItemTags,
  listAllTags,
  listUncanonicalVerbs,
  canonicalVerbs,
  recentActivity,
  listScanDirs,
  listVerbMap,
  mergeItems,
  pullFromLocation,
  pushToLocation,
  listConflicts,
  pushAllToLocation,
  hasRefineBackup,
  revertRefine,
  readPlacement,
  refineItem,
  removeScanDir,
  removeSynonym,
  removeItemTag,
  renormalizeVerbs,
  restoreDeleted,
  runImport,
  saveMerge,
  type DupGroup,
  type Item,
  type ItemType,
  type MergeResult,
  type RefineResult,
} from "./api";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { esc, fuzzyScore } from "./util";
import {
  searchEl,
  importBtn,
  cancelBtn,
  classifyBtn,
  statusEl,
  modebarEl,
  selbarEl,
  dashboardEl,
  deployEl,
  listEl,
  dupesEl,
  filtersEl,
  sourcesEl,
  verbmapEl,
  emptyEl,
  detailEl,
  paletteBtn,
  paletteEl,
  paletteInputEl,
  paletteResultsEl,
} from "./dom";
import { S, itemById, type View, type TypeFilter } from "./state";

const DIRECTIVES = [
  "Generalize: open it beyond a single tool or topic to broader options",
  "Specialize: narrow and sharpen its focus",
  "Tighten guardrails: add validation, error handling, and safety boundaries",
  "Clarify the trigger/description so it activates at the right time",
  "Add concrete examples",
  "Tighten the prose; remove redundancy",
  "Modernize: update to current best practices and APIs",
];
const TOOLS = [
  "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep", "LSP", "Bash",
  "PowerShell", "Monitor", "WebFetch", "WebSearch", "Agent", "Skill",
];


// ---------- top-bar mode switcher ----------
async function openSettings() {
  detailEl.hidden = false;
  detailEl.innerHTML =
    `<div class="detail-head"><div class="detail-title"><b>⚙ Settings</b></div><button id="set-x" class="src-rm" title="Close">✕</button></div>` +
    `<div class="rf-head">OpenAI API key</div>` +
    `<p class="nav-note" id="set-status">Loading…</p>` +
    `<div class="add-row"><input id="set-key" class="dir-input" type="password" placeholder="sk-…" /></div>` +
    `<div class="add-row"><button id="set-save" class="primary">Save key</button>` +
    `<button id="set-clear" class="add-btn">Clear stored key</button></div>` +
    `<p class="nav-note">The key is stored locally in this app's database and used for Classify, Merge, and Refactor. ` +
    `An <code>OPENAI_API_KEY</code> environment variable is used as a fallback when no key is stored here.</p>`;
  document.getElementById("set-x")!.addEventListener("click", closeDetail);
  const st = document.getElementById("set-status")!;
  const refreshStatus = async () => {
    try {
      const [stored, env] = await apiKeyStatus();
      st.textContent = stored
        ? "✓ A key is stored in-app (active)."
        : env
          ? "Using OPENAI_API_KEY from the environment. Save a key here to override it."
          : "⚠ No key set. AI features are disabled until you add one.";
    } catch (e) {
      st.textContent = `Error: ${e}`;
    }
  };
  await refreshStatus();
  document.getElementById("set-save")!.addEventListener("click", async () => {
    const key = (document.getElementById("set-key") as HTMLInputElement).value.trim();
    if (!key) {
      st.textContent = "Enter a key first (or use Clear stored key).";
      return;
    }
    try {
      await setApiKey(key);
      (document.getElementById("set-key") as HTMLInputElement).value = "";
      S.aiOk = await aiAvailable();
      await refreshStatus();
      statusEl.textContent = "API key saved.";
    } catch (e) {
      st.textContent = `Error: ${e}`;
    }
  });
  document.getElementById("set-clear")!.addEventListener("click", async () => {
    try {
      await setApiKey("");
      S.aiOk = await aiAvailable();
      await refreshStatus();
      statusEl.textContent = "Stored API key cleared.";
    } catch (e) {
      st.textContent = `Error: ${e}`;
    }
  });
}

function renderModebar() {
  const btn = (v: View, label: string, n?: number) =>
    `<button class="mode${S.view === v ? " active" : ""}" data-view="${v}"><span>${label}</span>${n !== undefined ? `<span class="count">${n}</span>` : ""}</button>`;
  modebarEl.innerHTML =
    btn("dashboard", "Dashboard") +
    btn("library", "Browse") +
    btn("duplicates", "Triage", S.dupGroups.length) +
    btn("deploy", "Deploy") +
    btn("archived", "Archived", S.archivedItems.length) +
    btn("deleted", "Deleted", S.deletedItems.length) +
    `<button class="mode" id="mode-settings" title="Settings"><span>⚙ Settings</span></button>`;
  for (const b of modebarEl.querySelectorAll<HTMLButtonElement>("[data-view]"))
    b.addEventListener("click", () => goToView(b.dataset.view as View));
  document.getElementById("mode-settings")!.addEventListener("click", openSettings);
}

function goToView(v: View) {
  S.view = v;
  renderModebar();
  renderFilters();
  renderMain();
}

// ---------- sidebar ----------
function renderFilters() {
  const typeCount = (t: TypeFilter) =>
    t === "all" ? S.allItems.length : S.allItems.filter((i) => i.item_type === t).length;
  const typeBtn = (t: TypeFilter, label: string) =>
    `<button class="nav${S.typeFilter === t ? " active" : ""}" data-type="${t}"><span>${label}</span><span class="count">${typeCount(t)}</span></button>`;

  const objects = new Map<string, number>();
  let untriaged = 0;
  for (const it of S.allItems) {
    if (it.object) objects.set(it.object, (objects.get(it.object) ?? 0) + 1);
    else untriaged++;
  }
  const objBtn = (key: string | null, label: string, n: number) =>
    `<button class="nav sub${S.objectFilter === key && S.view === "library" ? " active" : ""}" data-object="${esc(key ?? "")}"><span>${esc(label)}</span><span class="count">${n}</span></button>`;
  let tree: string;
  if (objects.size || untriaged) {
    tree =
      `<details class="nav-tree" id="obj-tree"${S.objectsTreeOpen ? " open" : ""}>` +
      `<summary class="nav-head">Objects</summary>` +
      objBtn(null, "All objects", S.allItems.length) +
      [...objects.entries()].sort((a, b) => b[1] - a[1]).map(([o, n]) => objBtn(o, o, n)).join("") +
      (untriaged ? objBtn("__none__", "Untriaged", untriaged) : "") +
      `</details>`;
  } else {
    tree = `<div class="nav-note">Run <b>Classify</b> to group by Object.</div>`;
  }

  const tagBtn = (key: string | null, label: string, n: number) =>
    `<button class="nav sub${S.tagFilter === key ? " active" : ""}" data-tag="${esc(key ?? "")}"><span>${esc(label)}</span><span class="count">${n}</span></button>`;
  const tagBlock = S.allTags.length
    ? `<details class="nav-tree" open><summary class="nav-head">Tags</summary>` +
      tagBtn(null, "All (clear tag)", S.allItems.length) +
      S.allTags.map(([t, n]) => tagBtn(t, `#${t}`, n)).join("") +
      `</details>`
    : "";

  filtersEl.innerHTML =
    `<div class="nav-group">${typeBtn("all", "All")}${typeBtn("skill", "Skills")}${typeBtn("agent", "Agents")}</div>` +
    `<div class="nav-group">${tree}</div>` +
    (tagBlock ? `<div class="nav-group">${tagBlock}</div>` : "");

  for (const b of filtersEl.querySelectorAll<HTMLButtonElement>("[data-type]"))
    b.addEventListener("click", () => {
      S.typeFilter = b.dataset.type as TypeFilter;
      S.cursorIdx = 0;
      renderFilters();
      renderMain();
    });
  for (const b of filtersEl.querySelectorAll<HTMLButtonElement>("[data-object]"))
    b.addEventListener("click", () => {
      S.objectFilter = b.dataset.object === "" ? null : b.dataset.object!;
      S.cursorIdx = 0;
      goToView("library");
    });
  for (const b of filtersEl.querySelectorAll<HTMLButtonElement>("[data-tag]"))
    b.addEventListener("click", () => {
      S.tagFilter = b.dataset.tag === "" ? null : b.dataset.tag!;
      S.cursorIdx = 0;
      goToView("library");
    });
  const objTree = document.getElementById("obj-tree") as HTMLDetailsElement | null;
  if (objTree) objTree.addEventListener("toggle", () => (S.objectsTreeOpen = objTree.open));
}

function renderSources() {
  const rows = S.scanDirs
    .map(
      (d) =>
        `<li class="src-item"><span class="badge ${d.item_type}">${d.item_type}</span><span class="src-path" title="${esc(d.path)}">${esc(d.path)}</span><button class="src-rm" data-id="${d.id}" title="Remove">✕</button></li>`,
    )
    .join("");
  sourcesEl.innerHTML =
    `<h3>Custom sources</h3><input id="dir-input" class="dir-input" placeholder="C:\\path\\to\\folder" />` +
    `<div class="add-row"><button id="dir-browse" class="add-btn">📁 Browse…</button></div>` +
    `<div class="add-row"><button id="add-agents" class="add-btn">+ Agents dir</button><button id="add-skills" class="add-btn">+ Skills dir</button></div>` +
    `<ul class="src-list">${rows}</ul>`;
  const input = document.getElementById("dir-input") as HTMLInputElement;
  document.getElementById("dir-browse")!.addEventListener("click", async () => {
    const picked = await open({ directory: true, title: "Pick a skills or agents folder" });
    if (typeof picked === "string") input.value = picked;
  });
  const add = async (t: ItemType) => {
    const path = input.value.trim();
    if (!path) return;
    try {
      await addScanDir(path, t);
      input.value = "";
      S.scanDirs = await listScanDirs();
      renderSources();
      statusEl.textContent = `Added ${t} source — click Scan & import`;
    } catch (e) {
      statusEl.textContent = `Error: ${e}`;
    }
  };
  document.getElementById("add-agents")!.addEventListener("click", () => add("agent"));
  document.getElementById("add-skills")!.addEventListener("click", () => add("skill"));
  for (const b of sourcesEl.querySelectorAll<HTMLButtonElement>(".src-rm"))
    b.addEventListener("click", async () => {
      await removeScanDir(Number(b.dataset.id));
      S.scanDirs = await listScanDirs();
      renderSources();
    });
}

function renderVerbMap() {
  const byCanon = new Map<string, string[]>();
  for (const [canon, syn] of S.verbMap) {
    if (!byCanon.has(canon)) byCanon.set(canon, []);
    byCanon.get(canon)!.push(syn);
  }
  const rows = [...byCanon.entries()]
    .sort()
    .map(
      ([canon, syns]) =>
        `<div class="verb-row"><b>${esc(canon)}</b> ` +
        syns.map((s) => `<span class="vchip">${esc(s)}<button class="vrm" data-syn="${esc(s)}">✕</button></span>`).join(" ") +
        `</div>`,
    )
    .join("");
  const promoteOptions = S.canonVerbList.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  const govRows = S.uncanonicalVerbs.length
    ? S.uncanonicalVerbs
        .map(
          ([v, n]) =>
            `<div class="verb-row gov-row"><span class="chip warn">${esc(v)}</span> <span class="count">${n}</span> ` +
            `<select class="gov-sel dir-input" data-verb="${esc(v)}"><option value="">promote to…</option>${promoteOptions}<option value="__self__">＋ adopt as canonical</option></select></div>`,
        )
        .join("")
    : `<div class="nav-note">No uncanonical verbs — all classified verbs are canonical. ✓</div>`;
  const govBlock =
    `<details class="gov-details"><summary>Uncanonical verbs (${S.uncanonicalVerbs.length})</summary>` +
    `<div class="nav-note">Verbs on items outside the 13 canonical set. Promote maps the verb (as a synonym) then re-normalizes matching items.</div>` +
    `<div class="verb-list">${govRows}</div></details>`;

  verbmapEl.innerHTML =
    `<details><summary>Verb map (${S.verbMap.length})</summary><div class="verb-list">${rows}</div>` +
    `<div class="add-row"><input id="vc" class="dir-input" placeholder="Canonical" /><input id="vs" class="dir-input" placeholder="synonym" /></div>` +
    `<div class="add-row"><button id="vadd" class="add-btn">+ Add synonym</button>` +
    `<button id="vrenorm" class="add-btn" title="Re-map existing items through this verb map">Re-normalize items</button></div>` +
    govBlock +
    `</details>`;
  document.getElementById("vadd")!.addEventListener("click", async () => {
    const c = (document.getElementById("vc") as HTMLInputElement).value.trim();
    const s = (document.getElementById("vs") as HTMLInputElement).value.trim();
    if (!c || !s) return;
    await addSynonym(c, s);
    S.verbMap = await listVerbMap();
    renderVerbMap();
  });
  document.getElementById("vrenorm")!.addEventListener("click", async () => {
    try {
      const n = await renormalizeVerbs();
      await load();
      statusEl.textContent = `Re-normalized ${n} item verb(s) through the verb map.`;
    } catch (e) {
      statusEl.textContent = `Error: ${e}`;
    }
  });
  for (const b of verbmapEl.querySelectorAll<HTMLButtonElement>(".vrm"))
    b.addEventListener("click", async () => {
      await removeSynonym(b.dataset.syn!);
      S.verbMap = await listVerbMap();
      renderVerbMap();
    });
  // Promote an uncanonical verb: map it (as a synonym) to a canonical verb, or
  // adopt it as its own canonical, then re-normalize matching items.
  for (const sel of verbmapEl.querySelectorAll<HTMLSelectElement>(".gov-sel"))
    sel.addEventListener("change", async () => {
      const verb = sel.dataset.verb!;
      const choice = sel.value;
      if (!choice) return;
      const canonical = choice === "__self__" ? verb : choice;
      try {
        await addSynonym(canonical, verb);
        const n = await renormalizeVerbs();
        await load();
        statusEl.textContent = `Promoted "${verb}" → ${canonical}; re-normalized ${n} item verb(s).`;
      } catch (e) {
        statusEl.textContent = `Error: ${e}`;
      }
    });
}

// ---------- rows + content ----------
function chips(it: Item): string {
  const c: string[] = [];
  if (it.object) c.push(`<span class="chip obj">${esc(it.object)}${it.sub_object ? " › " + esc(it.sub_object) : ""}</span>`);
  if (it.verb) c.push(`<span class="chip verb">${esc(it.verb)}</span>`);
  if (it.qualifier) c.push(`<span class="chip qual">${esc(it.qualifier)}</span>`);
  if (it.has_variants) c.push(`<span class="chip warn">⚠ variants</span>`);
  return c.join("");
}

function itemRow(
  it: Item,
  opts: { select?: boolean; restore?: "archive" | "delete"; cursor?: boolean } = {},
): string {
  const cb = opts.select
    ? `<input type="checkbox" class="sel" data-id="${it.id}"${S.selection.has(it.id) ? " checked" : ""} />`
    : "";
  const restore = opts.restore
    ? `<button class="restore" data-id="${it.id}" data-kind="${opts.restore}">Restore</button>`
    : "";
  return (
    `<li class="item${it.id === S.selectedId ? " active" : ""}${opts.cursor ? " cursor" : ""}" data-id="${it.id}">${cb}` +
    `<span class="badge ${it.item_type}">${it.item_type}</span><span class="name">${esc(it.name)}</span>${chips(it)}` +
    `<span class="desc">${esc(it.description)}</span>${restore}</li>`
  );
}

function visibleItems(): Item[] {
  const q = S.query.trim().toLowerCase();
  return S.allItems.filter((it) => {
    if (S.typeFilter !== "all" && it.item_type !== S.typeFilter) return false;
    if (S.objectFilter === "__none__" && it.object) return false;
    if (S.objectFilter && S.objectFilter !== "__none__" && it.object !== S.objectFilter) return false;
    if (S.tagFilter && !(S.itemTagsMap.get(it.id) ?? []).includes(S.tagFilter)) return false;
    if (!q) return true;
    return it.name.toLowerCase().includes(q) || it.description.toLowerCase().includes(q);
  });
}

function renderSelbar() {
  const n = S.selection.size;
  // The selection bar (merge/delete/etc.) is available wherever items have
  // checkboxes: the Library list and the Duplicates groups.
  if (n === 0 || (S.view !== "library" && S.view !== "duplicates")) {
    selbarEl.hidden = true;
    selbarEl.innerHTML = "";
    return;
  }
  selbarEl.hidden = false;
  const dis = n < 2 ? " disabled" : "";
  selbarEl.innerHTML =
    `<span>${n} selected</span>` +
    `<button id="mc" class="add-btn"${dis} title="AI-merge into a new item; keep the sources">Merge → New</button>` +
    `<button id="md" class="add-btn"${dis} title="AI-merge into a new item, then delete the sources">Merge → Delete</button>` +
    `<button id="clsel" class="add-btn">Classify</button>` +
    `<button id="rfsel" class="add-btn" title="AI-refactor all selected, then review one by one">Refactor</button>` +
    `<button id="arch" class="add-btn">Archive</button>` +
    `<button id="exp" class="add-btn" title="Export selected items as a shareable .tar.gz">Export…</button>` +
    `<button id="del" class="add-btn danger" title="Remove (recoverable from the Deleted view)">Delete</button>` +
    `<button id="clr" class="add-btn">Clear</button>`;
  document.getElementById("mc")!.addEventListener("click", () => startMerge("create"));
  document.getElementById("md")!.addEventListener("click", () => startMerge("delete"));
  document.getElementById("clsel")!.addEventListener("click", classifySelected);
  document.getElementById("rfsel")!.addEventListener("click", startBatchRefine);
  document.getElementById("arch")!.addEventListener("click", archiveSelected);
  document.getElementById("exp")!.addEventListener("click", exportSelected);
  document.getElementById("del")!.addEventListener("click", deleteSelected);
  document.getElementById("clr")!.addEventListener("click", () => {
    S.selection.clear();
    renderMain();
  });
}

function renderList() {
  const items = visibleItems();
  if (S.cursorIdx > items.length - 1) S.cursorIdx = Math.max(0, items.length - 1);
  listEl.innerHTML = items.map((it, i) => itemRow(it, { select: true, cursor: i === S.cursorIdx })).join("");
  emptyEl.hidden = S.allItems.length > 0;
  statusEl.textContent = S.allItems.length ? `${items.length} of ${S.allItems.length} items` : "";
}

// ---------- triage (duplicate clusters + untriaged queue) ----------
// dismissedKeys is a client-side optimistic cache mirroring the durable
// `dismissed_clusters` DB table (see dismissCluster below and
// commands::dismiss_cluster) — the backend is now the source of truth and
// `list_duplicates` already filters dismissed clusters server-side, so this
// Set only smooths the UI between a click and the next `load()`.
const dismissedKeys = new Set<string>();
let triageIndex = 0;

function visibleClusters(): DupGroup[] {
  const rank = { exact: 0, near: 1 } as const;
  return [...S.dupGroups]
    .filter((g) => !dismissedKeys.has(g.key))
    .sort((a, b) => rank[a.kind] - rank[b.kind] || b.item_ids.length - a.item_ids.length);
}

function clusterCard(g: DupGroup, idx: number): string {
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

function renderTriage() {
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

function mergeCluster(key: string) {
  const g = S.dupGroups.find((d) => d.key === key);
  if (!g) return;
  S.selection.clear();
  for (const id of g.item_ids) S.selection.add(id);
  renderMain();
  startMerge("create");
}

function dismissCluster(key: string) {
  // Optimistic UI: hide immediately, then persist. `S.dupGroups` (the source list)
  // is also refreshed on next `load()` since the backend now filters dismissed
  // clusters out of `list_duplicates` itself — this local Set just avoids a
  // flash/round-trip before that refresh happens.
  dismissedKeys.add(key);
  const clusters = visibleClusters();
  if (triageIndex >= clusters.length) triageIndex = Math.max(0, clusters.length - 1);
  renderMain();
  dismissClusterApi(key).catch((e) => {
    statusEl.textContent = `Error persisting dismiss: ${e}`;
  });
}

function onTriageKey(e: KeyboardEvent) {
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

// ---------- Browse keyboard navigation (j/k/arrows + Space select + Enter open) ----------
function onBrowseKey(e: KeyboardEvent) {
  if (S.view !== "library" || !paletteEl.hidden) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return; // don't shadow shortcuts like Ctrl+K
  // Don't steal keys from the search box, modal/detail inputs, or dropdowns.
  const tag = (document.activeElement as HTMLElement | null)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  const items = visibleItems();
  if (!items.length) return;
  if (e.key === "j" || e.key === "ArrowDown") {
    e.preventDefault();
    S.cursorIdx = Math.min(S.cursorIdx + 1, items.length - 1);
    renderList();
    listEl.querySelector(".item.cursor")?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "k" || e.key === "ArrowUp") {
    e.preventDefault();
    S.cursorIdx = Math.max(S.cursorIdx - 1, 0);
    renderList();
    listEl.querySelector(".item.cursor")?.scrollIntoView({ block: "nearest" });
  } else if (e.key === " ") {
    e.preventDefault();
    const it = items[S.cursorIdx];
    if (!it) return;
    if (S.selection.has(it.id)) S.selection.delete(it.id);
    else S.selection.add(it.id);
    renderList();
    renderSelbar();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const it = items[S.cursorIdx];
    if (it) openDetail(it.id);
  }
}
document.addEventListener("keydown", onBrowseKey);

function renderArchived() {
  dupesEl.innerHTML = S.archivedItems.length
    ? `<ul class="items">${S.archivedItems.map((it) => itemRow(it, { restore: "archive" })).join("")}</ul>`
    : `<p class="empty">No archived items.</p>`;
  statusEl.textContent = `${S.archivedItems.length} archived`;
}

function renderDeleted() {
  dupesEl.innerHTML = S.deletedItems.length
    ? `<p class="nav-note">Deleted items are kept out of re-import. Restore moves the copy back.</p>` +
      `<ul class="items">${S.deletedItems.map((it) => itemRow(it, { restore: "delete" })).join("")}</ul>`
    : `<p class="empty">No deleted items.</p>`;
  statusEl.textContent = `${S.deletedItems.length} deleted`;
}

// ---------- dashboard ----------
function statCard(label: string, value: string | number, tone?: "warn" | "ok" | "danger"): string {
  return `<div class="stat-card${tone ? " " + tone : ""}"><div class="stat-value">${esc(String(value))}</div><div class="stat-label">${esc(label)}</div></div>`;
}

function renderDashboard() {
  const total = S.allItems.length;
  const classified = S.allItems.filter((i) => i.object).length;
  const pct = total ? Math.round((classified / total) * 100) : 0;
  const exact = S.dupGroups.filter((g) => g.kind === "exact").length;
  const near = S.dupGroups.filter((g) => g.kind === "near").length;
  const untriaged = total - classified;
  const variants = S.allItems.filter((i) => i.has_variants).length;

  const strip =
    `<div class="stat-row">` +
    statCard("Total items", total) +
    statCard("Classified", `${pct}%`, pct < 50 ? "warn" : "ok") +
    statCard("Duplicate clusters", exact + near, exact + near ? "warn" : "ok") +
    statCard("Untriaged", untriaged, untriaged ? "warn" : "ok") +
    statCard("Flagged variants", variants, variants ? "warn" : "ok") +
    `</div>`;

  const topClusters = [...S.dupGroups]
    .sort((a, b) => b.item_ids.length - a.item_ids.length)
    .slice(0, 5);
  const clusterRows = topClusters.length
    ? topClusters
        .map(
          (g) =>
            `<li class="dash-cluster" data-key="${esc(g.key)}"><span class="chip ${g.kind === "exact" ? "warn" : "verb"}">${g.kind}</span> ` +
            `<b>${esc(g.key)}</b> <span class="count">${g.item_ids.length} items</span> ` +
            `<button class="add-btn dash-review" data-key="${esc(g.key)}">Review →</button></li>`,
        )
        .join("")
    : `<li class="nav-note">No duplicate clusters yet — run Classify, then check Triage.</li>`;

  const actions =
    `<div class="add-row">` +
    `<button id="dash-import" class="add-btn">⟳ Scan &amp; import</button>` +
    `<button id="dash-classify" class="add-btn"${S.aiOk ? "" : " disabled"}>✦ Classify ${untriaged ? `(${untriaged})` : ""}</button>` +
    `<button id="dash-triage" class="add-btn">Go to Triage (${S.dupGroups.length})</button>` +
    `</div>`;

  const activityHtml = S.activityFeed.length
    ? `<ul class="dash-list">` +
      S.activityFeed
        .map(
          ([, kind, summary, at]) =>
            `<li class="dash-cluster"><span class="chip verb">${esc(kind)}</span> ` +
            `<b>${esc(summary)}</b> <span class="count">${esc(at)}</span></li>`,
        )
        .join("") +
      `</ul>`
    : `<p class="nav-note">No activity yet.</p>`;

  const staleCount = S.allItems.filter((i) => i.use_count === 0 && !i.archived).length;
  const staleHtml = staleCount
    ? `<p class="nav-note">${staleCount} item(s) have never been marked used — <b>candidates for deletion</b>. ` +
      `Open an item and click ✓ to mark it used, or use them from the Browse list.</p>`
    : `<p class="nav-note">Every item has been marked used at least once. ✓</p>`;

  dashboardEl.innerHTML =
    `<h2 class="dash-h">Library health</h2>${strip}` +
    `<h2 class="dash-h">Top duplicate clusters</h2><ul class="dash-list">${clusterRows}</ul>` +
    `<h2 class="dash-h">Recent activity</h2>${activityHtml}` +
    `<h2 class="dash-h">Staleness</h2>${staleHtml}` +
    `<h2 class="dash-h">Quick actions</h2>${actions}`;

  document.getElementById("dash-import")!.addEventListener("click", () => importBtn.click());
  document.getElementById("dash-classify")!.addEventListener("click", () => classifyBtn.click());
  document.getElementById("dash-triage")!.addEventListener("click", () => goToView("duplicates"));
  for (const b of dashboardEl.querySelectorAll<HTMLButtonElement>(".dash-review"))
    b.addEventListener("click", () => goToView("duplicates"));
}

// ---------- deploy (per-location map view) ----------
async function renderDeploy() {
  deployEl.innerHTML = `<h2 class="dash-h">Deploy — locations</h2><p class="nav-note">Loading…</p>`;
  try {
    S.deployStatuses = await deployStatus();
  } catch (e) {
    deployEl.innerHTML = `<h2 class="dash-h">Deploy — locations</h2><p class="nav-note">Error: ${esc(String(e))}</p>`;
    return;
  }
  if (!S.deployStatuses.length) {
    deployEl.innerHTML =
      `<h2 class="dash-h">Deploy — locations</h2>` +
      `<p class="empty">No tracked locations yet — run <b>Scan &amp; import</b> first.</p>`;
    return;
  }
  const cards = S.deployStatuses
    .map((l) => {
      const healthy = l.drifted === 0 && l.missing === 0;
      return (
        `<div class="deploy-card${healthy ? "" : " warn"}">` +
        `<div class="deploy-card-head"><b>${esc(l.label)}</b><span class="pal-hint">${esc(l.root_path)}</span></div>` +
        `<div class="deploy-stats">` +
        `<span class="dstat ok">${l.in_sync} in sync</span>` +
        `<span class="dstat warn">${l.drifted} drifted</span>` +
        `<span class="dstat danger">${l.missing} missing</span>` +
        `<span class="dstat">${l.total} total</span>` +
        `</div>` +
        (healthy
          ? ""
          : `<button class="add-btn push-all" data-loc="${l.location_id}" title="Push library versions to every drifted/missing placement here (3-way conflicts are skipped)">Push all →</button>`) +
        `</div>`
      );
    })
    .join("");
  let conflicts: Awaited<ReturnType<typeof listConflicts>> = [];
  try {
    conflicts = await listConflicts();
  } catch {
    conflicts = [];
  }
  const conflictSection = conflicts.length
    ? `<h2 class="dash-h">⚠ Conflict inbox (${conflicts.length})</h2>` +
      `<p class="nav-note">Both the library copy and the deployed copy changed since the last sync. Choose which side wins for each — there's no safe automatic merge.</p>` +
      `<ul class="dash-list">` +
      conflicts
        .map(
          (c) =>
            `<li class="dash-cluster conflict-row"><b>${esc(c.item_name)}</b> ` +
            `<span class="chip warn">${esc(c.location_label)}</span> ` +
            `<span class="pal-hint">${esc(c.abs_path)}</span> ` +
            `<button class="add-btn cf-push" data-pid="${c.placement_id}" title="Overwrite the deployed copy with the library version">Keep library →</button>` +
            `<button class="add-btn cf-pull" data-pid="${c.placement_id}" title="Overwrite the library with the deployed version">← Keep deployed</button></li>`,
        )
        .join("") +
      `</ul>`
    : `<h2 class="dash-h">Conflict inbox</h2><p class="nav-note">No conflicts — every deployed copy can sync cleanly. ✓</p>`;

  deployEl.innerHTML =
    `<h2 class="dash-h">Deploy — locations (${S.deployStatuses.length})</h2>` +
    `<p class="nav-note">Bird's-eye sync status per tracked location. Open an item's detail pane (Browse) for the per-item diff/push/pull actions.</p>` +
    `<div class="deploy-grid">${cards}</div>` +
    conflictSection;
  const resolve = async (pid: number, keepLibrary: boolean) => {
    statusEl.textContent = "Resolving conflict…";
    try {
      if (keepLibrary) await pushToLocation(pid);
      else await pullFromLocation(pid);
      await load();
      renderDeploy();
      statusEl.textContent = keepLibrary ? "Kept library version." : "Kept deployed version.";
    } catch (e) {
      statusEl.textContent = `Error: ${e}`;
    }
  };
  for (const b of deployEl.querySelectorAll<HTMLButtonElement>(".cf-push"))
    b.addEventListener("click", () => resolve(Number(b.dataset.pid), true));
  for (const b of deployEl.querySelectorAll<HTMLButtonElement>(".cf-pull"))
    b.addEventListener("click", () => resolve(Number(b.dataset.pid), false));
  for (const b of deployEl.querySelectorAll<HTMLButtonElement>(".push-all"))
    b.addEventListener("click", async () => {
      b.disabled = true;
      statusEl.textContent = "Pushing all…";
      try {
        const [pushed, conflicts, ok] = await pushAllToLocation(Number(b.dataset.loc));
        await load();
        renderDeploy();
        statusEl.textContent =
          `Pushed ${pushed} item(s)` +
          (conflicts ? `, skipped ${conflicts} conflict(s) — resolve them below` : "") +
          (ok ? ` (${ok} already in sync)` : "") +
          ".";
      } catch (e) {
        b.disabled = false;
        statusEl.textContent = `Error: ${e}`;
      }
    });
}

function renderMain() {
  dashboardEl.hidden = S.view !== "dashboard";
  deployEl.hidden = S.view !== "deploy";
  listEl.hidden = S.view !== "library";
  dupesEl.hidden = S.view === "dashboard" || S.view === "library" || S.view === "deploy";
  emptyEl.hidden = true;
  if (S.view === "dashboard") renderDashboard();
  else if (S.view === "deploy") renderDeploy();
  else if (S.view === "library") renderList();
  else if (S.view === "duplicates") renderTriage();
  else if (S.view === "archived") renderArchived();
  else renderDeleted();
  renderSelbar();
}

// ---------- detail / preview ----------
function closeDetail() {
  S.selectedId = null;
  detailEl.hidden = true;
  detailEl.innerHTML = "";
  renderMain();
}

async function openDetail(id: number) {
  const it = itemById(id) ?? S.archivedItems.find((i) => i.id === id);
  if (!it) return;
  S.selectedId = id;
  renderMain();
  detailEl.hidden = false;
  detailEl.innerHTML =
    `<div class="detail-head"><div class="detail-title"><span class="badge ${it.item_type}">${it.item_type}</span><b>${esc(it.name)}</b></div>` +
    `<button id="detail-refine" class="rf-btn" title="Refactor & improve">✦</button>` +
    `<button id="detail-revert" class="rf-btn" title="Revert last refine (toggles between current and backed-up version)" hidden>↩</button>` +
    `<button id="detail-used" class="rf-btn" title="Mark as used (usage tracking)">✓</button>` +
    `<button id="detail-archive" class="rf-btn" title="Archive">🗄</button>` +
    `<button id="detail-close" class="src-rm" title="Close">✕</button></div>` +
    `<div class="detail-chips">${chips(it)}</div>` +
    (it.description ? `<p class="detail-desc">${esc(it.description)}</p>` : "") +
    `<div class="detail-path" title="${esc(it.library_path)}">${esc(it.library_path)}</div>` +
    `<div class="tag-panel" id="tag-panel"></div>` +
    `<div class="sync-panel" id="sync-panel"></div>` +
    `<pre class="detail-body">Loading…</pre>`;
  document.getElementById("detail-close")!.addEventListener("click", closeDetail);
  document.getElementById("detail-refine")!.addEventListener("click", () => openRefine(id));
  const revertBtn = document.getElementById("detail-revert") as HTMLButtonElement;
  hasRefineBackup(id)
    .then((has) => {
      revertBtn.hidden = !has;
    })
    .catch(() => {});
  revertBtn.addEventListener("click", async () => {
    if (!confirm("Revert to the version before the last refine? (You can toggle back.)")) return;
    try {
      await revertRefine(id);
      await load();
      openDetail(id); // re-render with restored content
      statusEl.textContent = "Reverted last refine.";
    } catch (e) {
      statusEl.textContent = `Error: ${e}`;
    }
  });
  document.getElementById("detail-used")!.addEventListener("click", async () => {
    try {
      await markUsed(id);
      await load();
      const it2 = itemById(id);
      statusEl.textContent = it2 ? `Marked used (${it2.use_count}× total).` : "Marked used.";
    } catch (e) {
      statusEl.textContent = `Error: ${e}`;
    }
  });
  document.getElementById("detail-archive")!.addEventListener("click", async () => {
    await archiveItem(id, true);
    closeDetail();
    await load();
    statusEl.textContent = "Archived.";
  });
  renderTagPanel(id);
  renderSyncPanel(id);
  const body = detailEl.querySelector(".detail-body")!;
  try {
    body.textContent = await getItemContent(id);
  } catch (e) {
    body.textContent = `Error: ${e}`;
  }
}

// ---------- tags (user-defined, orthogonal to AI taxonomy) ----------
function renderTagPanel(id: number) {
  const el = document.getElementById("tag-panel");
  if (!el) return;
  const tags = S.itemTagsMap.get(id) ?? [];
  const chipsHtml = tags.length
    ? tags
        .map(
          (t) =>
            `<span class="tag-chip">#${esc(t)}<button class="tag-rm" data-tag="${esc(t)}" title="Remove tag">✕</button></span>`,
        )
        .join(" ")
    : `<span class="nav-note">No tags yet.</span>`;
  el.innerHTML =
    `<div class="rf-head">Tags</div><div class="tag-list">${chipsHtml}</div>` +
    `<div class="add-row"><input id="tag-input" class="dir-input" placeholder="add a tag (e.g. core)" /><button id="tag-add" class="add-btn">+ Tag</button></div>`;
  const input = document.getElementById("tag-input") as HTMLInputElement;
  const doAdd = async () => {
    const t = input.value.trim();
    if (!t) return;
    try {
      await addItemTag(id, t);
      await load();
      if (S.selectedId === id) renderTagPanel(id);
      statusEl.textContent = `Tagged #${t.toLowerCase()}`;
    } catch (e) {
      statusEl.textContent = `Error: ${e}`;
    }
  };
  document.getElementById("tag-add")!.addEventListener("click", doAdd);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doAdd();
  });
  for (const b of el.querySelectorAll<HTMLButtonElement>(".tag-rm"))
    b.addEventListener("click", async () => {
      try {
        await removeItemTag(id, b.dataset.tag!);
        await load();
        if (S.selectedId === id) renderTagPanel(id);
      } catch (e) {
        statusEl.textContent = `Error: ${e}`;
      }
    });
}

// ---------- sync & deploy ----------
async function renderSyncPanel(id: number) {
  const el = document.getElementById("sync-panel");
  if (!el) return;
  try {
    const places = await itemSync(id);
    if (!places.length) {
      el.innerHTML = `<div class="rf-head">Locations &amp; sync</div><div class="nav-note">No tracked locations.</div>`;
      return;
    }
    el.innerHTML =
      `<div class="rf-head">Locations &amp; sync</div>` +
      places
        .map(
          (p) =>
            `<div class="sync-row"><span class="sdot ${p.status}"></span>` +
            `<span class="sync-label" title="${esc(p.abs_path)}">${esc(p.location_label)}</span>` +
            `<span class="sync-status">${p.status.replace("_", " ")}</span>` +
            `<button class="sbtn" data-act="diff" data-pid="${p.id}">Diff</button>` +
            `<button class="sbtn" data-act="push" data-pid="${p.id}">Push →</button>` +
            `<button class="sbtn" data-act="pull" data-pid="${p.id}">← Pull</button></div>`,
        )
        .join("");
    for (const b of el.querySelectorAll<HTMLButtonElement>(".sbtn"))
      b.addEventListener("click", () => onSyncAction(id, Number(b.dataset.pid), b.dataset.act!));
  } catch (e) {
    el.innerHTML = `<div class="nav-note">Sync error: ${esc(String(e))}</div>`;
  }
}

async function onSyncAction(id: number, pid: number, act: string) {
  try {
    if (act === "diff") {
      const [lib, loc] = await Promise.all([getItemContent(id), readPlacement(pid)]);
      detailEl.innerHTML =
        `<div class="detail-head"><div class="detail-title"><b>Library vs location</b></div><button id="sd-x" class="src-rm" title="Back">✕</button></div>` +
        `<div class="rf-head">Library (canonical)</div><pre class="detail-body">${esc(lib)}</pre>` +
        `<div class="rf-head">Location</div><pre class="detail-body dim">${esc(loc)}</pre>`;
      document.getElementById("sd-x")!.addEventListener("click", () => openDetail(id));
      return;
    }
    if (act === "push") {
      await pushToLocation(pid);
      statusEl.textContent = "Pushed library → location (original backed up).";
    } else if (act === "pull") {
      await pullFromLocation(pid);
      await load();
      statusEl.textContent = "Pulled location → library (original backed up).";
    }
    await renderSyncPanel(id);
  } catch (e) {
    statusEl.textContent = `Error: ${e}`;
  }
}

// ---------- refactor & improve ----------
function openRefine(id: number) {
  const it = itemById(id);
  if (!it) return;
  detailEl.hidden = false;
  detailEl.innerHTML =
    `<div class="detail-head"><div class="detail-title"><b>Refactor: ${esc(it.name)}</b></div><button id="rf-x" class="src-rm" title="Cancel">✕</button></div>` +
    `<div class="rf-head">Directives</div>` +
    DIRECTIVES.map((d, i) => `<label class="rf-chk"><input type="checkbox" data-dir="${i}" /> ${esc(d.split(":")[0])}</label>`).join("") +
    `<div class="rf-head">Tools — click to + add / − remove</div>` +
    `<div class="rf-tools">${TOOLS.map((t) => `<button class="rf-tool" data-tool="${t}" data-state="0">${t}</button>`).join("")}</div>` +
    `<div class="add-row"><button id="rf-run" class="primary">✦ Run refine</button></div><p id="rf-status" class="status"></p>`;
  document.getElementById("rf-x")!.addEventListener("click", () => openDetail(id));
  for (const b of detailEl.querySelectorAll<HTMLButtonElement>(".rf-tool"))
    b.addEventListener("click", () => {
      const s = (Number(b.dataset.state) + 1) % 3;
      b.dataset.state = String(s);
      b.className = "rf-tool" + (s === 1 ? " add" : s === 2 ? " remove" : "");
    });
  document.getElementById("rf-run")!.addEventListener("click", () => runRefine(id, it.name));
}

async function runRefine(id: number, name: string) {
  const rfStatus = document.getElementById("rf-status")!;
  if (!S.aiOk) {
    rfStatus.textContent = "Set a valid OPENAI_API_KEY (then restart) to refine.";
    return;
  }
  const dirs: string[] = [];
  for (const c of detailEl.querySelectorAll<HTMLInputElement>("input[data-dir]"))
    if (c.checked) dirs.push(DIRECTIVES[Number(c.dataset.dir)]);
  const toolsAdd: string[] = [];
  const toolsRemove: string[] = [];
  for (const b of detailEl.querySelectorAll<HTMLButtonElement>(".rf-tool")) {
    if (b.dataset.state === "1") toolsAdd.push(b.dataset.tool!);
    else if (b.dataset.state === "2") toolsRemove.push(b.dataset.tool!);
  }
  if (!dirs.length && !toolsAdd.length && !toolsRemove.length) {
    rfStatus.textContent = "Pick at least one directive or tool change.";
    return;
  }
  rfStatus.textContent = "Refining…";
  try {
    showRefineDiff(id, name, await refineItem(id, dirs, toolsAdd, toolsRemove));
  } catch (e) {
    rfStatus.textContent = `Error: ${e}`;
  }
}

function showRefineDiff(id: number, name: string, res: RefineResult) {
  detailEl.innerHTML =
    `<div class="detail-head"><div class="detail-title"><b>Refined: ${esc(name)}</b></div><button id="rf-x2" class="src-rm" title="Discard">✕</button></div>` +
    `<div class="add-row"><input id="rf-name" class="dir-input" value="${esc(name)} (refined)" /></div>` +
    `<div class="add-row"><button id="rf-save" class="primary">Save (overwrite)</button>` +
    `<button id="rf-savenew" class="add-btn">Save as new</button>` +
    `<button id="rf-back" class="add-btn">Back</button></div><p id="rf-status" class="status"></p>` +
    `<div class="rf-head">Proposed</div><pre class="detail-body">${esc(res.proposed)}</pre>` +
    `<div class="rf-head">Original</div><pre class="detail-body dim">${esc(res.original)}</pre>`;
  const rfErr = (e: unknown) => (document.getElementById("rf-status")!.textContent = `Error: ${e}`);
  document.getElementById("rf-x2")!.addEventListener("click", () => openDetail(id));
  document.getElementById("rf-back")!.addEventListener("click", () => openRefine(id));
  document.getElementById("rf-save")!.addEventListener("click", async () => {
    try {
      await applyRefinement(id, res.proposed);
      await load();
      openDetail(id);
      statusEl.textContent = "Refinement saved (original backed up).";
    } catch (e) {
      rfErr(e);
    }
  });
  document.getElementById("rf-savenew")!.addEventListener("click", async () => {
    const nm = (document.getElementById("rf-name") as HTMLInputElement).value.trim() || `${name} (refined)`;
    try {
      const newId = await applyRefinementAsNew(id, res.proposed, nm);
      await load();
      openDetail(newId);
      statusEl.textContent = "Saved as a new item (original kept).";
    } catch (e) {
      rfErr(e);
    }
  });
}

// ---------- batch refactor (staging-tray → directive picker → approve/reject queue) ----------
type BatchProposal = { id: number; name: string; original: string; proposed: string };

function startBatchRefine() {
  if (!S.aiOk) {
    statusEl.textContent = "Set a valid OPENAI_API_KEY (then restart) to refactor.";
    return;
  }
  if (!S.selection.size) return;
  const ids = [...S.selection];
  // Reuse the single-item directive picker UI, but wire the Run button to the batch runner.
  detailEl.hidden = false;
  detailEl.innerHTML =
    `<div class="detail-head"><div class="detail-title"><b>Batch refactor: ${ids.length} item(s)</b></div><button id="brf-x" class="src-rm" title="Cancel">✕</button></div>` +
    `<div class="rf-head">Directives (applied to every selected item)</div>` +
    DIRECTIVES.map((d, i) => `<label class="rf-chk"><input type="checkbox" data-dir="${i}" /> ${esc(d.split(":")[0])}</label>`).join("") +
    `<div class="rf-head">Tools — click to + add / − remove</div>` +
    `<div class="rf-tools">${TOOLS.map((t) => `<button class="rf-tool" data-tool="${t}" data-state="0">${t}</button>`).join("")}</div>` +
    `<div class="add-row"><button id="brf-run" class="primary">✦ Run on ${ids.length} item(s)</button></div><p id="brf-status" class="status"></p>`;
  document.getElementById("brf-x")!.addEventListener("click", closeDetail);
  for (const b of detailEl.querySelectorAll<HTMLButtonElement>(".rf-tool"))
    b.addEventListener("click", () => {
      const s = (Number(b.dataset.state) + 1) % 3;
      b.dataset.state = String(s);
      b.className = "rf-tool" + (s === 1 ? " add" : s === 2 ? " remove" : "");
    });
  document.getElementById("brf-run")!.addEventListener("click", () => runBatchRefine(ids));
}

async function runBatchRefine(ids: number[]) {
  const st = document.getElementById("brf-status")!;
  const dirs: string[] = [];
  for (const c of detailEl.querySelectorAll<HTMLInputElement>("input[data-dir]"))
    if (c.checked) dirs.push(DIRECTIVES[Number(c.dataset.dir)]);
  const toolsAdd: string[] = [];
  const toolsRemove: string[] = [];
  for (const b of detailEl.querySelectorAll<HTMLButtonElement>(".rf-tool")) {
    if (b.dataset.state === "1") toolsAdd.push(b.dataset.tool!);
    else if (b.dataset.state === "2") toolsRemove.push(b.dataset.tool!);
  }
  if (!dirs.length && !toolsAdd.length && !toolsRemove.length) {
    st.textContent = "Pick at least one directive or tool change.";
    return;
  }
  const proposals: BatchProposal[] = [];
  for (let i = 0; i < ids.length; i++) {
    const it = itemById(ids[i]);
    if (!it) continue;
    st.textContent = `Refining ${i + 1}/${ids.length}: ${it.name}…`;
    try {
      const res = await refineItem(ids[i], dirs, toolsAdd, toolsRemove);
      proposals.push({ id: ids[i], name: it.name, original: res.original, proposed: res.proposed });
    } catch (e) {
      st.textContent = `Error on ${it.name}: ${e}`;
      return;
    }
  }
  if (!proposals.length) {
    st.textContent = "Nothing to review.";
    return;
  }
  reviewBatch(proposals, 0);
}

function reviewBatch(proposals: BatchProposal[], idx: number) {
  if (idx >= proposals.length) {
    S.selection.clear();
    detailEl.hidden = true;
    detailEl.innerHTML = "";
    load().then(() => (statusEl.textContent = `Batch refactor complete (${proposals.length} reviewed).`));
    return;
  }
  const p = proposals[idx];
  detailEl.hidden = false;
  detailEl.innerHTML =
    `<div class="detail-head"><div class="detail-title"><b>Review ${idx + 1}/${proposals.length}: ${esc(p.name)}</b></div><button id="brv-x" class="src-rm" title="Stop reviewing">✕</button></div>` +
    `<div class="add-row"><button id="brv-approve" class="primary">✓ Approve (overwrite)</button>` +
    `<button id="brv-skip" class="add-btn">Skip</button></div><p id="brv-status" class="status"></p>` +
    `<div class="rf-head">Proposed</div><pre class="detail-body">${esc(p.proposed)}</pre>` +
    `<div class="rf-head">Original</div><pre class="detail-body dim">${esc(p.original)}</pre>`;
  document.getElementById("brv-x")!.addEventListener("click", () => reviewBatch(proposals, proposals.length));
  document.getElementById("brv-skip")!.addEventListener("click", () => reviewBatch(proposals, idx + 1));
  document.getElementById("brv-approve")!.addEventListener("click", async () => {
    try {
      await applyRefinement(p.id, p.proposed);
      reviewBatch(proposals, idx + 1);
    } catch (e) {
      document.getElementById("brv-status")!.textContent = `Error: ${e}`;
    }
  });
}

// ---------- merge / archive / delete ----------
type MergeMode = "create" | "delete";

async function startMerge(mode: MergeMode) {
  if (S.selection.size < 2) return;
  if (!S.aiOk) {
    statusEl.textContent = "Set a valid OPENAI_API_KEY (then restart) to merge.";
    return;
  }
  const ids = [...S.selection];
  statusEl.textContent = "Merging…";
  try {
    showMergeReview(ids, mode, await mergeItems(ids));
  } catch (e) {
    statusEl.textContent = `Error: ${e}`;
  }
}

function showMergeReview(ids: number[], mode: MergeMode, res: MergeResult) {
  const del = mode === "delete";
  detailEl.hidden = false;
  detailEl.innerHTML =
    `<div class="detail-head"><div class="detail-title"><b>Merge → ${del ? "Delete sources" : "New"}</b></div><button id="mg-x" class="src-rm" title="Discard">✕</button></div>` +
    `<div class="detail-path">Sources: ${res.sources.map((s) => esc(s.name)).join(", ")}</div>` +
    `<div class="add-row"><input id="mg-name" class="dir-input" value="${esc(res.sources[0]?.name ?? "merged")} (merged)" /></div>` +
    `<div class="add-row"><button id="mg-save" class="primary">Save ${del ? "& delete sources" : "as new"}</button></div><p id="mg-status" class="status"></p>` +
    `<div class="rf-head">Proposed</div><pre class="detail-body">${esc(res.proposed)}</pre>`;
  document.getElementById("mg-x")!.addEventListener("click", closeDetail);
  document.getElementById("mg-save")!.addEventListener("click", async () => {
    const name = (document.getElementById("mg-name") as HTMLInputElement).value.trim() || "merged";
    try {
      const newId = await saveMerge(ids, res.proposed, name, mode);
      S.selection.clear();
      await load();
      openDetail(newId);
      statusEl.textContent = del
        ? "Merged; sources deleted (restore from the Deleted view)."
        : "Merged into a new item.";
    } catch (e) {
      await load(); // reflect any partial progress (e.g. some sources already deleted)
      const st = document.getElementById("mg-status");
      if (st) st.textContent = `Error: ${e}`;
      statusEl.textContent = `Error: ${e}`;
    }
  });
}

async function archiveSelected() {
  const ids = [...S.selection];
  for (const id of ids) await archiveItem(id, true);
  S.selection.clear();
  await load();
  statusEl.textContent = `Archived ${ids.length} item(s).`;
}

async function exportSelected() {
  const ids = [...S.selection];
  if (!ids.length) return;
  const dest = await save({
    title: "Export selected items",
    defaultPath: "skill-export.tar.gz",
    filters: [{ name: "Gzipped tarball", extensions: ["tar.gz", "tgz"] }],
  });
  if (typeof dest !== "string") return; // cancelled
  statusEl.textContent = "Exporting…";
  try {
    const n = await exportItems(ids, dest);
    statusEl.textContent = `Exported ${n} item(s) → ${dest}`;
  } catch (e) {
    statusEl.textContent = `Error: ${e}`;
  }
}

async function deleteSelected() {
  const ids = [...S.selection];
  if (!ids.length) return;
  try {
    await deleteItems(ids);
    S.selection.clear();
    await load();
    statusEl.textContent = `Deleted ${ids.length} item(s) — restore from the Deleted view.`;
  } catch (e) {
    await load(); // reflect any partial progress
    statusEl.textContent = `Error: ${e}`;
  }
}

async function classifySelected() {
  if (!S.aiOk) {
    statusEl.textContent = "Set a valid OPENAI_API_KEY (then restart) to classify.";
    return;
  }
  const ids = [...S.selection];
  if (!ids.length) return;
  statusEl.textContent = `Classifying ${ids.length} selected…`;
  try {
    const s = await classifyAll(ids);
    S.selection.clear();
    await load();
    statusEl.textContent = `Classified ${s.classified} selected`;
  } catch (e) {
    statusEl.textContent = `Error: ${e}`;
  }
}

// ---------- load + events ----------
async function load() {
  const [items, arch, del, dirs, ok, vmap, dups, tagPairs, tagList] = await Promise.all([
    listItems(),
    listArchived(),
    listDeleted(),
    listScanDirs(),
    aiAvailable(),
    listVerbMap(),
    listDuplicates(),
    listItemTags(),
    listAllTags(),
  ]);
  S.allItems = items;
  S.archivedItems = arch;
  S.deletedItems = del;
  S.scanDirs = dirs;
  S.aiOk = ok;
  S.verbMap = vmap;
  S.dupGroups = dups;
  S.itemTagsMap = new Map();
  for (const [id, tag] of tagPairs) {
    const list = S.itemTagsMap.get(id) ?? [];
    list.push(tag);
    S.itemTagsMap.set(id, list);
  }
  S.allTags = tagList;
  try {
    [S.uncanonicalVerbs, S.canonVerbList] = await Promise.all([listUncanonicalVerbs(), canonicalVerbs()]);
  } catch {
    S.uncanonicalVerbs = [];
    S.canonVerbList = [];
  }
  try {
    S.activityFeed = await recentActivity();
  } catch {
    S.activityFeed = [];
  }
  for (const id of [...S.selection]) if (!S.allItems.some((i) => i.id === id)) S.selection.delete(id);
  // If the item open in the detail pane was just removed (deleted/merged away),
  // close the pane so it can't show or act on stale/tombstoned content.
  if (S.selectedId !== null && !itemById(S.selectedId) && !S.archivedItems.some((i) => i.id === S.selectedId)) {
    S.selectedId = null;
    detailEl.hidden = true;
    detailEl.innerHTML = "";
  }
  classifyBtn.disabled = !S.aiOk;
  classifyBtn.title = S.aiOk ? "Classify with AI" : "Set OPENAI_API_KEY to enable";
  renderModebar();
  renderFilters();
  renderSources();
  renderVerbMap();
  renderMain();
}

function onRowClick(e: Event) {
  const t = e.target as HTMLElement;
  if (t.classList.contains("sel")) {
    const id = Number((t as HTMLInputElement).dataset.id);
    if (S.selection.has(id)) S.selection.delete(id);
    else S.selection.add(id);
    renderSelbar();
    return;
  }
  if (t.classList.contains("restore")) {
    const id = Number(t.dataset.id);
    const done = t.dataset.kind === "delete" ? restoreDeleted(id) : archiveItem(id, false);
    done.then(load);
    return;
  }
  const li = t.closest("li.item") as HTMLElement | null;
  if (li?.dataset.id) openDetail(Number(li.dataset.id));
}
listEl.addEventListener("click", onRowClick);
dupesEl.addEventListener("click", onRowClick);

searchEl.addEventListener("input", () => {
  S.query = searchEl.value;
  S.cursorIdx = 0;
  if (S.query.trim() && S.view !== "library") S.view = "library";
  renderModebar();
  renderFilters();
  renderMain();
});

importBtn.addEventListener("click", async () => {
  importBtn.disabled = true;
  cancelBtn.hidden = false;
  cancelBtn.disabled = false;
  // Gate the rest of the UI: the import holds the single DB connection for its
  // whole run, so any other DB-touching command would block the main thread.
  // `body.importing` disables everything except the Cancel button (see styles.css),
  // keeping the main thread free so Cancel is always honored.
  document.body.classList.add("importing");
  statusEl.textContent = "Importing… (scanning locations + tarball)";
  try {
    const s = await runImport(); // resolves on done OR cancel; s.cancelled says which
    S.lastScanAt = Date.now(); // completed scan (incl. cancelled partials) — resets the auto-scan clock
    await load();
    statusEl.textContent = s.cancelled
      ? `Cancelled — kept ${s.items_new} new (partial, re-runnable) · ${S.allItems.length} total`
      : `Imported ${s.items_new} new · ${s.variants_flagged} variants · ${S.allItems.length} total`;
  } catch (e) {
    statusEl.textContent = `Error: ${e}`;
  } finally {
    importBtn.disabled = false;
    cancelBtn.hidden = true;
    document.body.classList.remove("importing");
  }
});
cancelBtn.addEventListener("click", async () => {
  cancelBtn.disabled = true;
  statusEl.textContent = "Cancelling…";
  try {
    await cancelImport();
  } catch (e) {
    statusEl.textContent = `Error: ${e}`;
  }
});

// ---------- auto-scan on window focus ----------
// If the app regains focus after sitting idle for AUTO_SCAN_AFTER_MS, kick off
const AUTO_SCAN_AFTER_MS = 5 * 60 * 1000; // 5 minutes
// the same scan/import as clicking the Scan & import button — unless an import
// is already running or the onboarding wizard is open.
window.addEventListener("focus", () => {
  if (Date.now() - S.lastScanAt <= AUTO_SCAN_AFTER_MS) return;
  if (importBtn.disabled || document.body.classList.contains("importing")) return; // import in flight
  if (S.onboardingOpen) return;
  importBtn.click();
});

classifyBtn.addEventListener("click", async () => {
  if (!S.aiOk) {
    statusEl.textContent = "Set a valid OPENAI_API_KEY, then restart, to classify.";
    return;
  }
  classifyBtn.disabled = true;
  statusEl.textContent = "Classifying… (one cheap call per ~20 items)";
  try {
    const s = await classifyAll();
    await load();
    statusEl.textContent = `Classified ${s.classified} of ${s.total}`;
  } catch (e) {
    statusEl.textContent = `Error: ${e}`;
  } finally {
    classifyBtn.disabled = false;
  }
});

listen<{ done: number; total: number }>("classify-progress", (e) => {
  statusEl.textContent = `Classifying… ${e.payload.done}/${e.payload.total}`;
});
listen<string>("import-progress", (e) => {
  statusEl.textContent = e.payload;
});

window.addEventListener("error", (ev) => {
  statusEl.textContent = `JS error: ${ev.message}`;
});
window.addEventListener("unhandledrejection", (ev) => {
  statusEl.textContent = `Promise error: ${ev.reason}`;
});

// ---------- command palette ----------
type PaletteAction = { label: string; hint?: string; run: () => void };

function paletteActions(): PaletteAction[] {
  const acts: PaletteAction[] = [
    { label: "Go to Dashboard", run: () => goToView("dashboard") },
    { label: "Go to Browse", run: () => goToView("library") },
    { label: "Go to Triage", hint: `${S.dupGroups.length} cluster(s)`, run: () => goToView("duplicates") },
    { label: "Go to Deploy", run: () => goToView("deploy") },
    { label: "Go to Archived", hint: `${S.archivedItems.length}`, run: () => goToView("archived") },
    { label: "Go to Deleted", hint: `${S.deletedItems.length}`, run: () => goToView("deleted") },
    { label: "Scan & import", run: () => importBtn.click() },
    { label: "Open Settings", run: () => openSettings() },
    { label: "Export selected items", hint: `${S.selection.size} selected`, run: () => exportSelected() },
    { label: "Batch refactor selected", hint: `${S.selection.size} selected`, run: () => startBatchRefine() },
  ];
  if (S.aiOk) acts.push({ label: "Classify all unclassified items", run: () => classifyBtn.click() });
  if (S.selection.size >= 2) {
    acts.push({ label: `Merge ${S.selection.size} selected → New`, run: () => startMerge("create") });
    acts.push({ label: `Merge ${S.selection.size} selected → Delete sources`, run: () => startMerge("delete") });
  }
  return acts;
}

function paletteItemMatches(it: Item, q: string): boolean {
  return (
    it.name.toLowerCase().includes(q) ||
    it.description.toLowerCase().includes(q) ||
    (it.object ?? "").toLowerCase().includes(q) ||
    (it.verb ?? "").toLowerCase().includes(q)
  );
}

let paletteFocus = 0;

// Subsequence fuzzy match: every char of `query` must appear in `target` in
// order (case-insensitive). Returns -1 on no match; otherwise a score that
// rewards consecutive-char runs and matches at the start of the target or of
// a word. Pure — no side effects.
// fuzzyScore lives in util.ts (imported above) — pure subsequence scorer for the palette.

function renderPalette() {
  const q = paletteInputEl.value.trim().toLowerCase();
  // Empty query: all actions in original order. Otherwise fuzzy-match and sort
  // by score descending, keeping the original order for equal scores (stable).
  const actions = q
    ? paletteActions()
        .map((a, i) => ({ a, i, s: fuzzyScore(q, a.label) }))
        .filter((x) => x.s >= 0)
        .sort((x, y) => y.s - x.s || x.i - y.i)
        .map((x) => x.a)
    : paletteActions();
  const items = q ? S.allItems.filter((it) => paletteItemMatches(it, q)).slice(0, 20) : [];

  const rows: string[] = [];
  actions.forEach((a, i) => {
    rows.push(
      `<li class="pal-row${i === paletteFocus ? " focused" : ""}" data-kind="action" data-idx="${i}">` +
        `<span class="pal-icon">▸</span><span class="pal-label">${esc(a.label)}</span>` +
        (a.hint ? `<span class="pal-hint">${esc(a.hint)}</span>` : "") +
        `</li>`,
    );
  });
  items.forEach((it, i) => {
    const idx = actions.length + i;
    rows.push(
      `<li class="pal-row${idx === paletteFocus ? " focused" : ""}" data-kind="item" data-idx="${idx}" data-id="${it.id}">` +
        `<span class="badge ${it.item_type}">${it.item_type}</span><span class="pal-label">${esc(it.name)}</span>` +
        `<span class="pal-hint">${esc(it.description).slice(0, 60)}</span>` +
        `</li>`,
    );
  });

  paletteResultsEl.innerHTML = rows.length
    ? rows.join("")
    : `<li class="pal-empty">No matches.</li>`;

  for (const li of paletteResultsEl.querySelectorAll<HTMLLIElement>(".pal-row")) {
    li.addEventListener("click", () => runPaletteRow(li, actions));
  }
}

function runPaletteRow(li: HTMLLIElement, actions: PaletteAction[]) {
  const idx = Number(li.dataset.idx);
  if (li.dataset.kind === "action") {
    actions[idx]?.run();
  } else {
    const id = Number(li.dataset.id);
    closePalette();
    openDetail(id);
    return;
  }
  closePalette();
}

function openPalette() {
  paletteFocus = 0;
  paletteInputEl.value = "";
  paletteEl.hidden = false;
  renderPalette();
  paletteInputEl.focus();
}

function closePalette() {
  paletteEl.hidden = true;
}

paletteBtn.addEventListener("click", openPalette);
paletteEl.addEventListener("click", (e) => {
  if (e.target === paletteEl) closePalette();
});
paletteInputEl.addEventListener("input", () => {
  paletteFocus = 0;
  renderPalette();
});
paletteInputEl.addEventListener("keydown", (e) => {
  const rowCount = paletteResultsEl.querySelectorAll(".pal-row").length;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    paletteFocus = Math.min(paletteFocus + 1, Math.max(rowCount - 1, 0));
    renderPalette();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    paletteFocus = Math.max(paletteFocus - 1, 0);
    renderPalette();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const li = paletteResultsEl.querySelector<HTMLLIElement>(".pal-row.focused");
    if (li) li.click();
  } else if (e.key === "Escape") {
    closePalette();
  }
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (paletteEl.hidden) openPalette();
    else closePalette();
  }
});

// ---------- first-run onboarding wizard ----------
async function maybeOnboard() {
  let done = true;
  try {
    done = await isOnboarded();
  } catch {
    done = true; // never block startup on a status-check failure
  }
  if (done) return;
  S.onboardingOpen = true;
  detailEl.hidden = false;
  const [stored, env] = await apiKeyStatus().catch(() => [false, false] as [boolean, boolean]);
  const keyLine = stored || env
    ? `<p class="nav-note">✓ An API key is already configured.</p>`
    : `<div class="add-row"><input id="ob-key" class="dir-input" type="password" placeholder="sk-… (optional, enables AI features)" /></div>`;
  detailEl.innerHTML =
    `<div class="detail-head"><div class="detail-title"><b>👋 Welcome — quick setup</b></div></div>` +
    `<p class="nav-note">Three quick steps to get your skill & agent library going. You can skip any of them and change everything later in Settings.</p>` +
    `<div class="rf-head">1. Add a folder to scan</div>` +
    `<p class="nav-note" id="ob-dirnote">Pick a folder containing skills (SKILL.md) or agents (*.md).</p>` +
    `<div class="add-row"><button id="ob-add-skill" class="add-btn">+ Add skills folder…</button>` +
    `<button id="ob-add-agent" class="add-btn">+ Add agents folder…</button></div>` +
    `<div class="rf-head">2. OpenAI API key</div>${keyLine}` +
    `<div class="rf-head">3. Finish</div>` +
    `<div class="add-row"><button id="ob-finish" class="primary">Scan now &amp; finish</button>` +
    `<button id="ob-skip" class="add-btn">Skip for now</button></div><p id="ob-status" class="status"></p>`;
  const st = document.getElementById("ob-status")!;
  const pickDir = async (t: "skill" | "agent") => {
    const path = await open({ directory: true, title: `Add ${t}s folder` });
    if (typeof path !== "string") return;
    try {
      await addScanDir(path, t);
      document.getElementById("ob-dirnote")!.textContent = `✓ Added ${t}s folder: ${path}`;
    } catch (e) {
      st.textContent = `Error: ${e}`;
    }
  };
  document.getElementById("ob-add-skill")!.addEventListener("click", () => pickDir("skill"));
  document.getElementById("ob-add-agent")!.addEventListener("click", () => pickDir("agent"));
  const saveKeyIfAny = async () => {
    const el = document.getElementById("ob-key") as HTMLInputElement | null;
    const key = el?.value.trim();
    if (key) {
      await setApiKey(key);
      S.aiOk = await aiAvailable();
    }
  };
  document.getElementById("ob-finish")!.addEventListener("click", async () => {
    st.textContent = "Setting up…";
    try {
      await saveKeyIfAny();
      await setOnboarded();
      S.onboardingOpen = false;
      closeDetail();
      importBtn.click(); // kick off the first scan/import
    } catch (e) {
      st.textContent = `Error: ${e}`;
    }
  });
  document.getElementById("ob-skip")!.addEventListener("click", async () => {
    try {
      await saveKeyIfAny();
      await setOnboarded();
    } catch {
      /* ignore */
    }
    S.onboardingOpen = false;
    closeDetail();
  });
}

load()
  .then(() => maybeOnboard())
  .catch((e) => {
    statusEl.textContent = `Load error: ${e}`;
    listEl.innerHTML = `<li class="item">⚠ Load failed: ${esc(String(e))}</li>`;
  });
