import { adminShell } from "./adminShared";

/**
 * GET /admin — the overview page: Fio poll state, registered sales, and voucher
 * orders.
 *
 * The login gate, the styles and the menu live in `adminShared.ts`, shared with
 * the settings page. Everything here reads through `GET /admin/data`,
 * `GET /admin/orders` and `GET /fio/status`, which require a Bearer token —
 * the shell is public, the data behind it is not. The password authenticates
 * against `ADMIN_PASSWORD` (a separate secret from `EET_API_TOKEN`, see
 * `checkAdminAuth` in `index.ts`) so a human never handles the
 * machine-to-machine token just to look at this page.
 */

const BODY = `
  <section id="fioSection">
    <h2>Fio poll</h2>
    <div id="fioStatus"></div>
    <button id="pollBtn">Zkontrolovat Fio teď</button>
    <span id="pollResult"></span>
  </section>

  <section>
    <h2>Evidované platby</h2>
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

  <section>
    <h2>Objednávky poukazek</h2>
    <div class="filters">
      <label>Stav
        <select id="orderStatusFilter">
          <option value="ALL">Vše</option>
          <option value="PENDING">PENDING</option>
          <option value="PAID">PAID</option>
          <option value="SENT">SENT</option>
          <option value="EXPIRED">EXPIRED</option>
          <option value="CANCELLED">CANCELLED</option>
        </select>
      </label>
      <label>Limit <input type="number" id="orderLimit" value="50" min="1" max="500" /></label>
      <button id="ordersRefreshBtn">Obnovit</button>
    </div>
    <p class="hint">
      <code>PENDING</code> čeká na platbu, <code>PAID</code> je zaplaceno a poukaz se
      doposílá, <code>SENT</code> doručeno.
    </p>
    <div id="ordersTableWrap">
      <table>
        <thead>
          <tr>
            <th>Č. poukazu</th><th>Stav</th><th>Platba</th><th>Částka (Kč)</th><th>E-mail</th>
            <th>Vytvořeno</th><th>Zaplaceno</th><th>Odesláno</th><th>Pokusy</th><th>Chyba</th>
          </tr>
        </thead>
        <tbody id="ordersBody"></tbody>
      </table>
    </div>
  </section>
`;

const SCRIPT = `
(function () {
  var authFetch = window.eetAdmin.authFetch;
  var showLogin = window.eetAdmin.showLogin;

  var pollBtn = document.getElementById("pollBtn");
  var pollResult = document.getElementById("pollResult");
  var refreshBtn = document.getElementById("refreshBtn");
  var fioStatusEl = document.getElementById("fioStatus");
  var rowsBody = document.getElementById("rowsBody");
  var statusFilter = document.getElementById("statusFilter");
  var dateFromInput = document.getElementById("dateFrom");
  var dateToInput = document.getElementById("dateTo");
  var limitInput = document.getElementById("limit");
  var ordersBody = document.getElementById("ordersBody");
  var orderStatusFilter = document.getElementById("orderStatusFilter");
  var orderLimitInput = document.getElementById("orderLimit");
  var ordersRefreshBtn = document.getElementById("ordersRefreshBtn");

  function guard(res) {
    if (res.status === 401) { showLogin("Heslo přestalo platit, přihlas se znovu."); throw new Error("unauthorized"); }
    return res;
  }

  function fioRow(label, value) {
    var p = document.createElement("p");
    var strong = document.createElement("strong");
    strong.textContent = label + ": ";
    p.appendChild(strong);
    p.appendChild(document.createTextNode(value));
    return p;
  }

  function renderFioStatus(state) {
    // Say *why* it is off, not just that it is: the setting can now be switched
    // off from the settings page without anyone touching the token.
    var statusText = state.enabled
      ? "zapnutý"
      : state.tokenSet
        ? "vypnutý (vypnuto v Nastavení)"
        : "vypnutý (token není nastaven)";

    fioStatusEl.textContent = "";
    fioStatusEl.appendChild(fioRow("Fio poll", statusText));
    fioStatusEl.appendChild(fioRow("Poslední běh", state.lastRunAt || "—"));
    fioStatusEl.appendChild(fioRow("Naposledy zaevidováno transakcí", String(state.lastReportedCount)));
    fioStatusEl.appendChild(
      fioRow("Poslední chyba", state.lastError ? state.lastError + " (" + state.lastErrorAt + ")" : "—"),
    );
  }

  function loadFioStatus() {
    return authFetch("/fio/status").then(guard).then(function (res) { return res.json(); }).then(renderFioStatus);
  }

  function fillTable(tbody, rows, columnCount, cellsFor, emptyText) {
    tbody.textContent = "";
    if (rows.length === 0) {
      var tr = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = columnCount;
      td.textContent = emptyText;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    rows.forEach(function (row) {
      var tr = document.createElement("tr");
      cellsFor(row).forEach(function (text) {
        var td = document.createElement("td");
        td.textContent = text;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  function errorText(row) {
    return row.lastErrorCode != null
      ? String(row.lastErrorCode) + (row.lastErrorMessage ? ": " + row.lastErrorMessage : "")
      : "—";
  }

  function renderRows(rows) {
    fillTable(rowsBody, rows, 7, function (row) {
      return [row.reference, row.status, row.amountCzk, row.pok || "—", String(row.attempts), errorText(row), row.createdAt];
    }, "Žádné záznamy.");
  }

  function loadRows() {
    var params = new URLSearchParams();
    params.set("status", statusFilter.value);
    if (dateFromInput.value) params.set("dateFrom", dateFromInput.value);
    if (dateToInput.value) params.set("dateTo", dateToInput.value);
    if (limitInput.value) params.set("limit", limitInput.value);
    return authFetch("/admin/data?" + params.toString()).then(guard).then(function (res) { return res.json(); })
      .then(function (data) { renderRows(data.rows || []); });
  }

  function renderOrders(rows) {
    fillTable(ordersBody, rows, 10, function (row) {
      return [
        row.variableSymbol,
        row.status,
        row.paymentMethod === "CASH" ? "hotovost" : "převod",
        row.amountCzk,
        row.email,
        row.createdAt,
        row.paidAt || "—",
        row.sentAt || "—",
        String(row.attempts),
        row.lastError || "—",
      ];
    }, "Žádné objednávky.");
  }

  function loadOrders() {
    var params = new URLSearchParams();
    params.set("status", orderStatusFilter.value);
    if (orderLimitInput.value) params.set("limit", orderLimitInput.value);
    return authFetch("/admin/orders?" + params.toString()).then(guard).then(function (res) { return res.json(); })
      .then(function (data) { renderOrders(data.rows || []); });
  }

  function loadAll() {
    loadFioStatus().catch(function () {});
    loadRows().catch(function () {});
    loadOrders().catch(function () {});
  }

  refreshBtn.addEventListener("click", loadAll);
  statusFilter.addEventListener("change", loadRows);
  ordersRefreshBtn.addEventListener("click", loadOrders);
  orderStatusFilter.addEventListener("change", loadOrders);

  pollBtn.addEventListener("click", function () {
    pollBtn.disabled = true;
    pollResult.textContent = " Kontroluji…";
    authFetch("/fio/poll", { method: "POST" })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (out) {
        pollBtn.disabled = false;
        if (out.ok) {
          var count = out.data.reportedCount != null ? out.data.reportedCount : 0;
          pollResult.textContent = " Hotovo — nově zaevidováno: " + count;
          loadAll();
        } else {
          pollResult.textContent = " Chyba: " + (out.data.error || "neznámá");
        }
      })
      .catch(function (err) {
        pollBtn.disabled = false;
        pollResult.textContent = " Chyba spojení: " + err.message;
      });
  });

  window.eetOnShown = loadAll;
})();
`;

export const ADMIN_HTML = adminShell({
  title: "EET — přehled plateb",
  active: "overview",
  heading: "EET — přehled",
  body: BODY,
  script: SCRIPT,
});
