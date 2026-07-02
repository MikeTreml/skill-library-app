// Central mutable UI state. Modules import { S } and read/write S.<field>;
// a single shared object keeps live bindings without setter boilerplate.
import type { DupGroup, Item, LocationDeployStatus, ScanDir } from "./api";

export type TypeFilter = "all" | "skill" | "agent";
// "duplicates" is labeled "Triage" in the UI (clusters + untriaged queue).
export type View = "dashboard" | "library" | "duplicates" | "archived" | "deleted" | "deploy";

export const S = {
  allItems: [] as Item[],
  archivedItems: [] as Item[],
  deletedItems: [] as Item[],
  objectsTreeOpen: true,
  scanDirs: [] as ScanDir[],
  dupGroups: [] as DupGroup[],
  deployStatuses: [] as LocationDeployStatus[],
  // item id -> user tags, and the full tag list with counts for the sidebar filter.
  itemTagsMap: new Map<number, string[]>(),
  allTags: [] as [string, number][],
  tagFilter: null as string | null,
  verbMap: [] as [string, string][],
  // Verbs on items that aren't canonical, + the canonical list for the "promote to" picker.
  uncanonicalVerbs: [] as [string, number][],
  canonVerbList: [] as string[],
  activityFeed: [] as [number, string, string, string][],
  aiOk: false,
  view: "dashboard" as View,
  typeFilter: "all" as TypeFilter,
  objectFilter: null as string | null,
  query: "",
  selectedId: null as number | null,
  selection: new Set<number>(),
  // Browse keyboard navigation: index of the highlighted row within visibleItems().
  cursorIdx: 0,
  // Auto-scan on window focus: initialized to "now" so initial load never auto-scans.
  lastScanAt: Date.now(),
  onboardingOpen: false,
};

export const itemById = (id: number) => S.allItems.find((i) => i.id === id);
