const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("orchardDesktop", {
  connectionMode: process.argv.includes("--orchard-shared") ? "shared" : "local",
  reconnect: () => ipcRenderer.invoke("orchard:reconnect"),
  printChecklist: () => ipcRenderer.invoke("orchard:output-checklist", "print"),
  saveChecklistPdf: (filename) => ipcRenderer.invoke("orchard:output-checklist", "pdf", filename),
});
