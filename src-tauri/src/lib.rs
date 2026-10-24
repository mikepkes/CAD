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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState { bridge: Arc::new(Bridge::default()), server: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![mcp_start, mcp_stop, mcp_status, mcp_respond])
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
