// Fix for iOS WKWebView/standalone-install PWAs where 100dvh and even
  // -webkit-fill-available (both used on body in styles.css) under-report the
  // true visible height on the very first layout pass after a cold launch,
  // only self-correcting a moment later once WebKit settles - visible as a
  // coffee-brown gap under the splash that "grows into place" a beat after
  // launch. This used to live in app.js, but app.js is now a separate module
  // file that needs its own network fetch before it can even start running -
  // on a slow connection that's exactly the gap-then-correct delay this was
  // supposed to prevent. Running it here instead, in a plain blocking script
  // tag with no fetch of its own, means it's already done before #liveSplash
  // is even parsed.
  function setAppHeight(){
    const h = Math.max(window.innerHeight, window.screen.height || 0);
    const px = h + 'px';
    // Guard against a feedback loop: setting body.style.height can itself trigger
    // another 'resize' in some WKWebView builds, which would re-run this and set the
    // same value again forever - this is what caused the "Maximum call stack size
    // exceeded" crash. Skip the write entirely when nothing actually changed.
    if (document.body.style.height === px) return;
    document.documentElement.style.setProperty('--app-height', px);
    document.body.style.height = px;
  }
  setAppHeight();
  // Deliberately NOT listening on 'resize' - on mobile that also fires every time the
  // keyboard opens/closes while typing, which would reflow body's explicit height and
  // visibly shift the whole page around. orientationchange (portrait/landscape) is the
  // only real case this needs to react to; screen.height never changes for the keyboard.
  window.addEventListener('orientationchange', setAppHeight);

  // Hard gate: the app must never render inside a plain browser tab, only when
  // installed to the Home Screen and launched standalone. Runs first, before
  // anything else, and just stops here if it fails the check.
  (function enforceStandalone(){
    const isStandalone = window.navigator.standalone === true
      || window.matchMedia('(display-mode: standalone)').matches;
    if (isStandalone) return;
    const gate = document.getElementById('installGate');
    gate.style.display = 'flex';
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    document.getElementById(isIOS ? 'installGateStepsIOS' : 'installGateStepsGeneric').style.display = 'block';
    document.documentElement.style.overflow = 'hidden';
  })();

  // Something went wrong, shown as a small dismissible card instead of a raw red
  // debug-console bar across the status bar - still surfaces the real error (needed
  // for debugging) but doesn't look like a leftover dev tool in a shipped app.
  function showErrorToast(text){
    const bar = document.getElementById('debugBar');
    bar.style.display = 'block';
    bar.innerHTML = '<div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">'
      + '<div style="opacity:0.85; white-space:pre-wrap;">Something went wrong. ' + text.replace(/</g,'&lt;') + '</div>'
      + '<button onclick="this.closest(\'#debugBar\').style.display=\'none\'" style="flex:none; color:#fff; opacity:0.6; font-size:16px; line-height:1; background:none; border:0;">✕</button>'
      + '</div>';
  }
  window.onerror = function(msg, src, line, col, err){
    showErrorToast(msg + ' (line ' + line + ')' + (err && err.stack ? '\n' + err.stack.slice(0, 400) : ''));
  };
  window.addEventListener('unhandledrejection', function(e){
    const reason = e.reason;
    const detail = reason && reason.stack ? reason.stack.slice(0, 400) : (reason?.message || reason);
    showErrorToast(detail);
  });
  // Poll instead of a single check: a slow network (auth + approval + settings + avatar
  // list, all sequential) can easily blow past a one-shot timer even when the app is
  // about to render fine, and a one-shot check that fires early also never gets undone
  // once things do resolve - leaving a stale "didn't render" banner over a working app.
  // This checks repeatedly, clears itself the moment home actually renders, and only
  // keeps the message up if it's still broken after a longer grace period.
  var renderCheckCount = 0;
  var renderCheckInterval = setInterval(function(){
    renderCheckCount++;
    var auth = document.getElementById('authScreen');
    var home = document.getElementById('screenHome');
    var bar = document.getElementById('debugBar');
    var rendered = home && home.offsetHeight > 0;
    var signedIn = auth && auth.classList.contains('hidden');
    if (rendered) {
      if (bar.textContent.indexOf('did not render') !== -1) { bar.style.display = 'none'; bar.textContent = ''; }
      clearInterval(renderCheckInterval);
      return;
    }
    if (signedIn && renderCheckCount >= 8) { // ~8s of being signed-in with nothing rendered
      bar.style.display = 'block';
      bar.innerHTML = 'App did not render after sign-in. <button onclick="location.reload()" style="text-decoration:underline; background:none; border:0; color:#fff; font-weight:700;">Tap to retry</button>';
      clearInterval(renderCheckInterval);
    }
  }, 1000);
