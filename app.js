import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

  const SUPABASE_URL = 'https://ewgtpxomgkpbmfyddypw.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_NkeueZ7vabkD9nUIPDaGwQ_GCd5Ci40';
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  // Note: this is Supabase's publishable/anon key, which is designed to be safely embedded in
  // client-side code — access is controlled by the Row Level Security policies on each table
  // (see supabase_schema.sql), not by hiding this key. The session token itself is the only
  // thing Supabase's own SDK keeps in localStorage — everything else below reads/writes Supabase.

  const $ = (id) => document.getElementById(id);

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
    if (name === 'profile') renderProfile();
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
    } catch (e) { /* leave as false - UI just shows "paste your key" */ }
    $('anamApiKey').placeholder = state.anamKeySet ? 'Key saved — enter a new one to replace' : 'Paste your Anam API key';
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
    const { data, error } = await supabase
      .from('video_call_chats')
      .select('*')
      .eq('user_id', currentUser.id)
      .order('updated_at', { ascending: false })
      .limit(50);
    if (error || !data || !data.length) { list.innerHTML = '<div class="emptyState">No chats yet. Brief the AI on Home to start one.</div>'; return; }
    list.innerHTML = data.map(c => {
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
          lfRemoteVideo.srcObject = e.streams[0];
          if (lfRemoteVideo.style.display !== 'block') {
            lfRemoteVideo.style.display = 'block';
            lfIdle.style.display = 'none';
            lfLiveDot.classList.add('live');
            lfBottom.classList.remove('hidden');
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

  async function startLiveFilter(retryCount){
    retryCount = retryCount || 0;
    if (!state.falKeySet) { updateLfKeyHint(); return; }
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
    lfCallScreen.classList.add('active');
    lfIdle.style.display = 'flex';
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

  $('headerCallBtn')?.addEventListener('click', startCall);
  $('endBtn')?.addEventListener('click', endCall);

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
