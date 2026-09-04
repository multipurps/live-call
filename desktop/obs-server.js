// NOT WIRED UP YET - see main.js, this module isn't imported/started there.
//
// What this needs to actually be: a local HTTP server implementing the WHEP
// spec (https://www.ietf.org/archive/id/draft-ietf-wish-whep-01.html) so OBS
// Studio's built-in WHEP Media Source can connect to it directly - OBS is the
// one deciding when to connect, so this side has to behave as a real server,
// not a client.
//
// What it is NOT: @eyevinn/whip-endpoint, despite the name being an obvious
// fit at first glance. That package expects you to already be running a
// separate SFU media server (Symphony Media Bridge) plus a separate
// @eyevinn/wrtc-egress service alongside it - it's an orchestration layer for
// people who already operate that infrastructure, not a self-contained
// server you drop into a single-user desktop app. Depending on it here would
// produce something that looks wired up but doesn't actually run standalone.
//
// The realistic path: hand-build a minimal WHEP server on top of `werift`
// (a pure-JS RTCPeerConnection implementation that runs in plain Node, no
// external media server or native bindings needed - https://github.com/shinyoshiaki/werift-webrtc).
// Roughly:
//   1. Node http server exposes POST /whep/live
//   2. On request: new RTCPeerConnection(), addTrack() the local video/audio
//      coming from the Electron renderer's call/swap output
//   3. createAnswer()/setLocalDescription(), respond with the SDP + a
//      Location header per the WHEP spec (this is the part that needs
//      getting exactly right against the spec and real OBS behavior)
//   4. Handle the DELETE the client sends to end the session
//
// This is genuine protocol work I have not been able to verify against a
// real OBS instance (no GUI/OBS available in the environment this was
// written in) - it needs to be built and tested end-to-end on an actual
// desktop machine before it's trusted, not shipped as "should work."
