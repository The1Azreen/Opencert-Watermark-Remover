// Automatic page detection, injected into the renderer frame and the export window.
// `detectPages` is serialised with toString(), so it must be fully self-contained.
//
// Returns { width, height, pages: [{ x, y, w, h }] } in document pixels:
//  1. explicit CSS page breaks, or a vertical stack of page-shaped blocks (e.g. one card
//     per transcript page), give the designed pages;
//  2. otherwise the content's bounding box is one page;
//  3. a page much taller than the sheet is split at whitespace between text lines,
//     images and table rows, so nothing is cut in half.

/* eslint-disable no-undef */
function detectPages(sheetRatio) {
  const doc = document.documentElement;
  const W = doc.scrollWidth;
  const H = doc.scrollHeight;
  const sx = window.scrollX;
  const sy = window.scrollY;
  const toDoc = (r) => ({ left: r.left + sx, top: r.top + sy, right: r.right + sx, bottom: r.bottom + sy });

  const shown = (el) => {
    for (let e = el; e && e !== doc; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.opacity === "0") return false;
    }
    return getComputedStyle(el).visibility !== "hidden";
  };

  // ---- atoms: things a cut must not pass through, and that make up the content ----
  const lines = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim() || !n.parentElement || !shown(n.parentElement)) continue;
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) lines.push(toDoc(r));
  }
  const solids = []; // images, rows: no cut through them
  const boxes = []; // painted boxes (backgrounds, borders): part of the content
  for (const el of document.body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const tag = el.tagName.toLowerCase();
    if (["img", "svg", "canvas", "video", "picture", "object", "embed", "input", "textarea", "select", "tr"].includes(tag)) {
      if (shown(el)) solids.push(toDoc(r));
      continue;
    }
    // full-width backgrounds (page backdrops) don't count as content
    if (r.width >= W * 0.98) continue;
    const cs = getComputedStyle(el);
    const painted =
      (cs.backgroundImage !== "none" && !el.hasAttribute("data-ocwr-wm")) ||
      !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor) ||
      ["Top", "Right", "Bottom", "Left"].some((s) => parseFloat(cs["border" + s + "Width"]) > 0 && cs["border" + s + "Style"] !== "none");
    if (painted && shown(el)) boxes.push(toDoc(r));
  }
  const atoms = lines.concat(solids);

  const within = (r, area) => r.bottom > area.top && r.top < area.bottom && r.right > area.left && r.left < area.right;
  const contentBox = (area) => {
    let box = null;
    for (const r of atoms.concat(boxes)) {
      if (!within(r, area)) continue;
      const c = {
        left: Math.max(r.left, area.left),
        top: Math.max(r.top, area.top),
        right: Math.min(r.right, area.right),
        bottom: Math.min(r.bottom, area.bottom),
      };
      box = box
        ? { left: Math.min(box.left, c.left), top: Math.min(box.top, c.top), right: Math.max(box.right, c.right), bottom: Math.max(box.bottom, c.bottom) }
        : c;
    }
    return box;
  };
  const pad = (b, p) => ({
    left: Math.max(0, b.left - p),
    top: Math.max(0, b.top - p),
    right: Math.min(W, b.right + p),
    bottom: Math.min(H, b.bottom + p),
  });

  // ---- 1. designed pages ----
  const visibleChildren = (el) =>
    Array.from(el.children).filter((c) => {
      const cs = getComputedStyle(c);
      if (cs.display === "none" || cs.position === "absolute" || cs.position === "fixed") return false;
      const r = c.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    });
  const wide = (r) => r.width > W * 0.5;
  const pageShaped = (r) => wide(r) && r.height / r.width > 0.4 && r.height / r.width < 1.9;
  // Finest split of el into a vertical stack of page-shaped blocks, or null.
  const decompose = (el, depth) => {
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

  const breaks = [];
  for (const el of document.body.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none") continue;
    const r = toDoc(el.getBoundingClientRect());
    if (cs.breakBefore === "page" || cs.breakBefore === "always") breaks.push(r.top);
    if (cs.breakAfter === "page" || cs.breakAfter === "always") breaks.push(r.bottom);
  }
  const cuts = [0, H, ...breaks.filter((c) => c > 2 && c < H - 2)].sort((a, b) => a - b);

  let regions = [];
  let source = "content";
  if (cuts.length > 2) {
    source = "page-breaks";
    for (let i = 1; i < cuts.length; i++) {
      const box = contentBox({ left: 0, top: cuts[i - 1], right: W, bottom: cuts[i] });
      if (box && box.bottom - box.top > 4) regions.push({ ...pad(box, 12), split: true });
    }
  } else {
    const blocks = decompose(document.body, 0);
    if (blocks && blocks.length) {
      source = "page-blocks";
      regions = blocks.map((b) => ({ ...toDoc(b.getBoundingClientRect()), split: blocks.length === 1 }));
    } else {
      const box = contentBox({ left: 0, top: 0, right: W, bottom: H });
      if (box) regions.push({ ...pad(box, 16), split: true });
    }
  }
  if (!regions.length) regions.push({ left: 0, top: 0, right: W, bottom: H, split: true });

  // ---- 3. split pages that are much taller than a sheet ----
  const blocked = atoms.map((r) => [r.top, r.bottom]).sort((a, b) => a[0] - b[0]);
  // best y in [lo, hi] that doesn't cross an atom, preferring the lowest one
  const safeCut = (lo, hi, left, right) => {
    const spans = blocked.filter(([t, b]) => b > lo && t < hi);
    let best = null;
    let y = lo;
    const gaps = [];
    for (const [t, b] of spans) {
      if (t > y) gaps.push([y, t]);
      y = Math.max(y, b);
    }
    if (y < hi) gaps.push([y, hi]);
    for (const [a, b] of gaps) if (b - a >= 1) best = b === hi ? hi : (a + b) / 2;
    return best;
  };

  const pages = [];
  for (const r of regions) {
    const w = r.right - r.left;
    const maxH = w * sheetRatio;
    let top = r.top;
    if (r.split && r.bottom - r.top > maxH * 1.2) {
      while (r.bottom - top > maxH * 1.05) {
        const cut = safeCut(top + maxH * 0.6, top + maxH, r.left, r.right) || top + maxH;
        pages.push({ x: r.left, y: top, w, h: cut - top });
        top = cut;
      }
    }
    pages.push({ x: r.left, y: top, w, h: r.bottom - top });
  }
  const round = (p) => ({ x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.w), h: Math.round(p.h) });
  return { width: W, height: H, source, pages: pages.filter((p) => p.w > 4 && p.h > 4).map(round) };
}

module.exports = { detectPages };
