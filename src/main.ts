import { addScanDir, aiAvailable, apiKeyStatus, archiveItem, cancelImport, canonicalVerbs, classifyAll, isOnboarded, listAllTags, listArchived, listDeleted, listDuplicates, listItemTags, listItems, listScanDirs, listUncanonicalVerbs, listVerbMap, recentActivity, restoreDeleted, runImport, setApiKey, setOnboarded } from "./api";
import { cancelBtn, classifyBtn, dashboardEl, deployEl, detailEl, dupesEl, emptyEl, importBtn, listEl, modebarEl, searchEl, statusEl } from "./dom";
import { S, type View, itemById } from "./state";
import { esc } from "./util";
import { renderArchived, renderDeleted, renderList, renderSelbar } from "./views/browse";
import { renderDashboard } from "./views/dashboard";
import { renderDeploy } from "./views/deploy";
import { closeDetail, openDetail } from "./views/detail";
import { renderFilters, renderSources, renderVerbMap } from "./views/sidebar";
import { renderTriage } from "./views/triage";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

// ---------- top-bar mode switcher ----------
export async function openSettings() {
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

export function renderModebar() {
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

export function goToView(v: View) {
  S.view = v;
  renderModebar();
  renderFilters();
  renderMain();
}


export function renderMain() {
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


// ---------- load + events ----------
export async function load() {
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

export function onRowClick(e: Event) {
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
export const AUTO_SCAN_AFTER_MS = 5 * 60 * 1000; // 5 minutes
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


// ---------- first-run onboarding wizard ----------
export async function maybeOnboard() {
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
