//! Media plane for the whatsapp-rust bridge: the Rust half of the
//! `AvatarMediaSource -> LiveCallMediaAdapter -> whatsapp-rust` chain.
//!
//! WHAT THIS IS
//! ------------
//! whatsapp-rust moves *pre-encoded* media. Its documented media ports are
//! (see `wacore::voip_control::ports`, re-exported as
//! `whatsapp_rust::voip::{AudioSource, AudioSink, VideoSource, VideoSink}`):
//!
//!   * `AudioSource`  - a channel of 60 ms / 960-sample MONO i16 frames @ 16 kHz
//!   * `AudioSink`    - a channel the call writes decoded peer PCM into
//!   * `VideoSource`  - a channel of complete H.264 Annex-B access units
//!                      (start codes included); "the library never touches
//!                      pixels - the codec lives with the consumer"
//!   * `VideoSink`    - a channel of reassembled peer access units
//!
//! There is deliberately no "push a pixel buffer" API, so a live avatar feed
//! has to be encoded by us before it reaches the crate. That is exactly what
//! whatsapp-rust's own `examples/voip-cli/src/video.rs` does with ffmpeg, and
//! this module is the same shape with the Live Call feed as the input.
//!
//! WIRING
//! ------
//! The frontend already produces both halves of this (see
//! `SocialCallMediaAdapter.startStreaming` in app.src.js) and already sends
//! them over the `/api/social-call/media` WebSocket with a 1-byte channel tag
//! - `0x01` = 480x640 JPEG frame @ ~15 fps (Lucy 2.5 Live Swap OR the Anam
//! avatar; the frontend picks which one is live, this bridge does not care),
//! `0x02` = raw s16le PCM, 16 kHz mono.
//!
//! server.mjs relays those same tagged frames to this process over one TCP
//! socket (WA_RUST_MEDIA_PORT). Ingest here is therefore:
//!
//!   0x01 JPEG  -> ffmpeg stdin (image2pipe) -> libx264 baseline -> Annex-B
//!                 -> AnnexBAuSplitter -> `VideoSource`  -> WhatsApp
//!   0x02 PCM   -> 960-sample i16 frames   -> `AudioSource` -> WhatsApp
//!
//! and the return direction uses the SAME socket with two new tags, so the
//! peer's media gets back to the browser through the existing WebSocket:
//!
//!   0x03 peer PCM audio (s16le 16 kHz mono)   <- `AudioSink`
//!   0x04 peer H.264 access unit (Annex-B)     <- `VideoSink`
//!   0x05 UTF-8 JSON telemetry line (counters, codec events)
//!
//! Frame on the wire, both directions: `[u8 channel][u32 BE length][payload]`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;
use whatsapp_rust::async_channel::{self, Receiver, Sender};
use whatsapp_rust::voip::VideoFrame;
use whatsapp_rust::wacore::voip::h264::{AnnexBAuSplitter, au_has_idr};

// ---------------------------------------------------------------------------
// Channel tags. MUST stay in sync with server.mjs (openWaRustMediaSocket /
// the media WebSocket handler) and app.src.js (SocialCallMediaAdapter and
// handleMediaWsBinary).
// ---------------------------------------------------------------------------
pub const CH_JPEG_IN: u8 = 0x01;
pub const CH_PCM_IN: u8 = 0x02;
pub const CH_PCM_OUT: u8 = 0x03;
pub const CH_H264_OUT: u8 = 0x04;
pub const CH_TELEMETRY_OUT: u8 = 0x05;

/// WhatsApp's call audio rate: 16 kHz mono.
pub const WA_SAMPLE_RATE: u32 = 16_000;
/// One call audio frame: 60 ms @ 16 kHz, per `wacore::voip_control::ports`.
pub const WA_FRAME_SAMPLES: usize = 960;

const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
const READ_CHUNK: usize = 64 * 1024;
/// Bounded so a stalled WhatsApp relay drops frames instead of growing the
/// heap without bound; the drop policy below only ever releases at an IDR.
const VIDEO_CHANNEL_CAP: usize = 8;
const AUDIO_CHANNEL_CAP: usize = 40;
/// Outgoing video geometry. Matches what the frontend actually encodes to
/// JPEG in SocialCallMediaAdapter (480x640 portrait @ 15 fps) so ffmpeg is
/// scaling, not guessing.
const VIDEO_WIDTH: u32 = 480;
const VIDEO_HEIGHT: u32 = 640;
const VIDEO_FPS: u32 = 15;
const VIDEO_BITRATE_KBPS: u32 = 900;
/// GOP in seconds: WhatsApp repeats SPS/PPS and adapts 15 fps -> 720p20, so a
/// short GOP keeps a peer that joins mid-stream from waiting long for an IDR.
const GOP_SECONDS: u32 = 2;

/// Everything the ingest socket and the call need to reach each other.
///
/// Kept OUTSIDE the HTTP/call `AppState` on purpose: the media socket writes
/// here at 15 fps + 60 ms audio cadence and must never contend with (or be
/// blocked by) a long HTTP handler holding the call-state lock.
#[derive(Default)]
pub struct MediaPlane {
    /// Set when a call is placed; the live call's `AudioSource` feeder.
    audio_tx: Option<Sender<Vec<i16>>>,
    /// ffmpeg's stdin for the current call's encoder, when video is on.
    encoder_stdin: Option<ChildStdin>,
    /// The ingest socket's write half, used for the peer's media + telemetry.
    egress: Option<OwnedWriteHalf>,
    /// Partial 16 kHz frame carried between ingest reads.
    pcm_partial: Vec<i16>,
}

impl MediaPlane {
    pub fn new() -> Self {
        Self { pcm_partial: Vec::with_capacity(WA_FRAME_SAMPLES * 2), ..Default::default() }
    }

    /// Attach the live call's audio feeder. `None` detaches (call ended).
    pub fn set_audio_tx(&mut self, tx: Option<Sender<Vec<i16>>>) {
        self.audio_tx = tx;
        self.pcm_partial.clear();
    }

    pub fn set_encoder_stdin(&mut self, stdin: Option<ChildStdin>) {
        // Replacing an encoder: close the old one so ffmpeg sees EOF and exits
        // instead of leaking a child per call.
        if let Some(mut old) = self.encoder_stdin.take() {
            tokio::spawn(async move {
                let _ = old.shutdown().await;
            });
        }
        self.encoder_stdin = stdin;
    }
}

/// Cheap, lock-free counters so `/status` and the telemetry frames can report
/// whether media is actually flowing - the thing that distinguishes a real
/// call from a UI that merely says "connected".
#[derive(Default)]
pub struct MediaCounters {
    pub jpeg_in: AtomicU64,
    pub pcm_bytes_in: AtomicU64,
    pub audio_frames_in: AtomicU64,
    pub aus_encoded: AtomicU64,
    pub aus_dropped: AtomicU64,
    pub peer_audio_frames: AtomicU64,
    pub peer_video_aus: AtomicU64,
}

impl MediaCounters {
    pub fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "jpegFramesIn": self.jpeg_in.load(Ordering::Relaxed),
            "pcmBytesIn": self.pcm_bytes_in.load(Ordering::Relaxed),
            "audioFramesIn": self.audio_frames_in.load(Ordering::Relaxed),
            "h264AusEncoded": self.aus_encoded.load(Ordering::Relaxed),
            "h264AusDropped": self.aus_dropped.load(Ordering::Relaxed),
            "peerAudioFrames": self.peer_audio_frames.load(Ordering::Relaxed),
            "peerVideoAus": self.peer_video_aus.load(Ordering::Relaxed),
        })
    }
}

/// One tagged frame: `[u8 channel][u32 BE length][payload]`.
fn frame(channel: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.push(channel);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// Write one tagged frame to the browser via the ingest socket's write half.
/// A missing/closed socket is normal (no call UI open yet), never an error.
pub async fn egress(plane: &Arc<Mutex<MediaPlane>>, channel: u8, payload: &[u8]) {
    let bytes = frame(channel, payload);
    let mut guard = plane.lock().await;
    if let Some(writer) = guard.egress.as_mut() {
        if writer.write_all(&bytes).await.is_err() {
            guard.egress = None;
        }
    }
}

/// Send a JSON telemetry line the frontend can render in the call UI.
pub async fn telemetry(plane: &Arc<Mutex<MediaPlane>>, value: &serde_json::Value) {
    let text = value.to_string();
    egress(plane, CH_TELEMETRY_OUT, text.as_bytes()).await;
}

// ---------------------------------------------------------------------------
// Ingest: the TCP socket server.mjs writes the live avatar frames into.
// ---------------------------------------------------------------------------

/// Accept ingest sockets until the process exits. One active socket at a time
/// is the whole model - there is one live call and one browser tab driving it.
pub async fn run_media_listener(
    port: u16,
    plane: Arc<Mutex<MediaPlane>>,
    counters: Arc<MediaCounters>,
) -> Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .with_context(|| format!("bind whatsapp_rust_bridge media socket on 127.0.0.1:{port}"))?;
    tracing::info!("whatsapp_rust_bridge media ingest listening on 127.0.0.1:{port}");

    loop {
        let (sock, peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("media accept failed: {e}");
                continue;
            }
        };
        tracing::info!("media ingest connected from {peer}");
        let plane = plane.clone();
        let counters = counters.clone();
        tokio::spawn(async move {
            handle_media_socket(sock, &plane, &counters).await;
            tracing::info!("media ingest disconnected from {peer}");
        });
    }
}

async fn handle_media_socket(
    sock: TcpStream,
    plane: &Arc<Mutex<MediaPlane>>,
    counters: &Arc<MediaCounters>,
) {
    let _ = sock.set_nodelay(true);
    let (mut reader, writer) = sock.into_split();
    {
        let mut guard = plane.lock().await;
        // A new socket replaces the old one for egress: the newest browser is
        // the one that should be hearing/seeing the peer.
        guard.egress = Some(writer);
    }

    let mut header = [0u8; 5];
    loop {
        if reader.read_exact(&mut header).await.is_err() {
            break;
        }
        let channel = header[0];
        let len = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
        if len == 0 || len > MAX_FRAME_BYTES {
            tracing::warn!("media ingest sent an implausible frame length {len}; closing socket");
            break;
        }
        let mut payload = vec![0u8; len];
        if reader.read_exact(&mut payload).await.is_err() {
            break;
        }

        match channel {
            CH_JPEG_IN => {
                counters.jpeg_in.fetch_add(1, Ordering::Relaxed);
                let mut guard = plane.lock().await;
                if let Some(stdin) = guard.encoder_stdin.as_mut() {
                    // ffmpeg's image2pipe demuxer reads concatenated JPEGs off
                    // stdin; a short write here just backpressures the encoder.
                    if stdin.write_all(&payload).await.is_err() {
                        tracing::warn!("ffmpeg stdin closed - video encoder died mid-call");
                        guard.encoder_stdin = None;
                    }
                }
            }
            CH_PCM_IN => {
                counters.pcm_bytes_in.fetch_add(payload.len() as u64, Ordering::Relaxed);
                push_pcm(plane, counters, &payload).await;
            }
            other => {
                tracing::debug!("ignoring unknown media channel 0x{other:02x}");
            }
        }
    }

    // Socket gone: stop the encoder (EOF makes ffmpeg exit) and drop the
    // egress half so peer media stops being written into a dead pipe.
    let mut guard = plane.lock().await;
    guard.egress = None;
    if let Some(mut stdin) = guard.encoder_stdin.take() {
        let _ = stdin.shutdown().await;
    }
}

/// s16le mono -> 960-sample frames -> the live call's `AudioSource`.
///
/// The frontend's ScriptProcessor emits 2048-sample chunks, which is not a
/// multiple of 960, hence the carry buffer: whatsapp-rust's PCM adapter
/// requires EXACTLY 960 samples per frame (`wacore::voip_control::ports`).
async fn push_pcm(plane: &Arc<Mutex<MediaPlane>>, counters: &Arc<MediaCounters>, payload: &[u8]) {
    let samples: Vec<i16> = payload
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect();

    let mut guard = plane.lock().await;
    guard.pcm_partial.extend_from_slice(&samples);

    let Some(tx) = guard.audio_tx.clone() else {
        // No live call: discard rather than buffer forever.
        guard.pcm_partial.clear();
        return;
    };

    while guard.pcm_partial.len() >= WA_FRAME_SAMPLES {
        let frame_samples: Vec<i16> = guard.pcm_partial.drain(..WA_FRAME_SAMPLES).collect();
        counters.audio_frames_in.fetch_add(1, Ordering::Relaxed);
        // try_send, never send().await: an audio frame that cannot be sent
        // right now is stale 60 ms later, and VoIP is loss tolerant.
        let _ = tx.try_send(frame_samples);
    }
}

// ---------------------------------------------------------------------------
// Outgoing video: JPEG frames -> H.264 Annex-B access units.
// ---------------------------------------------------------------------------

fn encoder_args() -> Vec<String> {
    // Mirrors whatsapp-rust's own voip-cli encoder (examples/voip-cli/src/
    // video.rs::encoder_args): H.264 Constrained Baseline, repeated SPS/PPS,
    // AUD-delimited, one slice per frame, zero-latency preset. WhatsApp's
    // video is H.264 Constrained Baseline (avc1.42E01F) per the crate's own
    // `src/voip/video.rs` doc comment.
    let gop = (VIDEO_FPS * GOP_SECONDS).to_string();
    let fps = VIDEO_FPS.to_string();
    let bitrate = format!("{VIDEO_BITRATE_KBPS}k");
    let buf = format!("{}k", VIDEO_BITRATE_KBPS * 2);
    let filter = format!(
        "scale={VIDEO_WIDTH}:{VIDEO_HEIGHT}:force_original_aspect_ratio=decrease,\
         pad={VIDEO_WIDTH}:{VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p"
    );
    [
        "-vf".to_string(),
        filter,
        "-r".into(),
        fps,
        "-fps_mode".into(),
        "cfr".into(),
        "-c:v".into(),
        "libx264".into(),
        "-profile:v".into(),
        "baseline".into(),
        "-level:v".into(),
        "3.1".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-preset".into(),
        "veryfast".into(),
        "-tune".into(),
        "zerolatency".into(),
        "-g".into(),
        gop.clone(),
        "-keyint_min".into(),
        gop,
        "-sc_threshold".into(),
        "0".into(),
        "-b:v".into(),
        bitrate.clone(),
        "-maxrate".into(),
        bitrate,
        "-bufsize".into(),
        buf,
        "-x264-params".into(),
        "repeat-headers=1:sliced-threads=0:threads=1".into(),
        "-bsf:v".into(),
        "h264_metadata=aud=insert".into(),
        "-an".into(),
        "-f".into(),
        "h264".into(),
        "pipe:1".into(),
    ]
}

/// Spawn ffmpeg with its stdin piped (server.mjs's JPEG frames go in there)
/// and its stdout piped (Annex-B H.264 comes out), then run the reader task
/// that turns stdout into one access unit per `VideoSource` item.
///
/// Returns the child so the caller can keep `kill_on_drop` armed for the life
/// of the call; dropping it terminates ffmpeg.
pub async fn spawn_h264_encoder(
    video_tx: Sender<Vec<u8>>,
    plane: Arc<Mutex<MediaPlane>>,
    counters: Arc<MediaCounters>,
) -> Result<Child> {
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-loglevel", "error"]);
    // image2pipe on stdin: the frontend's canvas.toBlob('image/jpeg') output,
    // concatenated. `-framerate 15` is the assumed cadence of that stream,
    // matching SocialCallMediaAdapter's 1000/15 interval and
    // `VIDEO_TS_STRIDE_15FPS` (the default `VideoSource::rtp_timestamp_stride`).
    cmd.args([
        "-f".to_string(),
        "image2pipe".into(),
        "-framerate".into(),
        VIDEO_FPS.to_string(),
        "-i".into(),
        "pipe:0".into(),
    ]);
    cmd.args(encoder_args());
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);

    let mut child = cmd.spawn().context(
        "spawn ffmpeg for outgoing H.264 (WhatsApp video needs pre-encoded \
         H.264 Annex-B; ffmpeg must be installed on PATH)",
    )?;

    let stdout = child.stdout.take().context("ffmpeg stdout pipe")?;
    let stdin = child.stdin.take().context("ffmpeg stdin pipe")?;
    {
        // `.await`, not `blocking_lock()`: this runs on a Tokio worker inside
        // the HTTP handler, where blocking the thread would panic.
        let mut guard = plane.lock().await;
        guard.set_encoder_stdin(Some(stdin));
    }

    tokio::spawn(read_encoder(stdout, video_tx, counters));
    Ok(child)
}

async fn read_encoder(
    mut stdout: tokio::process::ChildStdout,
    video_tx: Sender<Vec<u8>>,
    counters: Arc<MediaCounters>,
) {
    let mut splitter = AnnexBAuSplitter::default();
    let mut buf = vec![0u8; READ_CHUNK];
    let mut aus: Vec<Vec<u8>> = Vec::new();
    // When the channel backs up we drop - but only from a keyframe boundary,
    // because an arbitrary dropped AU corrupts the peer's decode until the
    // next IDR anyway. Same policy as whatsapp-rust's own example.
    let mut dropping = false;
    let mut first_idr_seen = false;

    loop {
        match stdout.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                splitter.push(&buf[..n], &mut aus);
                for au in aus.drain(..) {
                    let is_idr = au_has_idr(&au);
                    // Hold back everything before the first IDR: without an
                    // IDR + SPS/PPS the peer has nothing to start decoding from.
                    if !first_idr_seen {
                        if !is_idr {
                            counters.aus_dropped.fetch_add(1, Ordering::Relaxed);
                            continue;
                        }
                        first_idr_seen = true;
                    }
                    if dropping {
                        if !is_idr {
                            counters.aus_dropped.fetch_add(1, Ordering::Relaxed);
                            continue;
                        }
                        dropping = false;
                    }
                    match video_tx.try_send(au) {
                        Ok(()) => {
                            counters.aus_encoded.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(async_channel::TrySendError::Full(_)) => {
                            counters.aus_dropped.fetch_add(1, Ordering::Relaxed);
                            dropping = true;
                        }
                        // Call over: stop reading so ffmpeg's stdout write
                        // fails and the encoder exits.
                        Err(async_channel::TrySendError::Closed(_)) => return,
                    }
                }
            }
            Err(e) => {
                tracing::warn!("ffmpeg stdout read failed: {e}");
                break;
            }
        }
    }

    // `if let .. && ..` is an edition-2024 let-chain; this crate is edition
    // 2021, so the tail flush is spelled out longhand.
    if let Some(last) = splitter.finish() {
        if video_tx.try_send(last).is_ok() {
            counters.aus_encoded.fetch_add(1, Ordering::Relaxed);
        }
    }
}

// ---------------------------------------------------------------------------
// Incoming media: the call's AudioSink / VideoSink -> back to the browser.
// ---------------------------------------------------------------------------

/// Drain the call's `AudioSink` and forward decoded peer PCM to the browser.
pub fn spawn_audio_playout(
    rx: Receiver<Vec<i16>>,
    plane: Arc<Mutex<MediaPlane>>,
    counters: Arc<MediaCounters>,
) {
    tokio::spawn(async move {
        while let Ok(samples) = rx.recv().await {
            counters.peer_audio_frames.fetch_add(1, Ordering::Relaxed);
            let mut bytes = Vec::with_capacity(samples.len() * 2);
            for s in samples {
                bytes.extend_from_slice(&s.to_le_bytes());
            }
            egress(&plane, CH_PCM_OUT, &bytes).await;
        }
    });
}

/// Drain the call's `VideoSink` and forward peer H.264 access units.
pub fn spawn_video_playout(
    rx: Receiver<VideoFrame>,
    plane: Arc<Mutex<MediaPlane>>,
    counters: Arc<MediaCounters>,
) {
    tokio::spawn(async move {
        while let Ok(frame) = rx.recv().await {
            counters.peer_video_aus.fetch_add(1, Ordering::Relaxed);
            egress(&plane, CH_H264_OUT, &frame.data).await;
        }
    });
}

/// Make the two channel pairs a call needs, shaped exactly like the ports
/// `whatsapp_rust::voip`'s builder consumes (bare `async_channel` endpoints
/// implement `AudioSource`/`AudioSink`/`VideoSource`/`VideoSink` directly).
pub fn audio_channels() -> (Sender<Vec<i16>>, Receiver<Vec<i16>>) {
    async_channel::bounded(AUDIO_CHANNEL_CAP)
}

pub fn speaker_channels() -> (Sender<Vec<i16>>, Receiver<Vec<i16>>) {
    async_channel::bounded(AUDIO_CHANNEL_CAP)
}

pub fn video_channels() -> (Sender<Vec<u8>>, Receiver<Vec<u8>>) {
    async_channel::bounded(VIDEO_CHANNEL_CAP)
}

pub fn peer_video_channels() -> (Sender<VideoFrame>, Receiver<VideoFrame>) {
    async_channel::bounded(VIDEO_CHANNEL_CAP)
}
