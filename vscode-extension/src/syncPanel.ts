/**
 * VibeSync Sync Dashboard
 * WebviewPanel per visualizzare le differenze tra local_root e github_desktop_root
 * e selezionare i file da copiare.
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as lockManager from './lockManager';
import { t, getWebviewTranslations } from './i18n';

const CONFIG_PATH = path.join(os.homedir(), '.vibesync', 'config.json');

interface ScanResult {
    success: boolean;
    identical_count: number;
    skipped_count: number;
    new_files: { file: string; directory: string; filename: string; size: number }[];
    modified_files: { file: string; directory: string; filename: string; local_size: number; github_size: number; diff_bytes: number }[];
    error?: string;
}

interface CopyResult {
    success: boolean;
    copied: string[];
    errors: { file: string; error: string }[];
}

let currentPanel: vscode.WebviewPanel | undefined;

export async function showSyncDashboard(): Promise<void> {
    if (currentPanel) {
        currentPanel.reveal();
        return;
    }

    currentPanel = vscode.window.createWebviewPanel(
        'vibesyncSync',
        t('sync.title'),
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    currentPanel.onDidDispose(() => { currentPanel = undefined; });

    currentPanel.webview.html = getLoadingHtml();

    const scanResult = await runScan();

    if (!scanResult.success) {
        currentPanel.webview.html = getErrorHtml(scanResult.error ?? t('sync.unknownError'));
        return;
    }

    currentPanel.webview.html = getDashboardHtml(scanResult);

    currentPanel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.command === 'copy') {
            const files: string[] = msg.files;
            if (files.length === 0) {
                vscode.window.showWarningMessage(t('sync.noFilesSelected'));
                return;
            }

            const copyLabel = t('sync.copy');
            const confirm = await vscode.window.showWarningMessage(
                t('sync.confirmCopy', files.length),
                copyLabel,
                t('ext.cancel')
            );
            if (confirm !== copyLabel) { return; }

            currentPanel?.webview.postMessage({ command: 'copying', count: files.length });

            const result = await runCopy(files);

            currentPanel?.webview.postMessage({ command: 'copyResult', result });

            if (result.copied.length > 0) {
                let unlocked = 0;
                for (const file of result.copied) {
                    try {
                        const unlockResult = await lockManager.releaseLock(file);
                        if (unlockResult.success) { unlocked++; }
                    } catch { /* ignore */ }
                }
                if (unlocked > 0) {
                    await lockManager.fetchLocksFromGitHub();
                }
            }

            if (result.success) {
                vscode.window.showInformationMessage(t('sync.filesCopied', result.copied.length));
            } else {
                vscode.window.showErrorMessage(t('sync.copyWithErrors', result.copied.length, result.errors.length));
            }
        } else if (msg.command === 'refresh') {
            currentPanel!.webview.html = getLoadingHtml();
            const fresh = await runScan();
            if (fresh.success) {
                currentPanel!.webview.html = getDashboardHtml(fresh);
            } else {
                currentPanel!.webview.html = getErrorHtml(fresh.error ?? t('sync.unknownError'));
            }
        } else if (msg.command === 'openFile') {
            const config = lockManager.getConfig();
            if (config) {
                const filePath = path.join(config.local_root, msg.file);
                vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
            }
        } else if (msg.command === 'diffFile') {
            const config = lockManager.getConfig();
            if (config) {
                const localUri = vscode.Uri.file(path.join(config.local_root, msg.file));
                const githubUri = vscode.Uri.file(path.join(config.github_desktop_root, msg.file));
                vscode.commands.executeCommand('vscode.diff', localUri, githubUri,
                    t('sync.diffTitle', msg.file));
            }
        } else if (msg.command === 'excludeFile') {
            addToConfig('excluded_files', msg.file);
            currentPanel?.webview.postMessage({ command: 'excluded', type: 'file', value: msg.file });
        } else if (msg.command === 'excludeDir') {
            addToConfig('excluded_dirs', msg.dir);
            currentPanel?.webview.postMessage({ command: 'excluded', type: 'dir', value: msg.dir });
        }
    });
}

// ---------------------------------------------------------------------------
// Python script calls
// ---------------------------------------------------------------------------

function getSyncScriptPath(): string {
    const config = lockManager.getConfig();
    if (config) { return path.join(config.local_root, 'vibesync', 'vibesync_sync.py'); }
    return 'vibesync_sync.py';
}

function getPythonPath(): string {
    return vscode.workspace.getConfiguration('vibesync').get<string>('pythonPath') || 'python';
}

function runScan(): Promise<ScanResult> {
    return new Promise((resolve) => {
        const proc = cp.spawn(getPythonPath(), [getSyncScriptPath(), '--scan'], { cwd: lockManager.getLocalRoot() || undefined });
        let stdout = '', stderr = '';
        proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('close', () => {
            try { resolve(JSON.parse(stdout.trim())); }
            catch { resolve({ success: false, identical_count: 0, skipped_count: 0, new_files: [], modified_files: [], error: stderr || 'Parsing error' }); }
        });
        proc.on('error', (err: Error) => {
            resolve({ success: false, identical_count: 0, skipped_count: 0, new_files: [], modified_files: [], error: err.message });
        });
        setTimeout(() => { proc.kill(); }, 120000);
    });
}

function runCopy(files: string[]): Promise<CopyResult> {
    return new Promise((resolve) => {
        const proc = cp.spawn(getPythonPath(), [getSyncScriptPath(), '--copy-files', ...files], { cwd: lockManager.getLocalRoot() || undefined });
        let stdout = '', stderr = '';
        proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('close', () => {
            try { resolve(JSON.parse(stdout.trim())); }
            catch { resolve({ success: false, copied: [], errors: [{ file: '*', error: stderr || 'Parsing error' }] }); }
        });
        proc.on('error', (err: Error) => {
            resolve({ success: false, copied: [], errors: [{ file: '*', error: err.message }] });
        });
        setTimeout(() => { proc.kill(); }, 300000);
    });
}

// ---------------------------------------------------------------------------
// Config update
// ---------------------------------------------------------------------------

function addToConfig(field: 'excluded_dirs' | 'excluded_files', value: string): void {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const config = JSON.parse(raw);
        if (!config[field]) { config[field] = []; }
        const arr: string[] = config[field];
        if (!arr.some(v => v.toLowerCase() === value.toLowerCase())) {
            arr.push(value);
            arr.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
            lockManager.loadConfig();
            vscode.window.showInformationMessage(t('sync.addedToExclusions', value));
        }
    } catch (err: any) {
        vscode.window.showErrorMessage(t('sync.configSaveError', err.message));
    }
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function getLoadingHtml(): string {
    const T = getWebviewTranslations();
    return `<!DOCTYPE html>
<html><head><style>
body { font-family: var(--vscode-font-family, sans-serif); padding: 24px; color: var(--vscode-foreground); background: var(--vscode-editor-background); display: flex; align-items: center; justify-content: center; min-height: 60vh; }
.spinner { border: 4px solid var(--vscode-widget-border, #444); border-top-color: var(--vscode-focusBorder, #007acc); border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin-right: 16px; }
@keyframes spin { to { transform: rotate(360deg); } }
</style></head><body><div class="spinner"></div><span>${T['sync.scanning']}</span></body></html>`;
}

function getErrorHtml(error: string): string {
    const T = getWebviewTranslations();
    return `<!DOCTYPE html>
<html><head><style>
body { font-family: var(--vscode-font-family, sans-serif); padding: 24px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
.error { color: var(--vscode-errorForeground, #f44); padding: 16px; border: 1px solid var(--vscode-errorForeground, #f44); border-radius: 4px; }
</style></head><body><div class="error">${escapeHtml(error)}</div></body></html>`;
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatSize(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getDashboardHtml(data: ScanResult): string {
    const T = getWebviewTranslations();
    const totalNew = data.new_files.length;
    const totalMod = data.modified_files.length;
    const totalFiles = totalNew + totalMod;
    const totalSize = data.new_files.reduce((s, f) => s + f.size, 0)
        + data.modified_files.reduce((s, f) => s + f.local_size, 0);

    const newByDir = groupBy(data.new_files, f => f.directory);
    const modByDir = groupBy(data.modified_files, f => f.directory);

    let newSectionsHtml = '';
    for (const dir of Object.keys(newByDir).sort()) {
        const files = newByDir[dir];
        newSectionsHtml += `
        <div class="dir-group">
            <div class="dir-header" onclick="toggleDir(this)">
                <span class="arrow collapsed">&#9660;</span>
                <input type="checkbox" class="dir-checkbox" data-dir="${escapeHtml(dir)}" data-type="new" onchange="toggleDirFiles(this)" checked />
                <span class="dir-name">${escapeHtml(dir)}</span>
                <span class="dir-badge">${files.length}</span>
                ${dir !== '(root)' ? `<button class="btn-exclude-dir" onclick="excludeDir('${escapeJs(dir)}'); event.stopPropagation();" title="${T['sync.excludeFolder']}">&#10005;</button>` : ''}
            </div>
            <div class="dir-files hidden">
                ${files.sort((a, b) => a.filename.localeCompare(b.filename)).map(f => `
                <label class="file-row" data-file="${escapeHtml(f.file)}">
                    <input type="checkbox" class="file-checkbox" value="${escapeHtml(f.file)}" data-type="new" checked />
                    <span class="file-icon new-icon">+</span>
                    <span class="file-name" title="${escapeHtml(f.file)}">${escapeHtml(f.filename)}</span>
                    <span class="file-size">${formatSize(f.size)}</span>
                    <button class="btn-open" onclick="openFile('${escapeJs(f.file)}'); event.preventDefault();" title="${T['sync.openFile']}">&#128269;</button>
                    <button class="btn-exclude" onclick="excludeFile('${escapeJs(f.file)}'); event.preventDefault();" title="${T['sync.excludeFile']}">&#10005;</button>
                </label>`).join('')}
            </div>
        </div>`;
    }

    let modSectionsHtml = '';
    for (const dir of Object.keys(modByDir).sort()) {
        const files = modByDir[dir];
        modSectionsHtml += `
        <div class="dir-group">
            <div class="dir-header" onclick="toggleDir(this)">
                <span class="arrow collapsed">&#9660;</span>
                <input type="checkbox" class="dir-checkbox" data-dir="${escapeHtml(dir)}" data-type="mod" onchange="toggleDirFiles(this)" checked />
                <span class="dir-name">${escapeHtml(dir)}</span>
                <span class="dir-badge">${files.length}</span>
                ${dir !== '(root)' ? `<button class="btn-exclude-dir" onclick="excludeDir('${escapeJs(dir)}'); event.stopPropagation();" title="${T['sync.excludeFolder']}">&#10005;</button>` : ''}
            </div>
            <div class="dir-files hidden">
                ${files.sort((a, b) => a.filename.localeCompare(b.filename)).map(f => {
                    const arrow = f.diff_bytes >= 0 ? '+' : '';
                    return `
                <label class="file-row" data-file="${escapeHtml(f.file)}">
                    <input type="checkbox" class="file-checkbox" value="${escapeHtml(f.file)}" data-type="mod" checked />
                    <span class="file-icon mod-icon">~</span>
                    <span class="file-name" title="${escapeHtml(f.file)}">${escapeHtml(f.filename)}</span>
                    <span class="file-size">${formatSize(f.github_size)} &#8594; ${formatSize(f.local_size)}</span>
                    <span class="file-diff">${arrow}${f.diff_bytes} B</span>
                    <button class="btn-open" onclick="diffFile('${escapeJs(f.file)}'); event.preventDefault();" title="${T['sync.showDiff']}">&#128269;</button>
                    <button class="btn-exclude" onclick="excludeFile('${escapeJs(f.file)}'); event.preventDefault();" title="${T['sync.excludeFile']}">&#10005;</button>
                </label>`;
                }).join('')}
            </div>
        </div>`;
    }

    return `<!DOCTYPE html>
<html><head>
<style>
:root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-foreground);
    --border: var(--vscode-widget-border, #444);
    --accent: var(--vscode-focusBorder, #007acc);
    --badge-new: #2ea04370;
    --badge-mod: #d29922a0;
    --hover: var(--vscode-list-hoverBackground, #2a2d2e);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--vscode-font-family, 'Segoe UI', sans-serif); font-size: 13px; color: var(--fg); background: var(--bg); padding: 0; }
.header { padding: 20px 24px 16px; border-bottom: 1px solid var(--border); }
.header h1 { font-size: 18px; font-weight: 600; margin-bottom: 12px; }
.stats { display: flex; gap: 16px; flex-wrap: wrap; }
.stat { padding: 8px 16px; border-radius: 6px; background: var(--hover); }
.stat-value { font-size: 20px; font-weight: 700; }
.stat-label { font-size: 11px; opacity: 0.7; margin-top: 2px; }
.toolbar { padding: 12px 24px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.btn { padding: 6px 14px; border: 1px solid var(--border); border-radius: 4px; background: var(--hover); color: var(--fg); cursor: pointer; font-size: 12px; }
.btn:hover { border-color: var(--accent); }
.btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 600; }
.btn-primary:hover { opacity: 0.9; }
.btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-refresh { font-weight: 600; font-size: 13px; }
.btn-refresh:hover { background: var(--accent); color: #fff; border-color: var(--accent); }
.toolbar-sep { width: 1px; height: 20px; background: var(--border); }
.selection-info { margin-left: auto; font-size: 12px; opacity: 0.7; }
.section { padding: 16px 24px 8px; }
.section-title { font-size: 14px; font-weight: 600; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
.section-badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
.new-badge { background: var(--badge-new); }
.mod-badge { background: var(--badge-mod); }
.dir-group { margin-bottom: 4px; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
.dir-header { display: flex; align-items: center; gap: 8px; padding: 6px 12px; cursor: pointer; background: var(--hover); user-select: none; }
.dir-header:hover { opacity: 0.9; }
.arrow { font-size: 10px; transition: transform 0.15s; width: 14px; text-align: center; }
.arrow.collapsed { transform: rotate(-90deg); }
.dir-name { font-weight: 600; font-size: 12px; }
.dir-badge { font-size: 11px; opacity: 0.6; margin-left: 4px; }
.dir-files { padding: 0; }
.dir-files.hidden { display: none; }
.file-row { display: flex; align-items: center; gap: 8px; padding: 3px 12px 3px 36px; cursor: pointer; font-size: 12px; }
.file-row:hover { background: var(--hover); }
.file-icon { width: 18px; height: 18px; border-radius: 3px; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 13px; flex-shrink: 0; }
.new-icon { background: var(--badge-new); color: #3fb950; }
.mod-icon { background: var(--badge-mod); color: #d29922; }
.file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-size { font-size: 11px; opacity: 0.5; white-space: nowrap; }
.file-diff { font-size: 11px; opacity: 0.5; white-space: nowrap; min-width: 70px; text-align: right; }
.btn-open { background: none; border: none; cursor: pointer; font-size: 13px; opacity: 0.4; padding: 2px 4px; }
.btn-open:hover { opacity: 1; }
.btn-exclude { background: none; border: none; cursor: pointer; font-size: 11px; opacity: 0.3; padding: 2px 4px; color: var(--vscode-errorForeground, #f85149); }
.btn-exclude:hover { opacity: 1; }
.btn-exclude-dir { margin-left: auto; background: none; border: 1px solid transparent; border-radius: 3px; cursor: pointer; font-size: 10px; opacity: 0.4; padding: 2px 6px; color: var(--vscode-errorForeground, #f85149); }
.btn-exclude-dir:hover { opacity: 1; border-color: var(--vscode-errorForeground, #f85149); }
.overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 100; align-items: center; justify-content: center; flex-direction: column; gap: 12px; }
.overlay.active { display: flex; }
.overlay .spinner { border: 4px solid var(--border); border-top-color: var(--accent); border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.empty { padding: 40px; text-align: center; opacity: 0.5; }
</style>
</head>
<body>

<div class="header">
    <h1>${T['sync.title']}</h1>
    <div class="stats">
        <div class="stat"><div class="stat-value">${totalNew}</div><div class="stat-label">${T['sync.newFiles']}</div></div>
        <div class="stat"><div class="stat-value">${totalMod}</div><div class="stat-label">${T['sync.modifiedFiles']}</div></div>
        <div class="stat"><div class="stat-value">${data.identical_count}</div><div class="stat-label">${T['sync.synced']}</div></div>
        <div class="stat"><div class="stat-value">${formatSize(totalSize)}</div><div class="stat-label">${T['sync.totalSize']}</div></div>
    </div>
</div>

<div class="toolbar">
    <button class="btn btn-refresh" onclick="refresh()">${T['sync.rescan']}</button>
    <span class="toolbar-sep"></span>
    <button class="btn" onclick="selectAll()">${T['sync.selectAll']}</button>
    <button class="btn" onclick="deselectAll()">${T['sync.deselectAll']}</button>
    <button class="btn" onclick="selectNew()">${T['sync.newOnly']}</button>
    <button class="btn" onclick="selectMod()">${T['sync.modifiedOnly']}</button>
    <span class="selection-info" id="selectionInfo">${t('sync.filesSelected', totalFiles)}</span>
    <button class="btn btn-primary" id="copyBtn" onclick="copySelected()">${t('sync.copySelected', totalFiles)}</button>
</div>

${totalNew > 0 ? `
<div class="section">
    <div class="section-title">${T['sync.newFilesSection']} <span class="section-badge new-badge">${totalNew}</span></div>
    ${newSectionsHtml}
</div>` : ''}

${totalMod > 0 ? `
<div class="section">
    <div class="section-title">${T['sync.modifiedFilesSection']} <span class="section-badge mod-badge">${totalMod}</span></div>
    ${modSectionsHtml}
</div>` : ''}

${totalFiles === 0 ? `<div class="empty">${T['sync.allSynced']}</div>` : ''}

<div class="overlay" id="overlay">
    <div class="spinner"></div>
    <span id="overlayText">${T['sync.copying']}</span>
</div>

<script>
const vscode = acquireVsCodeApi();
const T = ${JSON.stringify(T).replace(/</g, '\\u003c')};
function tr(key, ...args) {
    let s = T[key] || key;
    for (let i = 0; i < args.length; i++) s = s.replace('{' + i + '}', args[i]);
    return s;
}

function getCheckedFiles() {
    return [...document.querySelectorAll('.file-checkbox:checked')].map(cb => cb.value);
}

function updateSelectionInfo() {
    const checked = getCheckedFiles();
    document.getElementById('selectionInfo').textContent = tr('sync.filesSelected', checked.length);
    const btn = document.getElementById('copyBtn');
    btn.textContent = tr('sync.copySelected', checked.length);
    btn.disabled = checked.length === 0;
}

function selectAll() { document.querySelectorAll('.file-checkbox, .dir-checkbox').forEach(cb => cb.checked = true); updateSelectionInfo(); }
function deselectAll() { document.querySelectorAll('.file-checkbox, .dir-checkbox').forEach(cb => cb.checked = false); updateSelectionInfo(); }
function selectNew() { document.querySelectorAll('.file-checkbox').forEach(cb => { cb.checked = cb.dataset.type === 'new'; }); document.querySelectorAll('.dir-checkbox').forEach(cb => { cb.checked = cb.dataset.type === 'new'; }); updateSelectionInfo(); }
function selectMod() { document.querySelectorAll('.file-checkbox').forEach(cb => { cb.checked = cb.dataset.type === 'mod'; }); document.querySelectorAll('.dir-checkbox').forEach(cb => { cb.checked = cb.dataset.type === 'mod'; }); updateSelectionInfo(); }

function toggleDir(header) { const files = header.nextElementSibling; const arrow = header.querySelector('.arrow'); files.classList.toggle('hidden'); arrow.classList.toggle('collapsed'); }
function toggleDirFiles(dirCb) { const filesDiv = dirCb.closest('.dir-header').nextElementSibling; filesDiv.querySelectorAll('.file-checkbox').forEach(cb => { cb.checked = dirCb.checked; }); updateSelectionInfo(); event.stopPropagation(); }

document.addEventListener('change', (e) => {
    if (e.target.classList.contains('file-checkbox')) {
        updateSelectionInfo();
        const dirFiles = e.target.closest('.dir-files');
        if (dirFiles) {
            const dirHeader = dirFiles.previousElementSibling;
            const dirCb = dirHeader.querySelector('.dir-checkbox');
            const allFiles = dirFiles.querySelectorAll('.file-checkbox');
            const allChecked = [...allFiles].every(cb => cb.checked);
            const someChecked = [...allFiles].some(cb => cb.checked);
            dirCb.checked = allChecked;
            dirCb.indeterminate = someChecked && !allChecked;
        }
    }
});

function copySelected() { const files = getCheckedFiles(); if (files.length === 0) return; vscode.postMessage({ command: 'copy', files }); }
function refresh() { vscode.postMessage({ command: 'refresh' }); }
function openFile(file) { vscode.postMessage({ command: 'openFile', file }); }
function diffFile(file) { vscode.postMessage({ command: 'diffFile', file }); }
function excludeFile(file) { vscode.postMessage({ command: 'excludeFile', file }); }
function excludeDir(dir) { vscode.postMessage({ command: 'excludeDir', dir }); }

window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.command === 'copying') {
        document.getElementById('overlay').classList.add('active');
        document.getElementById('overlayText').textContent = tr('sync.copyingN', msg.count);
    } else if (msg.command === 'excluded') {
        if (msg.type === 'file') {
            const row = document.querySelector('.file-row[data-file="' + CSS.escape(msg.value) + '"]');
            if (row) { row.remove(); }
        } else if (msg.type === 'dir') {
            document.querySelectorAll('.dir-header').forEach(header => {
                const nameEl = header.querySelector('.dir-name');
                if (nameEl && (nameEl.textContent === msg.value || nameEl.textContent.startsWith(msg.value + '/'))) {
                    header.closest('.dir-group').remove();
                }
            });
        }
        updateSelectionInfo();
    } else if (msg.command === 'copyResult') {
        document.getElementById('overlay').classList.remove('active');
        if (msg.result.copied && msg.result.copied.length > 0) {
            msg.result.copied.forEach(f => {
                const cb = document.querySelector('.file-checkbox[value="' + CSS.escape(f) + '"]');
                if (cb) {
                    const row = cb.closest('.file-row');
                    row.style.opacity = '0.4';
                    row.style.textDecoration = 'line-through';
                    cb.checked = false;
                    cb.disabled = true;
                }
            });
            updateSelectionInfo();
        }
    }
});
</script>
</body></html>`;
}

function escapeJs(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function groupBy<T>(arr: T[], keyFn: (item: T) => string): Record<string, T[]> {
    const result: Record<string, T[]> = {};
    for (const item of arr) {
        const key = keyFn(item);
        if (!result[key]) { result[key] = []; }
        result[key].push(item);
    }
    return result;
}
