"""
VibeSync Sync — Utility di sincronizzazione iniziale
Confronta local_root con github_desktop_root e propone le copie mancanti.

Uso:
    python vibesync_sync.py              # mostra riepilogo + chiede conferma
    python vibesync_sync.py --dry-run    # solo riepilogo, senza copiare
    python vibesync_sync.py --auto       # copia tutto senza chiedere

Parte di VibeSync by AReS-BI
"""

import os
import sys
import json
import shutil
import filecmp
import argparse
from datetime import datetime, timezone
from pathlib import Path


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".vibesync", "config.json")

DEFAULT_EXCLUDED_DIRS = {
    "__pycache__", "node_modules", ".git", ".next", "dist", "build",
    ".venv", "venv", "env", ".env", ".tox", ".pytest_cache", ".mypy_cache",
}

EXCLUDED_EXTENSIONS = {
    ".pyc", ".pyo", ".log", ".tmp", ".cache", ".map",
    ".sqlite3", ".db", ".swp", ".swo",
}


def load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def get_exclusions(config: dict) -> tuple:
    """Ritorna (simple_set, path_prefixes, excluded_files_set) dal config."""
    custom = config.get("excluded_dirs", [])
    simple = set(DEFAULT_EXCLUDED_DIRS)
    prefixes = []
    for d in custom:
        dl = d.lower().replace("\\", "/")
        if "/" in dl:
            prefixes.append(dl.rstrip("/") + "/")
        else:
            simple.add(dl)

    excluded_files = {f.lower().replace("\\", "/") for f in config.get("excluded_files", [])}
    return simple, prefixes, excluded_files


# ---------------------------------------------------------------------------
# Scansione
# ---------------------------------------------------------------------------

def should_include(rel_path: str, excluded_dirs: set) -> bool:
    """Controlla se il file deve essere incluso nel sync."""
    parts = rel_path.replace("\\", "/").split("/")

    # Controlla directory escluse
    for part in parts:
        if part.lower() in excluded_dirs:
            return False

    # Controlla estensioni escluse
    _, ext = os.path.splitext(rel_path)
    if ext.lower() in EXCLUDED_EXTENSIONS:
        return False

    return True


def scan_differences(config: dict) -> tuple:
    """
    Scansiona le differenze tra local_root e github_desktop_root.
    Ritorna (new_files, modified_files, identical_count, skipped_count).
    """
    local_root = config["local_root"]
    github_root = config["github_desktop_root"]
    simple_excluded, path_prefixes, excluded_files = get_exclusions(config)

    new_files = []
    modified_files = []
    identical_count = 0
    skipped_count = 0

    for dirpath, dirnames, filenames in os.walk(local_root):
        # Calcola path relativo
        rel_dir = os.path.relpath(dirpath, local_root).replace("\\", "/")
        if rel_dir == ".":
            rel_dir = ""

        # Escludi directory singole
        dirnames[:] = [
            d for d in dirnames
            if d.lower() not in simple_excluded
        ]

        # Escludi path prefixes (es. DbPuma/assets)
        if rel_dir:
            rel_dir_lower = rel_dir.lower() + "/"
            skip_dir = any(rel_dir_lower.startswith(p) for p in path_prefixes)
            if skip_dir:
                dirnames.clear()
                continue

        for filename in filenames:
            if rel_dir:
                rel_path = f"{rel_dir}/{filename}"
            else:
                rel_path = filename

            # Filtro estensioni
            _, ext = os.path.splitext(filename)
            if ext.lower() in EXCLUDED_EXTENSIONS:
                skipped_count += 1
                continue

            # Filtro file esclusi singolarmente
            if rel_path.lower().replace("\\", "/") in excluded_files:
                skipped_count += 1
                continue

            local_file = os.path.join(local_root, rel_path)
            github_file = os.path.join(github_root, rel_path)

            # Salta file non regolari
            if not os.path.isfile(local_file):
                continue

            if not os.path.exists(github_file):
                # File nuovo
                size = os.path.getsize(local_file)
                new_files.append((rel_path, size))
            elif not filecmp.cmp(local_file, github_file, shallow=False):
                # File modificato
                local_size = os.path.getsize(local_file)
                github_size = os.path.getsize(github_file)
                modified_files.append((rel_path, local_size, github_size))
            else:
                identical_count += 1

    return new_files, modified_files, identical_count, skipped_count


# ---------------------------------------------------------------------------
# Display
# ---------------------------------------------------------------------------

def format_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    else:
        return f"{size_bytes / (1024 * 1024):.1f} MB"


def print_summary(new_files: list, modified_files: list,
                  identical_count: int, skipped_count: int,
                  config: dict) -> None:
    print("=" * 70)
    print("  VibeSync Sync — Riepilogo Sincronizzazione")
    print("=" * 70)
    print(f"  Sorgente:      {config['local_root']}")
    print(f"  Destinazione:  {config['github_desktop_root']}")
    simple, prefixes, ex_files = get_exclusions(config)
    all_excl = sorted(simple) + [p.rstrip('/') for p in sorted(prefixes)]
    print(f"  Esclusioni dir: {', '.join(all_excl)}")
    if ex_files:
        print(f"  Esclusioni file: {len(ex_files)} file")
    print("-" * 70)
    print(f"  File identici (gia' sincronizzati): {identical_count}")
    print(f"  File esclusi (estensione):          {skipped_count}")
    print(f"  File NUOVI (da copiare):            {len(new_files)}")
    print(f"  File MODIFICATI (da aggiornare):    {len(modified_files)}")
    print("-" * 70)

    if new_files:
        print(f"\n  --- FILE NUOVI ({len(new_files)}) ---")
        # Raggruppa per directory
        dirs = {}
        for rel_path, size in new_files:
            d = os.path.dirname(rel_path).replace("\\", "/") or "(root)"
            if d not in dirs:
                dirs[d] = []
            dirs[d].append((os.path.basename(rel_path), size))

        for d in sorted(dirs.keys()):
            print(f"\n  [{d}]")
            for fname, size in sorted(dirs[d]):
                print(f"    + {fname}  ({format_size(size)})")

    if modified_files:
        print(f"\n  --- FILE MODIFICATI ({len(modified_files)}) ---")
        dirs = {}
        for rel_path, local_size, github_size in modified_files:
            d = os.path.dirname(rel_path).replace("\\", "/") or "(root)"
            if d not in dirs:
                dirs[d] = []
            dirs[d].append((os.path.basename(rel_path), local_size, github_size))

        for d in sorted(dirs.keys()):
            print(f"\n  [{d}]")
            for fname, ls, gs in sorted(dirs[d]):
                diff = ls - gs
                arrow = "+" if diff >= 0 else ""
                print(f"    ~ {fname}  ({format_size(gs)} -> {format_size(ls)}, {arrow}{diff} bytes)")

    total = len(new_files) + len(modified_files)
    total_size = sum(s for _, s in new_files) + sum(ls for _, ls, _ in modified_files)
    print(f"\n{'=' * 70}")
    print(f"  TOTALE: {total} file da copiare ({format_size(total_size)})")
    print(f"{'=' * 70}")


# ---------------------------------------------------------------------------
# Copia
# ---------------------------------------------------------------------------

def copy_files(new_files: list, modified_files: list, config: dict) -> tuple:
    """Copia i file. Ritorna (copied_count, error_count, errors)."""
    local_root = config["local_root"]
    github_root = config["github_desktop_root"]

    copied = 0
    errors = []

    all_files = [rel for rel, _ in new_files] + [rel for rel, _, _ in modified_files]

    for i, rel_path in enumerate(all_files, 1):
        local_file = os.path.join(local_root, rel_path)
        github_file = os.path.join(github_root, rel_path)

        try:
            os.makedirs(os.path.dirname(github_file), exist_ok=True)
            shutil.copy2(local_file, github_file)
            copied += 1
            # Progress ogni 50 file
            if copied % 50 == 0:
                print(f"  ... copiati {copied}/{len(all_files)} file")
        except Exception as e:
            errors.append((rel_path, str(e)))

    return copied, len(errors), errors


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def cmd_scan(config: dict) -> None:
    """Scansiona e output JSON per VS Code extension."""
    new_files, modified_files, identical_count, skipped_count = scan_differences(config)

    new_items = []
    for rel_path, size in new_files:
        directory = os.path.dirname(rel_path).replace("\\", "/") or "(root)"
        new_items.append({
            "file": rel_path,
            "directory": directory,
            "filename": os.path.basename(rel_path),
            "size": size,
        })

    mod_items = []
    for rel_path, local_size, github_size in modified_files:
        directory = os.path.dirname(rel_path).replace("\\", "/") or "(root)"
        mod_items.append({
            "file": rel_path,
            "directory": directory,
            "filename": os.path.basename(rel_path),
            "local_size": local_size,
            "github_size": github_size,
            "diff_bytes": local_size - github_size,
        })

    result = {
        "success": True,
        "identical_count": identical_count,
        "skipped_count": skipped_count,
        "new_files": new_items,
        "modified_files": mod_items,
    }
    print(json.dumps(result, ensure_ascii=False))


def cmd_copy_files(files: list, config: dict) -> None:
    """Copia una lista specifica di file. Output JSON."""
    local_root = config["local_root"]
    github_root = config["github_desktop_root"]

    copied = []
    errors = []

    for rel_path in files:
        local_file = os.path.join(local_root, rel_path)
        github_file = os.path.join(github_root, rel_path)
        try:
            if not os.path.exists(local_file):
                errors.append({"file": rel_path, "error": "File non trovato"})
                continue
            os.makedirs(os.path.dirname(github_file), exist_ok=True)
            shutil.copy2(local_file, github_file)
            copied.append(rel_path)
        except Exception as e:
            errors.append({"file": rel_path, "error": str(e)})

    print(json.dumps({"success": len(errors) == 0, "copied": copied, "errors": errors}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description="VibeSync Sync — Sincronizzazione iniziale")
    parser.add_argument("--dry-run", action="store_true", help="Solo riepilogo, senza copiare")
    parser.add_argument("--auto", action="store_true", help="Copia tutto senza chiedere conferma")
    parser.add_argument("--scan", action="store_true", help="Scansiona e output JSON (per VS Code)")
    parser.add_argument("--copy-files", nargs="+", metavar="FILE", help="Copia file specifici (output JSON)")
    args = parser.parse_args()

    try:
        config = load_config()
    except FileNotFoundError:
        if args.scan or args.copy_files:
            print(json.dumps({"success": False, "error": f"Config non trovato: {CONFIG_PATH}"}))
        else:
            print(f"Errore: config non trovato in {CONFIG_PATH}")
        sys.exit(1)

    # Modalita' JSON per VS Code
    if args.scan:
        cmd_scan(config)
        return

    if args.copy_files:
        cmd_copy_files(args.copy_files, config)
        return

    print("\nScansione in corso...\n")
    new_files, modified_files, identical_count, skipped_count = scan_differences(config)

    print_summary(new_files, modified_files, identical_count, skipped_count, config)

    total = len(new_files) + len(modified_files)
    if total == 0:
        print("\nTutto sincronizzato, nulla da fare.")
        return

    if args.dry_run:
        print("\n[DRY RUN] Nessun file copiato.")
        return

    if not args.auto:
        print()
        answer = input("Vuoi procedere con la copia? (s/n): ").strip().lower()
        if answer not in ("s", "si", "sì", "y", "yes"):
            print("Operazione annullata.")
            return

    print(f"\nCopia in corso...")
    copied, error_count, errors = copy_files(new_files, modified_files, config)

    print(f"\nCompletato: {copied} file copiati, {error_count} errori.")

    if errors:
        print("\nErrori:")
        for rel_path, err in errors:
            print(f"  {rel_path}: {err}")

    print(f"\nOra puoi aprire GitHub Desktop e fare commit + push su branch '{config['github_branch']}'.")


if __name__ == "__main__":
    main()
