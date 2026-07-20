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
  // Adaptive polling: snappy while the chat is open, gentle in the background
  // (so an owner's reply still surfaces as an unread badge + chime when closed).
  var POLL_OPEN = 1200;
  var POLL_CLOSED = 6000;

  var state = {
    token: null,
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
  } catch (e) {
    /* private mode — fall back to in-memory token */
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
      '.panel{position:absolute;bottom:74px;' + side + ':0;width:340px;max-width:calc(100vw - 40px);' +
      'height:460px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;overflow:hidden;' +
      'box-shadow:0 12px 40px rgba(0,0,0,.28);display:none;flex-direction:column}' +
      '.panel.open{display:flex}' +
      '.head{background:' + accent + ';color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px}' +
      '.head img{width:34px;height:34px;border-radius:50%;object-fit:cover;background:rgba(255,255,255,.2)}' +
      '.head .nm{font-weight:600;font-size:15px;line-height:1.1}' +
      '.head .st{font-size:12px;opacity:.85}' +
      '.head .x{margin-' + (side === 'right' ? 'left' : 'right') + ':auto;cursor:pointer;font-size:20px;opacity:.9;background:none;border:none;color:#fff}' +
      '.body{flex:1;overflow-y:auto;padding:14px;background:#f5f6f8;display:flex;flex-direction:column;gap:8px}' +
      '.msg{max-width:80%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.35;word-wrap:break-word}' +
      '.msg.them{align-self:flex-start;background:#fff;color:#111;border:1px solid #ececec}' +
      '.typing{align-self:flex-start;background:#fff;border:1px solid #ececec;border-radius:14px;padding:11px 14px;display:flex;gap:4px}' +
      '.typing span{width:7px;height:7px;border-radius:50%;background:#bbb;display:inline-block;animation:ymtype 1.2s infinite}' +
      '.typing span:nth-child(2){animation-delay:.2s}.typing span:nth-child(3){animation-delay:.4s}' +
      '@keyframes ymtype{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}' +
      '.msg.me{align-self:flex-end;background:' + accent + ';color:#fff}' +
      '.foot{border-top:1px solid #ececec;padding:10px;display:flex;gap:8px;background:#fff}' +
      '.foot input{flex:1;border:1px solid #dcdcdc;border-radius:20px;padding:9px 14px;font-size:14px;outline:none}' +
      '.foot button{border:none;background:' + accent + ';color:#fff;border-radius:50%;width:38px;height:38px;cursor:pointer;font-size:16px}' +
      '.foot button:disabled{opacity:.5;cursor:default}' +
      '.greet{align-self:flex-start;color:#666;font-size:13px;padding:4px 2px}' +
      '.lead{padding:14px;display:none;flex-direction:column;gap:8px}' +
      '.lead.show{display:flex}' +
      '.lead p{margin:0;font-size:13px;color:#444}' +
      '.lead input,.lead textarea{border:1px solid #dcdcdc;border-radius:10px;padding:9px 12px;font-size:14px;font-family:inherit;outline:none}' +
      '.lead button{border:none;background:' + accent + ';color:#fff;border-radius:10px;padding:10px;font-weight:600;cursor:pointer}'
    );
  }

  var CHAT_ICON =
    '<svg viewBox="0 0 24 24"><path d="M12 3C6.5 3 2 6.9 2 11.7c0 2.2.98 4.2 2.6 5.7L4 21l4.2-1.4c1.2.4 2.5.6 3.8.6 5.5 0 10-3.9 10-8.5S17.5 3 12 3z"/></svg>';

  root.innerHTML =
    '<style>' + css() + '</style>' +
    '<div class="wrap">' +
    '  <div class="panel" part="panel">' +
    '    <div class="head">' +
    '      <img class="av" alt=""/>' +
    '      <div><div class="nm"></div><div class="st"></div></div>' +
    '      <button class="x" aria-label="Close">&times;</button>' +
    '    </div>' +
    '    <div class="body"></div>' +
    '    <form class="lead">' +
    '      <p>We\'re away right now — leave your email and message and we\'ll get back to you.</p>' +
    '      <input class="lead-email" type="email" placeholder="Your email" required />' +
    '      <textarea class="lead-msg" rows="3" placeholder="Your message" required></textarea>' +
    '      <button type="submit">Send</button>' +
    '    </form>' +
    '    <form class="foot"><input class="in" placeholder="Type a message…" autocomplete="off"/><button type="submit">&#10148;</button></form>' +
    '  </div>' +
    '  <button class="bubble" aria-label="Chat">' + CHAT_ICON + '<span class="badge"></span></button>' +
    '</div>';

  var el = {
    bubble: root.querySelector('.bubble'),
    badge: root.querySelector('.badge'),
    panel: root.querySelector('.panel'),
    close: root.querySelector('.x'),
    av: root.querySelector('.av'),
    nm: root.querySelector('.nm'),
    st: root.querySelector('.st'),
    body: root.querySelector('.body'),
    foot: root.querySelector('.foot'),
    input: root.querySelector('.in'),
    send: root.querySelector('.foot button'),
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
    div.innerHTML = esc(m.content);
    el.body.appendChild(div);
    el.body.scrollTop = el.body.scrollHeight;
  }

  function applyConfig(cfg) {
    state.config = cfg;
    var t = cfg.theme || {};
    var name = (cfg.owner && cfg.owner.displayName) || 'Chat';
    el.nm.textContent = name;
    el.st.textContent = cfg.owner && cfg.owner.online ? 'Online' : 'Away';
    if (cfg.owner && cfg.owner.avatarUrl) el.av.src = cfg.owner.avatarUrl;
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

  function togglePanel(open) {
    state.open = open;
    el.panel.classList.toggle('open', open);
    if (open) {
      state.unread = 0;
      updateBadge();
      ensureSession().then(startPolling).catch(function (e) {
        console.warn('[Yomeet widget]', e.message);
      });
      el.input.focus();
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
