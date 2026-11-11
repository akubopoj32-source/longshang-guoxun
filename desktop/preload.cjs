const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("orchardDesktop", {
  printChecklist: () => ipcRenderer.invoke("orchard:output-checklist", "print"),
  saveChecklistPdf: (filename) => ipcRenderer.invoke("orchard:output-checklist", "pdf", filename),
});
