import { adminShell } from "./adminShared";

/**
 * GET /admin/config — the settings page.
 *
 * Everything here overrides the environment; anything left empty falls back to
 * it, and the page says so next to every field. Two things are deliberate:
 *
 * - **Secrets are never shown.** The server does not send the Fio token or the
 *   SMTP password, only whether they are set, so the fields start empty and
 *   staying empty means "leave it alone". A value that cannot be read back
 *   cannot leak through a shared screen or a browser's form history.
 * - **"Uložit" sends the whole form.** Empty non-secret fields therefore clear
 *   the override and hand that setting back to the environment, which is what
 *   clearing a box looks like it should do.
 */

const BODY = `
  <section>
    <h2>Fio poll</h2>
    <p class="hint">
      Když je poll vypnutý, neběží ani s vyplněným tokenem. Prázdné pole frekvence
      znamená „použij hodnotu z prostředí".
    </p>

    <label class="checkline">
      <input type="checkbox" id="fioEnabled" />
      <span>Kontrolovat příchozí platby</span>
    </label>

    <label class="field">
      <span class="label">Frekvence kontroly (sekundy)</span>
      <input type="number" id="fioPollIntervalSeconds" min="30" step="1" placeholder="např. 45" />
      <span class="source" id="fioPollIntervalSource"></span>
    </label>

    <label class="field">
      <span class="label">Fio API token</span>
      <input type="password" id="fioToken" autocomplete="new-password" placeholder="" />
      <span class="source" id="fioTokenSource"></span>
    </label>
  </section>

  <section>
    <h2>SMTP (odesílání poukazek)</h2>
    <p class="hint">
      Port a režim musí souhlasit: <code>465</code> znamená TLS od prvního bajtu
      (<code>tls</code>), <code>587</code> znamená připojit se nešifrovaně a pak
      povýšit (<code>starttls</code>).
    </p>

    <label class="field">
      <span class="label">Server</span>
      <input type="text" id="smtpHost" placeholder="např. smtp.gmail.com" />
      <span class="source" id="smtpHostSource"></span>
    </label>

    <label class="field">
      <span class="label">Port</span>
      <input type="number" id="smtpPort" min="1" max="65535" placeholder="465" />
      <span class="source" id="smtpPortSource"></span>
    </label>

    <label class="field">
      <span class="label">Zabezpečení</span>
      <select id="smtpSecure">
        <option value="">(podle portu)</option>
        <option value="tls">tls — TLS od prvního bajtu (465)</option>
        <option value="starttls">starttls — povýšení (587)</option>
        <option value="none">none — nešifrovaně (jen místní test)</option>
      </select>
      <span class="source" id="smtpSecureSource"></span>
    </label>

    <label class="field">
      <span class="label">Odesílatel (From)</span>
      <input type="text" id="smtpFrom" placeholder="např. poukazy@vasedomena.cz" />
      <span class="source" id="smtpFromSource"></span>
    </label>

    <label class="field">
      <span class="label">Jméno odesílatele</span>
      <input type="text" id="smtpFromName" placeholder="např. Masáže" />
      <span class="source" id="smtpFromNameSource"></span>
    </label>

    <label class="field">
      <span class="label">Uživatel</span>
      <input type="text" id="smtpUser" autocomplete="off" />
      <span class="source" id="smtpUserSource"></span>
    </label>

    <label class="field">
      <span class="label">Heslo</span>
      <input type="password" id="smtpPassword" autocomplete="new-password" />
      <span class="source" id="smtpPasswordSource"></span>
    </label>
  </section>

  <section>
    <button id="saveBtn">Uložit</button>
    <button id="resetBtn">Vrátit vše na hodnoty z prostředí</button>
    <p id="saveResult"></p>
  </section>
`;

const SCRIPT = `
(function () {
  var authFetch = window.eetAdmin.authFetch;

  var fields = [
    "fioPollIntervalSeconds", "fioToken",
    "smtpHost", "smtpPort", "smtpSecure", "smtpFrom", "smtpFromName", "smtpUser", "smtpPassword",
  ];

  function el(id) { return document.getElementById(id); }

  var SOURCE_LABELS = {
    config: "nastaveno zde",
    env: "z prostředí (ENV)",
    default: "výchozí hodnota",
    unset: "nenastaveno",
  };

  function describeSource(kind, origin) {
    if (origin !== undefined) {
      var label = SOURCE_LABELS[origin] || origin;
      return origin === "config" ? "Používá se: " + label : "Používá se: " + label;
    }
    return SOURCE_LABELS[kind] || kind;
  }

  function render(data) {
    el("fioEnabled").checked = data.fio.enabled;
    el("fioPollIntervalSeconds").value = data.fio.pollIntervalSource === "default" ? "" : data.fio.pollIntervalSeconds;
    el("fioPollIntervalSource").textContent = describeSource(null, data.fio.pollIntervalSource);
    el("fioPollIntervalSource").className = "source" + (data.fio.pollIntervalSource === "config" ? " from-config" : "");

    // Secrets are write-only: an empty box means "keep what is stored".
    el("fioToken").value = "";
    el("fioToken").placeholder = data.fio.tokenSet ? "•••••• (uloženo — nech prázdné pro zachování)" : "nenastaveno";
    el("fioTokenSource").textContent = describeSource(null, data.fio.tokenSource);
    el("fioTokenSource").className = "source" + (data.fio.tokenSource === "config" ? " from-config" : "");

    el("smtpHost").value = data.smtp.host;
    el("smtpHostSource").textContent = describeSource(null, data.smtp.hostSource);
    el("smtpHostSource").className = "source" + (data.smtp.hostSource === "config" ? " from-config" : "");

    el("smtpPort").value = data.smtp.port;
    el("smtpPortSource").textContent = describeSource(null, data.smtp.portSource);
    el("smtpPortSource").className = "source" + (data.smtp.portSource === "config" ? " from-config" : "");

    el("smtpSecure").value = data.smtp.security;
    el("smtpSecureSource").textContent = describeSource(null, data.smtp.securitySource);
    el("smtpSecureSource").className = "source" + (data.smtp.securitySource === "config" ? " from-config" : "");

    el("smtpFrom").value = data.smtp.from;
    el("smtpFromSource").textContent = describeSource(null, data.smtp.fromSource);
    el("smtpFromSource").className = "source" + (data.smtp.fromSource === "config" ? " from-config" : "");

    el("smtpFromName").value = data.smtp.fromName;
    el("smtpFromNameSource").textContent = describeSource(null, data.smtp.fromNameSource);
    el("smtpFromNameSource").className = "source" + (data.smtp.fromNameSource === "config" ? " from-config" : "");

    el("smtpUser").value = "";
    el("smtpUser").placeholder = data.smtp.userSet ? "•••••• (uloženo — nech prázdné pro zachování)" : "nenastaveno";
    el("smtpUserSource").textContent = describeSource(null, data.smtp.userSource);
    el("smtpUserSource").className = "source" + (data.smtp.userSource === "config" ? " from-config" : "");

    el("smtpPassword").value = "";
    el("smtpPassword").placeholder = data.smtp.passwordSet ? "•••••• (uloženo — nech prázdné pro zachování)" : "nenastaveno";
    el("smtpPasswordSource").textContent = describeSource(null, data.smtp.passwordSource);
    el("smtpPasswordSource").className = "source" + (data.smtp.passwordSource === "config" ? " from-config" : "");
  }

  function result(message, isError) {
    var p = el("saveResult");
    p.textContent = message;
    p.className = isError ? "error" : "ok";
  }

  function load() {
    return authFetch("/admin/config/data")
      .then(function (res) {
        if (res.status === 401) { window.eetAdmin.showLogin("Heslo přestalo platit, přihlas se znovu."); throw new Error("unauthorized"); }
        return res.json();
      })
      .then(render);
  }

  function payload() {
    var body = { fioEnabled: el("fioEnabled").checked };
    fields.forEach(function (id) { body[id] = el(id).value; });
    return body;
  }

  function send(path, message) {
    result("Ukládám…", false);
    return authFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload()),
    })
      .then(function (res) {
        if (res.status === 401) { window.eetAdmin.showLogin("Heslo přestalo platit, přihlas se znovu."); throw new Error("unauthorized"); }
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (out) {
        if (!out.ok) { result("Nepodařilo se uložit: " + (out.data.error || "neznámá chyba"), true); return; }
        render(out.data);
        result(message, false);
      })
      .catch(function (err) {
        if (err.message !== "unauthorized") result("Chyba spojení: " + err.message, true);
      });
  }

  el("saveBtn").addEventListener("click", function () {
    send("/admin/config/data", "Uloženo.");
  });

  el("resetBtn").addEventListener("click", function () {
    result("Vracím na hodnoty z prostředí…", false);
    authFetch("/admin/config/reset", { method: "POST" })
      .then(function (res) {
        if (res.status === 401) { window.eetAdmin.showLogin("Heslo přestalo platit, přihlas se znovu."); throw new Error("unauthorized"); }
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (out) {
        if (!out.ok) { result("Nepodařilo se vrátit: " + (out.data.error || "neznámá chyba"), true); return; }
        render(out.data);
        result("Vráceno na hodnoty z prostředí.", false);
      })
      .catch(function (err) {
        if (err.message !== "unauthorized") result("Chyba spojení: " + err.message, true);
      });
  });

  window.eetOnShown = load;
})();
`;

export const ADMIN_CONFIG_HTML = adminShell({
  title: "EET — nastavení",
  active: "config",
  heading: "EET — nastavení",
  body: BODY,
  script: SCRIPT,
});
