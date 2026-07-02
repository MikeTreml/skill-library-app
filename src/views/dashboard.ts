import { classifyBtn, dashboardEl, importBtn } from "../dom";
import { goToView } from "../main";
import { S } from "../state";
import { esc } from "../util";

// ---------- dashboard ----------
export function statCard(label: string, value: string | number, tone?: "warn" | "ok" | "danger"): string {
  return `<div class="stat-card${tone ? " " + tone : ""}"><div class="stat-value">${esc(String(value))}</div><div class="stat-label">${esc(label)}</div></div>`;
}

export function renderDashboard() {
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

