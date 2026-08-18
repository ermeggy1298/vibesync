/**
 * VibeSync Chat — persistenza cronologia locale
 *
 * File: ~/.vibesync/chat_history.json
 * Schema: { messages: ChatHistoryEntry[], updated_at: string }
 *
 * Politiche:
 *  - append idempotente per `id` (evita doppioni quando il polling ripassa
 *    sullo stesso update_id)
 *  - cap MAX_MESSAGES: quando superato, i piu' vecchi vengono spostati in
 *    archive mensile (chat_history.archive.YYYY-MM.json)
 *  - flag `read` per il badge "non letti"
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ChatMessage } from './chatTelegram';

const HISTORY_PATH = path.join(os.homedir(), '.vibesync', 'chat_history.json');
const ARCHIVE_DIR = path.join(os.homedir(), '.vibesync');
const MAX_MESSAGES = 5000;
const ARCHIVE_BATCH = 1000;   // quando triggera l'archive, ne sposta 1000

export interface ChatHistoryEntry extends ChatMessage {
    read: boolean;
}

interface HistoryFile {
    messages: ChatHistoryEntry[];
    updated_at: string;
}

function emptyHistory(): HistoryFile {
    return { messages: [], updated_at: new Date().toISOString() };
}

function loadFile(): HistoryFile {
    try {
        const raw = fs.readFileSync(HISTORY_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.messages)) { return emptyHistory(); }
        return parsed;
    } catch {
        return emptyHistory();
    }
}

function saveFile(h: HistoryFile): void {
    try {
        fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
        h.updated_at = new Date().toISOString();
        fs.writeFileSync(HISTORY_PATH, JSON.stringify(h, null, 2), 'utf-8');
    } catch { /* silent */ }
}

/**
 * Aggiungi un messaggio se non esiste gia' (dedup per id). Se aggiunto,
 * ritorna true (utile al chiamante per decidere se emettere toast). read
 * viene inizializzato a false: sara' markAllRead() a resettarlo.
 */
export function appendIfNew(msg: ChatMessage): boolean {
    const h = loadFile();
    if (h.messages.some(m => m.id === msg.id)) { return false; }
    h.messages.push({ ...msg, read: false });

    if (h.messages.length > MAX_MESSAGES) {
        archiveOldest(h);
    }

    saveFile(h);
    return true;
}

/**
 * Sposta i piu' vecchi ARCHIVE_BATCH messaggi in un file archive mensile.
 * Se il file archive esiste gia', appende (per non perdere batch precedenti
 * dello stesso mese).
 */
function archiveOldest(h: HistoryFile): void {
    const toArchive = h.messages.splice(0, ARCHIVE_BATCH);
    if (toArchive.length === 0) { return; }
    try {
        const oldestTs = toArchive[0].ts || new Date().toISOString();
        const ym = oldestTs.slice(0, 7); // YYYY-MM
        const archivePath = path.join(ARCHIVE_DIR, `chat_history.archive.${ym}.json`);
        let existing: ChatHistoryEntry[] = [];
        if (fs.existsSync(archivePath)) {
            try {
                const raw = fs.readFileSync(archivePath, 'utf-8');
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed.messages)) { existing = parsed.messages; }
            } catch { /* file corrotto: sovrascriviamo */ }
        }
        fs.writeFileSync(archivePath, JSON.stringify({
            messages: [...existing, ...toArchive],
            archived_at: new Date().toISOString(),
        }, null, 2), 'utf-8');
    } catch { /* silent: se archive fallisce, i messaggi restano nel main */ }
}

/** Ritorna gli ultimi N messaggi (o tutti se limit non specificato). */
export function load(limit?: number): ChatHistoryEntry[] {
    const h = loadFile();
    if (!limit || limit >= h.messages.length) { return h.messages; }
    return h.messages.slice(-limit);
}

/** Conteggio messaggi non letti (per badge sidebar). */
export function getUnreadCount(): number {
    const h = loadFile();
    return h.messages.filter(m => !m.read).length;
}

/** Marca tutti i messaggi come letti (quando l'utente apre il pannello). */
export function markAllRead(): void {
    const h = loadFile();
    let changed = false;
    for (const m of h.messages) {
        if (!m.read) { m.read = true; changed = true; }
    }
    if (changed) { saveFile(h); }
}

/** Ripulisce tutta la cronologia (per il comando "Clear chat" opzionale). */
export function clearAll(): void {
    saveFile(emptyHistory());
}
