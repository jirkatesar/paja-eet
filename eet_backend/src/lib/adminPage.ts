/**
 * GET /admin — a small dependency-free HTML/JS dashboard (no build step,
 * matches this Worker's "no framework" ethos). The shell itself is public;
 * everything it shows comes from `GET /admin/data` and `GET /fio/status`,
 * which require a Bearer token. The password field authenticates against
 * `ADMIN_PASSWORD` (a separate secret from `EET_API_TOKEN` — see
 * `checkAdminAuth` in `index.ts`) so a human never needs to handle the
 * machine-to-machine API token just to look at this page. The token is kept
 * in this browser's `localStorage` and sent as a normal `Authorization`
 * header — never in a URL.
 */
export const ADMIN_HTML = `<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>EET — přehled plateb</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    margin: 0; padding: 1.5rem 1rem 3rem;
    max-width: 64rem; margin-inline: auto;
    line-height: 1.5;
  }
  h1 { font-size: 1.3rem; margin: 0 0 1rem; }
  .hidden { display: none !important; }

  #login { max-width: 20rem; margin: 4rem auto; text-align: center; }
  #login input {
    width: 100%; padding: 0.5rem; font-size: 1rem; margin-bottom: 0.75rem;
    border: 1px solid light-dark(#bbb, #555); border-radius: 0.3rem;
    background: light-dark(#fff, #222); color: inherit;
  }
  .error { color: light-dark(#b00020, #ff6b6b); font-size: 0.9rem; }

  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }

  button {
    padding: 0.4rem 0.9rem; font-size: 0.9rem; border-radius: 0.3rem;
    border: 1px solid light-dark(#bbb, #555); background: light-dark(#f3f3f3, #2a2a2a);
    color: inherit; cursor: pointer;
  }
  button:hover { background: light-dark(#e6e6e6, #333); }
  button:disabled { opacity: 0.5; cursor: default; }

  section { margin-bottom: 1.5rem; }
  #fioStatus p { margin: 0.2rem 0; font-size: 0.9rem; }

  .filters { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: end; margin-bottom: 0.75rem; }
  .filters label { display: flex; flex-direction: column; font-size: 0.8rem; gap: 0.2rem; }
  .filters input, .filters select {
    padding: 0.3rem; border: 1px solid light-dark(#bbb, #555); border-radius: 0.3rem;
    background: light-dark(#fff, #222); color: inherit;
  }

  table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid light-dark(#ddd, #333); white-space: nowrap; }
  th { font-weight: 600; }
  tbody tr:hover { background: light-dark(#f7f7f7, #262626); }
  #rowsTableWrap { overflow-x: auto; }

  code { background: light-dark(#eee, #333); padding: 0.1rem 0.3rem; border-radius: 0.2rem; }
</style>
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
    <h1>EET — přehled evidovaných plateb</h1>
    <button id="logoutBtn">Odhlásit</button>
  </header>

  <section id="fioSection">
    <div id="fioStatus"></div>
    <button id="pollBtn">Zkontrolovat Fio teď</button>
    <span id="pollResult"></span>
  </section>

  <section>
    <div class="filters">
      <label>Stav
        <select id="statusFilter">
          <option value="ALL">Vše</option>
          <option value="PENDING">PENDING</option>
          <option value="SENT">SENT</option>
          <option value="EXPIRED">EXPIRED</option>
          <option value="REJECTED">REJECTED</option>
        </select>
      </label>
      <label>Od <input type="date" id="dateFrom" /></label>
      <label>Do <input type="date" id="dateTo" /></label>
      <label>Limit <input type="number" id="limit" value="50" min="1" max="500" /></label>
      <button id="refreshBtn">Obnovit</button>
    </div>
    <div id="rowsTableWrap">
      <table>
        <thead>
          <tr>
            <th>Reference</th><th>Stav</th><th>Částka (Kč)</th><th>POK</th>
            <th>Pokusy</th><th>Chyba</th><th>Vytvořeno</th>
          </tr>
        </thead>
        <tbody id="rowsBody"></tbody>
      </table>
    </div>
  </section>
</div>

<script>
(function () {
  var STORAGE_KEY = "eet_admin_token";

  var loginEl = document.getElementById("login");
  var dashEl = document.getElementById("dashboard");
  var pwInput = document.getElementById("pw");
  var loginBtn = document.getElementById("loginBtn");
  var loginError = document.getElementById("loginError");
  var logoutBtn = document.getElementById("logoutBtn");
  var pollBtn = document.getElementById("pollBtn");
  var pollResult = document.getElementById("pollResult");
  var refreshBtn = document.getElementById("refreshBtn");
  var fioStatusEl = document.getElementById("fioStatus");
  var rowsBody = document.getElementById("rowsBody");
  var statusFilter = document.getElementById("statusFilter");
  var dateFromInput = document.getElementById("dateFrom");
  var dateToInput = document.getElementById("dateTo");
  var limitInput = document.getElementById("limit");

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
          loadAll();
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

  function fioRow(label, value) {
    var p = document.createElement("p");
    var strong = document.createElement("strong");
    strong.textContent = label + ": ";
    p.appendChild(strong);
    p.appendChild(document.createTextNode(value));
    return p;
  }

  function renderFioStatus(state) {
    fioStatusEl.textContent = "";
    fioStatusEl.appendChild(fioRow("Fio poll", state.enabled ? "zapnutý" : "vypnutý (FIO_TOKEN není nastaven)"));
    fioStatusEl.appendChild(fioRow("Poslední běh", state.lastRunAt || "—"));
    fioStatusEl.appendChild(fioRow("Naposledy zaevidováno transakcí", String(state.lastReportedCount)));
    fioStatusEl.appendChild(
      fioRow("Poslední chyba", state.lastError ? state.lastError + " (" + state.lastErrorAt + ")" : "—"),
    );
  }

  function loadFioStatus() {
    return authFetch("/fio/status").then(function (res) {
      if (res.status === 401) { showLogin("Heslo přestalo platit, přihlas se znovu."); throw new Error("unauthorized"); }
      return res.json();
    }).then(renderFioStatus);
  }

  function renderRows(rows) {
    rowsBody.textContent = "";
    if (rows.length === 0) {
      var tr = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = 7;
      td.textContent = "Žádné záznamy.";
      tr.appendChild(td);
      rowsBody.appendChild(tr);
      return;
    }
    rows.forEach(function (row) {
      var tr = document.createElement("tr");
      var errorText = row.lastErrorCode != null
        ? String(row.lastErrorCode) + (row.lastErrorMessage ? ": " + row.lastErrorMessage : "")
        : "—";
      [row.reference, row.status, row.amountCzk, row.pok || "—", String(row.attempts), errorText, row.createdAt]
        .forEach(function (text) {
          var td = document.createElement("td");
          td.textContent = text;
          tr.appendChild(td);
        });
      rowsBody.appendChild(tr);
    });
  }

  function loadRows() {
    var params = new URLSearchParams();
    params.set("status", statusFilter.value);
    if (dateFromInput.value) params.set("dateFrom", dateFromInput.value);
    if (dateToInput.value) params.set("dateTo", dateToInput.value);
    if (limitInput.value) params.set("limit", limitInput.value);
    return authFetch("/admin/data?" + params.toString()).then(function (res) {
      if (res.status === 401) { showLogin("Heslo přestalo platit, přihlas se znovu."); throw new Error("unauthorized"); }
      return res.json();
    }).then(function (data) {
      renderRows(data.rows || []);
    });
  }

  function loadAll() {
    loadFioStatus().catch(function () {});
    loadRows().catch(function () {});
  }

  refreshBtn.addEventListener("click", loadAll);
  statusFilter.addEventListener("change", loadRows);

  pollBtn.addEventListener("click", function () {
    pollBtn.disabled = true;
    pollResult.textContent = " Kontroluji…";
    authFetch("/fio/poll", { method: "POST" })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (result) {
        pollBtn.disabled = false;
        if (result.ok) {
          var count = result.data.reportedCount != null ? result.data.reportedCount : 0;
          pollResult.textContent = " Hotovo — nově zaevidováno: " + count;
          loadAll();
        } else {
          pollResult.textContent = " Chyba: " + (result.data.error || "neznámá");
        }
      })
      .catch(function (err) {
        pollBtn.disabled = false;
        pollResult.textContent = " Chyba spojení: " + err.message;
      });
  });

  var saved = getToken();
  if (saved) {
    tryLogin(saved)
      .then(function (ok) {
        if (ok) { showDashboard(); loadAll(); } else { localStorage.removeItem(STORAGE_KEY); showLogin(); }
      })
      .catch(function () { showLogin(); });
  } else {
    showLogin();
  }
})();
</script>
</body>
</html>
`;
