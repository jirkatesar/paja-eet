import { connect } from "cloudflare:sockets";

/**
 * A minimal SMTP submission client, because Cloudflare Workers have no usable
 * e-mail library: `nodemailer` needs node's `net`/`tls`, which workerd doesn't
 * provide. The only way to speak SMTP from a Worker is `cloudflare:sockets`,
 * so the protocol lives here.
 *
 * **Prefer port 465** (`secureTransport: "on"`, implicit TLS). There is an open
 * workerd bug (https://github.com/cloudflare/workerd/issues/2712) where
 * `startTls()` — the STARTTLS upgrade on 587 — completes the handshake and then
 * hangs on writes; it was reported against Proton Mail, Outlook and Ethereal.
 * On 465 there is no `startTls()` call at all, so that whole class of failure
 * can't happen. Note it did *not* reproduce against smtp.seznam.cz, which works
 * on both 465 and 587 — so `starttls` is supported and usable, just not the
 * default, and it is the path where a provider-specific hang is a known risk.
 *
 * This is a submission client, not an MTA: it authenticates to the operator's
 * own mail provider, which then relays and signs the message. That is what
 * makes SPF/DKIM line up — as long as `SMTP_FROM` is on the same domain as the
 * authenticated account, which is a configuration concern, not a code one.
 */

export type SmtpSecurity = "tls" | "starttls" | "none";

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string;
  password: string;
  /** Envelope sender and `From:` header. */
  from: string;
  /** Optional display name for `From:`. */
  fromName?: string;
}

export interface MailAttachment {
  filename: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  attachment?: MailAttachment;
}

/** A hung mail server must not hold a cron run (or an HTTP request) open. */
const DEFAULT_TIMEOUT_MS = 20_000;

const CRLF = "\r\n";

// ---------------------------------------------------------------- encoding

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked because `String.fromCharCode(...bytes)` blows the argument limit
  // on anything larger than a small PDF.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** base64 wrapped at 76 characters, as MIME requires. */
function wrapBase64(base64: string): string {
  return base64.replace(/(.{76})/g, `$1${CRLF}`);
}

/** RFC 2047 encoded-word, so a Czech subject with diacritics survives the trip. */
function encodeHeaderValue(value: string): string {
  return /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${utf8ToBase64(value)}?=`;
}

// ---------------------------------------------------------------- MIME

function buildMimeMessage(config: SmtpConfig, message: MailMessage): string {
  const boundary = `----=_poukaz_${crypto.randomUUID().replace(/-/g, "")}`;
  const fromDomain = config.from.split("@")[1] || "localhost";
  const fromHeader = config.fromName ? `"${encodeHeaderValue(config.fromName)}" <${config.from}>` : `<${config.from}>`;

  const headers = [
    `From: ${fromHeader}`,
    `To: <${message.to}>`,
    `Subject: ${encodeHeaderValue(message.subject)}`,
    // RFC 5322 wants a numeric zone; toUTCString() gives "GMT".
    `Date: ${new Date().toUTCString().replace(/GMT$/, "+0000")}`,
    `Message-ID: <${crypto.randomUUID()}@${fromDomain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].join(CRLF);

  // Both parts are base64 so the whole message stays 7-bit ASCII: no 8-bit
  // mangling of Czech diacritics in transit, and no line can start with ".".
  const parts = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(utf8ToBase64(message.text)),
  ];

  if (message.attachment) {
    const { filename, bytes, contentType } = message.attachment;
    parts.push(
      `--${boundary}`,
      `Content-Type: ${contentType}; name="${filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${filename}"`,
      "",
      wrapBase64(bytesToBase64(bytes)),
    );
  }

  parts.push(`--${boundary}--`);

  return `${headers}${CRLF}${CRLF}${parts.join(CRLF)}`;
}

/** An SMTP line may not begin with "." — double it (RFC 5321 §4.5.2). */
function dotStuff(message: string): string {
  return message.replace(/^\./gm, "..");
}

// ---------------------------------------------------------------- transport

/** Reads CRLF-terminated lines out of the socket, one chunk at a time. */
class LineReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async readLine(): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf(CRLF);
      if (end >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + CRLF.length);
        return line;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error("server closed the connection");
      // stream: true — a multi-byte character may straddle two chunks.
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  release(): void {
    try {
      this.reader.releaseLock();
    } catch {
      // Already released (the socket closed under us) — nothing to do.
    }
  }
}

type SmtpResponse = { code: number; lines: string[] };

class SmtpSession {
  private socket: Socket;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private reader: LineReader;
  private readonly encoder = new TextEncoder();

  constructor(socket: Socket) {
    this.socket = socket;
    this.writer = socket.writable.getWriter();
    this.reader = new LineReader(socket.readable);
  }

  /** Swaps to the TLS-upgraded socket. `startTls()` returns a *new* socket; the old one stops working. */
  upgradeToTls(hostname: string): void {
    this.reader.release();
    try {
      this.writer.releaseLock();
    } catch {
      // Same as above — the plaintext side is finished either way.
    }
    this.socket = this.socket.startTls({ expectedServerHostname: hostname });
    this.writer = this.socket.writable.getWriter();
    this.reader = new LineReader(this.socket.readable);
  }

  async close(): Promise<void> {
    this.reader.release();
    try {
      await this.socket.close();
    } catch {
      // Closing an already-broken socket is not an error worth reporting.
    }
  }

  /** Reads one (possibly multi-line) reply. "250-FOO" continues; "250 FOO" or "250" ends. */
  private async readResponse(): Promise<SmtpResponse> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.reader.readLine();
      lines.push(line);
      if (line.length < 4 || line[3] !== "-") break;
    }
    return { code: Number(lines[lines.length - 1].slice(0, 3)), lines };
  }

  async command(command: string, ...expectedCodes: number[]): Promise<SmtpResponse> {
    await this.writer.write(this.encoder.encode(command + CRLF));
    const response = await this.readResponse();
    if (expectedCodes.length && !expectedCodes.includes(response.code)) {
      throw new Error(`"${command.split(" ")[0]}" failed with ${response.code} ${this.lastLine(response)}`);
    }
    return response;
  }

  /** Writes the message body and reads the reply that accepts (or rejects) it. */
  async sendBody(payload: string): Promise<void> {
    await this.writer.write(this.encoder.encode(payload));
    const response = await this.readResponse();
    if (response.code !== 250) {
      throw new Error(`message rejected with ${response.code} ${this.lastLine(response)}`);
    }
  }

  greeting(): Promise<SmtpResponse> {
    return this.readResponse();
  }

  lastLine(response: SmtpResponse): string {
    return response.lines[response.lines.length - 1].slice(4);
  }
}

/** The name this client announces in EHLO — the sending domain is the honest answer. */
function clientName(config: SmtpConfig): string {
  return config.from.split("@")[1] || "localhost";
}

async function sayEhlo(session: SmtpSession, config: SmtpConfig): Promise<string[]> {
  const response = await session.command(`EHLO ${clientName(config)}`, 250);
  return response.lines.map((line) => line.slice(4).trim());
}

async function authenticate(session: SmtpSession, config: SmtpConfig, capabilities: string[]): Promise<void> {
  const mechanisms = capabilities
    .filter((line) => line.toUpperCase().startsWith("AUTH"))
    .flatMap((line) => line.split(/\s+/).slice(1).map((m) => m.toUpperCase()));

  if (mechanisms.includes("PLAIN")) {
    // One round trip: NUL user NUL password, base64'd.
    await session.command(`AUTH PLAIN ${utf8ToBase64(`\0${config.user}\0${config.password}`)}`, 235);
    return;
  }
  if (mechanisms.includes("LOGIN")) {
    // No initial response — the server replies with a base64 "Username:" challenge.
    await session.command("AUTH LOGIN", 334);
    await session.command(utf8ToBase64(config.user), 334);
    await session.command(utf8ToBase64(config.password), 235);
    return;
  }
  throw new Error(`no supported AUTH mechanism offered (${mechanisms.join(", ") || "none advertised"})`);
}

/** Distinguishable from a transport failure, so the two can be reported differently. */
class SmtpTimeoutError extends Error {}

/**
 * Hosts where an unencrypted connection cannot leave the machine. Plaintext SMTP
 * is only ever acceptable against one of these — a stub on the developer's own
 * laptop — which is what `SMTP_SECURE=none` exists for.
 */
function isLoopback(host: string): boolean {
  const bare = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return bare === "localhost" || bare === "::1" || /^127\.\d+\.\d+\.\d+$/.test(bare);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new SmtpTimeoutError(`timed out after ${ms}ms`)), ms)),
  ]);
}

/**
 * Sends one message. Throws on any failure — callers decide whether that means
 * "retry later" (it usually does) or "give up".
 *
 * Every error is re-thrown with the endpoint prefixed, because the transport's
 * own failures are uninformative on their own: a refused connection surfaces as
 * the bare "Stream was cancelled.", which says nothing about *which* server the
 * Worker couldn't reach — and that string is what ends up in the order's
 * `lastError` on the dashboard.
 */
export async function sendMail(config: SmtpConfig, message: MailMessage, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  // Checked before anything is opened: unencrypted SMTP to a real server would
  // put the mailbox password on the wire in the clear, and would send the
  // customer's voucher the same way. Only a loopback stub may do that, and
  // there is deliberately no override — a real mailbox that "needs" plaintext
  // needs a different provider, not a config flag.
  if (config.security === "none" && !isLoopback(config.host)) {
    throw new Error(
      `refusing to send unencrypted to ${config.host} — SMTP_SECURE=none is only for a local test server, ` +
        `use tls (port 465) or starttls (port 587)`,
    );
  }

  try {
    await attemptSendMail(config, message, timeoutMs);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`SMTP ${config.host}:${config.port}: ${detail}`);
  }
}

async function attemptSendMail(config: SmtpConfig, message: MailMessage, timeoutMs: number): Promise<void> {
  const secureTransport = config.security === "tls" ? "on" : config.security === "starttls" ? "starttls" : "off";
  const session = new SmtpSession(connect({ hostname: config.host, port: config.port }, { allowHalfOpen: false, secureTransport }));

  try {
    // Everything before the server's greeting is TCP and TLS, and it is where
    // the runtime's errors are at their most useless: a refused connection, an
    // untrusted certificate and a dropped handshake all arrive as the same bare
    // "Stream was cancelled." Reporting it as a connection/TLS problem — which
    // is what it always is at this stage — is the difference between an operator
    // checking SMTP_HOST and one checking whether their certificate is valid.
    try {
      await withTimeout(session.greeting(), timeoutMs);
    } catch (err) {
      if (err instanceof SmtpTimeoutError) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`no greeting from the server — connection or TLS (${config.security}) failed: ${detail}`);
    }

    await withTimeout(
      (async () => {
        let capabilities = await sayEhlo(session, config);

        if (config.security === "starttls") {
          // Not the recommended path — see the note at the top of this file.
          if (!capabilities.some((line) => line.toUpperCase().startsWith("STARTTLS"))) {
            throw new Error("server does not advertise STARTTLS");
          }
          await session.command("STARTTLS", 220);
          session.upgradeToTls(config.host);
          capabilities = await sayEhlo(session, config); // capabilities change after the upgrade
        }

        await authenticate(session, config, capabilities);
        await session.command(`MAIL FROM:<${config.from}>`, 250);
        await session.command(`RCPT TO:<${message.to}>`, 250, 251);
        await session.command("DATA", 354);
        // The terminating "." needs its own line, so the body must end with CRLF.
        await session.sendBody(`${dotStuff(buildMimeMessage(config, message))}${CRLF}.${CRLF}`);
        await session.command("QUIT", 221);
      })(),
      timeoutMs,
    );
  } finally {
    await session.close();
  }
}
