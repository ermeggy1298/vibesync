"""
VibeSync Release — Script rilascio file con conflict preview
Copia i file modificati da Puma_backend alla cartella GitHub Desktop.

Uso:
    python vibesync_release.py --list
    python vibesync_release.py --preview file1 file2 ...
    python vibesync_release.py --release file1 file2 ...

Output: JSON su stdout

Parte di VibeSync by AReS-BI
"""

import sys
import json
import os
import shutil
import difflib
import argparse
from datetime import datetime, timezone
from pathlib import Path


# ---------------------------------------------------------------------------
# Costanti
# ---------------------------------------------------------------------------

CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".vibesync", "config.json")
RELEASE_QUEUE_PATH = os.path.join(os.path.expanduser("~"), ".vibesync", "RELEASE_QUEUE.json")
LOG_PATH = os.path.join(os.path.expanduser("~"), ".vibesync", "vibesync.log")


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def log(message: str) -> None:
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{timestamp}] [release] {message}\n")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Config e Release Queue
# ---------------------------------------------------------------------------

def load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def load_release_queue() -> dict:
    if not os.path.exists(RELEASE_QUEUE_PATH):
        return {"queue": []}
    with open(RELEASE_QUEUE_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_release_queue(queue_data: dict) -> None:
    os.makedirs(os.path.dirname(RELEASE_QUEUE_PATH), exist_ok=True)
    with open(RELEASE_QUEUE_PATH, "w", encoding="utf-8") as f:
        json.dump(queue_data, f, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

def days_ago(iso_timestamp: str) -> int:
    """Calcola quanti giorni fa rispetto a ora."""
    try:
        dt = datetime.fromisoformat(iso_timestamp.replace("Z", "+00:00"))
        delta = datetime.now(timezone.utc) - dt
        return delta.days
    except Exception:
        return -1


def count_lines(file_path: str) -> int:
    """Conta le righe di un file. Ritorna 0 se non esiste."""
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            return sum(1 for _ in f)
    except (FileNotFoundError, OSError):
        return 0


def read_file_lines(file_path: str) -> list:
    """Legge le righe di un file. Ritorna lista vuota se non esiste."""
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            return f.readlines()
    except (FileNotFoundError, OSError):
        return []


def files_are_identical(path_a: str, path_b: str) -> bool:
    """Confronta due file byte per byte."""
    try:
        with open(path_a, "rb") as fa, open(path_b, "rb") as fb:
            while True:
                chunk_a = fa.read(8192)
                chunk_b = fb.read(8192)
                if chunk_a != chunk_b:
                    return False
                if not chunk_a:
                    return True
    except (FileNotFoundError, OSError):
        return False


# ---------------------------------------------------------------------------
# Output JSON
# ---------------------------------------------------------------------------

def output_json(data: dict) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False))


# ---------------------------------------------------------------------------
# Comandi
# ---------------------------------------------------------------------------

def cmd_list(config: dict) -> None:
    """Elenca i file nella release queue con metadati."""
    queue_data = load_release_queue()

    items = []
    for entry in queue_data.get("queue", []):
        locked_at = entry.get("locked_at", "")
        items.append({
            "file": entry["file"],
            "local_path": entry.get("local_path", ""),
            "github_desktop_path": entry.get("github_desktop_path", ""),
            "modified_at": locked_at,
            "days_ago": days_ago(locked_at),
            "released": entry.get("released", False),
            "released_at": entry.get("released_at", None),
        })

    output_json({"success": True, "queue": items})


def cmd_preview(files: list, config: dict) -> None:
    """Confronta file locali con quelli in GitHub Desktop e genera diff."""
    local_root = config["local_root"]
    github_root = config["github_desktop_root"]

    previews = []

    for file_rel in files:
        local_path = os.path.join(local_root, file_rel).replace("\\", "/")
        github_path = os.path.join(github_root, file_rel).replace("\\", "/")

        local_exists = os.path.exists(local_path)
        github_exists = os.path.exists(github_path)

        if not local_exists:
            previews.append({
                "file": file_rel,
                "status": "error",
                "error": "File non trovato in Puma_backend",
                "diff": None,
                "local_lines": 0,
                "github_lines": count_lines(github_path),
            })
            continue

        if not github_exists:
            # File nuovo — non esiste ancora su GitHub Desktop
            previews.append({
                "file": file_rel,
                "status": "new",
                "diff": None,
                "local_lines": count_lines(local_path),
                "github_lines": 0,
            })
            continue

        if files_are_identical(local_path, github_path):
            previews.append({
                "file": file_rel,
                "status": "identical",
                "diff": None,
                "local_lines": count_lines(local_path),
                "github_lines": count_lines(github_path),
            })
            continue

        # File diversi — genera diff
        local_lines = read_file_lines(local_path)
        github_lines = read_file_lines(github_path)

        diff = difflib.unified_diff(
            github_lines,
            local_lines,
            fromfile=f"github_desktop/{file_rel}",
            tofile=f"local/{file_rel}",
            lineterm="",
        )
        diff_text = "\n".join(diff)

        previews.append({
            "file": file_rel,
            "status": "conflict",
            "diff": diff_text,
            "local_lines": len(local_lines),
            "github_lines": len(github_lines),
        })

    output_json({"success": True, "previews": previews})


def cmd_release(files: list, config: dict) -> None:
    """Copia i file selezionati da Puma_backend a GitHub Desktop."""
    local_root = config["local_root"]
    github_root = config["github_desktop_root"]

    copied = []
    errors = []

    for file_rel in files:
        local_path = os.path.join(local_root, file_rel)
        github_path = os.path.join(github_root, file_rel)

        try:
            if not os.path.exists(local_path):
                errors.append({
                    "file": file_rel,
                    "error": "File non trovato in Puma_backend",
                })
                continue

            # Crea directory intermedie se necessario
            os.makedirs(os.path.dirname(github_path), exist_ok=True)

            # Copia il file
            shutil.copy2(local_path, github_path)
            copied.append(file_rel)
            log(f"File copiato: {file_rel}")

        except Exception as e:
            errors.append({
                "file": file_rel,
                "error": str(e),
            })
            log(f"Errore copia {file_rel}: {e}")

    # Aggiorna la release queue
    if copied:
        mark_copied_in_queue(copied)

    output_json({
        "success": len(errors) == 0,
        "copied": copied,
        "errors": errors,
    })


# ---------------------------------------------------------------------------
# Release Queue update
# ---------------------------------------------------------------------------

def mark_copied_in_queue(copied_files: list) -> None:
    """Segna i file come copiati nella release queue."""
    try:
        queue_data = load_release_queue()
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        for entry in queue_data.get("queue", []):
            if entry["file"] in copied_files:
                entry["released"] = True
                entry["released_at"] = timestamp
                entry["copied_to_github"] = True
                entry["copied_at"] = timestamp

        save_release_queue(queue_data)

    except Exception as e:
        log(f"Errore aggiornamento release queue: {e}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="VibeSync Release — Rilascio file su GitHub Desktop")

    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--list", action="store_true", help="Elenca i file nella coda di rilascio")
    group.add_argument("--preview", nargs="+", metavar="FILE", help="Anteprima conflitti per i file specificati")
    group.add_argument("--release", nargs="+", metavar="FILE", help="Copia i file su GitHub Desktop")

    args = parser.parse_args()

    try:
        config = load_config()
    except FileNotFoundError:
        output_json({"success": False, "error": f"Config non trovato: {CONFIG_PATH}"})
        sys.exit(1)
    except json.JSONDecodeError as e:
        output_json({"success": False, "error": f"Errore parsing config: {e}"})
        sys.exit(1)

    if args.list:
        cmd_list(config)
    elif args.preview:
        cmd_preview(args.preview, config)
    elif args.release:
        cmd_release(args.release, config)


if __name__ == "__main__":
    main()
