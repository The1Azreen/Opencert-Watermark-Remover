// Turns certificate snapshots into a PDF.
//
// Each snapshot is loaded at the renderer's own origin and laid out with screen or print
// styles. When the certificate is made of "designed pages" (a certificate page, transcript
// pages, ...), each designed page is printed onto a PDF page sized exactly to it, then
// placed onto a real sheet (A4, Letter, ...) as a vector form, scaled to fit and centred.
// That keeps text and artwork vector-sharp and avoids pages spilling onto the next sheet.
// Long free-flowing content is paginated normally instead.

const { BrowserWindow, session } = require("electron");
const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");

const PT_PER_IN = 72;
const PX_PER_PT = 96 / 72;

// [width, height] in points, portrait
const SHEETS = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  Letter: [612, 792],
  Legal: [612, 1008],
  Tabloid: [792, 1224],
};

// Finds the designed pages. They are delimited by explicit CSS page breaks or, failing
// that, are a stack of page-shaped sibling blocks (e.g. one card per transcript page),
// which then get page breaks inserted between them.
const MEASURE_SRC = `(() => {
  const doc = document.documentElement;
  const visibleChildren = (el) =>
    Array.from(el.children).filter((c) => {
      const cs = getComputedStyle(c);
      if (cs.display === "none" || cs.position === "absolute" || cs.position === "fixed") return false;
      const r = c.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    });

  const breakCuts = () => {
    const cuts = [];
    for (const el of document.body.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (cs.display === "none") continue;
      const before = cs.breakBefore === "page" || cs.breakBefore === "always";
      const after = cs.breakAfter === "page" || cs.breakAfter === "always";
      if (!before && !after) continue;
      const r = el.getBoundingClientRect();
      if (before) cuts.push(r.top + scrollY);
      if (after) cuts.push(r.bottom + scrollY);
    }
    return cuts.filter((c) => c > 2 && c < doc.scrollHeight - 2);
  };

  const wide = (r) => r.width > doc.scrollWidth * 0.5;
  const pageShaped = (r) => wide(r) && r.height / r.width > 0.4 && r.height / r.width < 1.9;

  // Finest split of el into a vertical stack of page-shaped blocks, or null.
  const decompose = (el, depth = 0) => {
    const rect = el.getBoundingClientRect();
    const kids = depth < 25 ? visibleChildren(el) : [];
    const rects = kids.map((k) => k.getBoundingClientRect());
    const stacked = kids.length > 0 && rects.every((r, i) => wide(r) && (i === 0 || r.top >= rects[i - 1].bottom - 2));
    if (stacked) {
      const parts = kids.map((k) => decompose(k, depth + 1));
      if (parts.every(Boolean)) {
        const pages = parts.flat();
        if (pages.length > 1 || !pageShaped(rect)) return pages;
      }
    }
    return el !== document.body && pageShaped(rect) ? [el] : null;
  };

  let pageBlocks = 0;
  const explicitBreaks = breakCuts().length > 0;
  if (!explicitBreaks) {
    const pages = decompose(document.body);
    if (pages && pages.length > 1) {
      pages.forEach((p, i) => {
        p.style.setProperty("break-inside", "avoid", "important");
        if (i < pages.length - 1) p.style.setProperty("break-after", "page", "important");
      });
    }
    pageBlocks = pages ? pages.length : 0;
  }
  const trail = [];
  for (let el = document.body, d = 0; el && d < 8; d++) {
    const kids = visibleChildren(el);
    trail.push((el.className || el.tagName).toString().slice(0, 40) + " " + JSON.stringify(kids.slice(0, 6).map((k) => [Math.round(k.getBoundingClientRect().width), Math.round(k.getBoundingClientRect().height)])));
    el = kids.length === 1 ? kids[0] : kids.find((k) => visibleChildren(k).length > 0) || null;
  }

  const cuts = [0, doc.scrollHeight, ...breakCuts()].sort((a, b) => a - b);
  const segments = [];
  for (let i = 1; i < cuts.length; i++) {
    const h = cuts[i] - cuts[i - 1];
    if (h > 2) segments.push({ top: cuts[i - 1], height: h });
  }
  return { width: doc.scrollWidth, height: doc.scrollHeight, segments, explicitBreaks, pageBlocks, trail };
})()`;

// Renderer UI (toolbars, print buttons) is typically shown on screen but hidden in print.
// Step 1 (screen media) records what's visible; step 2 (print media) returns the topmost
// elements that print hides; step 3 (screen media) hides the small ones.
const CHROME_MARK_SRC = `(() => {
  for (const el of document.body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) el.setAttribute("data-ocwr-sv", Math.round(r.height));
  }
})()`;
const CHROME_FIND_SRC = `(() => {
  for (const el of document.querySelectorAll("[data-ocwr-sv]")) {
    const parent = el.parentElement;
    const hidden = getComputedStyle(el).display === "none" && parent && getComputedStyle(parent).display !== "none";
    if (hidden) el.setAttribute("data-ocwr-print-hidden", "");
  }
})()`;
const CHROME_HIDE_SRC = `(() => {
  const docHeight = document.documentElement.scrollHeight;
  let hidden = 0;
  for (const el of document.querySelectorAll("[data-ocwr-print-hidden]")) {
    if (Number(el.getAttribute("data-ocwr-sv")) < docHeight * 0.25) {
      el.style.setProperty("display", "none", "important");
      hidden++;
    }
  }
  for (const el of document.querySelectorAll("[data-ocwr-sv]")) el.removeAttribute("data-ocwr-sv");
  return hidden;
})()`;

const WAIT_FOR_ASSETS_SRC = `Promise.all([
  document.fonts.ready,
  ...Array.from(document.images).map((i) => (i.complete ? 0 : i.decode().catch(() => 0))),
]).then(() => new Promise((r) => setTimeout(r, 150)))`;

const debug = (...args) => process.env.OCWR_DEBUG && console.log(...args);

const sheetFor = (opts, landscape) => {
  const [w, h] = SHEETS[opts.page] || SHEETS.A4;
  return landscape ? [h, w] : [w, h];
};

const marginPt = (opts) => (opts.margins === "default" ? 0.4 * PT_PER_IN : 0);

// opts.orientation: "auto" | "portrait" | "landscape"
const orientationFor = (opts, width, height) =>
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

const setViewport = (dbg, width, height) =>
  dbg.sendCommand("Emulation.setDeviceMetricsOverride", {
    width: Math.round(width),
    height: Math.round(height),
    deviceScaleFactor: 1,
    mobile: false,
  });

// Returns a list of { pdf, segments } chunks for one snapshot.
// opts.media: "screen" (the look on opencerts.io) or "print" (the issuer's print styles).
const renderSnapshot = (snap, opts) =>
  withSnapshotWindow(snap, async (win, dbg) => {
    const print = opts.media === "print";
    // Emulated media also applies to printToPDF.
    await dbg.sendCommand("Emulation.setEmulatedMedia", { media: print ? "print" : "screen" });
    // Printed pages have no scrollbar, so measure without one too.
    await dbg.sendCommand("Emulation.setScrollbarsHidden", { hidden: true });

    const margins = { top: 0, bottom: 0, left: 0, right: 0 };
    const m = marginPt(opts) / PT_PER_IN;
    const sheetMargins = { top: m, bottom: m, left: m, right: m };

    // Layout width: what the user was looking at (screen), or the printable sheet width (print),
    // which may come from the certificate's own @page rule, so ask Chromium for it.
    let layoutWidth;
    let layoutHeight;
    if (print) {
      const [w, h] = sheetFor(opts, opts.orientation === "landscape");
      const probe = await PDFDocument.load(
        await win.webContents.printToPDF({
          printBackground: true,
          pageSize: { width: w / PT_PER_IN, height: h / PT_PER_IN },
          landscape: false,
          margins: sheetMargins,
          pageRanges: "1",
        })
      );
      const size = probe.getPage(0).getSize();
      layoutWidth = (size.width - 2 * marginPt(opts)) * PX_PER_PT;
      layoutHeight = (size.height - 2 * marginPt(opts)) * PX_PER_PT;
    } else {
      layoutWidth = Math.min(1600, Math.max(960, snap.width || 1200));
      layoutHeight = layoutWidth * 0.7071;
    }
    await setViewport(dbg, layoutWidth, layoutHeight);
    if (!print) {
      await win.webContents.executeJavaScript(CHROME_MARK_SRC);
      await dbg.sendCommand("Emulation.setEmulatedMedia", { media: "print" });
      await win.webContents.executeJavaScript(CHROME_FIND_SRC);
      await dbg.sendCommand("Emulation.setEmulatedMedia", { media: "screen" });
      debug("hid renderer UI elements:", await win.webContents.executeJavaScript(CHROME_HIDE_SRC));
    }
    const measure = await win.webContents.executeJavaScript(MEASURE_SRC);
    debug("measure", { layoutWidth, layoutHeight, ...measure, segments: measure.segments.map((s) => Math.round(s.height)) });

    const { width, height, segments } = measure;
    const designed = opts.fit !== false && (measure.explicitBreaks || measure.pageBlocks > 1 || height <= width * 1.6);

    if (!designed) {
      // Free-flowing content: paginate normally on the chosen sheet, scaled to the sheet width.
      const landscape = opts.orientation === "landscape";
      const [w, h] = sheetFor(opts, landscape);
      const printable = (w - 2 * marginPt(opts)) * PX_PER_PT;
      const scale = opts.fit === false ? Number(opts.scale) || 1 : Math.min(1, printable / width);
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: { width: w / PT_PER_IN, height: h / PT_PER_IN },
        landscape: false,
        margins: sheetMargins,
        scale: Math.min(2, Math.max(0.1, scale)),
      });
      return { pdf, place: false };
    }

    // One PDF page per designed page, sized to the tallest one. The issuer's @page rules
    // (e.g. "size: landscape") would override that, so drop them first.
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
    const pageWidth = Math.ceil(width);
    let pageHeight = Math.ceil(Math.max(...segments.map((s) => s.height))) + 4;
    let pdf;
    // Fragmentation can add a few pixels (e.g. table rows that can't split); if a designed
    // page still spills onto an extra sheet, give the pages more room and try again.
    for (let attempt = 0; attempt < 4; attempt++) {
      pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: { width: pageWidth / 96, height: pageHeight / 96 },
        landscape: false,
        margins,
      });
      const pages = (await PDFDocument.load(pdf)).getPageCount();
      debug("designed print", { attempt, pageWidth, pageHeight, pages, segments: segments.length });
      if (pages <= segments.length) break;
      pageHeight = Math.ceil(pageHeight * 1.08);
    }
    return { pdf, place: true, segments, width: pageWidth, pageHeight };
  });

// Places content-sized pages onto real sheets, scaled to fit and centred, keeping them vector.
const placeOnSheets = async (out, chunk, opts) => {
  const src = await PDFDocument.load(chunk.pdf);
  const pages = src.getPages();
  // If the browser produced exactly one page per designed page, trim each to its real height.
  const trim = pages.length === chunk.segments.length;
  debug("chunk", { pages: pages.length, segments: chunk.segments.length, size: pages[0] && pages[0].getSize(), expected: [chunk.width, chunk.pageHeight] });
  for (const [i, page] of pages.entries()) {
    const { width: pw, height: ph } = page.getSize();
    const contentH = trim ? Math.min(ph, chunk.segments[i].height / PX_PER_PT) : ph;
    const embedded = await out.embedPage(page, { left: 0, right: pw, top: ph, bottom: ph - contentH });
    const [sw, sh] = sheetFor(opts, orientationFor(opts, pw, contentH));
    const margin = marginPt(opts);
    const scale = Math.min((sw - 2 * margin) / pw, (sh - 2 * margin) / contentH);
    const sheet = out.addPage([sw, sh]);
    sheet.drawPage(embedded, {
      x: (sw - pw * scale) / 2,
      y: (sh - contentH * scale) / 2,
      width: pw * scale,
      height: contentH * scale,
    });
  }
};

// snapshots: [{ html, url, width }] -> PDF bytes
const exportSnapshots = async (snapshots, opts) => {
  const out = await PDFDocument.create();
  for (const snap of snapshots) {
    const chunk = await renderSnapshot(snap, opts);
    if (chunk.place) {
      await placeOnSheets(out, chunk, opts);
    } else {
      const src = await PDFDocument.load(chunk.pdf);
      for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
    }
  }
  out.setProducer("OpenCert Watermark Remover");
  out.setCreator("OpenCert Watermark Remover");
  return Buffer.from(await out.save());
};

module.exports = { exportSnapshots };
