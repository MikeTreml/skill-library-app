use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemType {
    Skill,
    Agent,
}

impl ItemType {
    pub fn as_str(self) -> &'static str {
        match self {
            ItemType::Skill => "skill",
            ItemType::Agent => "agent",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "skill" => Some(ItemType::Skill),
            "agent" => Some(ItemType::Agent),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LocationKind {
    ClaudeSkills,
    Marketplace,
    Agents,
    Project,
    Codex,
    Tarball,
}

impl LocationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LocationKind::ClaudeSkills => "claude-skills",
            LocationKind::Marketplace => "marketplace",
            LocationKind::Agents => "agents",
            LocationKind::Project => "project",
            LocationKind::Codex => "codex",
            LocationKind::Tarball => "tarball",
        }
    }
    /// What the scanner looks for: agents = top-level `*.md`, everything else = `**/SKILL.md`.
    pub fn scans_agents(self) -> bool {
        matches!(self, LocationKind::Agents)
    }
}

/// A skill/agent discovered on disk, before it is stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannedItem {
    pub item_type: ItemType,
    pub name: String,
    pub description: String,
    pub source_path: std::path::PathBuf, // the item's folder (skill) or file (agent)
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    pub id: i64,
    pub item_type: ItemType,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub category: Option<String>,
    pub subcategory: Option<String>,
    pub object: Option<String>,
    pub sub_object: Option<String>,
    pub verb: Option<String>,
    pub qualifier: Option<String>,
    pub canonical_hash: String,
    pub library_path: String,
    pub has_variants: bool,
    pub archived: bool,
    /// Usage/staleness tracking: last time the user marked this item as used, and a
    /// running count. `last_used_at` is None until the first "mark as used".
    pub last_used_at: Option<String>,
    pub use_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Location {
    pub id: i64,
    pub label: String,
    pub root_path: String,
    pub kind: LocationKind,
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ImportSummary {
    pub locations_scanned: u32,
    pub items_found: u32,
    pub items_new: u32,
    pub placements_recorded: u32,
    pub variants_flagged: u32,
    /// True when the import stopped early because cancellation was requested.
    pub cancelled: bool,
}

/// A user-added directory to scan, tagged as holding agents or skills.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanDir {
    pub id: i64,
    pub path: String,
    pub item_type: ItemType,
    pub enabled: bool,
}

/// One place an item lives, with its current sync state vs the library copy.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlacementInfo {
    pub id: i64,
    pub location_label: String,
    pub abs_path: String,
    pub status: String, // in_sync | drifted | missing
}

/// A 3-way conflict surfaced in the Deploy-mode "conflict inbox": both the library
/// copy AND the on-disk deployed copy have diverged from the last common sync
/// baseline, so neither push nor pull is safe without the user choosing a side.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conflict {
    pub placement_id: i64,
    pub item_name: String,
    pub location_label: String,
    pub abs_path: String,
}

/// Aggregated sync status for one location, rolled up across all its placements —
/// powers the Deploy mode "map view" (one card per location) instead of requiring
/// the user to drill into each item's sync panel individually.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocationDeployStatus {
    pub location_id: i64,
    pub label: String,
    pub root_path: String,
    pub in_sync: u32,
    pub drifted: u32,
    pub missing: u32,
    pub total: u32,
}
