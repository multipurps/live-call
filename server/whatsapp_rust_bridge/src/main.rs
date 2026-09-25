//! whatsapp_rust_bridge - real 1:1 WhatsApp calling for Live Call, built on
//! the real `whatsapp-rust` library (github.com/oxidezap/whatsapp-rust).
//!
//! WHY THIS EXISTS
//! ---------------
//! Live Call already ships two WhatsApp paths and neither one is a real
//! WhatsApp video call:
//!
//!   * `server/greenapi_bridge.mjs` + `@green-api/whatsapp-api-calls-client-js`
//!     in the browser. That library is AUDIO ONLY - confirmed from its own
//!     source. It stays exactly as it is; nothing here touches it.
//!   * `server/whatsapp_bridge.mjs` (Baileys). Its `startCall()` sends a
//!     hand-written `<call><offer>` stanza and then *simulates* an answer
//!     after 2.5 seconds. That is not a call. It is also not imported by
//!     server.mjs any more.
//!
//! This binary is the third path and the only one that places an actual
//! WhatsApp call: whatsapp-rust implements the real call signaling (callKey
//! generation, per-device encryption, `<offer>`/`<accept>`, the relay
//! allocate, DTLS/SCTP/DataChannel, E2E SRTP/SFrame) and exposes real media
//! ports - `AudioSource`/`AudioSink`/`VideoSource`/`VideoSink` - which is
//! what lets the live Lucy 2.5 / Anam avatar output be injected.
//!
//! ARCHITECTURE (see ../README.md for the whole chain)
//! ----------------------------------------------------
//!   Lucy 2.5 (Fal/Decart realtime) or Anam avatar  ->  MediaStream
//!     -> SocialCallMediaAdapter (app.src.js): JPEG @15fps + 16k mono PCM
//!     -> /api/social-call/media WebSocket
//!     -> server.mjs  (channel 0x01 video / 0x02 audio)
//!     -> TCP WA_RUST_MEDIA_PORT
//!     -> media.rs: ffmpeg -> H.264 Annex-B -> `VideoSource`
//!                  s16le  -> 960-sample frames -> `AudioSource`
//!     -> client.voip().call(peer).audio(..).video(..).start()
//!     -> REAL WhatsApp 1:1 call
//!
//!   peer audio/video come back out the same socket (channels 0x03/0x04) and
//!   are forwarded to the browser over the existing media WebSocket.
//!
//! This process is a separate backend from Green API and shares no code, no
//! credentials and no session state with it. Provider selection happens in
//! server.mjs / the frontend; nothing here knows Green API exists.
//!
//! SECURITY
//! --------
//! The WhatsApp session lives in a local SQLite file (`SqliteStore`) inside
//! WA_RUST_DATA_DIR on this host. No credential, identity key or session
//! material is ever returned over HTTP - `/status` reports connection state
//! and the linked number only. The browser never sees it.

mod media;

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::Mutex;
use whatsapp_rust::pair_code::PairCodeOptions;
use whatsapp_rust::prelude::*;
use whatsapp_rust::voip::{CallEvent, CallHandle, CallTermination};

use crate::media::MediaCounters;

const DEFAULT_HTTP_PORT: u16 = 5060;
const DEFAULT_MEDIA_PORT: u16 = 5061;
/// How long `/call` waits for the socket to be up before giving up. Deliberately
/// finite: an unreachable WhatsApp must produce a real error, not a spinner.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(45);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// Mirrors server/tgcalls_bridge's CallState so server.mjs's existing
/// `/call/state` polling and `call_state` broadcast work unchanged for both
/// bridges.
#[derive(Clone, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
enum CallState {
    Idle,
    Ringing,
    Connecting,
    Connected,
    Ended,
    Failed { error: String },
}

#[derive(Clone, Serialize)]
struct OwnAccount {
    jid: String,
    phone: String,
    name: String,
}

#[derive(Clone, Serialize)]
struct PairingArtifact {
    value: String,
    /// Unix seconds; the UI stops showing the artifact past this.
    expires_at: u64,
}

/// A number the app user has called or added through the Live Call UI.
///
/// whatsapp-rust keeps no synced contact directory (its app-state sync does
/// not expose a contact collection through any public API - checked against
/// `wacore::store::traits` and `wacore::appstate_sync`), so "pick a contact"
/// here is: this list, plus `/lookup` which validates a typed number against
/// WhatsApp for real via `Client::contacts().is_on_whatsapp()`.
#[derive(Clone, Serialize, Deserialize)]
struct ContactRow {
    phone: String,
    name: String,
}

struct CallSlot {
    id: String,
    peer: String,
    name: String,
    video: bool,
    /// Which avatar is feeding the video source ('lucy' | 'anam'). Recorded
    /// for the UI/history; the media path itself is avatar-agnostic.
    source: String,
    started_at: Instant,
    handle: Arc<CallHandle>,
    /// Kept alive so `kill_on_drop` terminates ffmpeg when the call ends.
    encoder: Option<tokio::process::Child>,
}

struct AppState {
    client: Option<Arc<Client>>,
    conn: String,
    own: Option<OwnAccount>,
    qr: Option<PairingArtifact>,
    pair_code: Option<PairingArtifact>,
    last_error: Option<String>,
    call_state: CallState,
    call: Option<CallSlot>,
    contacts: Vec<ContactRow>,
    data_dir: String,
}

impl AppState {
    fn new(data_dir: String) -> Self {
        Self {
            client: None,
            conn: "starting".to_string(),
            own: None,
            qr: None,
            pair_code: None,
            last_error: None,
            call_state: CallState::Idle,
            call: None,
            contacts: load_contacts(&data_dir),
            data_dir,
        }
    }

    fn contacts_file(&self) -> std::path::PathBuf {
        std::path::Path::new(&self.data_dir).join("contacts.json")
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn digits_only(input: &str) -> String {
    input.chars().filter(|c| c.is_ascii_digit()).collect()
}

fn load_contacts(data_dir: &str) -> Vec<ContactRow> {
    let path = std::path::Path::new(data_dir).join("contacts.json");
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn save_contacts(state: &AppState) {
    let path = state.contacts_file();
    if let Ok(raw) = serde_json::to_string_pretty(&state.contacts) {
        if let Err(e) = std::fs::write(&path, raw) {
            tracing::warn!("could not persist contacts to {path:?}: {e}");
        }
    }
}

async fn set_call_state(state: &Arc<Mutex<AppState>>, next: CallState) {
    let mut guard = state.lock().await;
    // Report the newest fact, but never resurrect a call that already ended.
    if matches!(guard.call_state, CallState::Ended | CallState::Failed { .. })
        && matches!(next, CallState::Ringing | CallState::Connecting | CallState::Connected)
    {
        return;
    }
    guard.call_state = next;
}

// ---------------------------------------------------------------------------
// Handlers: connection / pairing
// ---------------------------------------------------------------------------

async fn handle_status(state: Arc<Mutex<AppState>>, counters: Arc<MediaCounters>) -> serde_json::Value {
    let guard = state.lock().await;
    let now = now_secs();

    let live = |artifact: &Option<PairingArtifact>| match artifact {
        Some(a) if a.expires_at > now => Some(a.clone()),
        _ => None,
    };

    let call = guard.call.as_ref().map(|slot| {
        json!({
            "id": slot.id,
            "peer": slot.peer,
            "name": slot.name,
            "video": slot.video,
            "source": slot.source,
            "durationSec": slot.started_at.elapsed().as_secs(),
            "muted": slot.handle.is_muted(),
        })
    });

    json!({
        "provider": "whatsapp-rust",
        "status": guard.conn,
        "connected": guard.conn == "connected",
        "user": guard.own,
        "qr": live(&guard.qr).map(|a| a.value),
        "pairingCode": live(&guard.pair_code).map(|a| a.value),
        "error": guard.last_error,
        "media": counters.snapshot(),
        "call": call,
        "callState": guard.call_state,
    })
}

/// Real phone-number pair-code linking: `Client::pair_with_code`, which
/// starts WhatsApp's phone-number linking flow and returns the 8-character
/// code to type into WhatsApp > Linked Devices > Link a Device > Link with
/// phone number instead. QR stays available in parallel (whichever the user
/// completes first wins) - this does not replace it.
async fn handle_pair_code(
    state: Arc<Mutex<AppState>>,
    body: serde_json::Value,
) -> serde_json::Value {
    let phone = digits_only(body.get("phone").and_then(|v| v.as_str()).unwrap_or(""));
    if phone.len() < 7 {
        return json!({ "error": "A full international phone number is required (no +, no spaces)" });
    }
    let custom = body
        .get("customCode")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_uppercase())
        .filter(|s| !s.is_empty());

    let client = {
        let guard = state.lock().await;
        match guard.client.clone() {
            Some(c) => c,
            None => return json!({ "error": "whatsapp-rust bridge has no client yet" }),
        }
    };

    // Must be reachable before a code can be requested - pair_with_code is a
    // server round trip on the live socket.
    if let Err(e) = client.wait_for_connected(Duration::from_secs(30)).await {
        let msg = format!("WhatsApp socket is not connected: {e}");
        state.lock().await.last_error = Some(msg.clone());
        return json!({ "error": msg });
    }

    match client
        .pair_with_code(PairCodeOptions {
            phone_number: phone,
            show_push_notification: true,
            custom_code: custom,
            platform_id: None,
            display_os: None,
        })
        .await
    {
        Ok(code) => {
            let artifact = PairingArtifact { value: code.clone(), expires_at: now_secs() + 180 };
            {
                let mut guard = state.lock().await;
                guard.pair_code = Some(artifact);
                guard.conn = "awaiting_pair".to_string();
                guard.last_error = None;
            }
            json!({ "code": code, "expires_at": now_secs() + 180 })
        }
        // The real error, verbatim: PairError carries WhatsApp's own
        // rejection (including rate-limit backoff), which is exactly what
        // the UI must show rather than a generic "try again".
        Err(e) => {
            let msg = e.to_string();
            state.lock().await.last_error = Some(msg.clone());
            json!({ "error": msg })
        }
    }
}

async fn handle_pair_cancel(state: Arc<Mutex<AppState>>) -> serde_json::Value {
    let client = state.lock().await.client.clone();
    if let Some(client) = client {
        if let Err(e) = client.cancel_pair_code().await {
            return json!({ "error": e.to_string() });
        }
    }
    let mut guard = state.lock().await;
    guard.pair_code = None;
    json!({ "status": "cancelled" })
}

async fn handle_logout(state: Arc<Mutex<AppState>>) -> serde_json::Value {
    let client = state.lock().await.client.clone();
    if let Some(client) = client {
        client.logout().await;
    }
    let mut guard = state.lock().await;
    guard.conn = "disconnected".to_string();
    guard.own = None;
    guard.qr = None;
    guard.pair_code = None;
    json!({ "status": "disconnected" })
}

// ---------------------------------------------------------------------------
// Handlers: contacts
// ---------------------------------------------------------------------------

async fn handle_contacts_get(state: Arc<Mutex<AppState>>) -> serde_json::Value {
    let guard = state.lock().await;
    let contacts: Vec<serde_json::Value> = guard
        .contacts
        .iter()
        .map(|c| {
            json!({
                "id": format!("{}@s.whatsapp.net", c.phone),
                "phone": c.phone,
                "name": c.name,
                "platform": "whatsapp",
            })
        })
        .collect();
    json!({ "contacts": contacts })
}

/// Add/refresh a number in the directory. When the socket is connected this
/// first asks WhatsApp whether the number is actually registered
/// (`Client::contacts().is_on_whatsapp`), so a typo is caught here rather
/// than as a call that rings nobody.
async fn handle_contacts_post(
    state: Arc<Mutex<AppState>>,
    body: serde_json::Value,
) -> serde_json::Value {
    let phone = digits_only(body.get("phone").and_then(|v| v.as_str()).unwrap_or(""));
    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if phone.len() < 7 {
        return json!({ "error": "A full international phone number is required" });
    }

    let mut resolved_name = name.clone();
    let client = state.lock().await.client.clone();
    if let Some(client) = client {
        match lookup_on_whatsapp(&client, &phone).await {
            Ok((registered, display)) => {
                if !registered {
                    return json!({
                        "error": format!("+{phone} is not registered on WhatsApp"),
                        "exists": false,
                    });
                }
                if resolved_name.is_empty() {
                    resolved_name = display.unwrap_or_else(|| format!("+{phone}"));
                }
            }
            Err(e) => return json!({ "error": format!("WhatsApp lookup failed: {e}") }),
        }
    } else if resolved_name.is_empty() {
        resolved_name = format!("+{phone}");
    }

    let mut guard = state.lock().await;
    if let Some(row) = guard.contacts.iter_mut().find(|c| c.phone == phone) {
        row.name = resolved_name.clone();
    } else {
        guard.contacts.push(ContactRow { phone: phone.clone(), name: resolved_name.clone() });
    }
    save_contacts(&guard);
    json!({ "ok": true, "phone": phone, "name": resolved_name })
}

/// Validate/resolve a typed number against WhatsApp for real.
async fn lookup_on_whatsapp(client: &Arc<Client>, phone: &str) -> Result<(bool, Option<String>)> {
    let jid = Jid::new(phone, Server::Pn);
    let results = client
        .contacts()
        .is_on_whatsapp(std::slice::from_ref(&jid))
        .await
        .map_err(|e| anyhow!(e.to_string()))?;
    let Some(result) = results.first() else {
        return Ok((false, None));
    };
    let display = result
        .username
        .as_ref()
        .map(|u| format!("@{u}"))
        .or_else(|| result.verified_name.as_ref().map(|_| "WhatsApp Business".to_string()));
    Ok((result.is_registered, display))
}

async fn handle_lookup(
    state: Arc<Mutex<AppState>>,
    body: serde_json::Value,
) -> serde_json::Value {
    let phone = digits_only(body.get("phone").and_then(|v| v.as_str()).unwrap_or(""));
    if phone.len() < 7 {
        return json!({ "error": "A full international phone number is required" });
    }
    let Some(client) = state.lock().await.client.clone() else {
        return json!({ "error": "whatsapp-rust is not connected yet" });
    };
    if let Err(e) = client.wait_for_connected(Duration::from_secs(20)).await {
        return json!({ "error": format!("WhatsApp socket is not connected: {e}") });
    }
    match lookup_on_whatsapp(&client, &phone).await {
        Ok((registered, display)) => json!({
            "exists": registered,
            "jid": format!("{phone}@s.whatsapp.net"),
            "phone": phone,
            "name": display.unwrap_or_else(|| format!("+{phone}")),
        }),
        Err(e) => json!({ "error": e.to_string() }),
    }
}

// ---------------------------------------------------------------------------
// Handlers: calling
// ---------------------------------------------------------------------------

async fn handle_call_state(state: Arc<Mutex<AppState>>) -> serde_json::Value {
    let guard = state.lock().await;
    let mut value = serde_json::to_value(&guard.call_state).unwrap_or(json!({ "state": "idle" }));
    if let (Some(slot), Some(obj)) = (&guard.call, value.as_object_mut()) {
        obj.insert("callId".to_string(), json!(slot.id));
        obj.insert("durationSec".to_string(), json!(slot.started_at.elapsed().as_secs()));
        obj.insert("video".to_string(), json!(slot.video));
        obj.insert("source".to_string(), json!(slot.source));
        obj.insert("muted".to_string(), json!(slot.handle.is_muted()));
    }
    value
}

async fn handle_mute(state: Arc<Mutex<AppState>>, body: serde_json::Value) -> serde_json::Value {
    let muted = body.get("muted").and_then(|v| v.as_bool()).unwrap_or(false);
    let handle = match state.lock().await.call.as_ref() {
        Some(slot) => slot.handle.clone(),
        None => return json!({ "error": "no active call" }),
    };
    // Real mute: `CallHandle::set_muted` switches the engine to DTX comfort
    // noise AND announces `<mute_v2>` to the peer, so the other phone shows
    // the mute too.
    match handle.set_muted(muted).await {
        Ok(()) => json!({ "ok": true, "muted": handle.is_muted() }),
        Err(e) => json!({ "error": e.to_string() }),
    }
}

async fn handle_hangup(
    state: Arc<Mutex<AppState>>,
    plane: Arc<Mutex<media::MediaPlane>>,
) -> serde_json::Value {
    let slot = state.lock().await.call.take();
    let Some(slot) = slot else {
        state.lock().await.call_state = CallState::Idle;
        return json!({ "ok": true, "status": "no_active_call" });
    };

    // `terminate()` sends the real `<terminate>` to the peer and reports how
    // many of the addressed devices confirmed; `hangup_local()` then aborts
    // our own media task. Dropping the encoder kills ffmpeg (kill_on_drop).
    let notified = match slot.handle.terminate().await {
        CallTermination::PeerNotified => true,
        _ => false,
    };
    slot.handle.hangup_local().await;
    drop(slot.encoder);

    {
        let mut guard = plane.lock().await;
        guard.set_audio_tx(None);
        guard.set_encoder_stdin(None);
    }
    {
        let mut guard = state.lock().await;
        guard.call_state = CallState::Ended;
    }
    json!({ "ok": true, "status": "ended", "callId": slot.id, "peerNotified": notified })
}

/// Place a REAL 1:1 WhatsApp call and wire the live avatar media into it.
async fn place_call(
    state: Arc<Mutex<AppState>>,
    plane: Arc<Mutex<media::MediaPlane>>,
    counters: Arc<MediaCounters>,
    body: serde_json::Value,
) -> serde_json::Value {
    let raw_target = body.get("target").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let phone = digits_only(&raw_target);
    if phone.len() < 7 {
        return json!({ "error": "target must be a full international phone number" });
    }
    // Video defaults ON: the whole point of this backend is real WhatsApp
    // video. `video=false` is a genuine audio-only call, not a fallback.
    let video = body.get("video").and_then(|v| v.as_bool()).unwrap_or(true);
    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("+{phone}"));
    let source = body
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("lucy")
        .to_string();

    let client = match state.lock().await.client.clone() {
        Some(c) => c,
        None => return json!({ "error": "whatsapp-rust bridge has no client yet" }),
    };

    // One call at a time: tear down anything still live first. The lock guard
    // must be dropped BEFORE the body runs - a temporary in an `if` condition
    // lives until the end of the whole statement, and handle_hangup locks the
    // same mutex, which would deadlock.
    let has_live_call = state.lock().await.call.is_some();
    if has_live_call {
        handle_hangup(state.clone(), plane.clone()).await;
    }

    set_call_state(&state, CallState::Ringing).await;

    if let Err(e) = client.wait_for_connected(CONNECT_TIMEOUT).await {
        let msg = format!("WhatsApp is not connected, so no call was placed: {e}");
        state.lock().await.last_error = Some(msg.clone());
        set_call_state(&state, CallState::Failed { error: msg.clone() }).await;
        return json!({ "error": msg });
    }

    // --- media endpoints ---------------------------------------------------
    // These are exactly the ports whatsapp-rust's builder consumes; bare
    // async_channel endpoints implement AudioSource/AudioSink/VideoSource/
    // VideoSink directly (see wacore::voip_control::ports).
    let (mic_tx, mic_rx) = media::audio_channels();
    let (speaker_tx, speaker_rx) = media::speaker_channels();
    let (video_tx, video_rx) = media::video_channels();
    let (peer_video_tx, peer_video_rx) = media::peer_video_channels();

    plane.lock().await.set_audio_tx(Some(mic_tx));
    media::spawn_audio_playout(speaker_rx, plane.clone(), counters.clone());
    media::spawn_video_playout(peer_video_rx, plane.clone(), counters.clone());

    // Outgoing video must be pre-encoded H.264 Annex-B - whatsapp-rust never
    // touches pixels. If ffmpeg is missing a video call is IMPOSSIBLE, so say
    // so instead of quietly ringing an audio-only call the user thinks has video.
    let mut encoder = None;
    if video {
        match media::spawn_h264_encoder(video_tx, plane.clone(), counters.clone()).await {
            Ok(child) => encoder = Some(child),
            Err(e) => {
                let msg = format!("Cannot start outgoing video: {e:#}");
                set_call_state(&state, CallState::Failed { error: msg.clone() }).await;
                plane.lock().await.set_audio_tx(None);
                return json!({ "error": msg });
            }
        }
    }

    // --- place the call ----------------------------------------------------
    let peer = Jid::new(phone.as_str(), Server::Pn);
    let voip = client.voip();
    let mut builder = voip.call(&peer).audio(mic_rx, speaker_tx);
    if video {
        builder = builder.video(video_rx, peer_video_tx);
    }

    let handle = match builder.start().await {
        Ok(h) => h,
        Err(e) => {
            let msg = format!("WhatsApp rejected the call offer: {e}");
            state.lock().await.last_error = Some(msg.clone());
            set_call_state(&state, CallState::Failed { error: msg.clone() }).await;
            plane.lock().await.set_audio_tx(None);
            return json!({ "error": msg });
        }
    };

    let handle = Arc::new(handle);
    let call_id = handle.call_id().to_string();
    {
        let mut guard = state.lock().await;
        guard.call = Some(CallSlot {
            id: call_id.clone(),
            peer: format!("+{phone}"),
            name: name.clone(),
            video,
            source: source.clone(),
            started_at: Instant::now(),
            handle: handle.clone(),
            encoder,
        });
    }

    tracing::info!("[Call] offer sent to +{phone} (call {call_id}, video={video}, source={source})");

    tokio::spawn(watch_call(state.clone(), plane.clone(), counters.clone(), handle));

    json!({
        "ok": true,
        "status": "calling",
        "callId": call_id,
        "peer": format!("+{phone}"),
        "name": name,
        "video": video,
        "source": source,
    })
}

/// Drive the call to its end, translating whatsapp-rust's real `CallEvent`
/// stream (and the peer's `<accept>`) into the CallState server.mjs polls.
///
/// Nothing here is inferred from a timer: `Connected` only happens when the
/// peer's accept actually named the answering device, and `Failed` carries
/// the engine's own reason.
async fn watch_call(
    state: Arc<Mutex<AppState>>,
    plane: Arc<Mutex<media::MediaPlane>>,
    counters: Arc<MediaCounters>,
    handle: Arc<CallHandle>,
) {
    let events = handle.events();
    let mut ticker = tokio::time::interval(Duration::from_millis(500));
    let mut answered = false;

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                // `peer_jid()` returns the device that answered once an
                // `<accept>` has arrived, and the bare offer target before
                // that - so a change means the peer picked up.
                if !answered && handle.peer_jid() != *handle.initial_peer_jid() {
                    answered = true;
                    tracing::info!("[Call] peer answered ({})", handle.peer_jid());
                    set_call_state(&state, CallState::Connected).await;
                }
                // Periodic telemetry so the UI can prove media is moving.
                media::telemetry(&plane, &json!({
                    "type": "media_stats",
                    "callId": handle.call_id(),
                    "answered": answered,
                    "muted": handle.is_muted(),
                    "counters": counters.snapshot(),
                })).await;
            }
            received = events.recv() => {
                let Ok(event) = received else { break };
                match event {
                    CallEvent::RelayAllocated => {
                        tracing::info!("[Call] relay allocated - media path live");
                        if !answered {
                            set_call_state(&state, CallState::Connecting).await;
                        }
                        media::telemetry(&plane, &json!({"type": "relay", "state": "allocated"})).await;
                    }
                    CallEvent::RelayAllocateFailed(code) => {
                        let msg = format!("WhatsApp's media relay rejected the call (STUN error {code})");
                        tracing::error!("[Call] {msg}");
                        set_call_state(&state, CallState::Failed { error: msg }).await;
                        break;
                    }
                    CallEvent::RelayAllocateTimedOut => {
                        let msg = "WhatsApp's media relay never responded - the call could not connect".to_string();
                        tracing::error!("[Call] {msg}");
                        set_call_state(&state, CallState::Failed { error: msg }).await;
                        break;
                    }
                    CallEvent::RelayReconnectTimedOut => {
                        let msg = "Lost WhatsApp's media relay and could not re-establish it".to_string();
                        tracing::error!("[Call] {msg}");
                        set_call_state(&state, CallState::Failed { error: msg }).await;
                        break;
                    }
                    CallEvent::MediaSetupFailed(reason) => {
                        let msg = format!("WhatsApp call media setup failed: {reason}");
                        tracing::error!("[Call] {msg}");
                        set_call_state(&state, CallState::Failed { error: msg }).await;
                        break;
                    }
                    CallEvent::AudioSilent { .. } => {
                        media::telemetry(&plane, &json!({"type": "audio_silent"})).await;
                    }
                    CallEvent::OutboundMediaDropped { .. } => {
                        media::telemetry(&plane, &json!({"type": "outbound_dropped"})).await;
                    }
                    CallEvent::VideoKeyframeNeeded => {
                        media::telemetry(&plane, &json!({"type": "keyframe_needed"})).await;
                    }
                    CallEvent::PeerVideoStateChanged { .. } | CallEvent::VideoStateChanged { .. } => {
                        media::telemetry(&plane, &json!({"type": "peer_video_state"})).await;
                    }
                    CallEvent::Closed(_) => {
                        tracing::info!("[Call] media session closed");
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    handle.wait_ended().await;

    {
        let mut guard = plane.lock().await;
        guard.set_audio_tx(None);
        guard.set_encoder_stdin(None);
    }

    let mut guard = state.lock().await;
    // Only clear OUR call: a hangup that already replaced it must survive.
    let still_ours = guard
        .call
        .as_ref()
        .is_some_and(|slot| slot.id == handle.call_id());
    if still_ours {
        guard.call = None;
        if !matches!(guard.call_state, CallState::Failed { .. }) {
            guard.call_state = CallState::Ended;
        }
    }
    tracing::info!("[Call] {} ended", handle.call_id());
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

fn json_response(value: serde_json::Value) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    tiny_http::Response::from_string(value.to_string()).with_header(
        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
    )
}

#[allow(clippy::too_many_arguments)]
async fn dispatch(
    state: Arc<Mutex<AppState>>,
    plane: Arc<Mutex<media::MediaPlane>>,
    counters: Arc<MediaCounters>,
    method: tiny_http::Method,
    url: &str,
    body: serde_json::Value,
) -> serde_json::Value {
    let path = url.split('?').next().unwrap_or(url);
    match (method, path) {
        (tiny_http::Method::Get, "/health") => json!({ "ok": true, "provider": "whatsapp-rust" }),
        (tiny_http::Method::Get, "/status") => handle_status(state, counters).await,
        (tiny_http::Method::Post, "/pair/code") => handle_pair_code(state, body).await,
        (tiny_http::Method::Post, "/pair/cancel") => handle_pair_cancel(state).await,
        (tiny_http::Method::Post, "/logout") => handle_logout(state).await,
        (tiny_http::Method::Get, "/contacts") => handle_contacts_get(state).await,
        (tiny_http::Method::Post, "/contacts") => handle_contacts_post(state, body).await,
        (tiny_http::Method::Post, "/lookup") => handle_lookup(state, body).await,
        (tiny_http::Method::Get, "/call/state") => handle_call_state(state).await,
        (tiny_http::Method::Post, "/call") => place_call(state, plane, counters, body).await,
        (tiny_http::Method::Post, "/call/mute") => handle_mute(state, body).await,
        (tiny_http::Method::Post, "/hangup") => handle_hangup(state, plane).await,
        _ => json!({ "error": format!("no route for {path}") }),
    }
}

fn run_http_server(
    port: u16,
    state: Arc<Mutex<AppState>>,
    plane: Arc<Mutex<media::MediaPlane>>,
    counters: Arc<MediaCounters>,
    rt: tokio::runtime::Handle,
) -> Result<()> {
    let server = tiny_http::Server::http(format!("127.0.0.1:{port}"))
        .map_err(|e| anyhow!("failed to bind whatsapp_rust_bridge HTTP server: {e}"))?;
    tracing::info!("whatsapp_rust_bridge listening on 127.0.0.1:{port}");

    loop {
        let mut request = match server.recv() {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("tiny_http recv error: {e}");
                continue;
            }
        };

        let mut raw = String::new();
        let _ = std::io::Read::read_to_string(&mut request.as_reader(), &mut raw);
        let body: serde_json::Value = serde_json::from_str(&raw).unwrap_or(json!({}));
        let method = request.method().clone();
        let url = request.url().to_string();

        // The HTTP loop runs on a blocking thread (tiny_http is synchronous);
        // each request is driven on the Tokio runtime that owns the client.
        let value = rt.block_on(dispatch(
            state.clone(),
            plane.clone(),
            counters.clone(),
            method,
            &url,
            body,
        ));
        let _ = request.respond(json_response(value));
    }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

fn data_dir() -> String {
    std::env::var("WA_RUST_DATA_DIR").unwrap_or_else(|_| "data/wa_rust_session".to_string())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_env_filter(
        tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
    ).init();

    let dir = data_dir();
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("create whatsapp-rust data dir {dir}"))?;
    let db_path = std::path::Path::new(&dir).join("whatsapp.db");

    let http_port: u16 = std::env::var("WA_RUST_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_HTTP_PORT);
    let media_port: u16 = std::env::var("WA_RUST_MEDIA_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_MEDIA_PORT);

    let state = Arc::new(Mutex::new(AppState::new(dir)));
    let plane = Arc::new(Mutex::new(media::MediaPlane::new()));
    let counters = Arc::new(MediaCounters::default());

    // --- build + start the real WhatsApp client ----------------------------
    // `SqliteStore` is whatsapp-rust's persistent session: credentials and
    // identity keys live in this file on this host and never leave it.
    let store = SqliteStore::new(db_path.to_string_lossy().as_ref())
        .await
        .map_err(|e| anyhow!("open whatsapp-rust session store: {e}"))?;

    let event_state = state.clone();
    let bot = Bot::builder()
        .with_backend(store)
        .on_event(move |event, client| {
            let state = event_state.clone();
            async move {
                match &*event {
                    Event::Connected(_) => {
                        let own = client.pn().map(|jid| OwnAccount {
                            phone: jid.user.to_string(),
                            jid: jid.to_string(),
                            name: client.push_name(),
                        });
                        let mut guard = state.lock().await;
                        guard.conn = "connected".to_string();
                        guard.last_error = None;
                        if own.is_some() {
                            guard.own = own;
                        }
                        tracing::info!("[WA] connected");
                    }
                    Event::PairSuccess(ps) => {
                        let mut guard = state.lock().await;
                        guard.conn = "connected".to_string();
                        guard.pair_code = None;
                        guard.qr = None;
                        guard.last_error = None;
                        guard.own = Some(OwnAccount {
                            phone: ps.id.user.to_string(),
                            jid: ps.id.to_string(),
                            name: if ps.business_name.is_empty() {
                                client.push_name()
                            } else {
                                ps.business_name.clone()
                            },
                        });
                        tracing::info!("[WA] paired as {}", ps.id);
                    }
                    Event::PairError(pe) => {
                        let mut guard = state.lock().await;
                        guard.conn = "error".to_string();
                        guard.last_error = Some(format!("WhatsApp pairing failed: {}", pe.error));
                        tracing::error!("[WA] pairing failed: {}", pe.error);
                    }
                    Event::PairingQrCode(qr) => {
                        let mut guard = state.lock().await;
                        guard.conn = "scan_qr".to_string();
                        guard.qr = Some(PairingArtifact {
                            value: qr.code.clone(),
                            expires_at: now_secs() + qr.timeout.as_secs(),
                        });
                    }
                    Event::PairingCode(pc) => {
                        let mut guard = state.lock().await;
                        guard.pair_code = Some(PairingArtifact {
                            value: pc.code.clone(),
                            expires_at: now_secs() + pc.timeout.as_secs(),
                        });
                    }
                    Event::PairingCodeError(e) => {
                        // The real rejection from WhatsApp (rate limit, bad
                        // number, ...) - surfaced verbatim, never swallowed.
                        let mut guard = state.lock().await;
                        guard.last_error = Some(format!("Pair code request failed: {}", e.error));
                        tracing::error!("[WA] pair code failed: {}", e.error);
                    }
                    Event::LoggedOut(_) => {
                        let mut guard = state.lock().await;
                        guard.conn = "logged_out".to_string();
                        guard.own = None;
                        guard.last_error = Some(
                            "This device was unlinked from WhatsApp. Pair again to reconnect."
                                .to_string(),
                        );
                        tracing::warn!("[WA] logged out");
                    }
                    Event::Disconnected(_) => {
                        let mut guard = state.lock().await;
                        // Only downgrade from a connected state: the client
                        // reconnects on its own, and reporting "disconnected"
                        // over a routine stream recycle would be wrong.
                        if guard.conn == "connected" {
                            guard.conn = "reconnecting".to_string();
                        }
                    }
                    _ => {}
                }
            }
        })
        .build()
        .await
        .map_err(|e| anyhow!("build whatsapp-rust client: {e}"))?;

    let mut bot_handle = bot.spawn();
    let client = bot_handle.client();
    {
        let mut guard = state.lock().await;
        guard.client = Some(client.clone());
    }

    // --- media ingest + HTTP ----------------------------------------------
    {
        let plane = plane.clone();
        let counters = counters.clone();
        tokio::spawn(async move {
            if let Err(e) = media::run_media_listener(media_port, plane, counters).await {
                tracing::error!("media listener stopped: {e:#}");
            }
        });
    }

    {
        let rt = tokio::runtime::Handle::current();
        let state = state.clone();
        let plane = plane.clone();
        let counters = counters.clone();
        tokio::task::spawn_blocking(move || {
            if let Err(e) = run_http_server(http_port, state, plane, counters, rt) {
                tracing::error!("HTTP server stopped: {e:#}");
            }
        });
    }

    // `bot_handle` keeps the client alive; awaiting it returns on logout or
    // shutdown, which is when this process should exit.
    tokio::select! {
        _ = &mut bot_handle => {
            tracing::warn!("whatsapp-rust client stopped (logout or shutdown)");
        }
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("shutting down");
        }
    }
    Ok(())
}
