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
            <th>Pokusy</th><th>Chyba</th><th>Vytvořeno</th><th></th>
          </tr>
        </thead>
        <tbody id="rowsBody"></tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Objednávky</h2>
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
      <button id="orderNewBtn" type="button">Nová objednávka</button>
      <span id="ordersMsg" class="ok"></span>
    </div>
    <p class="hint">
      <b>Poukaz</b> pošle poukaz i účet, <b>masáž</b> jen účet. <code>PENDING</code>
      čeká na platbu, <code>PAID</code> je zaplaceno a zpráva se doposílá,
      <code>SENT</code> doručeno.
    </p>
    <form id="orderForm" class="hidden">
      <h3 id="orderFormTitle">Nová objednávka</h3>
      <div class="filters">
        <label>Částka (Kč) <input type="number" id="orderAmount" min="1" step="1" /></label>
        <label>Variabilní symbol <input type="text" id="orderVs" inputmode="numeric" /></label>
        <label>Druh
          <select id="orderKind">
            <option value="VOUCHER">poukaz</option>
            <option value="SERVICE">masáž</option>
          </select>
        </label>
        <label>E-mail <input type="text" id="orderEmail" /></label>
        <label>KS <input type="text" id="orderKs" inputmode="numeric" /></label>
        <label class="checkline"><input type="checkbox" id="orderCash" /> hotovost</label>
      </div>
      <div class="filters">
        <button type="submit" id="orderSaveBtn">Uložit</button>
        <button type="button" id="orderCancelBtn">Zrušit</button>
        <span id="orderFormMsg"></span>
      </div>
      <p class="hint" id="orderFormHint"></p>
    </form>
    <div id="ordersTableWrap">
      <table>
        <thead>
          <tr>
            <th>Druh</th><th>VS</th><th>Stav</th><th>Platba</th><th>Částka (Kč)</th><th>E-mail</th>
            <th>Vytvořeno</th><th>Zaplaceno</th><th>Odesláno</th><th>Pokusy</th><th>Chyba</th><th></th>
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
  var ordersMsg = document.getElementById("ordersMsg");
  var orderForm = document.getElementById("orderForm");
  var orderFormTitle = document.getElementById("orderFormTitle");
  var orderFormHint = document.getElementById("orderFormHint");
  var orderFormMsg = document.getElementById("orderFormMsg");
  var orderAmount = document.getElementById("orderAmount");
  var orderVs = document.getElementById("orderVs");
  var orderKind = document.getElementById("orderKind");
  var orderEmail = document.getElementById("orderEmail");
  var orderKs = document.getElementById("orderKs");
  var orderCash = document.getElementById("orderCash");
  var orderSaveBtn = document.getElementById("orderSaveBtn");
  var orderNewBtn = document.getElementById("orderNewBtn");
  var orderCancelBtn = document.getElementById("orderCancelBtn");

  /** The order the form is editing, or null when it is making a new one. */
  var editingOrderId = null;
  /**
   * Whether that order has already been settled. Held here rather than read off
   * the form: a settled order's fields are disabled but still *hold* their
   * values, and sending them would have the Worker refuse the whole edit — the
   * e-mail included — with "objednávka je vyřízená".
   */
  var editingSettled = false;

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
    // A recent "last attempt" looks exactly like a recent success, which is how
    // a poll that has been failing for hours reads as healthy. Say when the last
    // attempt failed, right next to the switch.
    if (state.enabled && state.lastError) statusText += " — poslední pokus SELHAL";

    fioStatusEl.textContent = "";
    fioStatusEl.appendChild(fioRow("Fio poll", statusText));
    fioStatusEl.appendChild(fioRow("Poslední pokus", state.lastRunAt || "—"));
    fioStatusEl.appendChild(fioRow("Naposledy zaevidováno transakcí", String(state.lastReportedCount)));
    fioStatusEl.appendChild(
      fioRow("Poslední chyba", state.lastError ? state.lastError + " (" + state.lastErrorAt + ")" : "—"),
    );
  }

  function loadFioStatus() {
    return authFetch("/fio/status").then(guard).then(function (res) { return res.json(); }).then(renderFioStatus);
  }

  function fillTable(tbody, rows, columnCount, cellsFor, emptyText, actionFor) {
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
      if (actionFor) {
        var actionCell = document.createElement("td");
        actionCell.appendChild(actionFor(row));
        tr.appendChild(actionCell);
      }
      tbody.appendChild(tr);
    });
  }

  function errorText(row) {
    return row.lastErrorCode != null
      ? String(row.lastErrorCode) + (row.lastErrorMessage ? ": " + row.lastErrorMessage : "")
      : "—";
  }

  /**
   * A delete button for one row. It asks first, and says what is lost rather
   * than just "are you sure" — deleting a registered sale removes the only
   * record of what was filed with the tax authority, and that is worth knowing
   * before the click rather than after it.
   */
  function deleteButton(question, path, row, onDone) {
    var button = document.createElement("button");
    button.textContent = "Smazat";
    button.addEventListener("click", function () {
      if (!confirm(question)) return;
      button.disabled = true;
      authFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id }),
      })
        .then(guard)
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          onDone();
        })
        .catch(function (err) {
          button.disabled = false;
          alert("Nepodařilo se smazat: " + err.message);
        });
    });
    return button;
  }

  function renderRows(rows) {
    fillTable(rowsBody, rows, 8, function (row) {
      return [row.reference, row.status, row.amountCzk, row.pok || "—", String(row.attempts), errorText(row), row.createdAt];
    }, "Žádné záznamy.", function (row) {
      return deleteButton(
        "Smazat záznam o platbě " + row.reference + "?\\n\\nZ přehledu tím zmizí i doklad o tom, že byla nahlášena finanční správě.",
        "/admin/data/delete",
        row,
        loadRows,
      );
    });
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
    fillTable(ordersBody, rows, 12, function (row) {
      return [
        row.kind === "VOUCHER" ? "poukaz" : "masáž",
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
    }, "Žádné objednávky.", function (row) {
      var cell = document.createElement("div");
      cell.className = "rowactions";

      var editBtn = document.createElement("button");
      editBtn.textContent = "Upravit";
      editBtn.addEventListener("click", function () { openOrderForm(row); });
      cell.appendChild(editBtn);

      cell.appendChild(
        deleteButton(
          "Smazat objednávku " + row.variableSymbol + " (" + row.amountCzk + " Kč)?\\n\\n" +
            (row.status === "PENDING" ? "Číslo poukazu se tím uvolní pro další prodej." : "Objednávka je vyřízená, smaže se jen záznam o ní."),
          "/admin/orders/delete",
          row,
          loadOrders,
        ),
      );
      return cell;
    });
  }

  function loadOrders() {
    var params = new URLSearchParams();
    params.set("status", orderStatusFilter.value);
    if (orderLimitInput.value) params.set("limit", orderLimitInput.value);
    return authFetch("/admin/orders?" + params.toString()).then(guard).then(function (res) { return res.json(); })
      .then(function (data) { renderOrders(data.rows || []); });
  }

  /** The Worker's error codes, said the way somebody at a desk would say them. */
  function orderErrorText(error) {
    if (error === "variable_symbol_already_used") return "tenhle variabilní symbol už drží jiná objednávka";
    if (error === "voucher_ks_not_configured") return "vyplňte KS — v prostředí žádný nastavený není";
    if (error === "order_already_settled") return "objednávka je vyřízená, měnit lze jen e-mail";
    if (error === "cash_order_has_no_constant_symbol") return "hotovostní objednávka žádný KS nemá";
    if (error === "not_found") return "objednávka už neexistuje";
    if (error === "amountCzk must be a positive number below 100000000") return "částka musí být kladné číslo";
    if (error === "variableSymbol must be 1 to 10 digits") return "variabilní symbol musí být 1 až 10 číslic";
    if (error === "constantSymbol must be 1 to 4 digits") return "KS musí být 1 až 4 číslice";
    if (error === "email must be a valid e-mail address") return "e-mail nevypadá jako adresa";
    return error;
  }

  /**
   * Opens the form, empty or loaded with an order.
   *
   * A settled order gets its amount and symbols disabled rather than being
   * refused on submit: the Worker freezes those once the receipt is out, and
   * that is worth seeing before typing into the field, not after.
   */
  function openOrderForm(row) {
    editingOrderId = row ? row.id : null;
    orderFormTitle.textContent = row ? "Upravit objednávku VS " + row.variableSymbol : "Nová objednávka";
    orderAmount.value = row ? String(Number(row.amountCzk)) : "";
    orderVs.value = row ? row.variableSymbol : "";
    orderKind.value = row ? row.kind : "VOUCHER";
    orderEmail.value = row ? row.email : "";
    orderKs.value = row ? row.constantSymbol : "";
    orderCash.checked = row ? row.paymentMethod === "CASH" : false;
    orderFormMsg.textContent = "";
    orderFormMsg.className = "";
    ordersMsg.textContent = "";

    var settled = !!row && row.status !== "PENDING";
    editingSettled = settled;
    [orderAmount, orderVs, orderKind, orderKs].forEach(function (el) { el.disabled = settled; });
    // What an order *is* cannot be edited at all — an order is either settled by
    // the bank or paid at the counter, and flipping it would orphan the payment.
    orderCash.disabled = !!row;

    orderFormHint.textContent = !row
      ? "KS musí být stejný, jaký nese QR platba — jinak se příchozí převod nespáruje. U hotovosti se KS nepoužívá."
      : settled
        ? "Objednávka je vyřízená: účet i poukaz už mají původní údaje vytištěné, měnit lze jen e-mail."
        : "Dokud objednávka čeká na platbu, dá se změnit všechno — částka i symbol jsou to, na co se převod páruje.";

    orderForm.classList.remove("hidden");
    orderForm.scrollIntoView({ block: "nearest" });
  }

  function closeOrderForm() {
    editingOrderId = null;
    editingSettled = false;
    orderForm.classList.add("hidden");
    orderFormMsg.textContent = "";
    orderFormMsg.className = "";
  }

  orderNewBtn.addEventListener("click", function () { openOrderForm(null); });
  orderCancelBtn.addEventListener("click", closeOrderForm);

  orderForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var creating = editingOrderId === null;
    var email = orderEmail.value.trim();
    // Only what the Worker will actually accept: everything for a new order,
    // the amount and symbols only while one is still waiting to be paid, and
    // nothing but the address once it has been.
    var payload = creating
      ? {
          amountCzk: Number(orderAmount.value),
          variableSymbol: orderVs.value.trim(),
          kind: orderKind.value,
          email: email,
          constantSymbol: orderKs.value.trim(),
          cash: orderCash.checked,
        }
      : editingSettled
        ? { id: editingOrderId, email: email }
        : {
            id: editingOrderId,
            amountCzk: Number(orderAmount.value),
            variableSymbol: orderVs.value.trim(),
            kind: orderKind.value,
            email: email,
            constantSymbol: orderKs.value.trim(),
          };

    orderSaveBtn.disabled = true;
    orderFormMsg.className = "";
    orderFormMsg.textContent = "Ukládám…";

    authFetch(creating ? "/admin/orders" : "/admin/orders/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (out) {
        orderSaveBtn.disabled = false;
        if (!out.ok) {
          orderFormMsg.className = "error";
          orderFormMsg.textContent = "Nepodařilo se uložit: " + orderErrorText(out.data.error || "neznámá chyba");
          return;
        }
        ordersMsg.textContent = creating
          ? out.data.status === "PAID"
            ? "Objednávka " + out.data.variableSymbol + " vytvořena a hned odeslána (hotovost)."
            : "Objednávka " + out.data.variableSymbol + " vytvořena, čeká na platbu."
          : "Objednávka " + out.data.variableSymbol + " uložena.";
        closeOrderForm();
        loadOrders();
      })
      .catch(function (err) {
        orderSaveBtn.disabled = false;
        orderFormMsg.className = "error";
        orderFormMsg.textContent = "Chyba spojení: " + err.message;
      });
  });

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
