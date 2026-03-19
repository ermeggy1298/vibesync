"""
VibeSync Guard — Hook PreToolUse per Claude Code
Intercetta ogni scrittura/modifica e gestisce il file locking su GitHub.

Parte di VibeSync by AReS-BI
"""

import sys
import json
import os
import base64
import subprocess
import time
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from pathlib import Path


# ---------------------------------------------------------------------------
# Costanti
# ---------------------------------------------------------------------------

CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".vibesync", "config.json")
RELEASE_QUEUE_PATH = os.path.join(os.path.expanduser("~"), ".vibesync", "RELEASE_QUEUE.json")
HISTORY_LOG_PATH = os.path.join(os.path.expanduser("~"), ".vibesync", "LOCK_HISTORY.log")
LOG_PATH = os.path.join(os.path.expanduser("~"), ".vibesync", "vibesync.log")

EXCLUDED_DIRS = {
    "__pycache__", "node_modules", ".git", ".next", "dist", "build",
    ".venv", "venv", "env", ".env", ".tox", ".pytest_cache", ".mypy_cache",
}


def get_excluded_dirs(config: dict) -> tuple:
    """
    Ritorna (simple_set, path_prefixes) dal config.
    simple_set: nomi singoli di cartella (es. 'node_modules')
    path_prefixes: percorsi relativi con '/' (es. 'dbpuma/assets')
    """
    custom = config.get("excluded_dirs", [])
    simple = set(EXCLUDED_DIRS)
    prefixes = []
    for d in custom:
        dl = d.lower().replace("\\", "/")
        if "/" in dl:
            prefixes.append(dl.rstrip("/") + "/")
        else:
            simple.add(dl)
    return simple, prefixes

EXCLUDED_EXTENSIONS = {
    ".pyc", ".pyo", ".log", ".tmp", ".cache", ".map",
    ".sqlite3", ".db", ".swp", ".swo",
}

API_TIMEOUT = 10   # secondi per chiamate GitHub API
GIT_TIMEOUT = 5    # secondi per git fetch
HISTORY_MAX_SIZE = 10 * 1024 * 1024  # 10 MB rotazione log


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def log(message: str) -> None:
    """Scrive un messaggio nel log file con timestamp."""
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{timestamp}] [guard] {message}\n")
    except Exception:
        pass  # il logging non deve mai bloccare l'esecuzione


def history_log(action: str, file_path: str, developer: str, session_id: str, source: str) -> None:
    """Scrive una entry nel history log con rotazione automatica."""
    try:
        os.makedirs(os.path.dirname(HISTORY_LOG_PATH), exist_ok=True)

        # Rotazione se supera 10MB
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
    """Esegue una richiesta alla GitHub API REST."""
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "VibeSync-Guard/1.0",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"

    body = json.dumps(data).encode("utf-8") if data else None
    req = Request(url, data=body, headers=headers, method=method)

    response = urlopen(req, timeout=API_TIMEOUT)
    return json.loads(response.read().decode("utf-8"))


def get_locks_json(config: dict) -> tuple:
    """Scarica LOCKS.json dal repo GitHub. Ritorna (contenuto_dict, sha_file)."""
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
    """Carica LOCKS.json aggiornato su GitHub. Ritorna True se successo."""
    repo = config["github_repo"]
    branch = config.get("github_lock_branch", config["github_branch"])
    token = config["github_token"]

    url = f"https://api.github.com/repos/{repo}/contents/LOCKS.json"

    content_str = json.dumps(locks_data, indent=2, ensure_ascii=False)
    content_b64 = base64.b64encode(content_str.encode("utf-8")).decode("utf-8")

    data = {
        "message": f"[VibeSync] Lock update by {config['developer_name']}",
        "content": content_b64,
        "sha": sha,
        "branch": branch,
    }

    github_api_request(url, token, method="PUT", data=data)
    return True


# ---------------------------------------------------------------------------
# STEP 1 — Lettura input
# ---------------------------------------------------------------------------

def read_input() -> dict:
    """Legge il JSON da stdin fornito da Claude Code."""
    raw = sys.stdin.read()
    return json.loads(raw)


# ---------------------------------------------------------------------------
# STEP 1b — Filtro file
# ---------------------------------------------------------------------------

def should_protect(file_path: str, local_root: str, config: dict = None) -> bool:
    """Determina se il file deve essere protetto da VibeSync."""
    # Normalizza i path per confronto consistente
    file_norm = os.path.normpath(file_path).replace("\\", "/").lower()
    root_norm = os.path.normpath(local_root).replace("\\", "/").lower()

    # Il file deve essere dentro local_root
    if not file_norm.startswith(root_norm):
        return False

    # Controlla directory escluse (default + config)
    rel_path = file_norm[len(root_norm):].lstrip("/")
    if config:
        simple, prefixes = get_excluded_dirs(config)
        # Controlla path prefixes (es. 'dbpuma/assets/')
        for prefix in prefixes:
            if rel_path.startswith(prefix):
                return False
        # Controlla nomi singoli
        parts = rel_path.split("/")
        for part in parts:
            if part in simple:
                return False
    else:
        parts = rel_path.split("/")
        for part in parts:
            if part in EXCLUDED_DIRS:
                return False

    # Controlla estensioni escluse
    _, ext = os.path.splitext(file_path)
    if ext.lower() in EXCLUDED_EXTENSIONS:
        return False

    return True


def get_relative_path(file_path: str, local_root: str) -> str:
    """Calcola il path relativo del file rispetto a local_root."""
    file_norm = os.path.normpath(file_path).replace("\\", "/")
    root_norm = os.path.normpath(local_root).replace("\\", "/")

    if file_norm.lower().startswith(root_norm.lower()):
        rel = file_norm[len(root_norm):].lstrip("/")
        return rel
    return file_norm


# ---------------------------------------------------------------------------
# STEP 2 — Configurazione
# ---------------------------------------------------------------------------

def load_config() -> dict:
    """Legge il file di configurazione personale."""
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# STEP 3 — Git fetch silenzioso
# ---------------------------------------------------------------------------

def git_fetch(github_desktop_root: str) -> bool:
    """Esegue git fetch origin. Ritorna True se successo."""
    try:
        subprocess.run(
            ["git", "fetch", "origin"],
            cwd=github_desktop_root,
            capture_output=True,
            timeout=GIT_TIMEOUT,
        )
        return True
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as e:
        log(f"Git fetch fallito: {e}")
        return False


# ---------------------------------------------------------------------------
# STEP 4 — Confronto versione locale vs GitHub
# ---------------------------------------------------------------------------

def check_remote_changes(rel_path: str, config: dict) -> str | None:
    """
    Confronta il file locale con origin/dev.
    Ritorna il messaggio di diff formattato se ci sono differenze, None altrimenti.
    """
    github_desktop_root = config["github_desktop_root"]
    branch = config["github_branch"]

    # Controlla se il file esiste nella directory GitHub Desktop
    github_file = os.path.join(github_desktop_root, rel_path)
    if not os.path.exists(github_file):
        return None

    try:
        result = subprocess.run(
            ["git", "diff", f"HEAD", f"origin/{branch}", "--", rel_path],
            cwd=github_desktop_root,
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT,
        )

        diff_output = result.stdout.strip()
        if not diff_output:
            return None

        # Parsa il diff per un messaggio leggibile
        lines_added = 0
        lines_removed = 0
        current_function = ""
        changes_by_function = {}

        for line in diff_output.split("\n"):
            # Cerca contesto funzione (es: @@ -10,3 +10,5 @@ def my_function)
            if line.startswith("@@"):
                parts = line.split("@@")
                if len(parts) >= 3:
                    func_hint = parts[2].strip()
                    if func_hint:
                        current_function = func_hint
                    else:
                        current_function = "(livello modulo)"
                if current_function not in changes_by_function:
                    changes_by_function[current_function] = {"added": 0, "removed": 0}
            elif line.startswith("+") and not line.startswith("+++"):
                lines_added += 1
                if current_function in changes_by_function:
                    changes_by_function[current_function]["added"] += 1
            elif line.startswith("-") and not line.startswith("---"):
                lines_removed += 1
                if current_function in changes_by_function:
                    changes_by_function[current_function]["removed"] += 1

        # Recupera autore ultimo commit via GitHub API
        author_info = ""
        try:
            repo = config["github_repo"]
            token = config["github_token"]
            url = f"https://api.github.com/repos/{repo}/commits?path={rel_path}&per_page=1&sha={branch}"
            commits = github_api_request(url, token)
            if commits:
                author = commits[0].get("commit", {}).get("author", {})
                author_name = author.get("name", "Sconosciuto")
                author_date = author.get("date", "")
                author_info = f"Ultimo commit di: {author_name} ({author_date})"
        except Exception:
            author_info = "Autore ultimo commit: non disponibile"

        # Componi messaggio
        msg_lines = [
            f"VERSIONE REMOTA PIU' RECENTE: {rel_path}",
            f"{author_info}",
            f"Totale: +{lines_added} righe aggiunte, -{lines_removed} righe rimosse",
            "",
        ]

        if changes_by_function:
            msg_lines.append("Modifiche per sezione:")
            for func, counts in changes_by_function.items():
                msg_lines.append(f"  {func}: +{counts['added']} -{counts['removed']}")

        msg_lines.extend([
            "",
            "Usa l'estensione VS Code VibeSync per scaricare la versione aggiornata",
            "oppure esegui manualmente: git checkout origin/dev -- " + rel_path,
        ])

        return "\n".join(msg_lines)

    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as e:
        log(f"Git diff fallito: {e}")
        return None


# ---------------------------------------------------------------------------
# STEP 5 — Controllo lock
# ---------------------------------------------------------------------------

def check_lock(locks_data: dict, rel_path: str, developer_name: str, session_id: str) -> dict | None:
    """
    Controlla se il file e' lockato.
    Ritorna None se non lockato o lockato dallo stesso developer/sessione.
    Ritorna un dict con info lock se lockato da un altro developer.
    """
    for lock in locks_data.get("locks", []):
        if lock["file"] == rel_path:
            if lock["developer"] != developer_name:
                return lock
            # Stesso developer: lascia passare
            return None
    return None


# ---------------------------------------------------------------------------
# STEP 6 — Acquisizione lock con retry backoff
# ---------------------------------------------------------------------------

def acquire_lock(config: dict, locks_data: dict, sha: str,
                 rel_path: str, session_id: str) -> bool:
    """Acquisisce il lock su LOCKS.json con retry backoff. Ritorna True se successo."""
    developer = config["developer_name"]
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    new_lock = {
        "file": rel_path,
        "developer": developer,
        "timestamp": timestamp,
        "session_id": session_id,
        "source": "claude_code",
    }

    backoff_delays = [1, 2, 4]  # secondi

    for attempt in range(len(backoff_delays) + 1):
        try:
            # Aggiungi il lock (su copia fresca dei dati)
            current_locks = locks_data.copy()
            current_locks["locks"] = list(current_locks.get("locks", []))

            # Rimuovi eventuali lock precedenti dello stesso developer sullo stesso file
            current_locks["locks"] = [
                l for l in current_locks["locks"]
                if not (l["file"] == rel_path and l["developer"] == developer)
            ]
            current_locks["locks"].append(new_lock)

            put_locks_json(config, current_locks, sha)
            log(f"Lock acquisito: {rel_path} da {developer} (sessione {session_id})")

            # Scrivi nel history log
            history_log("LOCK", rel_path, developer, session_id, "claude_code")

            return True

        except HTTPError as e:
            if e.code == 409 and attempt < len(backoff_delays):
                # Conflitto SHA — qualcuno ha modificato LOCKS.json
                delay = backoff_delays[attempt]
                log(f"Conflitto 409 su LOCKS.json, retry {attempt + 1}/3 tra {delay}s")
                time.sleep(delay)

                # Ri-scarica LOCKS.json per ottenere il nuovo SHA
                try:
                    locks_data, sha = get_locks_json(config)
                except Exception as e2:
                    log(f"Errore ri-scaricamento LOCKS.json: {e2}")
                    return False
            else:
                log(f"Errore PUT LOCKS.json (attempt {attempt + 1}): {e}")
                return False

    return False


# ---------------------------------------------------------------------------
# Release Queue
# ---------------------------------------------------------------------------

def update_release_queue(rel_path: str, config: dict) -> None:
    """Aggiunge il file alla coda di rilascio locale."""
    try:
        os.makedirs(os.path.dirname(RELEASE_QUEUE_PATH), exist_ok=True)

        # Leggi coda esistente o creane una nuova
        if os.path.exists(RELEASE_QUEUE_PATH):
            with open(RELEASE_QUEUE_PATH, "r", encoding="utf-8") as f:
                queue_data = json.load(f)
        else:
            queue_data = {"queue": []}

        local_path = os.path.join(config["local_root"], rel_path).replace("\\", "/")
        github_path = os.path.join(config["github_desktop_root"], rel_path).replace("\\", "/")

        # Controlla se il file e' gia' in coda (non rilasciato)
        for entry in queue_data["queue"]:
            if entry["file"] == rel_path and not entry.get("released", False):
                return  # gia' in coda, non duplicare

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
# Output per Claude Code
# ---------------------------------------------------------------------------

def deny(reason: str) -> None:
    """Blocca l'operazione di Claude Code con un messaggio deny su stdout."""
    output = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }
    print(json.dumps(output))
    sys.exit(0)


def block_with_message(message: str) -> None:
    """Blocca l'operazione con exit code 2 e messaggio su stderr."""
    sys.stderr.write(message + "\n")
    sys.exit(2)


def allow() -> None:
    """Permetti all'operazione di procedere."""
    sys.exit(0)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    try:
        # STEP 1 — Lettura input
        hook_input = read_input()
        tool_name = hook_input.get("tool_name", "")
        tool_input = hook_input.get("tool_input", {})
        session_id = hook_input.get("session_id", "unknown")
        file_path = tool_input.get("file_path", "")

        # Se non c'e' file_path, potrebbe essere un Bash command — lascia passare
        if not file_path:
            allow()

        log(f"Intercettato {tool_name} su {file_path}")

        # STEP 1b — Filtro: il file deve essere protetto?
        config = load_config()
        local_root = config["local_root"]

        if not should_protect(file_path, local_root, config):
            log(f"File ignorato (fuori scope o escluso): {file_path}")
            allow()

        rel_path = get_relative_path(file_path, local_root)
        log(f"File protetto: {rel_path}")

        # STEP 3 — Git fetch silenzioso
        fetch_ok = git_fetch(config["github_desktop_root"])

        # STEP 4 — Confronto versione locale vs GitHub
        if fetch_ok:
            diff_message = check_remote_changes(rel_path, config)
            if diff_message:
                log(f"File non aggiornato: {rel_path}")
                block_with_message(diff_message)

        # STEP 5 — Controllo lock
        try:
            locks_data, sha = get_locks_json(config)
        except HTTPError as e:
            if e.code == 404:
                log("LOCKS.json non trovato sul repo — lascio passare")
                allow()
            else:
                log(f"Errore scaricamento LOCKS.json: {e}")
                allow()  # fail-open
        except (URLError, Exception) as e:
            log(f"GitHub non raggiungibile: {e}")
            allow()  # fail-open: offline

        lock_info = check_lock(locks_data, rel_path, config["developer_name"], session_id)
        if lock_info:
            reason = (
                f"BLOCCATO: {rel_path} e' in uso da {lock_info['developer']} "
                f"dalle {lock_info['timestamp']} "
                f"(sessione {lock_info['session_id']}, source: {lock_info['source']})"
            )
            log(reason)
            deny(reason)

        # STEP 6 — Acquisizione lock
        success = acquire_lock(config, locks_data, sha, rel_path, session_id)
        if not success:
            log(f"Lock non acquisito per {rel_path} — lascio passare comunque")

        # Tutto ok, Claude puo' procedere
        allow()

    except json.JSONDecodeError as e:
        log(f"Errore parsing JSON input: {e}")
        allow()  # fail-open
    except FileNotFoundError as e:
        log(f"File config non trovato: {e}")
        allow()  # fail-open
    except Exception as e:
        log(f"Errore imprevisto: {e}")
        allow()  # fail-open: mai bloccare per errori interni


if __name__ == "__main__":
    main()
