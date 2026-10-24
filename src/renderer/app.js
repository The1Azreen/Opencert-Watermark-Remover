import { connectToChild } from "penpal";
import connectToChildV4 from "penpal-v4/lib/connectToChild";
import { parseOpenCert } from "../shared/opencert";
import { createPageEditor } from "./page-editor";

const api = window.ocwr;
const $ = (sel) => document.querySelector(sel);

const CONNECT_TIMEOUT = 20000;

const state = {
  cert: null, // { raw, data, rendererUrl, info, fileName }
  child: null, // penpal connection
  connection: null,
  templates: [],
  selected: null,
  printView: false, // false: export the on-screen look (as on opencerts.io); true: the issuer's print styles
  removal: true,
  pick: false,
  report: null,
  lastFrameEvent: 0,
  busy: false,
  editing: false, // page editor open
  customPages: {}, // pageKey(tab) -> [{ x, y, w, h }] drawn or adjusted by the user
  lockedWidth: null, // the frame width page regions refer to
};

let editor;

const settings = loadSettings();

function loadSettings() {
  const defaults = { pages: "current", page: "A4", orientation: "auto", margins: "none", scale: 1, fit: true };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem("ocwr-settings") || "{}") };
  } catch (e) {
    return defaults;
  }
}
function saveSettings() {
  try {
    localStorage.setItem("ocwr-settings", JSON.stringify(settings));
  } catch (e) {
    // not important
  }
}

// ---------------- status ----------------
let statusTimer;
function setStatus(text, kind = "info", sticky = false) {
  const el = $("#status");
  el.textContent = text;
  el.dataset.kind = kind;
  el.hidden = !text;
  clearTimeout(statusTimer);
  if (text && !sticky) statusTimer = setTimeout(() => (el.hidden = true), 6000);
}

function setBusy(text) {
  state.busy = !!text;
  $("#busy").hidden = !text;
  $("#busy-text").textContent = text || "";
}

// ---------------- renderer connection ----------------
function frameDispatch(action) {
  state.lastFrameEvent = Date.now();
  switch (action.type) {
    case "UPDATE_HEIGHT":
      $("#renderer").style.height = `${Math.ceil(action.payload) + 20}px`;
      if (editor.visible) editor.position($("#renderer"));
      refreshReport();
      break;
    case "UPDATE_TEMPLATES":
      state.templates = action.payload || [];
      if (!state.selected || !state.templates.some((t) => t.id === state.selected)) {
        const first = state.templates.find((t) => t.id !== "print");
        state.selected = first ? first.id : null;
      }
      renderTabs();
      refreshReport();
      break;
    case "TIMEOUT":
      setStatus("The certificate renderer timed out.", "error", true);
      break;
    default:
      // OBFUSCATE etc. are not needed for exporting
      break;
  }
}

// Methods older renderers call instead of dispatch()
const legacyMethods = {
  updateHeight: (h) => frameDispatch({ type: "UPDATE_HEIGHT", payload: h }),
  updateTemplates: (t) => frameDispatch({ type: "UPDATE_TEMPLATES", payload: t }),
  handleObfuscation: () => {},
};

function toFrame(action) {
  const child = state.child;
  if (!child) return;
  if (child.dispatch) return child.dispatch(action);
  // legacy renderer API
  if (action.type === "RENDER_DOCUMENT") return child.renderDocument(action.payload.document, action.payload.rawDocument);
  if (action.type === "SELECT_TEMPLATE") return child.selectTemplateTab(state.templates.findIndex((t) => t.id === action.payload));
}

function renderDocumentAction() {
  return { type: "RENDER_DOCUMENT", payload: { document: state.cert.data, rawDocument: state.cert.raw } };
}

function connect(iframe) {
  const methods = { dispatch: frameDispatch, ...legacyMethods };
  const v6 = connectToChild({ iframe, methods, timeout: CONNECT_TIMEOUT });
  const v4 = connectToChildV4({ iframe, methods, timeout: CONNECT_TIMEOUT });
  state.connection = [v6, v4];
  const failed = () => {
    throw new Error(`Could not connect to the renderer at ${state.cert.rendererUrl}. Check your internet connection.`);
  };
  return Promise.any([v6.promise, v4.promise]).then((child) => {
    // whichever handshake lost is no longer needed
    for (const c of [v6, v4]) c.promise.then((other) => other !== child && c.destroy(), () => {});
    return child;
  }, failed);
}

function disconnect() {
  for (const c of state.connection || []) {
    try {
      c.destroy();
    } catch (e) {
      // already gone
    }
  }
  state.connection = null;
  state.child = null;
}

// ---------------- loading a certificate ----------------
let loadToken = 0;

async function openCert(file) {
  let cert;
  try {
    cert = parseOpenCert(file.text);
  } catch (e) {
    setStatus(e.message, "error", true);
    throw e;
  }
  const token = ++loadToken;
  disconnect();
  state.cert = { ...cert, fileName: file.name };
  state.templates = [];
  state.selected = null;
  state.report = null;
  state.pick = false;
  state.editing = false;
  state.customPages = {};
  state.lockedWidth = null;
  editor.hide();

  document.body.classList.add("has-cert");
  $("#cert-name").textContent = cert.info.name;
  $("#cert-meta").textContent = [cert.info.recipient, cert.info.issuer, file.name].filter(Boolean).join(" · ");
  $("#cert-meta").title = `${cert.info.schema}\nRenderer: ${cert.rendererUrl}`;
  renderTabs();
  updateControls();

  const old = $("#renderer");
  const iframe = document.createElement("iframe");
  iframe.id = "renderer";
  iframe.title = "Certificate";
  iframe.src = cert.rendererUrl;
  old.replaceWith(iframe);

  setBusy("Loading the issuer's certificate renderer…");
  try {
    const child = await connect(iframe);
    if (token !== loadToken) return;
    state.child = child;
    toFrame(renderDocumentAction());
    await settle();
    // Some renderers open on a different tab than the first one; keep the tab strip in sync.
    if (state.selected) {
      toFrame({ type: "SELECT_TEMPLATE", payload: state.selected });
      await settle();
    }
    await api.setPrintPreview(state.printView);
    await api.frame("setRemoval", state.removal);
    await afterRender();
  } catch (e) {
    if (token !== loadToken) return;
    setStatus(e.message, "error", true);
    throw e;
  } finally {
    if (token === loadToken) setBusy(null);
  }
}

// Resolves once the renderer has been quiet for a moment (it re-renders after tab changes).
function settle(quietMs = 600, maxMs = 6000) {
  const start = Date.now();
  state.lastFrameEvent = Math.max(state.lastFrameEvent, start);
  return new Promise((resolve) => {
    const tick = () => {
      const now = Date.now();
      if (now - state.lastFrameEvent >= quietMs || now - start >= maxMs) resolve();
      else setTimeout(tick, 100);
    };
    setTimeout(tick, 100);
  });
}

// ---------------- tabs ----------------
function renderTabs() {
  const tabs = $("#tabs");
  tabs.textContent = "";
  const visible = state.templates.filter((t) => t.id !== "print");
  tabs.hidden = visible.length < 2;
  for (const t of visible) {
    const b = document.createElement("button");
    b.className = "tab";
    b.textContent = t.label;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(t.id === state.selected));
    b.onclick = () => selectTemplate(t.id);
    tabs.appendChild(b);
  }
  $("#opt-pages-print").disabled = !state.templates.some((t) => t.id === "print");
  $("#opt-pages-all").disabled = visible.length < 2;
}

async function selectTemplate(id) {
  if (!state.child || state.selected === id) return;
  state.selected = id;
  renderTabs();
  toFrame({ type: "SELECT_TEMPLATE", payload: id });
  await settle();
  await afterRender();
}

// After the renderer draws something new: hide its own controls, rescan for watermarks,
// and refresh the page boxes.
async function afterRender() {
  await api.markChrome().catch(() => {});
  await refreshReport();
  await refreshEditor();
}

// ---------------- page editor ----------------
// Page regions depend on the layout, which differs between screen and print styles.
const pageKey = (tab) => `${tab}|${state.printView ? "print" : "screen"}`;

async function refreshEditor() {
  if (!editor.visible) return;
  editor.position($("#renderer"));
  const custom = state.customPages[pageKey(state.selected)];
  if (custom) {
    editor.setPages(custom);
  } else {
    const detected = await api.detectPages(settings.page).catch(() => null);
    editor.setPages(detected ? detected.pages : []);
  }
  updateControls();
}

// Page regions are in document pixels, so keep the layout width fixed from now on.
function lockWidth() {
  const iframe = $("#renderer");
  if (!state.lockedWidth) state.lockedWidth = iframe.offsetWidth;
  iframe.style.width = `${state.lockedWidth}px`;
  iframe.style.maxWidth = "none";
}

async function setEditing(on) {
  if (on && state.pick) await togglePick();
  state.editing = on;
  if (on) {
    lockWidth();
    editor.show();
    await refreshEditor();
  } else {
    editor.hide();
  }
  updateControls();
}

// ---------------- watermark controls ----------------
async function refreshReport() {
  if (!state.child) return;
  try {
    state.report = await api.frame("scan");
  } catch (e) {
    // frame navigating; next event will retry
  }
  updateControls();
}

function updateControls() {
  const loaded = !!state.child;
  for (const id of ["#toggle-print", "#toggle-removal", "#btn-pick", "#btn-pages", "#btn-export"]) $(id).disabled = !loaded || state.busy;
  $("#toggle-print").checked = state.printView;
  $("#toggle-removal").checked = state.removal;
  $("#btn-pick").setAttribute("aria-pressed", String(state.pick));
  $("#btn-pick").textContent = state.pick ? "Done hiding" : "Hide elements";
  document.body.classList.toggle("picking", state.pick);

  const r = state.report;
  const badge = $("#wm-badge");
  if (!r) {
    badge.hidden = true;
  } else {
    badge.hidden = false;
    badge.textContent = r.watermarks ? `${r.watermarks} found` : "none found";
    badge.dataset.kind = r.watermarks ? "found" : "none";
    badge.title = r.selectors.length ? `Matched CSS: ${r.selectors.join(", ")}` : "";
  }
  const picked = r ? r.picked : 0;
  $("#btn-clear").hidden = !picked;
  $("#btn-clear").textContent = `Show ${picked} hidden`;
  $("#pick-hint").hidden = !state.pick;

  $("#btn-pages").setAttribute("aria-pressed", String(state.editing));
  $("#btn-pages").textContent = state.editing ? "Done with pages" : "Pages";
  document.body.classList.toggle("editing-pages", state.editing);
  $("#pages-bar").hidden = !state.editing;
  if (state.editing) {
    const custom = !!state.customPages[pageKey(state.selected)];
    const count = editor.getPages().length;
    $("#pages-count").textContent = `${count} page${count === 1 ? "" : "s"} · ${custom ? "custom" : "auto-detected"}`;
    $("#btn-pages-auto").disabled = !custom;
  }
}

async function setPrintView(on) {
  state.printView = on;
  await api.setPrintPreview(on);
  await settle(300, 2000);
  await afterRender();
}

async function setRemoval(on) {
  state.removal = on;
  state.report = await api.frame("setRemoval", on);
  updateControls();
  await refreshEditor();
}

async function togglePick() {
  if (!state.pick && state.editing) await setEditing(false);
  state.pick = !state.pick;
  state.report = await api.frame("setPick", state.pick);
  updateControls();
  if (!state.pick) await refreshEditor();
}

// ---------------- export ----------------
function exportTemplateIds(pages) {
  if (pages === "print" && state.templates.some((t) => t.id === "print")) return ["print"];
  if (pages === "all") {
    const ids = state.templates.filter((t) => t.id !== "print").map((t) => t.id);
    if (ids.length) return ids;
  }
  return [state.selected];
}

async function exportPdf(opts) {
  const ids = exportTemplateIds(opts.pages);
  const original = state.selected;
  const wasPick = state.pick;
  setBusy("Preparing PDF…");
  updateControls();
  try {
    if (wasPick) await togglePick();
    await api.frame("setRemoval", opts.removeWatermark);
    const snapshots = [];
    for (const [i, id] of ids.entries()) {
      if (id && id !== state.selected) {
        setBusy(`Rendering page ${i + 1} of ${ids.length}…`);
        state.selected = id;
        toFrame({ type: "SELECT_TEMPLATE", payload: id });
        await settle();
      }
      await api.markChrome().catch(() => {});
      const snap = await api.snapshot();
      const custom = state.customPages[pageKey(id)];
      if (custom) snap.pages = custom;
      snapshots.push(snap);
    }
    setBusy("Writing PDF…");
    const baseName = (state.cert.fileName || "certificate").replace(/\.[^.]+$/, "");
    return await api.exportPdf(snapshots, { ...opts, suggestedName: `${baseName}.pdf` });
  } finally {
    if (original && state.selected !== original) {
      state.selected = original;
      toFrame({ type: "SELECT_TEMPLATE", payload: original });
      await settle();
    }
    await api.frame("setRemoval", state.removal).catch(() => {});
    renderTabs();
    setBusy(null);
    await afterRender();
  }
}

async function onExportClick() {
  closeExportMenu();
  try {
    const out = await exportPdf({ ...settings, removeWatermark: state.removal, media: state.printView ? "print" : "screen" });
    if (!out) return;
    const el = $("#status");
    setStatus(`Saved ${out}`, "ok", true);
    const open = document.createElement("button");
    open.className = "link";
    open.textContent = "Open";
    open.onclick = () => api.openPath(out);
    const show = document.createElement("button");
    show.className = "link";
    show.textContent = "Show in folder";
    show.onclick = () => api.showItem(out);
    el.append(" ", open, show);
  } catch (e) {
    setStatus(`Export failed: ${e.message}`, "error", true);
  }
}

// ---------------- export menu ----------------
function openExportMenu() {
  const menu = $("#export-menu");
  menu.hidden = false;
  $("#btn-export-menu").setAttribute("aria-expanded", "true");
  for (const input of menu.querySelectorAll("[name]")) {
    const value = settings[input.name];
    if (input.type === "radio") input.checked = input.value === String(value);
    else if (input.type === "checkbox") input.checked = !!value;
    else input.value = value;
  }
  menu.querySelector("[name=scale]").disabled = settings.fit;
}
function closeExportMenu() {
  $("#export-menu").hidden = true;
  $("#btn-export-menu").setAttribute("aria-expanded", "false");
}

function bindExportMenu() {
  $("#btn-export-menu").onclick = (e) => {
    e.stopPropagation();
    if ($("#export-menu").hidden) openExportMenu();
    else closeExportMenu();
  };
  $("#export-menu").addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", closeExportMenu);
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeExportMenu());
  $("#export-menu").addEventListener("change", (e) => {
    const input = e.target;
    if (!input.name) return;
    settings[input.name] =
      input.type === "checkbox" ? input.checked : input.name === "scale" ? Number(input.value) || 1 : input.value;
    $("#export-menu [name=scale]").disabled = settings.fit;
    saveSettings();
    if (input.name === "page") refreshEditor();
  });
  $("#btn-export-go").onclick = onExportClick;
}

// ---------------- file input ----------------
async function chooseFile() {
  const file = await api.openDialog();
  if (file) openCert(file).catch(() => {});
}

function bindDropZone() {
  const readDropped = (f) =>
    f.text().then((text) => openCert({ name: f.name, text }).catch(() => {}));
  window.addEventListener("dragover", (e) => {
    e.preventDefault();
    document.body.classList.add("dragging");
  });
  window.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) document.body.classList.remove("dragging");
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    document.body.classList.remove("dragging");
    const f = e.dataTransfer.files[0];
    if (f) readDropped(f);
  });
}

// ---------------- CLI (headless) ----------------
async function runCliJob() {
  const job = await api.cliJob();
  if (!job) return;
  if (!job.export) {
    openCert(job.open).catch(() => {});
    return;
  }
  try {
    state.printView = job.export.media === "print";
    await openCert(job.open);
    const outPath = await exportPdf({ ...job.export, pages: job.export.all ? "all" : "current" });
    api.cliDone({ outPath, watermarks: job.export.removeWatermark ? state.report && state.report.watermarks : undefined });
  } catch (e) {
    api.cliDone({ error: e.message || String(e) });
  }
}

// ---------------- init ----------------
function init() {
  $("#btn-open").onclick = chooseFile;
  $("#btn-open-empty").onclick = chooseFile;
  $("#toggle-print").onchange = (e) => setPrintView(e.target.checked);
  $("#toggle-removal").onchange = (e) => setRemoval(e.target.checked);
  $("#btn-pick").onclick = togglePick;
  $("#btn-clear").onclick = async () => {
    state.report = await api.frame("clearPicks");
    updateControls();
    await refreshEditor();
  };
  editor = createPageEditor($(".paper"), {
    onChange: (pages) => {
      state.customPages[pageKey(state.selected)] = pages;
      updateControls();
    },
  });
  $("#btn-pages").onclick = () => setEditing(!state.editing);
  $("#btn-pages-done").onclick = () => setEditing(false);
  $("#btn-pages-auto").onclick = async () => {
    delete state.customPages[pageKey(state.selected)];
    await refreshEditor();
  };
  new ResizeObserver(() => editor.visible && editor.position($("#renderer"))).observe($(".paper"));
  $("#btn-export").onclick = onExportClick;
  bindExportMenu();
  bindDropZone();
  api.onFileOpened((file) => openCert(file).catch(() => {}));
  updateControls();
  runCliJob();
}

init();
