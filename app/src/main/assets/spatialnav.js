// Spatial navigation for Autodarts TV.
// Injected by the Android WebView after page load. Survives SPA route changes
// because it lives on the document, not on a specific page.
//
// Written against Autodarts Play v2 (Tailwind + shadcn/ui on Base UI) and the
// "Tools for Autodarts" settings UI (Vue, inside a shadow root). Three facts
// about those two shape most of what follows:
//
//   - React and Vue own every element's class list and rewrite it on re-render,
//     so the highlight cannot be a class on the target. It is a separate ring
//     element laid over the target instead (see "highlight ring").
//   - Drawers, dialogs, menus and popovers mount in portals at the end of
//     <body>, far from their trigger. Geometry alone would never find them, so
//     the highlight follows real DOM focus into them (see "popups").
//   - Plenty of clickable things are bare <div class="cursor-pointer"> with no
//     role, href or tabindex (see SELECTOR).
(function () {
  'use strict';
  if (window.__adnav) return;

  // Also the hook MainActivity uses for BACK handling, and what the tests drive.
  var api = window.__adnav = { version: 2 };

  var current = null;

  // Last known screen position of the highlight. When the current element is
  // destroyed by a re-render (constant on the live match view), we re-pick the
  // nearest candidate to THIS instead of to the viewport centre, so the
  // highlight stays where the user left it instead of teleporting.
  var lastPos = null;

  // ---------- what counts as clickable ----------

  // Real controls: anything with native or ARIA semantics.
  var STRONG = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="tab"]',
    '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
    '[role="option"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
    '[role="slider"]', '[role="combobox"]', '[role="treeitem"]',
    '[onclick]', '[contenteditable="true"]', '[contenteditable=""]',
    // "Tools for Autodarts" drawer entry: a clone of a real drawer link with its
    // href stripped (v2-menu.ts) and only a JS click listener left. Its id is
    // stable across upstream versions — pin to it directly.
    '#autodarts-tools-menu-item'
  ].join(',');

  // Things that only LOOK clickable. v2 has many of these — the friend tiles on
  // the home screen are <div class="... cursor-pointer"> and nothing else — and
  // a click listener is invisible to a selector, so the cursor is the only
  // signal there is. Tailwind's class and an inline style both count.
  var HEURISTIC = '.cursor-pointer,[style*="cursor: pointer"],[style*="cursor:pointer"]';

  // Merely focusable. Often a wrapper (scroll areas, focus guards), so these
  // only count when they do not contain a better candidate.
  var FOCUS_ONLY = '[tabindex]:not([tabindex="-1"])';

  var SELECTOR = STRONG + ',' + HEURISTIC + ',' + FOCUS_ONLY;

  // Subtrees the page has explicitly taken out of play. Base UI marks everything
  // outside an open modal this way, so honouring it is what stops the D-pad
  // wandering off behind a dialog into controls the user cannot reach.
  var HIDDEN_SELECTOR = '[aria-hidden="true"],[inert]';

  // Floating surfaces. All of them render in portals.
  var POPUP_SELECTOR = [
    'dialog[open]', '[aria-modal="true"]',
    '[role="dialog"]', '[role="alertdialog"]', '[role="menu"]', '[role="listbox"]',
    '[data-slot="dialog-content"]', '[data-slot="alert-dialog-content"]',
    '[data-slot="drawer-content"]', '[data-slot="sheet-content"]',
    '[data-slot="popover-content"]', '[data-slot="dropdown-menu-content"]',
    '[data-slot="context-menu-content"]', '[data-slot="select-content"]',
    '[data-slot="combobox-content"]',
    // The live site (Base UI) names the same parts "-popup": its user drawer
    // is <div role="dialog" data-slot="drawer-popup">, with no aria-modal.
    '[data-slot="dialog-popup"]', '[data-slot="alert-dialog-popup"]',
    '[data-slot="drawer-popup"]', '[data-slot="sheet-popup"]',
    '[data-slot="popover-popup"]', '[data-slot="menu-popup"]',
    '[data-slot="select-popup"]', '[data-slot="combobox-popup"]'
  ].join(',');

  // The subset that must not be left with the D-pad: BACK closes them.
  var STRICT_POPUP_SELECTOR = [
    'dialog[open]', '[aria-modal="true"]', '[role="alertdialog"]',
    '[data-slot="dialog-content"]', '[data-slot="alert-dialog-content"]',
    '[data-slot="drawer-content"]', '[data-slot="sheet-content"]',
    '[data-slot="dialog-popup"]', '[data-slot="alert-dialog-popup"]',
    '[data-slot="drawer-popup"]', '[data-slot="sheet-popup"]'
  ].join(',');

  // ---------- shadow-DOM-aware helpers ----------
  // closest()/contains() stop at a shadow boundary, and the Tools for Autodarts
  // settings UI lives behind one, so both need a version that climbs through.

  function hostOf(node) {
    var root = node && node.getRootNode ? node.getRootNode() : null;
    return root && root.host ? root.host : null;
  }

  function deepClosest(el, selector) {
    var node = el;
    while (node) {
      var hit = node.closest ? node.closest(selector) : null;
      if (hit) return hit;
      node = hostOf(node);
    }
    return null;
  }

  function deepContains(root, el) {
    if (root === document) return true;
    var node = el;
    while (node) {
      if (root.contains(node)) return true;
      node = hostOf(node);
    }
    return false;
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

  function centreOf(el) {
    var r = rect(el);
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  // ---------- clipping ----------
  // An element can sit inside the viewport's coordinates and still not be on
  // screen: scrolled out of a panel, or past the edge of a carousel. v2 keeps
  // its header fixed and scrolls an inner container, so content that has been
  // scrolled away ends up with coordinates *underneath the header*. Geometry
  // that ignores this picks targets, draws rings and measures directions
  // against things nobody can see.

  /** The ancestors that cut off what is drawn outside them. */
  function clipAncestorsOf(el) {
    var out = [];
    var node = el;
    while (node && node !== document.body && node !== document.documentElement) {
      var s = window.getComputedStyle(node);
      if (node !== el) {
        var x = s.overflowX !== 'visible', y = s.overflowY !== 'visible';
        if (x || y) out.push({ node: node, x: x, y: y });
      }
      // position:fixed leaves every scroll container behind.
      if (s.position === 'fixed') break;
      node = node.parentElement || hostOf(node);
    }
    return out;
  }

  /** The window those ancestors leave open, in viewport coordinates. */
  function clipRectFrom(ancestors) {
    var c = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    for (var i = 0; i < ancestors.length; i++) {
      var r = ancestors[i].node.getBoundingClientRect();
      if (ancestors[i].x) { c.left = Math.max(c.left, r.left); c.right = Math.min(c.right, r.right); }
      if (ancestors[i].y) { c.top = Math.max(c.top, r.top); c.bottom = Math.min(c.bottom, r.bottom); }
    }
    return c;
  }

  function clipRect(el) { return clipRectFrom(clipAncestorsOf(el)); }

  function outside(r, c) {
    return r.bottom <= c.top || r.top >= c.bottom || r.right <= c.left || r.left >= c.right;
  }

  // ---------- visibility ----------

  function isDisabled(el) {
    return el.disabled === true || el.getAttribute('aria-disabled') === 'true';
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    var s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (parseFloat(s.opacity) < 0.05) return false;
    // Tailwind's pointer-events-none is how v2 parks controls that are present
    // but not usable; a click there goes straight through to what is behind.
    if (s.pointerEvents === 'none') return false;
    if (isDisabled(el)) return false;
    // Checked per keypress rather than cached: pages toggle aria-hidden and
    // inert dynamically (modal open/close) without changing the DOM structure.
    if (deepClosest(el, HIDDEN_SELECTOR)) return false;
    return true;
  }

  // ---------- structural candidates ----------

  /** Cheap "could this be used at all" test, without getComputedStyle. */
  function usable(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    if (isDisabled(el)) return false;
    return !el.closest(HIDDEN_SELECTOR);
  }

  /**
   * Decide whether a matching element is a real stop, or just packaging around
   * (or inside) one.
   *
   *  - focus-only wrapper, or cursor-pointer wrapper, with a usable candidate
   *    inside: the inner one is the stop.
   *  - cursor-pointer element inside a real control (<button><span
   *    class="cursor-pointer">): the control is the stop.
   *  - real control whose inside is mostly ANOTHER real control (<a><button>,
   *    or Base UI's <span role="button"> around a <button>): one stop, the
   *    inner one. A card with a small button in its corner stays two stops.
   *
   * Only usable inner elements count. Base UI renders a hidden <input> next to
   * or inside its switches and checkboxes, and counting that would hide the
   * very control the user is trying to reach.
   */
  function isStop(el) {
    var strong = el.matches(STRONG);
    if (!strong && el.matches(HEURISTIC) && el.parentElement && el.parentElement.closest(STRONG)) {
      return false;
    }
    var inner = el.querySelectorAll(strong ? STRONG : SELECTOR);
    if (!inner.length) return true;

    if (!strong) {
      for (var i = 0; i < inner.length; i++) if (usable(inner[i])) return false;
      return true;
    }
    var r = el.getBoundingClientRect();
    var area = r.width * r.height;
    if (area <= 0) return true;
    for (var j = 0; j < inner.length; j++) {
      if (!usable(inner[j])) continue;
      var q = inner[j].getBoundingClientRect();
      if (q.width * q.height >= area * 0.6) return false;
    }
    return true;
  }

  /**
   * Collect stops from a root, descending into every open shadow root on the
   * way down. That descent is what makes the "Tools for Autodarts" settings
   * panel reachable at all: it mounts via createShadowRootUi() under
   * <autodarts-tools-wxt>, and a plain querySelectorAll() sees nothing in it.
   */
  function collectDeep(root, out) {
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.shadowRoot) {
        observe(el.shadowRoot);
        collectDeep(el.shadowRoot, out);
      }
      if (!el.matches || !el.matches(SELECTOR)) continue;
      if (isStop(el)) out.push(el);
    }
  }

  // Holding the D-pad fires keydown every ~50ms. Only the structural part is
  // cached; visibility and geometry are re-read on every keypress, so scrolling
  // and show/hide stay exact.
  var cache = null;
  var cacheScope = null;
  var cacheTime = 0;
  var dirty = true;

  var CACHE_MAX_MS = 400;  // hard refresh even if nothing reported a mutation
  var CACHE_MIN_MS = 80;   // floor: never rebuild twice within one key repeat

  function structuralCandidates(scope) {
    var now = Date.now();
    var age = now - cacheTime;
    if (cache && cacheScope === scope) {
      if (age < CACHE_MIN_MS) return cache;
      if (!dirty && age < CACHE_MAX_MS) return cache;
    }
    var out = [];
    collectDeep(scope, out);
    cache = out;
    cacheScope = scope;
    cacheTime = now;
    dirty = false;
    return out;
  }

  // ---------- scopes ----------

  /**
   * When a modal is open, navigation must not escape it. Returns the innermost
   * open modal, or `document`.
   */
  function activeScope() {
    var explicit = null;
    var modals = document.querySelectorAll('dialog[open],[aria-modal="true"]');
    for (var i = modals.length - 1; i >= 0; i--) {
      if (isVisible(modals[i])) { explicit = modals[i]; break; }
    }
    var cover = screenCover();
    // A cover that merely wraps the declared modal (backdrop + dialog) adds
    // nothing; the dialog itself is the tighter scope.
    if (cover && explicit && deepContains(cover, explicit)) return explicit;
    return cover || explicit || document;
  }

  /** elementFromPoint that keeps going through shadow roots. */
  function deepElementFromPoint(x, y) {
    var root = document, el = null;
    for (var depth = 0; depth < 8; depth++) {
      var hit;
      try { hit = root.elementFromPoint(x, y); } catch (e) { break; }
      if (!hit || hit === el) break;
      el = hit;
      if (!hit.shadowRoot) break;
      root = hit.shadowRoot;
    }
    return el;
  }

  /**
   * A modal that does not say it is one: whatever fixed, screen-filling layer
   * is on top in the middle of the screen.
   *
   * The Tools for Autodarts dialogs are plain <div class="fixed inset-0"> with
   * no role or aria-modal, and they live in a shadow root where the query above
   * cannot see them anyway. Occlusion testing alone does not contain them: a
   * control far below the fold is not "covered" by anything until selecting it
   * scrolls it up — behind the dialog. So the layer itself becomes the scope.
   * If the layer is just the app's own full-screen shell, everything is inside
   * it and nothing changes.
   */
  function screenCover() {
    var node = deepElementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    while (node && node !== document.body && node !== document.documentElement) {
      if (window.getComputedStyle(node).position === 'fixed') {
        var r = node.getBoundingClientRect();
        // Only a layer with something to select in it. A bare backdrop is
        // fixed and screen-filling too, but its dialog is a SIBLING — scoping
        // to the backdrop would leave nothing to navigate at all.
        if (r.width >= window.innerWidth * 0.9 && r.height >= window.innerHeight * 0.9 &&
            node.querySelector(SELECTOR)) return node;
      }
      node = node.parentElement || hostOf(node);
    }
    return null;
  }

  function popupOf(el) { return el ? deepClosest(el, POPUP_SELECTOR) : null; }

  /**
   * Visible candidates inside `within` (a popup, or null for the whole scope).
   * `excluded` are elements already rejected in this search.
   */
  function candidates(within, excluded) {
    var all = structuralCandidates(activeScope());
    var out = [];
    // Cheap geometry cull BEFORE the expensive check. isVisible() calls
    // getComputedStyle(), which dominates the cost of a keypress on a long
    // page. Anything more than 1.5 viewports away is not a sensible jump
    // target, and the scroll fallback only moves half a viewport at a time, so
    // nothing becomes unreachable.
    var bandY = window.innerHeight * 1.5;
    var bandX = window.innerWidth * 1.5;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el === current) continue;
      if (excluded && excluded.indexOf(el) >= 0) continue;
      if (within && !deepContains(within, el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.bottom < -bandY || r.top > window.innerHeight + bandY) continue;
      if (r.right < -bandX || r.left > window.innerWidth + bandX) continue;
      if (isVisible(el)) out.push(el);
    }
    return out;
  }

  /**
   * True if something else is painted on top of the element's centre — an
   * overlay, toast or sticky header. Landing there looks like the remote
   * stopped responding, because the click goes to whatever is on top. Only ever
   * run on a winning candidate, never across the list: hit-testing forces
   * layout. (The highlight ring is pointer-events:none, so it never shows up.)
   */
  function isOccluded(el) {
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2;
    var y = r.top + r.height / 2;
    // Off-screen: nothing meaningful to hit-test against, so allow it — this is
    // how "down" into not-yet-scrolled content keeps working.
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
    // Scrolled out of its container: whatever is at those coordinates is not
    // covering it, it is simply somewhere else. Selecting it scrolls it back.
    var c = clipRect(el);
    if (x < c.left || x > c.right || y < c.top || y > c.bottom) return false;
    // Hit-test in the element's own tree, working inwards. From the document a
    // shadow root is opaque — elementsFromPoint reports the host and stops — so
    // a backdrop INSIDE the Tools for Autodarts settings UI (its "what's new"
    // dialog has no dialog role to go by) would cover nothing as far as the
    // document can tell. Each shadow root can answer for itself.
    var root = document;
    for (var depth = 0; depth < 8; depth++) {
      var stack;
      try { stack = root.elementsFromPoint(x, y); } catch (e) { return false; }
      if (!stack || !stack.length) return false;
      var top = stack[0];
      if (top === el) return false;
      if (el.contains && el.contains(top)) return false;
      if (top.contains && top.contains(el)) return false;
      // The host of a shadow tree the element is in: ask that tree next.
      if (top.shadowRoot && deepContains(top, el)) { root = top.shadowRoot; continue; }
      return true;
    }
    return false;
  }

  // ---------- direction search ----------
  // Three passes, strict to loose. This is what makes "up" really go UP:
  //   pass 0: candidate overlaps current on the orthogonal axis
  //           (same column for up/down, same row for left/right)
  //   pass 1: candidate lies within a 45-degree cone in that direction
  //   pass 2: anything in the half-plane (last resort, heavy ortho penalty)

  function rangesOverlap(a1, a2, b1, b2) {
    return Math.min(a2, b2) - Math.max(a1, b1) > 0;
  }

  /**
   * Where a move starts from: the current element's rect, pulled back inside
   * what is actually visible of it.
   *
   * Pressing down on a page with a long stretch of plain text scrolls the
   * highlight off the top. Measured from its real position — by then far above
   * the screen — the fixed header counts as "below" it, and the highlight
   * jumped there and could never get back down. Starting from the edge it left
   * through keeps "down" meaning down.
   */
  function originRect(dir) {
    var r = rect(current);
    var c = clipRect(current);
    var o = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    // Only ever pull the origin FORWARD, to the edge it was left behind at.
    // Pulling back an element that lies ahead of the screen (a drawer taller
    // than the TV: its last entries sit below the bottom edge and nothing
    // scrolls) would put it behind things it is actually past, and "down"
    // would bounce back up.
    if (dir === 'down' && r.bottom <= c.top) { o.top = o.bottom = c.top; }
    if (dir === 'up' && r.top >= c.bottom) { o.top = o.bottom = c.bottom; }
    if (dir === 'right' && r.right <= c.left) { o.left = o.right = c.left; }
    if (dir === 'left' && r.left >= c.right) { o.left = o.right = c.right; }
    o.width = o.right - o.left;
    o.height = o.bottom - o.top;
    return o;
  }

  function searchOnce(dir, cands) {
    var c = originRect(dir);
    var cx = c.left + c.width / 2, cy = c.top + c.height / 2;
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

        // Centre distance is a tiebreaker, not a driver: rects that overlap in
        // the travel direction all collapse to main === 0, and without this
        // the winner among them is arbitrary.
        var centre = vertical ? Math.abs(py - cy) : Math.abs(px - cx);
        var score = main + ortho * (pass === 2 ? 5 : 1.5) + centre * 0.15;
        if (score < bestScore) { bestScore = score; best = el; }
      }
      if (best) return best;
    }
    return null;
  }

  /** searchOnce, skipping winners that turn out to sit behind something. */
  function searchIn(dir, within) {
    var excluded = [];
    // Bounded so a page that covers everything can never spin here.
    for (var attempt = 0; attempt < 6; attempt++) {
      var el = searchOnce(dir, candidates(within, excluded));
      if (!el) return null;
      if (!isOccluded(el)) return el;
      excluded.push(el);
    }
    return null;
  }

  function findNext(dir) {
    var scope = activeScope();
    if (!current || !isVisible(current) || !deepContains(scope, current)) {
      // setCurrent(null), not `current = null`: the ring has to go too.
      setCurrent(null);
      return (scope !== document && pickFirst(scope)) || pickNear(lastPos);
    }
    // Inside a popup, stay inside it while there is somewhere to go. A menu or
    // popover may be left once its edge is reached; a drawer or dialog may not.
    var popup = popupOf(current);
    if (popup && popup !== scope) {
      var inside = searchIn(dir, popup);
      if (inside) return inside;
      if (popup.matches(STRICT_POPUP_SELECTOR)) return null;
    }
    return searchIn(dir, null);
  }

  /** Nearest candidate to a screen point; falls back to the viewport centre. */
  function pickNear(pos, within) {
    var cands = candidates(within || null);
    var cx = pos ? pos.x : window.innerWidth / 2;
    var cy = pos ? pos.y : window.innerHeight / 2;
    var best = null, bestD = Infinity;
    for (var i = 0; i < cands.length; i++) {
      var p = rect(cands[i]);
      var d = Math.abs(p.left + p.width / 2 - cx) + Math.abs(p.top + p.height / 2 - cy);
      if (d < bestD && !isOccluded(cands[i])) { bestD = d; best = cands[i]; }
    }
    return best;
  }

  /**
   * First candidate in reading order — the predictable place to start on a new
   * screen or inside a freshly opened popup. On a full page this prefers the
   * content area over the header, so the highlight lands on the first game
   * mode rather than on the logo.
   */
  function pickFirst(within, contentOnly) {
    var pools = [];
    if (!within || within === document) {
      var main = document.querySelector('#root main, main, [role="main"]');
      if (main) pools.push(candidates(main));
      if (!main || !contentOnly) pools.push(candidates(null));
    } else {
      pools.push(candidates(within));
    }
    for (var p = 0; p < pools.length; p++) {
      var best = null, bestKey = Infinity;
      for (var i = 0; i < pools[p].length; i++) {
        var el = pools[p][i];
        var r = rect(el);
        if (r.bottom <= 0 || r.top >= window.innerHeight) continue;
        if (r.right <= 0 || r.left >= window.innerWidth) continue;
        // Rows first (in 24px bands, so slightly staggered items still read as
        // one row), then left to right.
        var key = Math.round(Math.max(r.top, 0) / 24) * 10000 + Math.max(r.left, 0);
        if (key < bestKey && !isOccluded(el)) { bestKey = key; best = el; }
      }
      if (best) return best;
    }
    return null;
  }

  // ---------- highlight ring ----------
  // A separate element laid over the target, not a class on it:
  //   - React/Vue rewrite className on re-render and would silently drop it;
  //   - the old rule had to set position:relative, which un-positions anything
  //     absolute — shadcn's dialog close buttons, for a start;
  //   - cards with overflow-hidden clip an outline or shadow drawn on a child;
  //   - a shadow root needs its own copy of every style.
  // The ring sits on <html>, outside anything a framework renders into, and is
  // pointer-events:none so it can never eat a click or show up in hit tests.

  var RING_PAD = 3;

  var style = document.createElement('style');
  style.id = '__adnav_style';
  style.textContent =
    '@keyframes __adnav_pulse {' +
    '  0%,100% { box-shadow: 0 0 0 1px rgba(0,0,0,.55), 0 0 10px 3px rgba(255,255,255,.55); }' +
    '  50%     { box-shadow: 0 0 0 1px rgba(0,0,0,.55), 0 0 18px 6px rgba(255,255,255,.8); }' +
    '}' +
    '#__adnav_ring {' +
    '  position: fixed; left: 0; top: 0; margin: 0; padding: 0;' +
    '  box-sizing: border-box; pointer-events: none; display: none;' +
    '  border: 2px solid rgba(255,255,255,.95); border-radius: 8px;' +
    '  animation: __adnav_pulse 1.6s ease-in-out infinite;' +
    '  z-index: 2147483647;' +
    '}';
  (document.head || document.documentElement).appendChild(style);

  var ring = document.createElement('div');
  ring.id = '__adnav_ring';
  ring.setAttribute('aria-hidden', 'true');
  document.documentElement.appendChild(ring);

  var ringKey = '';
  // Clipping ancestors of the current target, refreshed when it changes and on
  // the slow tick — walking the ancestor chain every frame would be wasteful.
  var ringClip = [];

  /** Match the target's corner shape, so pills and avatars get a round ring. */
  function ringRadius(el) {
    var s = window.getComputedStyle(el);
    var corners = [s.borderTopLeftRadius, s.borderTopRightRadius,
                   s.borderBottomRightRadius, s.borderBottomLeftRadius];
    var out = [];
    for (var i = 0; i < corners.length; i++) {
      var v = corners[i] || '0px';
      if (v.indexOf('%') >= 0) { out.push(v.split(' ')[0]); continue; }
      var px = parseFloat(v) || 0;
      out.push(Math.max(px + RING_PAD, 6) + 'px');
    }
    return out.join(' ');
  }

  /**
   * Put the ring where the target currently is. `glide` animates the move and
   * is only for a deliberate jump: while FOLLOWING a target (scroll, layout
   * shift) the ring must stick to it exactly, not trail behind.
   */
  function updateRing(glide) {
    if (!ring.isConnected) document.documentElement.appendChild(ring);
    if (!current || !current.isConnected) {
      if (ringKey !== '') { ring.style.display = 'none'; ringKey = ''; }
      return;
    }
    var r = current.getBoundingClientRect();
    // Off screen, or scrolled out of its container: no ring. Without the second
    // half it would be painted over the header as content scrolls beneath it.
    var offscreen = r.width < 1 || r.height < 1 || outside(r, clipRectFrom(ringClip));
    if (offscreen) {
      if (ringKey !== '') { ring.style.display = 'none'; ringKey = ''; }
      return;
    }
    var key = r.left + ',' + r.top + ',' + r.width + ',' + r.height;
    if (key === ringKey) return;
    var wasHidden = (ringKey === '');
    ringKey = key;
    ring.style.transition = (glide && !wasHidden)
      ? 'transform .09s ease-out, width .09s ease-out, height .09s ease-out'
      : 'none';
    ring.style.transform = 'translate(' + (r.left - RING_PAD) + 'px,' + (r.top - RING_PAD) + 'px)';
    ring.style.width = (r.width + RING_PAD * 2) + 'px';
    ring.style.height = (r.height + RING_PAD * 2) + 'px';
    ring.style.display = 'block';
  }

  // Follow the target for a short while after anything that can move it. The
  // ring is purely visual — navigation always measures the real element — so a
  // late frame here costs a flicker at worst, never a wrong jump.
  var followUntil = 0;
  var rafId = 0;

  function tick() {
    rafId = 0;
    updateRing(false);
    if (Date.now() < followUntil) rafId = window.requestAnimationFrame(tick);
  }

  function follow(ms) {
    followUntil = Math.max(followUntil, Date.now() + (ms || 600));
    if (!rafId) rafId = window.requestAnimationFrame(tick);
  }

  window.addEventListener('scroll', function () { follow(400); }, { capture: true, passive: true });
  window.addEventListener('resize', function () { follow(400); });
  document.addEventListener('transitionend', function () { follow(200); }, true);
  document.addEventListener('animationend', function () { follow(200); }, true);
  // Safety net for moves nothing announced, and for when the WebView is not
  // painting (requestAnimationFrame is paused in the background).
  setInterval(function () {
    if (current && current.isConnected) ringClip = clipAncestorsOf(current);
    updateRing(false);
  }, 500);

  /** False if any part of the element is cut off or off screen. */
  function isFullyShown(el) {
    var r = el.getBoundingClientRect();
    var c = clipRect(el);
    return r.left >= c.left - 1 && r.right <= c.right + 1 &&
           r.top >= c.top - 1 && r.bottom <= c.bottom + 1;
  }

  // Whether the highlight was last inside a popup; see the re-render handling.
  var wasInPopup = false;

  function setCurrent(el) {
    current = el || null;
    if (current) {
      wasInPopup = !!popupOf(current);
      if (!isFullyShown(current)) {
        try {
          // Instant, NOT smooth: a smooth scroll is still animating when the
          // next D-pad repeat arrives, and every rect read mid-animation is
          // against stale geometry. And centred, not 'nearest': v2 keeps a bar
          // pinned to the top of the screen, and 'nearest' parks the target
          // flush against the edge — underneath it.
          current.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        } catch (e) {
          try { current.scrollIntoView({ block: 'center', inline: 'center' }); }
          catch (e2) { current.scrollIntoView(); }
        }
      }
      lastPos = centreOf(current);
      ring.style.borderRadius = ringRadius(current);
      ringClip = clipAncestorsOf(current);
    } else {
      ringClip = [];
    }
    updateRing(true);
    follow(600);
  }

  // ---------- scroll fallback ----------
  // If no element exists in the pressed direction, scroll instead, then retry.
  // This is how you reach the very top/bottom of long pages and virtualized
  // lists whose offscreen items are not in the DOM yet.

  function canScroll(node, vertical) {
    if (!node) return false;
    return vertical
      ? node.scrollHeight > node.clientHeight + 8
      : node.scrollWidth > node.clientWidth + 8;
  }

  function scrollContainerFor(el, vertical) {
    // From the element itself: a focusable scroll area can BE the highlight.
    var node = el;
    while (node && node !== document.body && node !== document.documentElement) {
      var s = window.getComputedStyle(node);
      var flow = vertical ? s.overflowY : s.overflowX;
      if ((flow === 'auto' || flow === 'scroll') && canScroll(node, vertical)) return node;
      node = node.parentElement || hostOf(node);
    }
    var root = document.scrollingElement || document.documentElement;
    // Only hand back the document if it actually scrolls on this axis. Without
    // this check, pressing right at the last element of a row shoves the whole
    // page sideways on a layout that has no horizontal overflow at all.
    if (canScroll(root, vertical)) return root;
    // v2 does not scroll the document at all: the header is fixed and the
    // content scrolls inside <main>. From the header there is no scrollable
    // ancestor, so "down" with nothing in range has to find that container
    // itself — but never from inside a popup, which must not scroll the page
    // behind it.
    return popupOf(el) ? null : mainScroller(vertical);
  }

  /** The biggest scrollable box in the content area. */
  function mainScroller(vertical) {
    var main = document.querySelector('#root main, main, [role="main"]');
    if (!main) return null;
    var best = null, bestArea = 0;
    var nodes = [main].concat([].slice.call(main.querySelectorAll('*')));
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!canScroll(node, vertical)) continue;  // cheap, rules out nearly all
      var s = window.getComputedStyle(node);
      var flow = vertical ? s.overflowY : s.overflowX;
      if (flow !== 'auto' && flow !== 'scroll') continue;
      var r = node.getBoundingClientRect();
      var area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = node; }
    }
    return best;
  }

  function scrollFallback(dir) {
    var vertical = (dir === 'up' || dir === 'down');
    var sc = scrollContainerFor(current, vertical);
    if (!sc) return;  // nothing scrolls that way: keep the highlight put
    var beforeTop = sc.scrollTop, beforeLeft = sc.scrollLeft;

    // Instant, for the same reason setCurrent() is: the retry below must read
    // settled geometry, and a smooth scroll would still be running.
    if (vertical) {
      sc.scrollTop += Math.round(window.innerHeight * 0.5) * (dir === 'up' ? -1 : 1);
    } else {
      sc.scrollLeft += Math.round(window.innerWidth * 0.5) * (dir === 'left' ? -1 : 1);
    }
    follow(400);

    var moved = (sc.scrollTop !== beforeTop) || (sc.scrollLeft !== beforeLeft);
    if (!moved) {
      if (!current) setCurrent(pickFirst(null));
      return;
    }

    // Retry immediately (geometry is already settled), then once more later to
    // catch virtualized lists that only render their new rows asynchronously.
    var next = findNext(dir);
    if (next) { setCurrent(next); return; }
    setTimeout(function () {
      dirty = true;
      var late = findNext(dir);
      if (late) setCurrent(late);
      else if (!current) setCurrent(pickFirst(null));
    }, 250);
  }

  // ---------- activation ----------

  function isTextInput(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      var t = (el.type || 'text').toLowerCase();
      return ['text', 'password', 'email', 'search', 'number', 'tel', 'url'].indexOf(t) >= 0;
    }
    return el.isContentEditable;
  }

  /** Left/right belong to these while they are highlighted: they set a value. */
  function isSlider(el) {
    if (!el) return false;
    if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'range') return true;
    return el.getAttribute('role') === 'slider';
  }

  // Set while WE move focus, so the focusin listener below can tell our own
  // focus() calls from the page moving focus (which it should follow).
  var selfFocus = false;

  function focusQuietly(el) {
    selfFocus = true;
    try { el.focus({ preventScroll: true }); } catch (e) { /* not focusable */ }
    selfFocus = false;
  }

  // When a choice made inside a popup leads to a new screen. The popup closes
  // and the page hands focus back to its trigger up in the header — but the
  // user picked a destination (Settings, Devices, Tools for Autodarts), so the
  // highlight belongs on that screen, not back on the avatar.
  // Watched for directly rather than in the mutation handler: the URL changes
  // while the popup is still animating shut, several re-renders before the
  // new screen has anything to highlight.
  var screenWatch = null;
  // The closing popup hands focus back to its trigger a moment AFTER the new
  // screen has been picked; until this time, that hand-back is not followed.
  var ignoreFocusReturnUntil = 0;

  function followToNewScreen() {
    var from = location.href;
    var tries = 0;
    if (screenWatch) clearInterval(screenWatch);
    screenWatch = setInterval(function () {
      var done = ++tries > 30;                       // ~4.5s, then give up
      if (!done && location.href !== from && !popupOf(current) && api.overlays() === 0) {
        ignoreFocusReturnUntil = Date.now() + 2000;
        setCurrent(null);
        pickFirstSoon();
        done = true;
      }
      if (done) { clearInterval(screenWatch); screenWatch = null; }
    }, 150);
  }

  function activate(el) {
    if (!el) return;
    if (popupOf(el)) followToNewScreen();
    if (isTextInput(el)) { focusQuietly(el); return; } // focus -> on-screen keyboard
    focusQuietly(el);
    if (el.tagName === 'SELECT' && typeof el.showPicker === 'function') {
      // click() does not open a <select>; showPicker() does, and the native
      // picker it opens is D-pad navigable on its own.
      try { el.showPicker(); return; } catch (e) { /* fall through to click */ }
    }
    el.click(); // triggers React/Vue click handlers
  }

  // ---------- keys ----------

  var KEYMAP = {
    'ArrowLeft': 'left', 'ArrowRight': 'right',
    'ArrowUp': 'up', 'ArrowDown': 'down'
  };

  function move(dir) {
    var next = findNext(dir);
    if (next) setCurrent(next);
    else if (!current) setCurrent(pickFirst(null));
    else scrollFallback(dir);
  }

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

    // On a slider, left/right change the value instead of leaving it. Focus it
    // and let the key through untouched; up/down still navigate away.
    if ((dir === 'left' || dir === 'right') && isSlider(current) && isVisible(current)) {
      if (active !== current) focusQuietly(current);
      return;
    }

    if (dir) {
      ev.preventDefault();
      ev.stopPropagation();
      move(dir);
      return;
    }

    if (ev.key === 'Enter') {
      if (!current || !isVisible(current)) { setCurrent(pickNear(lastPos) || pickFirst(null)); return; }
      ev.preventDefault();
      ev.stopPropagation();
      activate(current);
    }
  }, true); // capture phase: run before the app's own key handlers

  // ---------- popups ----------
  // Base UI moves real focus into a drawer, dialog or menu when it opens, and
  // back to the trigger when it closes. Following that is the only reliable way
  // to find a popup at all: it is portalled to the end of <body> and can open
  // anywhere on screen, so geometry from the trigger says nothing about it.

  function adoptFocus(target, attempt) {
    if (!target || !target.isConnected) return;
    var popup = popupOf(target);
    if (!popup && Date.now() < ignoreFocusReturnUntil) return;
    var pick = null;
    if (target.matches && target.matches(SELECTOR) && isVisible(target)) {
      pick = target;
    } else if (popup) {
      // Focus often lands on the popup container itself, or on a hidden guard.
      pick = pickFirst(popup);
    }
    if (pick) {
      if (pick !== current) setCurrent(pick);
      return;
    }
    // Popups animate in from opacity 0, which reads as "not visible" for the
    // first few frames. Look again shortly rather than giving up.
    if (popup && attempt < 6) {
      setTimeout(function () {
        if (deepActiveElement() === target || !current || !isVisible(current)) {
          dirty = true;
          adoptFocus(target, attempt + 1);
        }
      }, 70 * (attempt + 1));
    }
  }

  window.addEventListener('focusin', function (ev) {
    if (selfFocus) return;
    var path = ev.composedPath ? ev.composedPath() : null;
    var target = (path && path[0]) || ev.target;
    if (!target || target === current || target.nodeType !== 1) return;
    adoptFocus(target, 0);
  }, true);

  // ---------- re-renders ----------
  // If the highlighted element disappears, pick a fresh one near where it was.
  // Shadow roots get the same treatment as they are discovered, so panels that
  // re-render internally (the settings UI switching tabs) don't strand it.

  var lastHref = location.href;
  var recheck = null;
  var mo = new MutationObserver(function () {
    dirty = true;
    follow(300);
    // Re-renders arrive in bursts; coalesce them instead of running a full
    // re-pick per mutation record.
    if (recheck) return;
    recheck = setTimeout(function () {
      recheck = null;
      var navigated = (location.href !== lastHref);
      lastHref = location.href;

      // Focus events are the fast path into a popup, but they are not
      // guaranteed: a document that does not hold system focus changes
      // activeElement without firing any. Every popup opening is also a DOM
      // change, so check here as well.
      var active = deepActiveElement();
      var activePopup = popupOf(active);
      if (activePopup && isVisible(activePopup) &&
          (!current || !isVisible(current) || !deepContains(activePopup, current))) {
        adoptFocus(active, 0);
        if (current && isVisible(current)) return;
      }

      var scopeNow = activeScope();
      if (scopeNow !== document && current && !deepContains(scopeNow, current)) {
        // Something modal has opened over the highlight: go to it now, rather
        // than leave the ring on a control that can no longer be reached.
        var into = pickFirst(scopeNow);
        if (into) { setCurrent(into); return; }
      }

      if (current && isVisible(current)) return;

      // The highlight was inside a popup that has just closed. The page puts
      // focus back on whatever opened it, which is exactly where the highlight
      // belongs — better than the nearest thing to where the popup used to be.
      if (wasInPopup && Date.now() >= ignoreFocusReturnUntil &&
          active && active.matches && active.matches(SELECTOR) && isVisible(active)) {
        setCurrent(active);
        return;
      }
      // Nothing was highlighted, so there is nothing to repair. Picking "the
      // nearest thing" here would mean the middle of the screen, on a page
      // that is still loading; the patient first pick does that job properly.
      if (!current && !lastPos) { if (!settle) pickFirstSoon(); return; }
      var scope = activeScope();
      // A re-render of the same screen keeps the highlight where it was; a new
      // screen starts at its first item, once that has rendered.
      if (scope !== document) { setCurrent(pickFirst(scope)); return; }
      if (navigated) { setCurrent(null); pickFirstSoon(); return; }
      var next = pickNear(lastPos) || pickFirst(null);
      if (next || current) setCurrent(next);
    }, 60);
  });

  function observe(root) {
    if (!mo || !root || root.__adnav_observed) return;
    root.__adnav_observed = true;
    mo.observe(root, { childList: true, subtree: true });
  }

  observe(document.documentElement);

  /**
   * Highlight the first item of a new screen, once it has one.
   *
   * The header renders at once and the content a beat later (data to fetch,
   * skeletons to replace), so taking "the first thing on screen" immediately
   * always lands on the header. Hold out for the content area for a moment
   * before settling for whatever is there. Any key press in the meantime picks
   * straight away, so this can never make the remote feel dead.
   */
  var settle = null;
  function pickFirstSoon() {
    if (settle) clearInterval(settle);
    var tries = 0;
    settle = setInterval(function () {
      if ((current && isVisible(current)) || ++tries > 24) {
        clearInterval(settle); settle = null; return;
      }
      dirty = true;
      var el = pickFirst(null, tries <= 8);   // ~2s for the content to show up
      if (el) { setCurrent(el); clearInterval(settle); settle = null; }
    }, 250);
  }

  pickFirstSoon();

  // ---------- API ----------

  /**
   * How many closable layers are open. MainActivity asks this on BACK — if
   * anything is open it sends a real Escape key instead of navigating, then
   * asks again to see whether that closed something. (A real key event, from
   * Kotlin: a KeyboardEvent dispatched from here would have isTrusted:false,
   * which component libraries are free to ignore.)
   */
  api.overlays = function () {
    var n = 0;
    var seen = [];
    var popups = document.querySelectorAll(POPUP_SELECTOR);
    for (var i = 0; i < popups.length; i++) {
      // Count outermost popups only: a dialog and its own content wrapper both
      // match, and are one layer.
      if (popups[i].parentElement && popups[i].parentElement.closest(POPUP_SELECTOR)) continue;
      if (isVisible(popups[i])) { n++; seen.push(popups[i]); }
    }
    // A popup inside a shadow root (the Tools for Autodarts settings UI has its
    // own dialogs) is invisible to the query above; the highlight being inside
    // one is how we know it is there.
    var own = popupOf(current);
    if (own && isVisible(own)) {
      var counted = false;
      for (var j = 0; j < seen.length; j++) if (deepContains(seen[j], own)) counted = true;
      if (!counted) n++;
    }
    // An undeclared full-screen layer counts when it actually shuts part of the
    // page out. (The app's own shell is such a layer too, with nothing outside.)
    var cover = n === 0 ? screenCover() : null;
    if (cover) {
      var all = structuralCandidates(document);
      for (var k = 0; k < all.length; k++) {
        if (!deepContains(cover, all[k]) && isVisible(all[k])) { n++; break; }
      }
      dirty = true;  // that listing was for the whole document, not the scope
    }
    return n;
  };

  api.current = function () { return current; };
  api.move = move;
  api.activate = function () { activate(current); };
  api.focus = function (el) { setCurrent(el); };
  api.candidates = function () { return candidates(null); };
  api.refresh = function () { dirty = true; cacheTime = 0; };
  api.pickFirst = function () { return pickFirst(null); };
  api.isOccluded = isOccluded;
})();
