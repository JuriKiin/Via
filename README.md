<div align="center">
  <img src="logo.png" alt="Via Logo" width="128" />
  <h1>Via</h1>
</div>

A lightweight git UI with an embedded terminal. Via acts as a bridge for people who normally use UI tools for git but want to become more terminal-friendly — while keeping helpful visual tools like side-by-side diffs.

![Via Interface](screenshots/demo-1.png)

## Features

- **Embedded terminal** — Full PTY shell that opens in your repo directory, with multiple tabs and per-repo sessions
- **Real-time diff panel** — See your uncommitted changes update live, with collapsible file sections and unified/split view
- **Discard changes** — Discard all changes or individual files directly from the diff panel

![Diff Panel](screenshots/demo-2.png)

- **Search Commits** — Find commits that touched specific files in a date range, with syntax-highlighted diffs
- **Branch switching** — View and switch branches from the sidebar
- **Git Reference** — Built-in cheat sheet of common git commands

![Git Reference](screenshots/demo-3.png)

- **Snippets & Aliases** — Save frequently used terminal workflows and execute them instantly in your active or new tabs

![Snippets](screenshots/demo-6.png)

- **Customizable themes** — Choose from built-in presets or create your own with custom color schemes
- **Native macOS app** — Built with Electron

![Customization](screenshots/demo-4.png)

![Terminal View](screenshots/demo-5.png)

## Install from DMG

1. Download the latest `.dmg` from [Releases](https://github.com/JuriKiin/Via/releases)
2. Open the `.dmg` and drag **Via** to your Applications folder
3. Launch Via from Applications

### macOS Gatekeeper warning

Via is open source and not signed with an Apple Developer certificate, so macOS will block the first launch. To fix this, run the following after installing:

```bash
xattr -cr /Applications/Via.app
```

Or: **System Settings > Privacy & Security**, scroll down, and click **Open Anyway** next to the Via warning.

## Build from Source

Requires [Node.js](https://nodejs.org/) (v18+) and git.

```bash
# Clone the repo
git clone https://github.com/JuriKiin/Via.git
cd Via

# Install dependencies
npm install

# Build the .dmg and .app
npm run build
```

The built `Via.dmg` (installer) and `Via.app` will be in `dist/`.

To run the `.app` directly:

```bash
open dist/mac-*/Via.app
```

## Development

```bash
npm install
npm start
```

This runs Electron directly for fast iteration. The dock icon will show "Electron" instead of "Via" in dev mode — this is normal.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+M` | Toggle sidebar |
| `Cmd+T` | Open terminal |
| `Cmd+N` | New terminal tab |
| `Cmd+F` | Search commits |
| `Cmd+P` | Open repository |
