import { invoke } from "@tauri-apps/api/core";

export type ItemType = "skill" | "agent";

export interface Item {
  id: number;
  item_type: ItemType;
  name: string;
  slug: string;
  description: string;
  category: string | null;
  subcategory: string | null;
  object: string | null;
  sub_object: string | null;
  verb: string | null;
  qualifier: string | null;
  canonical_hash: string;
  library_path: string;
  has_variants: boolean;
  archived: boolean;
  last_used_at: string | null;
  use_count: number;
}

export interface ImportSummary {
  locations_scanned: number;
  items_found: number;
  items_new: number;
  placements_recorded: number;
  variants_flagged: number;
  cancelled: boolean;
}

export interface ScanDir {
  id: number;
  path: string;
  item_type: ItemType;
  enabled: boolean;
}

export const listItems = () => invoke<Item[]>("list_items");
export const runImport = () => invoke<ImportSummary>("run_import");
export const cancelImport = () => invoke<void>("cancel_import");
export const getItemContent = (id: number) => invoke<string>("get_item_content", { id });

export interface DupGroup {
  key: string;
  kind: "exact" | "near";
  item_ids: number[];
}
export interface ClassifySummary {
  classified: number;
  total: number;
}

export const aiAvailable = () => invoke<boolean>("ai_available");
export const classifyAll = (ids?: number[]) =>
  invoke<ClassifySummary>("classify_all", { ids: ids ?? null });
export const listDuplicates = () => invoke<DupGroup[]>("list_duplicates");
export const dismissCluster = (clusterKey: string) =>
  invoke<void>("dismiss_cluster", { clusterKey });
export const undismissCluster = (clusterKey: string) =>
  invoke<void>("undismiss_cluster", { clusterKey });
export const listDismissedClusters = () => invoke<string[]>("list_dismissed_clusters");

export const addItemTag = (id: number, tag: string) => invoke<void>("add_item_tag", { id, tag });
export const removeItemTag = (id: number, tag: string) =>
  invoke<void>("remove_item_tag", { id, tag });
export const listItemTags = () => invoke<[number, string][]>("list_item_tags");
export const listAllTags = () => invoke<[string, number][]>("list_all_tags");
export const listVerbMap = () => invoke<[string, string][]>("list_verb_map");
export const listUncanonicalVerbs = () => invoke<[string, number][]>("list_uncanonical_verbs");
export const canonicalVerbs = () => invoke<string[]>("canonical_verbs");
export const recentActivity = () => invoke<[number, string, string, string][]>("recent_activity");
export const addSynonym = (canonical: string, synonym: string) =>
  invoke<void>("add_synonym", { canonical, synonym });
export const removeSynonym = (synonym: string) => invoke<void>("remove_synonym", { synonym });
export const renormalizeVerbs = () => invoke<number>("renormalize_verbs");

export const listScanDirs = () => invoke<ScanDir[]>("list_scan_dirs");
export const addScanDir = (path: string, item_type: ItemType) =>
  invoke<void>("add_scan_dir", { path, itemType: item_type }); // Tauri maps camelCase → snake_case
export const removeScanDir = (id: number) => invoke<void>("remove_scan_dir", { id });

export interface RefineResult {
  original: string;
  proposed: string;
}
export const refineItem = (
  id: number,
  directives: string[],
  toolsAdd: string[],
  toolsRemove: string[],
) => invoke<RefineResult>("refine_item", { id, directives, toolsAdd, toolsRemove });
export const applyRefinement = (id: number, content: string) =>
  invoke<void>("apply_refinement", { id, content });
export const applyRefinementAsNew = (id: number, content: string, name: string) =>
  invoke<number>("apply_refinement_as_new", { id, content, name });

export interface MergeSource {
  id: number;
  name: string;
}
export interface MergeResult {
  proposed: string;
  sources: MergeSource[];
}
export const mergeItems = (ids: number[]) => invoke<MergeResult>("merge_items", { ids });
export const saveMerge = (ids: number[], content: string, name: string, mode: string) =>
  invoke<number>("save_merge", { ids, content, name, mode });
export const archiveItem = (id: number, archived: boolean) =>
  invoke<void>("archive_item", { id, archived });
export const listArchived = () => invoke<Item[]>("list_archived");
export const deleteItems = (ids: number[]) => invoke<void>("delete_items", { ids });
export const restoreDeleted = (id: number) => invoke<void>("restore_deleted", { id });
export const listDeleted = () => invoke<Item[]>("list_deleted");

export interface PlacementInfo {
  id: number;
  location_label: string;
  abs_path: string;
  status: string; // in_sync | drifted | missing
}
export const itemSync = (id: number) => invoke<PlacementInfo[]>("item_sync", { id });
export const readPlacement = (placementId: number) =>
  invoke<string>("read_placement", { placementId });
export const pushToLocation = (placementId: number) =>
  invoke<void>("push_to_location", { placementId });
export const pullFromLocation = (placementId: number) =>
  invoke<void>("pull_from_location", { placementId });

export interface LocationDeployStatus {
  location_id: number;
  label: string;
  root_path: string;
  in_sync: number;
  drifted: number;
  missing: number;
  total: number;
}
export const deployStatus = () => invoke<LocationDeployStatus[]>("deploy_status");

export interface Conflict {
  placement_id: number;
  item_name: string;
  location_label: string;
  abs_path: string;
}
export const listConflicts = () => invoke<Conflict[]>("list_conflicts");

/// Batch push for one location: returns [pushed, skipped_conflicts, skipped_ok].
export const pushAllToLocation = (locationId: number) =>
  invoke<[number, number, number]>("push_all_to_location", { locationId });

export const hasRefineBackup = (id: number) => invoke<boolean>("has_refine_backup", { id });
export const revertRefine = (id: number) => invoke<void>("revert_refine", { id });

export const exportItems = (ids: number[], destPath: string) =>
  invoke<number>("export_items", { ids, destPath });

export const setApiKey = (key: string) => invoke<void>("set_api_key", { key });
// Returns [storedInApp, envVarSet] — never the secret itself.
export const apiKeyStatus = () => invoke<[boolean, boolean]>("api_key_status");

export const markUsed = (id: number) => invoke<void>("mark_used", { id });
export const deletionCandidates = () => invoke<Item[]>("deletion_candidates");

export const isOnboarded = () => invoke<boolean>("is_onboarded");
export const setOnboarded = () => invoke<void>("set_onboarded");
