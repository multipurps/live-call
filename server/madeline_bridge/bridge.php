<?php
// bridge.php - real Telegram P2P calling via MadelineProto.
//
// Replaces server/tgcalls_bridge (Rust/ferogram+tgcalls), which compiled
// and ran but never confirmed an actual ring in real testing. MadelineProto
// has a documented, mature, high-level calling API:
//   requestCall(mixed $user, bool $video = false): \danog\MadelineProto\VoIP
// with a real VoIP object exposing accept()/discard()/play()/setOutput()/
// setMuted()/getCallState() - verified directly from MadelineProto's own
// src/InternalDoc.php and src/VoIP*.php, not assumed.
//
// STATUS: first draft, UNVERIFIED - could not test PHP/composer/amphp at
// all locally (no PHP available in the dev sandbox this was written in).
// Expect this to need iteration against Render's real build/runtime logs,
// the same way the Rust bridge needed two real compile-error fixes before
// it ran. This is written carefully against MadelineProto's documented
// API, not guessed blindly, but amphp's async/event-loop patterns are
// less certain here than the Rust crate's source was.
//
// Needs its own separate Telegram sign-in - MadelineProto is yet another
// independent MTProto client implementation, same situation as ferogram
// vs. Pyrogram before it. This is inherent to swapping libraries.

require __DIR__ . '/vendor/autoload.php';

use Amp\Http\Server\HttpServer;
use Amp\Http\Server\SocketHttpServer;
use Amp\Http\Server\Request;
use Amp\Http\Server\Response;
use Amp\Http\Server\RequestHandler\ClosureRequestHandler;
use Amp\Http\HttpStatus;
use danog\MadelineProto\API;
use danog\MadelineProto\Settings;
use danog\MadelineProto\Settings\AppInfo;
use danog\MadelineProto\SecurityException;
use danog\MadelineProto\VoIP;
use Psr\Log\NullLogger;

$PORT = (int)(getenv('TGCALLS_PORT') ?: 5051);
$SESSION_FILE = __DIR__ . '/session.madeline';
$SUPABASE_URL = 'https://ewgtpxomgkpbmfyddypw.supabase.co';
$SUPABASE_KEY = getenv('SUPABASE_SERVICE_ROLE_KEY') ?: null;
$API_ID = (int)(getenv('TELEGRAM_API_ID') ?: 2040);
$API_HASH = getenv('TELEGRAM_API_HASH') ?: 'b18441a1ff607e10a989891a5462e627';

// --- Session persistence across Render redeploys (same reasoning as the
// Python and Rust bridges before it: this service has no persistent disk
// on Render's free plan, so $SESSION_FILE is wiped on every cold start
// unless restored from Supabase first). MadelineProto's session is a
// binary serialized file, not a simple export string, so this stores/
// restores the raw file bytes as base64 rather than a clean session
// string like the other two bridges use. -------------------------------
function supabaseRequest(string $method, string $path, ?array $body = null): ?array {
    global $SUPABASE_URL, $SUPABASE_KEY;
    if (!$SUPABASE_KEY) return null;
    $ch = curl_init("$SUPABASE_URL$path");
    $headers = [
        "apikey: $SUPABASE_KEY",
        "Authorization: Bearer $SUPABASE_KEY",
        "Content-Type: application/json",
    ];
    if ($method === 'POST') {
        $headers[] = "Prefer: resolution=merge-duplicates";
    }
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
    ]);
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    }
    $result = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($status < 200 || $status >= 300) {
        error_log("[MadelineBridge] Supabase $method $path -> $status: $result");
        return null;
    }
    $decoded = json_decode($result ?: '', true);
    return is_array($decoded) ? $decoded : null;
}

// MadelineProto (v8+) stores its session as a DIRECTORY - safe.php shards,
// not one flat file - despite $SESSION_FILE looking like a plain filename.
// file_get_contents()/file_put_contents() on it fail with EISDIR. It must
// be archived before it can travel through Supabase as a base64 text blob.
function zipDirectoryToFile(string $dir, string $zipPath): bool {
    if (!class_exists('ZipArchive')) {
        error_log('[MadelineBridge] ZipArchive extension not available - cannot archive session directory');
        return false;
    }
    $zip = new ZipArchive();
    if ($zip->open($zipPath, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) return false;
    $base = realpath($dir);
    $files = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($dir, RecursiveDirectoryIterator::SKIP_DOTS),
        RecursiveIteratorIterator::LEAVES_ONLY
    );
    foreach ($files as $file) {
        if ($file->isDir()) continue;
        $relativePath = substr($file->getRealPath(), strlen($base) + 1);
        $zip->addFile($file->getRealPath(), $relativePath);
    }
    return $zip->close();
}

function unzipFileToDirectory(string $zipPath, string $destDir): bool {
    if (!class_exists('ZipArchive')) {
        error_log('[MadelineBridge] ZipArchive extension not available - cannot restore session directory');
        return false;
    }
    $zip = new ZipArchive();
    if ($zip->open($zipPath) !== true) return false;
    if (!is_dir($destDir)) mkdir($destDir, 0777, true);
    $ok = $zip->extractTo($destDir);
    $zip->close();
    return $ok;
}

function restoreSessionFromSupabase(): void {
    global $SESSION_FILE;
    if (file_exists($SESSION_FILE)) return; // local session already present, nothing to restore
    $rows = supabaseRequest('GET', '/rest/v1/app_settings?select=madeline_session_blob&id=eq.true');
    if (!$rows || empty($rows[0]['madeline_session_blob'])) {
        error_log('[MadelineBridge] No saved session in Supabase - fresh login required');
        return;
    }
    $decoded = base64_decode($rows[0]['madeline_session_blob']);
    if ($decoded === false) {
        error_log('[MadelineBridge] Saved session blob failed to base64-decode');
        return;
    }
    // The blob is a zip of the session DIRECTORY (see saveSessionToSupabase) -
    // extract it back into place rather than writing it as one flat file.
    $tmpZip = sys_get_temp_dir() . '/madeline_session_' . uniqid() . '.zip';
    file_put_contents($tmpZip, $decoded);
    $ok = unzipFileToDirectory($tmpZip, $SESSION_FILE);
    @unlink($tmpZip);
    error_log($ok ? '[MadelineBridge] Restored session from Supabase' : '[MadelineBridge] Failed to extract restored session zip');
}

function saveSessionToSupabase(): void {
    global $SESSION_FILE;
    if (!file_exists($SESSION_FILE)) return;
    $tmpZip = sys_get_temp_dir() . '/madeline_session_' . uniqid() . '.zip';
    // is_dir(), not file_get_contents() - see the comment above zipDirectoryToFile.
    $zipped = is_dir($SESSION_FILE) ? zipDirectoryToFile($SESSION_FILE, $tmpZip) : copy($SESSION_FILE, $tmpZip);
    if (!$zipped) {
        error_log('[MadelineBridge] Failed to archive session - skipping save');
        @unlink($tmpZip);
        return;
    }
    $blob = base64_encode(file_get_contents($tmpZip));
    @unlink($tmpZip);
    $result = supabaseRequest('POST', '/rest/v1/app_settings', [
        'id' => true,
        'madeline_session_blob' => $blob,
    ]);
    if ($result !== null) {
        error_log('[MadelineBridge] Saved session to Supabase');
    }
}

function rrmdir(string $path): void {
    if (is_dir($path) && !is_link($path)) {
        foreach (scandir($path) as $item) {
            if ($item === '.' || $item === '..') continue;
            rrmdir($path . DIRECTORY_SEPARATOR . $item);
        }
        @rmdir($path);
    } else {
        @unlink($path);
    }
}

function clearSavedSession(): void {
    supabaseRequest('PATCH', '/rest/v1/app_settings?id=eq.true', ['madeline_session_blob' => null]);
}
// -----------------------------------------------------------------------

restoreSessionFromSupabase();

$settings = new Settings;
$settings->getAppInfo()->setApiId($API_ID)->setApiHash($API_HASH);
$settings->getLogger()->setLevel(\danog\MadelineProto\Logger::LEVEL_WARNING);

$madeline = new API($SESSION_FILE, $settings);

// Shared in-memory call state, read/written across requests within this
// one long-lived process (same role as AppState in the Rust bridge).
$state = [
    'call' => null,       // active VoIP object, if any
    'callState' => 'idle', // idle|ringing|connecting|connected|ended|failed
    'callError' => null,
];

function jsonResponse(array $data, int $status = 200): Response {
    return new Response($status, ['content-type' => 'application/json'], json_encode($data));
}

$handler = new ClosureRequestHandler(function (Request $request) use ($madeline, &$state): Response {
    $path = $request->getUri()->getPath();
    $method = $request->getMethod();

    try {
        if ($path === '/status' && $method === 'GET') {
            try {
                $self = $madeline->getSelf();
                if ($self) {
                    saveSessionToSupabase();
                    return jsonResponse(['connected' => true]);
                }
                return jsonResponse(['connected' => false]);
            } catch (\Throwable $e) {
                return jsonResponse(['connected' => false, 'error' => $e->getMessage()]);
            }
        }

        if ($path === '/send_code' && $method === 'POST') {
            $body = json_decode($request->getBody()->buffer(), true) ?: [];
            $phone = $body['phone'] ?? null;
            if (!$phone) return jsonResponse(['error' => 'phone required'], 400);
            try {
                $result = $madeline->phoneLogin($phone);
                return jsonResponse(['status' => 'code_sent']);
            } catch (\Throwable $e) {
                return jsonResponse(['error' => $e->getMessage()], 500);
            }
        }

        if ($path === '/sign_in' && $method === 'POST') {
            $body = json_decode($request->getBody()->buffer(), true) ?: [];
            $code = $body['code'] ?? null;
            $password = $body['password'] ?? null;
            if (!$code) return jsonResponse(['error' => 'code required'], 400);
            try {
                $result = $madeline->completePhoneLogin($code);
                saveSessionToSupabase();
                return jsonResponse(['status' => 'connected']);
            } catch (SecurityException $e) {
                // 2FA password required
                if ($password) {
                    try {
                        $madeline->complete2faLogin($password);
                        saveSessionToSupabase();
                        return jsonResponse(['status' => 'connected']);
                    } catch (\Throwable $e2) {
                        return jsonResponse(['error' => $e2->getMessage()], 500);
                    }
                }
                return jsonResponse(['status' => '2fa_required']);
            } catch (\Throwable $e) {
                return jsonResponse(['error' => $e->getMessage()], 500);
            }
        }

        if ($path === '/disconnect' && $method === 'POST') {
            global $SESSION_FILE;
            try { $madeline->logout(); } catch (\Throwable $e) { /* best effort */ }
            // unlink() silently fails (returns false, swallowed by @) on a
            // directory - and $SESSION_FILE IS a directory (see the comment
            // above zipDirectoryToFile) - so this never actually cleared the
            // local session before. A disconnect that leaves the old,
            // possibly-invalidated session directory in place means the
            // very next boot just restores the same broken session again.
            if (file_exists($SESSION_FILE)) rrmdir($SESSION_FILE);
            clearSavedSession();
            // $madeline is a single long-lived object for this process's
            // entire life - deleting the directory alone doesn't reset it.
            // Exit (once, deliberately, after this response is sent) so the
            // next boot's `new API($SESSION_FILE, ...)` builds truly fresh
            // against the now-empty directory. server.mjs already restarts
            // this process with backoff on exit (startTgCallsBridge) - this
            // is a single intentional exit, not the crash-loop that backoff
            // guards against.
            \Amp\async(function () {
                \Amp\delay(0.5);
                exit(0);
            });
            return jsonResponse(['status' => 'disconnected']);
        }

        if ($path === '/call' && $method === 'POST') {
            $body = json_decode($request->getBody()->buffer(), true) ?: [];
            $target = $body['target'] ?? null;
            if (!$target) return jsonResponse(['error' => 'target (numeric Telegram user id) required'], 400);

            $state['callState'] = 'ringing';
            $state['callError'] = null;
            \Amp\async(function () use ($madeline, &$state, $target) {
                try {
                    // This bridge is a SEPARATE Telegram session from the
                    // app's regular Telegram connection (see the file header)
                    // - its own internal peer cache starts empty regardless
                    // of what the regular session has already resolved. A
                    // bare numeric id/phone it has never seen throws "This
                    // peer is not present in the internal peer database" the
                    // moment requestCall() tries to use it. getInfo() forces
                    // resolution first (importing as a contact by phone
                    // number if needed) so requestCall() has a cached peer
                    // to work with.
                    try {
                        $madeline->getInfo($target);
                    } catch (\Throwable $resolveErr) {
                        // Numeric ids that aren't phone numbers/usernames
                        // can't be resolved this way - only a phone number
                        // (E.164, with a leading +) can be imported as a
                        // contact. Try that explicitly before giving up.
                        $phone = ltrim((string)$target, '+');
                        if (ctype_digit($phone)) {
                            $madeline->contacts->importContacts([
                                'contacts' => [[
                                    '_' => 'inputPhoneContact',
                                    'client_id' => 0,
                                    'phone' => '+' . $phone,
                                    'first_name' => 'Live Call',
                                    'last_name' => '',
                                ]],
                            ]);
                            $madeline->getInfo('+' . $phone);
                        } else {
                            throw $resolveErr;
                        }
                    }

                    $call = $madeline->requestCall($target, true);
                    $state['call'] = $call;
                    $state['callState'] = 'connecting';
                    // Block here (within this async task, not the request
                    // handler) until the call actually connects or fails -
                    // matches the Rust bridge's run_call background-task
                    // shape, so the HTTP response returns immediately.
                    $call->onCall(function () use (&$state) {
                        $state['callState'] = 'connected';
                    });
                } catch (\Throwable $e) {
                    $state['callState'] = 'failed';
                    $state['callError'] = $e->getMessage();
                }
            });

            return jsonResponse(['status' => 'calling']);
        }

        if ($path === '/call/state' && $method === 'GET') {
            $resp = ['state' => $state['callState']];
            if ($state['callError']) $resp['error'] = $state['callError'];
            return jsonResponse($resp);
        }

        if ($path === '/hangup' && $method === 'POST') {
            if ($state['call']) {
                try { $state['call']->discard(); } catch (\Throwable $e) { /* best effort */ }
            }
            $state['call'] = null;
            $state['callState'] = 'ended';
            return jsonResponse(['status' => 'ended']);
        }

        return jsonResponse(['error' => 'not found'], 404);
    } catch (\Throwable $e) {
        return jsonResponse(['error' => $e->getMessage()], 500);
    }
});

// Deliberately NOT calling $madeline->start() here. start() is designed
// to trigger MadelineProto's own interactive login flow (CLI prompt or
// web UI) whenever there's no valid session yet - confirmed live: this
// caused the bridge to spam an actual Telegram login attempt (its own
// built-in QR-code flow) on every single boot, which under this
// process's restart-on-crash loop meant hammering Telegram's real login
// endpoint every few seconds and triggering an escalating FLOOD_WAIT
// rate-limit. Programmatic/headless login (what this whole bridge is
// for) means calling phoneLogin()/completePhoneLogin() directly instead
// of start() - MadelineProto connects lazily as needed when those (or
// any other API method) are called, without ever prompting for anything
// on its own.

$server = SocketHttpServer::createForDirectAccess(new NullLogger());
$server->expose("127.0.0.1:$PORT");
$server->start($handler, new \Amp\Http\Server\DefaultErrorHandler());

error_log("[MadelineBridge] listening on 127.0.0.1:$PORT");

// Keep the process alive - amphp's event loop runs in the background;
// this blocks the main fiber so the script doesn't exit immediately.
Amp\trapSignal([SIGINT, SIGTERM]);
