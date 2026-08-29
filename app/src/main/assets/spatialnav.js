// Spatial navigation for Autodarts TV.
// Injected by the Android WebView after page load. Survives SPA route changes
// because it lives on the document, not on a specific page.
(function () {
  'use strict';
  if (window.__adnav) return;
  window.__adnav = true;

  // ---------- highlight style: shiny white glow ----------
  // Styles do not cross shadow boundaries, so this text gets stamped into every
  // shadow root we walk into as well — see ensureStyle().
  var STYLE_TEXT =
    '@keyframes __adnav_pulse {' +
    '  0%   { box-shadow: 0 0 10px 3px rgba(255,255,255,0.55), 0 0 0 2px rgba(255,255,255,0.9); }' +
    '  50%  { box-shadow: 0 0 18px 6px rgba(255,255,255,0.75), 0 0 0 2px rgba(255,255,255,1); }' +
    '  100% { box-shadow: 0 0 10px 3px rgba(255,255,255,0.55), 0 0 0 2px rgba(255,255,255,0.9); }' +
    '}' +
    '.__adnav_focus {' +
    '  outline: 2px solid rgba(255,255,255,0.95) !important;' +
    '  outline-offset: 2px !important;' +
    '  border-radius: 8px;' +
    '  animation: __adnav_pulse 1.6s ease-in-out infinite !important;' +
    '  position: relative;' +
    '  z-index: 2147483646;' +
    '}';

  /** Inject the highlight CSS into a document or shadow root, once each. */
  function ensureStyle(root) {
    if (!root || root.__adnav_styled) return;
    root.__adnav_styled = true;
    var style = document.createElement('style');
    style.id = '__adnav_style';
    style.textContent = STYLE_TEXT;
    var host = (root === document)
      ? (document.head || document.documentElement)
      : root;
    host.appendChild(style);
  }

  ensureStyle(document);

  var current = null;

  var SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="tab"]',
    '[role="menuitem"]', '[role="option"]', '[role="checkbox"]',
    '[role="radio"]', '[role="switch"]',
    '[tabindex]:not([tabindex="-1"])', '[onclick]'
  ].join(',');

  function isVisible(el) {
    if (!el.isConnected) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    var s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (parseFloat(s.opacity) < 0.05) return false;
    if (el.disabled) return false;
    return true;
  }

  /** True if the element only wraps another candidate (avoid double hits). */
  function wrapsCandidate(el) {
    if (el.querySelector && el.querySelector(SELECTOR)) return true;
    // A shadow host's own light DOM is often empty while the real controls sit
    // inside its shadow root — those are the ones we want, not the host.
    if (el.shadowRoot && el.shadowRoot.querySelector(SELECTOR)) return true;
    return false;
  }

  /**
   * Collect focusable elements from a root, descending into every open shadow
   * root on the way down.
   *
   * This is what makes the "Tools for Autodarts" settings panel reachable at
   * all: it mounts via createShadowRootUi() under <autodarts-tools-wxt>, and a
   * plain document.querySelectorAll() sees nothing inside it. Without this the
   * one screen you most want the remote for would be completely dead.
   */
  function collectDeep(root, out) {
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.shadowRoot) {
        ensureStyle(el.shadowRoot);
        observe(el.shadowRoot);
        collectDeep(el.shadowRoot, out);
      }
      if (el === current) continue;
      if (!el.matches || !el.matches(SELECTOR)) continue;
      if (wrapsCandidate(el)) continue;
      if (isVisible(el)) out.push(el);
    }
  }

  function candidates() {
    var out = [];
    collectDeep(document, out);
    return out;
  }

  /** The innermost active element, following shadow roots down. */
  function deepActiveElement() {
    var el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
    }
    return el;
  }

  function rect(el) { return el.getBoundingClientRect(); }

  function rangesOverlap(a1, a2, b1, b2) {
    return Math.min(a2, b2) - Math.max(a1, b1) > 0;
  }

  // ---------- direction search ----------
  // Three passes, strict to loose. This is what makes "up" really go UP:
  //   pass 0: candidate overlaps current on the orthogonal axis
  //           (same column for up/down, same row for left/right)
  //   pass 1: candidate lies within a 45-degree cone in that direction
  //   pass 2: anything in the half-plane (last resort, heavy ortho penalty)
  function findNext(dir) {
    if (!current || !isVisible(current)) {
      current = null;
      return pickInitial();
    }
    var c = rect(current);
    var cx = c.left + c.width / 2, cy = c.top + c.height / 2;
    var cands = candidates();
    var vertical = (dir === 'up' || dir === 'down');

    for (var pass = 0; pass < 3; pass++) {
      var best = null, bestScore = Infinity;
      for (var i = 0; i < cands.length; i++) {
        var el = cands[i];
        var p = rect(el);
        var px = p.left + p.width / 2, py = p.top + p.height / 2;

        // main = edge-to-edge distance in the pressed direction (center-based
        // sign check so elements must actually lie in that direction)
        var main, ortho, overlap;
        if (dir === 'up')    { if (py >= cy - 2) continue; main = c.top - p.bottom; ortho = Math.abs(px - cx); }
        if (dir === 'down')  { if (py <= cy + 2) continue; main = p.top - c.bottom; ortho = Math.abs(px - cx); }
        if (dir === 'left')  { if (px >= cx - 2) continue; main = c.left - p.right; ortho = Math.abs(py - cy); }
        if (dir === 'right') { if (px <= cx + 2) continue; main = p.left - c.right; ortho = Math.abs(py - cy); }
        if (main < 0) main = 0; // overlapping rects: treat as adjacent

        overlap = vertical
          ? rangesOverlap(c.left, c.right, p.left, p.right)
          : rangesOverlap(c.top, c.bottom, p.top, p.bottom);

        if (pass === 0 && !overlap) continue;            // same column/row only
        if (pass === 1 && ortho > main + 4) continue;    // 45-degree cone

        var score = main + ortho * (pass === 2 ? 5 : 1.5);
        if (score < bestScore) { bestScore = score; best = el; }
      }
      if (best) return best;
    }
    return null;
  }

  function pickInitial() {
    // closest element to the viewport center
    var cands = candidates();
    var cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    var best = null, bestD = Infinity;
    for (var i = 0; i < cands.length; i++) {
      var p = rect(cands[i]);
      var d = Math.abs(p.left + p.width / 2 - cx) + Math.abs(p.top + p.height / 2 - cy);
      if (d < bestD) { bestD = d; best = cands[i]; }
    }
    return best;
  }

  function setCurrent(el) {
    if (current) current.classList.remove('__adnav_focus');
    current = el;
    if (current) {
      current.classList.add('__adnav_focus');
      try {
        current.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      } catch (e) { current.scrollIntoView(); }
    }
  }

  // ---------- scroll fallback ----------
  // If no element exists in the pressed direction, scroll the page instead,
  // then retry. This is how you reach the very top/bottom of long pages and
  // virtualized lists whose offscreen items are not in the DOM yet.
  function scrollContainerFor(el) {
    var node = el ? el.parentElement : null;
    while (node && node !== document.body) {
      var s = window.getComputedStyle(node);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') &&
          node.scrollHeight > node.clientHeight + 8) {
        return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function scrollFallback(dir) {
    if (dir !== 'up' && dir !== 'down') return;
    var sc = scrollContainerFor(current);
    var before = sc.scrollTop;
    var delta = Math.round(window.innerHeight * 0.5) * (dir === 'up' ? -1 : 1);
    try { sc.scrollBy({ top: delta, behavior: 'smooth' }); }
    catch (e) { sc.scrollTop += delta; }
    setTimeout(function () {
      // retry after the scroll settled; new elements may have appeared
      var next = findNext(dir);
      if (next) setCurrent(next);
      else if (sc.scrollTop === before && !current) setCurrent(pickInitial());
    }, 380);
  }

  function isTextInput(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      var t = (el.type || 'text').toLowerCase();
      return ['text', 'password', 'email', 'search', 'number', 'tel', 'url'].indexOf(t) >= 0;
    }
    return el.isContentEditable;
  }

  function activate(el) {
    if (!el) return;
    if (isTextInput(el)) { el.focus(); return; } // focus input -> on-screen keyboard
    el.focus({ preventScroll: true });
    el.click(); // triggers React onClick handlers
  }

  var KEYMAP = {
    'ArrowLeft': 'left', 'ArrowRight': 'right',
    'ArrowUp': 'up', 'ArrowDown': 'down'
  };

  window.addEventListener('keydown', function (ev) {
    var dir = KEYMAP[ev.key];
    var active = deepActiveElement();

    // While typing in a text field: left/right move the caret,
    // up/down leave the field and resume navigation.
    if (isTextInput(active)) {
      if (dir === 'left' || dir === 'right') return;
      if (ev.key === 'Enter') return; // let forms handle Enter
      if (dir === 'up' || dir === 'down') active.blur();
    }

    if (dir) {
      ev.preventDefault();
      ev.stopPropagation();
      var next = findNext(dir);
      if (next) setCurrent(next);
      else if (!current) setCurrent(pickInitial());
      else scrollFallback(dir);
      return;
    }

    if (ev.key === 'Enter') {
      if (!current) { setCurrent(pickInitial()); return; }
      ev.preventDefault();
      ev.stopPropagation();
      activate(current);
    }
  }, true); // capture phase: run before the app's own key handlers

  // SPA route changes / dialogs: if the highlighted element disappears,
  // pick a fresh one so the highlight never gets "lost". Shadow roots get the
  // same treatment as they are discovered, so panels that re-render internally
  // (the settings UI switching tabs) don't strand the highlight either.
  var mo = new MutationObserver(function () {
    if (current && !isVisible(current)) setCurrent(pickInitial());
  });

  function observe(root) {
    if (!mo || !root || root.__adnav_observed) return;
    root.__adnav_observed = true;
    mo.observe(root, { childList: true, subtree: true });
  }

  observe(document.documentElement);

  // initial highlight once the page settles
  setTimeout(function () { if (!current) setCurrent(pickInitial()); }, 800);
})();
