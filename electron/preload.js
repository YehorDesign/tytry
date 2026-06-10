const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("titryNative", {
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  showInFolder: (filePath) => ipcRenderer.invoke("show-in-folder", filePath),
});
