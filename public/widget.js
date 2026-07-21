/*!
 * Yomeet website chat widget loader.
 * Embed:  <script src="https://.../widget.js" data-handle="YOUR_HANDLE" async></script>
 *
 * Renders a floating bubble + chat panel in a Shadow DOM (so the host page's
 * CSS can't leak in). Talks only to /api/widget/public/* on the origin this
 * script is served from. No external dependencies.
 */
(function () {
  'use strict';

  // Find our own <script> tag. document.currentScript works for a normal
  // static embed, but is null when the script is injected dynamically (e.g. by
  // Google Tag Manager) — so fall back to matching by src + data-handle rather
  // than blindly grabbing the last script on the page.
  var script = document.currentScript;
  if (!script || !script.getAttribute('data-handle')) {
    var cand = document.querySelectorAll('script[data-handle]');
    for (var i = 0; i < cand.length; i++) {
      if (/\/widget\.js(\?|$)/.test(cand[i].src || '')) {
        script = cand[i];
        break;
      }
    }
  }
  if (!script) return;

  var handle = script.getAttribute('data-handle');
  if (!handle) {
    console.warn('[Yomeet widget] missing data-handle attribute');
    return;
  }
  var API;
  try {
    API = new URL(script.src).origin;
  } catch (e) {
    console.warn('[Yomeet widget] could not resolve API origin');
    return;
  }

  var TOKEN_KEY = 'yomeet_widget_token_' + handle;
  var NAME_KEY = 'yomeet_widget_name_' + handle;
  var EMAIL_KEY = 'yomeet_widget_email_' + handle;
  // Adaptive polling: snappy while the chat is open, gentle in the background
  // (so an owner's reply still surfaces as an unread badge + chime when closed).
  var POLL_OPEN = 1200;
  var POLL_CLOSED = 6000;

  var state = {
    token: null,
    name: null,    // visitor's typed name → shown in the owner's inbox
    email: null,   // optional; captured as a lead
    conversationId: null,
    lastId: null,
    open: false,
    started: false,
    config: null,
    pollTimer: null,
    unread: 0,
    es: null,      // EventSource (instant push); poll is the fallback
    sseUp: false,
    lastTyping: 0, // throttle for outbound typing pings
    // Message ids already rendered, so the poller can't re-add a message the
    // optimistic echo (or a previous poll) already showed.
    seen: {},
  };
  try {
    state.token = localStorage.getItem(TOKEN_KEY);
    state.name = localStorage.getItem(NAME_KEY);
    state.email = localStorage.getItem(EMAIL_KEY);
  } catch (e) {
    /* private mode — fall back to in-memory values */
  }
  function saveName(n) {
    state.name = n;
    try { localStorage.setItem(NAME_KEY, n); } catch (e) { /* ignore */ }
  }
  function saveEmail(em) {
    state.email = em;
    try { localStorage.setItem(EMAIL_KEY, em); } catch (e) { /* ignore */ }
  }

  // ── API helper ─────────────────────────────────────────────────────
  function api(method, path, body) {
    var headers = {};
    if (state.token) headers['x-widget-token'] = state.token;
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(API + '/api/widget' + path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (!r.ok) {
            var msg = (data && data.error && data.error.message) || 'Request failed';
            throw new Error(msg);
          }
          return data;
        });
    });
  }

  function saveToken(t) {
    state.token = t;
    try {
      localStorage.setItem(TOKEN_KEY, t);
    } catch (e) {
      /* ignore */
    }
  }

  // Multipart image upload — separate from api() because it must NOT set a JSON
  // Content-Type (the browser sets the multipart boundary itself).
  function uploadImage(file) {
    var fd = new FormData();
    fd.append('image', file);
    var headers = {};
    if (state.token) headers['x-widget-token'] = state.token;
    return fetch(API + '/api/widget/public/messages/image', {
      method: 'POST',
      headers: headers,
      body: fd,
    }).then(function (r) {
      return r
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (!r.ok) {
            throw new Error((data && data.error && data.error.message) || 'Upload failed');
          }
          return data;
        });
    });
  }

  // ── UI (Shadow DOM) ────────────────────────────────────────────────
  var host = document.createElement('div');
  host.setAttribute('data-yomeet-widget', handle);
  // Attach to <html>, not <body>. Frameworks that render into <body> (e.g.
  // Next.js app router) reconcile its children on every re-render and would
  // delete a node injected into <body>. <html> is never React-managed, so the
  // widget survives. Fixed positioning renders identically either way.
  document.documentElement.appendChild(host);
  var root = host.attachShadow({ mode: 'open' });

  var side = 'right';
  var accent = '#25D366';

  function css() {
    return (
      '' +
      ':host{all:initial}' +
      '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}' +
      '.wrap{position:fixed;bottom:20px;' + side + ':20px;z-index:2147483000}' +
      '.bubble{position:relative;width:60px;height:60px;border-radius:50%;background:' + accent + ';cursor:pointer;' +
      'display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(0,0,0,.25);' +
      'border:none;transition:transform .15s ease}' +
      '.bubble:hover{transform:scale(1.06)}' +
      '.bubble svg{width:28px;height:28px;fill:#fff}' +
      '.badge{position:absolute;top:-3px;right:-3px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;' +
      'background:#ff3b30;color:#fff;font-size:12px;font-weight:700;line-height:20px;text-align:center;' +
      'box-shadow:0 0 0 2px #fff;display:none}' +
      '.badge.show{display:block}' +
      '.panel{position:absolute;bottom:74px;' + side + ':0;width:344px;max-width:calc(100vw - 40px);' +
      'height:470px;max-height:calc(100vh - 120px);background:#fff;border-radius:18px;overflow:hidden;' +
      'box-shadow:0 12px 40px rgba(0,0,0,.28);display:none;flex-direction:column}' +
      '.panel.open{display:flex}' +
      // Header — avatar, name + online dot, and round translucent action buttons.
      '.head{background:' + accent + ';color:#fff;padding:12px 14px;display:flex;align-items:center;gap:10px}' +
      '.head img{width:38px;height:38px;border-radius:50%;object-fit:cover;background:rgba(255,255,255,.25);flex:none}' +
      '.head .meta{min-width:0;flex:1}' +
      '.head .nm{font-weight:600;font-size:15px;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.head .st{font-size:12px;opacity:.92;display:flex;align-items:center;gap:5px;margin-top:1px}' +
      '.head .dot{width:7px;height:7px;border-radius:50%;background:#7be07b;box-shadow:0 0 0 2px rgba(255,255,255,.25);flex:none}' +
      '.head .st.away .dot{background:#dfe2e6}' +
      '.head .btns{display:flex;gap:8px;flex:none}' +
      '.head .hbtn{width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.2);border:none;color:#fff;' +
      'cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;transition:background .15s}' +
      '.head .hbtn:hover{background:rgba(255,255,255,.35)}' +
      '.head .hbtn svg{width:16px;height:16px;fill:#fff}' +
      '.body{flex:1;overflow-y:auto;padding:14px;background:#eceff3;display:flex;flex-direction:column;gap:9px}' +
      // Bubbles with a pointed tail ("horn") on the bottom outer corner, mirroring
      // the app chat: brand-accent outgoing (right), white incoming (left).
      '.msg{position:relative;max-width:80%;padding:9px 13px;font-size:14px;line-height:1.4;word-wrap:break-word;box-shadow:0 1px 1px rgba(0,0,0,.08)}' +
      '.msg.them{align-self:flex-start;background:#fff;color:#1a1a1a;border-radius:16px 16px 16px 4px}' +
      '.msg.me{align-self:flex-end;background:' + accent + ';color:#fff;border-radius:16px 16px 4px 16px}' +
      '.msg.them::after{content:"";position:absolute;left:-6px;bottom:1px;width:0;height:0;' +
      'border-top:6px solid transparent;border-bottom:6px solid transparent;border-right:8px solid #fff}' +
      '.msg.me::after{content:"";position:absolute;right:-6px;bottom:1px;width:0;height:0;' +
      'border-top:6px solid transparent;border-bottom:6px solid transparent;border-left:8px solid ' + accent + '}' +
      // Image messages.
      '.msg.img{padding:4px;max-width:72%}' +
      '.msg.img img{display:block;width:100%;max-width:220px;max-height:260px;object-fit:cover;border-radius:13px;cursor:pointer}' +
      '.msg .cap{padding:5px 7px 2px;font-size:13px}' +
      '.typing{position:relative;align-self:flex-start;background:#fff;border-radius:16px 16px 16px 4px;box-shadow:0 1px 1px rgba(0,0,0,.08);padding:12px 14px;display:flex;gap:4px}' +
      '.typing::after{content:"";position:absolute;left:-6px;bottom:1px;width:0;height:0;' +
      'border-top:6px solid transparent;border-bottom:6px solid transparent;border-right:8px solid #fff}' +
      '.typing span{width:7px;height:7px;border-radius:50%;background:#bbb;display:inline-block;animation:ymtype 1.2s infinite}' +
      '.typing span:nth-child(2){animation-delay:.2s}.typing span:nth-child(3){animation-delay:.4s}' +
      '@keyframes ymtype{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}' +
      // Footer — image attach button, input, and the app\'s Telegram send button.
      '.foot{border-top:1px solid #ececec;padding:8px 10px;display:flex;gap:6px;background:#fff;align-items:center}' +
      '.foot input.in{flex:1;min-width:0;border:1px solid #dcdcdc;border-radius:22px;padding:10px 15px;font-size:14px;outline:none}' +
      '.foot input.in:focus{border-color:' + accent + '}' +
      '.foot .attach{background:none;border:none;width:38px;height:38px;min-width:38px;padding:0;cursor:pointer;display:flex;align-items:center;justify-content:center}' +
      '.foot .attach svg{width:23px;height:23px;fill:#8a8f98;transition:fill .15s}' +
      '.foot .attach:hover svg{fill:' + accent + '}' +
      '.foot .send{border:none;background:' + accent + ';color:#fff;border-radius:50%;width:40px;height:40px;min-width:40px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}' +
      '.foot .send svg{width:20px;height:20px;fill:#fff;margin:1px 0 0 1px}' +
      '.foot .send:disabled{opacity:.5;cursor:default}' +
      '.greet{align-self:flex-start;color:#666;font-size:13px;padding:4px 2px}' +
      // Pre-chat name step.
      '.namebar{border-top:1px solid #ececec;padding:12px;background:#fff;display:none;flex-direction:column;gap:8px}' +
      '.namebar.show{display:flex}' +
      '.namebar label{font-size:13px;color:#333;font-weight:600}' +
      '.namebar .row{display:flex;gap:8px}' +
      '.namebar input{flex:1;border:1px solid #dcdcdc;border-radius:22px;padding:10px 15px;font-size:14px;outline:none}' +
      '.namebar button{border:none;background:' + accent + ';color:#fff;border-radius:22px;padding:10px 18px;font-weight:600;cursor:pointer;white-space:nowrap}' +
      '.lead{padding:14px;display:none;flex-direction:column;gap:8px}' +
      '.lead.show{display:flex}' +
      '.lead p{margin:0;font-size:13px;color:#444}' +
      '.lead input,.lead textarea{border:1px solid #dcdcdc;border-radius:10px;padding:9px 12px;font-size:14px;font-family:inherit;outline:none}' +
      '.lead button{border:none;background:' + accent + ';color:#fff;border-radius:10px;padding:10px;font-weight:600;cursor:pointer}' +
      '.powered{text-align:center;font-size:11px;color:#9aa0a6;padding:6px;background:#fff;border-top:1px solid #f2f2f2}' +
      '.powered a{color:' + accent + ';text-decoration:none;font-weight:600}'
    );
  }

  var CHAT_ICON =
    '<svg viewBox="0 0 24 24"><path d="M12 3C6.5 3 2 6.9 2 11.7c0 2.2.98 4.2 2.6 5.7L4 21l4.2-1.4c1.2.4 2.5.6 3.8.6 5.5 0 10-3.9 10-8.5S17.5 3 12 3z"/></svg>';
  // The app's Telegram-plane send icon (assets/icons/telegram-send.svg) so the
  // widget's send button matches the in-app composer.
  var SEND_ICON =
    '<svg viewBox="0 0 496 512"><path d="M446.7 98.6l-67.6 318.8c-5.1 22.5-18.4 28.1-37.3 17.5l-103-75.9-49.7 47.8c-5.5 5.5-10.1 10.1-20.7 10.1l7.4-104.9 190.9-172.5c8.3-7.4-1.8-11.5-12.9-4.1L117.8 284 16.2 252.2c-22.1-6.9-22.5-22.1 4.6-32.7L418.2 66.4c18.4-6.8 34.5 4.4 28.5 32.2z"/></svg>';
  // Photo/gallery icon for the image attach button.
  var IMG_ICON =
    '<svg viewBox="0 0 24 24"><path d="M21 3H3a1 1 0 00-1 1v16a1 1 0 001 1h18a1 1 0 001-1V4a1 1 0 00-1-1zM8.5 8a1.75 1.75 0 110 3.5 1.75 1.75 0 010-3.5zM5 19l4.2-5.2 2.3 2.8L14.8 12 19 19H5z"/></svg>';
  var MIN_ICON = '<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>';
  var X_ICON =
    '<svg viewBox="0 0 24 24"><path d="M18.3 5.7a1 1 0 00-1.42 0L12 10.59 7.11 5.7A1 1 0 105.7 7.11L10.59 12 5.7 16.89a1 1 0 101.41 1.41L12 13.41l4.89 4.89a1 1 0 001.41-1.41L13.41 12l4.89-4.89a1 1 0 000-1.41z"/></svg>';

  root.innerHTML =
    '<style>' + css() + '</style>' +
    '<div class="wrap">' +
    '  <div class="panel" part="panel">' +
    '    <div class="head">' +
    '      <img class="av" alt=""/>' +
    '      <div class="meta"><div class="nm"></div><div class="st"><span class="dot"></span><span class="st-txt"></span></div></div>' +
    '      <div class="btns">' +
    '        <button class="hbtn min" aria-label="Minimize">' + MIN_ICON + '</button>' +
    '        <button class="hbtn x" aria-label="Close">' + X_ICON + '</button>' +
    '      </div>' +
    '    </div>' +
    '    <div class="body"></div>' +
    '    <form class="lead">' +
    '      <p>We\'re away right now — leave your email and message and we\'ll get back to you.</p>' +
    '      <input class="lead-email" type="email" placeholder="Your email" required />' +
    '      <textarea class="lead-msg" rows="3" placeholder="Your message" required></textarea>' +
    '      <button type="submit">Send</button>' +
    '    </form>' +
    '    <form class="namebar">' +
    '      <label>Hi 👋 Let\'s get started</label>' +
    '      <input class="name-in" placeholder="Your name" autocomplete="name" maxlength="60"/>' +
    '      <input class="email-in" type="email" placeholder="Email (optional)" autocomplete="email" maxlength="160"/>' +
    '      <button type="submit">Start chat</button>' +
    '    </form>' +
    '    <form class="foot">' +
    '      <button type="button" class="attach" aria-label="Send image">' + IMG_ICON + '</button>' +
    '      <input class="in" placeholder="Type a message…" autocomplete="off"/>' +
    '      <button type="submit" class="send" aria-label="Send">' + SEND_ICON + '</button>' +
    '      <input type="file" class="file" accept="image/*" hidden/>' +
    '    </form>' +
    '    <div class="powered">Powered by <a class="pw-link" target="_blank" rel="noopener noreferrer">Yomeet</a></div>' +
    '  </div>' +
    '  <button class="bubble" aria-label="Chat">' + CHAT_ICON + '<span class="badge"></span></button>' +
    '</div>';

  var el = {
    bubble: root.querySelector('.bubble'),
    badge: root.querySelector('.badge'),
    panel: root.querySelector('.panel'),
    close: root.querySelector('.x'),
    min: root.querySelector('.min'),
    av: root.querySelector('.av'),
    nm: root.querySelector('.nm'),
    st: root.querySelector('.st'),
    stTxt: root.querySelector('.st-txt'),
    body: root.querySelector('.body'),
    foot: root.querySelector('.foot'),
    namebar: root.querySelector('.namebar'),
    nameIn: root.querySelector('.name-in'),
    emailIn: root.querySelector('.email-in'),
    pwLink: root.querySelector('.pw-link'),
    input: root.querySelector('.in'),
    send: root.querySelector('.foot .send'),
    attach: root.querySelector('.attach'),
    file: root.querySelector('.file'),
    lead: root.querySelector('.lead'),
    leadEmail: root.querySelector('.lead-email'),
    leadMsg: root.querySelector('.lead-msg'),
  };

  // ── rendering ──────────────────────────────────────────────────────
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function addMessage(m) {
    if (m.id) {
      if (state.seen[m.id]) return; // already rendered — skip the duplicate
      state.seen[m.id] = 1;
      state.lastId = m.id;
    }
    var typing = el.body.querySelector('.typing');
    if (typing) typing.remove(); // a real message means typing is over
    var div = document.createElement('div');
    div.className = 'msg ' + (m.fromVisitor ? 'me' : 'them');
    if (m.imageUrl) {
      div.className += ' img';
      var im = document.createElement('img');
      im.src = m.imageUrl;
      im.alt = 'image';
      im.addEventListener('click', function () {
        window.open(m.imageUrl, '_blank', 'noopener');
      });
      div.appendChild(im);
      if (m.content) {
        var cap = document.createElement('div');
        cap.className = 'cap';
        cap.textContent = m.content;
        div.appendChild(cap);
      }
    } else {
      div.innerHTML = esc(m.content);
    }
    el.body.appendChild(div);
    el.body.scrollTop = el.body.scrollHeight;
  }

  function applyConfig(cfg) {
    state.config = cfg;
    var t = cfg.theme || {};
    var name = (cfg.owner && cfg.owner.displayName) || 'Chat';
    el.nm.textContent = name;
    var online = !!(cfg.owner && cfg.owner.online);
    el.stTxt.textContent = online ? 'Online' : 'Away';
    el.st.classList.toggle('away', !online);
    if (cfg.owner && cfg.owner.avatarUrl) el.av.src = cfg.owner.avatarUrl;
    // "Powered by Yomeet" → the right store for the visitor's device.
    var s = cfg.stores || {};
    var ua = navigator.userAgent || '';
    el.pwLink.href = /iPhone|iPad|iPod/i.test(ua) ? (s.ios || 'https://yomeet.app')
      : /Android/i.test(ua) ? (s.android || 'https://yomeet.app')
      : (s.web || 'https://yomeet.app');
    if (t.greeting) {
      var g = document.createElement('div');
      g.className = 'greet';
      g.textContent = t.greeting;
      el.body.appendChild(g);
    }
    // Offline + capture enabled + no history yet → show the lead form instead.
    if (cfg.owner && !cfg.owner.online && cfg.offlineCapture) {
      el.lead.classList.add('show');
      el.foot.style.display = 'none';
    }
  }

  // ── session + messaging ────────────────────────────────────────────
  function ensureSession() {
    if (state.started) return Promise.resolve();
    return api('POST', '/public/' + encodeURIComponent(handle) + '/session', {
      visitorToken: state.token || undefined,
      name: state.name || undefined,
      email: state.email || undefined,
      // Live-chat context the backend can't see (country/device come from
      // request headers server-side).
      pageUrl: location.href,
      referrer: document.referrer || undefined,
    }).then(function (res) {
      state.started = true;
      state.conversationId = res.conversationId || null;
      if (res.visitorToken) saveToken(res.visitorToken);
      if (state.conversationId) openStream(); // returning visitor with a thread
      return loadMessages();
    });
  }

  function loadMessages() {
    if (!state.token) return Promise.resolve();
    var q = state.lastId ? '?since=' + encodeURIComponent(state.lastId) : '';
    return api('GET', '/public/messages' + q).then(function (res) {
      var ownerNew = 0;
      (res.messages || []).forEach(function (m) {
        var isNew = !(m.id && state.seen[m.id]);
        addMessage(m); // dedupes via state.seen
        if (isNew && !m.fromVisitor) ownerNew++; // a fresh reply from the owner
      });
      // Reply arrived while the panel is closed → badge + chime.
      if (ownerNew > 0 && !state.open) {
        state.unread += ownerNew;
        updateBadge();
        playChime();
      }
    });
  }

  function updateBadge() {
    if (state.unread > 0) {
      el.badge.textContent = state.unread > 9 ? '9+' : String(state.unread);
      el.badge.classList.add('show');
    } else {
      el.badge.classList.remove('show');
    }
  }

  // Short, soft notification chime via Web Audio — no asset, CSP-safe. Audio is
  // unlocked once the visitor has interacted (they clicked the bubble to chat).
  var audioCtx = null;
  function playChime() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = audioCtx || new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var t = audioCtx.currentTime;
      [660, 880].forEach(function (freq, i) {
        var o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.connect(g); g.connect(audioCtx.destination);
        o.type = 'sine'; o.frequency.value = freq;
        var start = t + i * 0.12;
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(0.12, start + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
        o.start(start); o.stop(start + 0.2);
      });
    } catch (e) { /* ignore */ }
  }

  // Poll cadence: SSE handles live delivery when up, so the poll drops to a
  // slow safety net; otherwise it's snappy when open, gentle when closed.
  function pollInterval() {
    if (state.sseUp) return 20000;
    return state.open ? POLL_OPEN : POLL_CLOSED;
  }
  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(function () {
      loadMessages().catch(function () {});
    }, pollInterval());
  }
  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  // Instant push via SSE. The server resolves the conversation from the token;
  // events are just nudges → we refresh (message) or show typing. EventSource
  // auto-reconnects, so onerror only flips us back to faster polling.
  function openStream() {
    if (state.es || !state.token) return;
    try {
      var es = new EventSource(API + '/api/widget/public/events?t=' + encodeURIComponent(state.token));
      state.es = es;
      es.onopen = function () { state.sseUp = true; startPolling(); };
      es.onmessage = function (ev) {
        var d = {};
        try { d = JSON.parse(ev.data); } catch (e) { /* ignore */ }
        if (d.type === 'typing') showOwnerTyping();
        else loadMessages().catch(function () {});
      };
      es.onerror = function () {
        if (state.sseUp) { state.sseUp = false; startPolling(); }
      };
    } catch (e) { /* SSE unsupported → polling covers it */ }
  }

  var typingHideTimer = null;
  function showOwnerTyping() {
    if (!state.open) return; // no point animating a hidden panel
    var t = el.body.querySelector('.typing');
    if (!t) {
      t = document.createElement('div');
      t.className = 'typing';
      t.innerHTML = '<span></span><span></span><span></span>';
      el.body.appendChild(t);
      el.body.scrollTop = el.body.scrollHeight;
    }
    clearTimeout(typingHideTimer);
    typingHideTimer = setTimeout(function () {
      var x = el.body.querySelector('.typing');
      if (x) x.remove();
    }, 4000);
  }

  // Begin (or resume) the chat: start the session, poll loop, and stream.
  function startChat() {
    ensureSession().then(startPolling).catch(function (e) {
      console.warn('[Yomeet widget]', e.message);
    });
    el.input.focus();
  }

  function togglePanel(open) {
    state.open = open;
    el.panel.classList.toggle('open', open);
    if (open) {
      state.unread = 0;
      updateBadge();
      if (el.lead.classList.contains('show')) {
        // Owner offline → the lead (email) form handles it; nothing to do.
      } else if (!state.name) {
        // Ask the visitor's name first (once), then reveal the message input.
        el.namebar.classList.add('show');
        el.foot.style.display = 'none';
        el.nameIn.focus();
      } else {
        el.foot.style.display = 'flex';
        startChat();
      }
    } else {
      // Keep polling in the background (slower) so replies still chime + badge.
      startPolling();
    }
  }

  // ── events ─────────────────────────────────────────────────────────
  el.bubble.addEventListener('click', function () {
    togglePanel(!state.open);
  });
  el.close.addEventListener('click', function () {
    togglePanel(false);
  });
  el.min.addEventListener('click', function () {
    togglePanel(false);
  });

  // Image attach → open the native file picker; upload on selection.
  el.attach.addEventListener('click', function () {
    el.file.click();
  });
  el.file.addEventListener('change', function () {
    var f = el.file.files && el.file.files[0];
    el.file.value = ''; // allow re-picking the same file later
    if (!f || !/^image\//.test(f.type)) return;
    var localUrl = URL.createObjectURL(f);
    ensureSession()
      .then(function () {
        addMessage({ imageUrl: localUrl, fromVisitor: true }); // optimistic preview
        return uploadImage(f);
      })
      .then(function (msg) {
        // Advance the cursor so the poll/SSE refresh doesn't re-add the server
        // copy as a duplicate of the optimistic bubble (same as text sends).
        if (msg && msg.id) {
          state.seen[msg.id] = 1;
          state.lastId = msg.id;
        }
        openStream();
      })
      .catch(function (err) {
        console.warn('[Yomeet widget]', err.message);
      });
  });

  // Pre-chat name → remembered, then reveal the message input and start.
  el.namebar.addEventListener('submit', function (e) {
    e.preventDefault();
    var n = el.nameIn.value.trim();
    if (!n) return;
    saveName(n);
    var em = el.emailIn.value.trim();
    if (em) saveEmail(em); // optional — remembered so returning visitors re-attach
    el.namebar.classList.remove('show');
    el.foot.style.display = 'flex';
    startChat();
  });

  // Outbound typing → the owner's app shows "…is typing". Throttled to 1 ping /
  // 2s (the server auto-clears after 5s), and only once a session exists.
  el.input.addEventListener('input', function () {
    var now = Date.now();
    if (state.token && now - state.lastTyping > 2000) {
      state.lastTyping = now;
      api('POST', '/public/typing').catch(function () {});
    }
  });

  el.foot.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = el.input.value.trim();
    if (!text) return;
    el.input.value = '';
    el.send.disabled = true;
    ensureSession()
      .then(function () {
        // optimistic echo
        addMessage({ content: text, fromVisitor: true });
        return api('POST', '/public/messages', { content: text });
      })
      .then(function (msg) {
        // Record the server id + advance the cursor so the poller never
        // re-adds this just-sent message as a duplicate of the optimistic echo.
        if (msg && msg.id) {
          state.seen[msg.id] = 1;
          state.lastId = msg.id;
        }
        openStream(); // the conversation now exists → start instant push
        el.send.disabled = false;
      })
      .catch(function (err) {
        el.send.disabled = false;
        console.warn('[Yomeet widget]', err.message);
      });
  });

  el.lead.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = el.leadEmail.value.trim();
    var msg = el.leadMsg.value.trim();
    if (!email || !msg) return;
    ensureSession()
      .then(function () {
        return api('POST', '/public/lead', { email: email, message: msg });
      })
      .then(function () {
        el.lead.innerHTML = '<p>Thanks! We\'ll be in touch soon.</p>';
      })
      .catch(function (err) {
        console.warn('[Yomeet widget]', err.message);
      });
  });

  // ── boot: load public config, then reveal the bubble ───────────────
  api('GET', '/public/' + encodeURIComponent(handle) + '/config')
    .then(function (cfg) {
      var t = cfg.theme || {};
      if (t.position === 'left') side = 'left';
      if (typeof t.bubbleColor === 'string' && /^#([0-9a-f]{3}){1,2}$/i.test(t.bubbleColor)) {
        accent = t.bubbleColor;
      }
      // Re-render styles now that theme is known.
      root.querySelector('style').textContent = css();
      applyConfig(cfg);
    })
    .catch(function (e) {
      // Not enabled for this site / not found → remove the widget silently.
      host.remove();
    });
})();
