// Central registry of top-level DOM anchors from index.html. Importing from one
// place keeps element lookups typed and avoids scattered getElementById calls.

export const searchEl = document.getElementById("search") as HTMLInputElement;
export const importBtn = document.getElementById("import") as HTMLButtonElement;
export const cancelBtn = document.getElementById("cancel-import") as HTMLButtonElement;
export const classifyBtn = document.getElementById("classify") as HTMLButtonElement;
export const statusEl = document.getElementById("status")!;
export const modebarEl = document.getElementById("modebar")!;
export const selbarEl = document.getElementById("selbar")!;
export const dashboardEl = document.getElementById("dashboard")!;
export const deployEl = document.getElementById("deploy")!;
export const listEl = document.getElementById("items")!;
export const dupesEl = document.getElementById("dupes")!;
export const filtersEl = document.getElementById("filters")!;
export const sourcesEl = document.getElementById("sources")!;
export const verbmapEl = document.getElementById("verbmap")!;
export const emptyEl = document.getElementById("empty") as HTMLParagraphElement;
export const detailEl = document.getElementById("detail") as HTMLElement;
export const paletteBtn = document.getElementById("palette-btn") as HTMLButtonElement;
export const paletteEl = document.getElementById("palette") as HTMLElement;
export const paletteInputEl = document.getElementById("palette-input") as HTMLInputElement;
export const paletteResultsEl = document.getElementById("palette-results")!;
