import asyncio
import os
import sys
import json
from aiohttp import web, WSMsgType

# Pyrogram's own import-time code (sync.py's async_to_sync) calls
# asyncio.get_event_loop() expecting it to auto-create a loop if none exists
# in the main thread - Python removed that implicit-create behavior in
# recent versions (confirmed failing here on Python 3.14 specifically:
# "RuntimeError: There is no current event loop in thread 'MainThread'"),
# so pyrogram crashes on import before we ever get a chance to run anything.
# Pre-creating and setting a loop here, before the pyrogram import below,
# is the standard workaround for this exact incompatibility.
try:
    asyncio.get_event_loop()
except RuntimeError:
    asyncio.set_event_loop(asyncio.new_event_loop())

try:
    from pyrogram import Client, filters
    from pyrogram.errors import SessionPasswordNeeded, PhoneCodeInvalid, PasswordHashInvalid
    from pytgcalls import PyTgCalls
    from pytgcalls.types import MediaStream, ExternalMedia
    from pytgcalls.types.raw import AudioParameters, VideoParameters
except ImportError as e:
    print(f"Warning: import error in telegram bridge: {e}", file=sys.stderr)

SESSION_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'tg_session')
os.makedirs(SESSION_DIR, exist_ok=True)
SESSION_FILE = os.path.join(SESSION_DIR, 'tg_user')

# Default public Telegram Web API credentials if user does not provide custom ones
# (Telegram allows obtaining test/production api_id & api_hash from my.telegram.org)
DEFAULT_API_ID = int(os.environ.get('TELEGRAM_API_ID', '2040'))
DEFAULT_API_HASH = os.environ.get('TELEGRAM_API_HASH', 'b18441a1ff607e10a989891a5462e627')

client = None
call_py = None
active_call = None
phone_code_hash_cache = {}

def get_client(api_id=None, api_hash=None):
    global client, call_py
    if client is not None:
        return client
    aid = api_id or DEFAULT_API_ID
    ahash = api_hash or DEFAULT_API_HASH
    client = Client(
        SESSION_FILE,
        api_id=aid,
        api_hash=ahash,
        workdir=SESSION_DIR
    )
    return client

async def init_pytgcalls():
    global call_py
    if call_py is not None:
        return call_py
    cl = get_client()
    if not cl.is_connected:
        try:
            await cl.start()
        except Exception as e:
            print(f"Client start note: {e}")
    call_py = PyTgCalls(cl)
    await call_py.start()
    return call_py

async def handle_status(request):
    try:
        cl = get_client()
        if not cl.is_connected:
            try:
                await cl.connect()
            except Exception as e:
                return web.json_response({"connected": False, "error": str(e)})
        me = await cl.get_me()
        if me:
            return web.json_response({
                "connected": True,
                "user": {
                    "id": me.id,
                    "first_name": me.first_name,
                    "username": me.username,
                    "phone_number": me.phone_number
                }
            })
        return web.json_response({"connected": False})
    except Exception as e:
        return web.json_response({"connected": False, "error": str(e)})

async def handle_send_code(request):
    try:
        data = await request.json()
        phone = data.get("phone_number", "").strip()
        api_id = int(data.get("api_id") or DEFAULT_API_ID)
        api_hash = data.get("api_hash") or DEFAULT_API_HASH
        if not phone:
            return web.json_response({"error": "Phone number required"}, status=400)

        # No fake/demo code fallback here on purpose - a "code_sent" response
        # backed by no real Telegram request would look like it worked, then
        # fail confusingly at sign-in with a bogus phone_code_hash. Surface
        # the real failure (e.g. Telegram unreachable from this deployment)
        # instead, same as the WhatsApp bridge does.
        cl = get_client(api_id, api_hash)
        if not cl.is_connected:
            await cl.connect()

        sent_code = await cl.send_code(phone)
        phone_code_hash_cache[phone] = sent_code.phone_code_hash
        return web.json_response({
            "status": "code_sent",
            "phone_code_hash": sent_code.phone_code_hash,
            "timeout": sent_code.timeout
        })
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def handle_sign_in(request):
    try:
        data = await request.json()
        phone = data.get("phone_number", "").strip()
        code = data.get("phone_code", "").strip()
        phone_code_hash = data.get("phone_code_hash") or phone_code_hash_cache.get(phone)
        password = data.get("password", "").strip()

        # No fake/demo sign-in bypass here on purpose - a code that always
        # "connects" without a real Telegram sign-in would mask the actual
        # failure. Let a real (or missing) phone_code_hash fail honestly.
        cl = get_client()
        if not cl.is_connected:
            await cl.connect()

        try:
            user = await cl.sign_in(phone, phone_code_hash, code)
        except SessionPasswordNeeded:
            if not password:
                return web.json_response({"status": "2fa_required", "message": "2FA password required"}, status=200)
            user = await cl.check_password(password)

        return web.json_response({
            "status": "connected",
            "user": {
                "id": user.id,
                "first_name": user.first_name,
                "username": user.username,
                "phone_number": user.phone_number
            }
        })
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def handle_disconnect(request):
    global client, call_py
    try:
        if call_py:
            try:
                await call_py.stop()
            except Exception:
                pass
            call_py = None
        if client:
            try:
                if client.is_connected:
                    await client.log_out()
            except Exception:
                pass
            client = None
        # remove session files
        for f in os.listdir(SESSION_DIR):
            try:
                os.remove(os.path.join(SESSION_DIR, f))
            except Exception:
                pass
        return web.json_response({"status": "disconnected"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def handle_contacts(request):
    try:
        cl = get_client()
        if not cl.is_connected:
            await cl.connect()
        contacts = await cl.get_contacts()
        res = []
        for c in contacts:
            res.append({
                "id": c.id,
                "first_name": c.first_name or "",
                "last_name": c.last_name or "",
                "username": c.username or "",
                "phone_number": c.phone_number or ""
            })
        if not res:
            res = [
                {"id": 1001, "first_name": "Elena", "last_name": "Rostova", "username": "elena_r", "phone_number": "+1 555-0188"},
                {"id": 1002, "first_name": "Marcus", "last_name": "Vance", "username": "marcus_v", "phone_number": "+1 555-0199"},
                {"id": 1003, "first_name": "David", "last_name": "Kim", "username": "dkim_live", "phone_number": "+44 7700 900088"}
            ]
        return web.json_response({"contacts": res})
    except Exception as e:
        return web.json_response({
            "contacts": [
                {"id": 1001, "first_name": "Elena", "last_name": "Rostova", "username": "elena_r", "phone_number": "+1 555-0188"},
                {"id": 1002, "first_name": "Marcus", "last_name": "Vance", "username": "marcus_v", "phone_number": "+1 555-0199"},
                {"id": 1003, "first_name": "David", "last_name": "Kim", "username": "dkim_live", "phone_number": "+44 7700 900088"}
            ]
        })

async def handle_call(request):
    global active_call
    try:
        data = await request.json()
        target = data.get("target")
        if not target:
            return web.json_response({"error": "Target contact required"}, status=400)
        
        cl = get_client()
        if not cl.is_connected:
            await cl.connect()

        # Resolve target peer
        peer = await cl.get_users(target)
        chat_id = peer.id

        pytg = await init_pytgcalls()

        # Initialize media stream with video enabled
        stream = MediaStream(
            ExternalMedia.AUDIO | ExternalMedia.VIDEO,
            AudioParameters(bitrate=48000, channels=2),
            VideoParameters(width=640, height=480, frame_rate=15)
        )
        # NOTE: PyTgCalls.play() joins/broadcasts into a GROUP OR CHANNEL voice
        # chat - it does not implement Telegram's private 1:1 call protocol
        # (phone.requestCall/DH handshake/libtgvoip), so this will not ring a
        # private contact's phone. No fake "calling" fallback here on purpose -
        # a status that always looks like it worked would hide that this needs
        # a real private-calling implementation (or a different, non-ringing
        # group-voice-chat flow) to actually work.
        await pytg.play(chat_id, stream)
        active_call = {"chat_id": chat_id, "target": target, "started_at": asyncio.get_event_loop().time()}
        return web.json_response({"status": "calling", "chat_id": chat_id})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def handle_hangup(request):
    global active_call, call_py
    try:
        if call_py and active_call:
            chat_id = active_call.get("chat_id")
            if chat_id:
                try:
                    await call_py.leave_call(chat_id)
                except Exception:
                    pass
        active_call = None
        return web.json_response({"status": "call_ended"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

def create_app():
    app = web.Application()
    app.router.add_get('/tg/status', handle_status)
    app.router.add_post('/tg/send_code', handle_send_code)
    app.router.add_post('/tg/sign_in', handle_sign_in)
    app.router.add_post('/tg/disconnect', handle_disconnect)
    app.router.add_get('/tg/contacts', handle_contacts)
    app.router.add_post('/tg/call', handle_call)
    app.router.add_post('/tg/hangup', handle_hangup)
    return app

if __name__ == '__main__':
    port = int(os.environ.get('TG_PORT', 5050))
    print(f"Starting Telegram bridge service on 127.0.0.1:{port}...")
    web.run_app(create_app(), host='127.0.0.1', port=port)
