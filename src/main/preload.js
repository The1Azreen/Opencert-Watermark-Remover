const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ocwr", {
  openDialog: () => ipcRenderer.invoke("file:open-dialog"),
  onFileOpened: (cb) => ipcRenderer.on("file:opened", (event, file) => cb(file)),
  frame: (method, ...args) => ipcRenderer.invoke("frame:call", method, ...args),
  snapshot: () => ipcRenderer.invoke("frame:snapshot"),
  setPrintPreview: (on) => ipcRenderer.invoke("view:print-preview", on),
  exportPdf: (snapshots, opts) => ipcRenderer.invoke("export:pdf", snapshots, opts),
  openPath: (p) => ipcRenderer.invoke("shell:open-path", p),
  showItem: (p) => ipcRenderer.invoke("shell:show-item", p),
  cliJob: () => ipcRenderer.invoke("cli:job"),
  cliDone: (result) => ipcRenderer.send("cli:done", result),
});
