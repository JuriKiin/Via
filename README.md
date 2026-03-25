# GitFinder

A local web tool for narrowing down which commits may have caused an issue. Point it at a git repo, pick some files, set a date range, and see every commit that touched those files — with syntax-highlighted diffs.

Useful when you know an issue started within a time window and want to find the impacting change without digging through `git log` in the terminal.

<video src="https://github.com/JuriKiin/CommitFinder/Demo.mp4" width="100%"></video>

## Quick Start

```bash
git clone <repo-url> && cd GitFinder
chmod +x run.sh
./run.sh
```

That's it. The script creates a Python virtual environment, installs Flask, and opens the app in your browser at `http://localhost:5050`.

## Requirements

- Python 3.9+
- Git

No other dependencies. Flask is installed automatically into a local `.venv`.

## Usage

1. **Add a repository** — click "+ Add repository" and paste the path to a local git repo. Saved repos persist across sessions via localStorage.
2. **Search files** — type a filename fragment to get autocomplete suggestions. Select one or more files.
3. **Set a date range** — pick the start and end dates for the window you want to investigate.
4. **Search** — click "Search Commits" to see all commits that touched your selected files in that window.
5. **Inspect a commit** — click any commit to see the full diff with syntax highlighting. If the repo has a GitHub remote, a "View on GitHub" link is included.

## Sharing with coworkers

Clone the repo and run `./run.sh`. That's the entire setup — no Node, no build step, no global installs.
