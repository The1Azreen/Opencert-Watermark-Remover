// Turns certificate snapshots into a PDF.
//
// Each snapshot is laid out exactly as it was in the viewer (same width, same screen or print
// styles) and printed as one tall vector page. Every page region (detected automatically or
// drawn by the user) is then clipped out of that page and placed on its own sheet (A4,
// Letter, ...), scaled to fit and centred. Everything stays vector: text remains selectable
// and images keep their original resolution.

const { BrowserWindow, session } = require("electron");
const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");
const { detectPages } = require("./page-detect");

const PT_PER_IN = 72;
const PT_PER_PX = 72 / 96;
// Chromium/PDF page size limit is 200 in; stay below it.
const MAX_PAGE_PX = 19000;

// [width, height] in points, portrait
const SHEETS = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  Letter: [612, 792],
  Legal: [612, 1008],
  Tabloid: [792, 1224],
};

const WAIT_FOR_ASSETS_SRC = `Promise.all([
  document.fonts.ready,
  ...Array.from(document.images).map((i) => (i.complete ? 0 : i.decode().catch(() => 0))),
]).then(() => new Promise((r) => setTimeout(r, 150)))`;

const debug = (...args) => process.env.OCWR_DEBUG && console.log(...args);

const sheetFor = (opts, landscape) => {
  const [w, h] = SHEETS[opts.page] || SHEETS.A4;
  return landscape ? [h, w] : [w, h];
};

const sheetRatio = (opts) => {
  const [w, h] = SHEETS[opts.page] || SHEETS.A4;
  return h / w;
};

const marginPt = (opts) => (opts.margins === "default" ? 0.4 * PT_PER_IN : 0);

// opts.orientation: "auto" | "portrait" | "landscape"
const isLandscape = (opts, width, height) =>
  opts.orientation === "landscape" ? true : opts.orientation === "portrait" ? false : width > height;

let counter = 0;

// Loads a snapshot in a hidden window, served at the renderer's own origin from a throwaway
// session, so fonts, images and stylesheets load exactly as they did in the live renderer
// (including ones that need same-origin/CORS access).
const withSnapshotWindow = async (snap, fn) => {
  const id = ++counter;
  const ses = session.fromPartition(`ocwr-snapshot-${id}`, { cache: false });
  const pageUrl = new URL(`/__ocwr_snapshot_${id}.html`, snap.url).href;
  const handler = (request) =>
    request.url === pageUrl
      ? new Response(snap.html, { headers: { "content-type": "text/html; charset=utf-8" } })
      : ses.fetch(request, { bypassCustomProtocolHandlers: true });
  ses.protocol.handle("https", handler);
  ses.protocol.handle("http", handler);

  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true },
  });
  const dbg = win.webContents.debugger;
  try {
    // Debug aid: OCWR_DUMP_DIR=<dir> saves each snapshot's HTML.
    if (process.env.OCWR_DUMP_DIR) fs.writeFileSync(path.join(process.env.OCWR_DUMP_DIR, `snapshot-${id}.html`), snap.html);
    await win.loadURL(pageUrl);
    // Scripts are disabled by CSP in the snapshot; executeJavaScript is not affected.
    await win.webContents.executeJavaScript(WAIT_FOR_ASSETS_SRC);
    dbg.attach("1.3");
    return await fn(win, dbg);
  } finally {
    if (dbg.isAttached()) dbg.detach();
    win.destroy();
    ses.protocol.unhandle("https");
    ses.protocol.unhandle("http");
    ses.clearStorageData().catch(() => {});
  }
};

// Lays the snapshot out like the viewer did. Emulated media also applies to printToPDF.
const prepareLayout = async (win, dbg, snap, opts) => {
  await dbg.sendCommand("Emulation.setEmulatedMedia", { media: opts.media === "print" ? "print" : "screen" });
  await dbg.sendCommand("Emulation.setScrollbarsHidden", { hidden: true });
  await dbg.sendCommand("Emulation.setDeviceMetricsOverride", {
    width: Math.round(snap.viewportWidth || 1200),
    height: Math.round(snap.viewportHeight || 900),
    deviceScaleFactor: 1,
    mobile: false,
  });
  return win.webContents.executeJavaScript(
    "({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })"
  );
};

// Prints the whole document as a single page (scaled down if it is extremely tall),
// so page regions can be clipped out of it at their exact document coordinates.
const printWholeDocument = async (win, size) => {
  // The issuer's @page rules (e.g. "size: landscape") would override our page size.
  await win.webContents.executeJavaScript(`(() => {
    const strip = (list) => {
      for (let i = list.cssRules.length - 1; i >= 0; i--) {
        const rule = list.cssRules[i];
        if (rule instanceof CSSPageRule) list.deleteRule(i);
        else if (rule.cssRules) strip(rule);
      }
    };
    for (const sheet of document.styleSheets) {
      try { strip(sheet); } catch (e) { /* cross-origin */ }
    }
  })()`);
  const scale = Math.min(1, MAX_PAGE_PX / size.height, MAX_PAGE_PX / size.width);
  const pdf = await win.webContents.printToPDF({
    printBackground: true,
    pageSize: { width: (size.width * scale) / 96, height: (size.height * scale) / 96 + 0.01 },
    landscape: false,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    scale: Math.max(0.1, scale),
  });
  return { pdf, scale };
};

// Clips each region out of the tall page and places it on its own sheet.
const placeRegions = async (out, pdf, pxScale, regions, opts) => {
  const src = await PDFDocument.load(pdf);
  const page = src.getPage(0);
  const { height: ph } = page.getSize();
  const k = PT_PER_PX * pxScale; // document px -> points
  const margin = marginPt(opts);
  for (const r of regions) {
    const box = { left: r.x * k, right: (r.x + r.w) * k, top: ph - r.y * k, bottom: ph - (r.y + r.h) * k };
    const embedded = await out.embedPage(page, box);
    const w = box.right - box.left;
    const h = box.top - box.bottom;
    const [sw, sh] = sheetFor(opts, isLandscape(opts, w, h));
    const scale = Math.min((sw - 2 * margin) / w, (sh - 2 * margin) / h);
    const sheet = out.addPage([sw, sh]);
    sheet.drawPage(embedded, { x: (sw - w * scale) / 2, y: (sh - h * scale) / 2, width: w * scale, height: h * scale });
  }
};

// Without fitting: let Chromium paginate onto the chosen sheet, as a browser print would.
const printPaginated = (win, opts) => {
  const landscape = opts.orientation === "landscape";
  const [w, h] = sheetFor(opts, landscape);
  const m = marginPt(opts) / PT_PER_IN;
  return win.webContents.printToPDF({
    printBackground: true,
    pageSize: { width: w / PT_PER_IN, height: h / PT_PER_IN },
    landscape: false,
    margins: { top: m, bottom: m, left: m, right: m },
    scale: Math.min(2, Math.max(0.1, Number(opts.scale) || 1)),
  });
};

// snapshots: [{ html, url, viewportWidth, viewportHeight, pages? }] -> PDF bytes
// `pages` are the regions to export, in document pixels; when absent they are detected.
// opts.media: "screen" (the look on opencerts.io) or "print" (the issuer's print styles).
const exportSnapshots = async (snapshots, opts) => {
  const out = await PDFDocument.create();
  for (const snap of snapshots) {
    await withSnapshotWindow(snap, async (win, dbg) => {
      const size = await prepareLayout(win, dbg, snap, opts);
      if (opts.fit === false) {
        const src = await PDFDocument.load(await printPaginated(win, opts));
        for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
        return;
      }
      let regions = snap.pages && snap.pages.length ? snap.pages : null;
      if (!regions) {
        const detected = await win.webContents.executeJavaScript(`(${detectPages.toString()})(${sheetRatio(opts)})`);
        regions = detected.pages;
        debug("detected", detected.source, detected.pages);
      }
      // keep regions inside the document
      regions = regions
        .map((r) => {
          const x = Math.max(0, r.x);
          const y = Math.max(0, r.y);
          return { x, y, w: Math.min(size.width, r.x + r.w) - x, h: Math.min(size.height, r.y + r.h) - y };
        })
        .filter((r) => r.w > 2 && r.h > 2);
      const { pdf, scale } = await printWholeDocument(win, size);
      debug("layout", { ...size, scale, regions });
      if (process.env.OCWR_DUMP_DIR) fs.writeFileSync(path.join(process.env.OCWR_DUMP_DIR, `whole-${counter}.pdf`), pdf);
      await placeRegions(out, pdf, scale, regions, opts);
    });
  }
  out.setProducer("OpenCert Watermark Remover");
  out.setCreator("OpenCert Watermark Remover");
  return Buffer.from(await out.save());
};

module.exports = { exportSnapshots, sheetRatio };
