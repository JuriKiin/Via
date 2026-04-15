// ── State ────────────────────────────────────────────────────────────────────
let repoPath = "";
let selectedFiles = [];
let githubBaseUrl = null;
let searchResults = [];
let currentDiffMode = "line-by-line";
let currentDiffText = "";
let branchDiffMode = "line-by-line";
let branchDiffTimer = null;
let lastDiffStatus = "";
let lastDiffText = "";

// Terminals: { id, term, fitAddon, containerEl, name }
let terminals = [];
let activeTerminalId = null;
let terminalIdCounter = 0;

// Per-repo terminal sessions: Map<repoPath, { terminals, activeTerminalId, terminalIdCounter }>
const repoTerminals = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

function debounce(fn, ms) {
    let timer;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), ms);
    };
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

function formatDate(isoDate) {
    const d = new Date(isoDate);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatISODate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function highlightMatch(text, query) {
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return escapeHtml(text);
    const before = escapeHtml(text.slice(0, idx));
    const match = escapeHtml(text.slice(idx, idx + query.length));
    const after = escapeHtml(text.slice(idx + query.length));
    return `${before}<strong>${match}</strong>${after}`;
}

// ── Saved Repos (localStorage) ───────────────────────────────────────────────

function getSavedRepos() {
    try {
        return JSON.parse(localStorage.getItem("via_repos") || "[]");
    } catch {
        return [];
    }
}

// Worktree repos are ephemeral — not persisted across restarts
let worktreeRepos = [];

function saveRepos(repos) {
    localStorage.setItem("via_repos", JSON.stringify(repos));
}

function renderSavedRepos() {
    const container = document.getElementById("saved-repos");
    const repos = [...getSavedRepos(), ...worktreeRepos];

    if (repos.length === 0) {
        container.innerHTML = '<p class="empty-repos">No repositories yet</p>';
        return;
    }

    container.innerHTML = repos
        .map(
            (r) => `
            <div class="repo-item ${r.path === repoPath ? "active" : ""}" onclick="selectRepo('${escapeHtml(r.path)}')" oncontextmenu="showRepoContextMenu(event, '${escapeHtml(r.path)}')">
                <div class="repo-item-info">
                    <span class="repo-item-name">${escapeHtml(r.name)}${r.isWorktree ? '<span class="worktree-badge">worktree</span>' : ''}</span>
                    <span class="repo-item-path">${escapeHtml(r.path)}</span>
                </div>
                <button class="repo-remove-btn" onclick="event.stopPropagation(); removeRepo('${escapeHtml(r.path)}')" title="Remove">&times;</button>
            </div>`
        )
        .join("");
}

async function selectRepo(path) {
    const data = await window.via.validateRepo(path);

    if (data.valid) {
        const previousRepo = repoPath;

        // Save current repo's terminals before switching
        if (previousRepo && previousRepo !== data.path) {
            saveCurrentRepoTerminals(previousRepo);
        }

        repoPath = data.path;
        selectedFiles = [];
        renderChips();
        renderSavedRepos();

        document.getElementById("branch-info").style.display = "";

        window.via.getRemoteUrl(repoPath).then((res) => {
            githubBaseUrl = res.url || null;
        });

        // Restore or create terminals for this repo
        if (previousRepo !== data.path) {
            restoreRepoTerminals(data.path);
        }

        refreshBranchDiff();
        startDiffPolling();
    } else {
        alert("This repository path is no longer valid.");
        removeRepo(path);
    }
}

async function browseForRepo() {
    const dirPath = await window.via.pickDirectory();
    if (!dirPath) return;

    const data = await window.via.validateRepo(dirPath);
    if (data.valid) {
        if (data.isWorktree) {
            // Worktrees are shown temporarily — not saved to localStorage
            if (!worktreeRepos.some((r) => r.path === data.path)) {
                worktreeRepos.push({ name: data.name, path: data.path, isWorktree: true });
            }
            renderSavedRepos();
        } else {
            const repos = getSavedRepos();
            if (!repos.some((r) => r.path === data.path)) {
                repos.push({ name: data.name, path: data.path });
                saveRepos(repos);
            }
        }
        selectRepo(data.path);
    } else {
        alert("The selected folder is not a git repository.");
    }
}

function removeRepo(path) {
    // Remove from worktree list if it's a temporary worktree entry
    const worktreeIdx = worktreeRepos.findIndex((r) => r.path === path);
    if (worktreeIdx !== -1) {
        worktreeRepos.splice(worktreeIdx, 1);
    } else {
        const repos = getSavedRepos().filter((r) => r.path !== path);
        saveRepos(repos);
    }

    // Clean up saved terminals for removed repo
    const saved = repoTerminals.get(path);
    if (saved) {
        saved.terminals.forEach((t) => {
            window.via.terminalKill(t.id);
            t.term.dispose();
            t.containerEl.remove();
        });
        repoTerminals.delete(path);
    }
    localStorage.removeItem(terminalNamesKey(path));

    if (repoPath === path) {
        repoPath = "";
        document.getElementById("branch-info").style.display = "none";
        stopDiffPolling();
    }
    renderSavedRepos();
}

renderSavedRepos();

// ── Terminal ─────────────────────────────────────────────────────────────────

let terminalTheme = {
    background: "#0d0d0d",
    foreground: "#e4e4e7",
    cursor: "#0ea5e9",
    selectionBackground: "rgba(14, 165, 233, 0.3)",
    black: "#1a1a2e",
    red: "#f87171",
    green: "#34d399",
    yellow: "#fbbf24",
    blue: "#0ea5e9",
    magenta: "#c084fc",
    cyan: "#22d3ee",
    white: "#e4e4e7",
    brightBlack: "#4b5563",
    brightRed: "#fca5a5",
    brightGreen: "#6ee7b7",
    brightYellow: "#fde68a",
    brightBlue: "#38bdf8",
    brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",
    brightWhite: "#f9fafb",
};

function getTerminal(id) {
    const found = terminals.find((t) => t.id === id);
    if (found) return found;
    // Also search saved per-repo terminals
    for (const [, saved] of repoTerminals) {
        const t = saved.terminals.find((t) => t.id === id);
        if (t) return t;
    }
    return null;
}

function isActiveTerminal(id) {
    return terminals.some((t) => t.id === id);
}

function terminalNamesKey(path) {
    return path ? `via_terminal_names_${path}` : "via_terminal_names";
}

function saveTerminalNames() {
    const names = {};
    terminals.forEach((t, i) => {
        if (t.name) names[i] = t.name;
    });
    localStorage.setItem(terminalNamesKey(repoPath), JSON.stringify(names));
}

function loadTerminalNames() {
    try {
        return JSON.parse(localStorage.getItem(terminalNamesKey(repoPath)) || "{}");
    } catch {
        return {};
    }
}

function createTerminal(cwd) {
    const id = ++terminalIdCounter;

    const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace",
        theme: terminalTheme,
        allowProposedApi: true,
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    const containerEl = document.createElement("div");
    containerEl.className = "terminal-instance";
    containerEl.id = `terminal-instance-${id}`;
    document.getElementById("terminal-container").appendChild(containerEl);

    // Open into visible container so xterm can measure fonts/canvas
    term.open(containerEl);

    term.onData((data) => {
        window.via.terminalInput(id, data);
    });

    const entry = { id, term, fitAddon, containerEl, name: null };
    terminals.push(entry);

    // Start PTY
    window.via.terminalStart(id, cwd || undefined);

    setTimeout(() => {
        fitAddon.fit();
        const dims = fitAddon.proposeDimensions();
        if (dims) {
            window.via.terminalResize(id, dims.cols, dims.rows);
        }
        term.focus();
        // Hide if not the active terminal (after init is done)
        if (activeTerminalId && activeTerminalId !== id) {
            containerEl.style.display = "none";
        }
    }, 100);

    return entry;
}

function switchToTerminal(id) {
    activeTerminalId = id;
    terminals.forEach((t) => {
        t.containerEl.style.display = t.id === id ? "" : "none";
    });
    renderTerminalTabs();

    // Flush any buffered output for this terminal
    const buffered = terminalBuffers.get(id);
    if (buffered && buffered.length > 0) {
        const entry = getTerminal(id);
        if (entry) entry.term.write(buffered.join(""));
        terminalBuffers.delete(id);
    }

    const entry = getTerminal(id);
    if (entry) {
        setTimeout(() => {
            entry.fitAddon.fit();
            entry.term.focus();
        }, 50);
    }
}

function closeTerminal(id) {
    const idx = terminals.findIndex((t) => t.id === id);
    if (idx === -1) return;

    // Don't close the last terminal
    if (terminals.length === 1) return;

    window.via.terminalKill(id);
    terminals[idx].term.dispose();
    terminals[idx].containerEl.remove();
    terminals.splice(idx, 1);

    if (activeTerminalId === id) {
        const next = terminals[Math.min(idx, terminals.length - 1)];
        switchToTerminal(next.id);
    } else {
        renderTerminalTabs();
    }
}

function addTerminalTab() {
    const entry = createTerminal(repoPath || undefined);
    switchToTerminal(entry.id);
}

function renderTerminalTabs() {
    const tabsEl = document.getElementById("terminal-tabs");
    tabsEl.innerHTML = terminals
        .map((t, i) => {
            const active = t.id === activeTerminalId ? "active" : "";
            const label = t.name || `Terminal ${i + 1}`;
            const closeBtn = terminals.length > 1
                ? `<span class="terminal-tab-close" onclick="event.stopPropagation(); closeTerminal(${t.id})">&times;</span>`
                : "";
            return `<div class="terminal-tab ${active}" data-terminal-id="${t.id}" onclick="switchToTerminal(${t.id})" oncontextmenu="event.preventDefault(); startRenameTab(${t.id})">
                <span class="terminal-tab-label">${escapeHtml(label)}</span>
                ${closeBtn}
            </div>`;
        })
        .join("");
}

function startRenameTab(id) {
    const entry = getTerminal(id);
    if (!entry) return;

    const tabEl = document.querySelector(`.terminal-tab[data-terminal-id="${id}"]`);
    if (!tabEl) return;

    const labelEl = tabEl.querySelector(".terminal-tab-label");
    const currentName = entry.name || labelEl.textContent;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "terminal-tab-rename";
    input.value = currentName;
    labelEl.replaceWith(input);
    input.focus();
    input.select();

    function commitRename() {
        const newName = input.value.trim();
        if (newName) {
            entry.name = newName;
        }
        saveTerminalNames();
        renderTerminalTabs();
    }

    input.addEventListener("blur", commitRename);
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            input.blur();
        }
        if (e.key === "Escape") {
            e.preventDefault();
            // Cancel — don't change name
            input.removeEventListener("blur", commitRename);
            renderTerminalTabs();
        }
    });
}

function saveCurrentRepoTerminals(path) {
    if (!path || terminals.length === 0) return;
    // Hide all terminal containers
    terminals.forEach((t) => {
        t.containerEl.style.display = "none";
    });
    repoTerminals.set(path, {
        terminals: [...terminals],
        activeTerminalId,
        terminalIdCounter,
    });
}

function restoreRepoTerminals(path) {
    const saved = repoTerminals.get(path);
    if (saved) {
        terminals = saved.terminals;
        activeTerminalId = saved.activeTerminalId;
        terminalIdCounter = saved.terminalIdCounter;
        repoTerminals.delete(path); // Now active, remove from saved
        switchToTerminal(activeTerminalId);
    } else {
        // No saved terminals for this repo — create a fresh one
        terminals = [];
        terminalIdCounter = 0;
        const savedNames = loadTerminalNames();
        const entry = createTerminal(path);
        if (savedNames[0]) entry.name = savedNames[0];
        switchToTerminal(entry.id);
    }
}

function startTerminal(cwd) {
    // Kill all existing terminals (used for initial launch with no repo)
    terminals.forEach((t) => {
        window.via.terminalKill(t.id);
        t.term.dispose();
        t.containerEl.remove();
    });
    terminals = [];
    terminalIdCounter = 0;

    const savedNames = loadTerminalNames();
    const entry = createTerminal(cwd);
    if (savedNames[0]) entry.name = savedNames[0];
    switchToTerminal(entry.id);
}

function restartTerminal() {
    if (!activeTerminalId) return;
    const entry = getTerminal(activeTerminalId);
    if (!entry) return;

    window.via.terminalKill(entry.id);
    entry.term.clear();

    window.via.terminalStart(entry.id, repoPath || undefined);

    setTimeout(() => {
        const dims = entry.fitAddon.proposeDimensions();
        if (dims) {
            window.via.terminalResize(entry.id, dims.cols, dims.rows);
        }
    }, 100);
}

// Receive output from PTY — buffer writes for background terminals
const terminalBuffers = new Map();
let bufferFlushTimer = null;

function flushTerminalBuffers() {
    for (const [id, chunks] of terminalBuffers) {
        // Only flush for terminals in the current repo's set
        if (!isActiveTerminal(id)) continue;
        const entry = getTerminal(id);
        if (entry && chunks.length > 0) {
            entry.term.write(chunks.join(""));
        }
        terminalBuffers.delete(id);
    }
    bufferFlushTimer = null;
}

window.via.onTerminalOutput((id, data) => {
    const entry = getTerminal(id);
    if (!entry) return;

    if (id === activeTerminalId && isActiveTerminal(id)) {
        entry.term.write(data);
    } else {
        // Buffer background terminal output (including other repo terminals)
        if (!terminalBuffers.has(id)) terminalBuffers.set(id, []);
        terminalBuffers.get(id).push(data);
        if (!bufferFlushTimer) {
            bufferFlushTimer = setTimeout(flushTerminalBuffers, 500);
        }
    }
});

window.via.onTerminalExit((id) => {
    const entry = getTerminal(id);
    if (entry) {
        entry.term.write("\r\n\x1b[33m[Session ended. Click restart to begin a new session.]\x1b[0m\r\n");
    }
});

// Handle window resize
window.addEventListener("resize", () => {
    const entry = getTerminal(activeTerminalId);
    if (entry) {
        entry.fitAddon.fit();
        const dims = entry.fitAddon.proposeDimensions();
        if (dims) {
            window.via.terminalResize(entry.id, dims.cols, dims.rows);
        }
    }
});

// ── Branch Diff (Right Panel) ────────────────────────────────────────────────

async function refreshBranchDiff(force) {
    if (!repoPath) return;

    const data = await window.via.branchDiff(repoPath);

    const branchEl = document.getElementById("current-branch");
    if (data.branch) {
        branchEl.textContent = data.branch;
        document.getElementById("branch-info").style.display = "";
    }

    // Skip expensive re-render if nothing changed
    const newStatus = data.status || "";
    const newDiff = data.diff || "";
    if (!force && newStatus === lastDiffStatus && newDiff === lastDiffText) return;
    lastDiffStatus = newStatus;
    lastDiffText = newDiff;

    const discardBtn = document.getElementById("discard-all-btn");
    if (discardBtn) {
        discardBtn.style.display = newStatus || newDiff ? "" : "none";
    }

    const statusEl = document.getElementById("diff-status");
    if (newStatus) {
        statusEl.innerHTML = newStatus
            .split("\n")
            .map((line) => {
                const code = line.substring(0, 2);
                const rawFile = line.substring(3);
                const file = escapeHtml(rawFile);
                const escapedFile = escapeHtml(rawFile.replace(/'/g, "\\'"));
                const escapedCode = escapeHtml(code.replace(/'/g, "\\'"));
                const discardBtn = `<span class="status-discard-btn" onclick="event.stopPropagation(); discardFileChange('${escapedFile}', '${escapedCode}')" title="Discard change">&times;</span>`;
                if (code.includes("M")) return `<span class="status-modified status-file-link" onclick="scrollToDiffFile('${escapedFile}')"> M ${file}${discardBtn}</span>`;
                if (code.includes("A")) return `<span class="status-added status-file-link" onclick="scrollToDiffFile('${escapedFile}')"> A ${file}${discardBtn}</span>`;
                if (code.includes("D")) return `<span class="status-deleted status-file-link" onclick="scrollToDiffFile('${escapedFile}')"> D ${file}${discardBtn}</span>`;
                if (code.includes("?")) return `<span class="status-untracked status-file-link" onclick="scrollToDiffFile('${escapedFile}')">?? ${file}${discardBtn}</span>`;
                return `<span>${escapeHtml(line)}</span>`;
            })
            .join("\n");
    } else {
        statusEl.innerHTML = "";
    }

    const imageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico"];
    const imageFiles = [];
    if (newStatus) {
        newStatus.split("\n").forEach(line => {
            const file = line.substring(3);
            if (imageExtensions.some(ext => file.toLowerCase().endsWith(ext))) {
                imageFiles.push(file);
            }
        });
    }

    const container = document.getElementById("branch-diff-container");
    if (!newDiff && imageFiles.length === 0) {
        container.innerHTML = '<div class="empty-state">No uncommitted changes</div>';
        return;
    }

    container.innerHTML = "";

    if (newDiff) {
        const targetElement = document.createElement("div");
        container.appendChild(targetElement);

        const diff2htmlUi = new Diff2HtmlUI(targetElement, newDiff, {
            drawFileList: false,
            matching: "lines",
            outputFormat: branchDiffMode,
            highlight: true,
        });
        diff2htmlUi.draw();
        diff2htmlUi.highlightCode();
    }

    // Append image previews
    if (imageFiles.length > 0) {
        imageFiles.forEach(file => {
            const imgPath = encodeURI(`${repoPath}/${file}`);
            const imgHtml = `<div style="padding: 16px; text-align: center; background: var(--bg-surface);"><img src="file://${imgPath}?t=${Date.now()}" style="max-width: 100%; max-height: 500px; border: 1px solid var(--border-color); border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);" /></div>`;

            const wrappers = Array.from(container.querySelectorAll(".d2h-file-wrapper"));
            let existingWrapper = wrappers.find(w => {
                const header = w.querySelector(".d2h-file-name");
                return header && header.textContent.trim() === file;
            });

            if (existingWrapper) {
                // Overwrite standard text/binary diff with image preview
                const content = existingWrapper.querySelector(".d2h-file-content") || existingWrapper.querySelector("tbody");
                if (content) {
                    content.outerHTML = imgHtml;
                }
            } else {
                // Inject fake d2h-file-wrapper for untracked images to look consistent
                const wrapper = document.createElement("div");
                wrapper.className = "d2h-file-wrapper";
                wrapper.innerHTML = `
                <div class="d2h-file-header">
                    <span class="d2h-file-name-wrapper">
                        <svg aria-hidden="true" class="d2h-icon" height="16" version="1.1" viewBox="0 0 12 16" width="12">
                            <path d="M6 5L2 5 2 4 6 4 6 5 6 5ZM2 8L9 8 9 7 2 7 2 8 2 8ZM2 10L9 10 9 9 2 9 2 10 2 10ZM2 12L9 12 9 11 2 11 2 12 2 12ZM12 4.5L12 14C12 14.6 11.6 15 11 15L1 15C0.5 15 0 14.6 0 14L0 2C0 1.5 0.5 1 1 1L8.5 1 12 4.5 12 4.5ZM11 5L8 2 1 2 1 14 11 14 11 5 11 5Z"></path>
                        </svg>
                        <span class="d2h-file-name">${escapeHtml(file)}</span>
                    </span>
                </div>
                ${imgHtml}
                `;
                container.appendChild(wrapper);
            }
        });
    }
}

function switchBranchDiffMode(mode) {
    branchDiffMode = mode;
    document.getElementById("diff-mode-unified").classList.toggle("active", mode === "line-by-line");
    document.getElementById("diff-mode-split").classList.toggle("active", mode === "side-by-side");
    lastDiffText = "";
    refreshBranchDiff(true);
}

async function discardFileChange(file, statusCode) {
    if (!repoPath) return;
    if (!confirm(`Discard changes to "${file}" ? This cannot be undone.`)) return;

    const result = await window.via.discardFile(repoPath, file, statusCode);
    if (result.ok) {
        refreshBranchDiff(true);
    } else {
        alert(`Failed to discard: ${result.error}`);
    }
}

async function discardAllChanges() {
    if (!repoPath) return;
    if (!confirm("Discard ALL changes? This cannot be undone.")) return;

    const result = await window.via.discardAll(repoPath);
    if (result.ok) {
        refreshBranchDiff(true);
    } else {
        alert(`Failed to discard: ${result.error}`);
    }
}

function startDiffPolling() {
    stopDiffPolling();
    branchDiffTimer = setInterval(refreshBranchDiff, 10000);
}

function stopDiffPolling() {
    if (branchDiffTimer) {
        clearInterval(branchDiffTimer);
        branchDiffTimer = null;
    }
}

// ── Tools ────────────────────────────────────────────────────────────────────

function openTool(toolId) {
    // Deactivate all tools
    document.querySelectorAll(".tool-item").forEach((t) => t.classList.remove("active"));

    // Hide all overlays
    document.getElementById("tool-overlay").style.display = "none";
    document.getElementById("preferences-overlay").style.display = "none";
    document.getElementById("git-reference-overlay").style.display = "none";
    document.getElementById("snippets-overlay").style.display = "none";
    document.getElementById("terminal-header").style.display = "";

    if (toolId === "terminal") {
        document.getElementById("tool-terminal").classList.add("active");
        const entry = getTerminal(activeTerminalId);
        if (entry) {
            setTimeout(() => entry.fitAddon.fit(), 50);
        }
        return;
    }

    if (toolId === "commit-finder") {
        if (!repoPath) {
            alert("Please select a repository first.");
            return;
        }
        document.getElementById("terminal-header").style.display = "none";
        document.getElementById("tool-overlay").style.display = "flex";
        document.getElementById("tool-overlay-title").textContent = "Search Commits";
        document.getElementById("tool-commit-finder").classList.add("active");

        document.getElementById("cf-detail").style.display = "none";
        document.getElementById("cf-file-section").style.display = "";
        document.querySelectorAll(".tool-card").forEach((c) => (c.style.display = ""));
        document.querySelectorAll("#search-commits-view > section").forEach((s) => (s.style.display = ""));
    }

    if (toolId === "preferences") {
        document.getElementById("terminal-header").style.display = "none";
        document.getElementById("preferences-overlay").style.display = "flex";
        document.getElementById("tool-preferences").classList.add("active");
        renderThemeSwatches();
        document.getElementById("theme-input").value = getCurrentThemeString();
    }

    if (toolId === "git-reference") {
        document.getElementById("terminal-header").style.display = "none";
        document.getElementById("git-reference-overlay").style.display = "flex";
        document.getElementById("tool-git-reference").classList.add("active");
    }

    if (toolId === "snippets") {
        document.getElementById("terminal-header").style.display = "none";
        document.getElementById("snippets-overlay").style.display = "flex";
        document.getElementById("tool-snippets").classList.add("active");
        renderSnippets();
    }
}

function closeTool() {
    openTool("terminal");
}

// ── Search Commits ───────────────────────────────────────────────────────────

const cfFileInput = document.getElementById("cf-file-input");
const cfFileDropdown = document.getElementById("cf-file-dropdown");

const cfSearchFiles = debounce(async (query) => {
    if (!repoPath || query.length < 1) {
        cfFileDropdown.style.display = "none";
        return;
    }

    const data = await window.via.listFiles(repoPath, query);
    const filtered = data.files.filter((f) => !selectedFiles.includes(f));

    if (filtered.length === 0) {
        cfFileDropdown.style.display = "none";
        return;
    }

    cfFileDropdown.innerHTML = filtered
        .map((f) => {
            const highlighted = highlightMatch(f, query);
            return `<div class="dropdown-item" onmousedown="cfAddFile('${escapeHtml(f)}')">${highlighted}</div>`;
        })
        .join("");
    cfFileDropdown.style.display = "block";
}, 300);

cfFileInput.addEventListener("input", (e) => cfSearchFiles(e.target.value));
cfFileInput.addEventListener("focus", (e) => {
    if (e.target.value) cfSearchFiles(e.target.value);
});
cfFileInput.addEventListener("blur", () => {
    setTimeout(() => (cfFileDropdown.style.display = "none"), 150);
});
cfFileInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") cfFileDropdown.style.display = "none";
});

function cfAddFile(filename) {
    if (selectedFiles.includes(filename)) return;
    selectedFiles.push(filename);
    cfFileInput.value = "";
    cfFileDropdown.style.display = "none";
    renderChips();
}

function cfRemoveFile(filename) {
    selectedFiles = selectedFiles.filter((f) => f !== filename);
    renderChips();
}

function renderChips() {
    const container = document.getElementById("cf-file-chips");
    container.innerHTML = selectedFiles
        .map(
            (f) =>
                `<span class="chip">${escapeHtml(f)} <button onclick="cfRemoveFile('${escapeHtml(f)}')">&times;</button></span>`
        )
        .join("");
}

function applyQuickFilter(days) {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - days);

    document.getElementById("cf-start-date").value = formatISODate(start);
    document.getElementById("cf-end-date").value = formatISODate(end);

    document.querySelectorAll(".quick-filter").forEach((b) => b.classList.remove("active"));
    const btn = document.querySelector(`.quick - filter[onclick = "applyQuickFilter(${days})"]`);
    if (btn) btn.classList.add("active");
}

document.getElementById("cf-start-date").addEventListener("input", () => {
    document.querySelectorAll(".quick-filter").forEach((b) => b.classList.remove("active"));
});
document.getElementById("cf-end-date").addEventListener("input", () => {
    document.querySelectorAll(".quick-filter").forEach((b) => b.classList.remove("active"));
});

async function cfSearch() {
    const startDate = document.getElementById("cf-start-date").value;
    const endDate = document.getElementById("cf-end-date").value;
    const resultsSection = document.getElementById("cf-results");
    const resultsList = document.getElementById("cf-results-list");
    const heading = document.getElementById("cf-results-heading");

    if (selectedFiles.length === 0) {
        alert("Please select at least one file.");
        return;
    }
    if (!startDate || !endDate) {
        alert("Please select both start and end dates.");
        return;
    }

    resultsList.innerHTML = '<div class="loading">Searching commits...</div>';
    resultsSection.style.display = "";

    const data = await window.via.searchCommits(repoPath, selectedFiles, startDate, endDate);

    searchResults = data.commits || [];

    if (searchResults.length === 0) {
        heading.textContent = "";
        resultsList.innerHTML = '<p class="empty-state">No commits matched your criteria.</p>';
    } else {
        const label = data.truncated
            ? "200+ commits (showing 200)"
            : `${searchResults.length} commit${searchResults.length === 1 ? "" : "s"} `;
        heading.textContent = label;
        resultsList.innerHTML = searchResults
            .map(
                (c, i) => `
                <div class="commit-row" onclick="cfShowDetail(${i})">
                    <span class="commit-hash">${c.hash.slice(0, 8)}</span>
                    <span class="commit-message">${escapeHtml(c.message)}</span>
                    <span class="commit-meta">
                        <span>${escapeHtml(c.author)}</span>
                        <span>${formatDate(c.date)}</span>
                    </span>
                </div > `
            )
            .join("");
    }
}

async function cfShowDetail(index) {
    const commit = searchResults[index];
    if (!commit) return;

    document.getElementById("cf-results").style.display = "none";
    document.getElementById("cf-file-section").style.display = "none";
    document.querySelectorAll(".tool-card").forEach((c) => (c.style.display = "none"));
    document.querySelectorAll("#search-commits-view > section").forEach((s) => (s.style.display = "none"));

    const detail = document.getElementById("cf-detail");
    detail.style.display = "";

    document.getElementById("cf-detail-message").textContent = commit.message;
    document.getElementById("cf-detail-hash").textContent = commit.hash;
    document.getElementById("cf-detail-author").textContent = commit.author;
    document.getElementById("cf-detail-date").textContent = formatDate(commit.date);

    const ghLink = document.getElementById("cf-detail-github-link");
    if (githubBaseUrl) {
        ghLink.href = `${githubBaseUrl} /commit/${commit.hash} `;
        ghLink.style.display = "";
    } else {
        ghLink.style.display = "none";
    }

    const diffContainer = document.getElementById("cf-detail-diff");
    diffContainer.innerHTML = '<div class="loading">Loading diff...</div>';

    const data = await window.via.getDiff(repoPath, commit.hash, selectedFiles);

    currentDiffText = data.diff || "";

    if (!currentDiffText) {
        diffContainer.innerHTML = '<p class="empty-state">No diff available.</p>';
        return;
    }

    cfRenderDiff();
}

function cfRenderDiff() {
    const diffContainer = document.getElementById("cf-detail-diff");
    if (!currentDiffText) return;

    const targetElement = document.createElement("div");
    diffContainer.innerHTML = "";
    diffContainer.appendChild(targetElement);

    const diff2htmlUi = new Diff2HtmlUI(targetElement, currentDiffText, {
        drawFileList: true,
        matching: "lines",
        outputFormat: currentDiffMode,
        highlight: true,
    });
    diff2htmlUi.draw();
    diff2htmlUi.highlightCode();
}

function cfSwitchDiffMode(mode, btn) {
    currentDiffMode = mode;
    document.querySelectorAll("#cf-detail .toggle-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    cfRenderDiff();
}

function cfBackToResults() {
    document.getElementById("cf-detail").style.display = "none";
    document.getElementById("cf-file-section").style.display = "";
    document.querySelectorAll(".tool-card").forEach((c) => (c.style.display = ""));
    document.querySelectorAll("#search-commits-view > section").forEach((s) => (s.style.display = ""));
    document.getElementById("cf-results").style.display = "";
}

// ── Resizable Diff Panel ─────────────────────────────────────────────────────

(function () {
    const handle = document.getElementById("resize-handle");
    const diffPanel = document.getElementById("diff-panel");
    let isResizing = false;

    handle.addEventListener("mousedown", (e) => {
        isResizing = true;
        handle.classList.add("active");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
        if (!isResizing) return;
        const newWidth = window.innerWidth - e.clientX;
        const clamped = Math.max(200, Math.min(newWidth, window.innerWidth * 0.7));
        diffPanel.style.width = clamped + "px";

        // Refit terminal when resizing
        const active = getTerminal(activeTerminalId);
        if (active) active.fitAddon.fit();
    });

    document.addEventListener("mouseup", () => {
        if (!isResizing) return;
        isResizing = false;
        handle.classList.remove("active");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";

        const activeEntry = getTerminal(activeTerminalId);
        if (activeEntry) {
            activeEntry.fitAddon.fit();
            const dims = activeEntry.fitAddon.proposeDimensions();
            if (dims) window.via.terminalResize(activeEntry.id, dims.cols, dims.rows);
        }
    });
})();

// ── Resizable Sidebar ───────────────────────────────────────────────────────

(function () {
    const handle = document.getElementById("sidebar-resize-handle");
    const sidebar = document.getElementById("sidebar");
    const COLLAPSE_THRESHOLD = 100;
    let isResizing = false;

    handle.addEventListener("mousedown", (e) => {
        isResizing = true;
        handle.classList.add("active");
        sidebar.classList.add("resizing");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
        if (!isResizing) return;
        const layout = document.querySelector(".app-layout");
        const sidebarLeft = sidebar.getBoundingClientRect().left;
        const newWidth = e.clientX - sidebarLeft;

        if (newWidth < COLLAPSE_THRESHOLD) {
            if (!layout.classList.contains("sidebar-collapsed")) {
                layout.classList.add("sidebar-collapsed");
                sidebar.style.width = "";
                sidebar.style.minWidth = "";
            }
        } else {
            layout.classList.remove("sidebar-collapsed");
            const clamped = Math.max(COLLAPSE_THRESHOLD, Math.min(newWidth, window.innerWidth * 0.4));
            sidebar.style.width = clamped + "px";
            sidebar.style.minWidth = clamped + "px";
        }

        const active = getTerminal(activeTerminalId);
        if (active) active.fitAddon.fit();
    });

    document.addEventListener("mouseup", () => {
        if (!isResizing) return;
        isResizing = false;
        handle.classList.remove("active");
        sidebar.classList.remove("resizing");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";

        const activeEntry = getTerminal(activeTerminalId);
        if (activeEntry) {
            activeEntry.fitAddon.fit();
            const dims = activeEntry.fitAddon.proposeDimensions();
            if (dims) window.via.terminalResize(activeEntry.id, dims.cols, dims.rows);
        }
    });
})();

// ── Scroll to Diff File ─────────────────────────────────────────────────────

function scrollToDiffFile(filename) {
    const container = document.getElementById("branch-diff-container");
    const wrappers = container.querySelectorAll(".d2h-file-wrapper");
    for (const wrapper of wrappers) {
        const nameEl = wrapper.querySelector(".d2h-file-name");
        if (nameEl && nameEl.textContent.trim() === filename) {
            // Expand if collapsed
            if (wrapper.classList.contains("collapsed")) {
                wrapper.classList.remove("collapsed");
                collapsedFiles.delete(filename);
            }
            wrapper.scrollIntoView({ behavior: "smooth", block: "start" });
            // Brief highlight
            wrapper.classList.add("diff-file-highlight");
            setTimeout(() => wrapper.classList.remove("diff-file-highlight"), 1500);
            return;
        }
    }
}

// ── Collapse / Expand All Diffs ─────────────────────────────────────────────

let allCollapsed = false;

function toggleCollapseAll() {
    const container = document.getElementById("branch-diff-container");
    const wrappers = container.querySelectorAll(".d2h-file-wrapper");
    allCollapsed = !allCollapsed;

    wrappers.forEach((wrapper) => {
        const name = getFileName(wrapper.querySelector(".d2h-file-header"));
        if (allCollapsed) {
            wrapper.classList.add("collapsed");
            if (name) collapsedFiles.add(name);
        } else {
            wrapper.classList.remove("collapsed");
            if (name) collapsedFiles.delete(name);
        }
    });

    const btn = document.getElementById("collapse-all-btn");
    btn.textContent = allCollapsed ? "Expand All" : "Collapse All";
}

// ── Collapsible Diff Files ───────────────────────────────────────────────────

// Track collapsed files by name so state survives re-renders
const collapsedFiles = new Set();

function getFileName(header) {
    const nameEl = header.querySelector(".d2h-file-name");
    return nameEl ? nameEl.textContent.trim() : null;
}

function setupCollapsibleDiffs(container) {
    const wrappers = container.querySelectorAll(".d2h-file-wrapper");
    wrappers.forEach((wrapper) => {
        const header = wrapper.querySelector(".d2h-file-header");
        if (!header) return;

        const name = getFileName(header);

        // Restore collapsed state
        if (name && collapsedFiles.has(name)) {
            wrapper.classList.add("collapsed");
        }

        header.addEventListener("click", () => {
            wrapper.classList.toggle("collapsed");
            if (name) {
                if (wrapper.classList.contains("collapsed")) {
                    collapsedFiles.add(name);
                } else {
                    collapsedFiles.delete(name);
                }
            }
        });
    });
}

// ── Repo Context Menu ───────────────────────────────────────────────────────

let activeContextRepoPath = null;

function showRepoContextMenu(e, path) {
    e.preventDefault();
    e.stopPropagation();

    activeContextRepoPath = path;
    if (typeof hideDiffContextMenu === "function") hideDiffContextMenu();

    const menu = document.getElementById("repo-context-menu");
    menu.style.display = "block";
    menu.style.left = e.clientX + "px";
    menu.style.top = e.clientY + "px";

    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 4) + "px";
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 4) + "px";
}

function hideRepoContextMenu() {
    const menu = document.getElementById("repo-context-menu");
    if (menu) menu.style.display = "none";
    activeContextRepoPath = null;
}

async function openRepoInGithub() {
    if (!activeContextRepoPath) return;
    const path = activeContextRepoPath;
    hideRepoContextMenu();

    const res = await window.via.getRemoteUrl(path);
    if (res.url) {
        window.via.openExternal(res.url);
    } else {
        alert("No GitHub remote found for this repository.");
    }
}

function openRepoInFinder() {
    if (!activeContextRepoPath) return;
    const path = activeContextRepoPath;
    hideRepoContextMenu();
    window.via.openInFinder(path);
}

// ── Diff File Context Menu ──────────────────────────────────────────────────

let diffContextFile = null;

function getStatusCodeForFile(filename) {
    if (!lastDiffStatus) return null;
    for (const line of lastDiffStatus.split("\n")) {
        const rawFile = line.substring(3);
        if (rawFile === filename) return line.substring(0, 2);
    }
    return null;
}

function showDiffContextMenu(e, filename) {
    e.preventDefault();
    e.stopPropagation();
    diffContextFile = filename;

    const menu = document.getElementById("diff-context-menu");
    menu.style.display = "block";
    menu.style.left = e.clientX + "px";
    menu.style.top = e.clientY + "px";

    // Clamp to viewport
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 4) + "px";
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 4) + "px";
}

function hideDiffContextMenu() {
    document.getElementById("diff-context-menu").style.display = "none";
    diffContextFile = null;
}

document.getElementById("diff-context-finder").addEventListener("mousedown", (e) => {
    e.stopPropagation();
    if (!diffContextFile) return;
    const file = diffContextFile;
    hideDiffContextMenu();
    window.via.openInFinder(`${repoPath}/${file}`);
});

document.getElementById("diff-context-discard").addEventListener("mousedown", (e) => {
    e.stopPropagation();
    if (!diffContextFile) return;
    const file = diffContextFile;
    const code = getStatusCodeForFile(file) || " M";
    hideDiffContextMenu();
    discardFileChange(file, code);
});

document.addEventListener("mousedown", (e) => {
    if (!e.target.closest(".diff-context-menu")) {
        hideDiffContextMenu();
        if (typeof hideRepoContextMenu === "function") hideRepoContextMenu();
    }
});

function setupDiffContextMenus(container) {
    const wrappers = container.querySelectorAll(".d2h-file-wrapper");
    wrappers.forEach((wrapper) => {
        const header = wrapper.querySelector(".d2h-file-header");
        if (!header) return;
        const name = getFileName(header);
        if (!name) return;

        header.addEventListener("contextmenu", (e) => {
            showDiffContextMenu(e, name);
        });
    });
}

// Patch refreshBranchDiff to add collapsibility + context menus after rendering
const _origRefreshBranchDiff = refreshBranchDiff;
refreshBranchDiff = async function () {
    await _origRefreshBranchDiff();
    const container = document.getElementById("branch-diff-container");
    setupCollapsibleDiffs(container);
    setupDiffContextMenus(container);
};

// Patch cfRenderDiff too
const _origCfRenderDiff = cfRenderDiff;
cfRenderDiff = function () {
    _origCfRenderDiff();
    const container = document.getElementById("cf-detail-diff");
    setupCollapsibleDiffs(container);
};

// ── Sidebar Toggle ──────────────────────────────────────────────────────────

function toggleSidebar() {
    const layout = document.querySelector(".app-layout");
    const sidebar = document.getElementById("sidebar");
    layout.classList.toggle("sidebar-collapsed");
    // Reset inline resize styles so CSS variable takes over when expanding
    if (!layout.classList.contains("sidebar-collapsed")) {
        sidebar.style.width = "";
        sidebar.style.minWidth = "";
    }
    // Refit active terminal after sidebar animation
    setTimeout(() => {
        const entry = getTerminal(activeTerminalId);
        if (entry) {
            entry.fitAddon.fit();
            const dims = entry.fitAddon.proposeDimensions();
            if (dims) window.via.terminalResize(entry.id, dims.cols, dims.rows);
        }
    }, 50);
}

// ── Branch Dropdown ─────────────────────────────────────────────────────────

let branchDropdownOpen = false;

async function toggleBranchDropdown() {
    const dropdown = document.getElementById("branch-dropdown");

    if (branchDropdownOpen) {
        dropdown.style.display = "none";
        branchDropdownOpen = false;
        return;
    }

    if (!repoPath) return;

    dropdown.innerHTML = '<div class="loading">Loading...</div>';
    dropdown.style.display = "block";
    branchDropdownOpen = true;

    const [data, worktreeData] = await Promise.all([
        window.via.listBranches(repoPath),
        window.via.listWorktrees(repoPath),
    ]);

    if (!branchDropdownOpen) return; // closed while loading

    // Map branch name → worktree path for branches checked out elsewhere
    const worktreeBranchMap = new Map(
        worktreeData.worktrees
            .filter(wt => wt.branch && wt.path !== repoPath)
            .map(wt => [wt.branch, wt])
    );

    if (data.branches.length === 0) {
        dropdown.innerHTML = '<div class="branch-dropdown-item" style="color:var(--text-secondary)">No branches</div>';
        return;
    }

    dropdown.innerHTML = data.branches
        .map((b) => {
            const isCurrent = b === data.current ? "current" : "";
            const wt = worktreeBranchMap.get(b);
            const isWorktree = !!wt;
            const label = isWorktree
                ? `${escapeHtml(b)}<span class="branch-worktree-badge">${wt.isMain ? "repo" : "worktree"}</span>`
                : escapeHtml(b) + (b === data.current ? " (current)" : "");
            return `<div class="branch-dropdown-item ${isCurrent}${isWorktree ? " is-worktree" : ""}" onclick="selectBranch('${escapeHtml(b)}')">${label}</div>`;
        })
        .join("");
}

async function selectBranch(branch) {
    const dropdown = document.getElementById("branch-dropdown");
    if (dropdown) dropdown.style.display = "none";
    branchDropdownOpen = false;

    // Check if this branch is already checked out in another worktree or the main repo
    const worktreeData = await window.via.listWorktrees(repoPath);
    const occupied = worktreeData.worktrees.find(wt => wt.branch === branch && wt.path !== repoPath);

    if (occupied) {
        // If it's the main (non-worktree) repo, look for it in saved repos
        // If it's a linked worktree, open it as a temporary worktree entry
        const data = await window.via.validateRepo(occupied.path);
        if (data.valid) {
            if (data.isWorktree && !worktreeRepos.some(r => r.path === data.path)) {
                worktreeRepos.push({ name: data.name, path: data.path, isWorktree: true });
                renderSavedRepos();
            }
            selectRepo(data.path);
        }
        return;
    }

    let result = await window.via.checkoutBranch(repoPath, branch);

    if (!result.ok && result.error && result.error.includes("overwritten")) {
        if (confirm(`Your local changes conflict with '${branch}'.\nDo you want to stash, switch, and apply them?`)) {
            result = await window.via.checkoutBranch(repoPath, branch, true);
        } else {
            return;
        }
    }

    if (result.ok) {
        document.getElementById("current-branch").textContent = branch;
        refreshBranchDiff();
        if (result.conflicts) {
            alert("Branch switched successfully, but there were merge conflicts applying your changes.\\nPlease resolve them in the diff panel.");
        }
    } else {
        alert(`Failed to checkout branch: ${result.error}`);
    }
}

// Close branch dropdown on outside click
document.addEventListener("click", (e) => {
    if (branchDropdownOpen && !e.target.closest("#branch-selector")) {
        document.getElementById("branch-dropdown").style.display = "none";
        branchDropdownOpen = false;
    }
});

// ── Keyboard Shortcuts (from main process menu) ─────────────────────────────

window.via.onShortcut((action) => {
    switch (action) {
        case "toggle-sidebar":
            toggleSidebar();
            break;
        case "open-terminal":
            openTool("terminal");
            break;
        case "open-search":
            openTool("commit-finder");
            break;
        case "new-terminal":
            openTool("terminal");
            addTerminalTab();
            break;
        case "open-repo":
            browseForRepo();
            break;
        case "open-pinwheel":
            openPinwheel();
            break;
        case "close-pinwheel":
            closePinwheel();
            break;
    }
});

// ── Theme / Preferences ─────────────────────────────────────────────────────

const THEME_KEYS = [
    "bg", "surface", "surface-alt", "text", "text-secondary",
    "border", "accent", "accent-hover", "success", "error", "warning",
];

const THEME_LABELS = [
    "BG", "Surface", "Srf Alt", "Text", "Text 2",
    "Border", "Accent", "Acc Hvr", "Success", "Error", "Warning",
];

const DEFAULT_THEME = [
    "#1a1a2e", "#16213e", "#0f3460", "#e4e4e7", "#9ca3af",
    "#2a2a4a", "#0ea5e9", "#38bdf8", "#34d399", "#f87171", "#fbbf24",
];

const PRESET_THEMES = [
    {
        name: "Midnight (Default)",
        colors: ["#1a1a2e", "#16213e", "#0f3460", "#e4e4e7", "#9ca3af", "#2a2a4a", "#0ea5e9", "#38bdf8", "#34d399", "#f87171", "#fbbf24"],
    },
    {
        name: "Monokai",
        colors: ["#272822", "#1e1f1c", "#3e3d32", "#f8f8f2", "#75715e", "#3b3a32", "#a6e22e", "#b8e656", "#66d9ef", "#f92672", "#e6db74"],
    },
    {
        name: "Nord",
        colors: ["#2e3440", "#3b4252", "#434c5e", "#eceff4", "#d8dee9", "#4c566a", "#88c0d0", "#8fbcbb", "#a3be8c", "#bf616a", "#ebcb8b"],
    },
    {
        name: "Solarized Dark",
        colors: ["#002b36", "#073642", "#073642", "#fdf6e3", "#93a1a1", "#586e75", "#268bd2", "#2aa198", "#859900", "#dc322f", "#b58900"],
    },
    {
        name: "Rosewood",
        colors: ["#1a1016", "#241820", "#3a2030", "#f0e0e8", "#b09aa4", "#3d2a34", "#e06090", "#f080a0", "#70c0a0", "#f06070", "#e0b060"],
    },
];

function getCurrentThemeValues() {
    const style = getComputedStyle(document.documentElement);
    return THEME_KEYS.map((k) => style.getPropertyValue(`--${k}`).trim());
}

function getCurrentThemeString() {
    return getCurrentThemeValues().join(",");
}

function applyTheme(colors) {
    const root = document.documentElement;
    colors.forEach((color, i) => {
        if (THEME_KEYS[i]) {
            root.style.setProperty(`--${THEME_KEYS[i]}`, color);
        }
    });

    // Derive secondary colors
    const chipBg = colors[5] || "#2a2a4a"; // same as border
    const hoverBg = colors[2] || "#1e2a4a"; // close to surface-alt
    root.style.setProperty("--chip-bg", chipBg);
    root.style.setProperty("--hover-bg", hoverBg);

    // Update terminal theme for existing and new terminals
    const termBg = darkenColor(colors[0] || "#1a1a2e", 0.4);
    terminalTheme.background = termBg;
    terminalTheme.foreground = colors[3] || "#e4e4e7";
    terminalTheme.cursor = colors[6] || "#0ea5e9";
    terminalTheme.selectionBackground = hexToRgba(colors[6] || "#0ea5e9", 0.3);
    document.getElementById("terminal-container").style.background = termBg;

    // Update all terminals (active + saved per-repo)
    terminals.forEach((t) => {
        t.term.options.theme = { ...terminalTheme };
    });
    for (const [, saved] of repoTerminals) {
        saved.terminals.forEach((t) => {
            t.term.options.theme = { ...terminalTheme };
        });
    }

    // Save to localStorage
    localStorage.setItem("via_theme", colors.join(","));
}

function darkenColor(hex, amount) {
    const r = Math.max(0, Math.round(parseInt(hex.slice(1, 3), 16) * (1 - amount)));
    const g = Math.max(0, Math.round(parseInt(hex.slice(3, 5), 16) * (1 - amount)));
    const b = Math.max(0, Math.round(parseInt(hex.slice(5, 7), 16) * (1 - amount)));
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function parseThemeString(str) {
    const colors = str.split(",").map((c) => c.trim());
    if (colors.length !== THEME_KEYS.length) return null;
    const hexRe = /^#[0-9a-fA-F]{6}$/;
    if (!colors.every((c) => hexRe.test(c))) return null;
    return colors;
}

function applyThemeFromInput() {
    const input = document.getElementById("theme-input");
    const statusEl = document.getElementById("theme-status");
    const colors = parseThemeString(input.value);

    if (!colors) {
        statusEl.textContent = `Expected ${THEME_KEYS.length} hex colors(#rrggbb) separated by commas`;
        statusEl.className = "status error";
        return;
    }

    applyTheme(colors);
    renderThemeSwatches();
    statusEl.textContent = "Theme applied!";
    statusEl.className = "status success";
    setTimeout(() => (statusEl.textContent = ""), 2000);
}

function resetTheme() {
    applyTheme(DEFAULT_THEME);
    localStorage.removeItem("via_theme");
    document.getElementById("theme-input").value = DEFAULT_THEME.join(",");
    renderThemeSwatches();

    // Clear inline styles so CSS defaults take over
    const root = document.documentElement;
    THEME_KEYS.forEach((k) => root.style.removeProperty(`--${k} `));
    root.style.removeProperty("--chip-bg");
    root.style.removeProperty("--hover-bg");

    const statusEl = document.getElementById("theme-status");
    statusEl.textContent = "Reset to default theme";
    statusEl.className = "status success";
    setTimeout(() => (statusEl.textContent = ""), 2000);
}

function copyCurrentTheme() {
    const str = getCurrentThemeString();
    navigator.clipboard.writeText(str).then(() => {
        const statusEl = document.getElementById("theme-status");
        statusEl.textContent = "Copied to clipboard!";
        statusEl.className = "status success";
        setTimeout(() => (statusEl.textContent = ""), 2000);
    });
}

function renderThemeSwatches() {
    const container = document.getElementById("theme-swatches");
    const values = getCurrentThemeValues();
    container.innerHTML = values
        .map((color, i) => `
                <div class="prefs-swatch">
                    <input type="color" class="prefs-swatch-color" value="${color}" title="${THEME_KEYS[i]}: ${color}" onchange="swatchChanged(${i}, this.value)">
                    <span class="prefs-swatch-label">${THEME_LABELS[i]}</span>
                </div>
            `)
        .join("");

    renderPresets();
}

function renderPresets() {
    const container = document.getElementById("theme-presets");
    const currentStr = getCurrentThemeString();
    container.innerHTML = PRESET_THEMES
        .map((preset, i) => {
            const isActive = preset.colors.join(",") === currentStr ? "active" : "";
            const preview = preset.colors.slice(0, 5).map((c) =>
                `<span class="preset-color-dot" style="background:${c}"></span>`
            ).join("");
            return `<div class="preset-item ${isActive}" onclick="applyPreset(${i})">
                <div class="preset-colors">${preview}</div>
                <span class="preset-name">${escapeHtml(preset.name)}</span>
            </div>`;
        })
        .join("");
}

function applyPreset(index) {
    const preset = PRESET_THEMES[index];
    if (!preset) return;
    applyTheme(preset.colors);
    document.getElementById("theme-input").value = preset.colors.join(",");
    renderThemeSwatches();

    const statusEl = document.getElementById("theme-status");
    statusEl.textContent = `Applied "${preset.name}" theme`;
    statusEl.className = "status success";
    setTimeout(() => (statusEl.textContent = ""), 2000);
}

function swatchChanged(index, newColor) {
    const values = getCurrentThemeValues();
    values[index] = newColor;
    applyTheme(values);
    document.getElementById("theme-input").value = values.join(",");
}

// Load saved theme on startup
function loadSavedTheme() {
    const saved = localStorage.getItem("via_theme");
    if (saved) {
        const colors = parseThemeString(saved);
        if (colors) applyTheme(colors);
    }
}

// ── Init ─────────────────────────────────────────────────────────────────────

(function () {
    loadSavedTheme();
    const repos = getSavedRepos();
    if (repos.length > 0) {
        selectRepo(repos[0].path);
    } else {
        startTerminal();
    }
})();

// ── Snippets / Aliases ───────────────────────────────────────────────────────

function getSnippets() {
    try {
        return JSON.parse(localStorage.getItem("via_snippets") || "[]");
    } catch {
        return [];
    }
}

function saveSnippets(snippets) {
    localStorage.setItem("via_snippets", JSON.stringify(snippets));
}

function renderSnippets() {
    const list = document.getElementById("snippets-list");
    const snippets = getSnippets();

    if (snippets.length === 0) {
        list.innerHTML = '<div class="empty-state">No snippets saved. Click + to add one.</div>';
        return;
    }

    list.innerHTML = snippets.map(s => {
        const slotColor = s.pinSlot != null ? SLOT_COLORS[s.pinSlot] : null;
        const pinDot = slotColor
            ? `<span title="${SLOT_NAMES[s.pinSlot]} wheel slot" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${slotColor};margin-right:5px;flex-shrink:0;"></span>`
            : '';
        const nameHtml = s.name
            ? `<div class="snippet-header"><div class="snippet-name" style="${slotColor ? `color:${slotColor}` : ''}">${pinDot}${escapeHtml(s.name)}</div></div>`
            : '';
        const cmdColor = !s.name && slotColor ? `style="color:${slotColor}"` : '';
        return `
        <div class="snippet-card">
            ${nameHtml}
            <div class="snippet-command-wrapper">
                <div class="snippet-command-text" ${cmdColor}>${!s.name && slotColor ? pinDot : ''}${escapeHtml(s.command)}</div>
                <div class="snippet-actions">
                    <button class="snippet-icon-btn" onclick="copySnippet('${s.id}')" title="Copy to clipboard">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </button>
                    <button class="snippet-icon-btn" onclick="openSnippetModal('${s.id}')" title="Edit snippet">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                    </button>
                    <button class="snippet-icon-btn primary" 
                            onclick="runSnippetContextClick(event, '${s.id}', false)" 
                            oncontextmenu="runSnippetContextClick(event, '${s.id}', true)" title="Run (Right-click for options)">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l15 8-15 8z"/></svg>
                    </button>
                </div>
            </div>
        </div>
    `}).join("");
}

function copySnippet(id) {
    const snippet = getSnippets().find(s => s.id === id);
    if (!snippet) return;
    navigator.clipboard.writeText(snippet.command).catch(err => {
        console.error('Failed to copy: ', err);
    });
}

// Snippet Context & Execution
let currentSnippetRunId = null;

function runSnippetContextClick(event, id, isRightClick = false) {
    event.preventDefault();
    event.stopPropagation();

    if (isRightClick) {
        showSnippetRunMenu(event, id);
    } else {
        // Normal click => Run immediately in current terminal
        runSnippet(id, false);
    }
}

function showSnippetRunMenu(event, id) {
    currentSnippetRunId = id;
    const menu = document.getElementById("snippet-run-context-menu");
    menu.style.display = "block";

    // Position menu
    let x = event.pageX;
    let y = event.pageY;
    if (x + menu.offsetWidth > window.innerWidth) x = window.innerWidth - menu.offsetWidth;
    if (y + menu.offsetHeight > window.innerHeight) y = window.innerHeight - menu.offsetHeight;

    menu.style.left = x + "px";
    menu.style.top = y + "px";

    const closeListener = (e) => {
        if (!menu.contains(e.target)) {
            menu.style.display = "none";
            document.removeEventListener("mousedown", closeListener);
        }
    };
    setTimeout(() => document.addEventListener("mousedown", closeListener), 0);
}

function runSnippetContext(newTerminal) {
    const menu = document.getElementById("snippet-run-context-menu");
    menu.style.display = "none";
    if (currentSnippetRunId) {
        runSnippet(currentSnippetRunId, newTerminal);
    }
}

function getCommandVars(command) {
    const matches = [...command.matchAll(/\{(\w+)\}/g)];
    return [...new Set(matches.map(m => m[1]))];
}

function runSnippet(id, newTerminal = false) {
    const snippet = getSnippets().find(s => s.id === id);
    if (!snippet) return;

    const vars = getCommandVars(snippet.command);
    if (vars.length > 0) {
        openVarModal(snippet, newTerminal);
        return;
    }

    executeSnippet(snippet, snippet.command, newTerminal);
}

function executeSnippet(snippet, command, newTerminal = false) {
    if (newTerminal) {
        addTerminalTab();
    }

    if (!activeTerminalId) {
        alert("No active terminal found.");
        return;
    }

    // Switch to terminal view to see it run
    openTool('terminal');

    // Send command, optionally followed by Enter
    const input = snippet.autoRun !== false ? command + "\r" : command;
    window.via.terminalInput(activeTerminalId, input);
}

// Variable Prompt Modal
let _varModalSnippet = null;
let _varModalNewTerminal = false;

function openVarModal(snippet, newTerminal = false) {
    _varModalSnippet = snippet;
    _varModalNewTerminal = newTerminal;

    const vars = getCommandVars(snippet.command);
    document.getElementById("snippet-var-title").textContent = snippet.name || "Run Snippet";
    document.getElementById("snippet-var-subtitle").textContent = snippet.command;

    const fields = document.getElementById("snippet-var-fields");
    fields.innerHTML = vars.map(v => `
        <div>
            <label style="display:block; font-size:11px; color:var(--text-secondary); margin-bottom:4px;">${escapeHtml(v)}</label>
            <input type="text" id="var-input-${escapeHtml(v)}" data-var="${escapeHtml(v)}"
                placeholder="${escapeHtml(v)}"
                style="width:100%; padding:6px; background:var(--bg); border:1px solid var(--border); color:var(--text); border-radius:4px; font-family:var(--mono);">
        </div>
    `).join("");

    document.getElementById("snippet-var-modal").style.display = "flex";
    // Focus first input
    const first = fields.querySelector("input");
    if (first) setTimeout(() => first.focus(), 50);

    // Submit on Enter in any input
    fields.querySelectorAll("input").forEach(input => {
        input.addEventListener("keydown", e => {
            if (e.key === "Enter") submitVarModal();
            if (e.key === "Escape") closeVarModal();
        });
    });
}

function closeVarModal() {
    document.getElementById("snippet-var-modal").style.display = "none";
    _varModalSnippet = null;
}

function submitVarModal() {
    if (!_varModalSnippet) return;
    const snippet = _varModalSnippet;
    const newTerminal = _varModalNewTerminal;
    const vars = getCommandVars(snippet.command);
    let command = snippet.command;
    for (const v of vars) {
        const val = document.getElementById(`var-input-${v}`)?.value ?? "";
        command = command.replaceAll(`{${v}}`, val);
    }
    closeVarModal();
    executeSnippet(snippet, command, newTerminal);
}

// Edit Modal
function openSnippetModal(id = null) {
    const modal = document.getElementById("snippet-edit-modal");
    const title = document.getElementById("snippet-modal-title");
    const idInput = document.getElementById("snippet-id-input");
    const nameInput = document.getElementById("snippet-name-input");
    const commandInput = document.getElementById("snippet-command-input");
    const autoRunInput = document.getElementById("snippet-autorun-input");
    const deleteBtn = document.getElementById("snippet-delete-btn");

    updateSlotPickerOccupancy(id);

    if (id) {
        const snippet = getSnippets().find(s => s.id === id);
        if (snippet) {
            title.textContent = "Edit Snippet";
            idInput.value = snippet.id;
            nameInput.value = snippet.name || "";
            commandInput.value = snippet.command || "";
            autoRunInput.checked = snippet.autoRun !== false;
            deleteBtn.style.display = "block";
            if (snippet.pinSlot != null) {
                selectSnippetSlot(snippet.pinSlot);
            } else {
                clearSnippetSlot();
            }
        }
    } else {
        title.textContent = "New Snippet";
        idInput.value = "";
        nameInput.value = "";
        commandInput.value = "";
        autoRunInput.checked = true;
        clearSnippetSlot();
        deleteBtn.style.display = "none";
    }

    modal.style.display = "flex";
    if (!id) setTimeout(() => commandInput.focus(), 50);
}

function closeSnippetModal() {
    document.getElementById("snippet-edit-modal").style.display = "none";
}

function saveSnippetModal() {
    const idInput = document.getElementById("snippet-id-input").value;
    const nameInput = document.getElementById("snippet-name-input").value.trim();
    const commandInput = document.getElementById("snippet-command-input").value.trim();

    if (!commandInput) {
        alert("Command is required.");
        return;
    }

    const autoRun = document.getElementById("snippet-autorun-input").checked;
    const slotRaw = document.getElementById("snippet-slot-input").value;
    const pinSlot = slotRaw !== "" ? parseInt(slotRaw) : null;

    const snippets = getSnippets();

    // Clear any other snippet that currently holds this slot
    if (pinSlot != null) {
        snippets.forEach(s => {
            if (s.pinSlot === pinSlot && s.id !== idInput) s.pinSlot = null;
        });
    }

    if (idInput) {
        const idx = snippets.findIndex(s => s.id === idInput);
        if (idx !== -1) {
            snippets[idx].name = nameInput;
            snippets[idx].command = commandInput;
            snippets[idx].autoRun = autoRun;
            snippets[idx].pinSlot = pinSlot;
        }
    } else {
        snippets.push({
            id: 'snippet_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            name: nameInput,
            command: commandInput,
            autoRun: autoRun,
            pinSlot: pinSlot
        });
    }

    saveSnippets(snippets);
    closeSnippetModal();
    renderSnippets();
}

function deleteSnippetFromModal() {
    const id = document.getElementById("snippet-id-input").value;
    if (!id) return;

    if (confirm("Are you sure you want to delete this snippet?")) {
        const snippets = getSnippets().filter(s => s.id !== id);
        saveSnippets(snippets);
        closeSnippetModal();
        renderSnippets();
    }
}

// ── Slot Picker ────────────────────────────────────────────────────────────
const SLOT_NAMES = ["Top", "Top Right", "Right", "Bottom Right", "Bottom", "Bottom Left", "Left", "Top Left"];
const SLOT_COLORS = ["#0ea5e9", "#a855f7", "#34d399", "#fbbf24", "#f87171", "#f97316", "#06b6d4", "#ec4899"];
const PINWHEEL_SLOTS = 8;

// Positions for each slot dot within the 120x120 picker (center at 60,60, radius 50)
const SLOT_PICKER_POSITIONS = [
    { top: 10, left: 60 },
    { top: 25, left: 95 },
    { top: 60, left: 110 },
    { top: 95, left: 95 },
    { top: 110, left: 60 },
    { top: 95, left: 25 },
    { top: 60, left: 10 },
    { top: 25, left: 25 },
];

function initSlotPicker() {
    const picker = document.getElementById("snippet-slot-picker");
    SLOT_PICKER_POSITIONS.forEach((pos, slot) => {
        const dot = document.createElement("div");
        dot.className = "slot-picker-dot";
        dot.style.top = pos.top + "px";
        dot.style.left = pos.left + "px";
        dot.dataset.slot = slot;
        dot.title = SLOT_NAMES[slot];
        dot.style.setProperty("--slot-color", SLOT_COLORS[slot]);
        dot.addEventListener("click", () => {
            if (dot.classList.contains("occupied")) {
                const editingId = document.getElementById("snippet-id-input").value;
                const taken = getSnippets().find(s => s.pinSlot === slot && s.id !== editingId);
                const takenName = taken ? (taken.name || taken.command) : "another snippet";
                if (!confirm(`Slot "${SLOT_NAMES[slot]}" is already used by "${takenName}". Reassign it?`)) return;
            }
            selectSnippetSlot(slot);
        });
        picker.appendChild(dot);
    });
}

function selectSnippetSlot(slot) {
    document.getElementById("snippet-slot-input").value = slot;
    document.getElementById("snippet-slot-label").textContent = SLOT_NAMES[slot];
    document.querySelectorAll(".slot-picker-dot").forEach(d => {
        d.classList.toggle("selected", parseInt(d.dataset.slot) === slot);
    });
}

function clearSnippetSlot() {
    document.getElementById("snippet-slot-input").value = "";
    document.getElementById("snippet-slot-label").textContent = "No slot selected";
    document.querySelectorAll(".slot-picker-dot").forEach(d => d.classList.remove("selected"));
}

function updateSlotPickerOccupancy(editingId = null) {
    const snippets = getSnippets();
    document.querySelectorAll(".slot-picker-dot").forEach(dot => {
        const slot = parseInt(dot.dataset.slot);
        const occupied = snippets.some(s => s.pinSlot === slot && s.id !== editingId);
        dot.classList.toggle("occupied", occupied);
    });
}

// ── Pinwheel ───────────────────────────────────────────────────────────────
const PINWHEEL_RADIUS = 200;
const PINWHEEL_CENTER = 230;

function renderPinwheel() {
    const container = document.getElementById("pinwheel-container");
    container.querySelectorAll(".pinwheel-item").forEach(el => el.remove());

    const snippets = getSnippets();

    for (let slot = 0; slot < PINWHEEL_SLOTS; slot++) {
        const snippet = snippets.find(s => s.pinSlot === slot);
        const angle = (slot * 45 - 90) * Math.PI / 180;
        const x = PINWHEEL_CENTER + PINWHEEL_RADIUS * Math.cos(angle);
        const y = PINWHEEL_CENTER + PINWHEEL_RADIUS * Math.sin(angle);

        const item = document.createElement("div");
        item.className = "pinwheel-item" + (snippet ? "" : " empty");
        item.dataset.slot = slot;
        item.style.left = x + "px";
        item.style.top = y + "px";
        item.style.setProperty("--slot-color", SLOT_COLORS[slot]);

        if (snippet) {
            const label = escapeHtml(snippet.name || snippet.command);
            const cmd = snippet.command.length > 22
                ? escapeHtml(snippet.command.slice(0, 22)) + "…"
                : escapeHtml(snippet.command);
            item.innerHTML = `
                <div class="pinwheel-item-name">${label}</div>
                <div class="pinwheel-item-cmd">${cmd}</div>
            `;
            item.addEventListener("mouseup", (e) => {
                e.preventDefault();
                e.stopPropagation();
                closePinwheel();
                runSnippet(snippet.id);
            });
        } else {
            item.innerHTML = `<div class="pinwheel-item-name">${SLOT_NAMES[slot]}</div>`;
        }

        // Staggered entrance animation
        item.style.animation = `pinwheel-item-in 0.2s cubic-bezier(0.34, 1.56, 0.64, 1) ${slot * 25}ms both`;

        container.appendChild(item);
    }
}

let _pinwheelActiveSlot = null;

function onPinwheelMouseMove(e) {
    const container = document.getElementById("pinwheel-container");
    const rect = container.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < 40) {
        if (_pinwheelActiveSlot !== null) {
            const prev = document.querySelector(`.pinwheel-item[data-slot="${_pinwheelActiveSlot}"]`);
            if (prev) prev.classList.remove("active");
            _pinwheelActiveSlot = null;
        }
        return;
    }

    const angleDeg = (Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360;
    const slot = Math.round(angleDeg / 45) % 8;

    if (slot === _pinwheelActiveSlot) return;

    if (_pinwheelActiveSlot !== null) {
        const prev = document.querySelector(`.pinwheel-item[data-slot="${_pinwheelActiveSlot}"]`);
        if (prev) prev.classList.remove("active");
    }

    _pinwheelActiveSlot = slot;
    const item = document.querySelector(`.pinwheel-item[data-slot="${slot}"]`);
    if (item && !item.classList.contains("empty")) {
        item.classList.add("active");
    }
}

function openPinwheel() {
    if (document.getElementById("pinwheel-overlay").style.display !== "none") return;
    _pinwheelActiveSlot = null;
    renderPinwheel();
    const overlay = document.getElementById("pinwheel-overlay");
    overlay.style.display = "flex";
    overlay.addEventListener("mousemove", onPinwheelMouseMove);
    const center = document.getElementById("pinwheel-center");
    center.classList.remove("entering");
    void center.offsetWidth;
    center.classList.add("entering");
    const removeEntering = () => center.classList.remove("entering");
    center.addEventListener("animationend", removeEntering, { once: true });
    setTimeout(removeEntering, 300);
}

function closePinwheel() {
    const overlay = document.getElementById("pinwheel-overlay");
    overlay.style.display = "none";
    overlay.removeEventListener("mousemove", onPinwheelMouseMove);
    _pinwheelActiveSlot = null;
}



function togglePinwheel() {
    const overlay = document.getElementById("pinwheel-overlay");
    if (overlay.style.display === "none") {
        openPinwheel();
    } else {
        closePinwheel();
    }
}

function handlePinwheelOverlayClick(e) {
    if (e.target === document.getElementById("pinwheel-overlay")) {
        closePinwheel();
    }
}

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        const overlay = document.getElementById("pinwheel-overlay");
        if (overlay && overlay.style.display !== "none") {
            closePinwheel();
        }
    }
});

initSlotPicker();
