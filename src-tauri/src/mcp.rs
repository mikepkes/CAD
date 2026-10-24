//! Local MCP endpoint for the desktop app.
//!
//! The Rust side is *transport only*: it serves MCP's Streamable HTTP transport
//! (JSON-RPC over `POST /mcp`, stateless, JSON responses) on 127.0.0.1 and
//! bridges every request into the webview, where the app answers it with the
//! same tool set it already exposes over WebMCP — so an external MCP client
//! (Claude Code, Claude Desktop, …) drives the *live* document the user sees.
//!
//! Flow:  HTTP POST → `Bridge::request` → forward(id, json) (a Tauri event)
//!        → webview handles JSON-RPC → `mcp_respond` command → oneshot → HTTP 200.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::Router;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::oneshot;

/// How long a single tool call may take before the HTTP request fails. Kernel
/// rebuilds and renders can be slow on a big model, so be generous.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Delivers a request to the webview. In the app this emits a Tauri event; in
/// tests it's a closure that answers directly.
pub type Forward = Arc<dyn Fn(u64, Value) + Send + Sync>;

/// Correlates in-flight HTTP requests with the webview's answers.
#[derive(Default)]
pub struct Bridge {
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
}

impl Bridge {
    pub async fn request(&self, forward: &Forward, request: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        forward(id, request);
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(_)) => {
                self.pending.lock().unwrap().remove(&id);
                Err("app dropped the request".into())
            }
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("app did not answer within {}s", timeout.as_secs()))
            }
        }
    }

    /// Complete a pending request. Returns false if nothing was waiting for `id`.
    pub fn respond(&self, id: u64, response: Value) -> bool {
        match self.pending.lock().unwrap().remove(&id) {
            Some(tx) => tx.send(response).is_ok(),
            None => false,
        }
    }

    #[cfg(test)]
    pub fn pending_count(&self) -> usize {
        self.pending.lock().unwrap().len()
    }
}

#[derive(Clone)]
struct Ctx {
    bridge: Arc<Bridge>,
    forward: Forward,
}

#[derive(Serialize, Clone, Debug)]
pub struct McpStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub url: Option<String>,
}

impl McpStatus {
    pub fn stopped() -> Self {
        McpStatus { running: false, port: None, url: None }
    }
    pub fn running(port: u16) -> Self {
        McpStatus { running: true, port: Some(port), url: Some(format!("http://127.0.0.1:{port}/mcp")) }
    }
}

/// A running server; dropping the shutdown sender stops it.
pub struct ServerHandle {
    pub port: u16,
    shutdown: Option<oneshot::Sender<()>>,
}

impl ServerHandle {
    pub fn stop(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

pub fn router(bridge: Arc<Bridge>, forward: Forward) -> Router {
    Router::new()
        .route("/", get(root))
        .route("/mcp", any(mcp_endpoint))
        .with_state(Ctx { bridge, forward })
}

/// Bind 127.0.0.1:`port` and serve until the returned handle is stopped/dropped.
/// Must be called from within a tokio runtime (Tauri's async runtime qualifies).
pub async fn start(bridge: Arc<Bridge>, forward: Forward, port: u16) -> Result<ServerHandle, String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("cannot listen on 127.0.0.1:{port}: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let (tx, rx) = oneshot::channel::<()>();
    let app = router(bridge, forward);
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    Ok(ServerHandle { port, shutdown: Some(tx) })
}

async fn root() -> Response {
    json_response(
        StatusCode::OK,
        &json!({ "name": "chisel-cad", "transport": "streamable-http", "endpoint": "/mcp" }),
    )
}

async fn mcp_endpoint(State(ctx): State<Ctx>, method: axum::http::Method, headers: HeaderMap, body: Bytes) -> Response {
    // DNS-rebinding guard (MCP spec): browsers send Origin; only accept local ones.
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        if !is_local_origin(origin) {
            return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
        }
    }
    match method {
        axum::http::Method::POST => {
            // Require JSON. A cross-origin POST can only set a non-JSON (simple)
            // content type without a CORS preflight, so insisting on
            // application/json forces a preflight that this server never answers
            // — closing the simple-request path to driving the document.
            let ct = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
            if !ct.to_ascii_lowercase().contains("application/json") {
                return (StatusCode::UNSUPPORTED_MEDIA_TYPE, "content-type must be application/json").into_response();
            }
            handle_post(&ctx, body).await
        }
        // No server-initiated stream (stateless server): tell the client so.
        axum::http::Method::GET => StatusCode::METHOD_NOT_ALLOWED.into_response(),
        // Session termination: nothing to terminate.
        axum::http::Method::DELETE => StatusCode::OK.into_response(),
        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }
}

/// Is this a request from the local machine (the DNS-rebinding guard)?
///
/// The host must match *exactly* — a prefix test would let `localhost.evil.com`
/// (an attacker domain DNS-rebound to 127.0.0.1) pass and defeat the guard. So
/// parse off the scheme and any port and compare the bare host.
fn is_local_origin(origin: &str) -> bool {
    let o = origin.trim().to_ascii_lowercase();
    if o == "null" || o.starts_with("tauri://") {
        return true; // Tauri's own webview origins
    }
    let rest = match o.strip_prefix("http://").or_else(|| o.strip_prefix("https://")) {
        Some(r) => r,
        None => return false, // only http(s) and tauri:// are local transports
    };
    // Host is everything before the path/query, minus a trailing :port. Keep
    // IPv6 brackets intact ("[::1]:5173" → "[::1]"; "[::1]" has no port to strip).
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = match host.rfind(':') {
        Some(idx) if !host[idx..].contains(']') => &host[..idx],
        _ => host,
    };
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "tauri.localhost")
}

async fn handle_post(ctx: &Ctx, body: Bytes) -> Response {
    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                &rpc_error(Value::Null, -32700, &format!("parse error: {e}")),
            )
        }
    };
    match parsed {
        Value::Array(items) => {
            // JSON-RPC batch (allowed by older protocol revisions).
            let mut out = Vec::new();
            for item in items {
                if let Some(r) = dispatch_one(ctx, item).await {
                    out.push(r);
                }
            }
            if out.is_empty() {
                StatusCode::ACCEPTED.into_response()
            } else {
                json_response(StatusCode::OK, &Value::Array(out))
            }
        }
        item @ Value::Object(_) => match dispatch_one(ctx, item).await {
            Some(r) => json_response(StatusCode::OK, &r),
            None => StatusCode::ACCEPTED.into_response(),
        },
        _ => json_response(
            StatusCode::BAD_REQUEST,
            &rpc_error(Value::Null, -32600, "invalid request: expected a JSON-RPC object"),
        ),
    }
}

/// Returns a response for requests; `None` for notifications and client responses.
async fn dispatch_one(ctx: &Ctx, msg: Value) -> Option<Value> {
    let is_request = msg.get("method").is_some() && msg.get("id").map_or(false, |id| !id.is_null());
    if !is_request {
        return None;
    }
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    match ctx.bridge.request(&ctx.forward, msg, REQUEST_TIMEOUT).await {
        Ok(resp) => Some(resp),
        Err(e) => Some(rpc_error(id, -32000, &e)),
    }
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn json_response(status: StatusCode, v: &Value) -> Response {
    let mut r = (status, v.to_string()).into_response();
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    /// A fake webview: answers every forwarded request by echoing its method.
    fn echo_bridge() -> (Arc<Bridge>, Forward) {
        let bridge = Arc::new(Bridge::default());
        let b2 = bridge.clone();
        let forward: Forward = Arc::new(move |id, req| {
            let b = b2.clone();
            tokio::spawn(async move {
                let rid = req.get("id").cloned().unwrap_or(Value::Null);
                let method = req.get("method").cloned().unwrap_or(Value::Null);
                b.respond(id, json!({ "jsonrpc": "2.0", "id": rid, "result": { "method": method } }));
            });
        });
        (bridge, forward)
    }

    async fn post(router: Router, body: &str) -> (StatusCode, Value) {
        let resp = router
            .oneshot(
                Request::post("/mcp")
                    .header("content-type", "application/json")
                    .header("origin", "http://localhost:5173")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let v = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap() };
        (status, v)
    }

    #[tokio::test]
    async fn request_round_trips_through_bridge() {
        let (bridge, forward) = echo_bridge();
        let r = router(bridge.clone(), forward);
        let (status, v) = post(r, r#"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["id"], 7);
        assert_eq!(v["result"]["method"], "tools/list");
        assert_eq!(bridge.pending_count(), 0);
    }

    #[tokio::test]
    async fn notifications_get_202_and_are_not_forwarded() {
        let bridge = Arc::new(Bridge::default());
        let forward: Forward = Arc::new(|_, _| panic!("notification must not be forwarded"));
        let r = router(bridge, forward);
        let (status, v) = post(r, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).await;
        assert_eq!(status, StatusCode::ACCEPTED);
        assert_eq!(v, Value::Null);
    }

    #[tokio::test]
    async fn batch_returns_only_responses() {
        let (bridge, forward) = echo_bridge();
        let r = router(bridge, forward);
        let (status, v) = post(
            r,
            r#"[{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","id":"a","method":"ping"}]"#,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v.as_array().unwrap().len(), 1);
        assert_eq!(v[0]["id"], "a");
    }

    #[tokio::test]
    async fn foreign_origin_is_rejected() {
        let (bridge, forward) = echo_bridge();
        let resp = router(bridge, forward)
            .oneshot(
                Request::post("/mcp")
                    .header("origin", "https://evil.example")
                    .body(Body::from(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn is_local_origin_matches_host_exactly() {
        // Genuinely local.
        assert!(is_local_origin("http://localhost:5173"));
        assert!(is_local_origin("http://127.0.0.1:4673"));
        assert!(is_local_origin("http://[::1]:5173"));
        assert!(is_local_origin("http://[::1]"));
        assert!(is_local_origin("https://localhost"));
        assert!(is_local_origin("tauri://localhost"));
        assert!(is_local_origin("http://tauri.localhost"));
        assert!(is_local_origin("null"));
        // Prefix-bypass attempts the old starts_with() check let through.
        assert!(!is_local_origin("http://localhost.evil.com"));
        assert!(!is_local_origin("http://127.0.0.1.evil.com"));
        assert!(!is_local_origin("http://localhostx"));
        assert!(!is_local_origin("http://127.0.0.1.example.com:5173"));
        assert!(!is_local_origin("https://evil.example"));
        assert!(!is_local_origin("ftp://localhost"));
    }

    #[tokio::test]
    async fn localhost_subdomain_origin_is_rejected() {
        let (bridge, forward) = echo_bridge();
        let resp = router(bridge, forward)
            .oneshot(
                Request::post("/mcp")
                    .header("origin", "http://localhost.evil.com")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn non_json_content_type_is_rejected() {
        // A browser can send text/plain cross-origin without a CORS preflight; it
        // must not reach the document even from an allowed-looking origin.
        let (bridge, forward) = echo_bridge();
        let resp = router(bridge, forward)
            .oneshot(
                Request::post("/mcp")
                    .header("origin", "http://localhost:5173")
                    .header("content-type", "text/plain")
                    .body(Body::from(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }

    #[tokio::test]
    async fn unanswered_request_times_out_with_rpc_error() {
        let bridge = Arc::new(Bridge::default());
        let forward: Forward = Arc::new(|_, _| {});
        let v = bridge
            .request(&forward, json!({"id": 1, "method": "ping"}), Duration::from_millis(20))
            .await;
        assert!(v.is_err());
        assert_eq!(bridge.pending_count(), 0);
    }

    #[tokio::test]
    async fn bad_json_is_a_parse_error() {
        let (bridge, forward) = echo_bridge();
        let (status, v) = post(router(bridge, forward), "{nope").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(v["error"]["code"], -32700);
    }
}
