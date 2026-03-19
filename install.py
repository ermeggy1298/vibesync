#!/usr/bin/env python3
"""
VibeSync Installer
Automated setup: config, hooks, CLI scripts, VS Code extension.

Usage:
    python install.py
"""

import os
import sys
import json
import shutil
import subprocess
from pathlib import Path


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).parent.resolve()
VIBESYNC_HOME = Path.home() / ".vibesync"
CONFIG_PATH = VIBESYNC_HOME / "config.json"
HOOKS_DEST = VIBESYNC_HOME / "hooks"
CLI_DEST = VIBESYNC_HOME / "cli"

HOOKS_SRC = SCRIPT_DIR / "hooks"
CLI_SRC = SCRIPT_DIR / "cli"
VSCODE_EXT_DIR = SCRIPT_DIR / "vscode-extension"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def detect_python() -> str:
    """
    Find a working Python executable.
    On Windows, 'python' often points to the Microsoft Store stub that doesn't work.
    We check multiple candidates and return the first that actually runs.
    """
    candidates = []

    # 1. The Python running this script (always works)
    candidates.append(sys.executable)

    # 2. Common names
    candidates.extend(["python3", "python", "py"])

    # 3. Common Windows locations
    if sys.platform == "win32":
        home = Path.home()
        # Anaconda
        for p in [home / "anaconda3" / "python.exe", home / "miniconda3" / "python.exe"]:
            candidates.append(str(p))
        # Standard Python install
        import glob
        for pattern in [
            "C:/Python3*/python.exe",
            str(home / "AppData/Local/Programs/Python/Python3*/python.exe"),
            "C:/Program Files/Python3*/python.exe",
        ]:
            candidates.extend(glob.glob(pattern))

    # Test each candidate
    for candidate in candidates:
        try:
            result = subprocess.run(
                [str(candidate), "--version"],
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode == 0 and "Python" in result.stdout:
                return str(candidate).replace("\\", "/")
        except Exception:
            continue

    # Fallback — return sys.executable (we know it works, we're running in it)
    return sys.executable.replace("\\", "/")


def banner():
    print()
    print("  ╔══════════════════════════════════════════╗")
    print("  ║        🔒 VibeSync Installer             ║")
    print("  ║   AI-aware coordination for vibe coding   ║")
    print("  ╚══════════════════════════════════════════╝")
    print()


def ask(prompt: str, default: str = "") -> str:
    """Ask user for input with optional default."""
    if default:
        result = input(f"  {prompt} [{default}]: ").strip()
        return result if result else default
    else:
        while True:
            result = input(f"  {prompt}: ").strip()
            if result:
                return result
            print("    ⚠ This field is required.")


def ask_path(prompt: str, default: str = "") -> str:
    """Ask for a path, normalizing slashes."""
    raw = ask(prompt, default)
    return raw.replace("\\", "/")


def confirm(prompt: str) -> bool:
    """Yes/no confirmation."""
    result = input(f"  {prompt} [Y/n]: ").strip().lower()
    return result in ("", "y", "yes")


def success(msg: str):
    print(f"  ✅ {msg}")


def info(msg: str):
    print(f"  ℹ  {msg}")


def warn(msg: str):
    print(f"  ⚠  {msg}")


def error(msg: str):
    print(f"  ❌ {msg}")


# ---------------------------------------------------------------------------
# Step 1: Collect configuration
# ---------------------------------------------------------------------------

def collect_config() -> dict:
    print("─── Step 1/5: Configuration ───────────────────────────")
    print()
    print("  We need a few details to set up VibeSync.")
    print("  You'll need a GitHub Personal Access Token with 'repo' scope.")
    print()

    token = ask("GitHub Personal Access Token (ghp_...)")
    repo = ask("GitHub repository (owner/repo)")
    branch = ask("Main branch", "main")
    lock_branch = ask("Lock branch (for storing locks)", "vibesync-locks")
    dev_name = ask("Your developer name (shown in locks)")
    local_root = ask_path("Your local project folder (where you code)")
    github_root = ask_path("Your Git repo folder (where you commit from)")

    print()
    excluded_input = ask(
        "Folders to exclude from sync (comma-separated)",
        "node_modules,.vscode,__pycache__"
    )
    excluded_dirs = [d.strip() for d in excluded_input.split(",") if d.strip()]

    config = {
        "github_token": token,
        "github_repo": repo,
        "github_branch": branch,
        "github_lock_branch": lock_branch,
        "developer_name": dev_name,
        "local_root": local_root,
        "github_desktop_root": github_root,
        "excluded_dirs": excluded_dirs,
        "excluded_files": [".env", ".gitignore"],
    }

    print()
    print("  Your configuration:")
    print(f"    Repo:       {repo}")
    print(f"    Branch:     {branch}")
    print(f"    Developer:  {dev_name}")
    print(f"    Local root: {local_root}")
    print(f"    Git root:   {github_root}")
    print(f"    Excluded:   {', '.join(excluded_dirs)}")
    print()

    if not confirm("Save this configuration?"):
        print("  Aborted.")
        sys.exit(0)

    return config


# ---------------------------------------------------------------------------
# Step 2: Save config
# ---------------------------------------------------------------------------

def save_config(config: dict):
    print()
    print("─── Step 2/5: Saving configuration ────────────────────")
    VIBESYNC_HOME.mkdir(parents=True, exist_ok=True)

    if CONFIG_PATH.exists():
        if not confirm(f"Config already exists at {CONFIG_PATH}. Overwrite?"):
            info("Keeping existing config.")
            return

    CONFIG_PATH.write_text(json.dumps(config, indent=2), encoding="utf-8")
    success(f"Config saved to {CONFIG_PATH}")


# ---------------------------------------------------------------------------
# Step 3: Copy hooks and CLI scripts
# ---------------------------------------------------------------------------

def copy_files():
    print()
    print("─── Step 3/5: Installing hooks and CLI scripts ────────")

    # Hooks
    HOOKS_DEST.mkdir(parents=True, exist_ok=True)
    for src_file in HOOKS_SRC.glob("*.py"):
        dest = HOOKS_DEST / src_file.name
        shutil.copy2(src_file, dest)
    success(f"Hooks installed to {HOOKS_DEST}")

    # CLI scripts
    CLI_DEST.mkdir(parents=True, exist_ok=True)
    for src_file in CLI_SRC.glob("*.py"):
        dest = CLI_DEST / src_file.name
        shutil.copy2(src_file, dest)
    success(f"CLI scripts installed to {CLI_DEST}")


# ---------------------------------------------------------------------------
# Step 4: Configure Claude Code hooks
# ---------------------------------------------------------------------------

def configure_claude_hooks(config: dict):
    print()
    print("─── Step 4/5: Configuring Claude Code hooks ────────────")

    local_root = config.get("local_root", "")
    if not local_root:
        warn("No local_root in config, skipping hook setup.")
        return

    claude_dir = Path(local_root) / ".claude"
    settings_path = claude_dir / "settings.json"

    guard_path = str(HOOKS_DEST / "vibesync_guard.py").replace("\\", "/")
    stop_path = str(HOOKS_DEST / "vibesync_stop.py").replace("\\", "/")

    python_cmd = detect_python()
    info(f"Using Python: {python_cmd}")

    vibesync_hooks = {
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "Edit|MultiEdit|Write",
                    "hooks": [
                        {
                            "type": "command",
                            "command": f"{python_cmd} {guard_path}"
                        }
                    ]
                }
            ],
            "Stop": [
                {
                    "hooks": [
                        {
                            "type": "command",
                            "command": f"{python_cmd} {stop_path}"
                        }
                    ]
                }
            ]
        }
    }

    # Load existing settings or create new
    existing = {}
    if settings_path.exists():
        try:
            existing = json.loads(settings_path.read_text(encoding="utf-8"))
        except Exception:
            existing = {}

    # Merge hooks — don't overwrite existing non-VibeSync hooks
    if "hooks" not in existing:
        existing["hooks"] = {}

    for event_name, event_hooks in vibesync_hooks["hooks"].items():
        if event_name not in existing["hooks"]:
            existing["hooks"][event_name] = []

        # Remove old VibeSync hooks if present
        existing["hooks"][event_name] = [
            h for h in existing["hooks"][event_name]
            if not any(
                "vibesync_guard" in hook.get("command", "") or
                "vibesync_stop" in hook.get("command", "")
                for hook in h.get("hooks", [])
            )
        ]

        # Add new VibeSync hooks
        existing["hooks"][event_name].extend(event_hooks)

    claude_dir.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(json.dumps(existing, indent=2), encoding="utf-8")
    success(f"Claude Code hooks configured in {settings_path}")
    info(f"  Guard: {python_cmd} {guard_path}")
    info(f"  Stop:  {python_cmd} {stop_path}")


# ---------------------------------------------------------------------------
# Step 5: Build and install VS Code extension
# ---------------------------------------------------------------------------

def install_extension():
    print()
    print("─── Step 5/5: VS Code extension ────────────────────────")

    # Check if npm is available
    npm_available = False
    try:
        result = subprocess.run(
            ["npm", "--version"], capture_output=True, text=True, timeout=10
        )
        npm_available = result.returncode == 0
    except Exception:
        pass

    # Check if code CLI is available
    code_available = False
    try:
        result = subprocess.run(
            ["code", "--version"], capture_output=True, text=True, timeout=10
        )
        code_available = result.returncode == 0
    except Exception:
        pass

    vsix_path = None

    # Check for pre-built VSIX in the extension dir
    for f in VSCODE_EXT_DIR.glob("*.vsix"):
        vsix_path = f
        break

    if not vsix_path and npm_available:
        if confirm("Build the VS Code extension from source?"):
            info("Installing npm dependencies...")
            subprocess.run(
                ["npm", "install"],
                cwd=str(VSCODE_EXT_DIR),
                capture_output=True,
                timeout=120
            )

            info("Building extension...")
            result = subprocess.run(
                ["npx", "vsce", "package"],
                cwd=str(VSCODE_EXT_DIR),
                capture_output=True,
                text=True,
                timeout=120
            )

            if result.returncode == 0:
                for f in VSCODE_EXT_DIR.glob("*.vsix"):
                    vsix_path = f
                    break
                if vsix_path:
                    success(f"Extension built: {vsix_path.name}")
            else:
                warn("Build failed. You can build manually later:")
                print(f"    cd {VSCODE_EXT_DIR}")
                print("    npm install && npx vsce package")

    if vsix_path and code_available:
        if confirm(f"Install {vsix_path.name} in VS Code?"):
            result = subprocess.run(
                ["code", "--install-extension", str(vsix_path), "--force"],
                capture_output=True,
                text=True,
                timeout=60
            )
            if result.returncode == 0:
                success("Extension installed in VS Code!")
                info("Reload VS Code to activate: Ctrl+Shift+P → 'Reload Window'")
            else:
                warn("Could not install automatically. Install manually:")
                print(f"    code --install-extension {vsix_path} --force")
    elif vsix_path:
        info(f"VS Code CLI not found. Install the extension manually:")
        print(f"    code --install-extension {vsix_path} --force")
    else:
        info("No .vsix found. Build it first:")
        print(f"    cd {VSCODE_EXT_DIR}")
        print("    npm install && npx vsce package")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def choose_mode() -> str:
    """Ask user which mode to install."""
    print("─── Choose installation mode ──────────────────────────")
    print()
    print("  [1] 💬 Chat Manager only  (no GitHub needed)")
    print("      Search, rename, organize Claude Code conversations.")
    print("      Zero configuration. Just install and go.")
    print()
    print("  [2] 🔒 Full setup  (team collaboration)")
    print("      Everything in Chat Manager PLUS:")
    print("      File locking, sync dashboard, conflict warnings.")
    print("      Requires a GitHub repo and token.")
    print()

    while True:
        choice = input("  Your choice [1/2]: ").strip()
        if choice in ("1", "2"):
            return "chat" if choice == "1" else "full"
        print("    Please enter 1 or 2.")


def save_vscode_python_path(python_cmd: str):
    """Save the detected Python path to VS Code settings for the extension."""
    vscode_settings_dir = Path.home() / ".config" / "Code" / "User"
    if sys.platform == "win32":
        vscode_settings_dir = Path(os.environ.get("APPDATA", "")) / "Code" / "User"
    settings_path = vscode_settings_dir / "settings.json"

    try:
        existing = {}
        if settings_path.exists():
            raw = settings_path.read_text(encoding="utf-8")
            # Handle trailing commas (common in VS Code settings)
            import re
            raw = re.sub(r',\s*([}\]])', r'\1', raw)
            existing = json.loads(raw)

        existing["vibesync.pythonPath"] = python_cmd
        vscode_settings_dir.mkdir(parents=True, exist_ok=True)
        settings_path.write_text(json.dumps(existing, indent=4), encoding="utf-8")
        success(f"VS Code setting vibesync.pythonPath = {python_cmd}")
    except Exception as e:
        warn(f"Could not update VS Code settings: {e}")
        info(f"Set manually: VS Code Settings → vibesync.pythonPath = {python_cmd}")


def main():
    banner()

    # Detect Python early
    python_cmd = detect_python()
    info(f"Python detected: {python_cmd}")
    print()

    mode = choose_mode()

    if mode == "full":
        config = collect_config()
        save_config(config)
        copy_files()
        configure_claude_hooks(config)
    else:
        # Chat Manager only — just ensure ~/.vibesync/ exists
        VIBESYNC_HOME.mkdir(parents=True, exist_ok=True)
        # Copy CLI scripts (search works without config)
        CLI_DEST.mkdir(parents=True, exist_ok=True)
        for src_file in CLI_SRC.glob("*.py"):
            shutil.copy2(src_file, CLI_DEST / src_file.name)
        success("CLI scripts installed (chat search available)")

    # Save Python path to VS Code settings
    save_vscode_python_path(python_cmd)

    install_extension()

    print()
    print("  ╔══════════════════════════════════════════╗")
    print("  ║       🎉 VibeSync is ready!              ║")
    print("  ╚══════════════════════════════════════════╝")
    print()
    print("  Next steps:")
    print("    1. Open/reload VS Code")
    print("    2. Click the 🔒 lock icon in the sidebar")
    print("    3. Use 'Search Chats' to find past conversations")
    print("    4. Use 'Chat Projects' to organize your sessions")
    print()

    if mode == "full":
        print("  Config:  ~/.vibesync/config.json")
        print("  Hooks:   ~/.vibesync/hooks/")
        print("  CLI:     ~/.vibesync/cli/")
    else:
        print("  💡 To enable file locking & sync later,")
        print("     run: python install.py  (choose Full setup)")
    print()
    print("  Docs: https://github.com/ermeggy1298/vibesync")
    print()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n  Aborted.")
        sys.exit(1)
