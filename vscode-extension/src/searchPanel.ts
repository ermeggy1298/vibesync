/**
 * VibeSync Search Panel
 * WebviewPanel per cercare nelle chat di Claude Code e organizzarle in progetti.
 *
 * Vista Ricerca: full-text search via vibesync_search.py --json
 * Vista Progetti: organizzazione chat in progetti personalizzati (chat_projects.json)
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as lockManager from './lockManager';
import { t, getWebviewTranslations } from './i18n';

// ---------------------------------------------------------------------------
// Tipi
// ---------------------------------------------------------------------------

interface SearchResult {
    project: string;
    session_id: string;
    slug: string;
    type: 'user' | 'assistant';
    timestamp: string;
    preview: string;
    file: string;
}

interface ChatSummary {
    session_id: string;
    slug: string;
    project: string;
    first_timestamp: string;
    last_timestamp: string;
    message_count: number;
    first_user_message: string;
    file: string;
}

interface Project {
    id: string;
    name: string;
    color: string;
    created_at: string;
}

interface ChatMeta {
    title?: string;
    description?: string;
}

interface ChatProjectsData {
    projects: Project[];
    assignments: Record<string, string[]>;
    chat_meta?: Record<string, ChatMeta>;
    hidden_chats?: string[];
}

// ---------------------------------------------------------------------------
// Storage progetti
// ---------------------------------------------------------------------------

const PROJECTS_PATH = path.join(os.homedir(), '.vibesync', 'chat_projects.json');

const PROJECT_COLORS = [
    '#667eea', '#2dd4bf', '#4facfe', '#fa709a',
    '#fee140', '#f093fb', '#ff6b6b', '#51cf66',
];

function loadProjects(): ChatProjectsData {
    try {
        const raw = fs.readFileSync(PROJECTS_PATH, 'utf-8');
        const data = JSON.parse(raw);
        if (!data.chat_meta) { data.chat_meta = {}; }
        if (!data.hidden_chats) { data.hidden_chats = []; }
        return data;
    } catch {
        return { projects: [], assignments: {}, chat_meta: {}, hidden_chats: [] };
    }
}

function saveProjects(data: ChatProjectsData): void {
    try {
        fs.mkdirSync(path.dirname(PROJECTS_PATH), { recursive: true });
        fs.writeFileSync(PROJECTS_PATH, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err: any) {
        vscode.window.showErrorMessage(t('search.saveError', err.message));
    }
}

// ---------------------------------------------------------------------------
// Python path helpers
// ---------------------------------------------------------------------------

function getPythonPath(): string {
    return vscode.workspace.getConfiguration('vibesync').get<string>('pythonPath') || 'python';
}

function getSearchScriptPath(): string {
    const config = lockManager.getConfig();
    if (config?.local_root) {
        return path.join(config.local_root, 'vibesync', 'vibesync_search.py');
    }
    // Fallback: cerca relativo al workspace
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws) { return path.join(ws, 'vibesync', 'vibesync_search.py'); }
    return 'vibesync_search.py';
}

// ---------------------------------------------------------------------------
// Chiamate Python
// ---------------------------------------------------------------------------

function runSearch(keyword: string, projectFilter?: string, msgFilter?: string): Promise<SearchResult[]> {
    return new Promise((resolve) => {
        const args = [getSearchScriptPath(), '--json', '--max', '100', keyword];
        if (projectFilter && projectFilter !== 'all') { args.push('--project', projectFilter); }
        if (msgFilter === 'user') { args.push('--user-only'); }
        if (msgFilter === 'assistant') { args.push('--assistant-only'); }

        const proc = cp.spawn(getPythonPath(), args);
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('close', () => {
            try { resolve(JSON.parse(stdout.trim())); }
            catch { resolve([]); }
        });
        proc.on('error', () => resolve([]));
        setTimeout(() => proc.kill(), 30000);
    });
}

function runListAll(): Promise<ChatSummary[]> {
    return new Promise((resolve) => {
        const args = [getSearchScriptPath(), '--list-all', '--json'];
        const proc = cp.spawn(getPythonPath(), args);
        let stdout = '';

        proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.on('close', () => {
            try { resolve(JSON.parse(stdout.trim())); }
            catch { resolve([]); }
        });
        proc.on('error', () => resolve([]));
        setTimeout(() => proc.kill(), 60000);
    });
}

// ---------------------------------------------------------------------------
// Panel singleton
// ---------------------------------------------------------------------------

let currentPanel: vscode.WebviewPanel | undefined;

export function showSearchPanel(initialView: 'search' | 'projects' = 'search'): void {
    if (currentPanel) {
        currentPanel.reveal();
        currentPanel.webview.postMessage({ command: 'switchView', view: initialView });
        return;
    }

    currentPanel = vscode.window.createWebviewPanel(
        'vibesyncSearch',
        'VibeSync — Chat',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    currentPanel.onDidDispose(() => { currentPanel = undefined; });

    // HTML iniziale
    currentPanel.webview.html = getPanelHtml(initialView);

    // Gestione messaggi dal webview
    currentPanel.webview.onDidReceiveMessage(async (msg) => {
        switch (msg.command) {

            // ── Ricerca ──────────────────────────────────────────────────────
            case 'search': {
                currentPanel?.webview.postMessage({ command: 'searching' });
                const results = await runSearch(msg.keyword, msg.project, msg.filter);
                const projectsData = loadProjects();
                currentPanel?.webview.postMessage({
                    command: 'searchResults',
                    results,
                    keyword: msg.keyword,
                    projects: projectsData.projects,
                    assignments: projectsData.assignments,
                    chatMeta: projectsData.chat_meta,
                    hiddenChats: projectsData.hidden_chats,
                });
                break;
            }

            case 'resumeChat': {
                const terminal = vscode.window.createTerminal({ name: 'Claude Code' });
                terminal.show();
                terminal.sendText(`claude --resume "${msg.sessionId}"`);
                break;
            }

            // ── Progetti ─────────────────────────────────────────────────────
            case 'loadProjects': {
                currentPanel?.webview.postMessage({ command: 'loadingProjects' });
                const [chats, projectsData] = await Promise.all([
                    runListAll(),
                    Promise.resolve(loadProjects()),
                ]);
                currentPanel?.webview.postMessage({
                    command: 'projectsData',
                    projects: projectsData.projects,
                    assignments: projectsData.assignments,
                    chatMeta: projectsData.chat_meta,
                    hiddenChats: projectsData.hidden_chats,
                    chats,
                });
                break;
            }

            case 'createProject': {
                const data = loadProjects();
                const newProject: Project = {
                    id: `proj_${Date.now()}`,
                    name: msg.name,
                    color: msg.color || PROJECT_COLORS[data.projects.length % PROJECT_COLORS.length],
                    created_at: new Date().toISOString(),
                };
                data.projects.push(newProject);
                saveProjects(data);
                currentPanel?.webview.postMessage({
                    command: 'projectCreated',
                    project: newProject,
                    projects: data.projects,
                    assignments: data.assignments,
                });
                break;
            }

            case 'renameProject': {
                const data = loadProjects();
                const proj = data.projects.find(p => p.id === msg.projectId);
                if (proj) {
                    proj.name = msg.newName;
                    saveProjects(data);
                }
                currentPanel?.webview.postMessage({
                    command: 'projectsUpdated',
                    projects: data.projects,
                    assignments: data.assignments,
                });
                break;
            }

            case 'deleteProject': {
                const data = loadProjects();
                data.projects = data.projects.filter(p => p.id !== msg.projectId);
                // Rimuovi dalle assegnazioni
                for (const sid of Object.keys(data.assignments)) {
                    data.assignments[sid] = data.assignments[sid].filter(pid => pid !== msg.projectId);
                    if (data.assignments[sid].length === 0) { delete data.assignments[sid]; }
                }
                saveProjects(data);
                currentPanel?.webview.postMessage({
                    command: 'projectsUpdated',
                    projects: data.projects,
                    assignments: data.assignments,
                });
                break;
            }

            case 'changeProjectColor': {
                const data = loadProjects();
                const proj = data.projects.find(p => p.id === msg.projectId);
                if (proj) {
                    proj.color = msg.color;
                    saveProjects(data);
                }
                currentPanel?.webview.postMessage({
                    command: 'projectsUpdated',
                    projects: data.projects,
                    assignments: data.assignments,
                });
                break;
            }

            case 'assignChat': {
                const data = loadProjects();
                if (!data.assignments[msg.sessionId]) { data.assignments[msg.sessionId] = []; }
                if (!data.assignments[msg.sessionId].includes(msg.projectId)) {
                    data.assignments[msg.sessionId].push(msg.projectId);
                    saveProjects(data);
                }
                currentPanel?.webview.postMessage({
                    command: 'assignmentUpdated',
                    sessionId: msg.sessionId,
                    assignments: data.assignments,
                    projects: data.projects,
                });
                break;
            }

            case 'unassignChat': {
                const data = loadProjects();
                if (data.assignments[msg.sessionId]) {
                    data.assignments[msg.sessionId] = data.assignments[msg.sessionId]
                        .filter(pid => pid !== msg.projectId);
                    if (data.assignments[msg.sessionId].length === 0) {
                        delete data.assignments[msg.sessionId];
                    }
                    saveProjects(data);
                }
                currentPanel?.webview.postMessage({
                    command: 'assignmentUpdated',
                    sessionId: msg.sessionId,
                    assignments: data.assignments,
                    projects: data.projects,
                });
                break;
            }

            // ── Prompt/Confirm via VS Code API ──────────────────────────────
            case 'promptNewProject': {
                const name = await vscode.window.showInputBox({
                    prompt: t('search.promptNewProject'),
                    placeHolder: t('search.promptNewProjectPlaceholder'),
                });
                if (!name || !name.trim()) { break; }
                // Crea progetto e assegna la chat
                const data = loadProjects();
                const newProject: Project = {
                    id: `proj_${Date.now()}`,
                    name: name.trim(),
                    color: PROJECT_COLORS[data.projects.length % PROJECT_COLORS.length],
                    created_at: new Date().toISOString(),
                };
                data.projects.push(newProject);
                if (msg.sessionId) {
                    if (!data.assignments[msg.sessionId]) { data.assignments[msg.sessionId] = []; }
                    data.assignments[msg.sessionId].push(newProject.id);
                }
                saveProjects(data);
                currentPanel?.webview.postMessage({
                    command: 'projectCreated',
                    project: newProject,
                    projects: data.projects,
                    assignments: data.assignments,
                });
                break;
            }

            case 'promptRenameProject': {
                const newName = await vscode.window.showInputBox({
                    prompt: t('search.promptRename'),
                    value: msg.currentName,
                });
                if (!newName || !newName.trim() || newName.trim() === msg.currentName) { break; }
                const data = loadProjects();
                const proj = data.projects.find(p => p.id === msg.projectId);
                if (proj) {
                    proj.name = newName.trim();
                    saveProjects(data);
                }
                currentPanel?.webview.postMessage({
                    command: 'projectsUpdated',
                    projects: data.projects,
                    assignments: data.assignments,
                });
                break;
            }

            case 'confirmDeleteProject': {
                const deleteLabel = t('search.delete');
                const answer = await vscode.window.showWarningMessage(
                    t('search.confirmDelete', msg.name),
                    { modal: true },
                    deleteLabel
                );
                if (answer !== deleteLabel) { break; }
                const data = loadProjects();
                data.projects = data.projects.filter(p => p.id !== msg.projectId);
                for (const sid of Object.keys(data.assignments)) {
                    data.assignments[sid] = data.assignments[sid].filter(pid => pid !== msg.projectId);
                    if (data.assignments[sid].length === 0) { delete data.assignments[sid]; }
                }
                saveProjects(data);
                currentPanel?.webview.postMessage({
                    command: 'projectsUpdated',
                    projects: data.projects,
                    assignments: data.assignments,
                });
                break;
            }

            case 'saveChatMeta': {
                const data = loadProjects();
                if (!data.chat_meta) { data.chat_meta = {}; }
                if (msg.title && msg.title.trim()) {
                    data.chat_meta[msg.sessionId] = {
                        title: msg.title.trim(),
                        description: (msg.description || '').trim().substring(0, 50) || undefined,
                    };
                } else {
                    delete data.chat_meta[msg.sessionId];
                }
                saveProjects(data);
                currentPanel?.webview.postMessage({
                    command: 'chatMetaUpdated',
                    sessionId: msg.sessionId,
                    chatMeta: data.chat_meta,
                });
                break;
            }

            case 'hideChat': {
                const data = loadProjects();
                if (!data.hidden_chats) { data.hidden_chats = []; }
                if (!data.hidden_chats.includes(msg.sessionId)) {
                    data.hidden_chats.push(msg.sessionId);
                    saveProjects(data);
                }
                currentPanel?.webview.postMessage({
                    command: 'chatHidden',
                    sessionId: msg.sessionId,
                    hiddenChats: data.hidden_chats,
                });
                break;
            }

            case 'unhideChat': {
                const data = loadProjects();
                if (data.hidden_chats) {
                    data.hidden_chats = data.hidden_chats.filter(id => id !== msg.sessionId);
                    saveProjects(data);
                }
                currentPanel?.webview.postMessage({
                    command: 'chatUnhidden',
                    sessionId: msg.sessionId,
                    hiddenChats: data.hidden_chats || [],
                });
                break;
            }

            case 'confirmDeleteChat': {
                const deleteLabel = t('search.delete');
                const chatTitle = msg.title || msg.slug || msg.sessionId;
                const answer = await vscode.window.showWarningMessage(
                    t('search.confirmDeleteChat', chatTitle),
                    { modal: true },
                    deleteLabel
                );
                if (answer !== deleteLabel) { break; }

                // Delete the .jsonl file
                if (msg.file && fs.existsSync(msg.file)) {
                    try {
                        fs.unlinkSync(msg.file);
                    } catch (err: any) {
                        vscode.window.showErrorMessage(t('search.saveError', err.message));
                        break;
                    }
                }

                // Clean up metadata
                const data = loadProjects();
                if (data.chat_meta) { delete data.chat_meta[msg.sessionId]; }
                if (data.assignments) { delete data.assignments[msg.sessionId]; }
                if (data.hidden_chats) {
                    data.hidden_chats = data.hidden_chats.filter(id => id !== msg.sessionId);
                }
                saveProjects(data);

                currentPanel?.webview.postMessage({
                    command: 'chatDeleted',
                    sessionId: msg.sessionId,
                });
                break;
            }
        }
    });
}

// ---------------------------------------------------------------------------
// HTML del pannello
// ---------------------------------------------------------------------------

function getPanelHtml(initialView: 'search' | 'projects'): string {
    const T = getWebviewTranslations();
    const TJson = JSON.stringify(T).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="${T['search.msgAll'] === 'All' ? 'en' : 'it'}">
<head>
<meta charset="UTF-8">
<style>
:root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-foreground);
    --border: var(--vscode-widget-border, #444);
    --accent: var(--vscode-focusBorder, #007acc);
    --hover: var(--vscode-list-hoverBackground, #2a2d2e);
    --input-bg: var(--vscode-input-background, #3c3c3c);
    --input-fg: var(--vscode-input-foreground);
    --badge-h: 22px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
    font-size: 13px;
    color: var(--fg);
    background: var(--bg);
}

/* ── Tab bar ────────────────────────────────────────────────────────────── */
.tab-bar {
    display: flex;
    border-bottom: 1px solid var(--border);
    padding: 0 16px;
    background: var(--bg);
    position: sticky;
    top: 0;
    z-index: 10;
}
.tab {
    padding: 10px 20px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    font-weight: 500;
    color: var(--fg);
    opacity: 0.6;
    transition: all 0.15s;
    user-select: none;
}
.tab:hover { opacity: 0.9; }
.tab.active { border-bottom-color: var(--accent); opacity: 1; color: var(--accent); }

/* ── Views ──────────────────────────────────────────────────────────────── */
.view { display: none; }
.view.active { display: block; }

/* ── Search view ────────────────────────────────────────────────────────── */
.search-bar {
    padding: 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.search-row {
    display: flex;
    gap: 8px;
}
.search-input {
    flex: 1;
    padding: 6px 10px;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 13px;
    outline: none;
}
.search-input:focus { border-color: var(--accent); }
.filters-row {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
    font-size: 12px;
}
.filter-label { opacity: 0.7; }
select.filter-select {
    background: var(--input-bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 3px 6px;
    font-size: 12px;
}
.radio-group { display: flex; gap: 10px; }
.radio-group label { display: flex; align-items: center; gap: 4px; cursor: pointer; opacity: 0.8; }
.radio-group label:hover { opacity: 1; }

/* ── Bottoni ────────────────────────────────────────────────────────────── */
.btn {
    padding: 5px 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--hover);
    color: var(--fg);
    cursor: pointer;
    font-size: 12px;
    white-space: nowrap;
}
.btn:hover { border-color: var(--accent); }
.btn-primary {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
    font-weight: 600;
}
.btn-primary:hover { opacity: 0.85; }
.btn-sm { padding: 3px 8px; font-size: 11px; }
.btn-icon {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--fg);
    opacity: 0.5;
    padding: 2px 5px;
    font-size: 13px;
}
.btn-icon:hover { opacity: 1; }
.btn-danger-icon { color: var(--vscode-errorForeground, #f85149); }
.btn-danger-icon:hover { opacity: 1; color: var(--vscode-errorForeground, #f85149); }

/* ── Risultati ricerca ───────────────────────────────────────────────────── */
.results-header {
    padding: 10px 16px;
    font-size: 12px;
    opacity: 0.6;
    border-bottom: 1px solid var(--border);
}
.results-list { padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; }

/* ── Card sessione ───────────────────────────────────────────────────────── */
.session-card {
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
}
.session-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--hover);
    flex-wrap: wrap;
}
.session-slug {
    font-weight: 600;
    font-size: 13px;
}
.session-title-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    flex: 1;
    min-width: 0;
}
.session-desc {
    font-size: 11px;
    opacity: 0.55;
    font-style: italic;
    margin-top: 1px;
}
.edit-meta-form {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 8px 12px;
    border-top: 1px solid var(--border);
    background: var(--hover);
}
.edit-meta-form input {
    padding: 4px 8px;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--accent);
    border-radius: 4px;
    font-size: 12px;
    outline: none;
}
.edit-meta-form .edit-meta-row {
    display: flex;
    gap: 6px;
    align-items: center;
}
.edit-meta-form .edit-meta-label {
    font-size: 11px;
    opacity: 0.6;
    width: 70px;
    flex-shrink: 0;
}
.edit-meta-form .edit-meta-actions {
    display: flex;
    gap: 6px;
    margin-top: 2px;
}
.edit-meta-form .char-count {
    font-size: 10px;
    opacity: 0.4;
    margin-left: auto;
}
.session-meta {
    font-size: 11px;
    opacity: 0.5;
}
.session-badges { display: flex; gap: 4px; flex-wrap: wrap; margin-left: 4px; }
.session-actions { margin-left: auto; display: flex; gap: 6px; align-items: center; }

/* ── Badge progetto ─────────────────────────────────────────────────────── */
.proj-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 7px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 500;
    cursor: default;
    height: var(--badge-h);
}
.proj-badge .proj-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
}
.proj-badge .proj-remove {
    cursor: pointer;
    opacity: 0.5;
    font-size: 10px;
    margin-left: 2px;
    line-height: 1;
}
.proj-badge .proj-remove:hover { opacity: 1; }

/* ── Match row ──────────────────────────────────────────────────────────── */
.match-list { padding: 0; }
.match-row {
    display: flex;
    gap: 8px;
    padding: 5px 12px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    line-height: 1.5;
}
.match-ts { opacity: 0.45; white-space: nowrap; flex-shrink: 0; }
.match-role {
    font-weight: 600;
    flex-shrink: 0;
    width: 44px;
    font-size: 11px;
}
.match-role.user { color: #4facfe; }
.match-role.assistant { color: #f093fb; }
.match-preview { flex: 1; opacity: 0.85; }
.match-preview mark {
    background: rgba(255, 220, 0, 0.25);
    color: inherit;
    border-radius: 2px;
    padding: 0 2px;
}

/* ── Dropdown assegna progetto ───────────────────────────────────────────── */
.assign-dropdown {
    position: relative;
    display: inline-block;
}
.assign-menu {
    display: none;
    position: absolute;
    right: 0;
    top: 100%;
    margin-top: 4px;
    background: var(--vscode-menu-background, #252526);
    border: 1px solid var(--border);
    border-radius: 4px;
    min-width: 180px;
    z-index: 100;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
}
.assign-menu.open { display: block; }
.assign-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    cursor: pointer;
    font-size: 12px;
}
.assign-menu-item:hover { background: var(--hover); }
.assign-menu-sep { height: 1px; background: var(--border); margin: 2px 0; }
.assign-menu-new { color: var(--accent); }

/* ── Vista Progetti ─────────────────────────────────────────────────────── */
.projects-toolbar {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}
.proj-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 10px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
    transition: all 0.15s;
    user-select: none;
}
.proj-pill:hover { opacity: 0.85; }
.proj-pill.active { border-color: currentColor; }
.proj-pill .proj-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
}
.proj-pill-actions {
    margin-left: 2px;
    display: flex;
    gap: 2px;
}
.proj-pill-actions button {
    background: none;
    border: none;
    cursor: pointer;
    color: inherit;
    opacity: 0.5;
    font-size: 10px;
    padding: 1px 2px;
    line-height: 1;
}
.proj-pill-actions button:hover { opacity: 1; }

.projects-content { padding: 16px; }
.project-section { margin-bottom: 20px; }
.project-section-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
    font-weight: 600;
    font-size: 13px;
}
.project-section-count {
    font-size: 11px;
    opacity: 0.5;
    font-weight: normal;
}
.project-section-actions { margin-left: auto; display: flex; gap: 6px; }

/* ── Card chat nella vista Progetti ────────────────────────────────────── */
.chat-card {
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 8px 12px;
    margin-bottom: 6px;
    display: flex;
    gap: 10px;
    align-items: flex-start;
}
.chat-card-info { flex: 1; min-width: 0; }
.chat-slug { font-weight: 600; font-size: 12px; }
.chat-meta { font-size: 11px; opacity: 0.45; margin-top: 2px; }
.chat-preview {
    font-size: 12px;
    opacity: 0.65;
    margin-top: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.chat-card-actions { display: flex; gap: 4px; align-items: center; flex-shrink: 0; }

/* ── Collapsible senza progetto ─────────────────────────────────────────── */
.unassigned-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    padding: 6px 0;
    font-size: 12px;
    opacity: 0.6;
    user-select: none;
}
.unassigned-toggle:hover { opacity: 0.9; }
.unassigned-list { display: none; }
.unassigned-list.open { display: block; }

/* ── Inline input nuovo progetto ────────────────────────────────────────── */
.new-project-input {
    display: none;
    align-items: center;
    gap: 6px;
    padding: 4px 0;
}
.new-project-input.visible { display: flex; }
.new-project-input input {
    padding: 3px 8px;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--accent);
    border-radius: 4px;
    font-size: 12px;
    outline: none;
    width: 160px;
}

/* ── Spinner / empty ────────────────────────────────────────────────────── */
.spinner-wrap {
    display: none;
    align-items: center;
    justify-content: center;
    padding: 40px;
    gap: 12px;
}
.spinner-wrap.active { display: flex; }
.spinner {
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    width: 28px; height: 28px;
    animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.empty { padding: 40px; text-align: center; opacity: 0.4; font-size: 13px; }
</style>
</head>
<body>

<!-- Tab bar -->
<div class="tab-bar">
    <div class="tab ${initialView === 'search' ? 'active' : ''}" onclick="switchView('search')">${T['search.tabSearch']}</div>
    <div class="tab ${initialView === 'projects' ? 'active' : ''}" onclick="switchView('projects')">${T['search.tabProjects']}</div>
</div>

<!-- ═══════════════════════════════════════════════════════ VISTA RICERCA -->
<div id="view-search" class="view ${initialView === 'search' ? 'active' : ''}">
    <div class="search-bar">
        <div class="search-row">
            <input
                id="searchInput"
                class="search-input"
                type="text"
                placeholder="${T['search.placeholder']}"
                onkeydown="if(event.key==='Enter') doSearch()"
                autofocus
            />
            <button class="btn btn-primary" onclick="doSearch()">${T['search.searchBtn']}</button>
        </div>
        <div class="filters-row">
            <span class="filter-label">${T['search.projectLabel']}</span>
            <select id="projectFilter" class="filter-select">
                <option value="all">${T['search.allProjects']}</option>
                <option value="Puma-backend">Puma-backend</option>
                <option value="Puma-Tools">Puma-Tools</option>
            </select>
            <span class="filter-label">${T['search.messagesLabel']}</span>
            <div class="radio-group">
                <label><input type="radio" name="msgFilter" value="all" checked /> ${T['search.msgAll']}</label>
                <label><input type="radio" name="msgFilter" value="user" /> ${T['search.msgUser']}</label>
                <label><input type="radio" name="msgFilter" value="assistant" /> ${T['search.msgClaude']}</label>
            </div>
        </div>
    </div>

    <div id="search-spinner" class="spinner-wrap">
        <div class="spinner"></div>
        <span>${T['search.searching']}</span>
    </div>

    <div id="search-results-header" class="results-header" style="display:none"></div>
    <div id="search-results" class="results-list"></div>

    <div id="search-empty" class="empty" style="display:none">
        ${T['search.enterKeyword']}
    </div>
</div>

<!-- ══════════════════════════════════════════════════════ VISTA PROGETTI -->
<div id="view-projects" class="view ${initialView === 'projects' ? 'active' : ''}">
    <div class="projects-toolbar" id="projects-toolbar">
        <span style="opacity:0.5;font-size:12px">${T['search.loading']}</span>
    </div>
    <div id="projects-spinner" class="spinner-wrap active">
        <div class="spinner"></div>
        <span>${T['search.loadingChats']}</span>
    </div>
    <div id="projects-content" class="projects-content" style="display:none"></div>
</div>

<script>
const vscode = acquireVsCodeApi();
const T = ${TJson};
function tr(key, ...args) {
    let s = T[key] || key;
    for (let i = 0; i < args.length; i++) s = s.replace('{' + i + '}', args[i]);
    return s;
}

// ── State ──────────────────────────────────────────────────────────────────
let allProjects = [];
let allAssignments = {};
let allChatMeta = {};
let allHiddenChats = [];
let showHidden = false;
let allChats = [];
let activeProjectFilter = null;  // null = tutti

// ── View switch ────────────────────────────────────────────────────────────
function switchView(view) {
    document.querySelectorAll('.tab').forEach((t, i) => {
        t.classList.toggle('active', (i === 0 && view === 'search') || (i === 1 && view === 'projects'));
    });
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + view).classList.add('active');
    if (view === 'projects') { loadProjects(); }
}

// ── Ricerca ────────────────────────────────────────────────────────────────
function doSearch() {
    const keyword = document.getElementById('searchInput').value.trim();
    if (!keyword) {
        document.getElementById('search-empty').style.display = 'block';
        document.getElementById('search-empty').textContent = tr('search.enterKeywordToSearch');
        return;
    }

    const projectFilter = document.getElementById('projectFilter').value;
    const msgFilter = document.querySelector('input[name="msgFilter"]:checked').value;

    document.getElementById('search-spinner').classList.add('active');
    document.getElementById('search-results-header').style.display = 'none';
    document.getElementById('search-results').innerHTML = '';
    document.getElementById('search-empty').style.display = 'none';

    vscode.postMessage({ command: 'search', keyword, project: projectFilter, filter: msgFilter });
}

function renderSearchResults(results, keyword, projects, assignments, chatMeta, hiddenChats) {
    document.getElementById('search-spinner').classList.remove('active');

    if (!results || results.length === 0) {
        document.getElementById('search-results-header').style.display = 'none';
        document.getElementById('search-empty').style.display = 'block';
        document.getElementById('search-empty').textContent = tr('search.noResults', keyword);
        return;
    }

    // Aggiorna state globale
    allProjects = projects || [];
    allAssignments = assignments || {};
    allChatMeta = chatMeta || {};
    allHiddenChats = hiddenChats || [];

    // Raggruppa per sessione
    const sessions = {};
    for (const r of results) {
        const key = r.session_id || r.file;
        if (!sessions[key]) {
            sessions[key] = { slug: r.slug, project: r.project, session_id: r.session_id, matches: [] };
        }
        sessions[key].matches.push(r);
    }

    const sessionList = Object.values(sessions);
    // Filter out hidden chats
    const visibleSessions = sessionList.filter(s => !allHiddenChats.includes(s.session_id));
    const hiddenCount = sessionList.length - visibleSessions.length;

    document.getElementById('search-results-header').style.display = 'block';
    document.getElementById('search-results-header').textContent =
        tr('search.resultsCount', results.length, visibleSessions.length, keyword)
        + (hiddenCount > 0 ? '  (' + tr('search.hiddenCount', hiddenCount) + ')' : '');

    const container = document.getElementById('search-results');
    container.innerHTML = '';

    for (const session of visibleSessions) {
        container.appendChild(buildSessionCard(session, keyword, false));
    }
}

function buildSessionCard(session, keyword, isProjectView) {
    const sid = session.session_id || '';
    const assignedProjects = (allAssignments[sid] || [])
        .map(pid => allProjects.find(p => p.id === pid))
        .filter(Boolean);

    // Header
    const card = document.createElement('div');
    card.className = 'session-card';
    card.dataset.sessionId = sid;

    const header = document.createElement('div');
    header.className = 'session-header';

    const meta = allChatMeta[sid] || {};
    const displayTitle = meta.title || session.slug || tr('search.noName');

    const titleWrap = document.createElement('div');
    titleWrap.className = 'session-title-wrap';
    titleWrap.id = 'title-wrap-' + sid;

    const slugEl = document.createElement('span');
    slugEl.className = 'session-slug';
    slugEl.textContent = displayTitle;
    titleWrap.appendChild(slugEl);

    if (meta.title) {
        const origSlug = document.createElement('span');
        origSlug.className = 'session-meta';
        origSlug.textContent = session.slug || '';
        origSlug.style.marginLeft = '6px';
        titleWrap.appendChild(origSlug);
    }

    if (meta.description) {
        const descEl = document.createElement('span');
        descEl.className = 'session-desc';
        descEl.textContent = meta.description;
        titleWrap.appendChild(descEl);
    }

    // Bottone edit titolo
    const editBtn = document.createElement('button');
    editBtn.className = 'btn-icon';
    editBtn.textContent = '✏';
    editBtn.title = tr('search.editMeta');
    editBtn.onclick = (e) => {
        e.stopPropagation();
        showEditMetaForm(card, sid, session.slug, meta.title || '', meta.description || '');
    };
    titleWrap.appendChild(editBtn);

    header.appendChild(titleWrap);

    const metaEl = document.createElement('span');
    metaEl.className = 'session-meta';
    metaEl.textContent = session.project || '';
    header.appendChild(metaEl);

    // Badge progetti assegnati
    const badges = document.createElement('div');
    badges.className = 'session-badges';
    badges.id = 'badges-' + sid;
    for (const proj of assignedProjects) {
        badges.appendChild(buildProjBadge(proj, sid, !isProjectView));
    }
    header.appendChild(badges);

    // Azioni
    const actions = document.createElement('div');
    actions.className = 'session-actions';

    // Bottone riprendi
    const resumeBtn = document.createElement('button');
    resumeBtn.className = 'btn btn-sm';
    resumeBtn.textContent = tr('search.resumeChat');
    resumeBtn.onclick = () => vscode.postMessage({ command: 'resumeChat', sessionId: sid, slug: session.slug });
    actions.appendChild(resumeBtn);

    // Dropdown assegna progetto
    if (allProjects.length > 0 || true) {
        const dropdown = buildAssignDropdown(sid);
        actions.appendChild(dropdown);
    }

    // Hide button
    const hideBtn = document.createElement('button');
    hideBtn.className = 'btn-icon';
    hideBtn.innerHTML = '&#128065;&#8416;';
    hideBtn.title = tr('search.hideChat');
    hideBtn.style.fontSize = '12px';
    hideBtn.onclick = (e) => {
        e.stopPropagation();
        vscode.postMessage({ command: 'hideChat', sessionId: sid });
    };
    actions.appendChild(hideBtn);

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-icon btn-danger-icon';
    deleteBtn.innerHTML = '&#128465;';
    deleteBtn.title = tr('search.deleteChat');
    deleteBtn.style.fontSize = '13px';
    deleteBtn.onclick = (e) => {
        e.stopPropagation();
        const title = (allChatMeta[sid] || {}).title || session.slug || sid;
        const file = session.file || (session.matches && session.matches[0] ? session.matches[0].file : '');
        vscode.postMessage({ command: 'confirmDeleteChat', sessionId: sid, title, slug: session.slug, file });
    };
    actions.appendChild(deleteBtn);

    header.appendChild(actions);
    card.appendChild(header);

    // Match list (solo in vista ricerca)
    if (!isProjectView && session.matches) {
        const matchList = document.createElement('div');
        matchList.className = 'match-list';
        for (const m of session.matches) {
            matchList.appendChild(buildMatchRow(m, keyword));
        }
        card.appendChild(matchList);
    } else if (isProjectView && session.first_user_message) {
        const preview = document.createElement('div');
        preview.style.cssText = 'padding:6px 12px;font-size:12px;opacity:0.6;border-top:1px solid var(--border);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        preview.textContent = session.first_user_message;
        card.appendChild(preview);
    }

    return card;
}

function buildMatchRow(match, keyword) {
    const row = document.createElement('div');
    row.className = 'match-row';

    const ts = document.createElement('span');
    ts.className = 'match-ts';
    ts.textContent = formatTs(match.timestamp);
    row.appendChild(ts);

    const role = document.createElement('span');
    role.className = 'match-role ' + match.type;
    role.textContent = match.type === 'user' ? 'USER' : 'CLAUDE';
    row.appendChild(role);

    const preview = document.createElement('span');
    preview.className = 'match-preview';
    preview.innerHTML = highlightKeyword(escHtml(match.preview), keyword);
    row.appendChild(preview);

    return row;
}

function buildProjBadge(proj, sessionId, showRemove) {
    const badge = document.createElement('span');
    badge.className = 'proj-badge';
    badge.style.background = proj.color + '22';
    badge.style.color = proj.color;
    badge.style.border = '1px solid ' + proj.color + '44';

    const dot = document.createElement('span');
    dot.className = 'proj-dot';
    dot.style.background = proj.color;
    badge.appendChild(dot);

    badge.appendChild(document.createTextNode(proj.name));

    if (showRemove) {
        const removeBtn = document.createElement('span');
        removeBtn.className = 'proj-remove';
        removeBtn.textContent = '×';
        removeBtn.title = tr('search.removeFromProject');
        removeBtn.onclick = (e) => {
            e.stopPropagation();
            vscode.postMessage({ command: 'unassignChat', sessionId, projectId: proj.id });
        };
        badge.appendChild(removeBtn);
    }

    return badge;
}

function buildAssignDropdown(sessionId) {
    const wrap = document.createElement('div');
    wrap.className = 'assign-dropdown';

    const btn = document.createElement('button');
    btn.className = 'btn btn-sm';
    btn.textContent = tr('search.projectBtn');
    btn.onclick = (e) => {
        e.stopPropagation();
        const menu = wrap.querySelector('.assign-menu');
        document.querySelectorAll('.assign-menu.open').forEach(m => { if (m !== menu) m.classList.remove('open'); });
        menu.classList.toggle('open');
    };
    wrap.appendChild(btn);

    const menu = document.createElement('div');
    menu.className = 'assign-menu';
    menu.innerHTML = buildAssignMenuItems(sessionId);
    wrap.appendChild(menu);

    return wrap;
}

function buildAssignMenuItems(sessionId) {
    const assigned = allAssignments[sessionId] || [];
    let html = '';
    for (const proj of allProjects) {
        const isAssigned = assigned.includes(proj.id);
        html += '<div class="assign-menu-item" onclick="assignChat(&#39;' + sessionId + '&#39;,&#39;' + proj.id + '&#39;,' + isAssigned + ')">' +
            '<span style="width:10px;height:10px;border-radius:50%;background:' + proj.color + ';display:inline-block;flex-shrink:0"></span>' +
            '<span style="flex:1">' + escHtml(proj.name) + '</span>' +
            (isAssigned ? '<span style="opacity:0.5">✓</span>' : '') +
            '</div>';
    }
    if (allProjects.length > 0) { html += '<div class="assign-menu-sep"></div>'; }
    html += '<div class="assign-menu-item assign-menu-new" onclick="promptNewProjectFromSearch(&#39;' + sessionId + '&#39;)">' +
        '<span>' + tr('search.newProject') + '</span></div>';
    return html;
}

function assignChat(sessionId, projectId, isCurrentlyAssigned) {
    document.querySelectorAll('.assign-menu.open').forEach(m => m.classList.remove('open'));
    if (isCurrentlyAssigned) {
        vscode.postMessage({ command: 'unassignChat', sessionId, projectId });
    } else {
        vscode.postMessage({ command: 'assignChat', sessionId, projectId });
    }
}

function promptNewProjectFromSearch(sessionId) {
    document.querySelectorAll('.assign-menu.open').forEach(m => m.classList.remove('open'));
    vscode.postMessage({ command: 'promptNewProject', sessionId });
}

let pendingAssignAfterCreate = null;

// ── Progetti ───────────────────────────────────────────────────────────────
function loadProjects() {
    document.getElementById('projects-spinner').classList.add('active');
    document.getElementById('projects-content').style.display = 'none';
    vscode.postMessage({ command: 'loadProjects' });
}

function renderProjectsView(projects, assignments, chatMeta, hiddenChats, chats) {
    allProjects = projects || [];
    allAssignments = assignments || {};
    allChatMeta = chatMeta || {};
    allHiddenChats = hiddenChats || [];
    allChats = chats || [];

    document.getElementById('projects-spinner').classList.remove('active');
    document.getElementById('projects-content').style.display = 'block';

    renderProjectsToolbar();
    renderProjectsContent();
}

function renderProjectsToolbar() {
    const toolbar = document.getElementById('projects-toolbar');
    let html = '';

    for (const proj of allProjects) {
        const isActive = activeProjectFilter === proj.id;
        const count = Object.entries(allAssignments)
            .filter(([, ids]) => ids.includes(proj.id)).length;
        html += '<span class="proj-pill ' + (isActive ? 'active' : '') + '" ' +
            'style="background:' + proj.color + '18;color:' + proj.color + '" ' +
            'onclick="filterByProject(&#39;' + proj.id + '&#39;)">' +
            '<span class="proj-dot" style="background:' + proj.color + '"></span>' +
            escHtml(proj.name) +
            '<span style="opacity:0.5;font-size:10px;margin-left:3px">(' + count + ')</span>' +
            '<span class="proj-pill-actions">' +
            '<button onclick="renameProject(&#39;' + proj.id + '&#39;,&#39;' + escJs(proj.name) + '&#39;);event.stopPropagation()" title="Rinomina">✏️</button>' +
            '<button onclick="deleteProject(&#39;' + proj.id + '&#39;,&#39;' + escJs(proj.name) + '&#39;);event.stopPropagation()" title="Elimina">🗑</button>' +
            '</span>' +
            '</span>';
    }

    // Input nuovo progetto inline
    html += '<div class="new-project-input" id="new-proj-input">' +
        '<input id="new-proj-name" type="text" placeholder="' + tr('search.projectPlaceholder') + '" onkeydown="onNewProjKey(event)" />' +
        '<button class="btn btn-sm btn-primary" onclick="confirmNewProject()">' + tr('search.create') + '</button>' +
        '<button class="btn btn-sm" onclick="cancelNewProject()">' + tr('ext.cancel') + '</button>' +
        '</div>';

    html += '<button class="btn btn-sm" onclick="showNewProjectInput()" id="btn-new-proj">' + tr('search.newBtn') + '</button>';

    toolbar.innerHTML = html;
}

function renderProjectsContent() {
    const container = document.getElementById('projects-content');
    container.innerHTML = '';

    if (allProjects.length === 0) {
        container.innerHTML = '<div class="empty">' + tr('search.noProjects') + '</div>';
        return;
    }

    const projectsToShow = activeProjectFilter
        ? allProjects.filter(p => p.id === activeProjectFilter)
        : allProjects;

    for (const proj of projectsToShow) {
        const assignedSids = Object.entries(allAssignments)
            .filter(([, ids]) => ids.includes(proj.id))
            .map(([sid]) => sid);
        const assignedChats = assignedSids
            .map(sid => allChats.find(c => c.session_id === sid))
            .filter(Boolean);

        const section = document.createElement('div');
        section.className = 'project-section';

        const hdr = document.createElement('div');
        hdr.className = 'project-section-header';
        hdr.innerHTML =
            '<span style="width:12px;height:12px;border-radius:50%;background:' + proj.color + ';display:inline-block"></span>' +
            '<span>' + escHtml(proj.name) + '</span>' +
            '<span class="project-section-count">' + assignedChats.length + ' ' + tr('search.chats') + '</span>';
        section.appendChild(hdr);

        if (assignedChats.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'font-size:12px;opacity:0.4;padding:8px 0;';
            empty.textContent = tr('search.noChatsAssigned');
            section.appendChild(empty);
        } else {
            for (const chat of assignedChats) {
                section.appendChild(buildChatCard(chat, proj));
            }
        }

        container.appendChild(section);
    }

    // Sezione "Senza progetto" (collassabile) — escludi hidden
    if (!activeProjectFilter) {
        const unassignedChats = allChats.filter(
            c => (!allAssignments[c.session_id] || allAssignments[c.session_id].length === 0)
                 && !allHiddenChats.includes(c.session_id)
        );
        if (unassignedChats.length > 0) {
            const toggle = document.createElement('div');
            toggle.className = 'unassigned-toggle';
            toggle.innerHTML = '<span id="unassigned-arrow">▸</span> ' + tr('search.unassigned') + ' (' + unassignedChats.length + ')';
            toggle.onclick = toggleUnassigned;

            const list = document.createElement('div');
            list.className = 'unassigned-list';
            list.id = 'unassigned-list';
            for (const chat of unassignedChats.slice(0, 50)) {
                list.appendChild(buildChatCard(chat, null));
            }
            if (unassignedChats.length > 50) {
                const more = document.createElement('div');
                more.style.cssText = 'font-size:11px;opacity:0.4;padding:6px 0;';
                more.textContent = tr('search.andMore', unassignedChats.length - 50);
                list.appendChild(more);
            }

            container.appendChild(toggle);
            container.appendChild(list);
        }

        // Sezione "Hidden" — mostra solo se ci sono chat nascoste e il toggle è attivo
        const hiddenChats = allChats.filter(c => allHiddenChats.includes(c.session_id));
        if (hiddenChats.length > 0) {
            const hiddenToggle = document.createElement('div');
            hiddenToggle.className = 'unassigned-toggle';
            hiddenToggle.innerHTML = '<span id="hidden-arrow">' + (showHidden ? '▾' : '▸') + '</span> ' +
                tr('search.showHidden') + ' (' + hiddenChats.length + ')';
            hiddenToggle.onclick = () => {
                showHidden = !showHidden;
                document.getElementById('hidden-arrow').textContent = showHidden ? '▾' : '▸';
                document.getElementById('hidden-list').classList.toggle('open', showHidden);
            };

            const hiddenList = document.createElement('div');
            hiddenList.className = 'unassigned-list' + (showHidden ? ' open' : '');
            hiddenList.id = 'hidden-list';
            for (const chat of hiddenChats.slice(0, 50)) {
                const card = buildChatCard(chat, null);
                card.style.opacity = '0.5';
                hiddenList.appendChild(card);
            }

            container.appendChild(hiddenToggle);
            container.appendChild(hiddenList);
        }
    }
}

function buildChatCard(chat, currentProj) {
    const card = document.createElement('div');
    card.className = 'chat-card';
    card.dataset.sessionId = chat.session_id;

    const info = document.createElement('div');
    info.className = 'chat-card-info';

    const cmeta = allChatMeta[chat.session_id] || {};
    const displayTitle = cmeta.title || chat.slug || tr('search.noName');

    const titleRow = document.createElement('div');
    titleRow.style.cssText = 'display:flex;align-items:center;gap:4px;';

    const slugEl = document.createElement('div');
    slugEl.className = 'chat-slug';
    slugEl.textContent = displayTitle;
    titleRow.appendChild(slugEl);

    if (cmeta.title) {
        const origSlug = document.createElement('span');
        origSlug.className = 'chat-meta';
        origSlug.textContent = chat.slug || '';
        origSlug.style.marginTop = '0';
        titleRow.appendChild(origSlug);
    }

    const editBtn = document.createElement('button');
    editBtn.className = 'btn-icon';
    editBtn.textContent = '✏';
    editBtn.title = tr('search.editMeta');
    editBtn.style.fontSize = '11px';
    editBtn.onclick = (e) => {
        e.stopPropagation();
        showEditMetaForm(card, chat.session_id, chat.slug, cmeta.title || '', cmeta.description || '');
    };
    titleRow.appendChild(editBtn);
    info.appendChild(titleRow);

    if (cmeta.description) {
        const descEl = document.createElement('div');
        descEl.className = 'session-desc';
        descEl.textContent = cmeta.description;
        info.appendChild(descEl);
    }

    const meta = document.createElement('div');
    meta.className = 'chat-meta';
    const ts = chat.last_timestamp ? formatDate(chat.last_timestamp) : '?';
    meta.textContent = ts + '  ·  ' + chat.message_count + ' ' + tr('search.messages') + '  ·  ' + (chat.project || '');
    info.appendChild(meta);

    if (chat.first_user_message) {
        const preview = document.createElement('div');
        preview.className = 'chat-preview';
        preview.textContent = chat.first_user_message;
        info.appendChild(preview);
    }

    card.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'chat-card-actions';

    // Riprendi
    const resumeBtn = document.createElement('button');
    resumeBtn.className = 'btn btn-sm';
    resumeBtn.textContent = tr('search.resumeShort');
    resumeBtn.title = tr('search.resumeChat');
    resumeBtn.onclick = () => vscode.postMessage({
        command: 'resumeChat', sessionId: chat.session_id, slug: chat.slug
    });
    actions.appendChild(resumeBtn);

    // Dropdown assegna
    const dropdown = buildAssignDropdown(chat.session_id);
    actions.appendChild(dropdown);

    // Rimuovi dal progetto corrente
    if (currentProj) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'btn-icon';
        removeBtn.textContent = '×';
        removeBtn.title = tr('search.removeFrom', currentProj.name);
        removeBtn.onclick = () => vscode.postMessage({
            command: 'unassignChat', sessionId: chat.session_id, projectId: currentProj.id
        });
        actions.appendChild(removeBtn);
    }

    // Hide button
    const isHidden = allHiddenChats.includes(chat.session_id);
    const hideBtn = document.createElement('button');
    hideBtn.className = 'btn-icon';
    hideBtn.innerHTML = isHidden ? '&#128065;' : '&#128065;&#8416;';
    hideBtn.title = isHidden ? tr('search.unhideChat') : tr('search.hideChat');
    hideBtn.style.fontSize = '12px';
    hideBtn.onclick = (e) => {
        e.stopPropagation();
        vscode.postMessage({ command: isHidden ? 'unhideChat' : 'hideChat', sessionId: chat.session_id });
    };
    actions.appendChild(hideBtn);

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'btn-icon btn-danger-icon';
    delBtn.innerHTML = '&#128465;';
    delBtn.title = tr('search.deleteChat');
    delBtn.style.fontSize = '13px';
    delBtn.onclick = (e) => {
        e.stopPropagation();
        const title = cmeta.title || chat.slug || chat.session_id;
        vscode.postMessage({ command: 'confirmDeleteChat', sessionId: chat.session_id, title, slug: chat.slug, file: chat.file });
    };
    actions.appendChild(delBtn);

    card.appendChild(actions);
    return card;
}

function filterByProject(projectId) {
    activeProjectFilter = activeProjectFilter === projectId ? null : projectId;
    renderProjectsToolbar();
    renderProjectsContent();
}

function toggleUnassigned() {
    const list = document.getElementById('unassigned-list');
    const arrow = document.getElementById('unassigned-arrow');
    list.classList.toggle('open');
    arrow.textContent = list.classList.contains('open') ? '▾' : '▸';
}

function showNewProjectInput() {
    document.getElementById('new-proj-input').classList.add('visible');
    document.getElementById('btn-new-proj').style.display = 'none';
    setTimeout(() => document.getElementById('new-proj-name').focus(), 50);
}

function cancelNewProject() {
    document.getElementById('new-proj-input').classList.remove('visible');
    document.getElementById('btn-new-proj').style.display = '';
    document.getElementById('new-proj-name').value = '';
}

function confirmNewProject() {
    const name = document.getElementById('new-proj-name').value.trim();
    if (!name) { return; }
    vscode.postMessage({ command: 'createProject', name });
    cancelNewProject();
}

function onNewProjKey(e) {
    if (e.key === 'Enter') { confirmNewProject(); }
    if (e.key === 'Escape') { cancelNewProject(); }
}

function renameProject(projectId, currentName) {
    vscode.postMessage({ command: 'promptRenameProject', projectId, currentName });
}

function deleteProject(projectId, name) {
    vscode.postMessage({ command: 'confirmDeleteProject', projectId, name });
}

// ── Messaggi dall'estensione ───────────────────────────────────────────────
window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.command) {
        case 'switchView':
            switchView(msg.view);
            break;
        case 'searching':
            document.getElementById('search-spinner').classList.add('active');
            break;
        case 'searchResults':
            renderSearchResults(msg.results, msg.keyword, msg.projects, msg.assignments, msg.chatMeta, msg.hiddenChats);
            break;
        case 'loadingProjects':
            document.getElementById('projects-spinner').classList.add('active');
            break;
        case 'projectsData':
            renderProjectsView(msg.projects, msg.assignments, msg.chatMeta, msg.hiddenChats, msg.chats);
            break;
        case 'projectCreated':
            allProjects = msg.projects;
            allAssignments = msg.assignments;
            if (pendingAssignAfterCreate && msg.project) {
                vscode.postMessage({ command: 'assignChat', sessionId: pendingAssignAfterCreate, projectId: msg.project.id });
                pendingAssignAfterCreate = null;
            }
            // Se siamo nella vista progetti, ricarica
            if (document.getElementById('view-projects').classList.contains('active')) {
                loadProjects();
            }
            break;
        case 'projectsUpdated':
            allProjects = msg.projects;
            allAssignments = msg.assignments;
            if (document.getElementById('view-projects').classList.contains('active')) {
                renderProjectsToolbar();
                renderProjectsContent();
            }
            break;
        case 'assignmentUpdated':
            allAssignments = msg.assignments;
            allProjects = msg.projects;
            // Aggiorna badge nella vista ricerca
            updateBadgesForSession(msg.sessionId);
            // Aggiorna dropdown aperti
            document.querySelectorAll('.assign-menu.open').forEach(m => m.classList.remove('open'));
            // Se siamo nella vista progetti, ridisegna il contenuto
            if (document.getElementById('view-projects').classList.contains('active')) {
                renderProjectsToolbar();
                renderProjectsContent();
            }
            break;
        case 'chatMetaUpdated':
            allChatMeta = msg.chatMeta || {};
            if (document.getElementById('view-projects').classList.contains('active')) {
                renderProjectsContent();
            }
            updateTitleForSession(msg.sessionId);
            break;
        case 'chatHidden':
            allHiddenChats = msg.hiddenChats || [];
            // Remove from search results
            removeCardForSession(msg.sessionId);
            // Refresh projects view if active
            if (document.getElementById('view-projects').classList.contains('active')) {
                renderProjectsContent();
            }
            break;
        case 'chatUnhidden':
            allHiddenChats = msg.hiddenChats || [];
            if (document.getElementById('view-projects').classList.contains('active')) {
                renderProjectsContent();
            }
            break;
        case 'chatDeleted':
            // Remove from all state
            allChats = allChats.filter(c => c.session_id !== msg.sessionId);
            delete allChatMeta[msg.sessionId];
            delete allAssignments[msg.sessionId];
            allHiddenChats = allHiddenChats.filter(id => id !== msg.sessionId);
            removeCardForSession(msg.sessionId);
            if (document.getElementById('view-projects').classList.contains('active')) {
                renderProjectsContent();
            }
            break;
    }
});

function removeCardForSession(sessionId) {
    document.querySelectorAll('.session-card[data-session-id="' + sessionId + '"]').forEach(el => {
        el.style.transition = 'opacity 0.3s, max-height 0.3s';
        el.style.opacity = '0';
        el.style.maxHeight = '0';
        el.style.overflow = 'hidden';
        setTimeout(() => el.remove(), 300);
    });
    document.querySelectorAll('.chat-card[data-session-id="' + sessionId + '"]').forEach(el => {
        el.style.transition = 'opacity 0.3s';
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 300);
    });
}

function updateBadgesForSession(sessionId) {
    const badgesEl = document.getElementById('badges-' + sessionId);
    if (!badgesEl) { return; }
    const assignedProjects = (allAssignments[sessionId] || [])
        .map(pid => allProjects.find(p => p.id === pid))
        .filter(Boolean);
    badgesEl.innerHTML = '';
    for (const proj of assignedProjects) {
        badgesEl.appendChild(buildProjBadge(proj, sessionId, true));
    }
    // Ricostruisci anche i menu dropdown delle card in ricerca
    document.querySelectorAll('.session-card[data-session-id="' + sessionId + '"] .assign-menu').forEach(menu => {
        menu.innerHTML = buildAssignMenuItems(sessionId);
    });
}

// ── Edit Meta inline ────────────────────────────────────────────────────────
function showEditMetaForm(cardEl, sessionId, slug, currentTitle, currentDesc) {
    // Rimuovi form precedenti
    document.querySelectorAll('.edit-meta-form').forEach(f => f.remove());

    const form = document.createElement('div');
    form.className = 'edit-meta-form';

    // Riga titolo
    const titleRow = document.createElement('div');
    titleRow.className = 'edit-meta-row';
    const titleLabel = document.createElement('span');
    titleLabel.className = 'edit-meta-label';
    titleLabel.textContent = tr('search.titleLabel');
    titleRow.appendChild(titleLabel);
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.value = currentTitle;
    titleInput.placeholder = slug || tr('search.titlePlaceholder');
    titleInput.style.flex = '1';
    titleRow.appendChild(titleInput);
    form.appendChild(titleRow);

    // Riga descrizione
    const descRow = document.createElement('div');
    descRow.className = 'edit-meta-row';
    const descLabel = document.createElement('span');
    descLabel.className = 'edit-meta-label';
    descLabel.textContent = tr('search.descLabel');
    descRow.appendChild(descLabel);
    const descInput = document.createElement('input');
    descInput.type = 'text';
    descInput.value = currentDesc;
    descInput.placeholder = tr('search.descPlaceholder');
    descInput.maxLength = 50;
    descInput.style.flex = '1';
    descRow.appendChild(descInput);
    const charCount = document.createElement('span');
    charCount.className = 'char-count';
    charCount.textContent = (currentDesc || '').length + '/50';
    descRow.appendChild(charCount);
    descInput.oninput = () => { charCount.textContent = descInput.value.length + '/50'; };
    form.appendChild(descRow);

    // Bottoni
    const actionsRow = document.createElement('div');
    actionsRow.className = 'edit-meta-actions';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-sm btn-primary';
    saveBtn.textContent = tr('search.save');
    saveBtn.onclick = () => {
        vscode.postMessage({
            command: 'saveChatMeta',
            sessionId,
            title: titleInput.value,
            description: descInput.value,
        });
        form.remove();
    };
    actionsRow.appendChild(saveBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-sm';
    cancelBtn.textContent = tr('ext.cancel');
    cancelBtn.onclick = () => form.remove();
    actionsRow.appendChild(cancelBtn);

    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn btn-sm';
    clearBtn.textContent = tr('search.removeTitle');
    clearBtn.style.marginLeft = 'auto';
    clearBtn.style.opacity = '0.6';
    clearBtn.onclick = () => {
        vscode.postMessage({ command: 'saveChatMeta', sessionId, title: '', description: '' });
        form.remove();
    };
    actionsRow.appendChild(clearBtn);
    form.appendChild(actionsRow);

    cardEl.appendChild(form);
    titleInput.focus();

    // Enter per salvare, Escape per annullare
    const onKey = (e) => {
        if (e.key === 'Enter') { saveBtn.click(); }
        if (e.key === 'Escape') { form.remove(); }
    };
    titleInput.addEventListener('keydown', onKey);
    descInput.addEventListener('keydown', onKey);
}

function updateTitleForSession(sessionId) {
    const meta = allChatMeta[sessionId] || {};
    // Aggiorna nelle card di ricerca
    document.querySelectorAll('.session-card[data-session-id="' + sessionId + '"] .session-slug').forEach(el => {
        el.textContent = meta.title || el.closest('.session-card')?.querySelector('.session-meta')?.textContent?.split(' ')[0] || el.textContent;
    });
    // Aggiorna nelle chat-card (progetti)
    document.querySelectorAll('.chat-card[data-session-id="' + sessionId + '"] .chat-slug').forEach(el => {
        el.textContent = meta.title || el.textContent;
    });
}

// ── Chiudi dropdown quando si clicca fuori ─────────────────────────────────
document.addEventListener('click', () => {
    document.querySelectorAll('.assign-menu.open').forEach(m => m.classList.remove('open'));
});

// ── Utility ────────────────────────────────────────────────────────────────
function formatTs(ts) {
    if (!ts) { return ''; }
    try {
        const d = new Date(ts);
        return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
}

function formatDate(ts) {
    if (!ts) { return ''; }
    try {
        const d = new Date(ts);
        return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch { return ''; }
}

function highlightKeyword(text, keyword) {
    if (!keyword) { return text; }
    try {
        const lower = text.toLowerCase();
        const kw = keyword.toLowerCase();
        let result = '';
        let lastIdx = 0;
        let idx = lower.indexOf(kw);
        while (idx >= 0) {
            result += text.slice(lastIdx, idx) + '<mark>' + text.slice(idx, idx + kw.length) + '</mark>';
            lastIdx = idx + kw.length;
            idx = lower.indexOf(kw, lastIdx);
        }
        return result + text.slice(lastIdx);
    } catch(e) { return text; }
}

function escHtml(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escJs(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/'/g,'&#39;');
}

// Carica progetti se siamo già nella vista giusta
if (${initialView === 'projects' ? 'true' : 'false'}) {
    loadProjects();
} else {
    document.getElementById('search-empty').style.display = 'block';
}
</script>
</body>
</html>`;
}
