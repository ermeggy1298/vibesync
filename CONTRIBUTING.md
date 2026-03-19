# Contributing to VibeSync

Thank you for your interest in contributing to VibeSync!

## How to Contribute

### Reporting Bugs
- Open an issue on GitHub with a clear description
- Include your VS Code version and OS
- Steps to reproduce the bug

### Suggesting Features
- Open an issue with the `enhancement` label
- Describe the use case and expected behavior

### Pull Requests
1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Compile: `npm run compile`
5. Test the extension locally (F5 in VS Code)
6. Commit with a descriptive message
7. Push and open a Pull Request

### Development Setup

```bash
# Clone the repo
git clone https://github.com/ermeggy1298/vibesync.git
cd vibesync

# Setup (installs everything automatically)
python install.py

# For extension development:
cd vscode-extension
npm install
npm run compile
npm run watch    # auto-recompile on save
npm run package  # build .vsix
```

### Project Structure
```
vibesync/
├── cli/           — Python CLI scripts (lock, release, search, sync)
├── hooks/         — Claude Code hooks (guard + stop)
├── vscode-extension/
│   └── src/       — TypeScript source
│       ├── i18n.ts          — All translations (add new languages here!)
│       ├── searchPanel.ts   — Chat search & projects UI
│       └── syncPanel.ts     — Sync dashboard UI
├── docs/          — Landing page (GitHub Pages)
└── install.py     — Automated setup script
```

### Adding a New Language
1. Add a new dictionary in `src/i18n.ts` following the `en` / `it` pattern
2. Add the language to the `vibesync.language` enum in `package.json`
3. Create `package.nls.<lang>.json` for static VS Code strings

## Code Style
- TypeScript with strict mode
- No external runtime dependencies (VS Code API + Node.js built-ins only)
- Keep webview HTML in template literals within the TypeScript files

## License
By contributing, you agree that your contributions will be licensed under the MIT License.
