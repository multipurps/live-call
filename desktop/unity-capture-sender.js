// Sends frames into a UnityCaptureFilter virtual camera device on Windows,
// so OBS (or Zoom, Teams, anything with a camera dropdown) can select it as
// a normal Video Capture Device - exactly the mechanism apps like Avatarify
// and Snap Camera use, just built on someone else's pre-built, MIT-licensed
// capture filter instead of writing our own DirectShow filter from scratch.
//
// The receiving side (the actual camera device Windows sees) is
// UnityCaptureFilter, from https://github.com/schellingb/UnityCapture -
// despite the name, it needs no Unity engine, it's just a DirectShow filter
// DLL + an install script. Download a release, run Install.bat once (or
// InstallMultipleDevices.bat for more than one device) - that's the only
// setup step, and it needs no compiler, just running a provided .bat file.
//
// This file is the SENDER side: it implements the exact shared-memory
// protocol that filter reads from, ported line-for-line from its own source
// (Source/shared.inl in that repo, the `Open(ForReceiving=false)` and
// `Send()` methods specifically) rather than guessed. Every named
// object/struct-offset below is a direct translation of that C++ code - see
// the comments pointing at each.
//
// STATUS: written carefully against the real protocol, but NOT run against
// a real UnityCaptureFilter install or real OBS - there is no Windows
// machine available in the environment this was written in. Treat this as
// "should be correct" pending an actual test, not "confirmed working."
// If frames don't show up, the first things to check are: filter actually
// installed (regsvr32 succeeded), device name matches, and byte order
// (UnityCapture expects RGBA - see FORMAT_UINT8 below).

const koffi = require('koffi');

if (process.platform !== 'win32') {
  module.exports = null; // this mechanism is Windows-only, see main.js
} else {

const kernel32 = koffi.load('kernel32.dll');

// Win32 function signatures - koffi's syntax, see https://koffi.dev
const OpenMutexA        = kernel32.func('void* __stdcall OpenMutexA(uint32 dwDesiredAccess, bool bInheritHandle, str lpName)');
const CreateEventA      = kernel32.func('void* __stdcall CreateEventA(void* lpEventAttributes, bool bManualReset, bool bInitialState, str lpName)');
const OpenEventA        = kernel32.func('void* __stdcall OpenEventA(uint32 dwDesiredAccess, bool bInheritHandle, str lpName)');
const OpenFileMappingA  = kernel32.func('void* __stdcall OpenFileMappingA(uint32 dwDesiredAccess, bool bInheritHandle, str lpName)');
const MapViewOfFile     = kernel32.func('void* __stdcall MapViewOfFile(void* hFileMappingObject, uint32 dwDesiredAccess, uint32 dwFileOffsetHigh, uint32 dwFileOffsetLow, size_t dwNumberOfBytesToMap)');
const WaitForSingleObject = kernel32.func('uint32 __stdcall WaitForSingleObject(void* hHandle, uint32 dwMilliseconds)');
const ReleaseMutex      = kernel32.func('bool __stdcall ReleaseMutex(void* hMutex)');
const SetEvent          = kernel32.func('bool __stdcall SetEvent(void* hEvent)');
const CloseHandle       = kernel32.func('bool __stdcall CloseHandle(void* hObject)');

// Constants - from winbase.h / synchapi.h, values are fixed Win32 ABI constants
const SYNCHRONIZE = 0x00100000;
const EVENT_MODIFY_STATE = 0x0002;
const FILE_MAP_WRITE = 0x0002;
const INFINITE = 0xFFFFFFFF;
const WAIT_OBJECT_0 = 0x0;

// From shared.inl: FORMAT_UINT8 = 0 (the enum's first value). We always send
// this - plain 8-bit-per-channel RGBA, no HDR/float formats.
const FORMAT_UINT8 = 0;
const RESIZEMODE_DISABLED = 0;
const MIRRORMODE_DISABLED = 0;

// SharedMemHeader layout from shared.inl, translated field-for-field:
//   DWORD maxSize;   int width; int height; int stride;
//   int format; int resizemode; int mirrormode; int timeout;
//   uint8_t data[1];
// All fields are 4-byte aligned on this struct (no padding surprises since
// every field before `data` is exactly 4 bytes), so the pixel data starts
// at a fixed 32-byte offset.
const HEADER_SIZE = 32;
const MAX_SHARED_IMAGE_SIZE = 3840 * 2160 * 4 * 2; // matches the C++ MAX_SHARED_IMAGE_SIZE macro (4K, RGBA, 16-bit-per-channel max)

// Reproduces the C++ naming rule exactly (Open()'s CS_NAME_* construction):
// each base name ends in a placeholder '0' character. For capNum 0, that
// placeholder is replaced with a NUL terminator (i.e. effectively dropped -
// this is for backwards compatibility with pre-multi-device filter builds).
// For capNum 1-9, it's replaced with the ASCII digit for that number.
function sharedName(base, capNum){
  const trimmed = base.slice(0, -1);
  return capNum === 0 ? trimmed : trimmed + String(capNum);
}

class UnityCaptureSender {
  constructor(capNum = 0){
    this.capNum = capNum;
    this.hMutex = null;
    this.hWantFrameEvent = null;
    this.hSentFrameEvent = null;
    this.hSharedFile = null;
    this.sharedBuf = null; // koffi buffer view over the mapped memory
    this.opened = false;
  }

  // Mirrors Open(ForReceiving=false) - the sender never CREATEs the mutex or
  // shared memory (the filter/receiver side does that when Windows
  // instantiates the capture device), it only OPENs what already exists.
  // Returns false if the filter isn't installed/running as a capture source
  // yet - that's the normal state before anything has tried to read from it.
  open(){
    if (this.opened) return true;
    const n = this.capNum;
    this.hMutex = OpenMutexA(SYNCHRONIZE, false, sharedName('UnityCapture_Mutx0', n));
    if (!this.hMutex) return false;
    this.hWantFrameEvent = CreateEventA(null, false, false, sharedName('UnityCapture_Want0', n));
    if (!this.hWantFrameEvent) return false;
    this.hSentFrameEvent = OpenEventA(EVENT_MODIFY_STATE, false, sharedName('UnityCapture_Sent0', n));
    if (!this.hSentFrameEvent) return false;
    this.hSharedFile = OpenFileMappingA(FILE_MAP_WRITE, false, sharedName('UnityCapture_Data0', n));
    if (!this.hSharedFile) return false;

    const view = MapViewOfFile(this.hSharedFile, FILE_MAP_WRITE, 0, 0, 0);
    if (!view) return false;
    // koffi needs an explicit size to treat this pointer as a readable/writable
    // buffer - map the whole region the filter allocated (header + max image).
    this.sharedBuf = koffi.decode(view, koffi.array('uint8_t', HEADER_SIZE + MAX_SHARED_IMAGE_SIZE), 1);
    this.opened = true;
    return true;
  }

  // Mirrors Send(): lock mutex, write header fields + pixel data, unlock,
  // signal the filter. `rgbaBuffer` must be a Buffer/Uint8Array of raw
  // RGBA8 pixels, width*height*4 bytes, row-major, no padding (stride = width*4).
  send(width, height, rgbaBuffer){
    if (!this.open()) return false;
    const stride = width * 4;
    const dataSize = stride * height;
    if (HEADER_SIZE + dataSize > HEADER_SIZE + MAX_SHARED_IMAGE_SIZE) return false; // SENDRES_TOOLARGE equivalent

    WaitForSingleObject(this.hMutex, INFINITE);
    // Header fields, written as little-endian int32 at their fixed offsets -
    // matches struct SharedMemHeader field order/size exactly.
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32LE(MAX_SHARED_IMAGE_SIZE, 0);  // maxSize
    header.writeInt32LE(width, 4);
    header.writeInt32LE(height, 8);
    header.writeInt32LE(stride, 12);
    header.writeInt32LE(FORMAT_UINT8, 16);
    header.writeInt32LE(RESIZEMODE_DISABLED, 20);
    header.writeInt32LE(MIRRORMODE_DISABLED, 24);
    header.writeInt32LE(0, 28); // timeout - unused on the sending side

    koffi.encode(this.sharedBuf, 0, header, HEADER_SIZE);
    koffi.encode(this.sharedBuf, HEADER_SIZE, rgbaBuffer, dataSize);
    ReleaseMutex(this.hMutex);

    SetEvent(this.hSentFrameEvent);
    // Non-blocking check mirroring the C++ SENDRES_WARN_FRAMESKIP diagnostic -
    // not required for correctness, just useful to know if the filter isn't
    // actually being read from (e.g. OBS hasn't got the source added yet).
    const consumedLastWant = WaitForSingleObject(this.hWantFrameEvent, 0) === WAIT_OBJECT_0;
    return { ok: true, filterIsConsuming: consumedLastWant };
  }

  close(){
    if (this.hMutex) CloseHandle(this.hMutex);
    if (this.hWantFrameEvent) CloseHandle(this.hWantFrameEvent);
    if (this.hSentFrameEvent) CloseHandle(this.hSentFrameEvent);
    if (this.hSharedFile) CloseHandle(this.hSharedFile);
    this.opened = false;
  }
}

module.exports = UnityCaptureSender;

}
