# Live Call & Swap — Desktop

Electron shell around the same web app used on mobile/PWA. Reuses 100% of the
existing app by loading the deployed URL — no separate copy to maintain.

## How OBS integration actually works (corrected from an earlier, wrong plan)

Not WHIP/WHEP (an earlier version of this doc proposed that — wrong tool for
this job, dropped). **It's a virtual camera**, the same mechanism apps like
Avatarify and Snap Camera use: this app writes raw video frames into a
shared-memory region that a separate, pre-built capture filter
([UnityCaptureFilter](https://github.com/schellingb/UnityCapture) — despite
the name, no Unity engine involved, just a DirectShow filter DLL) exposes to
Windows as a normal camera device. OBS then just picks it from the same
dropdown as any real webcam.

## Current state

- **Works now:** the shell itself (`npm install && npm start` opens the real
  app), and `unity-capture-sender.js` — a from-scratch port of
  UnityCaptureFilter's actual shared-memory protocol (named mutex/events +
  a fixed-offset header struct, read directly from its source, not guessed).
- **Set up required, one-time, per machine:** download a UnityCaptureFilter
  release from the link above and run its `Install.bat` — this registers
  the actual camera device Windows/OBS will see. No compiler needed for
  this step, it's a pre-built DLL + script.
- **Not yet verified:** the sender code has not been run against a real
  UnityCaptureFilter install or real OBS — there's no Windows machine in the
  environment this was written in. The protocol is byte-for-byte from the
  real source, but "should be correct" is not the same as "tested." If
  frames don't appear once wired up, check (in order): the filter is
  actually installed (`Install.bat` ran without error), OBS's source is
  pointed at the right device name, and that koffi loaded correctly
  (`npm start` console will show errors if not).
- **macOS:** deliberately not attempted the same way. macOS requires any
  code installing a system-level camera device to be signed and notarized
  by Apple (Developer Program, $99/year) — there's no equivalent
  "just run a script" path there. `obsCaptureAvailable` is `false` on macOS
  for this reason; building that path is separate work once there's a way
  to sign it.

## Running it

```
cd desktop
npm install
npm start
```

Set `LIVE_CALL_URL` to point at a different deployment (e.g. `localhost:3000`
while developing the web app itself) instead of the default production URL.

## Packaging

`npm run dist` (electron-builder) is configured in package.json but has not
been run/verified — do that on the target OS before distributing anything.
