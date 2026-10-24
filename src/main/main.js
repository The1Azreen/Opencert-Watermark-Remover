const { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { installHelpers } = require("./frame-helpers");
const { exportSnapshots, sheetRatio } = require("./pdf-export");
const { detectPages } = require("./page-detect");

const ROOT = path.join(__dirname, "..", "..");
const UI_DIR = path.join(ROOT, "dist");
const HELPERS_SRC = `(${installHelpers.toString()})();`;

// The viewer is served from app://viewer so the issuer's renderer sees a normal origin
// during the penpal postMessage handshake (file:// pages report the origin "null").
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// ---------- command line ----------
// electron . [file.opencert]
// electron . --export file.opencert [out.pdf] [--all] [--keep-watermark] [--page A4|Letter|Legal|A3]
//            [--landscape|--portrait] [--margins none|default] [--scale 1 | --no-fit] [--print-styles]
// Without --scale/--no-fit, each designed page is scaled to fit one sheet.
// --print-styles uses the issuer's print stylesheet (where watermarks live) instead of the on-screen look.
const parseArgs = (argv) => {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  const opts = { export: false, files: [], all: false, keepWatermark: false, page: "A4", orientation: "auto", margins: "none", scale: 1, fit: true, media: "screen" };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--export") opts.export = true;
    else if (a === "--all") opts.all = true;
    else if (a === "--keep-watermark") opts.keepWatermark = true;
    else if (a === "--landscape") opts.orientation = "landscape";
    else if (a === "--portrait") opts.orientation = "portrait";
    else if (a === "--page") opts.page = args[++i];
    else if (a === "--margins") opts.margins = args[++i];
    else if (a === "--scale") {
      opts.scale = Number(args[++i]);
      opts.fit = false;
    } else if (a === "--no-fit") opts.fit = false;
    else if (a === "--print-styles") opts.media = "print";
    else if (!a.startsWith("-")) opts.files.push(path.resolve(a));
  }
  return opts;
};
const cli = parseArgs(process.argv);

let mainWindow;

const createWindow = ({ show = true } = {}) => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 760,
    minHeight: 500,
    show,
    title: "OpenCert Watermark Remover",
    backgroundColor: "#f4f6f9",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  // Links clicked inside a certificate open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("app://")) e.preventDefault();
  });
  win.loadURL("app://viewer/index.html");
  return win;
};

// Many issuers only allow their renderer to be framed by opencerts.io
// (CSP frame-ancestors / X-Frame-Options). Lift that for frames embedded in our viewer.
const allowFramingInViewer = (ses) => {
  ses.webRequest.onHeadersReceived({ urls: ["https://*/*", "http://*/*"] }, (details, callback) => {
    const embeddedInViewer =
      details.resourceType === "subFrame" && details.webContents && details.webContents.getURL().startsWith("app://");
    if (!embeddedInViewer) return callback({});
    const headers = {};
    for (const [name, values] of Object.entries(details.responseHeaders || {})) {
      const lower = name.toLowerCase();
      if (lower === "x-frame-options") continue;
      if (lower === "content-security-policy") {
        const kept = values
          .map((policy) =>
            policy
              .split(";")
              .filter((d) => !/^\s*frame-ancestors\b/i.test(d))
              .join(";")
          )
          .filter((policy) => policy.trim());
        if (kept.length) headers[name] = kept;
        continue;
      }
      headers[name] = values;
    }
    callback({ responseHeaders: headers });
  });
};

// ---------- talking to the renderer iframe ----------
const rendererFrame = (win) => win && win.webContents.mainFrame.frames[0];

const callFrame = async (win, method, ...args) => {
  const frame = rendererFrame(win);
  if (!frame) throw new Error("The certificate renderer is not loaded.");
  return frame.executeJavaScript(`${HELPERS_SRC} window.__ocwr.${method}(...${JSON.stringify(args)});`);
};

// Show the page with print styles applied, i.e. exactly as it will look in the PDF.
// The renderer watermark is print-only, so this is also what makes it visible on screen.
// The issuer's iframe runs in its own process (site isolation), so it is a separate DevTools
// target: auto-attach to child frames and apply the emulation to each of them too.
const previewState = new WeakMap(); // webContents -> { media, sessions }

const framePreview = async (win) => {
  const wc = win.webContents;
  const dbg = wc.debugger;
  let st = previewState.get(wc);
  if (!st) {
    st = { media: "", sessions: new Set() };
    previewState.set(wc, st);
    if (!dbg.isAttached()) dbg.attach("1.3");
    dbg.on("message", (event, method, params) => {
      if (method === "Target.attachedToTarget") {
        const sessionId = params.sessionId;
        st.sessions.add(sessionId);
        dbg.sendCommand("Emulation.setEmulatedMedia", { media: st.media }, sessionId).catch(() => {});
        dbg.sendCommand("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
      } else if (method === "Target.detachedFromTarget") {
        st.sessions.delete(params.sessionId);
      }
    });
    await dbg.sendCommand("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  }
  return st;
};

const emulateFrameMedia = async (win, media) => {
  const st = await framePreview(win);
  const dbg = win.webContents.debugger;
  await dbg.sendCommand("Emulation.setEmulatedMedia", { media });
  await Promise.all([...st.sessions].map((id) => dbg.sendCommand("Emulation.setEmulatedMedia", { media }, id).catch(() => {})));
};

const setPrintPreview = async (win, on) => {
  const st = await framePreview(win);
  st.media = on ? "print" : "";
  await emulateFrameMedia(win, st.media);
};

// Marks the renderer's own controls (shown on screen, hidden in print) so they are hidden
// in the preview and left out of page detection and the PDF.
const markRendererChrome = async (win) => {
  const st = await framePreview(win);
  if (st.media === "print") return 0; // print styles already hide them
  await callFrame(win, "chromeBefore");
  try {
    await emulateFrameMedia(win, "print");
    await callFrame(win, "chromeDuring");
  } finally {
    await emulateFrameMedia(win, st.media);
  }
  return callFrame(win, "chromeAfter");
};

// ---------- IPC ----------
const winOf = (event) => BrowserWindow.fromWebContents(event.sender);

ipcMain.handle("file:open-dialog", async (event) => {
  const res = await dialog.showOpenDialog(winOf(event), {
    title: "Open an OpenCert",
    filters: [
      { name: "OpenCerts", extensions: ["opencert", "json", "tt"] },
      { name: "All files", extensions: ["*"] },
    ],
    properties: ["openFile"],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return readCert(res.filePaths[0]);
});

const readCert = (filePath) => ({ name: path.basename(filePath), path: filePath, text: fs.readFileSync(filePath, "utf8") });

ipcMain.handle("frame:call", (event, method, ...args) => {
  if (!["scan", "setRemoval", "setPick", "clearPicks", "report"].includes(method)) throw new Error(`Unknown method ${method}`);
  // Status refreshes can race a reload or app exit; there's nothing to report then.
  if (!rendererFrame(winOf(event))) return null;
  return callFrame(winOf(event), method, ...args);
});

ipcMain.handle("frame:snapshot", (event) => callFrame(winOf(event), "snapshot"));

ipcMain.handle("frame:mark-chrome", (event) => (rendererFrame(winOf(event)) ? markRendererChrome(winOf(event)) : 0));

// Automatic page regions for the current tab, in the frame's document pixels.
ipcMain.handle("frame:detect-pages", (event, paper) => {
  const frame = rendererFrame(winOf(event));
  if (!frame) return null;
  return frame.executeJavaScript(`(${detectPages.toString()})(${sheetRatio({ page: paper })})`);
});

ipcMain.handle("view:print-preview", (event, on) => setPrintPreview(winOf(event), on));

// snapshots: [{html, url, width}], opts: page settings + suggestedName or outPath
ipcMain.handle("export:pdf", async (event, snapshots, opts) => {
  let outPath = opts.outPath;
  if (!outPath) {
    const res = await dialog.showSaveDialog(winOf(event), {
      title: "Export PDF",
      defaultPath: path.join(app.getPath("documents"), opts.suggestedName || "certificate.pdf"),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (res.canceled || !res.filePath) return null;
    outPath = res.filePath;
  }
  fs.writeFileSync(outPath, await exportSnapshots(snapshots, opts));
  return outPath;
});

ipcMain.handle("shell:open-path", (event, p) => shell.openPath(p));
ipcMain.handle("shell:show-item", (event, p) => shell.showItemInFolder(p));

// CLI mode: the hidden viewer asks for its job and reports back when done.
ipcMain.handle("cli:job", () => {
  if (!cli.export) return cli.files[0] ? { open: readCert(cli.files[0]) } : null;
  const [input, output] = cli.files;
  return {
    open: readCert(input),
    export: {
      outPath: output || input.replace(/\.[^.\\/]+$/, "") + ".pdf",
      all: cli.all,
      removeWatermark: !cli.keepWatermark,
      page: cli.page,
      orientation: cli.orientation,
      margins: cli.margins,
      scale: cli.scale,
      fit: cli.fit,
      media: cli.media,
    },
  };
});

ipcMain.on("cli:done", (event, result) => {
  if (result.error) {
    console.error(`Export failed: ${result.error}`);
    app.exit(1);
  } else {
    console.log(`Saved ${result.outPath}${result.watermarks !== undefined ? ` (${result.watermarks} watermark layer(s) removed)` : ""}`);
    app.exit(0);
  }
});

// ---------- app lifecycle ----------
if (!cli.export && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (event, argv) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    const file = parseArgs(argv).files[0];
    if (file && fs.existsSync(file)) mainWindow.webContents.send("file:opened", readCert(file));
  });

  app.whenReady().then(() => {
    allowFramingInViewer(session.defaultSession);
    protocol.handle("app", (request) => {
      const { pathname } = new URL(request.url);
      const file = path.normalize(path.join(UI_DIR, decodeURIComponent(pathname)));
      if (!file.startsWith(UI_DIR)) return new Response("Not found", { status: 404 });
      return net.fetch(require("url").pathToFileURL(file).href);
    });

    if (cli.export) {
      if (!cli.files[0]) {
        console.error("Usage: opencert-watermark-remover --export <file.opencert> [out.pdf] [--all] [--keep-watermark] [--page A4] [--landscape|--portrait] [--margins none|default] [--scale 1 | --no-fit] [--print-styles]");
        app.exit(2);
        return;
      }
      createWindow({ show: false });
      setTimeout(() => {
        console.error("Export timed out.");
        app.exit(1);
      }, 120000);
    } else {
      mainWindow = createWindow();
      mainWindow.on("closed", () => (mainWindow = null));
    }
  });

  app.on("window-all-closed", () => app.quit());
}
