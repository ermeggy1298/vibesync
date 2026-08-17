/**
 * VibeSync Config Panel
 * WebviewPanel per visualizzare e modificare ~/.vibesync/config.json
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getLang } from './i18n';
import { sendTestMessage } from './notificationsTelegram';
import * as lockManager from './lockManager';

const CONFIG_PATH = path.join(os.homedir(), '.vibesync', 'config.json');
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const CLAUDE_DEFAULT_RETENTION = 30;

// Cartelle silenziosamente sempre escluse dallo scan (vedi vibesync_sync.py:36-39).
// Se l'utente aggiunge una di queste come esclusione, la voce e' redundante ma non
// pericolosa: il match ricorsivo e' esattamente il comportamento desiderato per
// node_modules/__pycache__/etc. Non le trattiamo come "rischiose".
const DEFAULT_EXCLUDED_DIRS = new Set([
    '__pycache__', 'node_modules', '.git', '.next', 'dist', 'build',
    '.venv', 'venv', 'env', '.env', '.tox', '.pytest_cache', '.mypy_cache',
]);

function getLocalRootTopFolders(localRoot: string): string[] {
    try {
        const entries = fs.readdirSync(localRoot, { withFileTypes: true });
        return entries
            .filter(e => e.isDirectory())
            .map(e => e.name)
            .filter(name => !name.startsWith('.') && !DEFAULT_EXCLUDED_DIRS.has(name.toLowerCase()));
    } catch {
        return [];
    }
}

function isRiskyExclusion(name: string, topFoldersLower: Set<string>): boolean {
    if (name.includes('/') || name.includes('\\')) { return false; }
    return topFoldersLower.has(name.toLowerCase());
}

interface TelegramRecipient {
    name: string;
    chat_id: string;
}

interface NotificationsConfig {
    telegram?: {
        bot_token: string;
        recipients: TelegramRecipient[];
        notify_self?: boolean;
    };
}

interface VibesyncConfig {
    github_token: string;
    github_repo: string;
    github_branch: string;
    github_lock_branch?: string;
    developer_name: string;
    local_root: string;
    github_desktop_root: string;
    excluded_dirs: string[];
    excluded_files?: string[];
    notifications?: NotificationsConfig;
}

function loadClaudeRetention(): number {
    try {
        const raw = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8');
        const settings = JSON.parse(raw);
        const v = settings.cleanupPeriodDays;
        return typeof v === 'number' && v >= 1 ? v : CLAUDE_DEFAULT_RETENTION;
    } catch {
        return CLAUDE_DEFAULT_RETENTION;
    }
}

function saveClaudeRetention(days: number): void {
    let settings: Record<string, unknown> = {};
    try {
        const raw = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8');
        settings = JSON.parse(raw);
    } catch { /* file mancante o JSON invalido: ripartiamo da {} */ }
    settings.cleanupPeriodDays = days;
    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
}

let currentPanel: vscode.WebviewPanel | undefined;

export function showConfigPanel(): void {
    if (currentPanel) {
        currentPanel.reveal();
        return;
    }

    currentPanel = vscode.window.createWebviewPanel(
        'vibesyncConfig',
        'VibeSync — Impostazioni',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    currentPanel.onDidDispose(() => { currentPanel = undefined; });

    const config = loadConfig();
    if (!config) {
        currentPanel.webview.html = getErrorHtml();
        return;
    }

    currentPanel.webview.html = getConfigHtml(config, loadClaudeRetention(), getLocalRootTopFolders(config.local_root));

    currentPanel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.command === 'save') {
            try {
                // Merge con config esistente per preservare campi non editabili (github_lock_branch, excluded_files)
                const existing = loadConfig() || {};
                const merged = { ...existing, ...msg.config };
                fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
                lockManager.loadConfig();
                vscode.window.showInformationMessage('VibeSync: configurazione salvata');
                currentPanel!.webview.postMessage({ command: 'saved' });
            } catch (err: any) {
                vscode.window.showErrorMessage(`VibeSync: errore salvataggio — ${err.message}`);
            }
        } else if (msg.command === 'testTelegram') {
            try {
                const existing = loadConfig() || {} as VibesyncConfig;
                const merged: VibesyncConfig = {
                    ...existing,
                    notifications: {
                        ...(existing.notifications || {}),
                        telegram: {
                            bot_token: msg.bot_token,
                            recipients: msg.recipients,
                            notify_self: msg.notify_self === true,
                        },
                    },
                };
                fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
                lockManager.loadConfig();
                const result = await sendTestMessage();
                currentPanel!.webview.postMessage({ command: 'telegramTestResult', result });
                if (result.sent > 0 && result.failed.length === 0) {
                    vscode.window.showInformationMessage(`VibeSync: test Telegram OK (${result.sent} dev)`);
                } else if (result.sent > 0) {
                    vscode.window.showWarningMessage(`VibeSync: test Telegram parziale — ${result.sent} OK, ${result.failed.length} falliti`);
                } else if (result.skipped) {
                    vscode.window.showWarningMessage(`VibeSync: test saltato — ${result.skipped}`);
                } else {
                    const detail = result.failed.map(f => `${f.name}: ${f.error}`).join('; ');
                    vscode.window.showErrorMessage(`VibeSync: test Telegram fallito — ${detail}`);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`VibeSync: errore test Telegram — ${err.message}`);
            }
        } else if (msg.command === 'browseFolders') {
            const config = loadConfig();
            if (!config) { return; }
            const localRoot = config.local_root;

            try {
                const entries = fs.readdirSync(localRoot, { withFileTypes: true });
                const dirs = entries
                    .filter(e => e.isDirectory())
                    .map(e => e.name)
                    .filter(name => !name.startsWith('.'))
                    .sort();
                currentPanel!.webview.postMessage({ command: 'folderList', folders: dirs });
            } catch (err: any) {
                vscode.window.showErrorMessage(`VibeSync: errore lettura cartelle — ${err.message}`);
            }
        } else if (msg.command === 'changeLang') {
            await vscode.workspace.getConfiguration('vibesync').update('language', msg.lang, vscode.ConfigurationTarget.Global);
            const reloadLabel = msg.lang === 'en' ? 'Reload now' : 'Riavvia ora';
            const reloadMsg = msg.lang === 'en'
                ? 'VibeSync: Language changed to English. Reload VS Code to apply.'
                : 'VibeSync: Lingua cambiata in Italiano. Riavvia VS Code per applicare.';
            const choice = await vscode.window.showInformationMessage(reloadMsg, reloadLabel);
            if (choice === reloadLabel) {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        } else if (msg.command === 'saveClaudeRetention') {
            const days = Number(msg.days);
            if (!Number.isFinite(days) || days < 1 || !Number.isInteger(days)) {
                vscode.window.showErrorMessage('VibeSync: retention deve essere un intero >= 1');
                return;
            }
            try {
                saveClaudeRetention(days);
                vscode.window.showInformationMessage(`VibeSync: retention chat Claude Code impostata a ${days} giorni`);
                currentPanel!.webview.postMessage({ command: 'claudeRetentionSaved', days });
            } catch (err: any) {
                vscode.window.showErrorMessage(`VibeSync: errore salvataggio retention — ${err.message}`);
            }
        } else if (msg.command === 'pickFolder') {
            const uri = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                defaultUri: msg.field === 'local_root' || msg.field === 'github_desktop_root'
                    ? vscode.Uri.file(msg.currentValue || os.homedir())
                    : undefined,
                title: `VibeSync: seleziona cartella per ${msg.field}`,
            });
            if (uri && uri.length > 0) {
                const selected = uri[0].fsPath.replace(/\\/g, '/');
                currentPanel!.webview.postMessage({ command: 'folderPicked', field: msg.field, value: selected });
            }
        }
    });
}

function loadConfig(): VibesyncConfig | null {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const config = JSON.parse(raw);
        if (!config.excluded_dirs) { config.excluded_dirs = []; }
        return config;
    } catch {
        return null;
    }
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getErrorHtml(): string {
    return `<!DOCTYPE html>
<html><head><style>
body { font-family: var(--vscode-font-family, sans-serif); padding: 24px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
.error { color: var(--vscode-errorForeground, #f44); padding: 16px; border: 1px solid var(--vscode-errorForeground, #f44); border-radius: 4px; }
</style></head><body>
<div class="error">Config non trovato: ${escapeHtml(CONFIG_PATH)}</div>
</body></html>`;
}

function getConfigHtml(config: VibesyncConfig, claudeRetention: number, localRootTopFolders: string[]): string {
    const tg = config.notifications?.telegram;
    const tgToken = tg?.bot_token ?? '';
    const tgRecipients: TelegramRecipient[] = Array.isArray(tg?.recipients) ? tg!.recipients : [];
    const tgNotifySelf = tg?.notify_self === true;
    const topFoldersLower = new Set(localRootTopFolders.map(f => f.toLowerCase()));
    const excludedItems = config.excluded_dirs.map(d => {
        const risky = isRiskyExclusion(d, topFoldersLower);
        const cls = risky ? 'tag risky' : 'tag';
        const title = risky
            ? `MATCH RICORSIVO: esclude qualsiasi cartella con questo nome a qualunque profondita'. Per escludere solo la top-level meglio scrivere "${d}/"`
            : '';
        return `<div class="${cls}" data-dir="${escapeHtml(d)}" title="${escapeHtml(title)}">
            <span class="tag-text">${escapeHtml(d)}</span>
            <button class="tag-remove" onclick="removeExclusion('${escapeHtml(d)}')" title="Rimuovi">&times;</button>
        </div>`;
    }).join('');

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
    --input-border: var(--vscode-input-border, #444);
    --hover: var(--vscode-list-hoverBackground, #2a2d2e);
    --success: #2ea043;
    --danger: #f85149;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--vscode-font-family, 'Segoe UI', sans-serif); font-size: 13px; color: var(--fg); background: var(--bg); padding: 24px; max-width: 700px; }

h1 { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
.subtitle { font-size: 12px; opacity: 0.6; margin-bottom: 24px; }

/* Sezioni */
.section { margin-bottom: 24px; }
.section-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }

/* Campi */
.field { margin-bottom: 14px; }
.field-label { font-size: 12px; font-weight: 600; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
.field-hint { font-size: 11px; opacity: 0.5; margin-bottom: 4px; }
.field-row { display: flex; gap: 6px; }
input[type="text"], input[type="password"] {
    width: 100%; padding: 6px 10px; border: 1px solid var(--input-border);
    border-radius: 4px; background: var(--input-bg); color: var(--input-fg);
    font-family: var(--vscode-editor-font-family, monospace); font-size: 12px;
}
input:focus { outline: none; border-color: var(--accent); }
.field-row input { flex: 1; }

.btn { padding: 6px 12px; border: 1px solid var(--border); border-radius: 4px; background: var(--hover); color: var(--fg); cursor: pointer; font-size: 12px; white-space: nowrap; }
.btn:hover { border-color: var(--accent); }
.btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 600; }
.btn-primary:hover { opacity: 0.9; }
.btn-sm { padding: 4px 8px; font-size: 11px; }
.btn-danger { border-color: var(--danger); color: var(--danger); }
.btn-danger:hover { background: var(--danger); color: #fff; }

/* Token visibility */
.token-toggle { cursor: pointer; font-size: 11px; opacity: 0.6; }
.token-toggle:hover { opacity: 1; }

/* Tags per excluded_dirs */
.tags-container { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; min-height: 32px; }
.tag { display: flex; align-items: center; gap: 4px; padding: 4px 8px 4px 10px; border-radius: 4px; background: var(--hover); border: 1px solid var(--border); font-size: 12px; }
.tag-text { font-family: var(--vscode-editor-font-family, monospace); }
.tag-remove { background: none; border: none; color: var(--danger); cursor: pointer; font-size: 16px; line-height: 1; padding: 0 2px; opacity: 0.6; }
.tag-remove:hover { opacity: 1; }
.tag.risky {
    background: rgba(248, 81, 73, 0.15);
    border-color: rgba(248, 81, 73, 0.55);
    color: #ffb8b0;
    cursor: help;
}
.tag.risky::before {
    content: '\\26A0\\FE0F';
    margin-right: 4px;
    font-size: 11px;
}
.tag.risky .tag-remove { color: #ffb8b0; opacity: 0.8; }

/* Modal per voci esclusioni rischiose */
.modal-overlay {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.65);
    display: none;
    align-items: center; justify-content: center;
    z-index: 200;
    backdrop-filter: blur(2px);
}
.modal-overlay.active { display: flex; }
.modal-card {
    background: var(--bg);
    border: 1px solid var(--danger);
    border-radius: 12px;
    padding: 22px 24px;
    max-width: 540px;
    width: calc(100% - 40px);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
    animation: modalIn 0.15s ease-out;
}
@keyframes modalIn { from { transform: scale(0.96); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.modal-title {
    color: var(--danger);
    font-size: 15px;
    font-weight: 700;
    margin-bottom: 12px;
    display: flex; align-items: center; gap: 8px;
}
.modal-body {
    font-size: 13px;
    line-height: 1.65;
    margin-bottom: 18px;
    color: var(--fg);
}
.modal-body code {
    background: rgba(0, 0, 0, 0.4);
    padding: 2px 7px;
    border-radius: 4px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: #ffb8b0;
    font-size: 12px;
}
.modal-actions {
    display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap;
}

/* Add exclusion */
.add-row { display: flex; gap: 6px; margin-bottom: 8px; }
.add-row input { flex: 1; }

/* Folder picker dropdown */
.folder-picker { position: relative; }
.folder-dropdown { position: absolute; top: 100%; left: 0; right: 0; max-height: 200px; overflow-y: auto;
    background: var(--input-bg); border: 1px solid var(--accent); border-radius: 4px; z-index: 10;
    display: none; margin-top: 2px; }
.folder-dropdown.active { display: block; }
.folder-option { padding: 5px 10px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 6px; }
.folder-option:hover { background: var(--hover); }
.folder-option.excluded { opacity: 0.35; text-decoration: line-through; }
.folder-option .check { color: var(--success); font-size: 11px; }

/* Save bar */
.save-bar { position: sticky; bottom: 0; background: var(--bg); padding: 16px 0; border-top: 1px solid var(--border);
    display: flex; align-items: center; gap: 12px; }
.save-status { font-size: 12px; opacity: 0.7; }
.save-status.saved { color: var(--success); opacity: 1; }
</style>
</head>
<body>

<h1>VibeSync — ${getLang() === 'en' ? 'Settings' : 'Impostazioni'}</h1>
<p class="subtitle">${escapeHtml(CONFIG_PATH)}</p>

<div class="section">
    <div class="section-title">🌐 Language / Lingua</div>
    <div class="field">
        <div style="display:flex;gap:8px;align-items:center;">
            <button class="btn ${getLang() === 'it' ? 'btn-primary' : ''}" onclick="changeLang('it')">🇮🇹 Italiano</button>
            <button class="btn ${getLang() === 'en' ? 'btn-primary' : ''}" onclick="changeLang('en')">🇬🇧 English</button>
        </div>
    </div>
</div>

<div class="section">
    <div class="section-title">${getLang() === 'en' ? 'GitHub Connection' : 'Connessione GitHub'}</div>

    <div class="field">
        <div class="field-label">GitHub Token <span class="token-toggle" onclick="toggleToken()">[mostra/nascondi]</span></div>
        <input type="password" id="github_token" value="${escapeHtml(config.github_token)}" onchange="markDirty()" />
    </div>

    <div class="field">
        <div class="field-label">Repository</div>
        <div class="field-hint">Formato: owner/repo</div>
        <input type="text" id="github_repo" value="${escapeHtml(config.github_repo)}" onchange="markDirty()" />
    </div>

    <div class="field">
        <div class="field-label">Branch</div>
        <input type="text" id="github_branch" value="${escapeHtml(config.github_branch)}" onchange="markDirty()" />
    </div>
</div>

<div class="section">
    <div class="section-title">Developer</div>

    <div class="field">
        <div class="field-label">Nome developer</div>
        <div class="field-hint">Usato per identificare i lock</div>
        <input type="text" id="developer_name" value="${escapeHtml(config.developer_name)}" onchange="markDirty()" />
    </div>
</div>

<div class="section">
    <div class="section-title">Percorsi</div>

    <div class="field">
        <div class="field-label">Local Root</div>
        <div class="field-hint">Cartella di sviluppo locale</div>
        <div class="field-row">
            <input type="text" id="local_root" value="${escapeHtml(config.local_root)}" onchange="markDirty()" />
            <button class="btn btn-sm" onclick="pickFolder('local_root')">Sfoglia...</button>
        </div>
    </div>

    <div class="field">
        <div class="field-label">GitHub Desktop Root</div>
        <div class="field-hint">Cartella del repo GitHub Desktop</div>
        <div class="field-row">
            <input type="text" id="github_desktop_root" value="${escapeHtml(config.github_desktop_root)}" onchange="markDirty()" />
            <button class="btn btn-sm" onclick="pickFolder('github_desktop_root')">Sfoglia...</button>
        </div>
    </div>
</div>

<div class="section">
    <div class="section-title">Cartelle Escluse</div>
    <div class="field-hint" style="margin-bottom:10px">Queste cartelle vengono ignorate da lock, sync e release. Le voci in rosso &#9888;&#65039; sono match ricorsivi che potrebbero non essere volute.</div>

    <div class="tags-container" id="tagsContainer">
        ${excludedItems}
    </div>

    <div class="add-row folder-picker">
        <input type="text" id="newExclusion" placeholder="Nome cartella da escludere..." onkeydown="if(event.key==='Enter'){addExclusion();}" onfocus="showFolderSuggestions()" oninput="filterSuggestions()" />
        <button class="btn btn-sm" onclick="addExclusion()">+ Aggiungi</button>
        <button class="btn btn-sm" onclick="browseFolders()">Sfoglia cartelle</button>
        <div class="folder-dropdown" id="folderDropdown"></div>
    </div>
</div>

<div class="modal-overlay" id="riskyModal">
    <div class="modal-card">
        <div class="modal-title">&#9888;&#65039; Match ricorsivo — attenzione</div>
        <div class="modal-body">
            La voce <code id="riskyName"></code> corrisponde a una cartella di primo livello del tuo progetto,
            ma senza slash <strong>esclude qualsiasi cartella con quel nome a qualunque profondit&agrave;</strong>.
            Se hai una <code>Puma_backend/</code> a livello progetto e per sbaglio scrivi <code>Puma_backend</code>
            senza slash, tutta la cartella scompare dallo scan.
            <br><br>
            Per escludere solo la cartella di primo livello, scrivi <code id="riskySuggested"></code> con lo slash finale.
        </div>
        <div class="modal-actions">
            <button class="btn btn-primary" onclick="riskyChoose('slash')">Escludi solo top-level (raccomandato)</button>
            <button class="btn" onclick="riskyChoose('as-is')">Escludi ricorsivo (come &egrave;)</button>
            <button class="btn" onclick="riskyChoose('cancel')">Annulla</button>
        </div>
    </div>
</div>

<div class="section">
    <div class="section-title">📱 Notifiche Telegram</div>
    <div class="field-hint" style="margin-bottom:10px">
        Manda un messaggio Telegram ai dev quando rilasci file su git dalla Sync Dashboard.
        Setup: crea un bot con <code>@BotFather</code>, ottieni il <code>bot_token</code>;
        ogni dev manda <code>/start</code> al bot e legge il proprio <code>chat_id</code>
        (es. inoltrando un suo messaggio a <code>@userinfobot</code>).
    </div>

    <div class="field">
        <div class="field-label">Bot token <span class="token-toggle" onclick="toggleTgToken()">[mostra/nascondi]</span></div>
        <input type="password" id="tg_bot_token" value="${escapeHtml(tgToken)}" placeholder="123456:ABC-DEF..." />
    </div>

    <div class="field">
        <div class="field-label">Destinatari</div>
        <div class="field-hint">Nome dev (per skip auto-notifica) + chat_id Telegram</div>
        <div id="tg_recipients" style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px"></div>
        <button class="btn btn-sm" onclick="addTgRecipient()">+ Aggiungi destinatario</button>
    </div>

    <div class="field">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px">
            <input type="checkbox" id="tg_notify_self" ${tgNotifySelf ? 'checked' : ''} />
            <span>Notifica anche me stesso (di default chi rilascia non riceve la notifica)</span>
        </label>
    </div>

    <div class="field" style="display:flex;gap:8px;align-items:center">
        <button class="btn btn-sm btn-primary" onclick="testTelegram()">Salva e invia test</button>
        <span class="save-status" id="tgStatus"></span>
    </div>
</div>

<div class="section">
    <div class="section-title">Claude Code — Retention chat</div>
    <div class="field-hint" style="margin-bottom:10px">
        Giorni di conservazione delle conversazioni in <code>~/.claude/projects/</code>.
        Default Claude Code: <strong>30</strong> giorni. Oltre questo limite le chat vengono cancellate al prossimo avvio.
        Modifica il valore qui per evitare la perdita di chat vecchie.
    </div>
    <div class="field">
        <div class="field-label">cleanupPeriodDays</div>
        <div class="field-row">
            <input type="number" id="claude_retention" value="${claudeRetention}" min="1" step="1" style="max-width:160px" />
            <button class="btn btn-sm btn-primary" onclick="saveClaudeRetention()">Salva retention</button>
            <span class="save-status" id="claudeRetentionStatus" style="margin-left:8px"></span>
        </div>
        <div class="field-hint" style="margin-top:6px">
            Scritto in <code>${escapeHtml(path.join(os.homedir(), '.claude', 'settings.json'))}</code>.
            Effetto al prossimo avvio di Claude Code.
        </div>
    </div>
</div>

<div class="save-bar">
    <button class="btn btn-primary" id="saveBtn" onclick="saveConfig()" disabled>Salva configurazione</button>
    <span class="save-status" id="saveStatus">Nessuna modifica</span>
</div>

<script>
const vscode = acquireVsCodeApi();
let dirty = false;
let excludedDirs = ${JSON.stringify(config.excluded_dirs)};
let allFolders = [];
const localRootTopFolders = new Set(${JSON.stringify(localRootTopFolders.map(f => f.toLowerCase()))});

function isRisky(name) {
    if (!name) return false;
    if (name.indexOf('/') !== -1 || name.indexOf('\\\\') !== -1) return false;
    return localRootTopFolders.has(name.toLowerCase());
}

let pendingRiskyOnConfirm = null;
function showRiskyModal(name, onConfirm) {
    pendingRiskyOnConfirm = onConfirm;
    document.getElementById('riskyName').textContent = name;
    document.getElementById('riskySuggested').textContent = name + '/';
    document.getElementById('riskyModal').classList.add('active');
}
function riskyChoose(choice) {
    const modal = document.getElementById('riskyModal');
    const name = document.getElementById('riskyName').textContent;
    modal.classList.remove('active');
    const cb = pendingRiskyOnConfirm;
    pendingRiskyOnConfirm = null;
    if (choice === 'cancel' || !cb) return;
    cb(choice === 'slash' ? (name + '/') : name);
}
function tryAddExclusion(name, onConfirm) {
    if (isRisky(name)) { showRiskyModal(name, onConfirm); }
    else { onConfirm(name); }
}

function changeLang(lang) {
    vscode.postMessage({ command: 'changeLang', lang });
}

function markDirty() {
    dirty = true;
    document.getElementById('saveBtn').disabled = false;
    document.getElementById('saveStatus').textContent = 'Modifiche non salvate';
    document.getElementById('saveStatus').className = 'save-status';
}

function toggleToken() {
    const input = document.getElementById('github_token');
    input.type = input.type === 'password' ? 'text' : 'password';
}

function pickFolder(field) {
    const input = document.getElementById(field);
    vscode.postMessage({ command: 'pickFolder', field, currentValue: input.value });
}

function renderTags() {
    const container = document.getElementById('tagsContainer');
    container.innerHTML = excludedDirs.map(d => {
        const risky = isRisky(d);
        const cls = risky ? 'tag risky' : 'tag';
        const title = risky
            ? 'MATCH RICORSIVO: esclude qualsiasi cartella con questo nome a qualunque profondita. Meglio scrivere "' + d + '/" per escludere solo la top-level.'
            : '';
        return '<div class="' + cls + '" data-dir="' + escapeHtml(d) + '" title="' + escapeHtml(title) + '">' +
            '<span class="tag-text">' + escapeHtml(d) + '</span>' +
            '<button class="tag-remove" onclick="removeExclusion(\\'' + escapeHtml(d) + '\\')" title="Rimuovi">&times;</button>' +
            '</div>';
    }).join('');
}

function addExclusion() {
    const input = document.getElementById('newExclusion');
    const name = input.value.trim();
    if (!name) return;
    tryAddExclusion(name, (finalName) => {
        if (excludedDirs.some(d => d.toLowerCase() === finalName.toLowerCase())) {
            input.value = '';
            hideSuggestions();
            return;
        }
        excludedDirs.push(finalName);
        excludedDirs.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        renderTags();
        input.value = '';
        markDirty();
        hideSuggestions();
    });
}

function addExclusionByName(name) {
    tryAddExclusion(name, (finalName) => {
        if (excludedDirs.some(d => d.toLowerCase() === finalName.toLowerCase())) return;
        excludedDirs.push(finalName);
        excludedDirs.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        renderTags();
        markDirty();
        updateSuggestionDisplay();
    });
}

function removeExclusion(name) {
    excludedDirs = excludedDirs.filter(d => d !== name);
    renderTags();
    markDirty();
    updateSuggestionDisplay();
}

function browseFolders() {
    vscode.postMessage({ command: 'browseFolders' });
}

function showFolderSuggestions() {
    if (allFolders.length > 0) {
        updateSuggestionDisplay();
    }
}

function hideSuggestions() {
    document.getElementById('folderDropdown').classList.remove('active');
}

function filterSuggestions() {
    updateSuggestionDisplay();
}

function updateSuggestionDisplay() {
    if (allFolders.length === 0) return;
    const filter = document.getElementById('newExclusion').value.toLowerCase();
    const dropdown = document.getElementById('folderDropdown');
    const filtered = allFolders.filter(f => !filter || f.toLowerCase().includes(filter));

    if (filtered.length === 0) {
        dropdown.classList.remove('active');
        return;
    }

    dropdown.innerHTML = filtered.map(f => {
        const isExcluded = excludedDirs.some(d => d.toLowerCase() === f.toLowerCase());
        return '<div class="folder-option ' + (isExcluded ? 'excluded' : '') + '" onclick="' +
            (isExcluded ? 'removeExclusion(\\'' + escapeHtml(f) + '\\')' : 'addExclusionByName(\\'' + escapeHtml(f) + '\\')') + '">' +
            (isExcluded ? '<span class="check">&#10003; esclusa</span>' : '<span>&#128193;</span>') +
            '<span>' + escapeHtml(f) + '</span></div>';
    }).join('');
    dropdown.classList.add('active');
}

let tgRecipients = ${JSON.stringify(tgRecipients)};

function renderTgRecipients() {
    const container = document.getElementById('tg_recipients');
    if (tgRecipients.length === 0) {
        container.innerHTML = '<div class="field-hint" style="opacity:0.4">Nessun destinatario configurato</div>';
        return;
    }
    container.innerHTML = tgRecipients.map((r, i) =>
        '<div style="display:flex;gap:6px;align-items:center">' +
        '<input type="text" placeholder="Nome (es. Meggio)" value="' + escapeHtml(r.name) + '" oninput="updateTgRecipient(' + i + ', \\'name\\', this.value)" style="flex:0 0 180px" />' +
        '<input type="text" placeholder="chat_id Telegram" value="' + escapeHtml(r.chat_id) + '" oninput="updateTgRecipient(' + i + ', \\'chat_id\\', this.value)" style="flex:1;font-family:monospace" />' +
        '<button class="btn btn-sm btn-danger" onclick="removeTgRecipient(' + i + ')" title="Rimuovi">&times;</button>' +
        '</div>'
    ).join('');
}

function addTgRecipient() {
    tgRecipients.push({ name: '', chat_id: '' });
    renderTgRecipients();
}

function removeTgRecipient(i) {
    tgRecipients.splice(i, 1);
    renderTgRecipients();
}

function updateTgRecipient(i, field, value) {
    if (tgRecipients[i]) { tgRecipients[i][field] = value; }
}

function toggleTgToken() {
    const input = document.getElementById('tg_bot_token');
    input.type = input.type === 'password' ? 'text' : 'password';
}

function testTelegram() {
    const bot_token = document.getElementById('tg_bot_token').value.trim();
    const notify_self = document.getElementById('tg_notify_self').checked;
    const clean = tgRecipients
        .map(r => ({ name: (r.name || '').trim(), chat_id: (r.chat_id || '').trim() }))
        .filter(r => r.name && r.chat_id);

    const status = document.getElementById('tgStatus');
    if (!bot_token) {
        status.textContent = 'Bot token mancante';
        status.className = 'save-status';
        return;
    }
    if (clean.length === 0) {
        status.textContent = 'Nessun destinatario valido';
        status.className = 'save-status';
        return;
    }

    status.textContent = 'Invio test...';
    status.className = 'save-status';
    vscode.postMessage({ command: 'testTelegram', bot_token, recipients: clean, notify_self });
}

function saveClaudeRetention() {
    const raw = document.getElementById('claude_retention').value;
    const days = parseInt(raw, 10);
    const status = document.getElementById('claudeRetentionStatus');
    if (!Number.isInteger(days) || days < 1) {
        status.textContent = 'Valore non valido';
        status.className = 'save-status';
        return;
    }
    status.textContent = 'Salvataggio...';
    status.className = 'save-status';
    vscode.postMessage({ command: 'saveClaudeRetention', days });
}

function saveConfig() {
    const config = {
        github_token: document.getElementById('github_token').value,
        github_repo: document.getElementById('github_repo').value,
        github_branch: document.getElementById('github_branch').value,
        developer_name: document.getElementById('developer_name').value,
        local_root: document.getElementById('local_root').value,
        github_desktop_root: document.getElementById('github_desktop_root').value,
        excluded_dirs: excludedDirs,
    };
    vscode.postMessage({ command: 'save', config });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Chiudi dropdown se si clicca fuori
document.addEventListener('click', (e) => {
    if (!e.target.closest('.folder-picker')) {
        hideSuggestions();
    }
});

// Init render lista destinatari Telegram
renderTgRecipients();

window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.command === 'saved') {
        dirty = false;
        document.getElementById('saveBtn').disabled = true;
        document.getElementById('saveStatus').textContent = 'Salvato!';
        document.getElementById('saveStatus').className = 'save-status saved';
    } else if (msg.command === 'claudeRetentionSaved') {
        const status = document.getElementById('claudeRetentionStatus');
        status.textContent = 'Salvato (' + msg.days + 'gg)';
        status.className = 'save-status saved';
    } else if (msg.command === 'telegramTestResult') {
        const status = document.getElementById('tgStatus');
        const r = msg.result || { sent: 0, failed: [], skipped: '' };
        if (r.sent > 0 && (!r.failed || r.failed.length === 0)) {
            status.textContent = 'Test OK (' + r.sent + ' dev)';
            status.className = 'save-status saved';
        } else if (r.sent > 0) {
            status.textContent = r.sent + ' OK, ' + r.failed.length + ' falliti';
            status.className = 'save-status';
        } else if (r.skipped) {
            status.textContent = 'Saltato: ' + r.skipped;
            status.className = 'save-status';
        } else {
            const detail = (r.failed || []).map(f => f.name + ': ' + f.error).join('; ');
            status.textContent = 'Errore: ' + (detail || 'unknown');
            status.className = 'save-status';
        }
    } else if (msg.command === 'folderPicked') {
        document.getElementById(msg.field).value = msg.value;
        markDirty();
    } else if (msg.command === 'folderList') {
        allFolders = msg.folders;
        updateSuggestionDisplay();
        document.getElementById('folderDropdown').classList.add('active');
    }
});
</script>
</body></html>`;
}
