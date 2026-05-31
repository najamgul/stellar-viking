/**
 * PDF Export API — Puppeteer-based PDF generation
 * 
 * POST /api/export-pdf
 * Body: { html: string, filename: string }
 * Returns: PDF file as binary download
 */

import puppeteer from 'puppeteer';
import logger from '../utils/logger.js';

let browserInstance = null;

/**
 * Get or create a shared Puppeteer browser instance.
 * Reuses the browser across requests for performance.
 */
async function getBrowser() {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }

  logger.info('🖨️ Launching Puppeteer browser for PDF generation...');
  browserInstance = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=none',
    ],
  });

  // If the browser disconnects, clear the reference
  browserInstance.on('disconnected', () => {
    browserInstance = null;
  });

  return browserInstance;
}

/**
 * Register the PDF export route on the Fastify app.
 */
export function registerPdfExport(app) {
  app.post('/api/export-pdf', async (request, reply) => {
    const { html, filename = 'tour-package.pdf' } = request.body || {};

    if (!html) {
      return reply.code(400).send({ error: 'Missing "html" in request body' });
    }

    let page;
    try {
      const browser = await getBrowser();
      page = await browser.newPage();

      // Full HTML document with styles embedded
      const fullHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;0,800;1,400&family=Inter:wght@300;400;500;600;700&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Outfit', 'Inter', system-ui, sans-serif;
      color: #1a1a2e;
      background: #ffffff;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    .pdf-document {
      width: 100%;
      background: #ffffff;
      color: #1a1a2e;
      font-family: 'Inter', 'Outfit', system-ui, sans-serif;
    }

    .pdf-document * { color: #1a1a2e; }

    .pdf-header {
      background: linear-gradient(135deg, #1a1a2e 0%, #2d2b55 100%);
      padding: 36px 40px 32px;
      position: relative;
      overflow: hidden;
    }

    .pdf-header::before {
      content: '';
      position: absolute;
      top: -40px; right: -40px;
      width: 200px; height: 200px;
      background: rgba(201,164,78,0.1);
      border-radius: 50%;
    }

    .pdf-header::after {
      content: '';
      position: absolute;
      bottom: -60px; left: 30%;
      width: 300px; height: 300px;
      background: rgba(62,198,193,0.05);
      border-radius: 50%;
    }

    .pdf-header * { color: #ffffff !important; }

    .pdf-company-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 24px;
      position: relative;
      z-index: 1;
    }

    .pdf-company-name {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 1.8rem;
      font-weight: 700;
      color: #c9a44e !important;
    }

    .pdf-company-contact {
      text-align: right;
      font-size: 0.78rem;
      line-height: 1.8;
      opacity: 0.85;
    }

    .pdf-title-block {
      position: relative;
      z-index: 1;
    }

    .pdf-tour-title {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 2rem;
      font-weight: 800;
      line-height: 1.2;
      margin-bottom: 6px;
    }

    .pdf-tour-subtitle {
      font-size: 0.92rem;
      opacity: 0.8;
    }

    .pdf-meta-strip {
      display: flex;
      gap: 0;
      background: #c9a44e;
    }

    .pdf-meta-item {
      flex: 1;
      padding: 12px 16px;
      text-align: center;
      border-right: 1px solid rgba(26,26,46,0.15);
    }

    .pdf-meta-item:last-child { border-right: none; }
    .pdf-meta-item * { color: #1a1a2e !important; }

    .pdf-meta-label {
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 1px;
      font-weight: 600;
      opacity: 0.7;
    }

    .pdf-meta-value {
      font-size: 0.9rem;
      font-weight: 700;
      margin-top: 2px;
    }

    .pdf-body { padding: 32px 40px; }

    .pdf-section { margin-bottom: 28px; }

    .pdf-section-title {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 1.15rem;
      font-weight: 700;
      color: #1a1a2e;
      padding-bottom: 8px;
      margin-bottom: 14px;
      border-bottom: 2px solid #c9a44e;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .pdf-section-title .icon { font-size: 1rem; }

    .pdf-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 4px;
    }

    .pdf-table th {
      background: #f0ebe0;
      text-align: left;
      padding: 9px 14px;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: 600;
      color: #1a1a2e;
      border-bottom: 2px solid #c9a44e;
    }

    .pdf-table td {
      padding: 10px 14px;
      font-size: 0.88rem;
      border-bottom: 1px solid #ece8e0;
      color: #333;
    }

    .pdf-table tr:last-child td { border-bottom: none; }
    .pdf-table tr:nth-child(even) td { background: #faf8f5; }

    .pdf-itinerary { display: flex; flex-direction: column; gap: 0; }

    .pdf-itin-day {
      display: grid;
      grid-template-columns: 70px 1fr;
      gap: 0;
      position: relative;
    }

    .pdf-itin-marker {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding-top: 14px;
    }

    .pdf-itin-dot {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: linear-gradient(135deg, #1a1a2e, #2d2b55);
      color: #c9a44e !important;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.72rem;
      font-weight: 700;
      z-index: 1;
    }

    .pdf-itin-line {
      width: 2px;
      flex: 1;
      background: #ddd8ce;
      margin-top: 4px;
    }

    .pdf-itin-day:last-child .pdf-itin-line { display: none; }

    .pdf-itin-content {
      padding: 12px 16px;
      border-bottom: 1px solid #f0ebe0;
    }

    .pdf-itin-day:last-child .pdf-itin-content { border-bottom: none; }

    .pdf-itin-title {
      font-weight: 700;
      font-size: 0.95rem;
      color: #1a1a2e;
      margin-bottom: 2px;
    }

    .pdf-itin-location {
      font-size: 0.78rem;
      color: #c9a44e;
      font-weight: 600;
      margin-bottom: 4px;
    }

    .pdf-itin-desc {
      font-size: 0.84rem;
      color: #555;
      line-height: 1.6;
    }

    .pdf-two-col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
    }

    .pdf-list { list-style: none; padding: 0; }

    .pdf-list li {
      padding: 6px 0;
      font-size: 0.86rem;
      color: #444;
      display: flex;
      align-items: flex-start;
      gap: 8px;
      border-bottom: 1px solid #f5f2ed;
    }

    .pdf-list li:last-child { border-bottom: none; }
    .pdf-list .check { color: #22c55e; font-weight: bold; flex-shrink: 0; }
    .pdf-list .cross { color: #ef4444; font-weight: bold; flex-shrink: 0; }

    .pdf-pricing-box {
      background: linear-gradient(135deg, #1a1a2e 0%, #2d2b55 100%);
      border-radius: 10px;
      padding: 24px 28px;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 20px;
      align-items: center;
    }

    .pdf-pricing-box * { color: #ffffff !important; }

    .pdf-pricing-breakdown {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .pdf-price-line {
      display: flex;
      justify-content: space-between;
      gap: 40px;
      font-size: 0.88rem;
      opacity: 0.85;
    }

    .pdf-price-line.total {
      font-size: 1.1rem;
      font-weight: 700;
      opacity: 1;
      padding-top: 8px;
      margin-top: 4px;
      border-top: 1px solid rgba(255,255,255,0.15);
    }

    .pdf-total-badge { text-align: center; }

    .pdf-total-label {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 1px;
      opacity: 0.7;
      margin-bottom: 4px;
    }

    .pdf-total-amount {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 2.2rem;
      font-weight: 800;
      color: #c9a44e !important;
    }

    .pdf-terms { font-size: 0.76rem; color: #888; line-height: 1.7; }
    .pdf-terms h5 { font-size: 0.8rem; color: #555; margin-bottom: 6px; }
    .pdf-terms ul { padding-left: 16px; list-style: disc; }
    .pdf-terms li { margin-bottom: 3px; }

    .pdf-footer {
      background: #f8f6f2;
      padding: 16px 40px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-top: 2px solid #c9a44e;
      font-size: 0.75rem;
      color: #888;
    }

    .pdf-footer-brand {
      font-family: 'Playfair Display', Georgia, serif;
      font-weight: 700;
      color: #1a1a2e;
      font-size: 0.85rem;
    }
  </style>
</head>
<body>
  ${html}
</body>
</html>`;

      await page.setContent(fullHtml, {
        waitUntil: 'networkidle0',
        timeout: 30000,
      });

      // Wait for fonts to load
      await page.evaluateHandle('document.fonts.ready');

      // Small delay to ensure full render
      await new Promise(r => setTimeout(r, 500));

      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: {
          top: '0mm',
          right: '0mm',
          bottom: '0mm',
          left: '0mm',
        },
        preferCSSPageSize: false,
      });

      const sanitizedFilename = filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_');

      reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${sanitizedFilename}"`)
        .header('Content-Length', pdfBuffer.length)
        .send(pdfBuffer);

    } catch (err) {
      logger.error({ error: err.message, stack: err.stack }, '❌ PDF generation failed');
      reply.code(500).send({ error: 'PDF generation failed', details: err.message });
    } finally {
      if (page) {
        try { await page.close(); } catch (e) { /* ignore */ }
      }
    }
  });

  logger.info('📄 PDF export endpoint registered at POST /api/export-pdf');
}

/**
 * Cleanup browser on server shutdown
 */
export async function closePdfBrowser() {
  if (browserInstance) {
    try {
      await browserInstance.close();
      browserInstance = null;
    } catch (e) { /* ignore */ }
  }
}
