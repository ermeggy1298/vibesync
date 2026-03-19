"""
VibeSync Search — Ricerca nelle chat passate di Claude Code
Cerca parole chiave nei messaggi utente e assistente delle conversazioni salvate.

Uso:
    python vibesync/vibesync_search.py "parola chiave"
    python vibesync/vibesync_search.py "parola chiave" --project Puma-backend
    python vibesync/vibesync_search.py "parola chiave" --max 20
    python vibesync/vibesync_search.py "parola chiave" --user-only
    python vibesync/vibesync_search.py "parola chiave" --assistant-only
    python vibesync/vibesync_search.py "parola chiave" --json
    python vibesync/vibesync_search.py --list-all --json

Output: risultati colorati su stdout, oppure JSON con --json

Parte di VibeSync by AReS-BI
"""

import sys
import json
import os
import re
import argparse
from datetime import datetime, timezone

# Forza UTF-8 su Windows per supportare i caratteri Unicode
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Costanti
# ---------------------------------------------------------------------------

CLAUDE_PROJECTS_DIR = os.path.join(os.path.expanduser("~"), ".claude", "projects")


# ---------------------------------------------------------------------------
# Colori terminale
# ---------------------------------------------------------------------------

class Colors:
    BLUE = "\033[94m"
    CYAN = "\033[96m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    RED = "\033[91m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    RESET = "\033[0m"

    @staticmethod
    def enabled():
        return hasattr(sys.stdout, "isatty") and sys.stdout.isatty()


def c(text, color):
    if Colors.enabled():
        return f"{color}{text}{Colors.RESET}"
    return text


# ---------------------------------------------------------------------------
# Estrazione testo
# ---------------------------------------------------------------------------

def extract_text_content(content):
    """Estrae il testo leggibile dal campo content di un messaggio."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                btype = block.get("type", "")
                if btype == "text":
                    parts.append(block.get("text", ""))
                elif btype == "tool_use":
                    tool_input = block.get("input", {})
                    if isinstance(tool_input, dict):
                        for v in tool_input.values():
                            if isinstance(v, str) and len(v) > 10:
                                parts.append(v)
                elif btype == "tool_result":
                    result_content = block.get("content", "")
                    if isinstance(result_content, str):
                        parts.append(result_content)
            elif isinstance(block, str):
                parts.append(block)
        return "\n".join(parts)
    return ""


# ---------------------------------------------------------------------------
# Ricerca in una conversazione
# ---------------------------------------------------------------------------

def search_conversation(jsonl_path, pattern, user_only=False, assistant_only=False):
    """Cerca un pattern in una conversazione JSONL. Ritorna lista di match."""
    matches = []
    session_slug = None
    session_id = None

    rel = os.path.relpath(jsonl_path, CLAUDE_PROJECTS_DIR)
    parts = rel.replace("\\", "/").split("/")
    project_name = parts[0] if parts else ""

    try:
        with open(jsonl_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                if not session_slug and entry.get("slug"):
                    session_slug = entry["slug"]
                if not session_id and entry.get("sessionId"):
                    session_id = entry["sessionId"]

                msg_type = entry.get("type")
                if msg_type not in ("user", "assistant"):
                    continue
                if user_only and msg_type != "user":
                    continue
                if assistant_only and msg_type != "assistant":
                    continue

                text = extract_text_content(entry.get("message", {}).get("content", ""))
                if not text or not pattern.search(text):
                    continue

                m = pattern.search(text)
                start = max(0, m.start() - 80)
                end = min(len(text), m.end() + 80)
                preview = text[start:end].replace("\n", " ").replace("\r", "")
                if start > 0:
                    preview = "..." + preview
                if end < len(text):
                    preview = preview + "..."

                matches.append({
                    "project": project_name,
                    "session_id": session_id,
                    "slug": session_slug,
                    "type": msg_type,
                    "timestamp": entry.get("timestamp", ""),
                    "preview": preview,
                    "file": str(jsonl_path),
                })
    except (OSError, PermissionError):
        pass

    return matches


# ---------------------------------------------------------------------------
# Lista tutte le conversazioni (per vista Progetti)
# ---------------------------------------------------------------------------

def list_all_conversations():
    """Lista tutte le conversazioni con metadati."""
    result = []
    if not os.path.isdir(CLAUDE_PROJECTS_DIR):
        return result

    for project_dir in os.listdir(CLAUDE_PROJECTS_DIR):
        project_path = os.path.join(CLAUDE_PROJECTS_DIR, project_dir)
        if not os.path.isdir(project_path):
            continue
        for fname in os.listdir(project_path):
            if not fname.endswith(".jsonl"):
                continue
            info = _extract_conversation_info(
                os.path.join(project_path, fname), project_dir
            )
            if info:
                result.append(info)

    result.sort(key=lambda x: x.get("last_timestamp", ""), reverse=True)
    return result


def _extract_conversation_info(jsonl_path, project_name):
    """Estrae metadati da una conversazione (slug, date, primo messaggio)."""
    session_id = None
    slug = None
    first_timestamp = None
    last_timestamp = None
    first_user_message = None
    message_count = 0

    try:
        with open(jsonl_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                if not slug and entry.get("slug"):
                    slug = entry["slug"]
                if not session_id and entry.get("sessionId"):
                    session_id = entry["sessionId"]

                msg_type = entry.get("type")
                if msg_type not in ("user", "assistant"):
                    continue

                ts = entry.get("timestamp", "")
                if ts:
                    if not first_timestamp:
                        first_timestamp = ts
                    last_timestamp = ts

                message_count += 1

                if msg_type == "user" and not first_user_message:
                    text = extract_text_content(entry.get("message", {}).get("content", ""))
                    if text:
                        first_user_message = text[:150].replace("\n", " ").strip()
                        if len(text) > 150:
                            first_user_message += "..."

    except (OSError, PermissionError):
        return None

    if not session_id:
        return None

    return {
        "session_id": session_id,
        "slug": slug or "senza-nome",
        "project": project_name,
        "first_timestamp": first_timestamp or "",
        "last_timestamp": last_timestamp or "",
        "message_count": message_count,
        "first_user_message": first_user_message or "",
        "file": str(jsonl_path),
    }


# ---------------------------------------------------------------------------
# Scoperta conversazioni
# ---------------------------------------------------------------------------

def find_conversations(project_filter=None):
    """Trova tutti i file .jsonl delle conversazioni (esclusi subagents)."""
    result = []
    if not os.path.isdir(CLAUDE_PROJECTS_DIR):
        return result

    for project_dir in os.listdir(CLAUDE_PROJECTS_DIR):
        project_path = os.path.join(CLAUDE_PROJECTS_DIR, project_dir)
        if not os.path.isdir(project_path):
            continue
        if project_filter and project_filter.lower() not in project_dir.lower():
            continue
        for fname in os.listdir(project_path):
            if fname.endswith(".jsonl"):
                result.append(os.path.join(project_path, fname))

    return result


# ---------------------------------------------------------------------------
# Output terminale
# ---------------------------------------------------------------------------

def highlight_match(text, pattern):
    if not Colors.enabled():
        return text
    return pattern.sub(
        lambda m: f"{Colors.RED}{Colors.BOLD}{m.group()}{Colors.RESET}", text
    )


def print_results(all_matches, keyword, pattern):
    if not all_matches:
        print(c(f"\n  Nessun risultato per \"{keyword}\"\n", Colors.YELLOW))
        return

    sessions = {}
    for m in all_matches:
        key = m["session_id"] or m["file"]
        if key not in sessions:
            sessions[key] = {"slug": m["slug"], "project": m["project"],
                             "session_id": m["session_id"], "matches": []}
        sessions[key]["matches"].append(m)

    print()
    print(c("  VibeSync Search", Colors.BOLD))
    print(c("  ─────────────────────────────────────────────", Colors.DIM))
    print(c(f"  {len(all_matches)} risultati in {len(sessions)} conversazioni per ", Colors.DIM) +
          c(f'"{keyword}"', Colors.GREEN + Colors.BOLD))
    print()

    for session in sessions.values():
        slug = session["slug"] or "senza-nome"
        sid = (session["session_id"] or "")[:8]
        print(c("  ┌─ ", Colors.BLUE) + c(slug, Colors.CYAN + Colors.BOLD) +
              c(f"  ({session['project']})", Colors.DIM) + c(f"  [{sid}]", Colors.DIM))

        for match in session["matches"]:
            ts = match["timestamp"]
            try:
                ts_display = datetime.fromisoformat(
                    ts.replace("Z", "+00:00")
                ).strftime("%Y-%m-%d %H:%M") if ts else "?"
            except ValueError:
                ts_display = ts[:16]

            role_color = Colors.GREEN if match["type"] == "user" else Colors.YELLOW
            role_label = "USER  " if match["type"] == "user" else "CLAUDE"
            preview = highlight_match(match["preview"], pattern)

            print(c("  │  ", Colors.BLUE) + c(f"[{ts_display}]", Colors.DIM) +
                  " " + c(role_label, role_color) + " " + preview)

        print(c("  └───", Colors.BLUE))
        print()

    print(c("  Tip: per riprendere una chat usa:", Colors.DIM))
    print(c("       claude --resume <slug-o-session-id>", Colors.CYAN))
    print()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="VibeSync Search — Cerca nelle chat passate di Claude Code"
    )
    parser.add_argument("keyword", nargs="?", help="Parola chiave o regex da cercare")
    parser.add_argument("--project", "-p", help="Filtra per nome progetto (sottostringa)")
    parser.add_argument("--max", "-m", type=int, default=50, help="Numero max risultati (default: 50)")
    parser.add_argument("--user-only", "-u", action="store_true")
    parser.add_argument("--assistant-only", "-a", action="store_true")
    parser.add_argument("--json", "-j", action="store_true", help="Output JSON")
    parser.add_argument("--regex", "-r", action="store_true", help="Keyword come regex")
    parser.add_argument("--list-all", "-l", action="store_true",
                        help="Lista tutte le chat con metadati (no ricerca)")

    args = parser.parse_args()

    # Modalità lista tutte le chat
    if args.list_all:
        conversations = list_all_conversations()
        if args.json:
            print(json.dumps(conversations, indent=2, ensure_ascii=False))
        else:
            print(c(f"\n  {len(conversations)} conversazioni trovate\n", Colors.BOLD))
            for conv in conversations:
                ts = conv.get("last_timestamp", "")[:10] or "?"
                print(c(f"  [{ts}] ", Colors.DIM) + c(conv["slug"], Colors.CYAN) +
                      c(f"  ({conv['project']})", Colors.DIM) +
                      c(f"  {conv['message_count']} msg", Colors.DIM))
                if conv.get("first_user_message"):
                    print(c(f"         {conv['first_user_message']}", Colors.DIM))
            print()
        return

    if not args.keyword:
        parser.error("keyword richiesta (oppure usa --list-all)")

    # Compila pattern
    if args.regex:
        try:
            pattern = re.compile(args.keyword, re.IGNORECASE)
        except re.error as e:
            print(f"Errore regex: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        pattern = re.compile(re.escape(args.keyword), re.IGNORECASE)

    conversations = find_conversations(project_filter=args.project)
    if not conversations:
        print("[]" if args.json else c(f"\n  Nessuna conversazione trovata\n", Colors.YELLOW))
        return

    if not args.json:
        print(c(f"\n  Ricerca in {len(conversations)} conversazioni...", Colors.DIM))

    all_matches = []
    for conv_path in conversations:
        all_matches.extend(search_conversation(
            conv_path, pattern,
            user_only=args.user_only,
            assistant_only=args.assistant_only,
        ))
        if len(all_matches) >= args.max:
            all_matches = all_matches[:args.max]
            break

    all_matches.sort(key=lambda x: x.get("timestamp", ""), reverse=True)

    if args.json:
        print(json.dumps(all_matches, indent=2, ensure_ascii=False))
    else:
        print_results(all_matches, args.keyword, pattern)


if __name__ == "__main__":
    main()
