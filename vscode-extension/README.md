<p align="center">
  <img src="https://img.shields.io/badge/VS%20Code-Extension-blue?logo=visualstudiocode" alt="VS Code">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT License">
  <img src="https://img.shields.io/badge/Language-EN%20%7C%20IT-purple" alt="i18n">
  <img src="https://img.shields.io/badge/Made%20with-Claude%20Code-blueviolet" alt="Claude Code">
</p>

<h1 align="center">🔒 VibeSync</h1>

<p align="center">
  <strong>The missing collaboration layer for Claude Code in VS Code</strong><br>
  Search chats, organize projects, rename sessions, prevent file conflicts — all from VS Code.
</p>

<p align="center">
  <a href="#-features">Features</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-chat-manager">Chat Manager</a> •
  <a href="#-file-locking">File Locking</a> •
  <a href="#-sync-dashboard">Sync Dashboard</a> •
  <a href="#-documentation">Docs</a>
</p>

---

> 🇮🇹 **[Leggi in Italiano](#-italiano)**

## The Problem

If you use **Claude Code** in VS Code, you know the pain:

- **🔍 Can't search past conversations** — Sessions are saved as `.jsonl` files with random names like `quiet-nibbling-spring`. Finding last week's chat? Good luck.
- **📁 No way to organize chats** — Unlike Claude Web, there are no projects, no folders, no tags. After a few weeks you have 50+ sessions and zero structure.
- **💥 File conflicts in teams** — Two developers (or AI agents) editing the same file? No warning, no lock, just merge hell.

**VibeSync fixes all of this.**

## ✨ Features

### 🔍 Chat Manager (the killer feature)

Everything Claude Web has for chat organization — **now in VS Code for Claude Code**:

| Feature | Description |
|---------|-------------|
| **Full-Text Search** | Search across all Claude Code conversations by keyword, filter by project/role |
| **Rename Chats** | Give meaningful titles and 50-char descriptions to sessions |
| **Project Organization** | Create color-coded projects, assign chats retroactively |
| **One-Click Resume** | Found the chat? Click to open `claude --resume` in the terminal |

### 🔒 File Locking

Distributed lock system via GitHub API for team coordination:

- **Automatic locks** — FileSystemWatcher detects saves, Claude Code hooks lock before AI edits
- **Real-time sidebar** — See your locks, others' locks, and the release queue
- **Conflict warnings** — Notified when someone starts working on a file you need
- **Stale cleanup** — Force-unlock abandoned locks (>24h) with one command

### 📊 Sync Dashboard

Visual file sync between your workspace and Git repo:

- Scan & compare (new, modified, identical)
- Inline diff preview with VS Code's native diff view
- Selective copy with smart filters
- Exclude files/folders with one click

### 🌐 Multilingual

Full EN/IT support. Toggle in Settings. All UI, messages, sidebar labels.

## 🚀 Quick Start

### 1. Create the config file

Create `~/.vibesync/config.json`:

```json
{
  "github_token": "ghp_YOUR_TOKEN",
  "github_repo": "your-org/your-repo",
  "github_branch": "main",
  "github_lock_branch": "vibesync-locks",
  "developer_name": "YourName",
  "local_root": "/path/to/your/project",
  "github_desktop_root": "/path/to/git/repo",
  "excluded_dirs": ["node_modules", ".vscode"]
}
```

> See [`config.example.json`](config.example.json) for a full template.

### 2. Install the extension

```bash
# From .vsix (download from Releases)
code --install-extension vibesync-1.0.0.vsix --force
```

### 3. Start using it

1. Click the **🔒 lock icon** in the VS Code sidebar
2. **Search Chats** — find and resume any past conversation
3. **Chat Projects** — organize sessions into themed folders
4. **Sync Dashboard** — push changed files to your Git repo
5. File locks happen **automatically** when you save

## Claude Code vs Claude Code + VibeSync

| Feature | Claude Code | + VibeSync |
|---------|:-----------:|:----------:|
| Search past conversations | ❌ | ✅ Full-text |
| Rename chat sessions | ❌ | ✅ Title + description |
| Organize chats in projects | ❌ | ✅ Color-coded |
| Resume old conversations | `--resume` | ✅ One click |
| File lock coordination | ❌ | ✅ Auto via GitHub |
| Conflict warnings | ❌ | ✅ Real-time |
| File sync to Git | ❌ | ✅ Visual dashboard |
| Multilingual UI | ❌ | ✅ EN / IT |

## 📖 Documentation

- **[Interactive Guide (EN/IT)](https://aresbi.github.io/vibesync/)** — Navigable presentation with full feature walkthrough
- **[Contributing](CONTRIBUTING.md)** — How to contribute, dev setup, adding languages

## 🏗 Architecture

```
┌──────────────────┐    ┌─────────────────────────┐
│  Claude Code     │    │  VS Code + Extension     │
│  (hooks)         │    │  (lockManager, panels)   │
└────────┬─────────┘    └────────────┬────────────┘
         │                           │
         │  GitHub API               │  Python scripts
         │                           │
    ┌────┴───────────────────────────┴────┐
    │                                      │
    │   LOCKS.json (branch vibesync-locks) │
    │   GitHub: your-org/your-repo         │
    │                                      │
    └──────────────────────────────────────┘
```

## Requirements

- **VS Code** 1.85+
- **Python** 3.8+ (for CLI scripts)
- **GitHub** repo with a Personal Access Token (repo scope)

## License

MIT — see [LICENSE](LICENSE)

---

<h2 id="-italiano">🇮🇹 Italiano</h2>

### Il Problema

Se usi **Claude Code** in VS Code, conosci il problema:

- **🔍 Non puoi cercare nelle chat passate** — Le sessioni sono salvate come file `.jsonl` con nomi casuali. Trovare la chat di settimana scorsa? Buona fortuna.
- **📁 Nessun modo di organizzare le conversazioni** — A differenza di Claude Web, Claude Code non ha progetti, cartelle né tag.
- **💥 Conflitti sui file nel team** — Due developer che modificano lo stesso file? Nessun avviso, solo merge hell.

### Funzionalità Principali

- **🔍 Chat Manager** — Ricerca full-text, rinomina sessioni, organizzazione in progetti colorati, riprendi chat con un click
- **🔒 File Locking** — Lock automatici via GitHub API, sidebar real-time, avvisi conflitto, pulizia lock scaduti
- **📊 Sync Dashboard** — Confronto visuale workspace/repo, diff inline, copia selettiva, esclusioni
- **🌐 Multilingua** — Toggle EN/IT nelle impostazioni

### Guida Rapida

1. Crea `~/.vibesync/config.json` (vedi [`config.example.json`](config.example.json))
2. Installa l'estensione: `code --install-extension vibesync-1.0.0.vsix --force`
3. Apri la sidebar VibeSync (icona lucchetto) e inizia!

**[Guida interattiva completa (ITA/ENG)](https://aresbi.github.io/vibesync/)**

---

<p align="center">
  <strong>VibeSync</strong> by <a href="https://github.com/AReS-BI">AReS-BI</a> — AI-aware file coordination for vibe coding teams
</p>
