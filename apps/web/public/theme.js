// Applies the saved theme before first paint, so the app does not flash the
// dark default on a light-theme machine.
//
// A file rather than an inline <script> in index.html: the production CSP is
// `script-src 'self'`, which blocks inline scripts with no console warning that
// names the theme — so inline, this silently did nothing in production and
// worked in dev, where Vite serves no CSP.
try {
  if (localStorage.getItem('rainver:theme') === 'light') {
    document.documentElement.classList.add('theme-light')
  }
} catch (_) {
  /* private mode, or storage disabled: the default theme is correct enough */
}
