/**
 * Submits a signed envelope to the EET SOAP endpoint and interprets the
 * response. The response is a small, fixed-shape SOAP body, so a couple of
 * targeted regexes are used instead of a full XML parser (see xmlsign.ts for
 * why the same "keep it simple, the shape never varies" approach applies
 * here too).
 */

export interface EetSubmitResult {
  ok: boolean;
  pok?: string;
  test?: boolean;
  errorCode?: number;
  errorMessage?: string;
  raw: string;
}

const SOAP_ACTION = '"http://fs.gov.cz/eet/OdeslaniTrzby"';

export async function submitToEet(envelopeXml: string, endpoint: string): Promise<EetSubmitResult> {
  let text: string;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: SOAP_ACTION },
      body: envelopeXml,
    });
    text = await res.text();
  } catch (err) {
    return { ok: false, raw: err instanceof Error ? err.message : String(err) };
  }

  const pokMatch = text.match(/<[^>]*:?Potvrzeni\b[^>]*\bpok="([^"]+)"[^>]*\/?>/);
  if (pokMatch) {
    const testMatch = text.match(/<[^>]*:?Potvrzeni\b[^>]*\btest="(true|1)"/);
    return { ok: true, pok: pokMatch[1], test: Boolean(testMatch), raw: text };
  }

  const errMatch = text.match(/<([a-zA-Z0-9]+:)?Chyba\b[^>]*\bkod="(-?\d+)"[^>]*>([\s\S]*?)<\/[^>]*Chyba>/);
  if (errMatch) {
    const code = Number(errMatch[2]);
    const message = errMatch[3].trim();
    return { ok: false, errorCode: code, errorMessage: message, raw: text };
  }

  // Unparseable response (SOAP fault, HTML error page, connectivity-layer failure).
  return { ok: false, raw: text.slice(0, 2000) };
}
