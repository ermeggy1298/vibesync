/**
 * VibeSync Chat — Webview panel
 *
 * Pannello con lista messaggi + input textarea. Iter 0: chat piatta,
 * nessuna ancora al codice (arriva in Iter 1).
 *
 * Flow:
 *  - Al showChatPanel(): carica cronologia da chatHistory, marca tutti come letti,
 *    render iniziale, avvia il polling se non gia' attivo.
 *  - onSendMessage: chatTelegram.sendChatMessage(text), append LOCALE alla history
 *    (per vedere subito il proprio messaggio senza aspettare il polling round-trip),
 *    re-render.
 *  - onIncomingMessage (dal polling): chatHistory.appendIfNew, se panel aperto
 *    postMessage al webview, altrimenti toast.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as lockManager from './lockManager';
import { sendChatMessage, startPolling, ChatMessage, Anchor, extractAnchorsFromText, hashSnippet } from './chatTelegram';
import { appendIfNew, load, markAllRead, getUnreadCount, ChatHistoryEntry } from './chatHistory';

let currentPanel: vscode.WebviewPanel | undefined;
let pollingStarted = false;

// ---------------------------------------------------------------------------
// Handler globale del polling: gira anche a panel chiuso
// ---------------------------------------------------------------------------

/**
 * Da chiamare una sola volta all'activation dell'extension. Avvia il polling
 * in background: i messaggi in arrivo vengono persistiti sempre, e se il
 * panel e' aperto vengono inoltrati via postMessage, altrimenti generano toast.
 */
export function initChatBackground(): void {
    if (pollingStarted) { return; }
    const cfg = lockManager.getConfig();
    if (!cfg?.notifications?.telegram?.bot_token) { return; }
    pollingStarted = true;

    startPolling((msg: ChatMessage) => {
        const isNew = appendIfNew(msg);
        if (!isNew) { return; }

        // Se il messaggio e' del developer stesso (echo del proprio invio via
        // Telegram), lo mostriamo comunque nel panel per coerenza cross-device.
        if (currentPanel && currentPanel.visible) {
            currentPanel.webview.postMessage({ command: 'newMessage', message: { ...msg, read: true } });
            markAllRead();
        } else {
            // Toast solo per messaggi non tuoi (rumore altrimenti)
            const myName = cfg.developer_name || '';
            if (msg.from.toLowerCase() !== myName.toLowerCase()) {
                const isDirectedToMe = msg.to && msg.to.toLowerCase() === myName.toLowerCase();
                const isDirectedElsewhere = msg.to && msg.to.toLowerCase() !== myName.toLowerCase();
                // Se il messaggio e' esplicitamente targettato ad altro dev (@mention),
                // niente toast: e' rumore per te. Il messaggio finisce comunque in
                // cronologia e lo vedrai grigio "sussurrato" quando apri il panel.
                if (isDirectedElsewhere) { return; }

                const openLabel = 'Apri chat';
                const preview = msg.text.length > 60 ? msg.text.slice(0, 60) + '…' : msg.text;
                const prefix = isDirectedToMe ? `📌 @per te da ${msg.from}` : `💬 ${msg.from}`;
                const notify = isDirectedToMe
                    ? vscode.window.showWarningMessage    // toast prioritario per @mention diretto
                    : vscode.window.showInformationMessage;
                notify(`${prefix}: ${preview}`, openLabel).then(choice => {
                    if (choice === openLabel) {
                        vscode.commands.executeCommand('vibesync.openChat');
                    }
                });
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Pannello
// ---------------------------------------------------------------------------

export function showChatPanel(context: vscode.ExtensionContext): void {
    if (currentPanel) {
        currentPanel.reveal();
        markAllRead();
        return;
    }

    currentPanel = vscode.window.createWebviewPanel(
        'vibesyncChat',
        'VibeSync — Chat team',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
    );

    currentPanel.onDidDispose(() => { currentPanel = undefined; });

    const cfg = lockManager.getConfig();
    const myName = cfg?.developer_name || 'Me';
    const recipients = cfg?.notifications?.telegram?.recipients || [];
    const peers = recipients.filter(r => r.name.toLowerCase() !== myName.toLowerCase()).map(r => r.name);
    const peerLabel = peers.length === 0 ? '(nessun peer configurato)' : peers.join(', ');

    const history = load(200);
    markAllRead();

    currentPanel.webview.html = getPanelHtml(myName, peerLabel, history);

    currentPanel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.command === 'send') {
            const text = (msg.text || '').trim();
            if (!text) { return; }

            // Ancore = quelle esplicite passate dall'input (via context menu o
            // /anchor) + quelle rilevate nel testo. Merge deduplicato.
            const explicit: Anchor[] = Array.isArray(msg.anchors) ? msg.anchors : [];
            const auto = extractAnchorsFromText(text);
            const anchors = mergeAnchors(explicit, auto);
            const to: string | undefined = msg.to && typeof msg.to === 'string' && msg.to.trim() ? msg.to.trim() : undefined;

            // 1. append locale immediato per feedback UI (echo ottimistico)
            const localMsg: ChatMessage = {
                id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                from: myName,
                ts: new Date().toISOString(),
                text,
                is_vibesync: true,
                anchors: anchors.length > 0 ? anchors : undefined,
                to,
            };
            appendIfNew(localMsg);
            currentPanel?.webview.postMessage({ command: 'newMessage', message: { ...localMsg, read: true } });

            // 2. invio reale a Telegram
            const res = await sendChatMessage(text, anchors.length > 0 ? anchors : undefined, to);
            if (!res.ok) {
                vscode.window.showErrorMessage(`VibeSync Chat: invio fallito — ${res.error}`);
                currentPanel?.webview.postMessage({ command: 'sendFailed', id: localMsg.id, error: res.error });
            }
        } else if (msg.command === 'openAnchor') {
            await openAnchor(msg.file, msg.start, msg.end, msg.hash);
        }
    });

    // Assicura che il polling sia partito
    initChatBackground();
}

/** Utility per il badge sidebar. */
export function getUnread(): number { return getUnreadCount(); }

/**
 * Pre-compila l'input della chat con un'ancora (usato dal context menu
 * "Chatta selezione"). Se il pannello non e' aperto, lo apre.
 */
export function prefillWithAnchor(context: vscode.ExtensionContext, anchor: Anchor): void {
    if (!currentPanel) {
        showChatPanel(context);
    }
    // Il panel potrebbe non essere ancora pronto al momento del postMessage
    // (WebviewPanel emette messaggi solo dopo aver caricato l'HTML). Piccolo
    // delay per aspettare che il webview lo abbia agganciato.
    setTimeout(() => {
        currentPanel?.webview.postMessage({ command: 'prefillAnchor', anchor });
        currentPanel?.reveal();
    }, 200);
}

async function openAnchor(file: string, start: number, end?: number, originalHash?: string): Promise<void> {
    const cfg = lockManager.getConfig();
    const root = cfg?.local_root;
    if (!root) {
        vscode.window.showWarningMessage('VibeSync Chat: local_root non configurato, impossibile aprire l\'ancora.');
        return;
    }
    const full = path.join(root, file);
    if (!fs.existsSync(full)) {
        vscode.window.showWarningMessage(`VibeSync Chat: file non trovato nel workspace corrente: ${file}`);
        return;
    }
    const uri = vscode.Uri.file(full);
    const startPos = new vscode.Position(Math.max(0, start - 1), 0);
    const endLine = end && end > start ? end : start;
    const endPos = new vscode.Position(Math.max(0, endLine - 1), Number.MAX_SAFE_INTEGER);
    const selection = new vscode.Selection(startPos, endPos);

    const editor = await vscode.window.showTextDocument(uri, {
        selection,
        preview: false,
        viewColumn: vscode.ViewColumn.Beside,
    });

    // Iter 2: detect "codice cambiato". Se abbiamo l'hash originale, ricalcoliamo
    // l'hash sul range corrente (stesso contesto ±3 righe usato al send) e
    // segnaliamo l'utente se non matcha. Best-effort: nessun errore blocca l'apertura.
    if (originalHash) {
        try {
            const doc = editor.document;
            const CONTEXT = 3;
            const MAX_LINES = 8;
            const rawFrom = Math.max(0, start - 1 - CONTEXT);
            const rawTo = Math.min(doc.lineCount - 1, endLine - 1 + CONTEXT);
            const capTo = Math.min(rawTo, rawFrom + MAX_LINES - 1);
            const current = doc.getText(new vscode.Range(
                new vscode.Position(rawFrom, 0),
                new vscode.Position(capTo, Number.MAX_SAFE_INTEGER),
            ));
            const currentHash = hashSnippet(current);
            if (currentHash !== originalHash) {
                vscode.window.showWarningMessage(
                    `⚠ VibeSync Chat: il codice a ${file}:${start}${end && end > start ? '-' + end : ''} è cambiato da quando l'ancora è stata creata. Sto mostrando la versione ATTUALE del file.`,
                );
            }
        } catch { /* silent: non blocca l'apertura */ }
    }
}

function mergeAnchors(a: Anchor[], b: Anchor[]): Anchor[] {
    const seen = new Set<string>();
    const out: Anchor[] = [];
    for (const anchor of [...a, ...b]) {
        if (!anchor || !anchor.file || !anchor.start) { continue; }
        const key = anchor.end ? `${anchor.file}:${anchor.start}-${anchor.end}` : `${anchor.file}:${anchor.start}`;
        if (seen.has(key)) { continue; }
        seen.add(key);
        out.push(anchor);
    }
    return out;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getPanelHtml(myName: string, peerLabel: string, history: ChatHistoryEntry[]): string {
    const historyJson = JSON.stringify(history);
    const myNameJson = JSON.stringify(myName);
    // Lista dei possibili @mention target: tutti i recipient escluso me stesso
    const cfg = lockManager.getConfig();
    const targets: string[] = (cfg?.notifications?.telegram?.recipients || [])
        .map(r => r.name)
        .filter(n => n && n.toLowerCase() !== myName.toLowerCase());
    const targetsJson = JSON.stringify(targets);
    return `<!DOCTYPE html>
<html><head>
<style>
:root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-foreground);
    --border: var(--vscode-widget-border, #444);
    --accent: var(--vscode-focusBorder, #007acc);
    --input-bg: var(--vscode-input-background, #1e1e1e);
    --input-fg: var(--vscode-input-foreground, #ccc);
    --hover: var(--vscode-list-hoverBackground, #2a2d2e);
    --purple: #667eea;
    --pink: #f093fb;
    --cyan: #4facfe;
    --teal: #2dd4bf;
    --danger: #f85149;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
    font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
    font-size: 13px;
    color: var(--fg);
    background: var(--bg);
    display: flex;
    flex-direction: column;
    height: 100vh;
}
.header {
    padding: 14px 20px;
    border-bottom: 1px solid var(--border);
    background: linear-gradient(135deg, rgba(102,126,234,0.08) 0%, rgba(79,172,254,0.05) 100%);
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
}
.header-title {
    font-size: 15px;
    font-weight: 700;
    background: linear-gradient(135deg, #667eea 0%, #4facfe 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
}
.header-sub { font-size: 11px; opacity: 0.6; margin-top: 2px; }

.messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.messages .empty {
    opacity: 0.4;
    text-align: center;
    padding: 60px 20px;
    font-size: 12.5px;
}
.msg {
    max-width: 78%;
    padding: 8px 12px;
    border-radius: 10px;
    border: 1px solid var(--border);
    line-height: 1.5;
    animation: fadeIn 0.2s ease-out;
}
@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.msg.mine {
    align-self: flex-end;
    background: linear-gradient(135deg, rgba(240,147,251,0.14) 0%, rgba(102,126,234,0.10) 100%);
    border-color: rgba(240,147,251,0.35);
}
.msg.theirs {
    align-self: flex-start;
    background: linear-gradient(135deg, rgba(79,172,254,0.10) 0%, rgba(45,212,191,0.08) 100%);
    border-color: rgba(79,172,254,0.30);
}
.msg.free {
    /* messaggio non VibeSync (arrivato da app Telegram mobile) */
    border-style: dashed;
    opacity: 0.9;
}
.msg-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 10.5px;
    color: rgba(255,255,255,0.55);
    margin-bottom: 3px;
    letter-spacing: 0.3px;
}
.msg-head .name { color: var(--teal); font-weight: 700; }
.msg.mine .msg-head .name { color: var(--pink); }
.msg-head .time { opacity: 0.7; }
.msg-head .badge-free {
    background: rgba(250, 112, 154, 0.18);
    border: 1px solid rgba(250, 112, 154, 0.35);
    border-radius: 4px;
    padding: 0 5px;
    font-size: 9px;
    color: #ffb8b0;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}
.msg-text { white-space: pre-wrap; word-wrap: break-word; }
.msg-error { color: var(--danger); font-size: 10.5px; margin-top: 4px; }

/* @mention: se targettato a me, evidenzia; se ad altro dev, grigio/opaco */
.msg.to-me {
    border-left: 3px solid var(--pink);
    padding-left: 10px;
    box-shadow: 0 0 0 1px rgba(240,147,251,0.25);
}
.msg.to-other { opacity: 0.55; }
.msg.to-other:hover { opacity: 0.85; }
.badge-to {
    background: rgba(240,147,251,0.20);
    border: 1px solid rgba(240,147,251,0.4);
    border-radius: 4px;
    padding: 0 5px;
    font-size: 9.5px;
    color: var(--pink);
    text-transform: uppercase;
    letter-spacing: 0.4px;
    font-weight: 700;
}
.badge-to.grey {
    background: rgba(255,255,255,0.05);
    border-color: rgba(255,255,255,0.15);
    color: rgba(255,255,255,0.5);
}

.msg-anchors { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.msg-anchor-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.anchor-snippet {
    background: rgba(0, 0, 0, 0.35);
    border: 1px solid var(--border);
    border-left: 3px solid rgba(240, 147, 251, 0.5);
    border-radius: 6px;
    padding: 8px 10px;
    margin-top: 4px;
    font-family: var(--vscode-editor-font-family, 'SF Mono', monospace);
    font-size: 11.5px;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.82);
    white-space: pre;
    overflow-x: auto;
    max-height: 180px;
    max-width: 100%;
}
.anchor-snippet .ln {
    color: rgba(255, 255, 255, 0.35);
    display: inline-block;
    width: 32px;
    text-align: right;
    margin-right: 10px;
    user-select: none;
}
.chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 9px;
    border-radius: 5px;
    background: rgba(240,147,251,0.14);
    border: 1px solid rgba(240,147,251,0.35);
    color: var(--pink);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11.5px;
    cursor: pointer;
    text-decoration: none;
    transition: all 0.15s;
}
.chip:hover { background: rgba(240,147,251,0.28); border-color: rgba(240,147,251,0.6); }
.chip .chip-icon { font-size: 12px; opacity: 0.85; }

/* Ancora in preview nella composer (via context menu / /anchor) */
.anchor-preview {
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    padding: 6px 12px 0;
    min-height: 0;
    transition: min-height 0.15s;
}
.anchor-preview:not(:empty) { min-height: 32px; padding-bottom: 6px; }
.anchor-preview .chip-remove {
    background: none; border: none; color: var(--pink); cursor: pointer;
    margin-left: 4px; padding: 0; font-size: 13px; opacity: 0.6;
}
.anchor-preview .chip-remove:hover { opacity: 1; }

.composer {
    padding: 12px 16px;
    border-top: 1px solid var(--border);
    background: var(--bg);
    display: flex;
    gap: 8px;
    align-items: flex-end;
    flex-shrink: 0;
}
.composer select {
    padding: 8px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--input-bg);
    color: var(--input-fg);
    font-size: 12px;
    font-family: var(--vscode-font-family, 'Segoe UI');
    align-self: stretch;
    max-width: 150px;
}
.composer select:focus { outline: none; border-color: var(--accent); }
.composer textarea {
    flex: 1;
    resize: none;
    min-height: 36px;
    max-height: 160px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--input-bg);
    color: var(--input-fg);
    font-family: var(--vscode-font-family, 'Segoe UI');
    font-size: 13px;
    line-height: 1.4;
}
.composer textarea:focus { outline: none; border-color: var(--accent); }
.composer button {
    padding: 8px 16px;
    border: none;
    border-radius: 6px;
    background: linear-gradient(135deg, #667eea 0%, #4facfe 100%);
    color: #fff;
    font-weight: 600;
    cursor: pointer;
    font-size: 12.5px;
    align-self: stretch;
}
.composer button:hover { opacity: 0.92; }
.composer button:disabled { opacity: 0.4; cursor: not-allowed; }

.hint {
    font-size: 10px;
    opacity: 0.4;
    padding: 4px 20px 8px;
    text-align: right;
}
</style>
</head>
<body>

<div class="header">
    <div>
        <div class="header-title">💬 Chat team</div>
        <div class="header-sub">Tu: <strong>${escHtml(myName)}</strong> · Peer: ${escHtml(peerLabel)}</div>
    </div>
</div>

<div id="messages" class="messages"></div>

<div id="anchorPreview" class="anchor-preview"></div>
<div class="composer">
    <select id="targetSelect" title="Destinatario primario (il messaggio arriva a tutto il canale, ma il destinatario riceve toast prioritario e gli altri lo vedono in grigio)">
        <option value="">📢 Tutti</option>
    </select>
    <textarea id="input" placeholder="Scrivi un messaggio... (Ctrl+Invio per inviare). Riferimenti tipo &quot;views.py:245&quot; diventano chip cliccabili." rows="2"></textarea>
    <button id="sendBtn" onclick="send()">Invia</button>
</div>
<div class="hint">Ctrl+Invio · trasporto: Telegram bot · polling long-poll ~25s</div>

<script>
const vscode = acquireVsCodeApi();
const MY_NAME = ${myNameJson};
const TARGETS = ${targetsJson};
let messages = ${historyJson};

// Popola dropdown "Invia a" con i peer dal config
(function initTargetSelect() {
    const sel = document.getElementById('targetSelect');
    TARGETS.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = '📌 @' + name;
        sel.appendChild(opt);
    });
})();

function fmtTime(iso) {
    try {
        const d = new Date(iso);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
}

function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderAll() {
    const box = document.getElementById('messages');
    if (messages.length === 0) {
        box.innerHTML = '<div class="empty">Nessun messaggio ancora. Scrivi qualcosa per iniziare.</div>';
        return;
    }
    box.innerHTML = messages.map(renderMsg).join('');
    box.scrollTop = box.scrollHeight;
}

function anchorLabel(a) {
    const range = a.end && a.end > a.start ? (a.start + '-' + a.end) : String(a.start);
    // Mostra solo il basename del path per non riempire il chip
    const parts = (a.file || '').split('/');
    const short = parts[parts.length - 1] || a.file;
    return short + ':' + range;
}

function renderMsg(m) {
    const isMine = (m.from || '').toLowerCase() === MY_NAME.toLowerCase();
    // @mention state:
    //  - to assente          → normale (broadcast)
    //  - to == me            → to-me (evidenziato)
    //  - to != me AND != mio (sono altrui) → to-other (grigio)
    //  - to != me AND == mio mittente (io ho mandato a X) → nessuna classe extra (mio invio)
    let toCls = '';
    let toBadge = '';
    if (m.to) {
        const meLower = MY_NAME.toLowerCase();
        const toLower = m.to.toLowerCase();
        if (isMine) {
            toBadge = '<span class="badge-to">📌 a ' + escHtml(m.to) + '</span>';
        } else if (toLower === meLower) {
            toCls = ' to-me';
            toBadge = '<span class="badge-to">📌 per te</span>';
        } else {
            toCls = ' to-other';
            toBadge = '<span class="badge-to grey">📌 a ' + escHtml(m.to) + '</span>';
        }
    }
    const cls = 'msg ' + (isMine ? 'mine' : 'theirs') + (m.is_vibesync === false ? ' free' : '') + toCls;
    const badgeFree = m.is_vibesync === false ? '<span class="badge-free">telegram</span>' : '';

    let anchorsHtml = '';
    if (Array.isArray(m.anchors) && m.anchors.length > 0) {
        const items = m.anchors.map((a, i) => {
            const idAttr = JSON.stringify(m.id).replace(/"/g, '&quot;');
            const chip = '<a href="#" class="chip" onclick="openAnchor(event, ' + i + ', ' + idAttr + ')" title="' + escHtml(a.file) + '">' +
                '<span class="chip-icon">📄</span>' +
                escHtml(anchorLabel(a)) +
            '</a>';
            let snip = '';
            if (a.snippet) {
                // Numera le righe partendo dal contesto (start - 3, ma non sotto 1)
                const CONTEXT = 3;
                const firstLine = Math.max(1, a.start - CONTEXT);
                const lines = a.snippet.split(/\r?\n/);
                const rows = lines.map((line, k) => {
                    const ln = firstLine + k;
                    return '<span class="ln">' + ln + '</span>' + escHtml(line);
                }).join('\n');
                snip = '<div class="anchor-snippet">' + rows + '</div>';
            }
            return '<div class="msg-anchor-row">' + chip + '</div>' + snip;
        }).join('');
        anchorsHtml = '<div class="msg-anchors">' + items + '</div>';
    }

    return '<div class="' + cls + '" data-id="' + escHtml(m.id) + '">' +
        '<div class="msg-head">' +
            '<span class="name">' + escHtml(m.from || '?') + '</span>' +
            '<span class="time">' + fmtTime(m.ts) + '</span>' +
            toBadge +
            badgeFree +
        '</div>' +
        '<div class="msg-text">' + escHtml(m.text || '') + '</div>' +
        anchorsHtml +
    '</div>';
}

function openAnchor(ev, idx, msgId) {
    ev.preventDefault();
    const msg = messages.find(x => x.id === msgId);
    if (!msg || !msg.anchors || !msg.anchors[idx]) { return; }
    const a = msg.anchors[idx];
    vscode.postMessage({ command: 'openAnchor', file: a.file, start: a.start, end: a.end, hash: a.hash });
}

// Ancore pre-caricate (via context menu "Chatta selezione"): allegate al
// prossimo invio e poi resettate.
let pendingAnchors = [];

function anchorKey(a) {
    return a.end && a.end > a.start ? (a.file + ':' + a.start + '-' + a.end) : (a.file + ':' + a.start);
}

function renderAnchorPreview() {
    const box = document.getElementById('anchorPreview');
    if (pendingAnchors.length === 0) { box.innerHTML = ''; return; }
    box.innerHTML = pendingAnchors.map((a, i) =>
        '<span class="chip" title="' + escHtml(a.file) + '">' +
            '<span class="chip-icon">📌</span>' +
            escHtml(anchorLabel(a)) +
            '<button class="chip-remove" onclick="removePendingAnchor(' + i + ')" title="Rimuovi">&times;</button>' +
        '</span>'
    ).join('');
}

function addPendingAnchor(a) {
    const key = anchorKey(a);
    if (pendingAnchors.some(x => anchorKey(x) === key)) { return; }
    pendingAnchors.push(a);
    renderAnchorPreview();
}

function removePendingAnchor(i) {
    pendingAnchors.splice(i, 1);
    renderAnchorPreview();
}

function send() {
    const ta = document.getElementById('input');
    const text = ta.value.trim();
    if (!text) return;
    const to = document.getElementById('targetSelect').value || undefined;
    ta.value = '';
    ta.focus();
    vscode.postMessage({ command: 'send', text, anchors: pendingAnchors, to });
    pendingAnchors = [];
    renderAnchorPreview();
    // Non resetto il target: se stai avendo una conversazione mirata con
    // un dev specifico, i messaggi successivi vanno probabilmente allo stesso.
}

document.getElementById('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        send();
    }
});

window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.command === 'newMessage') {
        // Dedup: se e' gia' in lista (per id), sostituisci
        const idx = messages.findIndex(x => x.id === msg.message.id);
        if (idx >= 0) { messages[idx] = msg.message; } else { messages.push(msg.message); }
        renderAll();
    } else if (msg.command === 'sendFailed') {
        // Marca il messaggio locale con errore inline
        const el = document.querySelector('[data-id="' + msg.id + '"]');
        if (el) {
            const errEl = document.createElement('div');
            errEl.className = 'msg-error';
            errEl.textContent = '⚠ invio fallito: ' + msg.error;
            el.appendChild(errEl);
        }
    } else if (msg.command === 'prefillAnchor') {
        addPendingAnchor(msg.anchor);
        document.getElementById('input').focus();
    }
});

renderAll();
document.getElementById('input').focus();
</script>
</body></html>`;
}
