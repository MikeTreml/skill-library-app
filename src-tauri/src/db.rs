use crate::model::{Item, ItemType, Location, LocationKind, ScanDir};
use rusqlite::{params, Connection, OptionalExtension};

pub fn open(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    init_schema(&conn)?;
    Ok(conn)
}

#[cfg(test)]
pub fn open_in_memory() -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    init_schema(&conn)?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS locations (
            id INTEGER PRIMARY KEY,
            label TEXT NOT NULL,
            root_path TEXT NOT NULL,
            kind TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            last_scanned TEXT,
            UNIQUE(kind, root_path)
        );
        CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY,
            item_type TEXT NOT NULL,
            name TEXT NOT NULL,
            slug TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            category TEXT,
            subcategory TEXT,
            object TEXT,
            sub_object TEXT,
            verb TEXT,
            qualifier TEXT,
            archived INTEGER NOT NULL DEFAULT 0,
            canonical_hash TEXT NOT NULL,
            library_path TEXT NOT NULL,
            has_variants INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(item_type, slug)
        );
        CREATE TABLE IF NOT EXISTS placements (
            id INTEGER PRIMARY KEY,
            item_id INTEGER NOT NULL REFERENCES items(id),
            location_id INTEGER NOT NULL REFERENCES locations(id),
            rel_path TEXT NOT NULL,
            location_hash TEXT NOT NULL,
            status TEXT NOT NULL,
            last_scanned TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(item_id, location_id)
        );
        CREATE TABLE IF NOT EXISTS scan_dirs (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL,
            item_type TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            UNIQUE(path, item_type)
        );
        CREATE TABLE IF NOT EXISTS verb_map (
            id INTEGER PRIMARY KEY,
            canonical TEXT NOT NULL,
            synonym TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS dismissed_clusters (
            cluster_key TEXT PRIMARY KEY,
            dismissed_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS item_tags (
            item_id INTEGER NOT NULL REFERENCES items(id),
            tag TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY(item_id, tag)
        );
        CREATE TABLE IF NOT EXISTS activity_log (
            id INTEGER PRIMARY KEY,
            kind TEXT NOT NULL,
            summary TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        ",
    )?;
    // Migrate pre-existing item tables that predate the v2 classification columns.
    for (col, decl) in [
        ("object", "TEXT"),
        ("sub_object", "TEXT"),
        ("verb", "TEXT"),
        ("qualifier", "TEXT"),
        ("archived", "INTEGER NOT NULL DEFAULT 0"),
        ("deleted", "INTEGER NOT NULL DEFAULT 0"),
        ("last_used_at", "TEXT"),
        ("use_count", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        ensure_column(conn, "items", col, decl)?;
    }
    seed_verb_map(conn)?;
    Ok(())
}

/// Add `col` to `table` if it isn't already present (table/col are hard-coded, not user input).
fn ensure_column(conn: &Connection, table: &str, col: &str, decl: &str) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let cols: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<_>>()?;
    if !cols.iter().any(|c| c == col) {
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {col} {decl}"), [])?;
    }
    Ok(())
}

/// Seed the editable verb map from the canonical taxonomy (only if empty).
fn seed_verb_map(conn: &Connection) -> rusqlite::Result<()> {
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM verb_map", [], |r| r.get(0))?;
    if n > 0 {
        return Ok(());
    }
    for (canon, syns) in crate::taxonomy::verb_synonyms() {
        conn.execute(
            "INSERT OR IGNORE INTO verb_map (canonical, synonym) VALUES (?1, ?2)",
            params![canon, canon.to_ascii_lowercase()],
        )?;
        for s in *syns {
            conn.execute(
                "INSERT OR IGNORE INTO verb_map (canonical, synonym) VALUES (?1, ?2)",
                params![canon, s],
            )?;
        }
    }
    Ok(())
}

/// Insert a location if its (kind, root_path) is new; return its id either way.
pub fn upsert_location(
    conn: &Connection,
    label: &str,
    root_path: &str,
    kind: LocationKind,
) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT OR IGNORE INTO locations (label, root_path, kind) VALUES (?1, ?2, ?3)",
        params![label, root_path, kind.as_str()],
    )?;
    conn.query_row(
        "SELECT id FROM locations WHERE kind = ?1 AND root_path = ?2",
        params![kind.as_str(), root_path],
        |r| r.get(0),
    )
}

/// Insert an item if (item_type, slug) is new; return (id, was_new).
pub fn insert_item_if_absent(
    conn: &Connection,
    item_type: ItemType,
    name: &str,
    slug: &str,
    description: &str,
    canonical_hash: &str,
    library_path: &str,
) -> rusqlite::Result<(i64, bool)> {
    let changed = conn.execute(
        "INSERT OR IGNORE INTO items
            (item_type, name, slug, description, canonical_hash, library_path)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            item_type.as_str(),
            name,
            slug,
            description,
            canonical_hash,
            library_path
        ],
    )?;
    let id = conn.query_row(
        "SELECT id FROM items WHERE item_type = ?1 AND slug = ?2",
        params![item_type.as_str(), slug],
        |r| r.get(0),
    )?;
    Ok((id, changed == 1))
}

/// A slug not used by any existing item of this type (live, archived, OR deleted),
/// appending `-2`, `-3`, … as needed. Callers that create a brand-new library item
/// use this so a colliding slug can never overwrite another item's library copy.
pub fn unique_slug(conn: &Connection, item_type: ItemType, base: &str) -> rusqlite::Result<String> {
    let taken = |slug: &str| -> rusqlite::Result<bool> {
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM items WHERE item_type = ?1 AND slug = ?2",
            params![item_type.as_str(), slug],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    };
    if !taken(base)? {
        return Ok(base.to_string());
    }
    let mut i = 2;
    loop {
        let candidate = format!("{base}-{i}");
        if !taken(&candidate)? {
            return Ok(candidate);
        }
        i += 1;
    }
}

pub fn set_has_variants(conn: &Connection, item_id: i64, value: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE items SET has_variants = ?2, updated_at = datetime('now') WHERE id = ?1",
        params![item_id, value as i64],
    )?;
    Ok(())
}

pub fn item_canonical_hash(conn: &Connection, item_id: i64) -> rusqlite::Result<String> {
    conn.query_row(
        "SELECT canonical_hash FROM items WHERE id = ?1",
        params![item_id],
        |r| r.get(0),
    )
}

pub fn item_name(conn: &Connection, item_id: i64) -> rusqlite::Result<String> {
    conn.query_row(
        "SELECT name FROM items WHERE id = ?1",
        params![item_id],
        |r| r.get(0),
    )
}

pub fn item_library_path(conn: &Connection, item_id: i64) -> rusqlite::Result<String> {
    conn.query_row(
        "SELECT library_path FROM items WHERE id = ?1",
        params![item_id],
        |r| r.get(0),
    )
}

pub fn set_canonical_hash(conn: &Connection, item_id: i64, hash: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE items SET canonical_hash=?2, updated_at=datetime('now') WHERE id=?1",
        params![item_id, hash],
    )?;
    Ok(())
}

/// Each place an item lives: (placement_id, location_label, root_path, rel_path).
pub fn placements_for_item(
    conn: &Connection,
    item_id: i64,
) -> rusqlite::Result<Vec<(i64, String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, l.label, l.root_path, p.rel_path
         FROM placements p JOIN locations l ON p.location_id = l.id
         WHERE p.item_id = ?1 ORDER BY l.label",
    )?;
    let rows = stmt.query_map(params![item_id], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
    })?;
    rows.collect()
}

/// Every placement across all (non-deleted) items, joined with its item's canonical
/// hash — feeds the Deploy mode "map view" (one status roll-up per location instead
/// of drilling into each item individually).
/// Returns (placement_id, location_id, location_label, root_path, rel_path, canonical_hash).
pub fn all_placements_with_hash(
    conn: &Connection,
) -> rusqlite::Result<Vec<(i64, i64, String, String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, l.id, l.label, l.root_path, p.rel_path, i.canonical_hash
         FROM placements p
         JOIN locations l ON p.location_id = l.id
         JOIN items i ON p.item_id = i.id
         WHERE i.deleted = 0
         ORDER BY l.label",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
    })?;
    rows.collect()
}

/// Like `all_placements_with_hash` but also returns the placement's stored
/// `location_hash` (the baseline recorded at last sync — the "last common sync"
/// ancestor used for 3-way conflict detection). Returns
/// (placement_id, location_label, root_path, rel_path, canonical_hash, baseline_hash).
pub fn placements_for_conflict_check(
    conn: &Connection,
) -> rusqlite::Result<Vec<(i64, String, String, String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, l.label, l.root_path, p.rel_path, i.canonical_hash, p.location_hash
         FROM placements p
         JOIN locations l ON p.location_id = l.id
         JOIN items i ON p.item_id = i.id
         WHERE i.deleted = 0
         ORDER BY l.label",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
    })?;
    rows.collect()
}

/// (item_id, root_path, rel_path) for one placement.
pub fn placement_paths(conn: &Connection, placement_id: i64) -> rusqlite::Result<(i64, String, String)> {
    conn.query_row(
        "SELECT p.item_id, l.root_path, p.rel_path
         FROM placements p JOIN locations l ON p.location_id = l.id WHERE p.id = ?1",
        params![placement_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
}

pub fn update_placement_sync(
    conn: &Connection,
    placement_id: i64,
    hash: &str,
    status: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE placements SET location_hash=?2, status=?3, last_scanned=datetime('now') WHERE id=?1",
        params![placement_id, hash, status],
    )?;
    Ok(())
}

pub fn upsert_placement(
    conn: &Connection,
    item_id: i64,
    location_id: i64,
    rel_path: &str,
    location_hash: &str,
    status: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO placements (item_id, location_id, rel_path, location_hash, status)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(item_id, location_id) DO UPDATE SET
            rel_path = excluded.rel_path,
            location_hash = excluded.location_hash,
            status = excluded.status,
            last_scanned = datetime('now')",
        params![item_id, location_id, rel_path, location_hash, status],
    )?;
    Ok(())
}

pub fn list_items(conn: &Connection) -> rusqlite::Result<Vec<Item>> {
    query_items(conn, "archived = 0 AND deleted = 0")
}

pub fn list_archived(conn: &Connection) -> rusqlite::Result<Vec<Item>> {
    query_items(conn, "archived = 1 AND deleted = 0")
}

/// Tombstoned (soft-deleted) items — shown in the Deleted view, restorable.
pub fn list_deleted(conn: &Connection) -> rusqlite::Result<Vec<Item>> {
    query_items(conn, "deleted = 1")
}

pub fn item_type(conn: &Connection, id: i64) -> rusqlite::Result<String> {
    conn.query_row("SELECT item_type FROM items WHERE id = ?1", params![id], |r| r.get(0))
}

const ITEM_COLUMNS: &str = "id, item_type, name, slug, description, category, subcategory,
     object, sub_object, verb, qualifier, canonical_hash, library_path, has_variants, archived,
     last_used_at, use_count";

fn map_item_row(r: &rusqlite::Row) -> rusqlite::Result<Item> {
    let type_str: String = r.get(1)?;
    Ok(Item {
        id: r.get(0)?,
        item_type: ItemType::parse(&type_str).unwrap_or(ItemType::Skill),
        name: r.get(2)?,
        slug: r.get(3)?,
        description: r.get(4)?,
        category: r.get(5)?,
        subcategory: r.get(6)?,
        object: r.get(7)?,
        sub_object: r.get(8)?,
        verb: r.get(9)?,
        qualifier: r.get(10)?,
        canonical_hash: r.get(11)?,
        library_path: r.get(12)?,
        has_variants: r.get::<_, i64>(13)? != 0,
        archived: r.get::<_, i64>(14)? != 0,
        last_used_at: r.get(15)?,
        use_count: r.get(16)?,
    })
}

/// `where_clause` is a trusted, code-supplied SQL condition (never user input).
fn query_items(conn: &Connection, where_clause: &str) -> rusqlite::Result<Vec<Item>> {
    let sql = format!(
        "SELECT {ITEM_COLUMNS} FROM items WHERE {where_clause} ORDER BY name COLLATE NOCASE"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], map_item_row)?;
    rows.collect()
}

/// Items not yet classified (object IS NULL), for the AI classifier. Returns (id, name, description).
pub fn unclassified_items(conn: &Connection) -> rusqlite::Result<Vec<(i64, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, description FROM items WHERE object IS NULL AND archived = 0 AND deleted = 0 ORDER BY id",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    rows.collect()
}

/// Store the canonical classification (Object / Sub / Verb / Qualifier) for an item.
pub fn set_classification(
    conn: &Connection,
    item_id: i64,
    object: Option<&str>,
    sub_object: Option<&str>,
    verb: Option<&str>,
    qualifier: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE items SET object=?2, sub_object=?3, verb=?4, qualifier=?5,
                          updated_at=datetime('now') WHERE id=?1",
        params![item_id, object, sub_object, verb, qualifier],
    )?;
    Ok(())
}

pub fn set_archived(conn: &Connection, item_id: i64, archived: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE items SET archived=?2, updated_at=datetime('now') WHERE id=?1",
        params![item_id, archived as i64],
    )?;
    Ok(())
}

pub fn set_deleted(conn: &Connection, item_id: i64, deleted: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE items SET deleted=?2, updated_at=datetime('now') WHERE id=?1",
        params![item_id, deleted as i64],
    )?;
    Ok(())
}

/// True if an item with this (type, slug) exists AND is tombstoned. Re-import
/// consults this so a user-deleted item is not resurrected from its still-present source.
pub fn is_tombstoned(conn: &Connection, item_type: ItemType, slug: &str) -> rusqlite::Result<bool> {
    let deleted: Option<i64> = conn
        .query_row(
            "SELECT deleted FROM items WHERE item_type = ?1 AND slug = ?2",
            params![item_type.as_str(), slug],
            |r| r.get(0),
        )
        .optional()?;
    Ok(deleted == Some(1))
}

pub fn list_verb_map(conn: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt =
        conn.prepare("SELECT canonical, synonym FROM verb_map ORDER BY canonical, synonym")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

pub fn add_synonym(conn: &Connection, canonical: &str, synonym: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO verb_map (canonical, synonym) VALUES (?1, ?2)",
        params![canonical, synonym.to_ascii_lowercase()],
    )?;
    Ok(())
}

pub fn remove_synonym(conn: &Connection, synonym: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM verb_map WHERE synonym = ?1",
        params![synonym.to_ascii_lowercase()],
    )?;
    Ok(())
}

/// Session-independent duplicate-cluster dismissals ("not actually a duplicate"),
/// keyed by the same `DupGroup.key` the frontend already groups by (e.g.
/// `"Ax › Form — Create"`). Persisted so Triage doesn't re-surface a dismissed
/// cluster after an app restart.
pub fn dismiss_cluster(conn: &Connection, cluster_key: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO dismissed_clusters (cluster_key) VALUES (?1)",
        params![cluster_key],
    )?;
    Ok(())
}

pub fn undismiss_cluster(conn: &Connection, cluster_key: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM dismissed_clusters WHERE cluster_key = ?1",
        params![cluster_key],
    )?;
    Ok(())
}

pub fn list_dismissed_clusters(conn: &Connection) -> rusqlite::Result<std::collections::HashSet<String>> {
    let mut stmt = conn.prepare("SELECT cluster_key FROM dismissed_clusters")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    rows.collect()
}

// ---- user-defined tags (orthogonal to the AI taxonomy) ----

/// Attach a tag to an item (idempotent). Tags are lowercased+trimmed for consistency.
pub fn add_item_tag(conn: &Connection, item_id: i64, tag: &str) -> rusqlite::Result<()> {
    let t = tag.trim().to_ascii_lowercase();
    if t.is_empty() {
        return Ok(());
    }
    conn.execute(
        "INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?1, ?2)",
        params![item_id, t],
    )?;
    Ok(())
}

pub fn remove_item_tag(conn: &Connection, item_id: i64, tag: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM item_tags WHERE item_id = ?1 AND tag = ?2",
        params![item_id, tag.trim().to_ascii_lowercase()],
    )?;
    Ok(())
}

/// All (item_id, tag) pairs, so the frontend can build an id→tags map in one round-trip.
pub fn list_item_tags(conn: &Connection) -> rusqlite::Result<Vec<(i64, String)>> {
    let mut stmt = conn.prepare("SELECT item_id, tag FROM item_tags ORDER BY tag")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

/// Distinct tag names with their item counts, for the sidebar filter list.
pub fn list_all_tags(conn: &Connection) -> rusqlite::Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT t.tag, COUNT(*)
         FROM item_tags t JOIN items i ON t.item_id = i.id
         WHERE i.deleted = 0
         GROUP BY t.tag ORDER BY t.tag",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

/// Distinct non-null verbs currently assigned to live items, with counts —
/// "uncanonical" verbs for the verb-governance UI.
pub fn distinct_verbs_with_counts(conn: &Connection) -> rusqlite::Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT verb, COUNT(*)
         FROM items
         WHERE verb IS NOT NULL AND verb <> '' AND deleted = 0
         GROUP BY verb ORDER BY verb",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

/// Append an entry to the activity log (audit trail powering the Dashboard feed).
pub fn log_activity(conn: &Connection, kind: &str, summary: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO activity_log (kind, summary) VALUES (?1, ?2)",
        params![kind, summary],
    )?;
    Ok(())
}

/// Most-recent activity entries first: (id, kind, summary, created_at).
pub fn recent_activity(conn: &Connection, limit: i64) -> rusqlite::Result<Vec<(i64, String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, summary, created_at FROM activity_log ORDER BY id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
    })?;
    rows.collect()
}

/// Read a setting value by key (None if unset).
pub fn get_setting(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
        .optional()
}

/// Upsert a setting value.
pub fn set_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// Delete a setting (no-op if absent).
pub fn delete_setting(conn: &Connection, key: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
    Ok(())
}

/// Record a "use" of an item: bump use_count and stamp last_used_at to now.
pub fn mark_item_used(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE items SET use_count = use_count + 1, last_used_at = datetime('now') WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

/// Stale candidates: live (non-deleted, non-archived) items never marked used, oldest
/// created first — the "candidates for deletion" review queue.
pub fn never_used_items(conn: &Connection) -> rusqlite::Result<Vec<Item>> {
    let sql = format!(
        "SELECT {ITEM_COLUMNS} FROM items \
         WHERE deleted = 0 AND archived = 0 AND use_count = 0 \
         ORDER BY created_at ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], map_item_row)?;
    rows.collect()
}

/// Lowercased synonym → canonical verb, from the editable verb map.
pub fn verb_lookup(
    conn: &Connection,
) -> rusqlite::Result<std::collections::HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT synonym, canonical FROM verb_map")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut map = std::collections::HashMap::new();
    for row in rows {
        let (syn, canon) = row?;
        map.insert(syn.to_ascii_lowercase(), canon);
    }
    Ok(map)
}

pub fn set_verb(conn: &Connection, item_id: i64, verb: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE items SET verb=?2, updated_at=datetime('now') WHERE id=?1",
        params![item_id, verb],
    )?;
    Ok(())
}

pub fn list_locations(conn: &Connection) -> rusqlite::Result<Vec<Location>> {
    let mut stmt =
        conn.prepare("SELECT id, label, root_path, kind, enabled FROM locations ORDER BY id")?;
    let rows = stmt.query_map([], |r| {
        let kind_str: String = r.get(3)?;
        Ok(Location {
            id: r.get(0)?,
            label: r.get(1)?,
            root_path: r.get(2)?,
            kind: match kind_str.as_str() {
                "marketplace" => LocationKind::Marketplace,
                "agents" => LocationKind::Agents,
                "project" => LocationKind::Project,
                "codex" => LocationKind::Codex,
                "tarball" => LocationKind::Tarball,
                _ => LocationKind::ClaudeSkills,
            },
            enabled: r.get::<_, i64>(4)? != 0,
        })
    })?;
    rows.collect()
}

/// Insert a user scan dir if (path, item_type) is new; return its id.
pub fn add_scan_dir(conn: &Connection, path: &str, item_type: ItemType) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT OR IGNORE INTO scan_dirs (path, item_type) VALUES (?1, ?2)",
        params![path, item_type.as_str()],
    )?;
    conn.query_row(
        "SELECT id FROM scan_dirs WHERE path = ?1 AND item_type = ?2",
        params![path, item_type.as_str()],
        |r| r.get(0),
    )
}

pub fn list_scan_dirs(conn: &Connection) -> rusqlite::Result<Vec<ScanDir>> {
    let mut stmt = conn.prepare("SELECT id, path, item_type, enabled FROM scan_dirs ORDER BY id")?;
    let rows = stmt.query_map([], |r| {
        let t: String = r.get(2)?;
        Ok(ScanDir {
            id: r.get(0)?,
            path: r.get(1)?,
            item_type: ItemType::parse(&t).unwrap_or(ItemType::Skill),
            enabled: r.get::<_, i64>(3)? != 0,
        })
    })?;
    rows.collect()
}

pub fn remove_scan_dir(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM scan_dirs WHERE id = ?1", params![id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn location_upsert_is_idempotent() {
        let c = open_in_memory().unwrap();
        let id1 = upsert_location(&c, "skills", "/a/b", LocationKind::ClaudeSkills).unwrap();
        let id2 = upsert_location(&c, "skills", "/a/b", LocationKind::ClaudeSkills).unwrap();
        assert_eq!(id1, id2);
        assert_eq!(list_locations(&c).unwrap().len(), 1);
    }

    #[test]
    fn item_insert_then_absent_on_second() {
        let c = open_in_memory().unwrap();
        let (id, new1) = insert_item_if_absent(
            &c,
            ItemType::Skill,
            "Babysit",
            "babysit",
            "d",
            "h1",
            "lib/babysit",
        )
        .unwrap();
        let (id2, new2) = insert_item_if_absent(
            &c,
            ItemType::Skill,
            "Babysit",
            "babysit",
            "d",
            "h1",
            "lib/babysit",
        )
        .unwrap();
        assert!(new1 && !new2);
        assert_eq!(id, id2);
        assert_eq!(item_canonical_hash(&c, id).unwrap(), "h1");
        let items = list_items(&c).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].item_type, ItemType::Skill);
    }

    #[test]
    fn placement_upsert_is_idempotent() {
        let c = open_in_memory().unwrap();
        let (item_id, _) =
            insert_item_if_absent(&c, ItemType::Skill, "x", "x", "d", "h", "lib/x").unwrap();
        let loc_id = upsert_location(&c, "skills", "/a", LocationKind::ClaudeSkills).unwrap();
        upsert_placement(&c, item_id, loc_id, "x", "h", "in_sync").unwrap();
        upsert_placement(&c, item_id, loc_id, "x", "h", "in_sync").unwrap();
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM placements", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn has_variants_flag_round_trips() {
        let c = open_in_memory().unwrap();
        let (id, _) =
            insert_item_if_absent(&c, ItemType::Skill, "x", "x", "d", "h", "lib/x").unwrap();
        set_has_variants(&c, id, true).unwrap();
        assert!(list_items(&c).unwrap()[0].has_variants);
    }

    #[test]
    fn scan_dirs_crud() {
        let c = open_in_memory().unwrap();
        let id = add_scan_dir(&c, "/my/agents", ItemType::Agent).unwrap();
        add_scan_dir(&c, "/my/agents", ItemType::Agent).unwrap(); // idempotent
        let dirs = list_scan_dirs(&c).unwrap();
        assert_eq!(dirs.len(), 1);
        assert_eq!(dirs[0].item_type, ItemType::Agent);
        assert_eq!(dirs[0].path, "/my/agents");
        remove_scan_dir(&c, id).unwrap();
        assert!(list_scan_dirs(&c).unwrap().is_empty());
    }

    #[test]
    fn classification_round_trips() {
        let c = open_in_memory().unwrap();
        let (id, _) =
            insert_item_if_absent(&c, ItemType::Skill, "x", "x", "d", "h", "lib/x").unwrap();
        set_classification(&c, id, Some("Ax"), Some("Form"), Some("Create"), Some("Expert")).unwrap();
        let items = list_items(&c).unwrap();
        let it = &items[0];
        assert_eq!(it.object.as_deref(), Some("Ax"));
        assert_eq!(it.sub_object.as_deref(), Some("Form"));
        assert_eq!(it.verb.as_deref(), Some("Create"));
        assert_eq!(it.qualifier.as_deref(), Some("Expert"));
    }

    #[test]
    fn archived_items_are_hidden() {
        let c = open_in_memory().unwrap();
        let (id, _) =
            insert_item_if_absent(&c, ItemType::Skill, "x", "x", "d", "h", "lib/x").unwrap();
        assert_eq!(list_items(&c).unwrap().len(), 1);
        set_archived(&c, id, true).unwrap();
        assert!(list_items(&c).unwrap().is_empty());
    }

    #[test]
    fn deleted_items_are_tombstoned_hidden_and_restorable() {
        let c = open_in_memory().unwrap();
        let (id, _) =
            insert_item_if_absent(&c, ItemType::Skill, "x", "x", "d", "h", "lib/x").unwrap();
        assert!(!is_tombstoned(&c, ItemType::Skill, "x").unwrap());

        set_deleted(&c, id, true).unwrap();
        assert!(list_items(&c).unwrap().is_empty(), "hidden from library");
        assert!(list_archived(&c).unwrap().is_empty(), "and from archived");
        assert_eq!(list_deleted(&c).unwrap().len(), 1, "shown in deleted view");
        assert!(is_tombstoned(&c, ItemType::Skill, "x").unwrap());
        // A different slug is not tombstoned.
        assert!(!is_tombstoned(&c, ItemType::Skill, "y").unwrap());

        set_deleted(&c, id, false).unwrap();
        assert_eq!(list_items(&c).unwrap().len(), 1, "restore brings it back");
        assert!(list_deleted(&c).unwrap().is_empty());
    }

    #[test]
    fn verb_map_is_seeded_and_editable() {
        let c = open_in_memory().unwrap();
        let map = list_verb_map(&c).unwrap();
        assert!(map.iter().any(|(canon, syn)| canon == "Create" && syn == "generate"));
        add_synonym(&c, "Create", "Spawn").unwrap();
        assert!(list_verb_map(&c).unwrap().iter().any(|(_, s)| s == "spawn"));
        remove_synonym(&c, "spawn").unwrap();
        assert!(!list_verb_map(&c).unwrap().iter().any(|(_, s)| s == "spawn"));
    }

    #[test]
    fn placements_join_and_update() {
        let c = open_in_memory().unwrap();
        let (item_id, _) =
            insert_item_if_absent(&c, ItemType::Skill, "x", "x", "d", "h", "lib/x").unwrap();
        let loc = upsert_location(&c, "Claude skills", "/home/.claude/skills", LocationKind::ClaudeSkills).unwrap();
        upsert_placement(&c, item_id, loc, "x", "h", "in_sync").unwrap();

        let places = placements_for_item(&c, item_id).unwrap();
        assert_eq!(places.len(), 1);
        let (pid, label, root, rel) = places[0].clone();
        assert_eq!((label, root, rel), ("Claude skills".into(), "/home/.claude/skills".into(), "x".into()));

        let (it, root2, rel2) = placement_paths(&c, pid).unwrap();
        assert_eq!(it, item_id);
        assert_eq!((root2, rel2), ("/home/.claude/skills".into(), "x".into()));

        update_placement_sync(&c, pid, "newhash", "drifted").unwrap();
        let status: String = c
            .query_row("SELECT status FROM placements WHERE id=?1", [pid], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "drifted");
    }

    #[test]
    fn verb_lookup_and_set_verb() {
        let c = open_in_memory().unwrap();
        add_synonym(&c, "Create", "Fabricate").unwrap();
        let m = verb_lookup(&c).unwrap();
        assert_eq!(m.get("fabricate").map(String::as_str), Some("Create"));
        assert_eq!(m.get("generate").map(String::as_str), Some("Create")); // seeded
        let (id, _) =
            insert_item_if_absent(&c, ItemType::Skill, "x", "x", "d", "h", "lib/x").unwrap();
        set_verb(&c, id, "Create").unwrap();
        assert_eq!(list_items(&c).unwrap()[0].verb.as_deref(), Some("Create"));
    }

    #[test]
    fn all_placements_with_hash_joins_across_locations_and_skips_deleted() {
        let c = open_in_memory().unwrap();
        let (item1, _) =
            insert_item_if_absent(&c, ItemType::Skill, "a", "a", "d", "hash1", "lib/a").unwrap();
        let (item2, _) =
            insert_item_if_absent(&c, ItemType::Skill, "b", "b", "d", "hash2", "lib/b").unwrap();
        let loc1 = upsert_location(&c, "Claude skills", "/home/.claude/skills", LocationKind::ClaudeSkills).unwrap();
        let loc2 = upsert_location(&c, "Codex skills", "/home/.codex/skills", LocationKind::Codex).unwrap();
        upsert_placement(&c, item1, loc1, "a", "hash1", "in_sync").unwrap();
        upsert_placement(&c, item2, loc1, "b", "hash2", "in_sync").unwrap();
        upsert_placement(&c, item2, loc2, "b", "hash2", "in_sync").unwrap();

        let rows = all_placements_with_hash(&c).unwrap();
        assert_eq!(rows.len(), 3);
        // Every row carries its item's *current* canonical hash (for fresh status derivation).
        assert!(rows.iter().any(|(_, lid, _, _, _, hash)| *lid == loc1 && hash == "hash1"));
        assert!(rows.iter().filter(|(_, lid, _, _, _, _)| *lid == loc2).count() == 1);

        // Soft-deleting an item's placements should drop out of the roll-up.
        conn_mark_deleted(&c, item1);
        let rows2 = all_placements_with_hash(&c).unwrap();
        assert_eq!(rows2.len(), 2);
    }

    /// Test-only helper: tombstone an item directly (mirrors what `delete_items` does at
    /// the DB layer) so `all_placements_with_hash`'s `WHERE i.deleted = 0` filter can be
    /// exercised without pulling in the full commands-layer delete flow.
    fn conn_mark_deleted(conn: &Connection, item_id: i64) {
        conn.execute("UPDATE items SET deleted = 1 WHERE id = ?1", params![item_id])
            .unwrap();
    }

    #[test]
    fn dismissed_clusters_persist_and_are_reversible() {
        let c = open_in_memory().unwrap();
        assert!(list_dismissed_clusters(&c).unwrap().is_empty());

        dismiss_cluster(&c, "Ax › Form — Create").unwrap();
        // Idempotent: dismissing twice doesn't error or duplicate.
        dismiss_cluster(&c, "Ax › Form — Create").unwrap();
        let dismissed = list_dismissed_clusters(&c).unwrap();
        assert_eq!(dismissed.len(), 1);
        assert!(dismissed.contains("Ax › Form — Create"));

        undismiss_cluster(&c, "Ax › Form — Create").unwrap();
        assert!(list_dismissed_clusters(&c).unwrap().is_empty());
    }

    #[test]
    fn item_tags_crud_and_counts() {
        let c = open_in_memory().unwrap();
        let (a, _) = insert_item_if_absent(&c, ItemType::Skill, "a", "a", "d", "h", "lib/a").unwrap();
        let (b, _) = insert_item_if_absent(&c, ItemType::Skill, "b", "b", "d", "h", "lib/b").unwrap();

        add_item_tag(&c, a, "Core").unwrap(); // normalizes to lowercase
        add_item_tag(&c, a, "core").unwrap(); // idempotent after normalize
        add_item_tag(&c, b, "core").unwrap();
        add_item_tag(&c, a, "experimental").unwrap();
        add_item_tag(&c, a, "   ").unwrap(); // blank ignored

        let pairs = list_item_tags(&c).unwrap();
        assert_eq!(pairs.iter().filter(|(id, _)| *id == a).count(), 2);

        let tags = list_all_tags(&c).unwrap();
        // "core" on 2 items, "experimental" on 1.
        assert!(tags.iter().any(|(t, n)| t == "core" && *n == 2));
        assert!(tags.iter().any(|(t, n)| t == "experimental" && *n == 1));

        remove_item_tag(&c, a, "Core").unwrap(); // case-insensitive removal
        assert_eq!(
            list_all_tags(&c).unwrap().iter().find(|(t, _)| t == "core").map(|(_, n)| *n),
            Some(1)
        );
    }

    #[test]
    fn activity_log_appends_and_returns_newest_first() {
        let c = open_in_memory().unwrap();
        assert!(recent_activity(&c, 10).unwrap().is_empty());
        log_activity(&c, "import", "Imported 5 new items").unwrap();
        log_activity(&c, "merge", "Merged 2 → 1").unwrap();
        log_activity(&c, "delete", "Deleted 1 item").unwrap();

        let recent = recent_activity(&c, 2).unwrap();
        assert_eq!(recent.len(), 2); // limit honored
        assert_eq!(recent[0].1, "delete"); // newest first
        assert_eq!(recent[1].1, "merge");
    }

    #[test]
    fn settings_upsert_get_delete() {
        let c = open_in_memory().unwrap();
        assert_eq!(get_setting(&c, "openai_api_key").unwrap(), None);
        set_setting(&c, "openai_api_key", "sk-abc").unwrap();
        assert_eq!(get_setting(&c, "openai_api_key").unwrap().as_deref(), Some("sk-abc"));
        set_setting(&c, "openai_api_key", "sk-xyz").unwrap(); // upsert overwrites
        assert_eq!(get_setting(&c, "openai_api_key").unwrap().as_deref(), Some("sk-xyz"));
        delete_setting(&c, "openai_api_key").unwrap();
        assert_eq!(get_setting(&c, "openai_api_key").unwrap(), None);
    }

    #[test]
    fn usage_tracking_marks_and_lists_candidates() {
        let c = open_in_memory().unwrap();
        let (a, _) = insert_item_if_absent(&c, ItemType::Skill, "a", "a", "d", "h", "lib/a").unwrap();
        let (b, _) = insert_item_if_absent(&c, ItemType::Skill, "b", "b", "d", "h", "lib/b").unwrap();

        // Both start unused → both are deletion candidates.
        assert_eq!(never_used_items(&c).unwrap().len(), 2);

        mark_item_used(&c, a).unwrap();
        mark_item_used(&c, a).unwrap(); // count accumulates
        let used = list_items(&c).unwrap().into_iter().find(|i| i.id == a).unwrap();
        assert_eq!(used.use_count, 2);
        assert!(used.last_used_at.is_some());

        // Only the never-used item remains a candidate.
        let cands = never_used_items(&c).unwrap();
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].id, b);
    }
}
