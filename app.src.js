import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

  const SUPABASE_URL = 'https://ewgtpxomgkpbmfyddypw.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_NkeueZ7vabkD9nUIPDaGwQ_GCd5Ci40';
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  // Note: this is Supabase's publishable/anon key, which is designed to be safely embedded in
  // client-side code — access is controlled by the Row Level Security policies on each table
  // (see supabase_schema.sql), not by hiding this key. The session token itself is the only
  // thing Supabase's own SDK keeps in localStorage — everything else below reads/writes Supabase.

  const $ = (id) => document.getElementById(id);

  // ---------- desktop / OBS detection ----------
  // isElectronShell(): actually running inside the desktop app (see /desktop) -
  // window.electronAPI only exists there, exposed by its preload script.
  // isDesktopBrowser(): a plain desktop browser, not the shell and not mobile -
  // used only to show a "there's a desktop app" hint, since OBS features
  // need the actual shell (a webpage alone can't run a local server for OBS
  // to connect to).
  function isElectronShell(){ return !!(window.electronAPI && window.electronAPI.isDesktopApp); }
  function isDesktopBrowser(){
    if (isElectronShell()) return false;
    const ua = navigator.userAgent || '';
    return !/Mobi|Android|iPhone|iPad|iPod/i.test(ua);
  }

  function initDesktopHint(){
    const el = $('desktopHint');
    if (!el) return;
    if (isElectronShell() && !window.electronAPI.obsCaptureAvailable) {
      // Real desktop shell, but OBS output isn't available on this platform
      // yet (currently Windows-only - see /desktop/README.md for why macOS
      // needs a different, signed approach).
      $('desktopHintText').textContent = 'Desktop app — OBS output isn\u2019t available on this platform yet.';
      el.style.display = 'flex';
    } else if (isDesktopBrowser() && !localStorage.getItem('lc_desktop_hint_dismissed')) {
      $('desktopHintText').textContent = 'On a desktop? A desktop app with OBS support is in this project\u2019s /desktop folder.';
      el.style.display = 'flex';
    }
    $('desktopHintClose')?.addEventListener('click', () => {
      el.style.display = 'none';
      localStorage.setItem('lc_desktop_hint_dismissed', '1');
    });
  }
  initDesktopHint();

  // ---------- OBS virtual-camera bridge (desktop shell, Windows only for now) ----------
  // Grabs frames off a <video> element onto an offscreen canvas and hands
  // the raw RGBA pixels to window.electronAPI.sendFrameToObs(), which the
  // desktop shell's main process writes into a UnityCaptureFilter virtual
  // camera device (see /desktop/unity-capture-sender.js) for OBS to pick up
  // as a normal Video Capture Device source.
  function createObsBridge(videoEl){
    let rafId = null, canvas = null, ctx = null;
    function tick(){
      if (!videoEl.videoWidth) { rafId = requestAnimationFrame(tick); return; }
      if (!canvas) { canvas = document.createElement('canvas'); ctx = canvas.getContext('2d', { willReadFrequently: true }); }
      if (canvas.width !== videoEl.videoWidth || canvas.height !== videoEl.videoHeight) {
        canvas.width = videoEl.videoWidth;
        canvas.height = videoEl.videoHeight;
      }
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      window.electronAPI.sendFrameToObs(canvas.width, canvas.height, frame.data.buffer);
      rafId = requestAnimationFrame(tick);
    }
    return {
      start(){ if (!rafId) tick(); },
      stop(){ if (rafId) { cancelAnimationFrame(rafId); rafId = null; } },
    };
  }

  function wireObsButton(btnId, videoEl){
    const btn = $(btnId);
    if (!btn) return;
    if (!isElectronShell() || !window.electronAPI.obsCaptureAvailable) return; // stays hidden (display:none from markup)
    btn.style.display = 'inline-block';
    const bridge = createObsBridge(videoEl);
    let on = false;
    btn.addEventListener('click', () => {
      on = !on;
      btn.classList.toggle('active', on);
      btn.textContent = on ? 'Sending to OBS' : 'Send to OBS';
      if (on) bridge.start(); else bridge.stop();
    });
  }
  // Wired once at boot - the video elements exist in the DOM from page load
  // (they're just display:none / not srcObject-populated until a call starts),
  // so this doesn't need to wait for a call to actually be active.
  wireObsButton('callObsBtn', $('remoteVideo'));
  wireObsButton('lfObsBtn', $('lfRemoteVideo'));

  // ---------- splash ----------
  // Always shown (unconditional - no "only for returning sessions" check here,
  // unlike Personal Studio's splash), for at least MIN_SPLASH_MS, and hidden
  // only once auth has also resolved - whichever of the two finishes last.
  const MIN_SPLASH_MS = 2300;
  let splashMinDone = false;
  let splashAuthDone = false;
  function maybeHideSplash(){
    if (!splashMinDone || !splashAuthDone) return;
    const el = $('liveSplash');
    if (!el) return;
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 450);
  }
  setTimeout(() => { splashMinDone = true; maybeHideSplash(); }, MIN_SPLASH_MS);

  // Splash background is embedded directly in styles.css (base64) - nothing
  // to fetch or cache here. Only the min-duration/fade-out timing lives here.

  // Reusable "•••" action menu - a small dismissible popover anchored near the button
  // that opened it. Used for Recent chat's overflow menu and Avatar/Voice delete,
  // instead of a bare trash-can icon sitting exposed in the row.
  let openMenuEl = null;
  function closeActionMenu(){
    if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; }
    document.removeEventListener('click', closeActionMenu, true);
  }
  function openActionMenu(anchorBtn, items){
    closeActionMenu();
    const rect = anchorBtn.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'actionMenu';
    menu.innerHTML = items.map((it, i) => `<button data-i="${i}"${it.danger ? ' class="danger"' : ''}>${it.label}</button>`).join('');
    document.body.appendChild(menu);
    const menuW = menu.offsetWidth || 180;
    let left = rect.right - menuW;
    if (left < 8) left = 8;
    menu.style.left = left + 'px';
    menu.style.top = (rect.bottom + 6) + 'px';
    items.forEach((it, i) => {
      menu.querySelector(`[data-i="${i}"]`).addEventListener('click', (e) => {
        e.stopPropagation();
        closeActionMenu();
        it.onClick();
      });
    });
    openMenuEl = menu;
    setTimeout(() => document.addEventListener('click', closeActionMenu, true), 0);
  }

  // Every provider-facing API call authenticates as the signed-in user instead of
  // trusting a client-held plaintext key (see /lib/keys.js + /api/keys.js) - this
  // is the one shared way every fetch() proves who it is.
  async function authHeader(){
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  // setAppHeight() (the iOS WKWebView height-gap fix) now lives in boot.js, which
  // runs before app.js has even been fetched - see the comment there for why.

  // Temporary on-screen diagnostic in case the fix above still isn't enough -
  // remove once the gap is confirmed gone. Tap the "Live Call" logo 5x to show it.
  const saProbe = document.createElement('div');
  saProbe.style.cssText = 'position:fixed; bottom:0; height:0; padding-bottom:env(safe-area-inset-bottom); visibility:hidden;';
  document.body.appendChild(saProbe);

  let logoTapCount = 0, logoTapTimer = null;
  document.getElementById('authLogo')?.addEventListener('click', () => {
    logoTapCount++;
    clearTimeout(logoTapTimer);
    logoTapTimer = setTimeout(() => { logoTapCount = 0; }, 1500);
    if (logoTapCount >= 5) {
      logoTapCount = 0;
      const vv = window.visualViewport;
      const safeBottom = getComputedStyle(saProbe).paddingBottom;
      alert(`innerHeight: ${window.innerHeight}\nscreen.height: ${window.screen.height}\nvisualViewport.height: ${vv ? vv.height : 'n/a'}\nsafe-area-inset-bottom: ${safeBottom}\ndevicePixelRatio: ${window.devicePixelRatio}\nstandalone: ${window.navigator.standalone}`);
    }
  });

  // Admin-set login background (public read, works even signed out) - falls back to
  // the plain coffee background if nothing has been uploaded via admin.html.
  (async () => {
    try {
      const { data } = await supabase.from('app_settings').select('login_bg_url').eq('id', true).maybeSingle();
      if (data?.login_bg_url) {
        const el = document.getElementById('authScreen');
        el.style.backgroundImage = `linear-gradient(rgba(30,19,13,0.32), rgba(30,19,13,0.55)), url('${data.login_bg_url}')`;
        el.style.backgroundSize = 'cover';
        el.style.backgroundPosition = 'center';
        // Same background on the "install to Home Screen" gate - a person bounced
        // to that screen (opened in a browser tab, not installed) shouldn't see a
        // flat coffee card when everyone past that gate sees the real login art.
        const gate = document.getElementById('installGate');
        gate.style.backgroundImage = `linear-gradient(rgba(30,19,13,0.45), rgba(30,19,13,0.72)), url('${data.login_bg_url}')`;
        gate.style.backgroundSize = 'cover';
        gate.style.backgroundPosition = 'center';
      }
    } catch (e) {}
  })();


  const screens = { home: $('screenHome'), recent: $('screenRecent'), profile: $('screenProfile'), features: $('screenFeatures') };
  const tabBtns = document.querySelectorAll('.tabBtn');
  function moveTabGlider(name){
    const glider = $('tabGlider');
    const btn = document.querySelector(`#tabBar .tabBtn[data-tab="${name}"]`);
    if (!glider || !btn) return;
    const barRect = $('tabBar').getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    if (btnRect.width === 0) return; // tab bar hidden (desktop mode) - nothing to move
    glider.style.transform = `translateX(${btnRect.left - barRect.left - 6}px)`;
  }
  function showTab(name){
    const nextEl = screens[name];
    Object.entries(screens).forEach(([k, el]) => {
      if (k === name) return;
      el.classList.remove('active');
    });
    if (nextEl) {
      nextEl.classList.add('fadeIn');
      nextEl.classList.add('active');
      requestAnimationFrame(() => nextEl.classList.remove('fadeIn'));
    }
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    moveTabGlider(name);
    $('homeInputBar').classList.toggle('visible', name === 'home');
    if (name === 'recent') renderRecent();
    if (name === 'profile') { renderProfile(); fetchConnectedStatus(); }
    if (name === 'features') updateLfKeyHint();
  }
  tabBtns.forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  window.addEventListener('resize', () => moveTabGlider(document.querySelector('#tabBar .tabBtn.active')?.dataset.tab || 'home'));
  setTimeout(() => moveTabGlider('home'), 50);

  $('openApiKeys')?.addEventListener('click', () => $('apiKeysScreen').classList.add('active'));
  $('closeApiKeys')?.addEventListener('click', () => $('apiKeysScreen').classList.remove('active'));

  $('openChangePassword')?.addEventListener('click', () => $('changePasswordScreen').classList.add('active'));
  $('closeChangePassword')?.addEventListener('click', () => $('changePasswordScreen').classList.remove('active'));
  $('changePasswordBtn')?.addEventListener('click', async () => {
    const p1 = $('newPassword1').value;
    const p2 = $('newPassword2').value;
    if (!p1 || p1.length < 6) { $('changePasswordHint').textContent = 'Password must be at least 6 characters.'; return; }
    if (p1 !== p2) { $('changePasswordHint').textContent = 'Passwords do not match.'; return; }
    $('changePasswordHint').textContent = 'Saving…';
    const { error } = await supabase.auth.updateUser({ password: p1 });
    if (error) { $('changePasswordHint').textContent = error.message; return; }
    $('newPassword1').value = ''; $('newPassword2').value = '';
    $('changePasswordHint').textContent = 'Password updated.';
  });


  const infoContent = {
    faq: {
      title: 'FAQ',
      html: `
        <h3>Which provider powers the calls?</h3>
        <p>Anam. Add your own Anam API key under the API screen — your calls are billed to your own account, never anyone else's.</p>
        <h3>Where do I manage my avatar or voice?</h3>
        <p>In Profile, under Avatar — it shows the avatars and voices available on your Anam account.</p>
        <h3>Is my API key visible to anyone else?</h3>
        <p>No. It's stored against your account only and sent only when you start a call.</p>
      `,
    },
    about: {
      title: 'About',
      html: `
        <h3>Live Call</h3>
        <p>A lightweight way to start a real-time video call with an AI avatar, powered by your own Anam account.</p>
        <h3>Built for iPhone</h3>
        <p>Live Call is a Progressive Web App — add it to your home screen for the full experience.</p>
      `,
    },
    policy: {
      title: 'Privacy Policy',
      html: `
        <p>This policy explains what Live Call collects, why, and how it's protected.</p>
        <h3>Account data</h3>
        <p>When you sign in (Google or email), we store your email address and a unique account ID from Supabase Auth. That's the only identity data we keep.</p>
        <h3>Your API keys</h3>
        <p>If you add your own Anam API key, it's stored encrypted in Supabase Vault, never in plaintext, and used solely to place your own calls through your own account. The app's UI never displays a saved key back to you or anyone else — you can only overwrite it with a new one.</p>
        <h3>Call content</h3>
        <p>Your persona briefs, chat messages, and call history are stored against your account so you can resume past chats. This data is not shared with other users. Live video/audio during a call is streamed directly between your device and Anam — we don't record or store the call media itself.</p>
        <h3>What we don't do</h3>
        <p>We don't sell your data, share it with advertisers, or share your API keys or call data with any other user of this app. We don't use your data to train any AI model.</p>
        <h3>Third parties involved</h3>
        <p>Supabase (auth and database), Anam (avatar/voice calls), and Groq (for the pre-call chat) process data as needed to run the app — each under their own privacy terms.</p>
        <h3>Your control</h3>
        <p>You can delete your saved API keys at any time by saving an empty value, or contact the app owner to request full account deletion.</p>
        <h3>Changes</h3>
        <p>If this policy changes materially, it'll be reflected here with an updated date. Last updated: this build.</p>
      `,
    },
    terms: {
      title: 'Terms & Conditions',
      html: `
        <p>By using Live Call, you agree to the following.</p>
        <h3>Your account and keys</h3>
        <p>You're responsible for any API keys you add and all usage or cost they incur on Anam or any other connected provider. This app does not provide free access to those services — you must have and pay for your own account with them.</p>
        <h3>Acceptable use</h3>
        <p>You may not use this app to impersonate a real, identifiable person without their explicit consent, to harass or deceive anyone, to generate content involving minors in any sexual or exploitative context, or for any illegal purpose. Creating a fictional persona or roleplaying a scenario you've written yourself is fine; impersonating a specific real person to deceive someone else is not.</p>
        <h3>No guarantee of availability</h3>
        <p>This app depends on third-party providers (Anam, Groq, Supabase). We don't control their uptime, pricing, or policy changes, and can't guarantee the app will always work exactly as described.</p>
        <h3>Approval gate</h3>
        <p>New accounts require manual approval before use. Approval can be revoked at any time at the app owner's discretion, for any reason, including suspected abuse of the acceptable use terms above.</p>
        <h3>Liability</h3>
        <p>This app is provided as-is, without warranty. The app owner isn't liable for costs incurred on your connected provider accounts, for content generated during calls, or for any consequence of how you choose to use the persona/roleplay features.</p>
        <h3>Changes</h3>
        <p>These terms may be updated as the app evolves. Continued use after a change means you accept the update.</p>
      `,
    },
  };
  document.querySelectorAll('.navRow[data-info]').forEach(row => {
    row.addEventListener('click', () => {
      const info = infoContent[row.dataset.info];
      $('infoScreenTitle').textContent = info.title;
      $('infoScreenBody').innerHTML = info.html;
      $('infoScreen').classList.add('active');
    });
  });
  $('closeInfo')?.addEventListener('click', () => $('infoScreen').classList.remove('active'));

  const state = {
    systemPrompt: '',
    anamAvatarId: '',
    anamAvatarName: '',
    anamVoiceId: '',
    anamVoiceName: '',
    displayName: '',
    country: '',
    language: 'en',
    theme: 'coffee-emerald',
    avatarUrl: '',
    chatBgUrl: '',
    // Booleans only, never the plaintext - the real keys live encrypted in Supabase
    // Vault and never leave the server after the moment they're first saved (see
    // /api/keys.js, /lib/keys.js). Populated by loadKeyStatus() below.
    anamKeySet: false,
    anamKeyLocked: false,
    falKeySet: false,
  };
  let currentUser = null;
  let currentChatId = null;
  let chatMessages = []; // [{role: 'user'|'assistant', content: '...'}]

  async function persist(){
    if (!currentUser) return;
    const { error } = await supabase.from('video_call_settings').upsert({
      user_id: currentUser.id,
      system_prompt: state.systemPrompt,
      anam_avatar_id: state.anamAvatarId,
      anam_avatar_name: state.anamAvatarName,
      anam_voice_id: state.anamVoiceId,
      anam_voice_name: state.anamVoiceName,
      display_name: state.displayName,
      country: state.country,
      language: state.language,
      theme: state.theme,
      avatar_url: state.avatarUrl,
      chat_bg_url: state.chatBgUrl,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      console.error('persist() failed:', error);
      $('homeHint').textContent = 'Save failed: ' + error.message;
    }
    return !error;
  }

  async function loadKeyStatus(){
    try {
      const r = await fetch('/api/keys', { headers: await authHeader() });
      const data = await r.json();
      if (!r.ok) return;
      state.anamKeySet = !!data.anam;
      state.falKeySet = !!data.fal;
      state.anamKeyLocked = !!data.anamKeyLocked;
    } catch (e) { /* leave as false - UI just shows "paste your key" */ }
    if (state.anamKeyLocked) {
      $('anamApiKey').placeholder = 'Locked by admin — contact support to change this';
      $('anamApiKey').disabled = true;
      $('saveAnamKey').disabled = true;
    } else {
      $('anamApiKey').placeholder = state.anamKeySet ? 'Key saved — enter a new one to replace' : 'Paste your Anam API key';
      $('anamApiKey').disabled = false;
      $('saveAnamKey').disabled = false;
    }
    $('falApiKey').placeholder = state.falKeySet ? 'Key saved — enter a new one to replace' : 'Paste your Fal API key';
  }

  async function loadSettings(){
    const { data } = await supabase.from('video_call_settings').select('*').eq('user_id', currentUser.id).maybeSingle();
    if (data) {
      state.systemPrompt = data.system_prompt || '';
      state.anamAvatarId = data.anam_avatar_id || '';
      state.anamAvatarName = data.anam_avatar_name || '';
      state.anamVoiceId = data.anam_voice_id || '';
      state.anamVoiceName = data.anam_voice_name || '';
      state.displayName = data.display_name || '';
      state.country = data.country || '';
      state.language = data.language || 'en';
      state.theme = data.theme || 'coffee-emerald';
      state.avatarUrl = data.avatar_url || '';
      state.chatBgUrl = data.chat_bg_url || '';
      applyTheme();
    } else {
      await persist(); // first login — create the row
    }
    $('anamApiKey').value = '';
    $('falApiKey').value = '';
    $('profileName').value = state.displayName;
    $('profileCountry').value = state.country;
    $('profileLanguage').value = state.language;
    $('profileTheme').value = state.theme;
    await loadKeyStatus();
    updateAnamAvatarSummary();
    await loadAdminDefaultChatBg();
    applyChatBg();
    loadChatBgOptions();
    ensureNotificationsEnabled();
    checkForNewAnnouncements();
    renderProfile();
  }

  // ---------------------------------------------------------------- Chat background
  // Three states for state.chatBgUrl: '' (no preference yet - inherits the admin's
  // default), '__none__' (user explicitly turned it off), or a specific gallery URL.
  let adminDefaultChatBg = '';
  async function loadAdminDefaultChatBg(){
    try {
      const { data } = await supabase.from('app_settings').select('chat_bg_url').eq('id', true).maybeSingle();
      adminDefaultChatBg = data?.chat_bg_url || '';
    } catch (e) { adminDefaultChatBg = ''; }
  }
  function applyChatBg(){
    const effectiveUrl = state.chatBgUrl === '__none__' ? '' : (state.chatBgUrl || adminDefaultChatBg);
    ['screenHome', 'screenFeatures'].forEach(id => {
      const el = $(id);
      if (!el) return;
      if (effectiveUrl) {
        el.style.backgroundImage = `linear-gradient(rgba(30,19,13,0.5), rgba(30,19,13,0.7)), url('${effectiveUrl}')`;
        el.style.backgroundSize = 'cover';
        el.style.backgroundPosition = 'center';
      } else {
        el.style.backgroundImage = '';
      }
    });
  }

  async function loadChatBgOptions(){
    const { data } = await supabase.from('chat_backgrounds').select('id,url').order('created_at', { ascending: false });
    const row = $('chatBgPickerRow');
    const defaultSelected = !state.chatBgUrl;
    const noneSelected = state.chatBgUrl === '__none__';
    const optionsHtml = (data || []).map(bg => `
      <button class="chatBgThumb ${state.chatBgUrl === bg.url ? 'selected' : ''}" data-url="${bg.url}"><img src="${bg.url}" /></button>
    `).join('');
    row.innerHTML = `<button class="chatBgThumb noneOption ${defaultSelected ? 'selected' : ''}" data-url="">Default</button>`
      + `<button class="chatBgThumb noneOption ${noneSelected ? 'selected' : ''}" data-url="__none__">None</button>`
      + optionsHtml;
    row.querySelectorAll('.chatBgThumb').forEach(btn => {
      btn.addEventListener('click', async () => {
        state.chatBgUrl = btn.dataset.url;
        row.querySelectorAll('.chatBgThumb').forEach(b => b.classList.toggle('selected', b === btn));
        applyChatBg();
        await persist();
      });
    });
  }

  $('profileName')?.addEventListener('blur', async () => {
    state.displayName = $('profileName').value.trim();
    await persist();
    renderProfile();
  });
  $('profileCountry')?.addEventListener('change', async () => {
    state.country = $('profileCountry').value;
    await persist();
  });
  $('profileLanguage')?.addEventListener('change', async () => {
    state.language = $('profileLanguage').value;
    await persist();
  });
  function applyTheme(){
    document.documentElement.setAttribute('data-theme', state.theme === 'coffee-emerald' ? '' : state.theme);
  }
  $('profileTheme')?.addEventListener('change', async () => {
    state.theme = $('profileTheme').value;
    applyTheme();
    await persist();
  });

  $('notifBellBtn')?.addEventListener('click', () => { $('notificationsScreen').classList.add('active'); loadAnnouncements(); });
  $('closeNotifications')?.addEventListener('click', () => $('notificationsScreen').classList.remove('active'));

  async function loadAnnouncements(){
    const { data } = await supabase.from('announcements').select('*').order('created_at', { ascending: false }).limit(30);
    const list = $('notificationsList');
    if (!data || !data.length) { list.innerHTML = '<div class="emptyState">No announcements yet.</div>'; return; }
    list.innerHTML = data.map(a => `
      <div class="profileCard" style="align-items:flex-start;">
        <div class="cBody">
          <div class="cLabel" style="color:#fff; font-weight:700; margin-bottom:4px;">${a.title.replace(/</g,'&lt;')}</div>
          <div style="font-size:13.5px; color:var(--dim); line-height:1.4;">${a.body.replace(/</g,'&lt;')}</div>
          <div style="font-size:11px; color:var(--dim); margin-top:6px;">${new Date(a.created_at).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}</div>
        </div>
      </div>
    `).join('');
    const last = data[0]?.created_at;
    if (last && last !== localStorage.getItem('lastSeenAnnouncement')) {
      $('notifDot').style.display = 'block';
    }
    localStorage.setItem('lastSeenAnnouncement', last);
    $('notifDot').style.display = 'none';
  }
  async function checkForNewAnnouncements(){
    const { data } = await supabase.from('announcements').select('created_at').order('created_at', { ascending: false }).limit(1);
    const latest = data?.[0]?.created_at;
    if (latest && latest !== localStorage.getItem('lastSeenAnnouncement')) $('notifDot').style.display = 'block';
  }

  function autoGrow(){
    const el = $('briefInput');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }
  $('briefInput')?.addEventListener('input', autoGrow);
  $('briefInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });
  $('sendBtn')?.addEventListener('click', sendChatMessage);
  async function saveProviderKey(provider, inputId, btnId, onSaved){
    const input = $(inputId);
    const val = input.value.trim();
    const statusEl = $(provider + 'KeyStatus');
    if (!val) return;
    const btn = $(btnId);
    const originalText = btn.textContent;
    btn.textContent = 'Saving…'; btn.disabled = true;
    if (statusEl) statusEl.textContent = '';
    try {
      const r = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ provider, key: val }),
      });
      const data = await r.json();
      if (!r.ok) {
        if (statusEl) statusEl.textContent = '✗ Save failed: ' + (data.error?.message || JSON.stringify(data.error));
        return;
      }
      state[provider + 'KeySet'] = true;
      input.value = '';
      input.placeholder = 'Key saved — enter a new one to replace';
      if (statusEl) statusEl.textContent = '✓ Saved';
      if (onSaved) onSaved();
    } catch (e) {
      if (statusEl) statusEl.textContent = '✗ Save failed: ' + (e.message || e);
    } finally {
      btn.textContent = originalText; btn.disabled = false;
    }
  }
  $('saveAnamKey')?.addEventListener('click', () => saveProviderKey('anam', 'anamApiKey', 'saveAnamKey', () => { loadAnamAvatars(); loadAnamVoices(); }));
  $('saveFalKey')?.addEventListener('click', () => saveProviderKey('fal', 'falApiKey', 'saveFalKey', () => updateLfKeyHint()));
  document.querySelectorAll('.eyeToggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.revealFor);
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });

  function renderChatThread(){
    const el = $('chatThread');
    el.innerHTML = chatMessages.map(m => `
      <div class="msgRow ${m.role === 'user' ? 'user' : 'ai'}"><div class="bubble">${m.content.replace(/</g,'&lt;')}</div></div>
    `).join('');
    el.scrollIntoView({ block: 'end' });
  }

  async function saveChat(title){
    if (!currentUser) return;
    if (currentChatId) {
      await supabase.from('video_call_chats').update({
        messages: chatMessages, provider: 'anam',
        title: title || undefined, updated_at: new Date().toISOString(),
      }).eq('id', currentChatId);
    } else {
      const { data } = await supabase.from('video_call_chats').insert({
        user_id: currentUser.id, messages: chatMessages, provider: 'anam',
        title: title || 'New chat',
      }).select('id').single();
      if (data) currentChatId = data.id;
    }
  }

  async function sendChatMessage(){
    const text = $('briefInput').value.trim();
    if (!text) return;
    $('briefInput').value = ''; autoGrow();
    chatMessages.push({ role: 'user', content: text });
    renderChatThread();

    chatMessages.push({ role: 'assistant', content: '…' });
    const thinkingIdx = chatMessages.length - 1;
    renderChatThread();

    try {
      const r = await fetch('/api/chat-respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: chatMessages.slice(0, -1).map(m => ({ role: m.role, content: m.content })) }),
      });
      const data = await r.json();
      chatMessages[thinkingIdx] = { role: 'assistant', content: r.ok ? data.reply : ('Error: ' + JSON.stringify(data.error)) };
      renderChatThread();

      // Fold the whole conversation so far into the persona brief the call actually uses.
      state.systemPrompt = chatMessages.filter(m => m.role === 'user').map(m => m.content).join(' ');
      persist();
      if (r.ok && data.title) saveChat(data.title);
      else saveChat();
    } catch (e) {
      chatMessages[thinkingIdx] = { role: 'assistant', content: 'Connection error — try again.' };
      renderChatThread();
    }
  }

  function startNewChat(){
    currentChatId = null;
    chatMessages = [];
    state.systemPrompt = '';
    $('briefInput').value = '';
    autoGrow();
    $('homeHint').textContent = '';
    renderChatThread();
  }
  $('newChatBtn')?.addEventListener('click', startNewChat);


  async function loadAnamAvatars(){
    const sel = $('anamAvatarId');
    if (!state.anamKeySet) { sel.innerHTML = '<option value="">Add your Anam API key in the API screen first</option>'; return; }
    try {
      const r = await fetch('/api/anam?resource=avatars', { headers: await authHeader() });
      const data = await r.json();
      if (!r.ok) { sel.innerHTML = `<option value="">Error: ${JSON.stringify(data.error).slice(0,120)}</option>`; return; }
      const avatars = data.avatars || [];
      const options = avatars.map(a => `<option value="${a.id}">${a.name}</option>`);
      if (state.anamAvatarId && !avatars.some(a => a.id === state.anamAvatarId)) {
        options.unshift(`<option value="${state.anamAvatarId}">${state.anamAvatarName || state.anamAvatarId}</option>`);
      }
      if (!options.length) { sel.innerHTML = '<option value="">No avatars found</option>'; return; }
      sel.innerHTML = options.join('');
      if (state.anamAvatarId) sel.value = state.anamAvatarId;
      sel.onchange = () => {
        state.anamAvatarId = sel.value;
        state.anamAvatarName = sel.options[sel.selectedIndex]?.textContent || '';
        persist();
        updateAnamAvatarSummary();
      };
    } catch (e) { sel.innerHTML = '<option value="">Could not load avatars</option>'; }
  }

  async function loadAnamVoices(){
    const sel = $('anamVoiceId');
    if (!sel) return;
    if (!state.anamKeySet) { sel.innerHTML = '<option value="">Add your Anam API key in the API screen first</option>'; return; }
    try {
      const r = await fetch('/api/anam?resource=voices', { headers: await authHeader() });
      const data = await r.json();
      if (!r.ok) { sel.innerHTML = `<option value="">Error: ${JSON.stringify(data.error).slice(0,120)}</option>`; return; }
      const voices = data.voices || [];
      const options = voices.map(v => `<option value="${v.id}">${v.name}</option>`);
      if (state.anamVoiceId && !voices.some(v => v.id === state.anamVoiceId)) {
        options.unshift(`<option value="${state.anamVoiceId}">${state.anamVoiceName || state.anamVoiceId}</option>`);
      }
      sel.innerHTML = '<option value="">Default voice</option>' + options.join('');
      if (state.anamVoiceId) sel.value = state.anamVoiceId;
      updateVoiceCloneVisibility();
      sel.onchange = () => {
        state.anamVoiceId = sel.value;
        state.anamVoiceName = sel.options[sel.selectedIndex]?.textContent || '';
        persist();
        updateAnamAvatarSummary();
        updateVoiceCloneVisibility();
      };
    } catch (e) { sel.innerHTML = '<option value="">Could not load voices</option>'; }
  }


  // ---------------------------------------------------------------- Anam avatar subscreen
  function updateVoiceCloneVisibility(){
    const hasVoice = !!state.anamVoiceId;
    const section = $('voiceCloneSection');
    if (section) section.style.display = hasVoice ? 'none' : 'block';
    if (!hasVoice) $('voicePreviewRow').style.display = 'none'; // nothing active left to preview
  }
  function updateAnamAvatarSummary(){
    const parts = [];
    if (state.anamAvatarName) parts.push(state.anamAvatarName);
    if (state.anamVoiceName) parts.push(state.anamVoiceName);
    $('anamAvatarSummary').textContent = parts.join(' · ') || 'Not set';
    $('avatarPhotoTips').style.display = state.anamAvatarId ? 'none' : 'flex';
  }
  $('openAnamAvatarScreen')?.addEventListener('click', () => {
    $('anamAvatarScreen').classList.add('active');
    loadAnamAvatars();
    loadAnamVoices();
  });
  $('closeAnamAvatarScreen')?.addEventListener('click', () => {
    $('anamAvatarScreen').classList.remove('active');
    updateAnamAvatarSummary();
  });

  $('anamAvatarMenuBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.anamAvatarId) return;
    openActionMenu($('anamAvatarMenuBtn'), [{
      label: 'Delete this avatar',
      danger: true,
      onClick: async () => {
        if (!confirm(`Delete "${state.anamAvatarName || 'this avatar'}" from your Anam account? This can't be undone.`)) return;
        const r = await fetch(`/api/anam?type=avatar&id=${encodeURIComponent(state.anamAvatarId)}`, {
          method: 'DELETE',
          headers: await authHeader(),
        });
        const data = await r.json();
        if (!r.ok) { alert('Delete failed: ' + JSON.stringify(data.error)); return; }
        state.anamAvatarId = ''; state.anamAvatarName = '';
        await persist();
        loadAnamAvatars();
        updateAnamAvatarSummary();
      },
    }]);
  });

  $('anamVoiceMenuBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.anamVoiceId) return;
    openActionMenu($('anamVoiceMenuBtn'), [{
      label: 'Delete this voice',
      danger: true,
      onClick: async () => {
        if (!confirm(`Delete "${state.anamVoiceName || 'this voice'}" from your Anam account? This can't be undone.`)) return;
        const r = await fetch(`/api/anam?type=voice&id=${encodeURIComponent(state.anamVoiceId)}`, {
          method: 'DELETE',
          headers: await authHeader(),
        });
        const data = await r.json();
        if (!r.ok) { alert('Delete failed: ' + JSON.stringify(data.error)); return; }
        state.anamVoiceId = ''; state.anamVoiceName = '';
        await persist();
        loadAnamVoices();
        updateAnamAvatarSummary();
      },
    }]);
  });

  // ---------------------------------------------------------------- Anam custom avatar photo
  $('openAvatarUpload')?.addEventListener('click', () => $('avatarPhotoInput').click());
  $('avatarPhotoInput')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = ''; // allow picking the same file again later
    if (!file) return;
    const statusEl = $('avatarUploadStatus');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      statusEl.textContent = 'Use a PNG, JPEG, or WEBP photo.'; return;
    }
    if (file.size > 4.5 * 1024 * 1024) {
      statusEl.textContent = 'Photo is too large — 4.5MB max.'; return;
    }
    if (!state.anamKeySet) { statusEl.textContent = 'Add your Anam API key first.'; return; }
    try {
      statusEl.textContent = 'Uploading photo…';
      const ext = file.type.split('/')[1];
      const path = `${currentUser.id}/avatars/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from('user-uploads').upload(path, file, { contentType: file.type, upsert: true });
      if (upErr) { statusEl.textContent = 'Upload failed: ' + upErr.message; return; }
      const { data: pub } = supabase.storage.from('user-uploads').getPublicUrl(path);

      statusEl.textContent = 'Creating your avatar…';
      const r = await fetch('/api/anam', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ action: 'upload-avatar', imageUrl: pub.publicUrl, displayName: (state.displayName ? `${state.displayName}'s avatar` : 'My avatar') }),
      });
      const data = await r.json();
      if (!r.ok) { statusEl.textContent = 'Anam error: ' + JSON.stringify(data.error).slice(0, 140); return; }

      state.anamAvatarId = data.id;
      state.anamAvatarName = data.name;
      await persist();
      statusEl.textContent = 'Saved — ' + data.name;
      loadAnamAvatars();
      updateAnamAvatarSummary();
    } catch (err) {
      statusEl.textContent = 'Failed: ' + (err.message || err);
    }
  });

  // ---------------------------------------------------------------- Anam voice cloning
  let voiceRecorder = null, voiceChunks = [], voiceTimer = null, voiceSeconds = 0;
  const VOICE_MAX_SECONDS = 30;

  function setVoiceRecordUI(recording){
    $('voiceRecordBtn').textContent = recording ? 'Stop' : 'Record';
  }

  $('voiceRecordBtn')?.addEventListener('click', () => {
    if (voiceRecorder && voiceRecorder.state === 'recording') stopVoiceRecording();
    else startVoiceRecording();
  });

  async function startVoiceRecording(){
    const statusEl = $('voiceRecordStatus');
    if (!state.anamKeySet) { statusEl.textContent = 'Add your Anam API key first.'; return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceChunks = [];
      voiceRecorder = new MediaRecorder(stream);
      voiceRecorder.ondataavailable = (e) => { if (e.data.size > 0) voiceChunks.push(e.data); };
      voiceRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        clearInterval(voiceTimer);
        setVoiceRecordUI(false);
        const blob = new Blob(voiceChunks, { type: voiceRecorder.mimeType || 'audio/webm' });
        await uploadVoiceClip(blob);
      };
      voiceRecorder.start();
      voiceSeconds = 0;
      setVoiceRecordUI(true);
      statusEl.textContent = `Recording… ${voiceSeconds}s`;
      voiceTimer = setInterval(() => {
        voiceSeconds++;
        statusEl.textContent = `Recording… ${voiceSeconds}s`;
        if (voiceSeconds >= VOICE_MAX_SECONDS) stopVoiceRecording();
      }, 1000);
    } catch (e) {
      statusEl.textContent = 'Microphone permission is required.';
    }
  }

  function stopVoiceRecording(){
    if (voiceRecorder && voiceRecorder.state !== 'inactive') voiceRecorder.stop();
  }

  async function uploadVoiceClip(blob){
    const statusEl = $('voiceRecordStatus');
    statusEl.textContent = 'Uploading…';
    $('voicePreviewRow').style.display = 'none';
    try {
      // A recorded Blob has no filename (only File objects from a file input do) - derive
      // one from its mime type since Anam's presigned-upload endpoint requires both.
      const contentType = blob.type || 'audio/webm';
      const ext = (blob.name && blob.name.includes('.')) ? blob.name.split('.').pop()
        : (contentType.split('/')[1] || 'webm').split(';')[0];
      const filename = blob.name || `voice-${Date.now()}.${ext}`;

      const urlResp = await fetch('/api/anam', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ action: 'voice-upload-url', filename, contentType, fileSize: blob.size }),
      });
      const urlData = await urlResp.json();
      if (!urlResp.ok) { statusEl.textContent = 'Error: ' + JSON.stringify(urlData.error).slice(0, 140); return; }

      await fetch(urlData.uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: blob });

      const createResp = await fetch('/api/anam', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ action: 'create-voice', audioKey: urlData.audioKey, displayName: (state.displayName ? `${state.displayName}'s voice` : 'My voice') }),
      });
      const createData = await createResp.json();
      if (!createResp.ok) { statusEl.textContent = 'Error: ' + JSON.stringify(createData.error).slice(0, 140); return; }

      state.anamVoiceId = createData.id;
      state.anamVoiceName = createData.name;
      await persist();
      statusEl.textContent = 'Saved — ' + createData.name;
      // Anam doesn't expose a way to synthesize a quick sample from a brand-new voice
      // outside of a live session, so this plays back the exact clip that was just
      // cloned from - the honest, reliable version of "hear how it sounds."
      const audioEl = $('voicePreviewAudio');
      audioEl.src = URL.createObjectURL(blob);
      $('voicePreviewRow').style.display = 'flex';
      loadAnamVoices();
      updateAnamAvatarSummary();
    } catch (err) {
      statusEl.textContent = 'Upload failed: ' + (err.message || err);
    }
  }

  $('voicePreviewBtn')?.addEventListener('click', () => {
    const audioEl = $('voicePreviewAudio');
    const btn = $('voicePreviewBtn');
    if (!audioEl.src) return;
    if (!audioEl.paused) { audioEl.pause(); return; }
    audioEl.play().catch(() => {});
  });
  $('voicePreviewAudio')?.addEventListener('play', () => { $('voicePreviewBtn').textContent = '❚❚'; });
  $('voicePreviewAudio')?.addEventListener('pause', () => { $('voicePreviewBtn').textContent = '▶'; });
  $('voicePreviewAudio')?.addEventListener('ended', () => { $('voicePreviewBtn').textContent = '▶'; });

  $('voiceUploadBtn')?.addEventListener('click', () => $('voiceFileInput').click());
  $('voiceFileInput')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const statusEl = $('voiceRecordStatus');
    if (!state.anamKeySet) { statusEl.textContent = 'Add your Anam API key first.'; return; }
    if (file.size > 4.5 * 1024 * 1024) { statusEl.textContent = 'Audio file is too large — 4.5MB max.'; return; }
    await uploadVoiceClip(file);
  });


  function renderProfile(){
    $('profileEmail').textContent = state.displayName || 'Add your name';
    $('profileSub').textContent = state.displayName ? (currentUser?.email || '') : 'Complete your profile below';
    if (state.avatarUrl) {
      $('profilePhotoImg').src = state.avatarUrl;
      $('profilePhotoImg').style.display = 'block';
      $('profilePhotoDefault').style.display = 'none';
    } else {
      $('profilePhotoImg').style.display = 'none';
      $('profilePhotoDefault').style.display = 'block';
    }
    updateTabBarAvatar();
  }

  $('profilePhotoBtn')?.addEventListener('click', () => $('profilePhotoInput').click());
  $('profilePhotoInput')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !currentUser) return;
    $('photoUploadHint').textContent = 'Uploading…';
    const path = `${currentUser.id}/profile.${file.name.split('.').pop()}`;
    const { error: upErr } = await supabase.storage.from('user-uploads').upload(path, file, { upsert: true, cacheControl: '3600' });
    if (upErr) { $('photoUploadHint').textContent = 'Upload failed: ' + upErr.message; return; }
    const { data: pub } = supabase.storage.from('user-uploads').getPublicUrl(path);
    state.avatarUrl = pub.publicUrl + '?t=' + Date.now();
    await persist();
    renderProfile();
    $('photoUploadHint').textContent = '';
  });

  function updateTabBarAvatar(){
    const img = $('tabProfileImg'), fallback = $('tabProfileDefault');
    if (!img) return;
    if (state.avatarUrl) { img.src = state.avatarUrl; img.style.display = 'block'; fallback.style.display = 'none'; }
    else { img.style.display = 'none'; fallback.style.display = 'block'; }
  }

  // ---------- push notifications ----------
  const VAPID_PUBLIC_KEY = 'BERe9PaZxK_8m5HY4fqmzJrDcjXd5jDrcgrV8GTiiWC_HXWVKXM-li-jHId_oJ9CE73EYlxTQPhlAOlG_4NdgHw';
  function urlBase64ToUint8Array(base64String){
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }
  // Notifications have no manual toggle in Profile - they're important enough that we
  // just enable them ourselves the moment someone signs in, silently. If permission was
  // already denied at the OS level we can't re-prompt (browsers block that) and just
  // leave it; if it's still undecided, this triggers the native permission prompt.
  async function ensureNotificationsEnabled(){
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) return; // already enabled
      if (Notification.permission === 'denied') return; // can't re-prompt, nothing to do
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      await fetch('/api/save-push-subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
    } catch (e) { console.error('ensureNotificationsEnabled failed:', e); }
  }


  async function addHistory(entry){
    if (!currentUser) return null;
    const { data } = await supabase.from('video_call_history').insert({
      user_id: currentUser.id,
      provider: entry.provider,
      summary: entry.summary,
    }).select('id').single();
    return data?.id || null;
  }
  async function renderRecent(){
    const list = $('recentList');
    if (!currentUser) return;

    // Fetch both AI chats and social calls
    const [chatsRes, socialRes] = await Promise.all([
      supabase.from('video_call_chats').select('*').eq('user_id', currentUser.id).order('updated_at', { ascending: false }).limit(50),
      fetch(SOCIAL_CALL_API_BASE + '/api/social-call/history').then(r => r.json()).catch(() => ({ history: [] }))
    ]);

    const data = chatsRes.data || [];
    const socialCalls = socialRes.history || [];

    if (!data.length && !socialCalls.length) {
      list.innerHTML = '<div class="emptyState">No calls yet. Place a call or brief the AI on Home to start.</div>';
      return;
    }

    const socialRows = socialCalls.map(c => `
      <div class="callRow socialCallRow" style="cursor:default;">
        <div class="chatAvatar" style="background:${c.platform === 'whatsapp' ? '#25D366' : '#2AABEE'};">
          ${c.platform === 'whatsapp'
            ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91C2.13 13.66 2.59 15.36 3.45 16.86L2.05 22L7.3 20.62C8.75 21.41 10.38 21.83 12.04 21.83C17.5 21.83 21.95 17.38 21.95 11.92C21.95 9.27 20.92 6.78 19.05 4.91C17.18 3.03 14.69 2 12.04 2ZM12.05 3.67C14.25 3.67 16.31 4.53 17.87 6.09C19.42 7.65 20.28 9.72 20.28 11.92C20.28 16.46 16.59 20.15 12.04 20.15C10.56 20.15 9.11 19.76 7.85 19.01L7.55 18.83L4.43 19.65L5.26 16.61L5.06 16.29C4.24 14.99 3.8 13.47 3.8 11.91C3.81 7.37 7.5 3.67 12.05 3.67ZM8.79 7.34C8.61 7.34 8.31 7.41 8.06 7.68C7.81 7.95 7.11 8.61 7.11 9.94C7.11 11.27 8.08 12.55 8.22 12.73C8.36 12.92 10.13 15.65 12.84 16.82C13.49 17.1 13.99 17.26 14.38 17.39C15.04 17.6 15.64 17.57 16.11 17.5C16.64 17.42 17.73 16.84 17.96 16.19C18.19 15.54 18.19 14.99 18.12 14.87C18.05 14.75 17.87 14.68 17.6 14.54C17.33 14.4 16 13.75 15.75 13.66C15.5 13.57 15.32 13.52 15.14 13.79C14.96 14.07 14.44 14.68 14.28 14.87C14.13 15.05 13.97 15.07 13.7 14.94C13.43 14.8 12.56 14.52 11.53 13.6C10.73 12.89 10.19 12.01 10.03 11.74C9.87 11.46 10.01 11.31 10.15 11.18C10.27 11.06 10.42 10.86 10.56 10.7C10.7 10.54 10.75 10.42 10.84 10.24C10.93 10.06 10.89 9.9 10.82 9.76C10.75 9.62 10.2 8.27 9.97 7.73C9.75 7.2 9.53 7.28 9.36 7.27C9.21 7.26 9.01 7.26 8.81 7.26L8.79 7.34Z"/></svg>'
            : '<svg viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/></svg>'
          }
        </div>
        <div class="rowMain">
          <div class="name">${(c.name || c.target).replace(/</g,'&lt;')}</div>
          <div class="summary" style="display:flex; align-items:center; gap:6px;">
            <span class="socialBadge ${c.platform}">${c.platform === 'whatsapp' ? 'WhatsApp' : 'Telegram'}</span>
            <span>•</span>
            <span>${c.duration || '0m 0s'}</span>
          </div>
        </div>
        <div class="rowRight">
          <div class="time">${new Date(c.startedAt).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}</div>
        </div>
      </div>
    `).join('');

    const chatRows = data.map(c => {
      const msgs = Array.isArray(c.messages) ? c.messages : [];
      const lastMsg = msgs[msgs.length - 1]?.content || '';
      const title = c.title || 'New chat';
      const initials = title.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
      return `
      <div class="callRow" data-chat-id="${c.id}">
        <div class="chatAvatar">${initials}</div>
        <div class="rowMain" style="cursor:pointer;" data-open-chat-id="${c.id}">
          <div class="name">${title.replace(/</g,'&lt;')}</div>
          <div class="summary">${lastMsg.replace(/</g,'&lt;').slice(0, 80)}</div>
        </div>
        <div class="rowRight">
          <div class="time">${new Date(c.updated_at).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}</div>
          <button class="kebabBtn" data-menu-chat-id="${c.id}" aria-label="Chat options">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="6" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="18" r="1.6" fill="currentColor"/></svg>
          </button>
        </div>
      </div>
    `;
    }).join('');

    list.innerHTML = socialRows + chatRows;
    list.querySelectorAll('[data-open-chat-id]').forEach(row => {
      row.addEventListener('click', () => resumeChat(row.dataset.openChatId, data));
    });
    list.querySelectorAll('[data-menu-chat-id]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const chatId = btn.dataset.menuChatId;
        openActionMenu(btn, [{
          label: 'Delete chat',
          danger: true,
          onClick: async () => {
            if (!confirm('Delete this chat?')) return;
            await supabase.from('video_call_chats').delete().eq('id', chatId);
            if (currentChatId === chatId) startNewChat();
            renderRecent();
          },
        }]);
      });
    });
  }

  function resumeChat(chatId, chats){
    const chat = chats.find(c => c.id === chatId);
    if (!chat) return;
    currentChatId = chat.id;
    chatMessages = Array.isArray(chat.messages) ? chat.messages : [];
    state.systemPrompt = chatMessages.filter(m => m.role === 'user').map(m => m.content).join(' ');
    persist();
    showTab('home');
    renderChatThread();
  }

  const callScreen = $('callScreen'), callIdle = $('callIdle'), callStatus = $('callStatus'), callBottom = $('callBottom');
  const remoteVideo = $('remoteVideo'), liveDot = $('liveDot');
  let anamClient = null, micStream = null, audioCtx = null, callStartedAt = null, callStarting = false;

  function primeAudioSession(){
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      setTimeout(() => { try { osc.stop(); } catch(e){} }, 300);
    } catch (e) {}
  }

  async function startCall(){
    // Guards against the actual root cause of the duplicate-notification bug:
    // repeated taps on the call button (impatience during a slow connect, or a
    // double-tap) each spawned their own Anam session with its own
    // CONNECTION_CLOSED listener. When they all eventually closed, each one
    // independently fired its own /api/call-summary request and push
    // notification - which is exactly the "~50 notifications, same result
    // reworded" symptom (each session had no real transcript, so each got
    // the same generic fallback summary, just from a separate LLM call).
    if (callStarting || callScreen.classList.contains('active')) return;
    callStarting = true;
    try {
    // Prefer whatever is still typed in the box; if it's empty (e.g. already sent as a
    // chat message, which clears the box), fall back to what's actually in the chat.
    const typed = $('briefInput').value.trim();
    state.systemPrompt = typed || chatMessages.filter(m => m.role === 'user').map(m => m.content).join(' ');
    persist();
    if (!state.systemPrompt) {
      $('homeHint').textContent = 'Type what you want it to do first.';
      return;
    }
    if (!state.anamAvatarId) {
      $('homeHint').textContent = 'Pick an avatar first.';
      return;
    }
    $('homeHint').textContent = '';

    callScreen.classList.add('active');
    callIdle.style.display = 'flex';
    $('callConfirm').textContent = `Got it — I'll ${state.systemPrompt.length > 70 ? state.systemPrompt.slice(0, 70).trim() + '…' : state.systemPrompt}`;
    startConnectingMessages();
    liveDot.classList.remove('live');

    primeAudioSession();

    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      stopConnectingMessages();
      callStatus.textContent = 'Microphone permission is required';
      callScreen.classList.remove('active');
      return;
    }

    callStartedAt = Date.now();
    await startAnam();
    } finally {
      callStarting = false;
    }
  }

  // Cycles a few short phrases instead of a single static "Connecting…" - the call
  // still takes a few seconds either way, but rotating text reads as progress
  // instead of a stall.
  const CONNECTING_MESSAGES = ['Connecting…', 'Setting the scene…', 'Warming up the avatar…', 'Almost there…'];
  let connectingMsgTimer = null;
  function startConnectingMessages(){
    let i = 0;
    callStatus.textContent = CONNECTING_MESSAGES[0];
    clearInterval(connectingMsgTimer);
    connectingMsgTimer = setInterval(() => {
      i = (i + 1) % CONNECTING_MESSAGES.length;
      callStatus.textContent = CONNECTING_MESSAGES[i];
    }, 2200);
  }
  function stopConnectingMessages(){
    clearInterval(connectingMsgTimer);
    connectingMsgTimer = null;
  }

  async function startAnam(){
    if (!state.anamKeySet) { callStatus.textContent = 'Add your Anam API key in Profile settings first.'; return; }
    const resp = await fetch('/api/anam', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ action: 'session', avatarId: state.anamAvatarId, voiceId: state.anamVoiceId, systemPrompt: promptWithLanguage() }),
    });
    const data = await resp.json();
    if (!resp.ok) { callStatus.textContent = 'Anam error: ' + JSON.stringify(data.error); return; }

    const { createClient, AnamEvent } = await import('https://esm.sh/@anam-ai/js-sdk@latest');
    anamClient = createClient(data.sessionToken);

    remoteVideo.muted = false;
    remoteVideo.volume = 1.0;

    anamClient.addListener(AnamEvent.VIDEO_PLAY_STARTED, () => {
      remoteVideo.style.display = 'block';
      callIdle.style.display = 'none';
      stopConnectingMessages();
      liveDot.classList.add('live');
      callBottom.classList.remove('hidden');
    });
    anamClient.addListener(AnamEvent.CONNECTION_CLOSED, () => endCall());

    // The Anam SDK owns #remoteVideo directly - it captures its own mic and
    // streams both audio and video into it.
    await anamClient.streamToVideoElement('remoteVideo');
  }

  const LANGUAGE_NAMES = { en:'English', es:'Spanish', fr:'French', pt:'Portuguese', de:'German', ha:'Hausa', yo:'Yoruba', ig:'Igbo', sw:'Swahili', ar:'Arabic', hi:'Hindi', zh:'Chinese' };
  function promptWithLanguage(){
    if (!state.language || state.language === 'en') return state.systemPrompt;
    return `Speak only in ${LANGUAGE_NAMES[state.language] || state.language} for this entire call, regardless of what language the brief below is written in. ${state.systemPrompt}`;
  }

  function endCall(){
    // Idempotent: null callStartedAt out immediately so a second CONNECTION_CLOSED
    // (or a stray call to endCall from anywhere else) can't fire a second
    // summary/push for the same call.
    if (!callStartedAt) return;
    stopConnectingMessages();
    const durationSec = Math.round((Date.now() - callStartedAt) / 1000);
    const startedHistoryUpdate = (async () => {
      const historyId = await addHistory({
        provider: 'anam',
        time: new Date().toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }),
        summary: durationSec > 0 ? `Call ended after ${durationSec}s` : 'Call ended immediately',
      });
      // Fire-and-forget on purpose: the summary takes a few seconds (Anam's
      // session report + our own summarization pass), and the push
      // notification - not this request staying open - is what actually
      // reaches the user if they've already left the app.
      if (!historyId || durationSec <= 0) return;
      try {
        await fetch('/api/call-summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
          body: JSON.stringify({ historyId }),
        });
      } catch (e) { console.error('call-summary request failed:', e); }
    })();
    callStartedAt = null;
    if (anamClient) { try { anamClient.stopStreaming(); } catch(e){} anamClient = null; }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (audioCtx) { try { audioCtx.close(); } catch(e){} audioCtx = null; }
    remoteVideo.srcObject = null;
    remoteVideo.style.display = 'none';
    liveDot.classList.remove('live');
    callBottom.classList.add('hidden');
    callScreen.classList.remove('active');
    callStartedAt = null;
  }

  callScreen.addEventListener('click', (e) => {
    if (e.target.closest('#callTop') || e.target.closest('#callBottom')) return;
    callBottom.classList.toggle('hidden');
    $('callTop').classList.toggle('hidden');
  });

  // ---------------------------------------------------------------- Live Filter (Fal.ai / Decart Lucy 2.5)
  // Runs the user's camera through Fal's real-time video-to-video model over
  // WebRTC. Uses the same per-user Vault key pattern as Anam (see /api/keys.js,
  // /lib/keys.js) - the plaintext Fal key never reaches this client, only a
  // short-lived realtime token minted by /api/fal-realtime-token.
  let lfReferenceImageUrl = '';
  let lfReferenceDescription = ''; // strict, non-hallucinated description of the uploaded photo - see /api/describe-reference.js

  // Mirrors every diagnostic line onto a hidden on-screen log (not shown to
  // the person by default - raw provider/model/token details shouldn't be
  // visible in a screenshot). Tap the pulse logo 5x during a call to reveal
  // it, same pattern as the "tap logo 5x" diagnostic already used at boot.
  function lfDebug(msg){
    console.log('[LiveFilter]', msg);
    const el = $('lfDebugLog');
    if (!el) return;
    const t = new Date().toISOString().slice(11, 19);
    el.textContent += `[${t}] ${msg}\n`;
  }
  let lfDebugTapCount = 0, lfDebugTapTimer = null;
  $('lfPulse')?.addEventListener('click', () => {
    lfDebugTapCount++;
    clearTimeout(lfDebugTapTimer);
    lfDebugTapTimer = setTimeout(() => { lfDebugTapCount = 0; }, 1500);
    if (lfDebugTapCount >= 5) {
      lfDebugTapCount = 0;
      const el = $('lfDebugLog');
      if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }
  });

  // Maps raw provider/network errors to clean, non-technical copy - the raw
  // text still goes to lfDebug() (console + hidden log) for our own diagnosis.
  function lfFriendlyError(raw){
    const s = String(raw || '').toLowerCase();
    if (s.includes('capacity') || s.includes('busy')) return 'Servers are busy right now — please try again in a moment.';
    if (s.includes('token') || s.includes('key') || s.includes('401') || s.includes('unauthorized')) return 'We couldn\u2019t verify your account. Check your API key in Profile \u2192 API.';
    if (s.includes('camera') || s.includes('permission')) return 'Camera access is required to start Live Swap.';
    if (s.includes('timed out') || s.includes('timeout')) return 'This is taking longer than expected. Please try again.';
    if (s.includes('lost') || s.includes('disconnected') || s.includes('failed')) return 'Connection lost. Please try again.';
    return 'Something went wrong starting Live Swap. Please try again.';
  }
  function lfShowError(raw){
    lfClearConnectTimer();
    lfDebug('error shown to user: ' + raw);
    $('lfPulse')?.classList.add('error');
    lfStatus.classList.add('error');
    lfStatus.textContent = lfFriendlyError(raw);
    $('lfRetryBtn').style.display = 'inline-block';
  }
  function lfClearError(){
    $('lfPulse')?.classList.remove('error');
    lfStatus.classList.remove('error');
    $('lfRetryBtn').style.display = 'none';
  }
  $('lfRetryBtn')?.addEventListener('click', () => { lfClearError(); startLiveFilter(); });

  function updateLfKeyHint(){
    $('lfKeyHint').style.display = state.falKeySet ? 'none' : 'block';
    $('lfStartBtn').disabled = !state.falKeySet;
  }

  $('openLfImageUpload')?.addEventListener('click', () => $('lfImageInput').click());
  $('lfImageInput')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const statusEl = $('lfImageStatus');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      statusEl.textContent = 'Use a PNG, JPEG, or WEBP photo.'; return;
    }
    if (file.size > 4.5 * 1024 * 1024) {
      statusEl.textContent = 'Photo is too large — 4.5MB max.'; return;
    }
    try {
      statusEl.textContent = 'Uploading…';
      const ext = file.type.split('/')[1];
      const path = `${currentUser.id}/live-filter/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from('user-uploads').upload(path, file, { contentType: file.type, upsert: true });
      if (upErr) { statusEl.textContent = 'Upload failed: ' + upErr.message; return; }
      const { data: pub } = supabase.storage.from('user-uploads').getPublicUrl(path);
      lfReferenceImageUrl = pub.publicUrl;
      lfReferenceDescription = '';
      $('lfImagePreview').src = lfReferenceImageUrl;
      $('lfImagePreview').style.display = 'block';

      // Auto-describe the photo so the person never has to type a prompt -
      // Decart's docs say resemblance is weak without a literal description
      // of the reference in the prompt text, so we build that automatically.
      statusEl.textContent = 'Analyzing photo…';
      try {
        const dr = await fetch('/api/describe-reference', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
          body: JSON.stringify({ imageUrl: lfReferenceImageUrl }),
        });
        const dd = await dr.json();
        if (dr.ok && dd.description) {
          lfReferenceDescription = dd.description;
          statusEl.textContent = 'Reference photo ready';
          lfDebug('Reference described: ' + dd.description);
        } else {
          statusEl.textContent = 'Reference photo added (auto-description failed — will still work, just less precisely)';
          lfDebug('Describe-reference failed: ' + (dd.error || dr.status));
        }
      } catch (descErr) {
        statusEl.textContent = 'Reference photo added (auto-description failed — will still work, just less precisely)';
        lfDebug('Describe-reference error: ' + (descErr.message || descErr));
      }
    } catch (e) {
      statusEl.textContent = 'Upload failed: ' + (e.message || e);
    }
  });

  const lfCallScreen = $('lfCallScreen'), lfIdle = $('lfIdle'), lfStatus = $('lfStatus'), lfBottom = $('lfBottom');
  const lfRemoteVideo = $('lfRemoteVideo'), lfLiveDot = $('lfLiveDot');
  let lfConnection = null, lfLocalStream = null, lfPc = null, lfConnectTimer = null, lfGotIceServers = false;

  function lfClearConnectTimer(){
    if (lfConnectTimer) { clearTimeout(lfConnectTimer); lfConnectTimer = null; }
  }

  // ---------------------------------------------------------------- Reusable Live Swap Media Source
  // Central reusable output layer for Decart Lucy 2.5 avatar stream.
  // Reused as outgoing video stream for WhatsApp calls, Telegram calls, and the Live Swap screen.
  const LiveSwapMediaSource = {
    stream: null,
    listeners: new Set(),
    forSocialCall: false,
    setStream(s){
      this.stream = s;
      this.listeners.forEach(fn => { try { fn(s); } catch(e){} });
    },
    getStream(){
      return this.stream || (lfRemoteVideo ? lfRemoteVideo.srcObject : null) || (lfPc && lfPc.getRemoteStreams ? lfPc.getRemoteStreams()[0] : null);
    },
    getVideoElement(){
      return lfRemoteVideo;
    },
    onStream(fn){
      this.listeners.add(fn);
      if (this.stream) fn(this.stream);
    },
    isActive(){
      return !!(this.stream || (lfPc && lfPc.connectionState === 'connected'));
    },
    async start(options = {}){
      this.forSocialCall = !!options.forSocialCall;
      await startLiveFilter(0, options);
    },
    stop(){
      this.forSocialCall = false;
      this.stream = null;
      endLiveFilter();
    }
  };

  // Fal's `fal.realtime.connect` client is only a signaling *relay* for this
  // model (and its VTON sibling) - it does not open the WebRTC peer connection
  // for you. `onResult` delivers the raw signaling messages Decart's realtime
  // service sends back (iceServers, sdp offer/answer, ice candidates,
  // ice-restart, prompt/image acks, errors), and the app is expected to build
  // its own RTCPeerConnection, attach the local camera track, exchange
  // SDP/ICE via `connection.send(...)`, and render the incoming remote track
  // into a <video> itself. There is no `stream`/`outputVideo` shorthand for
  // this endpoint - that only exists on Decart's native SDK, not @fal-ai/client.
  // Source: fal.ai/models/decart/lucy2-vton/realtime (same signaling shape
  // documented for decart/lucy-2-5/realtime).
  async function handleLfResult(result){
    // Temporary: surface every message type Fal actually sends so a failed
    // connection tells us exactly which step it got stuck on, instead of
    // guessing again. Safe to trim once this is confirmed working end-to-end.
    lfDebug(`onResult: ${result?.type} ${JSON.stringify(result).slice(0, 200)}`);

    switch (result.type) {
      case 'iceservers':
      case 'iceServers': {
        lfClearConnectTimer();
        lfGotIceServers = true;
        lfStatus.textContent = 'Connecting…';

        const servers = (result.iceservers || result.iceServers || result.ice_servers || [])
          .map((s) => ({ urls: s.urls, username: s.username, credential: s.credential }));

        lfPc = new RTCPeerConnection({ iceServers: servers });
        lfLocalStream.getTracks().forEach((track) => lfPc.addTrack(track, lfLocalStream));

        lfPc.ontrack = (e) => {
          const stream = e.streams[0];
          lfRemoteVideo.srcObject = stream;
          LiveSwapMediaSource.setStream(stream);

          const socialVid = $('socialRemoteVideo');
          if (socialVid) { socialVid.srcObject = stream; socialVid.style.display = 'block'; }
          const prepVid = $('prepAvatarPreview');
          if (prepVid) {
            prepVid.srcObject = stream;
            prepVid.style.display = 'block';
            const ph = $('prepAvatarPlaceholder');
            if (ph) ph.style.display = 'none';
          }

          if (!LiveSwapMediaSource.forSocialCall) {
            if (lfRemoteVideo.style.display !== 'block') {
              lfRemoteVideo.style.display = 'block';
              lfIdle.style.display = 'none';
              lfLiveDot.classList.add('live');
              lfBottom.classList.remove('hidden');
            }
          } else {
            const idle = $('socialCallIdle');
            if (idle) idle.style.display = 'none';
            const lucySt = $('prepLucyStatus');
            if (lucySt) lucySt.textContent = 'Live & Streaming';
            $('prepLucyDot')?.classList.add('live');
          }
        };

        lfPc.onconnectionstatechange = () => {
          console.log('[LiveFilter] pc connectionState:', lfPc.connectionState);
          if (['failed', 'disconnected'].includes(lfPc.connectionState)) {
            lfIdle.style.display = 'flex';
            lfBottom.classList.add('hidden');
            lfLiveDot.classList.remove('live');
            lfShowError('connection lost');
          }
        };

        lfPc.onicecandidate = (e) => {
          if (e.candidate) {
            lfConnection.send({
              type: 'icecandidate',
              candidate: {
                candidate: e.candidate.candidate,
                sdpMid: e.candidate.sdpMid,
                sdpMLineIndex: e.candidate.sdpMLineIndex,
              },
            });
          }
        };

        const offer = await lfPc.createOffer();
        await lfPc.setLocalDescription(offer);
        lfConnection.send({ type: 'offer', sdp: offer.sdp });
        break;
      }
      case 'answer':
        if (lfPc) await lfPc.setRemoteDescription({ type: 'answer', sdp: result.sdp });
        break;
      case 'icecandidate':
        if (lfPc) await lfPc.addIceCandidate(new RTCIceCandidate(result.candidate));
        break;
      case 'ice-restart':
        if (result.turn_config && lfPc) {
          lfPc.setConfiguration({
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              {
                urls: result.turn_config.server_url,
                username: result.turn_config.username,
                credential: result.turn_config.credential,
              },
            ],
          });
          const offer = await lfPc.createOffer({ iceRestart: true });
          await lfPc.setLocalDescription(offer);
          lfConnection.send({ type: 'offer', sdp: offer.sdp });
        }
        break;
      case 'prompt_ack':
        if (!result.success) console.error('Prompt failed:', result.error);
        break;
      case 'set_image_ack':
        if (!result.success) console.error('Image failed:', result.error);
        break;
      case 'generation_started':
        break;
      case 'error':
        lfClearConnectTimer();
        console.error('Fal realtime server error:', result.error);
        lfShowError(result.error?.message || result.error || 'unknown');
        break;
      default:
        // An unrecognized message type means Fal is sending something this
        // switch doesn't handle yet - log it instead of silently ignoring it.
        console.log('[LiveFilter] Unhandled result type:', result?.type, result);
    }
  }

  // Mints a Fal realtime token directly, outside of the fal client, so a
  // failure here shows up as a specific, visible error instead of getting
  // swallowed inside fal.realtime.connect()'s internal tokenProvider call
  // (which is the leading suspect for a silent "Connecting…" hang that never
  // reaches Fal at all - if this never resolves/rejects visibly, nothing
  // downstream ever gets a chance to open the actual WebSocket).
  async function fetchLfToken(app){
    lfDebug(`requesting token for app: ${app}`);
    const r = await fetch('/api/fal-realtime-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ app }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      const fp = body.keyFingerprint ? ` [key: ${body.keyFingerprint}]` : '';
      const msg = `Token request failed (${r.status}) for app "${app}": ${body.error || 'no error message'}${fp}`;
      lfDebug(msg);
      throw new Error(msg);
    }
    const token = await r.text();
    if (!token || token.trim().startsWith('{')) {
      const msg = `Server returned 200 but body isn't a token (looks like JSON): ${token.slice(0, 300)}`;
      lfDebug(msg);
      throw new Error(msg);
    }
    lfDebug(`got token for app "${app}", length: ${token?.length}, prefix: ${token?.slice(0, 12)}…`);
    return token;
  }

  async function startLiveFilter(retryCount, { forSocialCall = false } = {}){
    retryCount = retryCount || 0;
    LiveSwapMediaSource.forSocialCall = !!forSocialCall;
    if (!state.falKeySet) {
      if (forSocialCall) {
        // Fallback for social call if Fal key is not configured: activate user camera for the call
        try {
          if (lfLocalStream) { lfLocalStream.getTracks().forEach(t => t.stop()); lfLocalStream = null; }
          lfLocalStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } }
          });
          const socialVid = $('socialRemoteVideo');
          if (socialVid) { socialVid.srcObject = lfLocalStream; }
          const socialSelfVid = $('socialSelfVideo');
          if (socialSelfVid) { socialSelfVid.srcObject = lfLocalStream; }
          const prepVid = $('prepAvatarPreview');
          if (prepVid) { prepVid.srcObject = lfLocalStream; prepVid.style.display = 'block'; $('prepAvatarPlaceholder').style.display = 'none'; }
          LiveSwapMediaSource.setStream(lfLocalStream);
          const idle = $('socialCallIdle');
          if (idle) idle.style.display = 'none';
          $('prepLucyStatus').textContent = 'Camera ready';
          $('prepLucyDot')?.classList.add('live');
          return;
        } catch(e) {
          lfShowError('camera permission');
          return;
        }
      }
      updateLfKeyHint();
      return;
    }
    // The person never has to type anything: if a reference photo is set, its
    // strict auto-description IS the prompt. Anything typed in the box is an
    // ADDITIONAL instruction appended after it (e.g. a background change),
    // never a replacement for the description.
    const extra = $('lfPrompt').value.trim();
    let prompt;
    if (lfReferenceImageUrl && lfReferenceDescription) {
      prompt = `Substitute the character in the video with ${lfReferenceDescription}.`;
      if (extra) prompt += ` ${extra}`;
    } else {
      prompt = extra || undefined;
    }
    $('lfStartStatus').textContent = '';

    lfClearError();
    if (!forSocialCall) {
      lfCallScreen.classList.add('active');
      lfIdle.style.display = 'flex';
    }
    lfStatus.textContent = 'Connecting…';
    lfLiveDot.classList.remove('live');
    lfGotIceServers = false;
    lfClearConnectTimer();
    if (retryCount === 0) $('lfDebugLog').textContent = '';
    lfDebug(`fal client version check: importing esm.sh/@fal-ai/client@latest`);

    try {
      if (lfLocalStream) { lfLocalStream.getTracks().forEach(t => t.stop()); lfLocalStream = null; }
      // Constrained to Decart's documented native input spec for this model
      // (roughly 1088x624 @ 30fps) - capturing at an arbitrary resolution
      // makes the model work harder to reconcile mismatched input, which
      // shows up as both slower responses and less stable/consistent output.
      lfLocalStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1088 }, height: { ideal: 624 }, frameRate: { ideal: 30, max: 30 } },
      });
      const socialSelfVid = $('socialSelfVideo');
      if (socialSelfVid) { socialSelfVid.srcObject = lfLocalStream; }
    } catch (e) {
      lfShowError('camera permission');
      return;
    }

    // Prove the token endpoint itself works, with its own visible error,
    // before ever handing control to the fal client. If this step fails,
    // it explains a hang that never touches Fal (the WebSocket to Fal never
    // opens without a valid token) and points straight at /api/fal-realtime-token
    // or the saved Fal key rather than the WebRTC signaling logic.
    try {
      lfStatus.textContent = 'Connecting…';
      await fetchLfToken('decart/lucy-2-5/realtime');
    } catch (e) {
      lfDebug(`token fetch failed: ${e.message || e}`);
      lfShowError('key ' + (e.message || e));
      return;
    }

    try {
      lfStatus.textContent = 'Opening connection…';
      // Fal's realtime client - loaded from esm.sh the same way the Anam SDK
      // is above, so no build step / bundler is needed for this single-file app.
      const { fal } = await import('https://esm.sh/@fal-ai/client@latest');
      lfDebug('fal client module loaded');

      lfConnection = fal.realtime.connect('decart/lucy-2-5/realtime', {
        connectionKey: `lf-${Date.now()}`,
        throttleInterval: 0,
        tokenProvider: (app) => { lfDebug(`tokenProvider invoked by fal client with app="${app}"`); return fetchLfToken(app); },
        tokenExpirationSeconds: 120,
        onResult: handleLfResult,
        onError: (err) => {
          lfClearConnectTimer();
          const msg = err?.message || (() => { try { return JSON.stringify(err); } catch { return String(err); } })();
          lfDebug(`onError fired: ${msg}`);
          lfShowError(msg);
        },
      });
      lfDebug(`fal.realtime.connect() returned, connection object: ${lfConnection ? 'created' : 'null/undefined'}`);

      // If we never even get the `iceservers` message back, the WebSocket to
      // Fal itself is the problem (network/CSP/auth) rather than anything in
      // the WebRTC offer/answer logic below it. A single stalled attempt is
      // common enough (cold start, transient network blip) that it's worth
      // one silent automatic retry before making the person manually restart -
      // only surface the error if it stalls twice in a row.
      lfConnectTimer = setTimeout(() => {
        if (!lfGotIceServers) {
          if (retryCount < 1) {
            lfDebug('45s elapsed, no response - retrying once automatically');
            lfStatus.textContent = 'Still connecting…';
            if (lfConnection) { try { lfConnection.close ? lfConnection.close() : null; } catch(e){} lfConnection = null; }
            startLiveFilter(retryCount + 1);
          } else {
            lfDebug('45s elapsed again on retry, no response - giving up');
            lfShowError('timed out');
          }
        }
      }, 45000);

      // Only the initial prompt/reference-image payload goes through the Fal
      // relay here - the actual WebRTC offer is sent once `handleLfResult`
      // receives the `iceservers` message above.
      const payload = {
        prompt: prompt || undefined,
        reference_image_url: lfReferenceImageUrl || undefined,
        // Off, not on: expansion rewrites/pads out what's sent with invented
        // extra detail, which is a plausible reason identity swap sometimes
        // only partially applies (clothes change, face doesn't) - keeping
        // the request literal keeps the reference's intent from getting
        // diluted by auto-added description.
        enable_prompt_expansion: false,
      };
      lfDebug(`sending initial payload: ${JSON.stringify(payload)}`);
      lfConnection.send(payload);
      lfDebug('initial payload sent, waiting for onResult/onError…');
    } catch (e) {
      lfClearConnectTimer();
      lfDebug(`failed to start (exception): ${e.message || e}`);
      lfShowError(e.message || e);
    }
  }

  function endLiveFilter(){
    lfClearConnectTimer();
    if (lfPc) { try { lfPc.close(); } catch(e){} lfPc = null; }
    if (lfConnection) { try { lfConnection.close ? lfConnection.close() : lfConnection.send({ close: true }); } catch(e){} lfConnection = null; }
    if (lfLocalStream) { lfLocalStream.getTracks().forEach(t => t.stop()); lfLocalStream = null; }
    lfRemoteVideo.srcObject = null;
    lfRemoteVideo.style.display = 'none';
    lfLiveDot.classList.remove('live');
    lfBottom.classList.add('hidden');
    lfCallScreen.classList.remove('active');

    const socialVid = $('socialRemoteVideo');
    if (socialVid) socialVid.srcObject = null;
    const socialSelfVid = $('socialSelfVideo');
    if (socialSelfVid) socialSelfVid.srcObject = null;
    const prepVid = $('prepAvatarPreview');
    if (prepVid) { prepVid.srcObject = null; prepVid.style.display = 'none'; $('prepAvatarPlaceholder').style.display = 'block'; }
    LiveSwapMediaSource.stream = null;
    LiveSwapMediaSource.forSocialCall = false;
  }

  $('lfStartBtn')?.addEventListener('click', () => startLiveFilter());
  $('lfEndBtn')?.addEventListener('click', endLiveFilter);
  lfCallScreen.addEventListener('click', (e) => {
    if (e.target.closest('#lfTop') || e.target.closest('#lfBottom')) return;
    lfBottom.classList.toggle('hidden');
    $('lfTop').classList.toggle('hidden');
  });

  let muted = false;
  $('muteBtn')?.addEventListener('click', () => {
    muted = !muted;
    if (micStream) micStream.getAudioTracks().forEach(t => t.enabled = !muted);
    $('muteBtn').classList.toggle('muted', muted);
    $('muteBtn').innerHTML = muted
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8"><path d="M3 3l18 18"/><path d="M12 1a3 3 0 0 0-3 3v6.5M15 9V4a3 3 0 0 0-3-3"/><path d="M19 10v2a7 7 0 0 1-9.8 6.4M5 10v2a7 7 0 0 0 2 4.9"/><path d="M12 19v4"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4"/></svg>';
  });

  $('endBtn')?.addEventListener('click', endCall);

  // ==============================================================================
  // SOCIAL CALLING ARCHITECTURE (WhatsApp & Telegram with Lucy 2.5 Live Swap)
  // ==============================================================================

  // The WhatsApp/Telegram bridges (server.mjs + the Baileys/Pyrogram processes)
  // only run on the long-lived Render service - they can't live on Vercel's
  // serverless functions, which have no persistent process and no WebSocket
  // support. This app's static files are served from Vercel, so a *relative*
  // fetch('/api/social-call/...') resolves against the Vercel origin instead,
  // which has no matching route and answers with its own 404 HTML page -
  // res.json() then throws a JSON-parse error on that HTML body. Pointing
  // these calls at the Render origin explicitly is the fix.
  const SOCIAL_CALL_API_BASE = 'https://live-call-f3qm.onrender.com';

  let currentSocialPlatform = null; // 'whatsapp' | 'telegram'
  let selectedSocialContact = null; // { name, target }
  let selectedCallSource = 'lucy'; // 'lucy' | 'avatar' - which outgoing source to use for a social call
  let socialMicStream = null;
  let socialCallDurationTimer = null;

  // Headless Anam avatar source for social calls - mirrors LiveSwapMediaSource's
  // shape (getStream/getVideoElement/start/stop) so the rest of the social-call
  // code can treat "Lucy 2.5" and "Avatar" interchangeably. Deliberately uses
  // its own client/video element, separate from callScreen's own anamClient/
  // remoteVideo, so starting a social avatar call can never interfere with
  // the regular AI-avatar call screen (which stays exactly as it was).
  const SocialAnamSource = {
    client: null,
    videoEl: null,
    getVideoElement(){ return this.videoEl; },
    getStream(){ return this.videoEl && this.videoEl.captureStream ? this.videoEl.captureStream() : null; },
    isActive(){ return !!this.client; },
    async start(){
      const vid = $('prepAvatarPreview');
      this.videoEl = vid;
      if (!state.anamKeySet) throw new Error('Add your Anam API key in Profile settings first.');
      if (!state.anamAvatarId) throw new Error('Pick an avatar first.');
      const resp = await fetch('/api/anam', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ action: 'session', avatarId: state.anamAvatarId, voiceId: state.anamVoiceId, systemPrompt: promptWithLanguage() }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error('Anam error: ' + JSON.stringify(data.error));

      const { createClient, AnamEvent } = await import('https://esm.sh/@anam-ai/js-sdk@latest');
      this.client = createClient(data.sessionToken);
      vid.muted = false;
      vid.volume = 1.0;
      vid.style.display = 'block';
      $('prepAvatarPlaceholder').style.display = 'none';
      const idle = $('socialCallIdle');
      this.client.addListener(AnamEvent.VIDEO_PLAY_STARTED, () => {
        if (idle) idle.style.display = 'none';
        $('prepLucyStatus').textContent = 'Avatar ready';
        $('prepLucyDot')?.classList.add('live');
        // The bug: Anam's SDK streams into prepAvatarPreview (which also
        // feeds the OUTGOING call capture), but nothing ever mirrored that
        // onto socialRemoteVideo - the actual on-screen big view during a
        // call. Only LiveSwapMediaSource's own WebRTC handler ever touched
        // socialRemoteVideo, so Avatar mode's screen stayed black even
        // though the avatar itself was working and being sent out fine.
        const remoteVid = $('socialRemoteVideo');
        if (remoteVid && vid.srcObject) remoteVid.srcObject = vid.srcObject;
      });
      this.client.addListener(AnamEvent.CONNECTION_CLOSED, () => {
        this.client = null;
        if ($('socialCallScreen')?.classList.contains('active')) endSocialCall();
      });
      await this.client.streamToVideoElement('prepAvatarPreview');

      // Avatar mode doesn't need your camera for the call itself, but the
      // self-view PIP still needs something to show - best-effort only,
      // never blocks the call if the camera isn't available/granted.
      try {
        if (!lfLocalStream) {
          lfLocalStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
          });
        }
        const selfVid = $('socialSelfVideo');
        if (selfVid) selfVid.srcObject = lfLocalStream;
      } catch(e) { /* self-view preview only - fine to skip */ }
    },
    stop(){
      if (this.client) { try { this.client.stopStreaming(); } catch(e){} this.client = null; }
      if (this.videoEl) { this.videoEl.style.display = 'none'; }
      const ph = $('prepAvatarPlaceholder');
      if (ph) ph.style.display = 'block';
      if (lfLocalStream) { lfLocalStream.getTracks().forEach(t => t.stop()); lfLocalStream = null; }
      const selfVid = $('socialSelfVideo');
      if (selfVid) selfVid.srcObject = null;
      const remoteVid = $('socialRemoteVideo');
      if (remoteVid) remoteVid.srcObject = null;
    },
  };

  function activeSocialSource(){
    return selectedCallSource === 'avatar' ? SocialAnamSource : LiveSwapMediaSource;
  }

  $('prepSourceLucyBtn')?.addEventListener('click', () => {
    selectedCallSource = 'lucy';
    $('prepSourceLucyBtn').classList.add('active');
    $('prepSourceAvatarBtn').classList.remove('active');
    $('prepSourceLabel').textContent = 'Live Swap / Lucy 2.5';
    $('prepPreviewPlaceholderLabel').textContent = 'Lucy 2.5 Live Swap Preview';
    $('prepLucyStatus').textContent = 'Ready to stream';
  });
  $('prepSourceAvatarBtn')?.addEventListener('click', () => {
    selectedCallSource = 'avatar';
    $('prepSourceAvatarBtn').classList.add('active');
    $('prepSourceLucyBtn').classList.remove('active');
    $('prepSourceLabel').textContent = 'AI Avatar (Anam)';
    $('prepPreviewPlaceholderLabel').textContent = 'AI Avatar Preview';
    $('prepLucyStatus').textContent = state.anamAvatarId ? 'Ready to stream' : 'Pick an avatar in Profile first';
  });

  let socialCallStartedAt = null;
  let socialMuted = false;
  let waStatusPollTimer = null;

  // Social Call Media Adapter
  // Pipes real-time Lucy 2.5 Live Swap video frames and mic audio to social call bridge
  const SocialCallMediaAdapter = {
    ws: null,
    frameTimer: null,
    audioProcessor: null,
    micAudioCtx: null,
    active: false,
    initWs(){
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
      this.ws = new WebSocket(SOCIAL_CALL_API_BASE.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') + '/api/social-call/media');
      this.ws.binaryType = 'arraybuffer';
      this.ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          handleMediaWsMessage(msg);
        } catch(err){}
      };
      this.ws.onclose = () => {
        if (this.active) setTimeout(() => this.initWs(), 2000);
      };
    },
    startStreaming(stream, micStream){
      this.active = true;
      this.initWs();

      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 640;
      const ctx = canvas.getContext('2d');
      const vid = activeSocialSource().getVideoElement() || $('socialRemoteVideo');

      clearInterval(this.frameTimer);
      // 15 fps loop matching WhatsApp and PyTgCalls video specification
      this.frameTimer = setInterval(() => {
        if (!this.active || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (vid && (vid.videoWidth || vid.readyState >= 2)) {
          ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((blob) => {
            if (!blob || !this.active || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            blob.arrayBuffer().then((buf) => {
              const tagged = new Uint8Array(buf.byteLength + 1);
              tagged[0] = 0x01; // 0x01 = Lucy 2.5 Video Frame
              tagged.set(new Uint8Array(buf), 1);
              this.ws.send(tagged);
            });
          }, 'image/jpeg', 0.7);
        }
      }, 1000 / 15);

      // Mic PCM 16kHz audio stream
      if (micStream && micStream.getAudioTracks().length) {
        try {
          this.micAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
          const source = this.micAudioCtx.createMediaStreamSource(micStream);
          this.audioProcessor = this.micAudioCtx.createScriptProcessor(2048, 1, 1);
          this.audioProcessor.onaudioprocess = (evt) => {
            if (!this.active || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            const input = evt.inputBuffer.getChannelData(0);
            const pcm16 = new Int16Array(input.length);
            for (let i = 0; i < input.length; i++) {
              const s = Math.max(-1, Math.min(1, input[i]));
              pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            const tagged = new Uint8Array(pcm16.buffer.byteLength + 1);
            tagged[0] = 0x02; // 0x02 = Mic PCM Audio
            tagged.set(new Uint8Array(pcm16.buffer), 1);
            this.ws.send(tagged);
          };
          source.connect(this.audioProcessor);
          this.audioProcessor.connect(this.micAudioCtx.destination);
        } catch(e){}
      }
    },
    stop(){
      this.active = false;
      clearInterval(this.frameTimer);
      if (this.audioProcessor) { try { this.audioProcessor.disconnect(); } catch(e){} this.audioProcessor = null; }
      if (this.micAudioCtx) { try { this.micAudioCtx.close(); } catch(e){} this.micAudioCtx = null; }
      if (this.ws) { try { this.ws.close(); } catch(e){} this.ws = null; }
    }
  };

  function handleMediaWsMessage(msg){
    if (msg.type === 'wa_status' || msg.type === 'wa_qr' || msg.type === 'wa_pairing_code') {
      fetchConnectedStatus();
    }
    if (msg.type === 'wa_call_event' && currentSocialPlatform === 'whatsapp') {
      // Real WhatsApp call signaling status (Baileys' sock.ev.on('call', ...)
      // - genuinely reflects whether the other phone is ringing/answered/
      // declined). Was already being broadcast server-side but never
      // listened for here at all - the call screen had no way to reflect
      // any of it, same class of bug as Telegram's missing state polling.
      const lbl = $('socialCallStatusLabel');
      const status = msg.call?.status;
      if (status === 'offer' || status === 'ringing') {
        if (lbl) lbl.textContent = 'Ringing…';
        startRingback();
      } else if (status === 'accept') {
        if (lbl) lbl.textContent = 'Connected';
        const idle = $('socialCallIdle');
        if (idle) idle.style.display = 'none';
        stopRingback();
      } else if (status === 'reject' || status === 'timeout' || status === 'terminate') {
        stopRingback();
        if (status === 'reject') $('prepErrorHint') && ($('prepErrorHint').textContent = 'Call declined');
        if (status === 'timeout') $('prepErrorHint') && ($('prepErrorHint').textContent = 'No answer');
        endSocialCall();
      }
    }
    if (msg.type === 'call_state') {
      const lbl = $('socialCallStatusLabel');
      if (msg.state === 'ringing') {
        if (lbl) lbl.textContent = 'Ringing…';
        startRingback();
      } else if (msg.state === 'connecting') {
        if (lbl) lbl.textContent = 'Connecting…';
        startRingback(); // keep playing through connecting - stops only once truly connected
      } else if (msg.state === 'connected') {
        if (lbl) lbl.textContent = 'Connected';
        const idle = $('socialCallIdle');
        if (idle) idle.style.display = 'none';
        stopRingback();
      } else if (msg.state === 'failed') {
        stopRingback();
        $('prepErrorHint') && ($('prepErrorHint').textContent = msg.error || 'Call failed');
        endSocialCall();
      } else if (msg.state === 'ended') {
        stopRingback();
        endSocialCall();
      }
    }
  }

  // -------------------------------------------------------------
  // Ringback tone (plays while the other side's phone is actually ringing,
  // i.e. real Telegram P2P calls - WhatsApp/PyTgCalls-Telegram calls don't
  // get real ringing state today so this simply never starts for them).
  // Generated with WebAudio rather than an audio file: a standard North-
  // American-style ringback cadence, 440Hz+480Hz combined tone, 2s on/4s
  // off, looped until the call connects or ends.
  // -------------------------------------------------------------
  let ringbackCtx = null, ringbackTimer = null, ringbackOscillators = [];
  function startRingback(){
    if (ringbackCtx) return; // already playing
    try {
      ringbackCtx = new (window.AudioContext || window.webkitAudioContext)();
      const playTone = () => {
        const gain = ringbackCtx.createGain();
        gain.gain.value = 0.05;
        gain.connect(ringbackCtx.destination);
        [440, 480].forEach((freq) => {
          const osc = ringbackCtx.createOscillator();
          osc.frequency.value = freq;
          osc.connect(gain);
          osc.start();
          ringbackOscillators.push(osc);
        });
        setTimeout(() => {
          ringbackOscillators.forEach((o) => { try { o.stop(); } catch(e){} });
          ringbackOscillators = [];
        }, 2000);
      };
      playTone();
      ringbackTimer = setInterval(playTone, 6000);
    } catch(e) { console.warn('[Ringback] could not start:', e.message); }
  }
  function stopRingback(){
    clearInterval(ringbackTimer);
    ringbackTimer = null;
    ringbackOscillators.forEach((o) => { try { o.stop(); } catch(e){} });
    ringbackOscillators = [];
    if (ringbackCtx) { ringbackCtx.close().catch(()=>{}); ringbackCtx = null; }
  }

  // -------------------------------------------------------------
  // Connected Accounts in Profile
  // -------------------------------------------------------------
  async function fetchConnectedStatus(){
    try {
      const res = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/status');
      if (!res.ok) return;
      const data = await res.json();

      // WhatsApp status
      const wa = data.whatsapp || {};
      const waStatusEl = $('whatsappAccountStatus');
      const waBadgeEl = $('whatsappAccountBadge');
      if (wa.connected && wa.user) {
        if (waStatusEl) waStatusEl.textContent = `Connected as ${wa.user.phone ? '+' + wa.user.phone : wa.user.name}`;
        if (waBadgeEl) {
          waBadgeEl.textContent = 'Connected';
          waBadgeEl.classList.add('connected');
        }
        $('waDetailStatus').textContent = 'Connected';
        $('waDetailSub').textContent = `Linked phone: +${wa.user.phone || ''}`;
        $('waConnectedNumber').textContent = `+${wa.user.phone || ''} (${wa.user.name || 'WhatsApp User'})`;
        $('waNotConnectedView').style.display = 'none';
        $('waConnectedView').style.display = 'block';
        $('choiceWhatsAppSubtitle').textContent = `Connected (+${wa.user.phone || ''})`;
      } else {
        if (waStatusEl) waStatusEl.textContent = 'Not connected';
        if (waBadgeEl) {
          waBadgeEl.textContent = 'Connect';
          waBadgeEl.classList.remove('connected');
        }
        $('waDetailStatus').textContent = wa.status === 'scan_qr' ? 'Waiting for scan…' : 'Disconnected';
        $('waDetailSub').textContent = 'Scan QR code or use pairing code';
        $('waNotConnectedView').style.display = 'block';
        $('waConnectedView').style.display = 'none';
        $('choiceWhatsAppSubtitle').textContent = 'Live Video Call with Lucy 2.5';

        if (wa.qr) {
          const img = $('waQrImg');
          if (img) { img.src = wa.qr; img.style.display = 'block'; }
          const load = $('waQrLoading');
          if (load) load.style.display = 'none';
        }
      }

      // Telegram status
      const tg = data.telegram || {};
      const tgStatusEl = $('telegramAccountStatus');
      const tgBadgeEl = $('telegramAccountBadge');
      if (tg.connected && tg.user) {
        const u = tg.user;
        const disp = u.username ? `@${u.username}` : (u.phone_number || u.first_name || 'Connected');
        if (tgStatusEl) tgStatusEl.textContent = `Connected as ${disp}`;
        if (tgBadgeEl) {
          tgBadgeEl.textContent = 'Connected';
          tgBadgeEl.classList.add('connected');
        }
        $('tgDetailStatus').textContent = 'Connected';
        $('tgDetailSub').textContent = `Linked account: ${disp}`;
        $('tgConnectedUser').textContent = `${u.first_name || ''} (${disp})`;
        $('tgNotConnectedView').style.display = 'none';
        $('tgConnectedView').style.display = 'block';
        $('choiceTelegramSubtitle').textContent = `Connected (${disp})`;
      } else {
        if (tgStatusEl) tgStatusEl.textContent = 'Not connected';
        if (tgBadgeEl) {
          tgBadgeEl.textContent = 'Connect';
          tgBadgeEl.classList.remove('connected');
        }
        $('tgDetailStatus').textContent = 'Disconnected';
        $('tgDetailSub').textContent = 'Enter phone number to receive login code';
        $('tgNotConnectedView').style.display = 'block';
        $('tgConnectedView').style.display = 'none';
        $('choiceTelegramSubtitle').textContent = 'Live Video Call with Lucy 2.5';
      }
    } catch(err){
      console.warn('[fetchConnectedStatus] note:', err.message);
    }
  }

  // Profile -> WhatsApp
  $('openWhatsAppConnect')?.addEventListener('click', () => {
    $('whatsappConnectScreen').classList.add('active');
    fetch(SOCIAL_CALL_API_BASE + '/api/social-call/whatsapp/qr', { method: 'POST' })
      .then(r => r.json())
      .then(() => fetchConnectedStatus())
      .catch((e) => showErrorToast ? showErrorToast(e.message) : console.warn('[WhatsApp QR] note:', e.message));
    clearInterval(waStatusPollTimer);
    waStatusPollTimer = setInterval(fetchConnectedStatus, 3000);
  });
  $('closeWhatsAppConnect')?.addEventListener('click', () => {
    $('whatsappConnectScreen').classList.remove('active');
    clearInterval(waStatusPollTimer);
  });

  $('waTabQrBtn')?.addEventListener('click', () => {
    $('waTabQrBtn').classList.add('active');
    $('waTabPairBtn').classList.remove('active');
    $('waQrBox').style.display = 'block';
    $('waPairBox').style.display = 'none';
  });
  $('waTabPairBtn')?.addEventListener('click', () => {
    $('waTabPairBtn').classList.add('active');
    $('waTabQrBtn').classList.remove('active');
    $('waPairBox').style.display = 'block';
    $('waQrBox').style.display = 'none';
  });

  $('waRefreshQrBtn')?.addEventListener('click', async () => {
    $('waQrLoading').style.display = 'block';
    $('waQrLoading').textContent = 'Refreshing QR code…';
    $('waQrImg').style.display = 'none';
    await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/whatsapp/qr', { method: 'POST' });
    await fetchConnectedStatus();
  });

  $('waGetPairBtn')?.addEventListener('click', async () => {
    const phone = $('waPairPhoneInput').value.trim();
    if (!phone) return alert('Enter phone number with country code');
    $('waGetPairBtn').textContent = 'Generating…';
    try {
      const res = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/whatsapp/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const data = await res.json();
      if (data.code) {
        $('waPairCodeDisplay').textContent = data.code;
        $('waPairResult').style.display = 'block';
      } else if (data.error) {
        alert(data.error);
      }
    } catch(e) {
      alert(e.message);
    } finally {
      $('waGetPairBtn').textContent = 'Get Pairing Code';
    }
  });

  $('waDisconnectBtn')?.addEventListener('click', async () => {
    if (!confirm('Disconnect WhatsApp?')) return;
    await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/whatsapp/disconnect', { method: 'POST' });
    await fetchConnectedStatus();
  });

  // Profile -> Telegram
  $('openTelegramConnect')?.addEventListener('click', () => {
    $('telegramConnectScreen').classList.add('active');
    fetchConnectedStatus();
    fetchP2pStatus();
  });
  $('closeTelegramConnect')?.addEventListener('click', () => {
    $('telegramConnectScreen').classList.remove('active');
  });

  $('tgSendCodeBtn')?.addEventListener('click', async () => {
    const phone = $('tgPhoneInput').value.trim();
    if (!phone) return alert('Enter phone number');
    $('tgSendCodeBtn').textContent = 'Sending code…';
    $('tgSendCodeHint').textContent = '';
    try {
      const res = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/telegram/send_code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number: phone }),
      });
      const data = await res.json();
      if (data.status === 'code_sent') {
        $('tgStepPhone').style.display = 'none';
        $('tgStepCode').style.display = 'block';
      } else {
        $('tgSendCodeHint').textContent = data.error || 'Failed to send code';
      }
    } catch(e){
      $('tgSendCodeHint').textContent = e.message;
    } finally {
      $('tgSendCodeBtn').textContent = 'Send Code';
    }
  });

  $('tgSignInBtn')?.addEventListener('click', async () => {
    const phone = $('tgPhoneInput').value.trim();
    const code = $('tgCodeInput').value.trim();
    const password = $('tgPasswordInput').value.trim();
    if (!code) return alert('Enter verification code');
    $('tgSignInBtn').textContent = 'Signing in…';
    $('tgSignInHint').textContent = '';
    try {
      const res = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/telegram/sign_in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number: phone, phone_code: code, password }),
      });
      const data = await res.json();
      if (data.status === '2fa_required') {
        $('tgPasswordCard').style.display = 'block';
        $('tgSignInHint').textContent = '2FA password required';
      } else if (data.status === 'connected') {
        fetchConnectedStatus();
      } else {
        $('tgSignInHint').textContent = data.error || 'Failed to sign in';
      }
    } catch(e){
      $('tgSignInHint').textContent = e.message;
    } finally {
      $('tgSignInBtn').textContent = 'Confirm & Connect';
    }
  });

  $('tgDisconnectBtn')?.addEventListener('click', async () => {
    if (!confirm('Disconnect Telegram?')) return;
    await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/telegram/disconnect', { method: 'POST' });
    await fetchConnectedStatus();
  });

  // -------------------------------------------------------------
  // Real Calling (P2P) sign-in - a separate Telegram session from the one
  // above, used only for actually placing/ringing calls (tgcalls_bridge).
  // Without this, calls were failing silently before ever ringing -
  // there was no way to authenticate this engine at all until now.
  // -------------------------------------------------------------
  async function fetchP2pStatus(){
    try {
      const res = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/telegram/p2p/status');
      const data = await res.json();
      const connected = !!data.connected;
      $('tgP2pStatus').textContent = connected ? 'Connected' : (data.error ? 'Error' : 'Not connected');
      $('tgP2pNotConnectedView').style.display = connected ? 'none' : 'block';
      $('tgP2pConnectedView').style.display = connected ? 'block' : 'none';
    } catch(e){
      $('tgP2pStatus').textContent = 'Unavailable';
    }
  }

  $('tgP2pSendCodeBtn')?.addEventListener('click', async () => {
    const phone = $('tgP2pPhoneInput').value.trim();
    if (!phone) return alert('Enter phone number');
    $('tgP2pSendCodeBtn').textContent = 'Sending code…';
    $('tgP2pSendCodeHint').textContent = '';
    try {
      const res = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/telegram/p2p/send_code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const data = await res.json();
      if (data.status === 'code_sent') {
        $('tgP2pStepPhone').style.display = 'none';
        $('tgP2pStepCode').style.display = 'block';
      } else if (data.status === 'connected') {
        // Already authorized (e.g. a restored session) - no code needed.
        fetchP2pStatus();
      } else {
        $('tgP2pSendCodeHint').textContent = data.error || 'Failed to send code';
      }
    } catch(e){
      $('tgP2pSendCodeHint').textContent = e.message;
    } finally {
      $('tgP2pSendCodeBtn').textContent = 'Send Code';
    }
  });

  $('tgP2pSignInBtn')?.addEventListener('click', async () => {
    const code = $('tgP2pCodeInput').value.trim();
    const password = $('tgP2pPasswordInput').value.trim();
    if (!code) return alert('Enter verification code');
    $('tgP2pSignInBtn').textContent = 'Signing in…';
    $('tgP2pSignInHint').textContent = '';
    try {
      const res = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/telegram/p2p/sign_in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, password }),
      });
      const data = await res.json();
      if (data.status === '2fa_required') {
        $('tgP2pPasswordCard').style.display = 'block';
        $('tgP2pSignInHint').textContent = '2FA password required';
      } else if (data.status === 'connected') {
        fetchP2pStatus();
      } else {
        $('tgP2pSignInHint').textContent = data.error || 'Failed to sign in';
      }
    } catch(e){
      $('tgP2pSignInHint').textContent = e.message;
    } finally {
      $('tgP2pSignInBtn').textContent = 'Confirm & Connect';
    }
  });

  $('tgP2pDisconnectBtn')?.addEventListener('click', async () => {
    if (!confirm('Disconnect real calling?')) return;
    await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/telegram/p2p/disconnect', { method: 'POST' });
    await fetchP2pStatus();
  });

  // -------------------------------------------------------------
  // Keep-alive toggle (test-mode only) - see server.mjs for why this exists.
  // -------------------------------------------------------------
  function setKeepAliveUI(on){
    const btn = $('keepAliveToggle');
    const hint = $('keepAliveHint');
    if (btn) btn.dataset.on = on ? 'true' : 'false';
    if (hint) hint.textContent = on
      ? 'On — pinging every 10 min so Render stays warm'
      : 'Off — Render free tier sleeps after ~15 min idle';
  }
  async function fetchKeepAliveStatus(){
    try {
      const res = await fetch(SOCIAL_CALL_API_BASE + '/api/keepalive/status');
      const data = await res.json();
      setKeepAliveUI(!!data.enabled);
    } catch(e){ console.warn('[KeepAlive] status note:', e.message); }
  }
  $('keepAliveToggle')?.addEventListener('click', async () => {
    const btn = $('keepAliveToggle');
    const next = btn.dataset.on !== 'true';
    btn.disabled = true;
    try {
      const res = await fetch(SOCIAL_CALL_API_BASE + '/api/keepalive/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const data = await res.json();
      setKeepAliveUI(!!data.enabled);
    } catch(e){
      alert('Could not update keep-alive: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  });
  fetchKeepAliveStatus();

  // -------------------------------------------------------------
  // Call Flow: Home -> Choose how to call
  // -------------------------------------------------------------
  $('headerCallBtn')?.addEventListener('click', () => {
    $('callChoiceModal').classList.add('active');
    fetchConnectedStatus();
  });
  $('closeCallChoiceBtn')?.addEventListener('click', () => {
    $('callChoiceModal').classList.remove('active');
  });

  $('chooseAiCallBtn')?.addEventListener('click', () => {
    $('callChoiceModal').classList.remove('active');
    startCall(); // Original Anam AI direct call
  });

  $('chooseWhatsAppCallBtn')?.addEventListener('click', () => {
    $('callChoiceModal').classList.remove('active');
    openContactPicker('whatsapp');
  });

  $('chooseTelegramCallBtn')?.addEventListener('click', () => {
    $('callChoiceModal').classList.remove('active');
    openContactPicker('telegram');
  });

  // Contact Picker
  let allLoadedContacts = [];
  async function openContactPicker(platform) {
    currentSocialPlatform = platform;
    $('contactPickerModal').classList.add('active');
    $('contactPickerTitle').textContent = platform === 'whatsapp' ? 'WhatsApp Contacts' : 'Telegram Contacts';
    $('contactPickerPlatformIcon').innerHTML = platform === 'whatsapp'
      ? '<span style="color:#25D366;"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91C2.13 13.66 2.59 15.36 3.45 16.86L2.05 22L7.3 20.62C8.75 21.41 10.38 21.83 12.04 21.83C17.5 21.83 21.95 17.38 21.95 11.92C21.95 9.27 20.92 6.78 19.05 4.91C17.18 3.03 14.69 2 12.04 2ZM12.05 3.67C14.25 3.67 16.31 4.53 17.87 6.09C19.42 7.65 20.28 9.72 20.28 11.92C20.28 16.46 16.59 20.15 12.04 20.15C10.56 20.15 9.11 19.76 7.85 19.01L7.55 18.83L4.43 19.65L5.26 16.61L5.06 16.29C4.24 14.99 3.8 13.47 3.8 11.91C3.81 7.37 7.5 3.67 12.05 3.67ZM8.79 7.34C8.61 7.34 8.31 7.41 8.06 7.68C7.81 7.95 7.11 8.61 7.11 9.94C7.11 11.27 8.08 12.55 8.22 12.73C8.36 12.92 10.13 15.65 12.84 16.82C13.49 17.1 13.99 17.26 14.38 17.39C15.04 17.6 15.64 17.57 16.11 17.5C16.64 17.42 17.73 16.84 17.96 16.19C18.19 15.54 18.19 14.99 18.12 14.87C18.05 14.75 17.87 14.68 17.6 14.54C17.33 14.4 16 13.75 15.75 13.66C15.5 13.57 15.32 13.52 15.14 13.79C14.96 14.07 14.44 14.68 14.28 14.87C14.13 15.05 13.97 15.07 13.7 14.94C13.43 14.8 12.56 14.52 11.53 13.6C10.73 12.89 10.19 12.01 10.03 11.74C9.87 11.46 10.01 11.31 10.15 11.18C10.27 11.06 10.42 10.86 10.56 10.7C10.7 10.54 10.75 10.42 10.84 10.24C10.93 10.06 10.89 9.9 10.82 9.76C10.75 9.62 10.2 8.27 9.97 7.73C9.75 7.2 9.53 7.28 9.36 7.27C9.21 7.26 9.01 7.26 8.81 7.26L8.79 7.34Z"/></svg></span>'
      : '<span style="color:#2AABEE;"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/></svg></span>';

    $('contactSearchInput').value = '';
    $('callDirectBtn').style.display = 'none';

    const container = $('contactsListContainer');
    container.innerHTML = '<div style="text-align:center; padding:30px; color:var(--dim); font-size:13px;">Loading contacts…</div>';

    const endpoint = platform === 'whatsapp' ? (SOCIAL_CALL_API_BASE + '/api/social-call/whatsapp/contacts') : (SOCIAL_CALL_API_BASE + '/api/social-call/telegram/contacts');
    try {
      const res = await fetch(endpoint);
      const data = await res.json();

      if (!res.ok) {
        container.innerHTML = `<div style="text-align:center; padding:20px; color:#ff6b6b; font-size:13px;">Error: ${data.error || 'Could not load contacts'}</div>`;
        allLoadedContacts = [];
        return;
      }

      allLoadedContacts = data.contacts || [];

      if (!allLoadedContacts.length) {
        container.innerHTML = `
          <div style="text-align:center; padding:30px 16px; color:var(--dim); font-size:13.5px; line-height:1.5;">
            No synced contacts found.<br>Type any phone number or username above to call.
          </div>
        `;
      } else {
        renderContactsList(allLoadedContacts);
      }
    } catch(err) {
      container.innerHTML = `<div style="text-align:center; padding:20px; color:#ff6b6b; font-size:13px;">Error: ${err.message}</div>`;
    }
  }

  function renderContactsList(list){
    const container = $('contactsListContainer');
    if (!list.length) {
      container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--dim); font-size:13px;">No matching contacts</div>';
      return;
    }
    container.innerHTML = list.map(c => {
      const name = c.name || c.first_name || c.phone || c.target || 'Contact';
      const target = c.phone || c.phone_number || c.username || c.id || c.target;
      const initials = name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
      return `
        <div class="contactRow" data-contact-target="${target}" data-contact-name="${name}">
          <div class="contactAvatar">${initials}</div>
          <div class="contactMain">
            <div class="contactName">${name.replace(/</g,'&lt;')}</div>
            <div class="contactSub">${target.replace(/</g,'&lt;')}</div>
          </div>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.contactRow').forEach(el => {
      el.addEventListener('click', () => {
        selectContactForCall({
          name: el.dataset.contactName,
          target: el.dataset.contactTarget,
        });
      });
    });
  }

  $('contactSearchInput')?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    const btn = $('callDirectBtn');
    if (q.length >= 3) {
      btn.style.display = 'inline-block';
      btn.textContent = 'Call ' + (q.length > 12 ? q.slice(0, 10) + '…' : q);
    } else {
      btn.style.display = 'none';
    }

    if (!q) {
      renderContactsList(allLoadedContacts);
    } else {
      const filtered = allLoadedContacts.filter(c => {
        const name = (c.name || c.first_name || '').toLowerCase();
        const target = (c.phone || c.phone_number || c.username || '').toLowerCase();
        return name.includes(q) || target.includes(q);
      });
      renderContactsList(filtered);
    }
  });

  $('callDirectBtn')?.addEventListener('click', async () => {
    const typed = $('contactSearchInput').value.trim();
    if (!typed) return;

    if (currentSocialPlatform === 'telegram') {
      // Never pass a raw phone number/username as target - tgcalls_bridge
      // needs a real numeric Telegram user id (and derives the access_hash
      // from that at call time). Resolve through the authenticated
      // account's own Telegram session first.
      const btn = $('callDirectBtn');
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Looking up…';
      try {
        const res = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/telegram/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: typed }),
        });
        const data = await res.json();
        if (!res.ok || !data.id) {
          alert(data.error || 'Could not find a Telegram user for that number/username');
          return;
        }
        const name = [data.first_name, data.last_name].filter(Boolean).join(' ') || data.username || typed;
        selectContactForCall({ name, target: data.id });
      } catch(e) {
        alert('Lookup failed: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
      return;
    }

    selectContactForCall({ name: typed, target: typed });
  });

  $('closeContactPicker')?.addEventListener('click', () => {
    $('contactPickerModal').classList.remove('active');
  });

  // Call Preparation
  function selectContactForCall(contact){
    selectedSocialContact = contact;
    $('contactPickerModal').classList.remove('active');
    $('callPrepModal').classList.add('active');

    $('prepContactName').textContent = contact.name || contact.target;
    $('prepContactDetails').textContent = `${contact.target} • ${currentSocialPlatform === 'whatsapp' ? 'WhatsApp' : 'Telegram'}`;
    const badge = $('prepPlatformBadge');
    badge.textContent = currentSocialPlatform === 'whatsapp' ? 'WhatsApp' : 'Telegram';
    badge.className = `platformBadge ${currentSocialPlatform}`;

    $('prepPlatformIcon').innerHTML = currentSocialPlatform === 'whatsapp'
      ? '<span style="color:#25D366;"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91C2.13 13.66 2.59 15.36 3.45 16.86L2.05 22L7.3 20.62C8.75 21.41 10.38 21.83 12.04 21.83C17.5 21.83 21.95 17.38 21.95 11.92C21.95 9.27 20.92 6.78 19.05 4.91C17.18 3.03 14.69 2 12.04 2ZM12.05 3.67C14.25 3.67 16.31 4.53 17.87 6.09C19.42 7.65 20.28 9.72 20.28 11.92C20.28 16.46 16.59 20.15 12.04 20.15C10.56 20.15 9.11 19.76 7.85 19.01L7.55 18.83L4.43 19.65L5.26 16.61L5.06 16.29C4.24 14.99 3.8 13.47 3.8 11.91C3.81 7.37 7.5 3.67 12.05 3.67ZM8.79 7.34C8.61 7.34 8.31 7.41 8.06 7.68C7.81 7.95 7.11 8.61 7.11 9.94C7.11 11.27 8.08 12.55 8.22 12.73C8.36 12.92 10.13 15.65 12.84 16.82C13.49 17.1 13.99 17.26 14.38 17.39C15.04 17.6 15.64 17.57 16.11 17.5C16.64 17.42 17.73 16.84 17.96 16.19C18.19 15.54 18.19 14.99 18.12 14.87C18.05 14.75 17.87 14.68 17.6 14.54C17.33 14.4 16 13.75 15.75 13.66C15.5 13.57 15.32 13.52 15.14 13.79C14.96 14.07 14.44 14.68 14.28 14.87C14.13 15.05 13.97 15.07 13.7 14.94C13.43 14.8 12.56 14.52 11.53 13.6C10.73 12.89 10.19 12.01 10.03 11.74C9.87 11.46 10.01 11.31 10.15 11.18C10.27 11.06 10.42 10.86 10.56 10.7C10.7 10.54 10.75 10.42 10.84 10.24C10.93 10.06 10.89 9.9 10.82 9.76C10.75 9.62 10.2 8.27 9.97 7.73C9.75 7.2 9.53 7.28 9.36 7.27C9.21 7.26 9.01 7.26 8.81 7.26L8.79 7.34Z"/></svg></span>'
      : '<span style="color:#2AABEE;"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/></svg></span>';

    // Mic check
    if (socialMicStream) {
      $('prepMicStatus').textContent = 'Microphone: Active';
      $('prepEnableMicBtn').style.display = 'none';
    } else {
      $('prepMicStatus').textContent = 'Microphone: Click to allow';
      $('prepEnableMicBtn').style.display = 'inline-block';
    }

    $('prepLucyStatus').textContent = state.falKeySet ? 'Lucy 2.5: Ready to stream' : 'Lucy 2.5: Ready (using camera)';
  }

  $('prepEnableMicBtn')?.addEventListener('click', async () => {
    try {
      socialMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      $('prepMicStatus').textContent = 'Microphone: Active';
      $('prepEnableMicBtn').style.display = 'none';
    } catch(e) {
      $('prepMicStatus').textContent = 'Microphone access denied';
    }
  });

  $('closeCallPrep')?.addEventListener('click', () => {
    $('callPrepModal').classList.remove('active');
  });

  // Step 4 & 5: Start Lucy 2.5 Live Swap automatically & place call
  $('prepStartCallActionBtn')?.addEventListener('click', placeSocialCall);

  // -------------------------------------------------------------
  // WhatsApp calling via Green API's calls SDK - unlike Telegram, there is
  // no server-side "place a call" REST endpoint for Green API; calling is
  // browser-side WebRTC that connects directly to their infrastructure.
  // Replaces the old Baileys-based waBridge.startCall()/hangup(), which
  // never worked because Baileys itself never successfully paired on this
  // deployment (WhatsApp very likely blocking datacenter IPs from linking
  // a device - see the Green API migration notes).
  // NOTE: confirmed by reading the SDK's own source directly - it is
  // audio-only. No video call support exists in this library at all.
  // -------------------------------------------------------------
  let gaClient = null, gaCalls = null;

  async function startGreenApiCall(target){
    const cfgRes = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/whatsapp/call-config');
    const cfg = await cfgRes.json();
    if (!cfg.apiUrl || !cfg.idInstance || !cfg.apiTokenInstance) {
      throw new Error('Green API not configured on the backend');
    }

    const { GreenApiVoipClient } = await import('https://esm.sh/@green-api/whatsapp-api-calls-client-js@2.0.0');
    gaClient = new GreenApiVoipClient({
      apiUrl: cfg.apiUrl,
      idInstance: cfg.idInstance,
      apiTokenInstance: cfg.apiTokenInstance,
    });
    gaCalls = gaClient.connectCalls();

    const lbl = $('socialCallStatusLabel');
    gaCalls.addEventListener('state', (event) => {
      const kind = event.detail?.kind;
      if (kind === 'out-call') { if (lbl) lbl.textContent = 'Ringing…'; startRingback(); }
      else if (kind === 'on-call') {
        if (lbl) lbl.textContent = 'Connected';
        $('socialCallIdle') && ($('socialCallIdle').style.display = 'none');
        stopRingback();
      }
    });
    gaCalls.addEventListener('end-call', () => { stopRingback(); endSocialCall(); });
    gaCalls.addEventListener('error', (event) => {
      stopRingback();
      $('prepErrorHint') && ($('prepErrorHint').textContent = event.detail?.message || 'WhatsApp call error');
    });
    gaCalls.addEventListener('remote-stream-ready', (event) => {
      // Audio-only per the SDK - attach the remote stream's audio to the
      // big view's video element so it's at least audible during the
      // call (there is no remote video track to show for WhatsApp).
      const remoteVid = $('socialRemoteVideo');
      if (remoteVid && event.detail?.stream) remoteVid.srcObject = event.detail.stream;
    });

    await gaCalls.startAudioBridge();
    await gaClient.dial(target);
  }

  function endGreenApiCall(){
    if (gaClient) { gaClient.hangUp().catch(()=>{}); }
    gaClient = null;
    gaCalls = null;
  }

  async function placeSocialCall(){
    const prepBtn = $('prepStartCallActionBtn');
    prepBtn.disabled = true;
    prepBtn.textContent = 'Starting Lucy 2.5 & Calling…';
    $('prepErrorHint').textContent = '';

    try {
      if (!socialMicStream) {
        try {
          socialMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          $('prepMicStatus').textContent = 'Microphone: Active';
        } catch(e) {
          $('prepErrorHint').textContent = 'Microphone permission required for call';
          prepBtn.disabled = false;
          prepBtn.textContent = 'Place Call';
          return;
        }
      }

      // Activate whichever outgoing source was picked - Lucy 2.5 (live face
      // swap of your own camera) or an Anam AI avatar - as the automatic
      // Step 4 & 5 (NO tab switch needed).
      await activeSocialSource().start({ forSocialCall: true });

      // Place call on backend bridge
      const res = await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: currentSocialPlatform,
          target: selectedSocialContact.target,
          name: selectedSocialContact.name,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to place call');

      if (currentSocialPlatform === 'whatsapp') {
        // Actual ringing happens here, client-side - the backend POST
        // above only recorded call state/history, it never rings anyone
        // for WhatsApp (see server.mjs's call route comments).
        await startGreenApiCall(selectedSocialContact.target);
      }

      // Transition to Active Call UI
      $('callPrepModal').classList.remove('active');
      const callScr = $('socialCallScreen');
      callScr.classList.add('active');

      // Reset layout to defaults for this call: PIP mode, remote as big
      // view, self-view back in its default corner (undoes any drag/swap
      // left over from a previous call).
      callScr.dataset.layout = 'pip';
      const remoteVid = $('socialRemoteVideo'), selfVid = $('socialSelfVideo');
      if (remoteVid && selfVid) {
        remoteVid.className = 'socialPipMain';
        selfVid.className = 'socialPipThumb';
        remoteVid.style.left = ''; remoteVid.style.top = ''; remoteVid.style.right = '';
        selfVid.style.left = ''; selfVid.style.top = ''; selfVid.style.right = '16px';
      }

      // Strip emoji from the displayed name here specifically (contact
      // names often have decorative emoji saved on the phone itself -
      // e.g. a heart - which read oddly stacked right above the
      // "Ringing... · 00:00" status line on this screen).
      const rawName = selectedSocialContact.name || selectedSocialContact.target;
      const cleanName = rawName.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').trim();
      $('socialCallTargetName').textContent = cleanName || rawName;
      $('socialCallPlatformPill').innerHTML = `<span>${currentSocialPlatform === 'whatsapp' ? 'WhatsApp' : 'Telegram'}</span>`;
      $('socialCallPlatformPill').className = `pill ${currentSocialPlatform}`;
      $('socialCallStatusLabel').textContent = 'Ringing…';
      $('socialCallTimer').textContent = '00:00';

      socialCallStartedAt = Date.now();
      clearInterval(socialCallDurationTimer);
      socialCallDurationTimer = setInterval(() => {
        const sec = Math.floor((Date.now() - socialCallStartedAt) / 1000);
        const m = String(Math.floor(sec / 60)).padStart(2, '0');
        const s = String(sec % 60).padStart(2, '0');
        $('socialCallTimer').textContent = `${m}:${s}`;
      }, 1000);

      // Start streaming outgoing video frames & mic audio through adapter
      SocialCallMediaAdapter.startStreaming(activeSocialSource().getStream(), socialMicStream);

    } catch(err) {
      console.error('[placeSocialCall] error:', err);
      $('prepErrorHint').textContent = err.message || 'Error starting call';
    } finally {
      prepBtn.disabled = false;
      prepBtn.textContent = 'Place Call';
    }
  }

  // Active Social Call controls
  $('socialMuteBtn')?.addEventListener('click', () => {
    socialMuted = !socialMuted;
    if (socialMicStream) {
      socialMicStream.getAudioTracks().forEach(t => t.enabled = !socialMuted);
    }
    $('socialMuteBtn').classList.toggle('muted', socialMuted);
    $('socialMuteBtn').innerHTML = socialMuted
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8"><path d="M3 3l18 18"/><path d="M12 1a3 3 0 0 0-3 3v6.5M15 9V4a3 3 0 0 0-3-3"/><path d="M19 10v2a7 7 0 0 1-9.8 6.4M5 10v2a7 7 0 0 0 2 4.9"/><path d="M12 19v4"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4"/></svg>';
  });

  $('socialEndBtn')?.addEventListener('click', endSocialCall);

  // -------------------------------------------------------------
  // Social call layout: PIP (tap the small self-view to swap it with the
  // big view, drag it anywhere) or split-screen (two fixed equal panes).
  // Both replace the idea of a separate "flip" button - self-view and the
  // outgoing view are always visible together, in one arrangement or
  // the other.
  // -------------------------------------------------------------
  (function setupSocialCallLayout(){
    const screen = $('socialCallScreen');
    const videoA = $('socialRemoteVideo'), videoB = $('socialSelfVideo');
    if (!screen || !videoA || !videoB) return;

    $('socialLayoutToggleBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      screen.dataset.layout = screen.dataset.layout === 'split' ? 'pip' : 'split';
      // Clear any inline position from a previous PIP drag - split mode's
      // CSS (top:0/bottom:0/left:0/right:0) is overridden by leftover
      // inline styles otherwise, since inline style always beats a
      // stylesheet rule regardless of selector. This was the split-screen
      // layout bug: switching modes after ever dragging the thumb left it
      // stuck at its dragged position instead of snapping to a full half.
      [videoA, videoB].forEach((el) => {
        el.style.left = ''; el.style.top = ''; el.style.right = '';
      });
    });

    // Tap-to-swap which video is "main" (big) vs "thumb" (small PIP), and
    // drag-to-reposition the thumb - both only meaningful in PIP mode.
    // Handlers are on both elements since either can be the thumb after a
    // swap; each checks its own current role at pointerdown time.
    let dragEl = null, moved = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;

    function onPointerDown(e){
      const el = e.currentTarget;
      if (screen.dataset.layout !== 'pip' || !el.classList.contains('socialPipThumb')) return;
      dragEl = el; moved = false;
      el.classList.add('dragging');
      const rect = el.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startLeft = rect.left; startTop = rect.top;
      el.style.right = 'auto';
      el.setPointerCapture?.(e.pointerId);
    }
    function onPointerMove(e){
      if (!dragEl || dragEl !== e.currentTarget) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      const rect = dragEl.getBoundingClientRect();
      const maxLeft = screen.clientWidth - rect.width;
      const maxTop = screen.clientHeight - rect.height;
      dragEl.style.left = `${Math.min(Math.max(0, startLeft + dx), maxLeft)}px`;
      dragEl.style.top = `${Math.min(Math.max(0, startTop + dy), maxTop)}px`;
    }
    function onPointerUp(e){
      const el = e.currentTarget;
      if (!dragEl || dragEl !== el) return;
      dragEl = null;
      el.classList.remove('dragging');
      if (!moved) {
        // A real tap, not a drag - swap main/thumb roles.
        const main = screen.querySelector('.socialPipMain');
        if (main && main !== el) {
          main.classList.remove('socialPipMain'); main.classList.add('socialPipThumb');
          el.classList.remove('socialPipThumb'); el.classList.add('socialPipMain');
          // Reset the now-thumb element back to its default corner position.
          main.style.left = ''; main.style.top = ''; main.style.right = '16px';
          el.style.left = ''; el.style.top = ''; el.style.right = '';
        }
      }
    }
    [videoA, videoB].forEach((el) => {
      el.addEventListener('pointerdown', onPointerDown);
      el.addEventListener('pointermove', onPointerMove);
      el.addEventListener('pointerup', onPointerUp);
      el.addEventListener('pointercancel', onPointerUp);
    });
  })();

  async function endSocialCall(){
    clearInterval(socialCallDurationTimer);
    stopRingback();
    if (currentSocialPlatform === 'whatsapp') endGreenApiCall();
    $('socialCallScreen').classList.remove('active');

    // Tear down media pipelines
    SocialCallMediaAdapter.stop();
    LiveSwapMediaSource.stop();
    SocialAnamSource.stop();

    if (socialMicStream) {
      socialMicStream.getTracks().forEach(t => t.stop());
      socialMicStream = null;
    }

    try {
      await fetch(SOCIAL_CALL_API_BASE + '/api/social-call/hangup', { method: 'POST' });
    } catch(e){}

    // Update Recent calls list with new record
    renderRecent();
  }

  // Initial fetch of connected account statuses
  fetchConnectedStatus();

  // ---------- auth ----------
  const authScreen = $('authScreen');
  let authMode = 'signin';

  $('authToggleMode')?.addEventListener('click', () => {
    authMode = authMode === 'signin' ? 'signup' : 'signin';
    $('authSubmit').textContent = authMode === 'signin' ? 'Sign in' : 'Sign up';
    $('authToggleMode').innerHTML = authMode === 'signin' ? 'Need an account? <b>Sign up</b>' : 'Have an account? <b>Sign in</b>';
    $('authHint').textContent = '';
  });

  $('authSubmit')?.addEventListener('click', async () => {
    const email = $('authEmail').value.trim();
    const password = $('authPassword').value;
    if (!email || !password) { $('authHint').textContent = 'Enter an email and password.'; return; }
    $('authHint').textContent = 'Working…';
    const { error } = authMode === 'signin'
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password });
    if (error) { $('authHint').textContent = error.message; return; }
    if (authMode === 'signup') { $('authHint').textContent = 'Check your email to confirm, then wait for approval.'; }
  });

  $('googleSignIn')?.addEventListener('click', async () => {
    await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } });
  });

  $('signOutBtn')?.addEventListener('click', async () => {
    await supabase.auth.signOut();
  });
  $('pendingSignOut')?.addEventListener('click', async () => {
    await supabase.auth.signOut();
  });

  async function checkApproval(userId){
    const { data } = await supabase.from('user_approvals').select('approved').eq('user_id', userId).maybeSingle();
    return !!data?.approved;
  }

  async function enterApp(user){
    currentUser = user;
    // Google accounts have no password to change — only show this for email/password sign-ups.
    const provider = user.app_metadata?.provider || user.identities?.[0]?.provider || 'email';
    $('openChangePassword').style.display = provider === 'email' ? 'flex' : 'none';
    const approved = await checkApproval(user.id);
    if (!approved) {
      authScreen.classList.remove('hidden');
      $('authBoot').style.display = 'none';
      $('authBox').style.display = 'none';
      $('pendingBox').style.display = 'block';
      splashAuthDone = true; maybeHideSplash();
      return;
    }
    $('authBoot').style.display = 'none';
    $('authBox').style.display = '';
    $('pendingBox').style.display = 'none';
    authScreen.classList.add('hidden');
    await loadSettings();
    loadAnamAvatars();
    loadAnamVoices();
    splashAuthDone = true; maybeHideSplash();
  }

  supabase.auth.onAuthStateChange((_event, session) => {
    if (session?.user) {
      enterApp(session.user);
    } else {
      currentUser = null;
      $('authBoot').style.display = 'none';
      $('authBox').style.display = '';
      $('pendingBox').style.display = 'none';
      authScreen.classList.remove('hidden');
      splashAuthDone = true; maybeHideSplash();
    }
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
