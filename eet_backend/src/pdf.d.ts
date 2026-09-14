/**
 * `.pdf` files are imported as binary Data modules (see `rules` in
 * wrangler.jsonc) — the bundler hands them over as an ArrayBuffer, which is
 * what `PDFDocument.load` wants.
 */
declare module "*.pdf" {
  const bytes: ArrayBuffer;
  export default bytes;
}
