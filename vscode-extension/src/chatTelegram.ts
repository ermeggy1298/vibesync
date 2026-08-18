/**
 * VibeSync Chat — Telegram transport
 *
 * Consuma la config gia' esistente `notifications.telegram` in ~/.vibesync/config.json:
 *   - bot_token per parlare col bot
 *   - recipients per sapere chi sono i peer del canale
 *
 * Send:    POST /sendMessage con payload prefissato "VSC1|..." per riconoscere
 *          i messaggi VibeSync-formattati dagli altri (es. testo libero mandato
 *          al bot dall'app Telegram mobile).
 * Receive: long polling getUpdates con timeout=25 (istantaneo se c'e' traffico,
 *          ~2 req/min in idle). Cursore last_update_id persistito in
 *          ~/.vibesync/chat_state.json cosi' al restart di VS Code riprendi
 *          esattamente dove eri (nessun messaggio perso, nessun doppione).
 *
 * IMPORTANTE: questo modulo deve essere l'UNICO consumer di getUpdates in tutta
 * l'estensione. Ogni update viene consumato ("committato" via offset), quindi due
 * consumer paralleli si ruberebbero i messaggi a vicenda. Oggi notificationsTelegram.ts
 * fa solo send, mai getUpdates, quindi non c'e' collisione.
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as lockManager from './lockManager';

const PROTOCOL_PREFIX = 'VSC1|';
const STATE_PATH = path.join(os.homedir(), '.vibesync', 'chat_state.json');
const LONG_POLL_TIMEOUT_S = 25;   // Telegram tiene aperta la conn fino a 25s
const HTTP_TIMEOUT_MS = 30_000;   // deve essere > LONG_POLL_TIMEOUT_S*1000

// ---------------------------------------------------------------------------
// Tipi
// ---------------------------------------------------------------------------

/**
 * Un'ancora al codice: file relativo al workspace + range di righe.
 * end e' opzionale (se assente, e' un'ancora a riga singola).
 * Iter 2 aggiunge snippet + hash per il detect di "codice cambiato".
 */
export interface Anchor {
    file: string;                     // path relativo al workspace, es. "DbPuma/views.py"
    start: number;                    // 1-based
    end?: number;                     // 1-based inclusive; se assente == start
    snippet?: string;                 // porzione di codice al momento del send (contesto ±3 righe)
    hash?: string;                    // SHA-1 dello snippet: al click confrontiamo con l'attuale per detect di "codice cambiato"
}

export interface ChatMessage {
    id: string;                       // update_id di Telegram (o "local-<ts>" per l'echo del proprio send)
    from: string;                     // developer_name del mittente
    ts: string;                       // ISO 8601
    text: string;                     // testo puro (parsato dal payload VSC1|... oppure raw)
    is_vibesync: boolean;             // true se arrivato con prefisso VSC1|, false se testo libero (mobile app)
    raw_from_telegram?: string;       // nome/username Telegram (utile per debug quando is_vibesync=false)
    anchors?: Anchor[];               // Iter 1: ancore al codice (chip cliccabili nel panel)
    to?: string;                      // @mention "target soft" — se presente, e' il destinatario primario del messaggio
                                      //   (il messaggio arriva a TUTTO il canale — Telegram non permette vera privacy per bot condiviso —
                                      //   ma i non-destinatari lo vedono in grigio "sussurrato"; il destinatario riceve un toast prioritario)
}

export interface SendResult {
    ok: boolean;
    error?: string;
}

// ---------------------------------------------------------------------------
// State (last_update_id persistito)
// ---------------------------------------------------------------------------

function loadState(): { last_update_id: number } {
    try {
        const raw = fs.readFileSync(STATE_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        return { last_update_id: typeof parsed.last_update_id === 'number' ? parsed.last_update_id : 0 };
    } catch {
        return { last_update_id: 0 };
    }
}

function saveState(state: { last_update_id: number }): void {
    try {
        fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
    } catch { /* silent — chat continua a funzionare, al prossimo restart ricomincia da 0 */ }
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function tgPost(botToken: string, method: string, payload: object, timeoutMs = HTTP_TIMEOUT_MS): Promise<any> {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const options = {
            hostname: 'api.telegram.org',
            path: `/bot${botToken}/${method}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('http timeout')); });
        req.write(body);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Protocollo VSC1|
// ---------------------------------------------------------------------------

/**
 * Encoding delle ancore nel payload VSC1|.
 *
 * Due formati supportati:
 *  - Legacy (Iter 1): `file:start[-end],file:start` — leggibile anche a occhio su
 *    Telegram mobile, usato quando le ancore non hanno snippet/hash.
 *  - Iter 2: `b64:<base64-JSON>` — necessario quando c'e' snippet/hash, che
 *    contengono \n, virgole, pipe e altri caratteri che romperebbero il formato
 *    a separatore. Prefisso `b64:` per distinguere unambiguously.
 *
 * Retro-compat: `decodeAnchors` prova prima il prefisso b64:, poi il legacy.
 * Cosi' i messaggi vecchi (senza snippet) continuano a essere decodabili anche
 * dopo l'upgrade di entrambi i client.
 */
function encodeAnchors(anchors?: Anchor[]): string {
    if (!anchors || anchors.length === 0) { return ''; }
    const clean = anchors.filter(a => a && a.file && a.start > 0);
    if (clean.length === 0) { return ''; }
    const hasRich = clean.some(a => a.snippet || a.hash);
    if (!hasRich) {
        // Formato legacy, piu' compatto e leggibile
        const parts = clean.map(a =>
            a.end && a.end > a.start ? `${a.file}:${a.start}-${a.end}` : `${a.file}:${a.start}`,
        );
        return `|a=${parts.join(',')}`;
    }
    // Formato rich: JSON + base64. La chiave `s` per snippet e `h` per hash
    // per contenere il payload.
    const compact = clean.map(a => {
        const o: any = { f: a.file, s: a.start };
        if (a.end && a.end > a.start) { o.e = a.end; }
        if (a.snippet) { o.sn = a.snippet; }
        if (a.hash) { o.h = a.hash; }
        return o;
    });
    const b64 = Buffer.from(JSON.stringify(compact), 'utf-8').toString('base64');
    return `|a=b64:${b64}`;
}

function decodeAnchors(raw: string): Anchor[] {
    if (!raw) { return []; }
    // Formato Iter 2 (b64+JSON)
    if (raw.startsWith('b64:')) {
        try {
            const json = Buffer.from(raw.slice(4), 'base64').toString('utf-8');
            const arr = JSON.parse(json);
            if (!Array.isArray(arr)) { return []; }
            return arr
                .map((o: any) => {
                    if (!o || !o.f || !o.s || o.s < 1) { return null; }
                    const a: Anchor = { file: String(o.f), start: Number(o.s) };
                    if (typeof o.e === 'number' && o.e > a.start) { a.end = o.e; }
                    if (typeof o.sn === 'string') { a.snippet = o.sn; }
                    if (typeof o.h === 'string') { a.hash = o.h; }
                    return a;
                })
                .filter((a): a is Anchor => a !== null);
        } catch { return []; }
    }
    // Formato legacy (Iter 1): file:start[-end],file:start
    const out: Anchor[] = [];
    for (const item of raw.split(',')) {
        const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(item.trim());
        if (!m) { continue; }
        const [, file, sStr, eStr] = m;
        const start = parseInt(sStr, 10);
        const end = eStr ? parseInt(eStr, 10) : undefined;
        if (start > 0) { out.push({ file, start, end }); }
    }
    return out;
}

/**
 * Calcola l'hash SHA-1 di uno snippet (usato per detect di "codice cambiato").
 * Normalizza line ending a LF prima dell'hash per stabilita' cross-platform.
 */
export function hashSnippet(snippet: string): string {
    const normalized = snippet.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return require('crypto').createHash('sha1').update(normalized, 'utf-8').digest('hex');
}

function encodeVsc1(from: string, ts: string, text: string, anchors?: Anchor[], to?: string): string {
    // Formato: VSC1|v=1|from=<name>|ts=<iso>[|to=<name>][|a=<...>]|t=<text>
    // Il campo `t` va SEMPRE per ultimo perche' il testo puo' contenere pipe.
    // Escape dei pipe negli altri campi (from/ts/to non dovrebbero mai averne, ma safety).
    const esc = (s: string) => s.replace(/\|/g, '/').replace(/\n/g, ' ');
    const toPart = to ? `|to=${esc(to)}` : '';
    return `${PROTOCOL_PREFIX}v=1|from=${esc(from)}|ts=${ts}${toPart}${encodeAnchors(anchors)}|t=${text}`;
}

interface Vsc1Parsed { from: string; ts: string; text: string; anchors: Anchor[]; to?: string; }

function decodeVsc1(raw: string): Vsc1Parsed | null {
    if (!raw.startsWith(PROTOCOL_PREFIX)) { return null; }
    const rest = raw.slice(PROTOCOL_PREFIX.length);
    // Cerca "t=" e prendi tutto quello che viene dopo come testo (puo' contenere pipe).
    const tIdx = rest.indexOf('|t=');
    if (tIdx < 0) { return null; }
    const head = rest.slice(0, tIdx);
    const text = rest.slice(tIdx + 3);   // salta "|t="
    let from = '', ts = '', anchorsRaw = '', to: string | undefined;
    for (const kv of head.split('|')) {
        const eq = kv.indexOf('=');
        if (eq < 0) { continue; }
        const k = kv.slice(0, eq);
        const v = kv.slice(eq + 1);
        if (k === 'from') { from = v; }
        else if (k === 'ts') { ts = v; }
        else if (k === 'a') { anchorsRaw = v; }
        else if (k === 'to') { to = v; }
    }
    if (!from || !ts) { return null; }
    return { from, ts, text, anchors: decodeAnchors(anchorsRaw), to };
}

/**
 * Regex per catturare pattern file.ext:line[-endLine] nel testo libero.
 * Usato per generare ancore automaticamente da messaggi ricevuti dall'app
 * Telegram mobile (dove non c'e' il protocollo VSC1|).
 * Match tipo: "DbPuma/views.py:245-260", "ui/App.js:12", "vibesync_sync.py:74".
 * Evita di matchare URL (esclude ':' preceduto da '/' o '.') e numeri isolati.
 */
const FILE_LINE_REGEX = /(?<![\w/.-])([a-zA-Z0-9_][\w.\/-]*\.[a-zA-Z0-9]{1,10}):(\d+)(?:-(\d+))?(?![\w])/g;

export function extractAnchorsFromText(text: string): Anchor[] {
    const found: Anchor[] = [];
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    FILE_LINE_REGEX.lastIndex = 0;
    while ((m = FILE_LINE_REGEX.exec(text)) !== null) {
        const [, file, sStr, eStr] = m;
        const start = parseInt(sStr, 10);
        const end = eStr ? parseInt(eStr, 10) : undefined;
        const key = end ? `${file}:${start}-${end}` : `${file}:${start}`;
        if (seen.has(key)) { continue; }
        seen.add(key);
        found.push({ file, start, end });
    }
    return found;
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/**
 * Manda un messaggio a tutti i recipient configurati.
 * Riutilizza `notifications.telegram.recipients` da config.
 * `notify_self` viene ignorato qui: la chat e' un canale broadcast, tutti i
 * partecipanti devono vedere quello che scrivi (anche se sei tu). Lo skip
 * lato viewer si fa nel panel (i propri messaggi appaiono come "mine").
 */
export async function sendChatMessage(text: string, anchors?: Anchor[], to?: string): Promise<SendResult> {
    const cfg = lockManager.getConfig();
    const tg = cfg?.notifications?.telegram;
    if (!cfg || !tg || !tg.bot_token || !Array.isArray(tg.recipients) || tg.recipients.length === 0) {
        return { ok: false, error: 'Telegram non configurato (bot_token o recipients mancanti)' };
    }
    const from = cfg.developer_name || 'Unknown';
    const ts = new Date().toISOString();
    const payload = encodeVsc1(from, ts, text, anchors, to);

    const results = await Promise.all(tg.recipients.map(async (r) => {
        try {
            const res = await tgPost(tg.bot_token, 'sendMessage', {
                chat_id: r.chat_id,
                text: payload,
                disable_web_page_preview: true,
            }, 10_000);
            return res?.ok === true;
        } catch { return false; }
    }));
    const sent = results.filter(Boolean).length;
    if (sent === 0) { return { ok: false, error: `Nessun invio riuscito (${tg.recipients.length} tentativi)` }; }
    return { ok: true };
}

// ---------------------------------------------------------------------------
// Receive — long polling
// ---------------------------------------------------------------------------

type MessageHandler = (msg: ChatMessage) => void;

let pollingActive = false;
let pollingLoopPromise: Promise<void> | undefined;
let pollingHandler: MessageHandler | null = null;

async function pollingLoop(): Promise<void> {
    const state = loadState();
    while (pollingActive) {
        const cfg = lockManager.getConfig();
        const tg = cfg?.notifications?.telegram;
        if (!cfg || !tg || !tg.bot_token) {
            // Config assente: attendi 10s e riprova (l'utente potrebbe configurarla dopo)
            await new Promise(r => setTimeout(r, 10_000));
            continue;
        }

        try {
            const res = await tgPost(tg.bot_token, 'getUpdates', {
                offset: state.last_update_id + 1,
                timeout: LONG_POLL_TIMEOUT_S,
                allowed_updates: ['message'],
            }, (LONG_POLL_TIMEOUT_S + 5) * 1000);

            if (!res?.ok || !Array.isArray(res.result)) {
                // Errore transitorio, backoff soft
                await new Promise(r => setTimeout(r, 5_000));
                continue;
            }

            for (const update of res.result) {
                if (typeof update.update_id === 'number' && update.update_id > state.last_update_id) {
                    state.last_update_id = update.update_id;
                }
                const message = update.message;
                if (!message || typeof message.text !== 'string') { continue; }

                const chatMsg = interpretMessage(update.update_id, message);
                if (chatMsg && pollingHandler) {
                    try { pollingHandler(chatMsg); }
                    catch { /* handler non deve rompere il loop */ }
                }
            }

            // Persisti il cursore dopo aver processato il batch (at-least-once
            // semantics; con la dedup lato history su id, non ci sono doppioni)
            saveState(state);
        } catch {
            // Timeout o network error: piccolo delay e riprova
            await new Promise(r => setTimeout(r, 3_000));
        }
    }
}

function interpretMessage(updateId: number, tgMessage: any): ChatMessage | null {
    const rawText: string = tgMessage.text || '';
    const from: any = tgMessage.from || {};
    const senderName: string = from.first_name || from.username || 'Sconosciuto';

    // Prova a decodificare come messaggio VibeSync-formattato
    const parsed = decodeVsc1(rawText);
    if (parsed) {
        // Ancore esplicite dal payload + eventuali ancore trovate anche nel testo
        // (es. l'utente ha scritto "vedi views.py:245" oltre ad aver selezionato
        // il range). Deduplichiamo per key.
        const inText = extractAnchorsFromText(parsed.text);
        const merged = mergeAnchors(parsed.anchors, inText);
        return {
            id: `tg-${updateId}`,
            from: parsed.from,
            ts: parsed.ts,
            text: parsed.text,
            is_vibesync: true,
            raw_from_telegram: senderName,
            anchors: merged.length > 0 ? merged : undefined,
            to: parsed.to,
        };
    }

    // Testo libero (probabilmente qualcuno ha scritto al bot dall'app Telegram
    // mobile). Lo mostriamo comunque, ma marcato is_vibesync=false. Auto-rileva
    // ancore da pattern file.ext:line — cosi' anche i messaggi da mobile diventano
    // cliccabili se contengono un riferimento al codice.
    const autoAnchors = extractAnchorsFromText(rawText);
    return {
        id: `tg-${updateId}`,
        from: senderName,
        ts: new Date((tgMessage.date || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
        text: rawText,
        is_vibesync: false,
        raw_from_telegram: senderName,
        anchors: autoAnchors.length > 0 ? autoAnchors : undefined,
    };
}

function mergeAnchors(a: Anchor[], b: Anchor[]): Anchor[] {
    const seen = new Set<string>();
    const out: Anchor[] = [];
    for (const anchor of [...a, ...b]) {
        const key = anchor.end ? `${anchor.file}:${anchor.start}-${anchor.end}` : `${anchor.file}:${anchor.start}`;
        if (seen.has(key)) { continue; }
        seen.add(key);
        out.push(anchor);
    }
    return out;
}

/**
 * Avvia il long polling in background. Idempotente: chiamate multiple non
 * creano loop paralleli. onMessage viene chiamato per ogni messaggio nuovo.
 */
export function startPolling(onMessage: MessageHandler): void {
    pollingHandler = onMessage;
    if (pollingActive) { return; }
    pollingActive = true;
    pollingLoopPromise = pollingLoop();
}

/**
 * Ferma il polling. Il loop termina alla prossima iterazione (max ~30s se e'
 * bloccato su una getUpdates lunga).
 */
export function stopPolling(): void {
    pollingActive = false;
    pollingHandler = null;
    pollingLoopPromise = undefined;
}

export function isPollingActive(): boolean {
    return pollingActive;
}
