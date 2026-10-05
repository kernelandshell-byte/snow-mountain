// Entry point for the pdf.js worker. Module imports run in order, so the
// polyfills are in place before the vendored worker code evaluates.
import '../vendor/pdfjs/polyfills.js';
import '../vendor/pdfjs/pdf.worker.mjs';
