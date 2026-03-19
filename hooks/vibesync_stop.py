"""
VibeSync Stop — Hook Stop per Claude Code
Rilascia tutti i lock acquisiti nella sessione corrente quando Claude finisce di rispondere.

Parte di VibeSync by AReS-BI
"""

import sys
import json
import os
import base64
import time
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError


# ---------------------------------------------------------------------------
# Costanti (stessi path di vibesync_guard.py)
# ---------------------------------------------------------------------------

CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".vibesync", "config.json")
RELEASE_QUEUE_PATH = os.path.join(os.path.expanduser("~"), ".vibesync", "RELEASE_QUEUE.json")
HISTORY_LOG_PATH = os.path.join(os.path.expanduser("~"), ".vibesync", "LOCK_HISTORY.log")
LOG_PATH = os.path.join(os.path.expanduser("~"), ".vibesync", "vibesync.log")

API_TIMEOUT = 10
HISTORY_MAX_SIZE = 10 * 1024 * 1024


# ---------------------------------------------------------------------------
# Logging (stessa logica di vibesync_guard.py)
# ---------------------------------------------------------------------------

def log(message: str) -> None:
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{timestamp}] [stop] {message}\n")
    except Exception:
        pass


def history_log(action: str, file_path: str, developer: str, session_id: str, source: str) -> None:
    try:
        os.makedirs(os.path.dirname(HISTORY_LOG_PATH), exist_ok=True)
        if os.path.exists(HISTORY_LOG_PATH) and os.path.getsize(HISTORY_LOG_PATH) > HISTORY_MAX_SIZE:
            backup_2 = HISTORY_LOG_PATH + ".2"
            backup_1 = HISTORY_LOG_PATH + ".1"
            if os.path.exists(backup_2):
                os.remove(backup_2)
            if os.path.exists(backup_1):
                os.rename(backup_1, backup_2)
            os.rename(HISTORY_LOG_PATH, backup_1)

        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        entry = f"[{timestamp}] {action:<6} {file_path:<50} {developer:<12} session:{session_id}  source:{source}\n"
        with open(HISTORY_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(entry)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# GitHub API
# ---------------------------------------------------------------------------

def github_api_request(url: str, token: str, method: str = "GET", data: dict = None) -> dict:
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "VibeSync-Stop/1.0",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"

    body = json.dumps(data).encode("utf-8") if data else None
    req = Request(url, data=body, headers=headers, method=method)

    response = urlopen(req, timeout=API_TIMEOUT)
    return json.loads(response.read().decode("utf-8"))


def get_locks_json(config: dict) -> tuple:
    repo = config["github_repo"]
    branch = config.get("github_lock_branch", config["github_branch"])
    token = config["github_token"]

    url = f"https://api.github.com/repos/{repo}/contents/LOCKS.json?ref={branch}"
    response = github_api_request(url, token)

    content_b64 = response["content"]
    sha = response["sha"]
    content_str = base64.b64decode(content_b64).decode("utf-8")
    locks_data = json.loads(content_str)

    return locks_data, sha


def put_locks_json(config: dict, locks_data: dict, sha: str) -> bool:
    repo = config["github_repo"]
    branch = config.get("github_lock_branch", config["github_branch"])
    token = config["github_token"]

    url = f"https://api.github.com/repos/{repo}/contents/LOCKS.json"

    content_str = json.dumps(locks_data, indent=2, ensure_ascii=False)
    content_b64 = base64.b64encode(content_str.encode("utf-8")).decode("utf-8")

    data = {
        "message": f"[VibeSync] Lock release by {config['developer_name']}",
        "content": content_b64,
        "sha": sha,
        "branch": branch,
    }

    github_api_request(url, token, method="PUT", data=data)
    return True


# ---------------------------------------------------------------------------
# Release Queue
# ---------------------------------------------------------------------------

def mark_released(released_files: list[str]) -> None:
    """Segna i file come released nella coda locale."""
    try:
        if not os.path.exists(RELEASE_QUEUE_PATH):
            return

        with open(RELEASE_QUEUE_PATH, "r", encoding="utf-8") as f:
            queue_data = json.load(f)

        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        for entry in queue_data.get("queue", []):
            if entry["file"] in released_files and not entry.get("released", False):
                entry["released"] = True
                entry["released_at"] = timestamp

        with open(RELEASE_QUEUE_PATH, "w", encoding="utf-8") as f:
            json.dump(queue_data, f, indent=2, ensure_ascii=False)

    except Exception as e:
        log(f"Errore aggiornamento release queue: {e}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    try:
        # STEP 1 — Leggi session_id
        raw = sys.stdin.read()
        hook_input = json.loads(raw)
        session_id = hook_input.get("session_id", "unknown")

        log(f"Stop sessione: {session_id}")

        # I lock NON vengono rilasciati automaticamente.
        # Restano attivi finche' l'utente non sincronizza i file su GitHub Desktop
        # tramite la Sync Dashboard dell'estensione VS Code.
        # Solo allora i lock vengono rilasciati.

        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            config = json.load(f)

        developer = config["developer_name"]

        # Log dei file che restano lockati
        try:
            locks_data, sha = get_locks_json(config)
            my_locks = [
                l["file"] for l in locks_data.get("locks", [])
                if l["developer"] == developer
            ]
            if my_locks:
                files_list = ", ".join(my_locks)
                sys.stderr.write(f"VibeSync: {len(my_locks)} file restano lockati fino al sync su GitHub Desktop: {files_list}\n")
                log(f"Sessione terminata. Lock attivi: {files_list}")
            else:
                log(f"Sessione terminata. Nessun lock attivo.")
        except Exception as e:
            log(f"Impossibile verificare lock attivi: {e}")

    except json.JSONDecodeError as e:
        log(f"Errore parsing JSON input: {e}")
    except FileNotFoundError as e:
        log(f"File config non trovato: {e}")
    except Exception as e:
        log(f"Errore imprevisto: {e}")

    # Esce SEMPRE con 0 — non deve mai bloccare Claude
    sys.exit(0)


if __name__ == "__main__":
    main()
