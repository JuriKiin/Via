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

function saveRepos(repos) {
    localStorage.setItem("via_repos", JSON.stringify(repos));
}

function renderSavedRepos() {
    const container = document.getElementById("saved-repos");
    const repos = getSavedRepos();

    if (repos.length === 0) {
        container.innerHTML = '<p class="empty-repos">No repositories yet</p>';
        return;
    }

    container.innerHTML = repos
        .map(
            (r) => `
            <div class="repo-item ${r.path === repoPath ? "active" : ""}" onclick="selectRepo('${escapeHtml(r.path)}')">
                <div class="repo-item-info">
                    <span class="repo-item-name">${escapeHtml(r.name)}</span>
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
        const repos = getSavedRepos();
        if (!repos.some((r) => r.path === data.path)) {
            repos.push({ name: data.name, path: data.path });
            saveRepos(repos);
        }
        selectRepo(data.path);
    } else {
        alert("The selected folder is not a git repository.");
    }
}

function removeRepo(path) {
    const repos = getSavedRepos().filter((r) => r.path !== path);
    saveRepos(repos);

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

    const container = document.getElementById("branch-diff-container");
    if (!newDiff) {
        container.innerHTML = '<div class="empty-state">No uncommitted changes</div>';
        return;
    }

    const targetElement = document.createElement("div");
    container.innerHTML = "";
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

function switchBranchDiffMode(mode) {
    branchDiffMode = mode;
    document.getElementById("diff-mode-unified").classList.toggle("active", mode === "line-by-line");
    document.getElementById("diff-mode-split").classList.toggle("active", mode === "side-by-side");
    lastDiffText = "";
    refreshBranchDiff(true);
}

async function discardFileChange(file, statusCode) {
    if (!repoPath) return;
    if (!confirm(`Discard changes to "${file}"? This cannot be undone.`)) return;

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
                `<span class="chip">${escapeHtml(f)}<button onclick="cfRemoveFile('${escapeHtml(f)}')">&times;</button></span>`
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
    const btn = document.querySelector(`.quick-filter[onclick="applyQuickFilter(${days})"]`);
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
            : `${searchResults.length} commit${searchResults.length === 1 ? "" : "s"}`;
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
                </div>`
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
        ghLink.href = `${githubBaseUrl}/commit/${commit.hash}`;
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

document.getElementById("diff-context-discard").addEventListener("mousedown", (e) => {
    e.stopPropagation();
    if (!diffContextFile) return;
    const file = diffContextFile;
    const code = getStatusCodeForFile(file) || " M";
    hideDiffContextMenu();
    discardFileChange(file, code);
});

document.addEventListener("mousedown", (e) => {
    if (!e.target.closest(".diff-context-menu")) hideDiffContextMenu();
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

    const data = await window.via.listBranches(repoPath);

    if (!branchDropdownOpen) return; // closed while loading

    if (data.branches.length === 0) {
        dropdown.innerHTML = '<div class="branch-dropdown-item" style="color:var(--text-secondary)">No branches</div>';
        return;
    }

    dropdown.innerHTML = data.branches
        .map((b) => {
            const isCurrent = b === data.current ? "current" : "";
            return `<div class="branch-dropdown-item ${isCurrent}" onclick="selectBranch('${escapeHtml(b)}')">${escapeHtml(b)}${b === data.current ? " (current)" : ""}</div>`;
        })
        .join("");
}

async function selectBranch(branch) {
    const dropdown = document.getElementById("branch-dropdown");
    dropdown.style.display = "none";
    branchDropdownOpen = false;

    const result = await window.via.checkoutBranch(repoPath, branch);
    if (result.ok) {
        document.getElementById("current-branch").textContent = branch;
        refreshBranchDiff();
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
        statusEl.textContent = `Expected ${THEME_KEYS.length} hex colors (#rrggbb) separated by commas`;
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
    THEME_KEYS.forEach((k) => root.style.removeProperty(`--${k}`));
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
