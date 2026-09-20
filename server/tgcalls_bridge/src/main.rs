// tgcalls_bridge: real Telegram private (1:1) calling.
//
// This exists because PyTgCalls (used by server/telegram_bridge.py) only
// implements group/channel voice chats - it cannot ring a private contact's
// phone. Real private calling needs the actual phone.requestCall MTProto
// handshake (DH key exchange, call confirmation, WebRTC signaling), which
// this binary implements via the `ferogram` + `tgcalls` (ntgcalls bindings)
// crates. See server/telegram_bridge.py's handle_call for the prior,
// honest-failure-only attempt via PyTgCalls, which this replaces for actual
// call placement.
//
// STATUS: compiles and runs stably on Render (verified via build/runtime
// logs). Auth (send_code/sign_in/session persistence) and call signaling
// (request/connect/run_signaling) are implemented against the crates'
// real source and API, with two real compile errors already found and
// fixed from an actual Render build (see git history) - not just
// speculation. NOT yet tested against a real Telegram account/call end to
// end. The outgoing media path (set_media reading from named pipes that
// server.mjs now writes the frontend's live capture into) is the newest,
// least-verified part - format assumptions (16kHz mono audio, 480x640
// JPEG video) are confirmed correct by reading app.src.js directly, but
// whether ntgcalls' ffmpeg-backed pipe reading actually behaves well with
// a live, slowly-filled FIFO (vs. a real file) hasn't been tested yet.

use std::sync::Arc;
use ferogram::{Client, PasswordToken, SignInError};
use serde_json::json;
use tgcalls::{Media, P2PCall, StreamMode};
use tokio::sync::Mutex;

const SESSION_FILE: &str = "/opt/render/project/src/data/tgcalls_session/tgcalls.session";
const SUPABASE_URL: &str = "https://ewgtpxomgkpbmfyddypw.supabase.co";

#[derive(Clone, serde::Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
enum CallState {
    Idle,
    Ringing,
    Connecting,
    Connected,
    Ended,
    Failed { error: String },
}

struct AppState {
    client: Option<Client>,
    login_token: Option<ferogram::SendCodeOutcome>,
    password_token: Option<Box<PasswordToken>>,
    call_state: CallState,
    // Set when a call is active so /hangup can actually end it.
    hangup_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            client: None,
            login_token: None,
            password_token: None,
            call_state: CallState::Idle,
            hangup_tx: None,
        }
    }
}

fn api_creds() -> (i32, String) {
    let id = std::env::var("TELEGRAM_API_ID")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2040);
    let hash = std::env::var("TELEGRAM_API_HASH")
        .unwrap_or_else(|_| "b18441a1ff607e10a989891a5462e627".to_string());
    (id, hash)
}

fn supabase_key() -> Option<String> {
    std::env::var("SUPABASE_SERVICE_ROLE_KEY").ok()
}

async fn load_saved_session_string() -> Option<String> {
    let key = supabase_key()?;
    let http = reqwest::Client::new();
    let resp = match http
        .get(format!(
            "{SUPABASE_URL}/rest/v1/app_settings?select=tgcalls_session_string&id=eq.true"
        ))
        .header("apikey", &key)
        .header("Authorization", format!("Bearer {key}"))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("[Session] Supabase load request failed: {}", e);
            return None;
        }
    };
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        tracing::warn!("[Session] Supabase load returned {}: {}", status, body);
        return None;
    }
    let rows: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("[Session] Supabase load response wasn't valid JSON: {}", e);
            return None;
        }
    };
    rows.get(0)?
        .get("tgcalls_session_string")?
        .as_str()
        .map(|s| s.to_string())
}

async fn save_session_string(session_string: &str) {
    let Some(key) = supabase_key() else {
        tracing::warn!("[Session] SUPABASE_SERVICE_ROLE_KEY not set - session will not survive a restart");
        return;
    };
    let http = reqwest::Client::new();
    match http
        .post(format!("{SUPABASE_URL}/rest/v1/app_settings"))
        .header("apikey", &key)
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .header("Prefer", "resolution=merge-duplicates")
        .json(&json!({ "id": true, "tgcalls_session_string": session_string }))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            tracing::info!("[Session] Saved tgcalls session to Supabase");
        }
        Ok(resp) => {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            tracing::warn!("[Session] Supabase save returned {}: {}", status, body);
        }
        Err(e) => {
            tracing::warn!("[Session] Supabase save request failed: {}", e);
        }
    }
}

async fn clear_saved_session_string() {
    let Some(key) = supabase_key() else { return };
    let http = reqwest::Client::new();
    match http
        .patch(format!("{SUPABASE_URL}/rest/v1/app_settings?id=eq.true"))
        .header("apikey", &key)
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .json(&json!({ "tgcalls_session_string": null }))
        .send()
        .await
    {
        Ok(resp) if !resp.status().is_success() => {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            tracing::warn!("[Session] Supabase clear returned {}: {}", status, body);
        }
        Err(e) => {
            tracing::warn!("[Session] Supabase clear request failed: {}", e);
        }
        _ => {}
    }
}

/// Gets (or restores, or creates) the ferogram Client. Mirrors
/// telegram_bridge.py's get_client_async(): try a saved session_string from
/// Supabase first (survives Render redeploys), fall back to a local session
/// file (works, but wiped on next redeploy - same limitation as before this
/// existed on the Python side, now fixed there too).
async fn get_or_init_client(state: &mut AppState) -> anyhow::Result<Client> {
    if let Some(c) = &state.client {
        return Ok(c.clone());
    }
    let (api_id, api_hash) = api_creds();

    if let Some(saved) = load_saved_session_string().await {
        tracing::info!("Restoring tgcalls session from Supabase");
        let (client, _shutdown) = Client::builder()
            .api_id(api_id)
            .api_hash(&api_hash)
            .session_string(saved)
            .connect()
            .await?;
        state.client = Some(client.clone());
        return Ok(client);
    }

    if let Some(parent) = std::path::Path::new(SESSION_FILE).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let (client, _shutdown) = Client::builder()
        .api_id(api_id)
        .api_hash(&api_hash)
        .session(SESSION_FILE)
        .connect()
        .await?;
    state.client = Some(client.clone());
    Ok(client)
}

async fn handle_status(state: Arc<Mutex<AppState>>) -> serde_json::Value {
    let mut st = state.lock().await;
    let client = match get_or_init_client(&mut st).await {
        Ok(c) => c,
        Err(e) => return json!({ "connected": false, "error": e.to_string() }),
    };
    match client.is_authorized().await {
        Ok(true) => {
            // Keep Supabase's copy fresh in case this is a freshly-restored
            // session (cheap no-op if unchanged).
            if let Ok(s) = client.export_session_string().await {
                save_session_string(&s).await;
            }
            json!({ "connected": true })
        }
        Ok(false) => json!({ "connected": false }),
        Err(e) => {
            // The cached client's underlying connection may be dead (e.g.
            // "deserialize error: sender task shut down" - its background
            // transport task exited). Without this, every future request
            // would keep reusing the same broken client forever, since
            // get_or_init_client only creates a new one when state.client
            // is None. Drop it so the next request reconnects from scratch.
            st.client = None;
            json!({ "connected": false, "error": e.to_string() })
        }
    }
}

async fn handle_send_code(state: Arc<Mutex<AppState>>, body: serde_json::Value) -> serde_json::Value {
    let Some(phone) = body.get("phone").and_then(|v| v.as_str()) else {
        return json!({ "error": "phone required" });
    };
    let mut st = state.lock().await;
    let client = match get_or_init_client(&mut st).await {
        Ok(c) => c,
        Err(e) => return json!({ "error": e.to_string() }),
    };
    match client.request_login_code(phone).await {
        Ok(ferogram::SendCodeOutcome::CodeRequired(token)) => {
            st.login_token = Some(ferogram::SendCodeOutcome::CodeRequired(token));
            json!({ "status": "code_sent" })
        }
        Ok(ferogram::SendCodeOutcome::AlreadyAuthorized(name)) => {
            // Already signed in (e.g. a previously restored session) - no
            // code needed at all, persist immediately.
            if let Ok(s) = client.export_session_string().await {
                save_session_string(&s).await;
            }
            json!({ "status": "connected", "user": name })
        }
        Err(e) => {
            // Same reasoning as handle_status above - a dead cached
            // connection must not be reused indefinitely.
            st.client = None;
            json!({ "error": e.to_string() })
        }
    }
}

async fn handle_sign_in(state: Arc<Mutex<AppState>>, body: serde_json::Value) -> serde_json::Value {
    let code = body.get("code").and_then(|v| v.as_str()).unwrap_or("");
    let password = body.get("password").and_then(|v| v.as_str());
    let mut st = state.lock().await;
    let Some(client) = st.client.clone() else {
        return json!({ "error": "call send_code first" });
    };
    let Some(outcome) = st.login_token.take() else {
        return json!({ "error": "call send_code first" });
    };
    let ferogram::SendCodeOutcome::CodeRequired(token) = outcome else {
        // AlreadyAuthorized shouldn't reach here - handle_send_code already
        // resolved that case directly - but handle it gracefully anyway.
        return json!({ "status": "connected" });
    };

    let result = client.sign_in(&token, code).await;
    match result {
        Ok(_user) => {
            if let Ok(s) = client.export_session_string().await {
                save_session_string(&s).await;
            }
            let _ = client.save_session().await;
            st.login_token = None;
            json!({ "status": "connected" })
        }
        Err(SignInError::PasswordRequired(password_token)) => {
            if let Some(pw) = password {
                match client.check_password(*password_token, pw).await {
                    Ok(_user) => {
                        if let Ok(s) = client.export_session_string().await {
                            save_session_string(&s).await;
                        }
                        let _ = client.save_session().await;
                        st.login_token = None;
                        st.password_token = None;
                        json!({ "status": "connected" })
                    }
                    Err(e) => json!({ "error": e.to_string() }),
                }
            } else {
                st.password_token = Some(password_token);
                json!({ "status": "2fa_required" })
            }
        }
        Err(e) => json!({ "error": e.to_string() }),
    }
}

async fn handle_disconnect(state: Arc<Mutex<AppState>>) -> serde_json::Value {
    let mut st = state.lock().await;
    st.client = None;
    st.login_token = None;
    st.password_token = None;
    let _ = std::fs::remove_file(SESSION_FILE);
    clear_saved_session_string().await;
    json!({ "status": "disconnected" })
}

async fn handle_call_state(state: Arc<Mutex<AppState>>) -> serde_json::Value {
    let st = state.lock().await;
    serde_json::to_value(&st.call_state).unwrap_or(json!({ "state": "idle" }))
}

async fn handle_hangup(state: Arc<Mutex<AppState>>) -> serde_json::Value {
    let mut st = state.lock().await;
    if let Some(tx) = st.hangup_tx.take() {
        let _ = tx.send(());
    }
    st.call_state = CallState::Ended;
    json!({ "status": "ended" })
}

/// Places a real P2P call: request (rings + waits for accept + DH confirm),
/// connect, set_media from the named pipes server.mjs writes our outgoing
/// audio/video into, run_signaling. Runs in a background task; state.call_state
/// is how the HTTP layer reports progress back (server.mjs polls
/// GET /call/state and forwards it as the existing call_state broadcast, same
/// mechanism already used for WhatsApp/Telegram status events).
async fn run_call(state: Arc<Mutex<AppState>>, target_user_id: i64) {
    let client = {
        let mut st = state.lock().await;
        match get_or_init_client(&mut st).await {
            Ok(c) => c,
            Err(e) => {
                st.call_state = CallState::Failed { error: e.to_string() };
                return;
            }
        }
    };

    {
        let mut st = state.lock().await;
        st.call_state = CallState::Ringing;
    }

    let mut update_stream = client.stream_updates();
    let mut call = P2PCall::new(client, target_user_id);

    // video=true: request an audio+video call, not audio-only.
    let (servers, versions) = match call.request(true, &mut update_stream).await {
        Ok(v) => v,
        Err(e) => {
            let mut st = state.lock().await;
            st.call_state = CallState::Failed { error: e.to_string() };
            return;
        }
    };

    {
        let mut st = state.lock().await;
        st.call_state = CallState::Connecting;
    }

    let (mut sig_out_rx, mut conn_rx) = match call.connect(&servers, &versions, true).await {
        Ok(v) => v,
        Err(e) => {
            let mut st = state.lock().await;
            st.call_state = CallState::Failed { error: e.to_string() };
            return;
        }
    };

    // Outgoing media: named pipes server.mjs writes our live capture into.
    // Format is dictated by what the frontend's SocialCallMediaAdapter
    // actually captures and sends (app.src.js), NOT ffmpeg/audio_raw()'s
    // usual assumptions - confirmed directly from that code:
    //   Audio: raw s16le PCM, 16kHz MONO (AudioContext sampleRate: 16000,
    //     createScriptProcessor(2048, 1, 1) - one input/output channel).
    //     Built manually rather than via Media::audio_raw() both because
    //     that helper hardcodes 48kHz stereo (wrong here) and because it
    //     defaults keep_open: false (fine for a real file, wrong for a
    //     FIFO that should keep being read as data streams in).
    //   Video: 480x640 (portrait) JPEG frames at 15fps, concatenated into
    //     a pipe as MJPEG, decoded by ffmpeg - this path is unverified; a
    //     raw external-frame API (like PyTgCalls' ExternalMedia) is NOT
    //     available on P2PCall in this crate version, only on group
    //     calls, so file/pipe-based ingestion via ffmpeg is the only
    //     option here.
    let media = tgcalls::MediaDescription {
        microphone: Some(tgcalls::AudioDescription {
            media_source: tgcalls::MediaSource::File,
            sample_rate: 16000,
            channel_count: 1,
            input: "/tmp/tgcalls_audio.pcm".to_string(),
            keep_open: true,
        }),
        speaker: None,
        camera: None,
        screen: None,
    };
    if let Err(e) = call.set_media(StreamMode::Capture, &media).await {
        tracing::warn!("set_media (audio) failed: {}", e);
    }
    let video_media = Media::video("/tmp/tgcalls_video.mjpeg", 480, 640, 15);
    if let Err(e) = call.set_media(StreamMode::Capture, &video_media).await {
        tracing::warn!("set_media (video) failed: {}", e);
    }

    let connected = match call.run_signaling(&mut sig_out_rx, &mut conn_rx, &mut update_stream).await {
        Ok(v) => v,
        Err(e) => {
            let mut st = state.lock().await;
            st.call_state = CallState::Failed { error: e.to_string() };
            call.end().await;
            return;
        }
    };

    if !connected {
        let mut st = state.lock().await;
        st.call_state = CallState::Failed { error: "WebRTC connection failed".to_string() };
        call.end().await;
        return;
    }

    {
        let mut st = state.lock().await;
        st.call_state = CallState::Connected;
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mut st = state.lock().await;
        st.hangup_tx = Some(tx);
    }

    // Block here until /hangup fires, keeping `call` alive (dropping it
    // would tear down the WebRTC connection).
    let _ = rx.await;
    call.end().await;

    let mut st = state.lock().await;
    st.call_state = CallState::Ended;
}

fn json_response(value: serde_json::Value) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let body = value.to_string();
    tiny_http::Response::from_string(body)
        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    if supabase_key().is_some() {
        tracing::info!("[Session] SUPABASE_SERVICE_ROLE_KEY is set - will try to persist/restore sessions via Supabase");
    } else {
        tracing::warn!("[Session] SUPABASE_SERVICE_ROLE_KEY not set - sessions will NOT survive a restart");
    }

    let port: u16 = std::env::var("TGCALLS_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5051);
    let state = Arc::new(Mutex::new(AppState::new()));

    let server = tiny_http::Server::http(format!("127.0.0.1:{port}"))
        .map_err(|e| anyhow::anyhow!("failed to bind tgcalls_bridge HTTP server: {e}"))?;
    tracing::info!("tgcalls_bridge listening on 127.0.0.1:{port}");

    loop {
        let mut request = match server.recv() {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("tiny_http recv error: {}", e);
                continue;
            }
        };

        let mut body_str = String::new();
        let _ = request.as_reader().read_to_string(&mut body_str);
        let body: serde_json::Value = serde_json::from_str(&body_str).unwrap_or(json!({}));

        let url = request.url().to_string();
        let method = request.method().clone();
        let state = state.clone();

        let response_value = match (method, url.as_str()) {
            (tiny_http::Method::Get, "/status") => handle_status(state.clone()).await,
            (tiny_http::Method::Post, "/send_code") => handle_send_code(state.clone(), body).await,
            (tiny_http::Method::Post, "/sign_in") => handle_sign_in(state.clone(), body).await,
            (tiny_http::Method::Post, "/disconnect") => handle_disconnect(state.clone()).await,
            (tiny_http::Method::Get, "/call/state") => handle_call_state(state.clone()).await,
            (tiny_http::Method::Post, "/hangup") => handle_hangup(state.clone()).await,
            (tiny_http::Method::Post, "/call") => {
                let target = body.get("target").and_then(|v| v.as_i64());
                match target {
                    Some(target_id) => {
                        // P2PCall (via ntgcalls) wraps a raw native pointer that
                        // isn't Send/Sync, so it can't cross tokio's
                        // multi-threaded work-stealing scheduler - tokio::spawn
                        // requires the whole future to be Send, which a future
                        // holding P2PCall across .await points isn't. Instead,
                        // run the entire call on its own dedicated OS thread
                        // with its own single-threaded runtime, so P2PCall
                        // never needs to move between threads at all.
                        let state_for_call = state.clone();
                        std::thread::spawn(move || {
                            let rt = match tokio::runtime::Builder::new_current_thread()
                                .enable_all()
                                .build()
                            {
                                Ok(rt) => rt,
                                Err(e) => {
                                    tracing::error!("failed to build call thread runtime: {}", e);
                                    return;
                                }
                            };
                            rt.block_on(run_call(state_for_call, target_id));
                        });
                        json!({ "status": "calling" })
                    }
                    None => json!({ "error": "target (numeric Telegram user id) required" }),
                }
            }
            _ => json!({ "error": "not found" }),
        };

        let _ = request.respond(json_response(response_value));
    }
}
