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
    ownerAvatar: null,       // shown next to incoming bubbles
    ownerReadAt: null,       // owner's read cursor → drives sent/delivered/read ticks
    ownerDeliveredAt: null,
    greeting: null,          // owner's greeting, shown as a bubble on first open
    greeted: false,          // guard so the greeting shows only once
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
  // Guard against a double embed (snippet pasted in both header + footer, or a
  // theme that includes it twice) — otherwise two widgets stack up.
  if (document.querySelector('[data-yomeet-widget="' + handle + '"]')) return;

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
  // Widget dimensions, driven by theme.size (small | medium | large).
  var SIZES = {
    small: { bubble: 52, icon: 36, panelW: 320, panelH: 440 },
    medium: { bubble: 60, icon: 42, panelW: 344, panelH: 470 },
    large: { bubble: 70, icon: 49, panelW: 372, panelH: 520 },
  };
  var sz = SIZES.medium;

  function css() {
    return (
      '' +
      ':host{all:initial}' +
      '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}' +
      '.wrap{position:fixed;bottom:20px;' + side + ':20px;z-index:2147483000}' +
      // Bubble = a transparent button holding two real layers: the rotating
      // aurora ring (behind) and the 3D orb (on top). No negative z-index, so a
      // hover transform can\'t flip the ring on top of the orb.
      '.bubble{position:relative;width:' + sz.bubble + 'px;height:' + sz.bubble + 'px;border-radius:50%;cursor:pointer;' +
      'background:none;border:none;padding:0;box-shadow:0 9px 22px rgba(0,0,0,.32);transition:transform .15s ease}' +
      '.bubble:hover{transform:scale(1.06)}' +
      // Rotating "aurora" ring (emerald→cyan→indigo) — a unique animated border.
      '.bubble .ring{position:absolute;inset:-4px;border-radius:50%;' +
      'background:conic-gradient(from 0deg,#34d399,#22d3ee,#818cf8,#22d3ee,#34d399);animation:ymring 3s linear infinite}' +
      // 3D glossy orb (top-left highlight + bottom shading over the accent) with
      // a thin white outline that reads as a gap between orb and ring.
      '.bubble .orb{position:absolute;inset:0;border-radius:50%;z-index:1;display:flex;align-items:center;justify-content:center;' +
      'background:radial-gradient(circle at 32% 24%,rgba(255,255,255,.55),rgba(255,255,255,0) 44%),' +
      'radial-gradient(circle at 72% 84%,rgba(0,0,0,.34),rgba(0,0,0,0) 56%),' + accent + ';' +
      'box-shadow:inset 0 3px 6px rgba(255,255,255,.4),inset 0 -9px 15px rgba(0,0,0,.3),0 0 0 2.5px #fff}' +
      '.bubble .orb svg{width:' + sz.icon + 'px;height:' + sz.icon + 'px;overflow:visible}' +
      '@keyframes ymring{to{transform:rotate(1turn)}}' +
      // The face winks + opens its smile every few seconds for a bit of life.
      '.bubble svg .eye{transform-box:fill-box;transform-origin:center;animation:ymwink 4.5s ease-in-out infinite}' +
      '.bubble svg .mouth{transform-box:fill-box;transform-origin:50% 25%;animation:ymgrin 4.5s ease-in-out infinite}' +
      '@keyframes ymwink{0%,84%,100%{transform:scaleY(1)}88%,92%{transform:scaleY(.08)}}' +
      '@keyframes ymgrin{0%,82%,100%{transform:scaleY(1)}88%,94%{transform:scaleY(1.35)}}' +
      // Greeting teaser — a small speech bubble that pops up beside the widget.
      '.teaser{position:absolute;bottom:' + (sz.bubble + 14) + 'px;' + side + ':2px;width:max-content;max-width:240px;background:#fff;color:#111;' +
      'padding:11px 34px 11px 14px;border-radius:18px;box-shadow:0 10px 30px rgba(0,0,0,.18);' +
      'font-size:14px;line-height:1.35;font-weight:500;cursor:pointer;display:none;' +
      'transform-origin:bottom ' + side + ';transform:translateY(8px) scale(.85);opacity:0;' +
      'transition:transform .28s cubic-bezier(.2,.9,.3,1.35),opacity .2s}' +
      '.teaser.show{display:block;transform:translateY(0) scale(1);opacity:1}' +
      '.teaser .tx{position:absolute;top:6px;' + (side === 'right' ? 'right' : 'left') + ':6px;width:20px;height:20px;' +
      'border:none;border-radius:50%;background:rgba(0,0,0,.06);color:#666;cursor:pointer;font-size:14px;' +
      'line-height:1;display:flex;align-items:center;justify-content:center;padding:0}' +
      '.teaser .tx:hover{background:rgba(0,0,0,.12)}' +
      '.badge{position:absolute;top:-3px;right:-3px;z-index:2;min-width:20px;height:20px;padding:0 5px;border-radius:10px;' +
      'background:#ff3b30;color:#fff;font-size:12px;font-weight:700;line-height:20px;text-align:center;' +
      'box-shadow:0 0 0 2px #fff;display:none}' +
      '.badge.show{display:block}' +
      '.panel{position:absolute;bottom:' + (sz.bubble + 14) + 'px;' + side + ':0;width:' + sz.panelW + 'px;max-width:calc(100vw - 40px);' +
      'height:' + sz.panelH + 'px;max-height:calc(100vh - 120px);border-radius:18px;overflow:hidden;' +
      'background-color:#f4f5f7;background-image:radial-gradient(rgba(0,0,0,.06) 1.1px,transparent 1.1px);background-size:16px 16px;' +
      'box-shadow:0 12px 40px rgba(0,0,0,.28);display:flex;flex-direction:column;' +
      // Smooth open/close: scale + fade from the bubble corner. visibility is
      // delayed on close so the panel animates out before it stops rendering.
      'opacity:0;visibility:hidden;pointer-events:none;transform:translateY(12px) scale(.92);' +
      'transform-origin:bottom ' + side + ';' +
      'transition:opacity .2s ease,transform .28s cubic-bezier(.2,.9,.25,1.2),visibility 0s linear .3s}' +
      '.panel.open{opacity:1;visibility:visible;pointer-events:auto;transform:none;' +
      'transition:opacity .2s ease,transform .28s cubic-bezier(.2,.9,.25,1.2),visibility 0s}' +
      // Header — compact, light bar (no full accent flood): avatar, name +
      // accent online dot, subtle grey action buttons. Keeps chat space free.
      '.head{position:relative;z-index:1;background:#fff;color:#111;padding:8px 12px;margin:6px 6px 0;display:flex;align-items:center;gap:9px;' +
      'border-radius:14px 14px 16px 16px;box-shadow:0 2px 8px rgba(0,0,0,.07)}' +
      '.head img{width:32px;height:32px;border-radius:50%;object-fit:cover;background:#e6e8ec;flex:none}' +
      '.head .meta{min-width:0;flex:1}' +
      '.head .nm{font-weight:600;font-size:14px;line-height:1.15;color:#111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.head .nm .vf{width:14px;height:14px;vertical-align:-2px;margin-left:3px}' +
      '.head .st{font-size:11px;color:#8a9099;display:flex;align-items:center;gap:5px;margin-top:1px}' +
      '.head .dot{width:7px;height:7px;border-radius:50%;background:' + accent + ';flex:none}' +
      '.head .st.away{color:#a2a7ae}' +
      '.head .st.away .dot{background:#ccd1d7}' +
      '.head .btns{display:flex;gap:6px;flex:none}' +
      '.head .hbtn{width:28px;height:28px;border-radius:50%;background:#f0f1f4;border:none;color:#5a6069;' +
      'cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;transition:background .15s}' +
      '.head .hbtn:hover{background:#e4e6ea}' +
      '.head .hbtn svg{width:15px;height:15px;fill:#5a6069}' +
      '.body{flex:1;overflow-y:auto;padding:12px 12px 8px;background:transparent;' +
      'display:flex;flex-direction:column;gap:1px}' +
      // Each message is a row: optional owner avatar + the bubble.
      '.row{display:flex;align-items:flex-start;gap:6px;max-width:88%;margin-top:7px}' +
      '.row.them{align-self:flex-start}' +
      '.row.me{align-self:flex-end;flex-direction:row-reverse}' +
      '.row .rav{width:26px;height:26px;border-radius:50%;object-fit:cover;background:#cfd4da;flex:none;margin-top:1px}' +
      '.row.me .rav{display:none}' +
      // Bubbles with a curved tail ("horn") on the bottom outer corner.
      '.msg{position:relative;padding:6px 9px 5px;font-size:14px;line-height:1.35;word-wrap:break-word;box-shadow:0 1px .6px rgba(0,0,0,.13);min-width:46px}' +
      '.msg.them{background:#fff;color:#1a1a1a;border-radius:3px 13px 13px 13px}' +
      '.msg.me{background:' + accent + ';color:#fff;border-radius:13px 3px 13px 13px}' +
      '.msg.them::after{content:"";position:absolute;left:-6px;top:0;width:11px;height:14px;background:#fff;' +
      'clip-path:polygon(100% 100%,100% 0,0 0)}' +
      '.msg.me::after{content:"";position:absolute;right:-6px;top:0;width:11px;height:14px;background:' + accent + ';' +
      'clip-path:polygon(0 100%,0 0,100% 0)}' +
      // Timestamp + delivery ticks, tucked bottom-right inside the bubble.
      '.msg .meta{display:flex;align-items:center;justify-content:flex-end;gap:3px;margin-top:1px;font-size:10px;line-height:1;white-space:nowrap}' +
      '.msg.them .meta{color:#9aa0a6}' +
      '.msg.me .meta{color:rgba(255,255,255,.82)}' +
      '.msg .tk{display:inline-flex;align-items:center}' +
      '.msg .tk svg{width:16px;height:11px}' +
      '.msg .tk svg path{fill:rgba(255,255,255,.85)}' +
      '.msg .tk.read svg path{fill:#7fd4ff}' +
      // Image messages — time chip overlays the photo.
      '.msg.img{padding:3px}' +
      '.msg.img img{display:block;width:100%;max-width:210px;max-height:250px;object-fit:cover;border-radius:11px;cursor:pointer}' +
      '.msg.img .meta{position:absolute;right:9px;bottom:8px;margin:0;padding:2px 6px;border-radius:9px;background:rgba(0,0,0,.4);color:#fff}' +
      '.msg.img .meta .tk svg path{fill:#fff}' +
      '.msg.img .meta .tk.read svg path{fill:#7fd4ff}' +
      '.msg .cap{padding:4px 6px 0}' +
      '.typing{position:relative;align-self:flex-start;background:#fff;border-radius:3px 13px 13px 13px;box-shadow:0 1px .6px rgba(0,0,0,.13);padding:11px 13px;display:flex;gap:4px;margin-top:7px}' +
      '.typing::after{content:"";position:absolute;left:-6px;top:0;width:11px;height:14px;background:#fff;' +
      'clip-path:polygon(100% 100%,100% 0,0 0)}' +
      '.typing span{width:7px;height:7px;border-radius:50%;background:#bbb;display:inline-block;animation:ymtype 1.2s infinite}' +
      '.typing span:nth-child(2){animation-delay:.2s}.typing span:nth-child(3){animation-delay:.4s}' +
      '@keyframes ymtype{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}' +
      // Footer — a rounded input pill with the "+" attach button inside it, and
      // the app\'s Telegram send button outside on the right.
      '.foot{position:relative;z-index:1;padding:8px 10px;margin:0 6px;display:flex;gap:8px;background:#fff;align-items:center;' +
      'border-radius:16px 16px 0 0;box-shadow:0 -2px 8px rgba(0,0,0,.06)}' +
      '.foot .inwrap{flex:1;display:flex;align-items:center;gap:4px;background:#f1f2f4;border:1px solid #e3e5e9;border-radius:22px;padding:3px 4px;min-width:0}' +
      '.foot .inwrap:focus-within{border-color:' + accent + '}' +
      '.foot .plus{width:32px;height:32px;min-width:32px;border:none;border-radius:50%;background:' + accent + ';cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}' +
      '.foot .plus svg{width:19px;height:19px;fill:#fff}' +
      '.foot input.in{flex:1;min-width:0;border:none;background:none;padding:8px 8px;font-size:14px;outline:none}' +
      '.foot .send{border:none;background:' + accent + ';color:#fff;border-radius:50%;width:40px;height:40px;min-width:40px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}' +
      '.foot .send svg{width:20px;height:20px;fill:#fff;margin:1px 0 0 1px}' +
      '.foot .send:disabled{opacity:.5;cursor:default}' +
      // Mic + record — idle/empty shows the mic; typing shows send; recording
      // swaps the input for a recording bar and shows send (to finish).
      '.foot .mic{border:none;background:' + accent + ';color:#fff;border-radius:50%;width:40px;height:40px;min-width:40px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}' +
      '.foot .mic svg{width:21px;height:21px;fill:#fff}' +
      '.foot .send{display:none}' +
      '.foot.has-text .mic{display:none}' +
      '.foot.has-text .send{display:flex}' +
      '.foot.recording .inwrap{display:none}' +
      '.foot.recording .mic{display:none}' +
      '.foot.recording .send{display:flex}' +
      '.recbar{display:none;flex:1;align-items:center;gap:10px;background:#f1f2f4;border:1px solid #e3e5e9;border-radius:22px;padding:8px 14px;min-width:0}' +
      '.foot.recording .recbar{display:flex}' +
      '.recbar .rec-dot{width:10px;height:10px;border-radius:50%;background:#ff3b30;flex:none;animation:ymrec 1s ease-in-out infinite}' +
      '@keyframes ymrec{0%,100%{opacity:1}50%{opacity:.25}}' +
      '.recbar .rec-time{font-size:14px;color:#333;flex:1}' +
      '.recbar .rec-cancel{border:none;background:none;color:#888;font-size:20px;cursor:pointer;padding:0 2px;line-height:1}' +
      // Voice-note bubble: play/pause + progress + countdown.
      '.msg.audio{min-width:186px}' +
      '.msg .aud{display:flex;align-items:center;gap:9px;padding:2px 2px 4px}' +
      '.msg .aud-play{border:none;border-radius:50%;width:32px;height:32px;min-width:32px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}' +
      '.msg.them .aud-play{background:' + accent + '}.msg.me .aud-play{background:rgba(255,255,255,.92)}' +
      '.msg .aud-play svg{width:16px;height:16px}' +
      '.msg.them .aud-play svg{fill:#fff}.msg.me .aud-play svg{fill:' + accent + '}' +
      '.msg .aud-bar{flex:1;height:3px;border-radius:2px;position:relative;min-width:60px}' +
      '.msg.them .aud-bar{background:rgba(0,0,0,.12)}.msg.me .aud-bar{background:rgba(255,255,255,.35)}' +
      '.msg .aud-fill{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:2px}' +
      '.msg.them .aud-fill{background:' + accent + '}.msg.me .aud-fill{background:#fff}' +
      '.msg .aud-time{font-size:11px;opacity:.75;flex:none;min-width:30px;text-align:right}' +
      '.greet{align-self:flex-start;color:#666;font-size:13px;padding:4px 2px}' +
      // Pre-chat name step.
      '.namebar{position:relative;z-index:1;padding:12px;margin:0 6px;background:#fff;display:none;flex-direction:column;gap:8px;' +
      'border-radius:16px 16px 0 0;box-shadow:0 -2px 8px rgba(0,0,0,.06)}' +
      '.namebar.show{display:flex}' +
      '.namebar label{font-size:13px;color:#333;font-weight:600}' +
      '.namebar .row{display:flex;gap:8px}' +
      '.namebar input{flex:1;border:1px solid #dcdcdc;border-radius:22px;padding:10px 15px;font-size:14px;outline:none}' +
      '.namebar button{border:none;background:' + accent + ';color:#fff;border-radius:22px;padding:10px 18px;font-weight:600;cursor:pointer;white-space:nowrap}' +
      '.lead{position:relative;z-index:1;padding:14px;margin:0 6px;background:#fff;display:none;flex-direction:column;gap:8px;' +
      'border-radius:16px 16px 0 0;box-shadow:0 -2px 8px rgba(0,0,0,.06)}' +
      '.lead.show{display:flex}' +
      '.lead p{margin:0;font-size:13px;color:#444}' +
      '.lead input,.lead textarea{border:1px solid #dcdcdc;border-radius:10px;padding:9px 12px;font-size:14px;font-family:inherit;outline:none}' +
      '.lead button{border:none;background:' + accent + ';color:#fff;border-radius:10px;padding:10px;font-weight:600;cursor:pointer}' +
      '.powered{text-align:center;font-size:11px;color:#9aa0a6;padding:5px 6px 7px;background:#fff;margin:0 6px 6px;border-radius:0 0 14px 14px}' +
      '.powered a{color:' + accent + ';text-decoration:none;font-weight:600}' +
      // Phones: the panel becomes a near-fullscreen sheet so the chat is
      // comfortable to read and type on small screens.
      '@media (max-width:480px){' +
      '.wrap{bottom:16px;' + side + ':16px}' +
      '.panel{width:calc(100vw - 24px);height:calc(100dvh - 96px);max-height:calc(100dvh - 96px);bottom:' + (sz.bubble + 12) + 'px}' +
      '.msg.img img,.msg.img{max-width:62vw}' +
      '}'
    );
  }

  // Friendly smiley face (white smile + dot) — the black circle from the source
  // icon is the bubble itself. Sits on the accent bubble inside the animated ring.
  var CHAT_ICON =
    '<svg viewBox="0 0 128 128" fill="none">' +
    '<path class="mouth" d="M34 62C43 86 56 95 72 95C88 95 101 86 110 62" fill="none" stroke="#fff" stroke-width="12" stroke-linecap="round"/>' +
    '<circle class="eye" cx="91" cy="42" r="9" fill="#fff"/>' +
    '</svg>';
  // The app's Telegram-plane send icon (assets/icons/telegram-send.svg) so the
  // widget's send button matches the in-app composer.
  var SEND_ICON =
    '<svg viewBox="0 0 496 512"><path d="M446.7 98.6l-67.6 318.8c-5.1 22.5-18.4 28.1-37.3 17.5l-103-75.9-49.7 47.8c-5.5 5.5-10.1 10.1-20.7 10.1l7.4-104.9 190.9-172.5c8.3-7.4-1.8-11.5-12.9-4.1L117.8 284 16.2 252.2c-22.1-6.9-22.5-22.1 4.6-32.7L418.2 66.4c18.4-6.8 34.5 4.4 28.5 32.2z"/></svg>';
  // "+" icon for the in-pill attach button.
  var PLUS_ICON =
    '<svg viewBox="0 0 24 24"><path d="M19 11h-6V5a1 1 0 00-2 0v6H5a1 1 0 000 2h6v6a1 1 0 002 0v-6h6a1 1 0 000-2z"/></svg>';
  // Double / single check ("tick") marks for delivery status on sent messages.
  var TICK_DOUBLE =
    '<svg viewBox="0 0 18 12"><path d="M17.1 1.3a.9.9 0 00-1.28-.03L8.2 8.6l-1.1-1.06 6.9-6.6a.9.9 0 10-1.24-1.3L6.3 6.02 3.9 3.72A.9.9 0 002.65 5l3 2.9c.35.34.9.34 1.25 0l.02-.02.03.03c.35.34.9.34 1.25 0l8-7.32a.9.9 0 00-.1-1.29zM.9 5.02a.9.9 0 00-.03 1.27l3 3.1c.35.36.92.37 1.28.02.36-.34.37-.91.02-1.27l-3-3.1A.9.9 0 00.9 5.02z"/></svg>';
  var TICK_SINGLE =
    '<svg viewBox="0 0 18 12"><path d="M6.5 9.6L3.2 6.3A.9.9 0 101.93 7.6l3.94 3.94c.35.35.92.35 1.27 0L15.9 2.98A.9.9 0 1014.63 1.7L6.5 9.6z"/></svg>';
  var MIN_ICON = '<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>';
  var MIC_ICON =
    '<svg viewBox="0 0 24 24"><path d="M12 15a3 3 0 003-3V6a3 3 0 00-6 0v6a3 3 0 003 3zm5-3a5 5 0 01-10 0H5a7 7 0 006 6.92V22h2v-3.08A7 7 0 0019 12h-2z"/></svg>';
  var AUDIO_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  var AUDIO_PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
  // Blue verified seal + white check, shown next to a verified owner's name.
  var VERIFIED_ICON =
    '<svg class="vf" viewBox="0 0 24 24" aria-label="Verified">' +
    '<path fill="#1d9bf0" d="M22.25 12l-2.1-2.4.29-3.19-3.12-.71L15.66 3 12 4.57 8.34 3 6.68 5.7l-3.12.7.29 3.2L1.75 12l2.1 2.4-.29 3.2 3.12.7L8.34 21 12 19.42 15.66 21l1.66-2.7 3.12-.71-.29-3.19z"/>' +
    '<path fill="#fff" d="M10.1 15.3l-3-3 1.3-1.3 1.7 1.7 4.2-4.2 1.3 1.3z"/></svg>';
  var X_ICON =
    '<svg viewBox="0 0 24 24"><path d="M18.3 5.7a1 1 0 00-1.42 0L12 10.59 7.11 5.7A1 1 0 105.7 7.11L10.59 12 5.7 16.89a1 1 0 101.41 1.41L12 13.41l4.89 4.89a1 1 0 001.41-1.41L13.41 12l4.89-4.89a1 1 0 000-1.41z"/></svg>';

  // Style injection that survives a strict Content-Security-Policy. On
  // security-hardened sites a `style-src` without 'unsafe-inline' blocks a
  // plain <style> tag (even inside a shadow root) → an unstyled widget. A
  // constructable stylesheet (adoptedStyleSheets) is not treated as inline, so
  // it renders under strict CSP. Fall back to <style> on older browsers.
  var styleSheet = null;
  function applyStyles() {
    var cssText = css();
    if (styleSheet) { styleSheet.replaceSync(cssText); return; }
    try {
      if (typeof CSSStyleSheet !== 'undefined' && 'replaceSync' in CSSStyleSheet.prototype) {
        styleSheet = new CSSStyleSheet();
        styleSheet.replaceSync(cssText);
        root.adoptedStyleSheets = [styleSheet];
        return;
      }
    } catch (e) { styleSheet = null; /* fall through to a <style> tag */ }
    var styleEl = root.querySelector('style');
    if (!styleEl) { styleEl = document.createElement('style'); root.insertBefore(styleEl, root.firstChild); }
    styleEl.textContent = cssText;
  }

  root.innerHTML =
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
    '      <div class="inwrap">' +
    '        <button type="button" class="plus" aria-label="Send image">' + PLUS_ICON + '</button>' +
    '        <input class="in" placeholder="Type a message…" autocomplete="off"/>' +
    '      </div>' +
    '      <div class="recbar"><span class="rec-dot"></span><span class="rec-time">0:00</span>' +
    '        <button type="button" class="rec-cancel" aria-label="Cancel recording">&times;</button></div>' +
    '      <button type="button" class="mic" aria-label="Record voice note">' + MIC_ICON + '</button>' +
    '      <button type="submit" class="send" aria-label="Send">' + SEND_ICON + '</button>' +
    '      <input type="file" class="file" accept="image/*" hidden/>' +
    '    </form>' +
    '    <div class="powered">Powered by <a class="pw-link" target="_blank" rel="noopener noreferrer">Yomeet</a></div>' +
    '  </div>' +
    '  <div class="teaser"><button class="tx" aria-label="Dismiss">&times;</button><span class="teaser-msg">Hello, need some help?</span></div>' +
    '  <button class="bubble" aria-label="Chat"><span class="ring"></span><span class="orb">' + CHAT_ICON + '</span><span class="badge"></span></button>' +
    '</div>';

  applyStyles(); // initial styles (defaults; re-applied once the theme loads)

  var el = {
    bubble: root.querySelector('.bubble'),
    badge: root.querySelector('.badge'),
    teaser: root.querySelector('.teaser'),
    teaserMsg: root.querySelector('.teaser-msg'),
    teaserX: root.querySelector('.teaser .tx'),
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
    mic: root.querySelector('.foot .mic'),
    recbar: root.querySelector('.recbar'),
    recTime: root.querySelector('.rec-time'),
    recCancel: root.querySelector('.rec-cancel'),
    attach: root.querySelector('.plus'),
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

  function fmtTime(iso) {
    var d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    var h = d.getHours(), mi = d.getMinutes();
    var ap = h < 12 ? 'AM' : 'PM';
    h = h % 12; if (h === 0) h = 12;
    return h + ':' + (mi < 10 ? '0' : '') + mi + ' ' + ap;
  }

  // Delivery status of one of the visitor's own messages, from the owner's read
  // position (returned on every poll). read > delivered > sent.
  function statusFor(createdIso) {
    var t = new Date(createdIso).getTime();
    if (state.ownerReadAt && new Date(state.ownerReadAt).getTime() >= t) return 'read';
    if (state.ownerDeliveredAt && new Date(state.ownerDeliveredAt).getTime() >= t) return 'delivered';
    return 'sent';
  }
  function tickInner(status) {
    return status === 'sent' ? TICK_SINGLE : TICK_DOUBLE;
  }

  function metaEl(m) {
    var meta = document.createElement('div');
    meta.className = 'meta';
    var tm = document.createElement('span');
    tm.textContent = fmtTime(m.createdAt);
    meta.appendChild(tm);
    if (m.fromVisitor) {
      var st = m.createdAt ? statusFor(m.createdAt) : 'sent';
      var tk = document.createElement('span');
      tk.className = 'tk' + (st === 'read' ? ' read' : '');
      tk.innerHTML = tickInner(st);
      meta.appendChild(tk);
    }
    return meta;
  }

  // Re-evaluate ticks on every own message when the owner's read position moves.
  function updateTicks() {
    var bubbles = el.body.querySelectorAll('.msg[data-me]');
    for (var i = 0; i < bubbles.length; i++) {
      var b = bubbles[i];
      var created = b.getAttribute('data-created');
      var tk = b.querySelector('.tk');
      if (!created || !tk) continue;
      var st = statusFor(created);
      tk.className = 'tk' + (st === 'read' ? ' read' : '');
      tk.innerHTML = tickInner(st);
    }
  }

  function fmtClock(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    var mm = Math.floor(sec / 60), ss = sec % 60;
    return mm + ':' + (ss < 10 ? '0' : '') + ss;
  }

  // A compact voice-note player: play/pause + progress bar + a countdown time.
  function renderAudio(url, duration) {
    var wrap = document.createElement('div');
    wrap.className = 'aud';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'aud-play';
    btn.innerHTML = AUDIO_PLAY;
    var bar = document.createElement('div');
    bar.className = 'aud-bar';
    var fill = document.createElement('div');
    fill.className = 'aud-fill';
    bar.appendChild(fill);
    var time = document.createElement('span');
    time.className = 'aud-time';
    time.textContent = fmtClock(duration);
    var audio = new Audio(url);
    var playing = false;
    audio.addEventListener('timeupdate', function () {
      var d = (audio.duration && isFinite(audio.duration)) ? audio.duration : (duration || 0);
      if (d > 0) fill.style.width = (audio.currentTime / d * 100) + '%';
      time.textContent = fmtClock(d - audio.currentTime);
    });
    audio.addEventListener('ended', function () {
      playing = false;
      btn.innerHTML = AUDIO_PLAY;
      fill.style.width = '0%';
      audio.currentTime = 0;
      time.textContent = fmtClock(duration);
    });
    btn.addEventListener('click', function () {
      if (playing) { audio.pause(); btn.innerHTML = AUDIO_PLAY; }
      else { audio.play(); btn.innerHTML = AUDIO_PAUSE; }
      playing = !playing;
    });
    wrap.appendChild(btn);
    wrap.appendChild(bar);
    wrap.appendChild(time);
    return wrap;
  }

  // Renders a message row (owner avatar on incoming + bubble) and returns the
  // bubble element so the caller can later stamp a server id/timestamp on it.
  function addMessage(m) {
    if (m.id) {
      var existing = el.body.querySelector('.msg[data-mid="' + m.id + '"]');
      if (state.seen[m.id]) return existing; // already rendered — skip the duplicate
      state.seen[m.id] = 1;
      state.lastId = m.id;
    }
    var typing = el.body.querySelector('.typing');
    if (typing) typing.remove(); // a real message means typing is over

    var row = document.createElement('div');
    row.className = 'row ' + (m.fromVisitor ? 'me' : 'them');
    if (!m.fromVisitor) {
      var av = document.createElement('img');
      av.className = 'rav';
      av.alt = '';
      if (state.ownerAvatar) av.src = state.ownerAvatar;
      row.appendChild(av);
    }

    var div = document.createElement('div');
    div.className = 'msg ' + (m.fromVisitor ? 'me' : 'them');
    if (m.id) div.setAttribute('data-mid', m.id);
    if (m.createdAt) div.setAttribute('data-created', m.createdAt);
    if (m.fromVisitor) div.setAttribute('data-me', '1');

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
    } else if (m.audioUrl) {
      div.className += ' audio';
      div.appendChild(renderAudio(m.audioUrl, m.audioDuration, m.fromVisitor));
    } else {
      var txt = document.createElement('span');
      txt.textContent = m.content == null ? '' : String(m.content);
      div.appendChild(txt);
    }
    div.appendChild(metaEl(m));
    row.appendChild(div);
    el.body.appendChild(row);
    el.body.scrollTop = el.body.scrollHeight;
    return div;
  }

  function applyConfig(cfg) {
    state.config = cfg;
    var t = cfg.theme || {};
    var name = (cfg.owner && cfg.owner.displayName) || 'Chat';
    el.nm.textContent = name;
    // Verified badge next to the owner's name when their Yomeet account is verified.
    if (cfg.owner && cfg.owner.verified) {
      el.nm.insertAdjacentHTML('beforeend', VERIFIED_ICON);
    }
    var online = !!(cfg.owner && cfg.owner.online);
    el.stTxt.textContent = online ? 'Online' : 'Away';
    el.st.classList.toggle('away', !online);
    if (cfg.owner && cfg.owner.avatarUrl) {
      el.av.src = cfg.owner.avatarUrl;
      state.ownerAvatar = cfg.owner.avatarUrl;
    }
    // "Powered by Yomeet" → the right store for the visitor's device.
    var s = cfg.stores || {};
    var ua = navigator.userAgent || '';
    el.pwLink.href = /iPhone|iPad|iPod/i.test(ua) ? (s.ios || 'https://yomeet.app')
      : /Android/i.test(ua) ? (s.android || 'https://yomeet.app')
      : (s.web || 'https://yomeet.app');
    if (t.greeting) {
      // Shown as an incoming bubble once the visitor has entered their name and
      // the chat opens (see maybeGreet), and reused as the teaser text.
      state.greeting = t.greeting;
      el.teaserMsg.textContent = t.greeting;
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
      if (res.ownerReadAt !== undefined) state.ownerReadAt = res.ownerReadAt;
      if (res.ownerDeliveredAt !== undefined) state.ownerDeliveredAt = res.ownerDeliveredAt;
      // Live owner presence — flip the header Online ↔ Away as it changes.
      if (typeof res.ownerOnline === 'boolean') {
        el.stTxt.textContent = res.ownerOnline ? 'Online' : 'Away';
        el.st.classList.toggle('away', !res.ownerOnline);
      }
      var ownerNew = 0;
      (res.messages || []).forEach(function (m) {
        var isNew = !(m.id && state.seen[m.id]);
        addMessage(m); // dedupes via state.seen
        if (isNew && !m.fromVisitor) ownerNew++; // a fresh reply from the owner
      });
      updateTicks(); // advance sent → delivered → read on our own messages
      // Reply arrived while the panel is closed → badge + chime.
      if (ownerNew > 0 && !state.open) {
        state.unread += ownerNew;
        updateBadge();
        playChime();
      }
      // Panel is open → the visitor is reading; tell the owner (blue ticks).
      if (state.open) markRead();
    });
  }

  // Stamp the server id + timestamp onto an optimistic echo bubble, and advance
  // the cursor so the poller never re-adds the just-sent message as a duplicate.
  function stampEcho(echo, msg) {
    if (!msg || !msg.id) return;
    state.seen[msg.id] = 1;
    state.lastId = msg.id;
    if (echo) {
      echo.setAttribute('data-mid', msg.id);
      if (msg.createdAt) echo.setAttribute('data-created', msg.createdAt);
    }
  }

  // Tell the owner the visitor has read the thread (blue ticks on the owner's
  // side). Debounced; only meaningful once a conversation and panel exist.
  var lastRead = 0;
  function markRead() {
    if (!state.token || !state.conversationId || !state.open) return;
    var now = Date.now();
    if (now - lastRead < 1500) return;
    lastRead = now;
    api('POST', '/public/read').catch(function () {});
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

  // A one-time greeting from the owner, shown as an incoming bubble once the
  // visitor has entered their name and the chat is open — but only for a fresh
  // chat (no prior messages), so returning visitors aren't re-greeted.
  function maybeGreet() {
    if (state.greeted || !state.greeting || !state.name) return;
    if (el.body.querySelector('.row')) return; // has history → don't greet
    state.greeted = true;
    addMessage({
      content: state.greeting,
      fromVisitor: false,
      createdAt: new Date().toISOString(),
    });
  }

  // Begin (or resume) the chat: start the session, poll loop, and stream.
  function startChat() {
    ensureSession()
      .then(function () {
        startPolling();
        maybeGreet();
      })
      .catch(function (e) {
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
        lastRead = 0; // let the next read ping fire immediately on open
        markRead();
      }
    } else {
      // Keep polling in the background (slower) so replies still chime + badge.
      startPolling();
    }
  }

  // ── greeting teaser ────────────────────────────────────────────────
  // A friendly nudge that pops up beside the bubble once per session, until the
  // visitor opens the chat or dismisses it.
  var TEASER_KEY = 'yomeet_widget_teaser_' + handle;
  var teaserTimer = null;
  function teaserSeen() {
    try { return !!sessionStorage.getItem(TEASER_KEY); } catch (e) { return false; }
  }
  function hideTeaser(remember) {
    el.teaser.classList.remove('show');
    clearTimeout(teaserTimer);
    if (remember) { try { sessionStorage.setItem(TEASER_KEY, '1'); } catch (e) { /* ignore */ } }
  }
  function maybeShowTeaser() {
    if (state.open || teaserSeen()) return;
    el.teaser.classList.add('show');
    // auto-retract after a while so it isn't nagging, but don't mark as seen —
    // it can pop again next session.
    teaserTimer = setTimeout(function () { el.teaser.classList.remove('show'); }, 12000);
  }
  // Give the page a moment to settle, then invite.
  setTimeout(maybeShowTeaser, 3500);

  el.teaser.addEventListener('click', function () {
    hideTeaser(true);
    togglePanel(true);
  });
  el.teaserX.addEventListener('click', function (e) {
    e.stopPropagation(); // don't also open the panel
    hideTeaser(true);
  });

  // ── events ─────────────────────────────────────────────────────────
  el.bubble.addEventListener('click', function () {
    hideTeaser(true);
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
    var echo = null;
    ensureSession()
      .then(function () {
        echo = addMessage({ imageUrl: localUrl, fromVisitor: true, createdAt: new Date().toISOString() });
        return uploadImage(f);
      })
      .then(function (msg) {
        stampEcho(echo, msg);
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
    // Show the send button when there's text, the mic button when empty.
    el.foot.classList.toggle('has-text', el.input.value.trim().length > 0);
    var now = Date.now();
    if (state.token && now - state.lastTyping > 2000) {
      state.lastTyping = now;
      api('POST', '/public/typing').catch(function () {});
    }
  });

  // ── voice notes ─────────────────────────────────────────────────────
  // Record to WAV (via Web Audio) so the clip plays everywhere — the owner's
  // iOS/Android app and any browser. MediaRecorder's webm/opus wouldn't play on
  // iOS, so we capture PCM and encode a 16-bit WAV ourselves.
  var rec = { active: false, ctx: null, src: null, proc: null, stream: null,
    chunks: [], sampleRate: 0, startTs: 0, timer: null };

  function recTick() {
    var s = Math.floor((Date.now() - rec.startTs) / 1000);
    el.recTime.textContent = fmtClock(s);
  }

  function recStart() {
    if (rec.active) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      rec.stream = stream;
      rec.ctx = new AC();
      rec.sampleRate = rec.ctx.sampleRate;
      rec.src = rec.ctx.createMediaStreamSource(stream);
      rec.proc = rec.ctx.createScriptProcessor(4096, 1, 1);
      rec.chunks = [];
      rec.proc.onaudioprocess = function (e) {
        rec.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      rec.src.connect(rec.proc);
      rec.proc.connect(rec.ctx.destination);
      rec.active = true;
      rec.startTs = Date.now();
      el.recTime.textContent = '0:00';
      el.foot.classList.add('recording');
      rec.timer = setInterval(recTick, 250);
    }).catch(function (err) {
      console.warn('[Yomeet widget] microphone unavailable', err && err.message);
    });
  }

  function recTeardown() {
    clearInterval(rec.timer);
    try { rec.proc && rec.proc.disconnect(); rec.src && rec.src.disconnect(); } catch (e) { /* ignore */ }
    if (rec.stream) rec.stream.getTracks().forEach(function (t) { t.stop(); });
    try { rec.ctx && rec.ctx.close(); } catch (e) { /* ignore */ }
    rec.active = false;
    el.foot.classList.remove('recording');
  }

  function recStop(send) {
    if (!rec.active) return;
    var dur = Math.round((Date.now() - rec.startTs) / 1000);
    var chunks = rec.chunks;
    var sr = rec.sampleRate;
    recTeardown();
    if (!send || dur < 1) return;
    var total = chunks.reduce(function (a, c) { return a + c.length; }, 0);
    var pcm = new Float32Array(total);
    var off = 0;
    chunks.forEach(function (c) { pcm.set(c, off); off += c.length; });
    var blob = new Blob([encodeWav(pcm, sr)], { type: 'audio/wav' });
    uploadAudio(blob, dur);
  }

  // 16-bit mono PCM → WAV container.
  function encodeWav(samples, sampleRate) {
    var buf = new ArrayBuffer(44 + samples.length * 2);
    var view = new DataView(buf);
    function str(off, s) { for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, samples.length * 2, true);
    var o = 44;
    for (var i = 0; i < samples.length; i++) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
    return view;
  }

  function uploadAudio(blob, dur) {
    var echo = null;
    ensureSession().then(function () {
      echo = addMessage({ audioUrl: URL.createObjectURL(blob), audioDuration: dur, fromVisitor: true, createdAt: new Date().toISOString() });
      var fd = new FormData();
      fd.append('audio', blob, 'voice.wav');
      fd.append('duration', String(dur));
      var headers = {};
      if (state.token) headers['x-widget-token'] = state.token;
      return fetch(API + '/api/widget/public/messages/audio', { method: 'POST', headers: headers, body: fd })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (d) {
            if (!r.ok) throw new Error((d && d.error && d.error.message) || 'Upload failed');
            return d;
          });
        });
    }).then(function (msg) {
      stampEcho(echo, msg);
      openStream();
    }).catch(function (err) {
      console.warn('[Yomeet widget]', err.message);
    });
  }

  el.mic.addEventListener('click', recStart);
  el.recCancel.addEventListener('click', function () { recStop(false); });

  el.foot.addEventListener('submit', function (e) {
    e.preventDefault();
    // While recording, the send button finishes + uploads the voice note.
    if (rec.active) { recStop(true); return; }
    var text = el.input.value.trim();
    if (!text) return;
    el.input.value = '';
    el.foot.classList.remove('has-text');
    el.send.disabled = true;
    var echo = null;
    ensureSession()
      .then(function () {
        // optimistic echo (client timestamp; server id/time stamped on below)
        echo = addMessage({ content: text, fromVisitor: true, createdAt: new Date().toISOString() });
        return api('POST', '/public/messages', { content: text });
      })
      .then(function (msg) {
        stampEcho(echo, msg);
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
      if (SIZES[t.size]) sz = SIZES[t.size];
      // Re-render styles now that theme is known.
      applyStyles();
      applyConfig(cfg);
    })
    .catch(function (e) {
      // Not enabled for this site / not found → remove the widget silently.
      host.remove();
    });
})();
