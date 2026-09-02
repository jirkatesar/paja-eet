/**
 * Builds and signs the EET 2.0 "OdeslaniTrzby" SOAP request per the official
 * interface spec (EET_popis_rozhrani_v1.2, section 5: WS-Security + XML-DSig,
 * Exclusive C14N, RSA-SHA256, SHA-256 digest, BinarySecurityToken).
 *
 * Rather than a generic XML canonicalizer, this generates the Body and
 * SignedInfo fragments already in canonical form (self-contained namespace
 * declarations, attributes in the fixed alphabetical order Exclusive C14N
 * produces for this schema's small, fixed attribute set) and reuses those
 * exact strings both for hashing/signing and for the literal message sent —
 * so there is no risk of the two ever diverging. Verified against the
 * official CZ00000019.eet.v4.req.xml sample from eet.gov.cz.
 */

export interface TrzbaParams {
  uuidZpravy: string;
  /** ISO 8601, no fractional seconds — e.g. 2027-01-08T21:19:40Z */
  datOdesl: string;
  prvniZaslani: boolean;
  overeni?: boolean;
  eicPopl: string;
  idJednotky: string;
  idPokl: string;
  poradCis: string;
  /** ISO 8601, no fractional seconds */
  datTrzby: string;
  /** Decimal string with exactly 2 decimal places, e.g. "150.00" */
  celkTrzba: string;
}

const NS = {
  soapenv: "http://schemas.xmlsoap.org/soap/envelope/",
  v4: "http://fs.gov.cz/eet/schema/v4",
  wsu: "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd",
  wsse: "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd",
  ds: "http://www.w3.org/2000/09/xmldsig#",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function canonicalHlavicka(p: TrzbaParams): string {
  const parts = [`dat_odesl="${esc(p.datOdesl)}"`];
  if (p.overeni !== undefined) parts.push(`overeni="${p.overeni}"`);
  parts.push(`prvni_zaslani="${p.prvniZaslani}"`, `uuid_zpravy="${esc(p.uuidZpravy)}"`);
  // Canonical XML never uses the self-closing form for empty elements — always an explicit start/end tag pair.
  return `<v4:Hlavicka ${parts.join(" ")}></v4:Hlavicka>`;
}

function canonicalData(p: TrzbaParams): string {
  const parts = [
    `celk_trzba="${esc(p.celkTrzba)}"`,
    `dat_trzby="${esc(p.datTrzby)}"`,
    `eic_popl="${esc(p.eicPopl)}"`,
    `id_jednotky="${esc(p.idJednotky)}"`,
    `id_pokl="${esc(p.idPokl)}"`,
    `porad_cis="${esc(p.poradCis)}"`,
  ];
  return `<v4:Data ${parts.join(" ")}></v4:Data>`;
}

/**
 * The `<soap:Body>` element in canonical (Exclusive C14N) form — the one and
 * only signed reference. Exclusive C14N does NOT hoist every namespace used
 * anywhere in the subtree up onto the subtree's root — each declaration is
 * rendered at the shallowest element that actually first uses that prefix.
 * `soapenv` and `wsu` are used by Body itself (element name / wsu:Id), so
 * they belong there; `v4` is only used starting at Trzba, so it belongs
 * there instead (verified against xmlsec1's own canonicalization output).
 */
function canonicalBody(p: TrzbaParams, wsuId: string): string {
  const trzba = `<v4:Trzba xmlns:v4="${NS.v4}">${canonicalHlavicka(p)}${canonicalData(p)}</v4:Trzba>`;
  return `<soapenv:Body xmlns:soapenv="${NS.soapenv}" xmlns:wsu="${NS.wsu}" wsu:Id="${wsuId}">${trzba}</soapenv:Body>`;
}

/** `<ds:SignedInfo>` in canonical form — this exact string is both signed and embedded in the message. */
function canonicalSignedInfo(digestB64: string, bodyRefId: string): string {
  return (
    `<ds:SignedInfo xmlns:ds="${NS.ds}">` +
    `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:CanonicalizationMethod>` +
    `<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"></ds:SignatureMethod>` +
    `<ds:Reference URI="#${bodyRefId}">` +
    `<ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:Transform></ds:Transforms>` +
    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>` +
    `<ds:DigestValue>${digestB64}</ds:DigestValue>` +
    `</ds:Reference></ds:SignedInfo>`
  );
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return arrayBufferToBase64(digest);
}

async function rsaSha256SignBase64(text: string, key: CryptoKey): Promise<string> {
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(text));
  return arrayBufferToBase64(sig);
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Imports a PKCS#8 PEM private key for RSASSA-PKCS1-v1_5 / SHA-256 signing. */
export async function importPrivateKeyFromPem(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", pemToArrayBuffer(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

/** Strips PEM armor down to the raw base64 DER — the form BinarySecurityToken expects. */
export function certPemToDerBase64(pem: string): string {
  return pem.replace(/-----BEGIN CERTIFICATE-----/, "").replace(/-----END CERTIFICATE-----/, "").replace(/\s+/g, "");
}

/** Builds the full signed SOAP envelope ready to POST to the EET SOAP endpoint. */
export async function buildSignedEnvelope(params: TrzbaParams, certDerBase64: string, privateKey: CryptoKey): Promise<string> {
  const bodyId = `id-${crypto.randomUUID()}`;
  const bodyXml = canonicalBody(params, bodyId);
  const bodyDigest = await sha256Base64(bodyXml);
  const signedInfoXml = canonicalSignedInfo(bodyDigest, bodyId);
  const signatureValue = await rsaSha256SignBase64(signedInfoXml, privateKey);

  const btId = `X509-${crypto.randomUUID()}`;
  const sigId = `SIG-${crypto.randomUUID()}`;
  const kiId = `KI-${crypto.randomUUID()}`;
  const strId = `STR-${crypto.randomUUID()}`;

  const binarySecurityToken =
    `<wsse:BinarySecurityToken xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}" ` +
    `EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary" ` +
    `ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3" wsu:Id="${btId}">` +
    `${certDerBase64}</wsse:BinarySecurityToken>`;

  const signature =
    `<ds:Signature xmlns:ds="${NS.ds}" Id="${sigId}">` +
    signedInfoXml +
    `<ds:SignatureValue>${signatureValue}</ds:SignatureValue>` +
    `<ds:KeyInfo Id="${kiId}">` +
    `<wsse:SecurityTokenReference xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}" wsu:Id="${strId}">` +
    `<wsse:Reference URI="#${btId}" ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3"/>` +
    `</wsse:SecurityTokenReference></ds:KeyInfo></ds:Signature>`;

  const security = `<wsse:Security xmlns:wsse="${NS.wsse}">${binarySecurityToken}${signature}</wsse:Security>`;

  return `<soapenv:Envelope xmlns:soapenv="${NS.soapenv}"><soapenv:Header>${security}</soapenv:Header>${bodyXml}</soapenv:Envelope>`;
}

/** Current time formatted as EET's required ISO 8601 form — no fractional seconds. */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
