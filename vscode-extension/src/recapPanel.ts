/**
 * VibeSync Recap Panel
 *
 * Webview con form per generare un recap AI dei commit di un dev in un range.
 * Chiama recapEngine.generateRecap() e mostra l'HTML risultante inline.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import {
    listAuthors,
    generateRecap,
    saveRecap,
    getRecapDir,
    RECAP_MODEL_LABELS,
    RecapModel,
} from './recapEngine';

let currentPanel: vscode.WebviewPanel | undefined;
let lastRecapHtml: string | undefined;
let lastRecapMeta: { author: string; from: string; to: string; commits: number; files: number; model: string } | undefined;

export async function showRecapPanel(): Promise<void> {
    if (currentPanel) {
        currentPanel.reveal();
        return;
    }

    currentPanel = vscode.window.createWebviewPanel(
        'vibesyncRecap',
        'VibeSync — Recap AI',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
    );

    currentPanel.onDidDispose(() => {
        currentPanel = undefined;
        lastRecapHtml = undefined;
        lastRecapMeta = undefined;
    });

    // Popola autori subito (async, mentre l'utente vede lo skeleton)
    const authors = await listAuthors();
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    // Formato italiano GG/MM/AAAA per la UI. La conversione a ISO YYYY-MM-DD
    // richiesta dal backend git avviene client-side prima del postMessage.
    const fmtIt = (d: Date) => {
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    };
    const defaultFrom = fmtIt(weekAgo);
    const defaultTo = fmtIt(today);

    currentPanel.webview.html = getPanelHtml(authors, defaultFrom, defaultTo);

    currentPanel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.command === 'generate') {
            const { author, from, to, model } = msg;
            if (!author || !from || !to) {
                vscode.window.showWarningMessage('VibeSync Recap: compila tutti i campi');
                return;
            }
            currentPanel?.webview.postMessage({ command: 'generating' });

            const result = await generateRecap(author, from, to, model as RecapModel);

            if (!result.success) {
                currentPanel?.webview.postMessage({
                    command: 'error',
                    message: result.error || 'Errore ignoto',
                });
                vscode.window.showErrorMessage(`VibeSync Recap: ${result.error}`);
                return;
            }

            lastRecapHtml = result.html;
            lastRecapMeta = {
                author, from, to,
                commits: result.commits_count || 0,
                files: result.files_count || 0,
                model,
            };

            currentPanel?.webview.postMessage({
                command: 'recap',
                html: result.html,
                commits: result.commits_count,
                files: result.files_count,
                tokens_input: result.tokens_input,
                tokens_output: result.tokens_output,
                cost: result.cost_estimate,
            });
        } else if (msg.command === 'save') {
            if (!lastRecapHtml || !lastRecapMeta) {
                vscode.window.showWarningMessage('VibeSync Recap: genera prima un recap');
                return;
            }
            try {
                const filePath = saveRecap(
                    lastRecapHtml,
                    lastRecapMeta.author,
                    lastRecapMeta.from,
                    lastRecapMeta.to,
                    {
                        commits_count: lastRecapMeta.commits,
                        files_count: lastRecapMeta.files,
                        model: lastRecapMeta.model,
                    },
                );
                const openLabel = 'Apri nel browser';
                const revealLabel = 'Mostra in Esplora file';
                const choice = await vscode.window.showInformationMessage(
                    `Recap salvato: ${filePath}`,
                    openLabel,
                    revealLabel,
                );
                if (choice === openLabel) {
                    vscode.env.openExternal(vscode.Uri.file(filePath));
                } else if (choice === revealLabel) {
                    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`VibeSync Recap: errore salvataggio — ${err.message}`);
            }
        } else if (msg.command === 'openRecapFolder') {
            const dir = getRecapDir();
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
        }
    });
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function escapeAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getPanelHtml(authors: string[], defaultFrom: string, defaultTo: string): string {
    const authorOptions = authors.length === 0
        ? '<option value="" disabled selected>Nessun autore trovato (git non raggiungibile?)</option>'
        : authors.map(a => `<option value="${escapeAttr(a)}">${escapeAttr(a)}</option>`).join('');

    const modelOptions = (Object.entries(RECAP_MODEL_LABELS) as [RecapModel, string][])
        .map(([id, label]) => `<option value="${escapeAttr(id)}">${escapeAttr(label)}</option>`)
        .join('');

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
    --purple: #667eea;
    --cyan: #4facfe;
    --pink: #f093fb;
    --teal: #2dd4bf;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
    font-size: 13px;
    color: var(--fg);
    background: var(--bg);
    padding: 0;
}
.header {
    padding: 20px 28px 16px;
    border-bottom: 1px solid var(--border);
    background: linear-gradient(135deg, rgba(102,126,234,0.08) 0%, rgba(79,172,254,0.05) 100%);
}
.header h1 {
    font-size: 20px;
    font-weight: 700;
    background: linear-gradient(135deg, #667eea 0%, #4facfe 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 4px;
}
.header p { font-size: 12px; opacity: 0.6; }

.form-bar {
    padding: 16px 28px;
    border-bottom: 1px solid var(--border);
    display: flex;
    gap: 12px;
    align-items: end;
    flex-wrap: wrap;
}
.form-field { display: flex; flex-direction: column; gap: 4px; }
.form-field label {
    font-size: 11px;
    font-weight: 600;
    opacity: 0.7;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}
.form-field input, .form-field select {
    padding: 6px 10px;
    border: 1px solid var(--input-border);
    border-radius: 4px;
    background: var(--input-bg);
    color: var(--input-fg);
    font-size: 12.5px;
    min-width: 140px;
}
.form-field input:focus, .form-field select:focus { outline: none; border-color: var(--accent); }
.form-field.wide input, .form-field.wide select { min-width: 200px; }

.btn {
    padding: 7px 16px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--hover);
    color: var(--fg);
    cursor: pointer;
    font-size: 12.5px;
    font-weight: 600;
}
.btn:hover { border-color: var(--accent); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-primary {
    background: linear-gradient(135deg, #667eea 0%, #4facfe 100%);
    color: #fff;
    border-color: transparent;
}
.btn-primary:hover { opacity: 0.92; }

.status-bar {
    padding: 8px 28px;
    background: var(--hover);
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    display: none;
}
.status-bar.visible { display: block; }
.status-bar .spinner {
    display: inline-block;
    width: 12px; height: 12px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin-right: 8px;
    vertical-align: -2px;
}
@keyframes spin { to { transform: rotate(360deg); } }

.result-area {
    padding: 24px 32px 40px;
    max-width: 960px;
    margin: 0 auto;
    line-height: 1.65;
}
.result-area .empty {
    opacity: 0.4;
    text-align: center;
    padding: 60px 20px;
    font-size: 13px;
}
.result-area h2 {
    font-size: 18px;
    color: var(--cyan);
    margin: 24px 0 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border);
}
.result-area h3 {
    font-size: 14.5px;
    color: var(--teal);
    margin: 16px 0 8px;
}
.result-area p { margin-bottom: 10px; color: var(--fg); opacity: 0.88; }
.result-area ul, .result-area ol { padding-left: 22px; margin-bottom: 12px; }
.result-area li { margin-bottom: 6px; opacity: 0.85; }
.result-area strong { color: var(--pink); font-weight: 600; }
.result-area code {
    background: rgba(0,0,0,0.35);
    padding: 1px 6px;
    border-radius: 4px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    color: var(--teal);
}
.result-area em { opacity: 0.65; font-style: italic; }
.result-area .recap-summary {
    background: linear-gradient(135deg, rgba(102,126,234,0.12) 0%, rgba(118,75,162,0.08) 100%);
    border: 1px solid rgba(102,126,234,0.3);
    border-radius: 8px;
    padding: 12px 18px;
    margin-bottom: 20px;
}
.result-area .recap-summary p { margin: 0; }

.actions-bar {
    padding: 14px 28px;
    border-top: 1px solid var(--border);
    background: var(--hover);
    display: none;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
}
.actions-bar.visible { display: flex; }
.actions-bar .metric { font-size: 11px; opacity: 0.6; margin-right: 12px; font-family: var(--vscode-editor-font-family, monospace); }
</style>
</head>
<body>

<div class="header">
    <h1>🤖 VibeSync — Recap AI</h1>
    <p>Analizza i commit di un dev in un range di date e genera un narrativo tecnico raggruppato per area funzionale.</p>
</div>

<div class="form-bar">
    <div class="form-field wide">
        <label>Autore</label>
        <select id="author">${authorOptions}</select>
    </div>
    <div class="form-field">
        <label>Dal (GG/MM/AAAA)</label>
        <input type="text" id="from" value="${defaultFrom}" placeholder="GG/MM/AAAA" maxlength="10" inputmode="numeric" pattern="\\d{2}/\\d{2}/\\d{4}" oninput="autoFormatDate(this)" />
    </div>
    <div class="form-field">
        <label>Al (GG/MM/AAAA)</label>
        <input type="text" id="to" value="${defaultTo}" placeholder="GG/MM/AAAA" maxlength="10" inputmode="numeric" pattern="\\d{2}/\\d{2}/\\d{4}" oninput="autoFormatDate(this)" />
    </div>
    <div class="form-field">
        <label>Modello</label>
        <select id="model">${modelOptions}</select>
    </div>
    <button class="btn btn-primary" id="genBtn" onclick="generate()">Genera recap</button>
    <button class="btn" onclick="openRecapFolder()" title="Apri cartella recap salvati">📁</button>
</div>

<div class="status-bar" id="statusBar"></div>

<div class="result-area" id="result">
    <div class="empty">
        Compila i campi e clicca <strong>"Genera recap"</strong>.<br><br>
        Il recap viene generato analizzando i commit git dell'autore selezionato nel range di date, sul repository <code>github_desktop_root</code> (dove arrivano dopo un pull da GitHub Desktop).
    </div>
</div>

<div class="actions-bar" id="actionsBar">
    <span class="metric" id="metric"></span>
    <button class="btn" onclick="save()">💾 Salva su disco</button>
    <button class="btn" onclick="regenerate()">🔄 Rigenera</button>
</div>

<script>
const vscode = acquireVsCodeApi();

// Auto-inserimento degli slash mentre l'utente digita (12 -> "12/", 12/08 -> "12/08/")
function autoFormatDate(el) {
    let v = el.value.replace(/[^0-9/]/g, '');
    // Rimuovi slash extra e ricostruisci in posizioni fisse
    const digits = v.replace(/\\D/g, '').slice(0, 8);
    let out = digits;
    if (digits.length >= 3) { out = digits.slice(0, 2) + '/' + digits.slice(2); }
    if (digits.length >= 5) { out = digits.slice(0, 2) + '/' + digits.slice(2, 4) + '/' + digits.slice(4); }
    el.value = out;
}

// Converte GG/MM/AAAA -> YYYY-MM-DD (formato richiesto da git log).
// Ritorna null se la stringa non è una data valida.
function parseItDate(s) {
    const m = /^(\\d{2})\\/(\\d{2})\\/(\\d{4})$/.exec((s || '').trim());
    if (!m) return null;
    const dd = parseInt(m[1], 10), mm = parseInt(m[2], 10), yyyy = parseInt(m[3], 10);
    if (dd < 1 || dd > 31 || mm < 1 || mm > 12 || yyyy < 2000 || yyyy > 2100) return null;
    // Verifica robustezza (es. 31/02 non deve passare)
    const d = new Date(yyyy, mm - 1, dd);
    if (d.getFullYear() !== yyyy || d.getMonth() !== mm - 1 || d.getDate() !== dd) return null;
    return yyyy + '-' + String(mm).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
}

function generate() {
    const author = document.getElementById('author').value;
    const fromRaw = document.getElementById('from').value;
    const toRaw = document.getElementById('to').value;
    const model = document.getElementById('model').value;
    if (!author) {
        alert('Seleziona un autore');
        return;
    }
    const from = parseItDate(fromRaw);
    if (!from) {
        alert('Data "Dal" non valida — usa GG/MM/AAAA');
        document.getElementById('from').focus();
        return;
    }
    const to = parseItDate(toRaw);
    if (!to) {
        alert('Data "Al" non valida — usa GG/MM/AAAA');
        document.getElementById('to').focus();
        return;
    }
    if (from > to) {
        alert('La data "Dal" deve essere precedente o uguale a "Al"');
        return;
    }
    document.getElementById('genBtn').disabled = true;
    document.getElementById('actionsBar').classList.remove('visible');
    vscode.postMessage({ command: 'generate', author, from, to, model });
}

function regenerate() { generate(); }
function save() { vscode.postMessage({ command: 'save' }); }
function openRecapFolder() { vscode.postMessage({ command: 'openRecapFolder' }); }

window.addEventListener('message', (e) => {
    const msg = e.data;
    const sb = document.getElementById('statusBar');
    const btn = document.getElementById('genBtn');
    if (msg.command === 'generating') {
        sb.classList.add('visible');
        sb.innerHTML = '<span class="spinner"></span>Generazione recap in corso — pu&ograve; richiedere 30-90s a seconda del volume...';
        document.getElementById('result').innerHTML = '<div class="empty">In elaborazione...</div>';
    } else if (msg.command === 'recap') {
        sb.classList.remove('visible');
        btn.disabled = false;
        document.getElementById('result').innerHTML = msg.html || '<div class="empty">Nessun contenuto generato.</div>';
        const metric = document.getElementById('metric');
        const cost = msg.cost !== undefined ? '$' + msg.cost.toFixed(4) : '?';
        metric.textContent = 'Commit: ' + (msg.commits ?? '?') + ' · File: ' + (msg.files ?? '?') + ' · Tokens in/out: ' + (msg.tokens_input ?? '?') + '/' + (msg.tokens_output ?? '?') + ' · Costo stimato: ' + cost;
        document.getElementById('actionsBar').classList.add('visible');
        window.scrollTo(0, 0);
    } else if (msg.command === 'error') {
        sb.classList.remove('visible');
        btn.disabled = false;
        document.getElementById('result').innerHTML = '<div class="empty" style="color: var(--danger); opacity: 0.9;">Errore: ' + msg.message + '</div>';
    }
});
</script>
</body></html>`;
}
