//! Chisel CAD desktop shell. The app itself is the web build (`../dist`); this
//! crate adds a window and, on request from the settings UI, a local MCP server
//! that lets external agents drive the running document. See `mcp.rs`.

mod mcp;

use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, Manager, State};

use mcp::{Bridge, Forward, McpStatus, ServerHandle};

pub struct AppState {
    bridge: Arc<Bridge>,
    server: Mutex<Option<ServerHandle>>,
}

/// Payload of the `mcp-request` event the webview listens for.
#[derive(Serialize, Clone)]
struct McpRequestEvent {
    id: u64,
    request: Value,
}

fn status_of(state: &AppState) -> McpStatus {
    match state.server.lock().unwrap().as_ref() {
        Some(h) => McpStatus::running(h.port),
        None => McpStatus::stopped(),
    }
}

/// Start (or move to another port) the MCP endpoint. The webview must already be
/// listening for `mcp-request` events, otherwise requests time out.
#[tauri::command]
async fn mcp_start(app: tauri::AppHandle, state: State<'_, AppState>, port: u16) -> Result<McpStatus, String> {
    let existing = state.server.lock().unwrap().take();
    if let Some(h) = existing {
        if h.port == port {
            *state.server.lock().unwrap() = Some(h);
            return Ok(status_of(&state));
        }
        h.stop();
    }
    let forward: Forward = Arc::new(move |id, request| {
        let _ = app.emit("mcp-request", McpRequestEvent { id, request });
    });
    let handle = mcp::start(state.bridge.clone(), forward, port).await?;
    *state.server.lock().unwrap() = Some(handle);
    Ok(status_of(&state))
}

#[tauri::command]
fn mcp_stop(state: State<'_, AppState>) -> McpStatus {
    if let Some(h) = state.server.lock().unwrap().take() {
        h.stop();
    }
    status_of(&state)
}

#[tauri::command]
fn mcp_status(state: State<'_, AppState>) -> McpStatus {
    status_of(&state)
}

/// The webview's answer to an `mcp-request` event.
#[tauri::command]
fn mcp_respond(state: State<'_, AppState>, id: u64, response: Value) -> Result<(), String> {
    if state.bridge.respond(id, response) {
        Ok(())
    } else {
        Err(format!("no pending MCP request #{id} (timed out or already answered)"))
    }
}

/// Write a render the MCP tools produced (a PNG still or MP4 turntable) into
/// `~/Downloads/Chisel CAD/`. The request body is the raw file bytes and the name
/// comes in the `x-filename` header; it must be a plain filename, so an agent can
/// choose what a render is called but never where it lands.
#[tauri::command]
fn save_render(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file bytes as the request body".into());
    };
    let name = request.headers().get("x-filename").and_then(|v| v.to_str().ok()).unwrap_or_default();
    let name = render_file_name(name)?;
    let dir = app.path().download_dir().map_err(|e| e.to_string())?.join("Chisel CAD");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let path = confined_target(&dir, name)?;
    write_no_follow(&path, bytes).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Where `name` lands inside the render folder, refusing anything that could
/// redirect the write elsewhere: the folder or the file being a symlink, or a
/// canonical path outside the folder.
fn confined_target(dir: &std::path::Path, name: &str) -> Result<std::path::PathBuf, String> {
    let is_link = |p: &std::path::Path| std::fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false);
    if is_link(dir) {
        return Err(format!("{} is a symlink; renders are only written to a real folder", dir.display()));
    }
    let root = dir.canonicalize().map_err(|e| format!("cannot resolve {}: {e}", dir.display()))?;
    let path = root.join(name);
    if is_link(&path) {
        return Err(format!("{} is a symlink; refusing to write through it", path.display()));
    }
    if path.parent() != Some(root.as_path()) {
        return Err(format!("{name:?} would land outside {}", root.display()));
    }
    Ok(path)
}

/// Write a file without following a symlink planted at its path after the check.
fn write_no_follow(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os = "linux")]
        const O_NOFOLLOW: i32 = 0o400000;
        #[cfg(not(target_os = "linux"))]
        const O_NOFOLLOW: i32 = 0x0100; // macOS / BSD
        opts.custom_flags(O_NOFOLLOW);
    }
    opts.open(path)?.write_all(bytes)
}

/// Accept only a plain `name.png` / `.mp4` / `.webm`: no path separators, no leading dot.
fn render_file_name(name: &str) -> Result<&str, String> {
    let plain = name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ' '));
    let lower = name.to_ascii_lowercase();
    let known_ext = [".png", ".mp4", ".webm"].iter().any(|e| lower.ends_with(e) && lower.len() > e.len());
    if name.len() > 120 || !plain || name.starts_with('.') || !known_ext {
        return Err(format!("invalid output filename {name:?}"));
    }
    Ok(name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState { bridge: Arc::new(Bridge::default()), server: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![mcp_start, mcp_stop, mcp_status, mcp_respond, save_render])
        .on_window_event(|window, event| {
            // Stop serving when the main window goes away so the port is released.
            if let tauri::WindowEvent::Destroyed = event {
                let state: State<'_, AppState> = window.app_handle().state();
                let handle = state.server.lock().unwrap().take();
                if let Some(h) = handle {
                    h.stop();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Chisel CAD");
}

#[cfg(test)]
mod tests {
    use super::{confined_target, render_file_name, write_no_follow};

    #[test]
    fn render_names_must_be_plain_files() {
        for ok in ["turntable.mp4", "view az30 el45.png", "part-v2_final.webm", "A.PNG"] {
            assert_eq!(render_file_name(ok), Ok(ok));
        }
        for bad in ["", ".png", ".hidden.png", "../x.png", "/etc/x.png", "a/b.mp4", "c:\\x.png", "x.sh", "x.png.sh", "~x.png"] {
            assert!(render_file_name(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn renders_never_write_through_symlinks() {
        let base = std::env::temp_dir().join(format!("chisel-render-test-{}", std::process::id()));
        let dir = base.join("Chisel CAD");
        std::fs::create_dir_all(&dir).unwrap();
        let ok = confined_target(&dir, "a.png").unwrap();
        assert_eq!(ok.parent().unwrap(), dir.canonicalize().unwrap());
        write_no_follow(&ok, b"png").unwrap();
        #[cfg(unix)]
        {
            let outside = base.join("outside.png");
            std::fs::write(&outside, b"keep").unwrap();
            std::os::unix::fs::symlink(&outside, dir.join("link.png")).unwrap();
            assert!(confined_target(&dir, "link.png").is_err());
            assert!(write_no_follow(&dir.join("link.png"), b"x").is_err(), "O_NOFOLLOW must refuse a symlink");
            assert_eq!(std::fs::read(&outside).unwrap(), b"keep");
            let linked_dir = base.join("linked");
            std::os::unix::fs::symlink(&dir, &linked_dir).unwrap();
            assert!(confined_target(&linked_dir, "a.png").is_err());
        }
        std::fs::remove_dir_all(&base).unwrap();
    }
}
