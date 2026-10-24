// "Snipping tool" for page regions, drawn over the certificate frame.
// Regions are in the frame's document pixels; the overlay is laid over the iframe 1:1.
//  - drag anywhere (also inside a page): draw a new page
//  - drag a page's label: move it; drag an edge or corner handle: resize it
//  - click a page: select it; × or Delete/Backspace: remove the selected page

const MIN_SIZE = 16;
const HANDLES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

const byPosition = (a, b) => (Math.abs(a.y - b.y) > 8 ? a.y - b.y : a.x - b.x);

export function createPageEditor(container, { onChange }) {
  const overlay = document.createElement("div");
  overlay.className = "page-overlay";
  overlay.hidden = true;
  overlay.tabIndex = -1;
  container.appendChild(overlay);

  let pages = [];
  let selected = null;
  let drag = null;

  const bounds = () => ({ w: overlay.clientWidth, h: overlay.clientHeight });
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const point = (e) => {
    const r = overlay.getBoundingClientRect();
    const { w, h } = bounds();
    return { x: clamp(e.clientX - r.left, 0, w), y: clamp(e.clientY - r.top, 0, h) };
  };

  const changed = () => {
    pages.sort(byPosition);
    render();
    onChange(getPages());
  };

  function render() {
    overlay.textContent = "";
    pages.forEach((p, i) => {
      const box = document.createElement("div");
      box.className = "page-box" + (p === selected ? " selected" : "");
      Object.assign(box.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px`, height: `${p.h}px` });
      box.dataset.index = i;

      const label = document.createElement("span");
      label.className = "page-label";
      label.textContent = `Page ${i + 1}`;
      label.title = "Drag to move";
      label.dataset.dir = "move";
      const del = document.createElement("button");
      del.className = "page-del";
      del.title = "Remove this page";
      del.setAttribute("aria-label", `Remove page ${i + 1}`);
      del.textContent = "×";
      del.dataset.action = "delete";
      box.append(label, del);
      for (const dir of HANDLES) {
        const h = document.createElement("span");
        h.className = `handle handle-${dir}`;
        h.dataset.dir = dir;
        box.appendChild(h);
      }
      overlay.appendChild(box);
    });
  }

  overlay.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const boxEl = e.target.closest(".page-box");
    const p = point(e);
    overlay.focus({ preventScroll: true });
    if (e.target.dataset.action === "delete" && boxEl) {
      const page = pages[Number(boxEl.dataset.index)];
      pages = pages.filter((x) => x !== page);
      selected = null;
      changed();
      return;
    }
    e.preventDefault();
    overlay.setPointerCapture(e.pointerId);
    const under = boxEl ? pages[Number(boxEl.dataset.index)] : null;
    if (under && e.target.dataset.dir) {
      selected = under;
      drag = { mode: e.target.dataset.dir, page: under, start: p, orig: { ...under } };
    } else {
      // a plain click (no drag) on a page selects it instead
      const page = { x: p.x, y: p.y, w: 0, h: 0 };
      pages.push(page);
      drag = { mode: "new", page, start: p, orig: { ...page }, under };
    }
    render();
  });

  overlay.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = point(e);
    const { w: W, h: H } = bounds();
    const { page, orig, start } = drag;
    const dx = p.x - start.x;
    const dy = p.y - start.y;
    if (drag.mode === "new") {
      page.x = Math.min(start.x, p.x);
      page.y = Math.min(start.y, p.y);
      page.w = Math.abs(dx);
      page.h = Math.abs(dy);
    } else if (drag.mode === "move") {
      page.x = clamp(orig.x + dx, 0, W - orig.w);
      page.y = clamp(orig.y + dy, 0, H - orig.h);
    } else {
      let { x, y } = orig;
      let right = orig.x + orig.w;
      let bottom = orig.y + orig.h;
      if (drag.mode.includes("w")) x = clamp(orig.x + dx, 0, right - MIN_SIZE);
      if (drag.mode.includes("e")) right = clamp(right + dx, x + MIN_SIZE, W);
      if (drag.mode.includes("n")) y = clamp(orig.y + dy, 0, bottom - MIN_SIZE);
      if (drag.mode.includes("s")) bottom = clamp(bottom + dy, y + MIN_SIZE, H);
      Object.assign(page, { x, y, w: right - x, h: bottom - y });
    }
    render();
  });

  const endDrag = () => {
    if (!drag) return;
    const { page, mode, orig, under } = drag;
    drag = null;
    const unchanged = ["x", "y", "w", "h"].every((k) => page[k] === orig[k]);
    if (mode !== "new" && unchanged) return; // just a selection click
    if (mode === "new" && (page.w < MIN_SIZE || page.h < MIN_SIZE)) {
      pages = pages.filter((x) => x !== page);
      selected = under;
      render();
      return;
    }
    if (mode === "new") selected = page;
    changed();
  };
  overlay.addEventListener("pointerup", endDrag);
  overlay.addEventListener("pointercancel", endDrag);

  overlay.addEventListener("keydown", (e) => {
    if ((e.key === "Delete" || e.key === "Backspace") && selected) {
      pages = pages.filter((x) => x !== selected);
      selected = null;
      changed();
    }
  });

  function getPages() {
    return pages.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.w), h: Math.round(p.h) }));
  }

  return {
    setPages(list) {
      pages = (list || []).map((p) => ({ ...p })).sort(byPosition);
      selected = null;
      render();
    },
    getPages,
    // Lays the overlay exactly over the iframe.
    position(iframe) {
      Object.assign(overlay.style, {
        left: `${iframe.offsetLeft}px`,
        top: `${iframe.offsetTop}px`,
        width: `${iframe.offsetWidth}px`,
        height: `${iframe.offsetHeight}px`,
      });
    },
    show() {
      overlay.hidden = false;
    },
    hide() {
      overlay.hidden = true;
      drag = null;
    },
    get visible() {
      return !overlay.hidden;
    },
  };
}
