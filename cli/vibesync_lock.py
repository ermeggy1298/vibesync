"""
VibeSync Lock — Script lock/unlock per sviluppo manuale
Chiamato dall'estensione VS Code per gestire i lock quando si sviluppa senza Claude Code.

Uso:
    python vibesync_lock.py --check <file_relativo>
    python vibesync_lock.py --lock <file_relativo>
    python vibesync_lock.py --unlock <file_relativo>
    python vibesync_lock.py --unlock-all

Output: JSON su stdout

Parte di VibeSync by AReS-BI
"""

import sys
import json
import os
import base64
import time
import argparse
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError


# ---------------------------------------------------------------------------
# Costanti
# ---------------------------------------------------------------------------

CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".vibesync", "config.json")
RELEASE_QUEUE_PATH = os.path.join(os.path.expanduser("~"), ".vibesync", "RELEASE_QUEUE.json")
HISTORY_LOG_PATH = os.path.join(os.path.expanduser("~"), ".vibesync", "LOCK_HISTORY.log")
LOG_PATH = os.path.join(os.path.expanduser("~"), ".vibesync", "vibesync.log")

API_TIMEOUT = 10
HISTORY_MAX_SIZE = 10 * 1024 * 1024


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def log(message: str) -> None:
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{timestamp}] [lock] {message}\n")
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
        "User-Agent": "VibeSync-Lock/1.0",
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


def put_locks_json(config: dict, locks_data: dict, sha: str, action_desc: str) -> bool:
    repo = config["github_repo"]
    branch = config.get("github_lock_branch", config["github_branch"])
    token = config["github_token"]

    url = f"https://api.github.com/repos/{repo}/contents/LOCKS.json"

    content_str = json.dumps(locks_data, indent=2, ensure_ascii=False)
    content_b64 = base64.b64encode(content_str.encode("utf-8")).decode("utf-8")

    data = {
        "message": f"[VibeSync] {action_desc} by {config['developer_name']}",
        "content": content_b64,
        "sha": sha,
        "branch": branch,
    }

    github_api_request(url, token, method="PUT", data=data)
    return True


def put_with_retry(config: dict, locks_data: dict, sha: str, action_desc: str,
                   session_id: str, filter_fn=None) -> tuple:
    """
    PUT con retry backoff. filter_fn e' una funzione che riceve locks_data freschi
    e ritorna locks_data filtrati (usata al retry per ri-applicare la modifica).
    Ritorna (success: bool, locks_data_finale, sha_finale).
    """
    backoff_delays = [1, 2, 4]

    for attempt in range(len(backoff_delays) + 1):
        try:
            put_locks_json(config, locks_data, sha, action_desc)
            return True, locks_data, sha
        except HTTPError as e:
            if e.code == 409 and attempt < len(backoff_delays):
                delay = backoff_delays[attempt]
                log(f"Conflitto 409, retry {attempt + 1}/3 tra {delay}s")
                time.sleep(delay)
                try:
                    locks_data, sha = get_locks_json(config)
                    if filter_fn:
                        locks_data = filter_fn(locks_data)
                except Exception as e2:
                    log(f"Errore ri-scaricamento: {e2}")
                    return False, locks_data, sha
            else:
                log(f"Errore PUT: {e}")
                return False, locks_data, sha

    return False, locks_data, sha


# ---------------------------------------------------------------------------
# Output JSON
# ---------------------------------------------------------------------------

def output_json(data: dict) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False))


def output_error(message: str) -> None:
    output_json({"success": False, "error": message})


# ---------------------------------------------------------------------------
# Comandi
# ---------------------------------------------------------------------------

def cmd_check(file_rel: str, config: dict) -> None:
    """Controlla se un file e' lockato."""
    try:
        locks_data, _ = get_locks_json(config)
    except (HTTPError, URLError, Exception) as e:
        log(f"Errore check: {e}")
        output_error(f"GitHub non raggiungibile: {e}")
        return

    developer = config["developer_name"]

    for lock in locks_data.get("locks", []):
        if lock["file"] == file_rel:
            output_json({
                "success": True,
                "locked": True,
                "developer": lock["developer"],
                "timestamp": lock["timestamp"],
                "session_id": lock["session_id"],
                "source": lock["source"],
                "is_own_lock": lock["developer"] == developer,
            })
            return

    output_json({
        "success": True,
        "locked": False,
    })


def cmd_lock(file_rel: str, config: dict) -> None:
    """Acquisisce un lock manuale su un file."""
    developer = config["developer_name"]
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    session_id = f"manual_{developer}_{timestamp.replace(':', '').replace('-', '')}"

    try:
        locks_data, sha = get_locks_json(config)
    except (HTTPError, URLError, Exception) as e:
        log(f"Errore lock: {e}")
        output_error(f"GitHub non raggiungibile: {e}")
        return

    # Controlla se gia' lockato da un altro developer
    for lock in locks_data.get("locks", []):
        if lock["file"] == file_rel:
            if lock["developer"] != developer:
                output_json({
                    "success": False,
                    "error": "locked_by_other",
                    "developer": lock["developer"],
                    "timestamp": lock["timestamp"],
                    "source": lock["source"],
                })
                return
            else:
                # Gia' lockato da noi — riusa il lock esistente
                output_json({
                    "success": True,
                    "action": "already_locked",
                    "file": file_rel,
                    "developer": developer,
                })
                return

    # Aggiungi il lock
    new_lock = {
        "file": file_rel,
        "developer": developer,
        "timestamp": timestamp,
        "session_id": session_id,
        "source": "manual",
    }

    locks_data["locks"] = list(locks_data.get("locks", []))
    locks_data["locks"].append(new_lock)

    success, _, _ = put_with_retry(
        config, locks_data, sha,
        f"Manual lock {file_rel}",
        session_id,
        filter_fn=lambda fresh: {
            **fresh,
            "locks": [l for l in fresh.get("locks", []) if l["file"] != file_rel] + [new_lock]
        },
    )

    if success:
        log(f"Lock manuale acquisito: {file_rel} da {developer}")
        history_log("LOCK", file_rel, developer, session_id, "manual")

        # Aggiorna release queue
        update_release_queue(file_rel, config)

        output_json({
            "success": True,
            "action": "locked",
            "file": file_rel,
            "developer": developer,
            "session_id": session_id,
        })
    else:
        output_error("Impossibile acquisire il lock dopo 3 tentativi")


def cmd_unlock(file_rel: str, config: dict) -> None:
    """Rilascia un lock specifico."""
    developer = config["developer_name"]

    try:
        locks_data, sha = get_locks_json(config)
    except (HTTPError, URLError, Exception) as e:
        log(f"Errore unlock: {e}")
        output_error(f"GitHub non raggiungibile: {e}")
        return

    # Trova il lock da rimuovere
    lock_found = None
    for lock in locks_data.get("locks", []):
        if lock["file"] == file_rel and lock["developer"] == developer:
            lock_found = lock
            break

    if not lock_found:
        output_json({
            "success": True,
            "action": "no_lock_found",
            "file": file_rel,
        })
        return

    session_id = lock_found["session_id"]
    source = lock_found["source"]

    def filter_fn(fresh):
        fresh["locks"] = [
            l for l in fresh.get("locks", [])
            if not (l["file"] == file_rel and l["developer"] == developer)
        ]
        return fresh

    locks_data = filter_fn(locks_data)

    success, _, _ = put_with_retry(
        config, locks_data, sha,
        f"Unlock {file_rel}",
        session_id,
        filter_fn=filter_fn,
    )

    if success:
        log(f"Lock rilasciato: {file_rel} da {developer}")
        history_log("UNLOCK", file_rel, developer, session_id, source)
        output_json({
            "success": True,
            "action": "unlocked",
            "file": file_rel,
        })
    else:
        output_error("Impossibile rilasciare il lock dopo 3 tentativi")


def cmd_unlock_all(config: dict) -> None:
    """Rilascia tutti i lock manuali del developer corrente."""
    developer = config["developer_name"]

    try:
        locks_data, sha = get_locks_json(config)
    except (HTTPError, URLError, Exception) as e:
        log(f"Errore unlock-all: {e}")
        output_error(f"GitHub non raggiungibile: {e}")
        return

    locks_to_remove = [
        l for l in locks_data.get("locks", [])
        if l["developer"] == developer and l["source"] == "manual"
    ]

    if not locks_to_remove:
        output_json({
            "success": True,
            "action": "no_locks_found",
            "released": [],
        })
        return

    released_files = [l["file"] for l in locks_to_remove]

    def filter_fn(fresh):
        fresh["locks"] = [
            l for l in fresh.get("locks", [])
            if not (l["developer"] == developer and l["source"] == "manual")
        ]
        return fresh

    locks_data = filter_fn(locks_data)

    success, _, _ = put_with_retry(
        config, locks_data, sha,
        f"Unlock all manual locks",
        "manual_unlock_all",
        filter_fn=filter_fn,
    )

    if success:
        log(f"Tutti i lock manuali rilasciati: {', '.join(released_files)}")
        for f in released_files:
            lock_info = next((l for l in locks_to_remove if l["file"] == f), {})
            history_log("UNLOCK", f, developer, lock_info.get("session_id", "unknown"), "manual")
        output_json({
            "success": True,
            "action": "all_unlocked",
            "released": released_files,
        })
    else:
        output_error("Impossibile rilasciare i lock dopo 3 tentativi")


# ---------------------------------------------------------------------------
# Release Queue
# ---------------------------------------------------------------------------

def update_release_queue(rel_path: str, config: dict) -> None:
    try:
        os.makedirs(os.path.dirname(RELEASE_QUEUE_PATH), exist_ok=True)

        if os.path.exists(RELEASE_QUEUE_PATH):
            with open(RELEASE_QUEUE_PATH, "r", encoding="utf-8") as f:
                queue_data = json.load(f)
        else:
            queue_data = {"queue": []}

        local_path = os.path.join(config["local_root"], rel_path).replace("\\", "/")
        github_path = os.path.join(config["github_desktop_root"], rel_path).replace("\\", "/")

        for entry in queue_data["queue"]:
            if entry["file"] == rel_path and not entry.get("released", False):
                return

        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        queue_data["queue"].append({
            "file": rel_path,
            "local_path": local_path,
            "github_desktop_path": github_path,
            "locked_at": timestamp,
            "released": False,
        })

        with open(RELEASE_QUEUE_PATH, "w", encoding="utf-8") as f:
            json.dump(queue_data, f, indent=2, ensure_ascii=False)

    except Exception as e:
        log(f"Errore aggiornamento release queue: {e}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="VibeSync Lock — Gestione lock manuali")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--check", metavar="FILE", help="Controlla se un file e' lockato")
    group.add_argument("--lock", metavar="FILE", help="Acquisisce un lock su un file")
    group.add_argument("--unlock", metavar="FILE", help="Rilascia un lock su un file")
    group.add_argument("--unlock-all", action="store_true", help="Rilascia tutti i lock manuali")

    args = parser.parse_args()

    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            config = json.load(f)
    except FileNotFoundError:
        output_error(f"File config non trovato: {CONFIG_PATH}")
        sys.exit(1)
    except json.JSONDecodeError as e:
        output_error(f"Errore parsing config: {e}")
        sys.exit(1)

    if args.check:
        cmd_check(args.check, config)
    elif args.lock:
        cmd_lock(args.lock, config)
    elif args.unlock:
        cmd_unlock(args.unlock, config)
    elif args.unlock_all:
        cmd_unlock_all(config)


if __name__ == "__main__":
    main()
