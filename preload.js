const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("via", {
  // File dialog
  pickDirectory: () => ipcRenderer.invoke("pick-directory"),

  // Git operations
  validateRepo: (path) => ipcRenderer.invoke("validate-repo", path),
  listFiles: (repoPath, query) => ipcRenderer.invoke("list-files", repoPath, query),
  searchCommits: (repoPath, files, startDate, endDate) =>
    ipcRenderer.invoke("search-commits", repoPath, files, startDate, endDate),
  getDiff: (repoPath, hash, files) => ipcRenderer.invoke("get-diff", repoPath, hash, files),
  getRemoteUrl: (repoPath) => ipcRenderer.invoke("get-remote-url", repoPath),
  branchDiff: (repoPath) => ipcRenderer.invoke("branch-diff", repoPath),
  listBranches: (repoPath) => ipcRenderer.invoke("list-branches", repoPath),
  checkoutBranch: (repoPath, branch) => ipcRenderer.invoke("checkout-branch", repoPath, branch),
  discardFile: (repoPath, file, statusCode) => ipcRenderer.invoke("discard-file", repoPath, file, statusCode),
  discardAll: (repoPath) => ipcRenderer.invoke("discard-all", repoPath),

  // Terminal
  terminalStart: (id, cwd) => ipcRenderer.send("terminal-start", id, cwd),
  terminalInput: (id, data) => ipcRenderer.send("terminal-input", id, data),
  terminalResize: (id, cols, rows) => ipcRenderer.send("terminal-resize", id, cols, rows),
  terminalKill: (id) => ipcRenderer.send("terminal-kill", id),
  onTerminalOutput: (cb) => ipcRenderer.on("terminal-output", (_e, id, data) => cb(id, data)),
  onTerminalExit: (cb) => ipcRenderer.on("terminal-exit", (_e, id) => cb(id)),

  // Shortcuts from main process menu
  onShortcut: (cb) => ipcRenderer.on("shortcut", (_e, action) => cb(action)),
});
