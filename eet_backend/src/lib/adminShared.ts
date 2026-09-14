/**
 * The parts every admin page shares: the stylesheet, the login gate, the
 * authenticated fetch helper, and the menu that switches between pages.
 *
 * Both pages are assembled by `adminShell`, so the login and the menu exist in
 * exactly one place. That matters more than it looks: the password is held in
 * `localStorage` and re-validated on every page load, and the menu navigates
 * with plain links (which reload the page). If the two pages each grew their
 * own copy of the auth scaffolding, switching pages would sooner or later log
 * the operator out — or worse, a fix to one would silently miss the other.
 *
 * No build step, no framework: this is a template string, like the pages.
 */

export type AdminPageId = "overview" | "config";

const PAGES: { id: AdminPageId; href: string; label: string }[] = [
  { id: "overview", href: "/admin", label: "Přehled" },
  { id: "config", href: "/admin/config", label: "Nastavení" },
];

export const ADMIN_STYLES = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    margin: 0; padding: 1.5rem 1rem 3rem;
    max-width: 64rem; margin-inline: auto;
    line-height: 1.5;
  }
  h1 { font-size: 1.3rem; margin: 0 0 0.4rem; }
  .hidden { display: none !important; }

  #login { max-width: 20rem; margin: 4rem auto; text-align: center; }
  #login input {
    width: 100%; padding: 0.5rem; font-size: 1rem; margin-bottom: 0.75rem;
    border: 1px solid light-dark(#bbb, #555); border-radius: 0.3rem;
    background: light-dark(#fff, #222); color: inherit;
  }
  .error { color: light-dark(#b00020, #ff6b6b); font-size: 0.9rem; }
  .ok { color: light-dark(#0a7a3d, #5ddc93); font-size: 0.9rem; }

  header { margin-bottom: 1.25rem; }
  .topline { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  nav { display: flex; gap: 0.5rem; margin-top: 0.6rem; }
  nav a {
    padding: 0.35rem 0.8rem; font-size: 0.9rem; border-radius: 0.3rem; text-decoration: none;
    border: 1px solid light-dark(#bbb, #555); background: light-dark(#f3f3f3, #2a2a2a);
    color: inherit;
  }
  nav a:hover { background: light-dark(#e6e6e6, #333); }
  nav a.active {
    background: light-dark(#d8e8ff, #14406e); border-color: light-dark(#7aa7e0, #3d6ea8);
    font-weight: 600;
  }

  button {
    padding: 0.4rem 0.9rem; font-size: 0.9rem; border-radius: 0.3rem;
    border: 1px solid light-dark(#bbb, #555); background: light-dark(#f3f3f3, #2a2a2a);
    color: inherit; cursor: pointer;
  }
  button:hover { background: light-dark(#e6e6e6, #333); }
  button:disabled { opacity: 0.5; cursor: default; }

  section { margin-bottom: 1.5rem; }
  h2 { font-size: 1rem; margin: 0 0 0.6rem; }
  #fioStatus p { margin: 0.2rem 0; font-size: 0.9rem; }
  .hint { font-size: 0.8rem; opacity: 0.75; margin: 0 0 0.75rem; }

  .filters { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: end; margin-bottom: 0.75rem; }
  .filters label { display: flex; flex-direction: column; font-size: 0.8rem; gap: 0.2rem; }
  .filters input, .filters select {
    padding: 0.3rem; border: 1px solid light-dark(#bbb, #555); border-radius: 0.3rem;
    background: light-dark(#fff, #222); color: inherit;
  }

  .field { display: flex; flex-direction: column; gap: 0.2rem; margin-bottom: 0.9rem; max-width: 32rem; }
  .field > span.label { font-size: 0.85rem; font-weight: 600; }
  .field input[type="text"], .field input[type="password"], .field input[type="number"], .field select {
    padding: 0.4rem; border: 1px solid light-dark(#bbb, #555); border-radius: 0.3rem;
    background: light-dark(#fff, #222); color: inherit; font-size: 0.95rem;
  }
  .field .source { font-size: 0.75rem; opacity: 0.75; }
  .field .source.from-config { opacity: 1; color: light-dark(#0a55a8, #7ab4ff); font-weight: 600; }
  .checkline { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.9rem; font-size: 0.95rem; }

  table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid light-dark(#ddd, #333); white-space: nowrap; }
  th { font-weight: 600; }
  tbody tr:hover { background: light-dark(#f7f7f7, #262626); }
  #rowsTableWrap, #ordersTableWrap { overflow-x: auto; }

  code { background: light-dark(#eee, #333); padding: 0.1rem 0.3rem; border-radius: 0.2rem; }
`;

/**
 * The shared half of every page's script: token storage, the authenticated
 * fetch helper, the login gate, and the auto-login from a stored token.
 *
 * A page hooks itself in through `window.eetOnShown`, called whenever the
 * dashboard becomes visible (after a fresh login or an automatic one), and
 * uses `window.eetAdmin.authFetch` for its data calls so the 401 handling and
 * the credential never get re-implemented per page.
 */
const ADMIN_SCRIPT = `
(function () {
  var STORAGE_KEY = "eet_admin_token";

  var loginEl = document.getElementById("login");
  var dashEl = document.getElementById("dashboard");
  var pwInput = document.getElementById("pw");
  var loginBtn = document.getElementById("loginBtn");
  var loginError = document.getElementById("loginError");
  var logoutBtn = document.getElementById("logoutBtn");

  function getToken() {
    return localStorage.getItem(STORAGE_KEY) || "";
  }

  function authFetch(path, opts) {
    opts = opts || {};
    var headers = {};
    for (var k in opts.headers || {}) headers[k] = opts.headers[k];
    headers["Authorization"] = "Bearer " + getToken();
    opts.headers = headers;
    return fetch(path, opts);
  }

  function showDashboard() {
    loginEl.classList.add("hidden");
    dashEl.classList.remove("hidden");
  }

  function showLogin(message) {
    dashEl.classList.add("hidden");
    loginEl.classList.remove("hidden");
    if (message) {
      loginError.textContent = message;
      loginError.classList.remove("hidden");
    } else {
      loginError.classList.add("hidden");
    }
  }

  function tryLogin(token) {
    return fetch("/fio/status", { headers: { Authorization: "Bearer " + token } }).then(function (res) {
      if (res.status === 401) return false;
      if (!res.ok) throw new Error("HTTP " + res.status);
      localStorage.setItem(STORAGE_KEY, token);
      return true;
    });
  }

  function onShown() {
    if (typeof window.eetOnShown === "function") window.eetOnShown();
  }

  loginBtn.addEventListener("click", function () {
    var token = pwInput.value.trim();
    if (!token) return;
    loginBtn.disabled = true;
    tryLogin(token)
      .then(function (ok) {
        loginBtn.disabled = false;
        if (ok) {
          pwInput.value = "";
          showDashboard();
          onShown();
        } else {
          showLogin("Špatné heslo.");
        }
      })
      .catch(function (err) {
        loginBtn.disabled = false;
        showLogin("Chyba spojení: " + err.message);
      });
  });

  pwInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") loginBtn.click();
  });

  logoutBtn.addEventListener("click", function () {
    localStorage.removeItem(STORAGE_KEY);
    showLogin();
  });

  window.eetAdmin = { authFetch: authFetch, showLogin: showLogin };

  var saved = getToken();
  if (saved) {
    tryLogin(saved)
      .then(function (ok) {
        if (ok) { showDashboard(); onShown(); } else { localStorage.removeItem(STORAGE_KEY); showLogin(); }
      })
      .catch(function () { showLogin(); });
  } else {
    showLogin();
  }
})();
`;

export type AdminPageSpec = {
  /** Browser tab title. */
  title: string;
  /** Which menu entry to highlight. */
  active: AdminPageId;
  heading: string;
  /** Everything inside the dashboard, below the header. */
  body: string;
  /** Page-specific script, run after the shared one. */
  script: string;
};

/** Assembles a complete admin page: styles, login gate, menu, body and scripts. */
export function adminShell(page: AdminPageSpec): string {
  const menu = PAGES.map(
    (entry) => `<a href="${entry.href}"${entry.id === page.active ? ' class="active"' : ""}>${entry.label}</a>`,
  ).join("\n      ");

  return `<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${page.title}</title>
<style>${ADMIN_STYLES}</style>
</head>
<body>

<div id="login">
  <h1>EET — přihlášení</h1>
  <input id="pw" type="password" placeholder="Heslo" autocomplete="current-password" />
  <button id="loginBtn">Přihlásit</button>
  <p id="loginError" class="error hidden"></p>
</div>

<div id="dashboard" class="hidden">
  <header>
    <div class="topline">
      <h1>${page.heading}</h1>
      <button id="logoutBtn">Odhlásit</button>
    </div>
    <nav>
      ${menu}
    </nav>
  </header>

${page.body}
</div>

<script>${ADMIN_SCRIPT}</script>
<script>${page.script}</script>
</body>
</html>
`;
}
