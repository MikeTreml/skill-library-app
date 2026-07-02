use crate::model::{Item, ItemType, Location, LocationKind, ScanDir};
use crate::{ai, db, importer};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;
use walkdir::WalkDir;

/// Build the default set of (label, path, kind) candidates relative to a home dir.
/// Only paths that exist are returned (the tarball is handled separately).
pub fn default_location_candidates(home: &Path) -> Vec<(String, PathBuf, LocationKind)> {
    let mut out = vec![
        (
            "Claude skills".into(),
            home.join(".claude/skills"),
            LocationKind::ClaudeSkills,
        ),
        (
            "Claude agents".into(),
            home.join(".claude/agents"),
            LocationKind::Agents,
        ),
        (
            "Marketplaces".into(),
            home.join(".claude/plugins/marketplaces"),
            LocationKind::Marketplace,
        ),
        (
            "Codex skills".into(),
            home.join(".codex/skills"),
            LocationKind::Codex,
        ),
    ];
    out.retain(|(_, p, _)| p.exists());
    out
}

/// Discover project-level `.claude/agents` and `.claude/skills` directories under
/// `root` (e.g. `~/Repo`), skipping dependency/build/VCS/fixture directories.
/// `.claude/agents` → Agents kind; `.claude/skills` → Project kind.
pub fn discover_project_locations(root: &Path) -> Vec<(String, PathBuf, LocationKind)> {
    let mut out = Vec::new();
    if !root.exists() {
        return out;
    }
    let pruned = |name: &str| {
        matches!(
            name,
            "node_modules" | "target" | ".git" | ".venv" | "dist" | "build"
        ) || name.contains("fixture")
            || name == "_test-run"
    };
    let walker = WalkDir::new(root).into_iter().filter_entry(|e| {
        if e.depth() > 0 && e.file_type().is_dir() {
            if let Some(n) = e.file_name().to_str() {
                return !pruned(n);
            }
        }
        true
    });
    for entry in walker.filter_map(|e| e.ok()) {
        if !entry.file_type().is_dir() {
            continue;
        }
        let p = entry.path();
        let name = match p.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };
        let in_dot_claude = p
            .parent()
            .and_then(|pp| pp.file_name())
            .and_then(|s| s.to_str())
            == Some(".claude");
        if !in_dot_claude {
            continue;
        }
        let kind = match name {
            "agents" => LocationKind::Agents,
            "skills" => LocationKind::Project,
            _ => continue,
        };
        let project = p
            .parent()
            .and_then(|pp| pp.parent())
            .and_then(|pj| pj.file_name())
            .and_then(|s| s.to_str())
            .unwrap_or("project")
            .to_string();
        out.push((format!("{project} ({name})"), p.to_path_buf(), kind));
    }
    out
}

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub library_root: PathBuf,
    pub home: PathBuf,
    pub tarball_path: Option<PathBuf>,
    /// Cooperative cancel flag for a running import.
    pub import_cancel: std::sync::atomic::AtomicBool,
    /// Re-entrancy guard: true while an import is in flight.
    pub import_running: std::sync::atomic::AtomicBool,
}

// ---- command submodules (split from the former single-file commands.rs) ----
// Shared imports + AppState + cross-domain helpers live here in mod.rs;
// submodules pull them in via `use super::*;`. Kept `pub` so lib.rs can use
// module-qualified paths in generate_handler! (tauri's __cmd__ macros need them).
pub mod ai_cmds;
pub mod catalog;
pub mod deploy;
pub mod importing;
pub mod items;

// Flat re-exports: keep `commands::foo` working for cross-module helpers and the
// shared tests module. Some are only consumed under #[cfg(test)], hence the allow.
#[allow(unused_imports)]
pub use ai_cmds::*;
#[allow(unused_imports)]
pub use catalog::*;
#[allow(unused_imports)]
pub use deploy::*;
#[allow(unused_imports)]
pub use importing::*;
#[allow(unused_imports)]
pub use items::*;

#[cfg(test)]
mod tests;
