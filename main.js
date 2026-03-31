const { app, BrowserWindow, ipcMain, dialog, Menu } = require("electron");
const path = require("path");
const os = require("os");
const { spawn, execFile } = require("child_process");
const pty = require("node-pty");

// ── State ────────────────────────────────────────────────────────────────────

let mainWindow = null;
const ptyProcesses = new Map(); // id -> ptyProcess

// File cache: { repoPath: { timestamp, files } }
const fileCache = {};
const CACHE_TTL = 60000; // 60s in ms

// ── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 600,
    title: "Via",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#1a1a2e",
    icon: path.join(__dirname, "build", "icon.icns"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile("renderer/index.html");

  mainWindow.on("closed", () => {
    mainWindow = null;
    killAllPty();
  });
}

function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{
      label: "Via",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Repository...",
          accelerator: "CmdOrCtrl+P",
          click: () => mainWindow?.webContents.send("shortcut", "open-repo"),
        },
        {
          label: "New Terminal Tab",
          accelerator: "CmdOrCtrl+N",
          click: () => mainWindow?.webContents.send("shortcut", "new-terminal"),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Sidebar",
          accelerator: "CmdOrCtrl+M",
          click: () => mainWindow?.webContents.send("shortcut", "toggle-sidebar"),
        },
        { type: "separator" },
        {
          label: "Terminal",
          accelerator: "CmdOrCtrl+T",
          click: () => mainWindow?.webContents.send("shortcut", "open-terminal"),
        },
        {
          label: "Search Commits",
          accelerator: "CmdOrCtrl+F",
          click: () => mainWindow?.webContents.send("shortcut", "open-search"),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac ? [{ type: "separator" }, { role: "front" }] : [{ role: "close" }]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  app.setName("Via");

  // Set dock icon explicitly for dev mode
  if (process.platform === "darwin" && app.dock) {
    const iconPath = path.join(__dirname, "build", "icon.png");
    try {
      const { nativeImage } = require("electron");
      const icon = nativeImage.createFromPath(iconPath);
      if (!icon.isEmpty()) {
        app.dock.setIcon(icon);
      }
    } catch (e) {
      console.error("Failed to set dock icon:", e);
    }
  }

  buildAppMenu();
  createWindow();
});

app.on("window-all-closed", () => {
  killAllPty();
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── Git helpers ──────────────────────────────────────────────────────────────

function runGit(repoPath, args) {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repoPath, ...args], { timeout: 30000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ returncode: err.code || 1, stdout: stdout || "", stderr: stderr || err.message });
      } else {
        resolve({ returncode: 0, stdout, stderr });
      }
    });
  });
}

function isGitRepo(dirPath) {
  return new Promise((resolve) => {
    const resolved = path.resolve(dirPath);
    execFile("git", ["-C", resolved, "rev-parse", "--git-dir"], { timeout: 5000 }, (err) => {
      resolve({ valid: !err, path: resolved });
    });
  });
}

function parseGithubUrl(remoteUrl) {
  const trimmed = remoteUrl.trim();
  let match = trimmed.match(/^git@github\.com:(.+?)(?:\.git)?$/);
  if (match) return `https://github.com/${match[1]}`;
  match = trimmed.match(/^https?:\/\/github\.com\/(.+?)(?:\.git)?$/);
  if (match) return `https://github.com/${match[1]}`;
  return null;
}

// ── IPC: File dialog ─────────────────────────────────────────────────────────

ipcMain.handle("pick-directory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    message: "Select a git repository",
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ── IPC: Git operations ──────────────────────────────────────────────────────

ipcMain.handle("validate-repo", async (_e, dirPath) => {
  const { valid, path: resolved } = await isGitRepo(dirPath);
  if (valid) {
    return { valid: true, name: path.basename(resolved), path: resolved };
  }
  return { valid: false, error: "Not a git repository" };
});

ipcMain.handle("list-files", async (_e, repoPath, query) => {
  const { valid, path: resolved } = await isGitRepo(repoPath);
  if (!valid) return { files: [], error: "Invalid repository" };

  const now = Date.now();
  const cached = fileCache[resolved];
  let allFiles;

  if (cached && now - cached.timestamp < CACHE_TTL) {
    allFiles = cached.files;
  } else {
    const result = await runGit(resolved, ["ls-files"]);
    if (result.returncode !== 0) return { files: [], error: "Failed to list files" };
    allFiles = result.stdout.trim().split("\n").filter(Boolean);
    fileCache[resolved] = { timestamp: now, files: allFiles };
  }

  if (!query) return { files: allFiles.slice(0, 50) };

  const q = query.toLowerCase();
  const matches = [];
  for (const f of allFiles) {
    if (f.toLowerCase().includes(q)) {
      matches.push(f);
      if (matches.length >= 50) break;
    }
  }
  return { files: matches };
});

ipcMain.handle("search-commits", async (_e, repoPath, files, startDate, endDate) => {
  const { valid, path: resolved } = await isGitRepo(repoPath);
  if (!valid) return { commits: [], error: "Invalid repository" };
  if (!files.length) return { commits: [], error: "No files specified" };

  const args = [
    "log",
    `--after=${startDate}`,
    `--before=${endDate}`,
    "--format=%H|%an|%aI|%s",
    "-n", "200",
    "--",
    ...files,
  ];

  const result = await runGit(resolved, args);
  if (result.returncode !== 0) return { commits: [], error: "Git log failed" };

  const commits = [];
  for (const line of result.stdout.trim().split("\n")) {
    if (!line) continue;
    const parts = line.split("|", 4);
    if (parts.length === 4) {
      commits.push({ hash: parts[0], author: parts[1], date: parts[2], message: parts[3] });
    }
  }

  return { commits, truncated: commits.length >= 200 };
});

ipcMain.handle("get-diff", async (_e, repoPath, commitHash, files) => {
  const { valid, path: resolved } = await isGitRepo(repoPath);
  if (!valid) return { diff: "", error: "Invalid repository" };
  if (!commitHash) return { diff: "", error: "No commit hash" };

  let result = await runGit(resolved, ["diff", `${commitHash}^..${commitHash}`, "--", ...files]);
  if (result.returncode !== 0) {
    result = await runGit(resolved, ["diff-tree", "--root", "-p", commitHash, "--", ...files]);
  }
  if (result.returncode !== 0) return { diff: "", error: "Failed to get diff" };

  let diff = result.stdout;
  const maxSize = 500 * 1024;
  if (diff.length > maxSize) {
    diff = diff.slice(0, maxSize) + "\n\n... diff truncated (exceeded 500KB) ...";
  }
  return { diff };
});

ipcMain.handle("get-remote-url", async (_e, repoPath) => {
  const { valid, path: resolved } = await isGitRepo(repoPath);
  if (!valid) return { url: null };

  const result = await runGit(resolved, ["remote", "get-url", "origin"]);
  if (result.returncode !== 0) return { url: null };

  return { url: parseGithubUrl(result.stdout) };
});

ipcMain.handle("branch-diff", async (_e, repoPath) => {
  const { valid, path: resolved } = await isGitRepo(repoPath);
  if (!valid) return { diff: "", branch: "", status: "", untracked: [] };

  const [branchResult, stagedResult, unstagedResult, statusResult] = await Promise.all([
    runGit(resolved, ["branch", "--show-current"]),
    runGit(resolved, ["diff", "--cached"]),
    runGit(resolved, ["diff"]),
    runGit(resolved, ["status", "--short"]),
  ]);

  const branch = branchResult.returncode === 0 ? branchResult.stdout.trim() : "";

  let diff = "";
  if (stagedResult.returncode === 0 && stagedResult.stdout.trim()) diff += stagedResult.stdout;
  if (unstagedResult.returncode === 0 && unstagedResult.stdout.trim()) {
    if (diff) diff += "\n";
    diff += unstagedResult.stdout;
  }

  const status = statusResult.returncode === 0 ? statusResult.stdout.trim() : "";

  const maxSize = 500 * 1024;
  if (diff.length > maxSize) {
    diff = diff.slice(0, maxSize) + "\n\n... diff truncated (exceeded 500KB) ...";
  }

  return { diff, branch, status };
});

ipcMain.handle("list-branches", async (_e, repoPath) => {
  const { valid, path: resolved } = await isGitRepo(repoPath);
  if (!valid) return { branches: [], current: "" };

  const [branchResult, currentResult] = await Promise.all([
    runGit(resolved, ["branch", "--format=%(refname:short)"]),
    runGit(resolved, ["branch", "--show-current"]),
  ]);

  const current = currentResult.returncode === 0 ? currentResult.stdout.trim() : "";
  const branches = branchResult.returncode === 0
    ? branchResult.stdout.trim().split("\n").filter(Boolean)
    : [];

  return { branches, current };
});

ipcMain.handle("checkout-branch", async (_e, repoPath, branch) => {
  const { valid, path: resolved } = await isGitRepo(repoPath);
  if (!valid) return { ok: false, error: "Invalid repository" };

  const result = await runGit(resolved, ["checkout", branch]);
  if (result.returncode !== 0) return { ok: false, error: result.stderr };
  return { ok: true };
});

ipcMain.handle("discard-file", async (_e, repoPath, file, statusCode) => {
  const { valid, path: resolved } = await isGitRepo(repoPath);
  if (!valid) return { ok: false, error: "Invalid repository" };

  let result;
  if (statusCode.includes("?")) {
    // Untracked file — remove it
    const filePath = path.join(resolved, file);
    try {
      const fs = require("fs");
      fs.rmSync(filePath, { recursive: true, force: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  } else {
    // Tracked file — restore it
    result = await runGit(resolved, ["checkout", "--", file]);
    if (result.returncode !== 0) return { ok: false, error: result.stderr };
    // Also unstage if staged
    await runGit(resolved, ["reset", "HEAD", "--", file]);
    return { ok: true };
  }
});

ipcMain.handle("discard-all", async (_e, repoPath) => {
  const { valid, path: resolved } = await isGitRepo(repoPath);
  if (!valid) return { ok: false, error: "Invalid repository" };

  // Reset staged changes, restore tracked files, remove untracked
  const [resetResult, checkoutResult, cleanResult] = await Promise.all([
    runGit(resolved, ["reset", "HEAD"]),
    runGit(resolved, ["checkout", "--", "."]),
    runGit(resolved, ["clean", "-fd"]),
  ]);

  const errors = [resetResult, checkoutResult, cleanResult]
    .filter((r) => r.returncode !== 0)
    .map((r) => r.stderr);

  if (errors.length) return { ok: false, error: errors.join("\n") };
  return { ok: true };
});

// ── IPC: Terminal (PTY) ──────────────────────────────────────────────────────

function killPty(id) {
  const p = ptyProcesses.get(id);
  if (p) {
    try { p.kill(); } catch {}
    ptyProcesses.delete(id);
  }
}

function killAllPty() {
  for (const [id] of ptyProcesses) {
    killPty(id);
  }
}

ipcMain.on("terminal-start", (_e, id, cwd) => {
  killPty(id);

  const shell = process.env.SHELL || "/bin/zsh";
  const startDir = cwd && require("fs").existsSync(cwd) ? cwd : os.homedir();

  try {
    const p = pty.spawn(shell, ["-l"], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: startDir,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}`,
      },
    });

    ptyProcesses.set(id, p);

    p.onData((data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("terminal-output", id, data);
      }
    });

    p.onExit(() => {
      ptyProcesses.delete(id);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("terminal-exit", id);
      }
    });
  } catch (err) {
    console.error("Failed to spawn PTY:", err);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("terminal-output", id,
        `\r\n\x1b[31mFailed to start terminal: ${err.message}\x1b[0m\r\n`);
    }
  }
});

ipcMain.on("terminal-input", (_e, id, data) => {
  const p = ptyProcesses.get(id);
  if (p) p.write(data);
});

ipcMain.on("terminal-resize", (_e, id, cols, rows) => {
  const p = ptyProcesses.get(id);
  if (p) {
    try { p.resize(cols, rows); } catch {}
  }
});

ipcMain.on("terminal-kill", (_e, id) => {
  killPty(id);
});
