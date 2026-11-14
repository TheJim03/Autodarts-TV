// Lays the page out at a TV-appropriate width.
//
// A 1080p TV reports density 320, which gives a WebView 960x540 CSS pixels: a
// phone-sized canvas blown up 2x. Autodarts Play then shows its narrow layout
// (no friends column, two cards per screen), and its user drawer — 726px tall,
// not scrollable — loses Logout and the language picker off the bottom edge.
// 1280x720 is the size web UIs for televisions are designed around: the desktop
// layout appears, the drawer fits, and text is still large from a sofa.
//
// Done by rewriting the page's own <meta name="viewport"> rather than natively:
// a WebView takes its scale from the real display and ignores a density
// override on its Context (tried on a SHIELD, Android 11, WebView 157).
// Requires settings.useWideViewPort = true, which MainActivity sets.
//
// Injected at document_start, before the meta tag exists, hence the observer.
(function () {
  'use strict';
  if (window.__tvViewport) return;
  window.__tvViewport = true;

  var LAYOUT_WIDTH = 1280;
  var CONTENT = 'width=' + LAYOUT_WIDTH;

  function apply() {
    var meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return false;
    if (meta.getAttribute('content') !== CONTENT) meta.setAttribute('content', CONTENT);
    return true;
  }

  // Never widen a screen that is already at least this wide in CSS pixels.
  if (window.screen && Math.max(screen.width, screen.height) >= LAYOUT_WIDTH) return;

  apply();
  // Catches the tag being parsed, and the page putting its own value back.
  // Observed on `document`, not documentElement: this runs so early that
  // <html> may not exist yet, and observing null throws.
  new MutationObserver(apply).observe(document, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['content']
  });
  document.addEventListener('DOMContentLoaded', apply);
})();
