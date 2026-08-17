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
  <a href="#-chat-manager-the-killer-feature">Chat Manager</a> •
  <a href="#-file-locking">File Locking</a> •
  <a href="#-sync-dashboard">Sync Dashboard</a> •
  <a href="#-ai-recap-new">AI Recap</a> •
  <a href="#-telegram-notifications-new">Telegram</a> •
  <a href="#-vibebuddy-new">VibeBuddy</a> •
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

### ✨ AI Recap (NEW)

**The feature no one else has.** Ask *"what did Massimo do between Aug 14 and Aug 17?"* and get back a structured technical narrative — grouped by functional area (CoGe, FinRisk, UI, Auth, …) — inferred by Claude from the actual code paths and commit messages of your monorepo.

- Pick author + date range from the panel — VibeSync runs `git log --author=X --since=... --until=...` on your Git repo
- Sends the full diff to Claude (Sonnet 5 recommended, Opus 5 for max quality, Haiku 4.5 for cheap)
- Returns an HTML with: **Overview** → **By functional area** → **Attention points** (risky auth/SQL/migration changes) → **Commit timeline**
- Save to disk in `~/.vibesync/recaps/` for future reference
- Typical cost: ~$0.02–0.05 per recap with Sonnet, ~$0.004 with Haiku

Why it's killer: Slack/Linear/GitHub are generalist — they don't know that `DbPuma/finrisk/` is FinRisk and `ui/src/components/CrCheck/` is CrCheck. An LLM with your monorepo context does, and describes the work in your team's language.

### 📱 Telegram Notifications (NEW)

Bot notifications to your team the moment you release files from the Sync Dashboard.

- One-time setup: create a bot with `@BotFather`, each dev sends `/start` to get their `chat_id`
- Configure in Settings → Notifications: bot token + list of recipients
- When you click "Release Selected" on the Sync Dashboard, all teammates get a Telegram message like:
  `🚀 Meggio released 3 files on "dev": • DbPuma/views.py • ...`
- The sender is auto-skipped (unless `notify_self` is enabled)
- Best-effort: failures don't block the release, they surface as VS Code warnings

### 🤖 VibeBuddy (NEW)

An AI companion inside VS Code (Claude Haiku) that observes your coding sessions and narrates what's happening — files touched, patterns detected, welcome-back messages after inactivity. Adjustable verbosity (quiet / normal / chatty). Requires Anthropic API key.

### 🌐 Multilingual

Full EN/IT support. Toggle in Settings. All UI, messages, sidebar labels.

## 🚀 Quick Start

### One-command setup

```bash
git clone https://github.com/ermeggy1298/vibesync.git
python vibesync/install.py
```

> **Windows note:** If `python` opens the Microsoft Store, use the full path to your Python, e.g.:
> `C:\Users\YourName\anaconda3\python.exe vibesync\install.py`

The installer auto-detects your Python path and configures everything.

**Chat Manager only** (option 1): zero config, just installs the extension. Search, rename, organize your Claude Code chats immediately.

**Full setup** (option 2): also configures file locking, sync dashboard, and Claude Code hooks. Requires a GitHub repo and token.

> You'll need: **Python 3.8+**, **VS Code**. For Full setup also: **GitHub** repo with a Personal Access Token (`repo` scope).

### Manual setup

If you prefer to configure manually, see [`config.example.json`](config.example.json) for the config template.

### Start using it

1. Open/reload VS Code
2. Click the **🔒 lock icon** in the sidebar
3. **Search Chats** — find and resume any past conversation
4. **Chat Projects** — organize sessions into themed folders
5. **Sync Dashboard** — push changed files to your Git repo
6. File locks happen **automatically** when you or Claude Code save a file

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
| **AI recap of teammate's commits** | ❌ | ✅ Grouped by area |
| **Telegram alerts on release** | ❌ | ✅ Bot to team |
| **AI coding companion** | ❌ | ✅ VibeBuddy (Haiku) |
| Multilingual UI | ❌ | ✅ EN / IT |

## 📖 Documentation

- **[Interactive Guide (EN/IT)](https://ermeggy1298.github.io/vibesync/)** — Navigable presentation with full feature walkthrough
- **[Contributing](CONTRIBUTING.md)** — How to contribute, dev setup, adding languages

## 🏗 Architecture

```
┌──────────────────┐    ┌─────────────────────────┐
│  Claude Code     │    │  VS Code + Extension     │
│                  │    │  Chat Manager, Sync,     │
│  PreToolUse hook │    │  Sidebar, Settings       │
│  (vibesync_guard)│    │                          │
│                  │    │  FileSystemWatcher        │
│  Stop hook       │    │  (auto-lock on save)     │
│  (vibesync_stop) │    │                          │
└────────┬─────────┘    └────────────┬────────────┘
         │                           │
         │  GitHub API               │  Python CLI scripts
         │  (lock/unlock)            │  (search, sync, release)
         │                           │
    ┌────┴───────────────────────────┴────┐
    │                                      │
    │   LOCKS.json (branch vibesync-locks) │
    │   GitHub: your-org/your-repo         │
    │                                      │
    └──────────────────────────────────────┘

~/.vibesync/
├── config.json          ← your settings
├── chat_projects.json   ← chat titles, projects, assignments
├── hooks/               ← Claude Code hook scripts
└── cli/                 ← CLI tools (search, sync, lock, release)
```

## Requirements

- **Python** 3.8+ (no external packages needed)
- **VS Code** 1.85+
- **Node.js/npm** (only for building the extension from source)
- **GitHub** repo with a Personal Access Token (`repo` scope)

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
- **✨ AI Recap** (NUOVO) — Chiedi *"cosa ha fatto Massimo dal 14 al 17 agosto"* e ricevi un narrativo tecnico raggruppato per area funzionale (CoGe, FinRisk, UI, Auth…). Interroga `git log` per autore/date e passa il diff a Claude Sonnet, che deduce le aree dai path del monorepo. HTML salvabile su disco.
- **📱 Notifiche Telegram** (NUOVO) — Bot che avvisa il team al momento del rilascio dalla Sync Dashboard. Setup di 5 minuti con `@BotFather` + `chat_id` per dev. Skip auto-notifica al mittente.
- **🤖 VibeBuddy** (NUOVO) — AI companion (Claude Haiku) dentro VS Code che commenta la tua sessione di coding, con verbosità configurabile
- **🌐 Multilingua** — Toggle EN/IT nelle impostazioni

### Guida Rapida

```bash
git clone https://github.com/ermeggy1298/vibesync.git
python vibesync/install.py
```

> **Windows:** Se `python` apre il Microsoft Store, usa il path completo, es: `C:\Users\TuoNome\anaconda3\python.exe vibesync\install.py`

L'installer rileva Python automaticamente e offre 2 modalità: **Chat Manager only** (zero config) o **Full setup** (locking + sync + hooks).

**[Guida interattiva completa (ITA/ENG)](https://ermeggy1298.github.io/vibesync/)**

---

<p align="center">
  <strong>VibeSync</strong> by <a href="https://github.com/ermeggy1298">AReS-BI</a> — AI-aware file coordination for vibe coding teams
</p>
