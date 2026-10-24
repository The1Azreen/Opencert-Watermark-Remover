// Code injected into the issuer's renderer iframe (via webFrameMain.executeJavaScript).
// `installHelpers` is serialised with toString(), so it must be fully self-contained.

/* eslint-disable no-undef */
function installHelpers() {
  if (window.__ocwr) return;

  const WM_ATTR = "data-ocwr-wm"; // "hide" | "bg": auto-detected watermark
  const PICK_ATTR = "data-ocwr-hide"; // hidden by the user in pick mode
  const CHROME_ATTR = "data-ocwr-chrome"; // renderer UI (toolbars, print buttons)
  const STYLE_ID = "ocwr-removal-style";
  const WATERMARK_RE = /watermark/i;

  const state = {
    removal: true,
    pick: false,
    hovered: null,
    pseudoRules: [], // override CSS for ::before/::after watermark rules
    selectors: [],
  };

  // Walk every readable stylesheet, including rules nested in @media/@supports.
  const eachStyleRule = (fn) => {
    const walk = (rules) => {
      for (const rule of Array.from(rules || [])) {
        if (rule.selectorText !== undefined) fn(rule);
        if (rule.cssRules) walk(rule.cssRules);
      }
    };
    const sheets = Array.from(document.styleSheets).concat(Array.from(document.adoptedStyleSheets || []));
    for (const sheet of sheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (e) {
        continue; // cross-origin sheet (e.g. a CDN framework); not where watermarks live
      }
      walk(rules);
    }
  };

  const hasVisibleContent = (el) =>
    el.textContent.trim() !== "" || el.querySelector("img, svg, canvas, video, picture, object, embed") !== null;

  const mark = (el, kind) => {
    if (el.closest && el.closest(`#${STYLE_ID}`)) return;
    // never downgrade "hide" to "bg"
    if (el.getAttribute(WM_ATTR) !== "hide") el.setAttribute(WM_ATTR, kind);
  };

  const markByContent = (el) => mark(el, hasVisibleContent(el) ? "bg" : "hide");

  const scan = () => {
    document.querySelectorAll(`[${WM_ATTR}]`).forEach((el) => el.removeAttribute(WM_ATTR));
    const selectors = new Set();
    const pseudoRules = new Set();

    // 1. CSS rules that mention a watermark (selector, class name or background image URL).
    //    This is how OpenCerts renderers do it: a print-only overlay div with
    //    `background-image: url(.../watermark.svg)` and a hashed class name.
    eachStyleRule((rule) => {
      if (!WATERMARK_RE.test(rule.cssText)) return;
      for (const selector of rule.selectorText.split(",").map((s) => s.trim())) {
        if (/::?(before|after)\b/i.test(selector)) {
          pseudoRules.add(`${selector}{background-image:none!important;content:none!important;display:none!important}`);
          continue;
        }
        let matches;
        try {
          matches = document.querySelectorAll(selector);
        } catch (e) {
          continue;
        }
        if (matches.length) selectors.add(selector);
        matches.forEach(markByContent);
      }
    });

    // 2. Elements that reference a watermark directly.
    document
      .querySelectorAll('[class*="watermark" i], [id*="watermark" i], [style*="watermark" i]')
      .forEach(markByContent);
    document.querySelectorAll('img[src*="watermark" i], img[srcset*="watermark" i]').forEach((el) => mark(el, "hide"));
    document.querySelectorAll("image").forEach((el) => {
      const href = el.getAttribute("href") || el.getAttribute("xlink:href") || "";
      if (WATERMARK_RE.test(href)) mark(el, "hide");
    });

    state.selectors = Array.from(selectors);
    state.pseudoRules = Array.from(pseudoRules);
    applyStyle();
    return report();
  };

  const report = () => ({
    removal: state.removal,
    pick: state.pick,
    watermarks: document.querySelectorAll(`[${WM_ATTR}]`).length + state.pseudoRules.length,
    selectors: state.selectors,
    picked: document.querySelectorAll(`[${PICK_ATTR}]`).length,
  });

  const applyStyle = () => {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    // Hidden user picks and renderer UI keep their layout space so nothing shifts.
    const css = [`[${PICK_ATTR}]{visibility:hidden!important}`, `[${CHROME_ATTR}]{visibility:hidden!important}`];
    if (state.removal) {
      css.push(
        `[${WM_ATTR}="hide"]{display:none!important}`,
        `[${WM_ATTR}="bg"]{background-image:none!important}`,
        ...state.pseudoRules
      );
    }
    if (state.pick) {
      css.push(
        `[${PICK_ATTR}]{visibility:visible!important;opacity:.25!important;outline:2px dashed #d33!important}`,
        "*{cursor:crosshair!important}"
      );
    }
    style.textContent = css.join("\n");
  };

  // ---- pick mode: click any element to hide/unhide it ----
  const setHover = (el) => {
    if (state.hovered) {
      state.hovered.style.removeProperty("outline");
      state.hovered.style.removeProperty("outline-offset");
    }
    state.hovered = el;
    if (el) {
      el.style.setProperty("outline", "2px solid #2b7cff", "important");
      el.style.setProperty("outline-offset", "-2px", "important");
    }
  };
  const onMove = (e) => setHover(e.target === document.documentElement || e.target === document.body ? null : e.target);
  const onClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    if (el === document.documentElement || el === document.body) return;
    if (el.hasAttribute(PICK_ATTR)) el.removeAttribute(PICK_ATTR);
    else el.setAttribute(PICK_ATTR, "");
  };
  const swallow = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const setPick = (on) => {
    state.pick = !!on;
    const method = on ? "addEventListener" : "removeEventListener";
    document[method]("mousemove", onMove, true);
    document[method]("click", onClick, true);
    document[method]("mousedown", swallow, true);
    document[method]("mouseup", swallow, true);
    if (!on) setHover(null);
    applyStyle();
    return report();
  };

  const setRemoval = (on) => {
    state.removal = !!on;
    applyStyle();
    return report();
  };

  const clearPicks = () => {
    document.querySelectorAll(`[${PICK_ATTR}]`).forEach((el) => el.removeAttribute(PICK_ATTR));
    return report();
  };

  // ---- snapshot: a static, script-free copy of the rendered certificate ----
  const blobToDataUrl = (url) =>
    fetch(url)
      .then((r) => r.blob())
      .then(
        (blob) =>
          new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => resolve(url);
            reader.readAsDataURL(blob);
          })
      )
      .catch(() => url);

  const snapshot = async () => {
    const pick = state.pick;
    if (pick) setPick(false);
    scan();
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images).map((img) => (img.complete ? null : img.decode().catch(() => null)))
    );

    const clone = document.documentElement.cloneNode(true);

    // CSS-in-JS libraries (emotion, styled-components) insert rules through the CSSOM,
    // which cloneNode doesn't copy, so serialise each <style>'s live rules instead.
    const liveStyles = document.querySelectorAll("style");
    const clonedStyles = clone.querySelectorAll("style");
    liveStyles.forEach((live, i) => {
      try {
        if (live.sheet && clonedStyles[i]) {
          clonedStyles[i].textContent = Array.from(live.sheet.cssRules)
            .map((r) => r.cssText)
            .join("\n");
        }
      } catch (e) {
        // keep original text
      }
    });
    const head = clone.querySelector("head") || clone.insertBefore(document.createElement("head"), clone.firstChild);
    for (const sheet of Array.from(document.adoptedStyleSheets || [])) {
      const style = document.createElement("style");
      style.textContent = Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join("\n");
      head.appendChild(style);
    }

    // Canvases (e.g. QR codes) lose their pixels when cloned.
    const liveCanvases = document.querySelectorAll("canvas");
    const clonedCanvases = clone.querySelectorAll("canvas");
    liveCanvases.forEach((live, i) => {
      const target = clonedCanvases[i];
      if (!target) return;
      try {
        const img = document.createElement("img");
        img.src = live.toDataURL("image/png");
        for (const attr of Array.from(live.attributes)) img.setAttribute(attr.name, attr.value);
        img.style.width = img.style.width || `${live.clientWidth}px`;
        img.style.height = img.style.height || `${live.clientHeight}px`;
        target.replaceWith(img);
      } catch (e) {
        // tainted canvas; leave it blank
      }
    });

    // Form values are properties, not attributes.
    const liveFields = document.querySelectorAll("input, textarea, select");
    const clonedFields = clone.querySelectorAll("input, textarea, select");
    liveFields.forEach((live, i) => {
      const target = clonedFields[i];
      if (!target) return;
      if (live.tagName === "TEXTAREA") target.textContent = live.value;
      else if (live.tagName === "SELECT") target.querySelectorAll("option")[live.selectedIndex]?.setAttribute("selected", "");
      else if (live.type === "checkbox" || live.type === "radio") live.checked && target.setAttribute("checked", "");
      else target.setAttribute("value", live.value);
    });

    // Images: pin the resolved URL, inline blob: URLs (they die with this frame).
    const liveImgs = document.querySelectorAll("img");
    const clonedImgs = clone.querySelectorAll("img");
    await Promise.all(
      Array.from(liveImgs).map(async (live, i) => {
        const target = clonedImgs[i];
        if (!target || !live.currentSrc) return;
        const src = live.currentSrc.startsWith("blob:") ? await blobToDataUrl(live.currentSrc) : live.currentSrc;
        target.setAttribute("src", src);
        target.removeAttribute("srcset");
        target.removeAttribute("loading");
      })
    );

    clone.querySelectorAll("script, noscript, base, link[rel=preload], link[rel=modulepreload], link[rel=prefetch]").forEach((el) => el.remove());
    clone.querySelectorAll("[style]").forEach((el) => {
      // drop pick-mode hover outline if any
      if (el.style.outline.includes("rgb(43, 124, 255)")) {
        el.style.removeProperty("outline");
        el.style.removeProperty("outline-offset");
      }
    });

    const base = document.createElement("base");
    base.href = document.baseURI;
    const csp = document.createElement("meta");
    csp.httpEquiv = "Content-Security-Policy";
    csp.content = "script-src 'none'";
    head.insertBefore(csp, head.firstChild);
    head.insertBefore(base, head.firstChild);

    if (pick) setPick(true);

    return {
      html: "<!DOCTYPE html>\n" + clone.outerHTML,
      url: location.href,
      title: document.title,
      width: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  };

  // ---- renderer UI detection ----
  // Renderer controls (toolbars, print buttons) show on screen but are hidden when printing.
  // The main process switches the frame to print media between chromeBefore() and
  // chromeDuring(), then back before chromeAfter(), which marks the small ones.
  const SEEN_ATTR = "data-ocwr-seen";
  const PRINT_HIDDEN_ATTR = "data-ocwr-print-hidden";
  const chromeBefore = () => {
    document.querySelectorAll(`[${CHROME_ATTR}]`).forEach((el) => el.removeAttribute(CHROME_ATTR));
    for (const el of document.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) el.setAttribute(SEEN_ATTR, Math.round(r.height));
    }
  };
  const chromeDuring = () => {
    for (const el of document.querySelectorAll(`[${SEEN_ATTR}]`)) {
      const parent = el.parentElement;
      if (getComputedStyle(el).display === "none" && parent && getComputedStyle(parent).display !== "none") {
        el.setAttribute(PRINT_HIDDEN_ATTR, "");
      }
    }
  };
  const chromeAfter = () => {
    const docHeight = document.documentElement.scrollHeight;
    for (const el of document.querySelectorAll(`[${PRINT_HIDDEN_ATTR}]`)) {
      if (Number(el.getAttribute(SEEN_ATTR)) < docHeight * 0.25) el.setAttribute(CHROME_ATTR, "");
      el.removeAttribute(PRINT_HIDDEN_ATTR);
    }
    document.querySelectorAll(`[${SEEN_ATTR}]`).forEach((el) => el.removeAttribute(SEEN_ATTR));
    return document.querySelectorAll(`[${CHROME_ATTR}]`).length;
  };

  // Templates re-render when tabs change; keep the marks up to date.
  let timer;
  new MutationObserver((mutations) => {
    if (mutations.every((m) => m.target.id === STYLE_ID || m.target === document.getElementById(STYLE_ID))) return;
    clearTimeout(timer);
    timer = setTimeout(scan, 150);
  }).observe(document.documentElement, { childList: true, subtree: true });

  window.__ocwr = { scan, setRemoval, setPick, clearPicks, snapshot, report, chromeBefore, chromeDuring, chromeAfter };
  scan();
}

module.exports = { installHelpers };
