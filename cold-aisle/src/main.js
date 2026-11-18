// ── main: the export for Node and the start-up guard ──
// Owns nothing but the hand-over, and stays the last part.  Under Node
// (module.exports exists) loading only exports CDA_API, on which every part
// has registered what tests need.  In a browser cdaInit (written by the
// page's part, the UI) runs once the document is parsed: at once when it
// already is, else on DOMContentLoaded.  The reference to cdaInit is only
// ever reached in a browser, so the file loads under Node before the page's
// part exists.  Uses every earlier part.

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CDA_API;
} else if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', cdaInit);
} else {
  cdaInit();
}
