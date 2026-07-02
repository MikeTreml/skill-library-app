use super::*;

#[derive(serde::Serialize)]
pub struct ClassifySummary {
    pub classified: u32,
    pub total: u32,
}

#[derive(serde::Serialize, Clone)]
pub struct ClassifyProgress {
    pub done: u32,
    pub total: u32,
}

/// Trim to None if empty (a free fn so the output borrow ties to the input).
pub(crate) fn opt_str(s: &str) -> Option<&str> {
    if s.trim().is_empty() {
        None
    } else {
        Some(s)
    }
}

#[tauri::command]
pub fn ai_available(state: State<AppState>) -> bool {
    resolve_api_key(&state).is_some()
}

/// Resolve the OpenAI API key: prefer the in-app stored key (settings table),
/// falling back to the OPENAI_API_KEY environment variable. Returns None if neither
/// is present/non-empty.
pub fn resolve_api_key(state: &AppState) -> Option<String> {
    if let Ok(conn) = state.db.lock() {
        if let Ok(Some(k)) = db::get_setting(&conn, "openai_api_key") {
            let k = k.trim().to_string();
            if !k.is_empty() {
                return Some(k);
            }
        }
    }
    ai::api_key()
}

/// Store (or update) the in-app OpenAI API key. Empty input clears the stored key.
#[tauri::command]
pub fn set_api_key(state: State<AppState>, key: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let trimmed = key.trim();
    if trimmed.is_empty() {
        db::delete_setting(&conn, "openai_api_key").map_err(|e| e.to_string())?;
        let _ = db::log_activity(&conn, "settings", "Cleared stored API key");
    } else {
        db::set_setting(&conn, "openai_api_key", trimmed).map_err(|e| e.to_string())?;
        let _ = db::log_activity(&conn, "settings", "Updated stored API key");
    }
    Ok(())
}

/// Whether a key is stored in-app (settings table) and whether the env var is set,
/// so the Settings UI can show the source without ever exposing the secret itself.
#[tauri::command]
pub fn api_key_status(state: State<AppState>) -> Result<(bool, bool), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let stored = db::get_setting(&conn, "openai_api_key")
        .map_err(|e| e.to_string())?
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false);
    Ok((stored, ai::api_key().is_some()))
}

/// Rows queued for classification: (item_id, name, description).
type ClassifyTodo = Vec<(i64, String, String)>;
/// Lowercased verb → canonical verb, from the editable verb map.
type VerbMap = std::collections::HashMap<String, String>;

/// Classify items. `ids = None` → all unclassified; `Some(list)` → exactly those.
/// Emits a `classify-progress` event after each batch.
#[tauri::command]
pub async fn classify_all(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    ids: Option<Vec<i64>>,
) -> Result<ClassifySummary, String> {
    use tauri::Emitter;
    let api_key = resolve_api_key(&state)
        .ok_or("No API key set (add one in Settings or set OPENAI_API_KEY)")?;
    // Scope the guard to this block so it is dropped before the await loop (not Send).
    let (todo, verb_map): (ClassifyTodo, VerbMap) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let todo = match &ids {
            Some(list) => {
                let items = db::list_items(&conn).map_err(|e| e.to_string())?;
                list.iter()
                    .filter_map(|id| {
                        items
                            .iter()
                            .find(|i| i.id == *id)
                            .map(|i| (i.id, i.name.clone(), i.description.clone()))
                    })
                    .collect()
            }
            None => db::unclassified_items(&conn).map_err(|e| e.to_string())?,
        };
        // The editable verb map overrides the model's verb (so verb-map edits take effect).
        let verb_map = db::verb_lookup(&conn).map_err(|e| e.to_string())?;
        (todo, verb_map)
    };
    let total = todo.len() as u32;
    let client = reqwest::Client::new();
    let mut classified = 0u32;
    for chunk in todo.chunks(20) {
        let results =
            ai::classify_batch(&client, &api_key, chunk, crate::taxonomy::CANONICAL_VERBS).await?;
        {
            let conn = state.db.lock().map_err(|e| e.to_string())?;
            for (id, c) in &results {
                let verb = verb_map
                    .get(&c.verb.to_ascii_lowercase())
                    .cloned()
                    .unwrap_or_else(|| c.verb.clone());
                db::set_classification(
                    &conn,
                    *id,
                    opt_str(&c.object),
                    opt_str(&c.sub_object),
                    opt_str(&verb),
                    opt_str(&c.qualifier),
                )
                .map_err(|e| e.to_string())?;
                classified += 1;
            }
        }
        let _ = app.emit(
            "classify-progress",
            ClassifyProgress {
                done: classified,
                total,
            },
        );
    }
    Ok(ClassifySummary { classified, total })
}
