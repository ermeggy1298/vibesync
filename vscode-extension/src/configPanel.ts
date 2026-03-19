/**
 * VibeSync Config Panel
 * WebviewPanel per visualizzare e modificare ~/.vibesync/config.json
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getLang } from './i18n';

const CONFIG_PATH = path.join(os.homedir(), '.vibesync', 'config.json');

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

    currentPanel.webview.html = getConfigHtml(config);

    currentPanel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.command === 'save') {
            try {
                // Merge con config esistente per preservare campi non editabili (github_lock_branch, excluded_files)
                const existing = loadConfig() || {};
                const merged = { ...existing, ...msg.config };
                fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
                vscode.window.showInformationMessage('VibeSync: configurazione salvata');
                currentPanel!.webview.postMessage({ command: 'saved' });
            } catch (err: any) {
                vscode.window.showErrorMessage(`VibeSync: errore salvataggio — ${err.message}`);
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

function getConfigHtml(config: VibesyncConfig): string {
    const excludedItems = config.excluded_dirs.map(d =>
        `<div class="tag" data-dir="${escapeHtml(d)}">
            <span class="tag-text">${escapeHtml(d)}</span>
            <button class="tag-remove" onclick="removeExclusion('${escapeHtml(d)}')" title="Rimuovi">&times;</button>
        </div>`
    ).join('');

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
    <div class="field-hint" style="margin-bottom:10px">Queste cartelle vengono ignorate da lock, sync e release</div>

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

<div class="save-bar">
    <button class="btn btn-primary" id="saveBtn" onclick="saveConfig()" disabled>Salva configurazione</button>
    <span class="save-status" id="saveStatus">Nessuna modifica</span>
</div>

<script>
const vscode = acquireVsCodeApi();
let dirty = false;
let excludedDirs = ${JSON.stringify(config.excluded_dirs)};
let allFolders = [];

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
    container.innerHTML = excludedDirs.map(d =>
        '<div class="tag" data-dir="' + escapeHtml(d) + '">' +
        '<span class="tag-text">' + escapeHtml(d) + '</span>' +
        '<button class="tag-remove" onclick="removeExclusion(\\'' + escapeHtml(d) + '\\')" title="Rimuovi">&times;</button>' +
        '</div>'
    ).join('');
}

function addExclusion() {
    const input = document.getElementById('newExclusion');
    const name = input.value.trim();
    if (!name) return;
    if (excludedDirs.some(d => d.toLowerCase() === name.toLowerCase())) {
        input.value = '';
        return;
    }
    excludedDirs.push(name);
    excludedDirs.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    renderTags();
    input.value = '';
    markDirty();
    hideSuggestions();
}

function addExclusionByName(name) {
    if (excludedDirs.some(d => d.toLowerCase() === name.toLowerCase())) return;
    excludedDirs.push(name);
    excludedDirs.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    renderTags();
    markDirty();
    updateSuggestionDisplay();
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

window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.command === 'saved') {
        dirty = false;
        document.getElementById('saveBtn').disabled = true;
        document.getElementById('saveStatus').textContent = 'Salvato!';
        document.getElementById('saveStatus').className = 'save-status saved';
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
