/**
 * VibeSync Recap Engine
 *
 * Analizza i commit git di un autore in un range di date e usa Claude
 * per produrre un HTML narrativo raggruppato per area funzionale.
 *
 * Fonte dati: `git log` su `github_desktop_root` (i commit di altri dev
 * arrivano lì dopo un pull, quindi è la fonte affidabile per "cosa ha
 * rilasciato Massimo"). Il RELEASE_QUEUE.json è locale a chi rilascia
 * e non è accessibile agli altri.
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as lockManager from './lockManager';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RECAP_DIR = path.join(os.homedir(), '.vibesync', 'recaps');

// Limite prudente per il diff totale inviato all'API (in caratteri).
// Sonnet 5 ha context ~200k token = ~600-800k caratteri, ma teniamo margine
// abbondante per prompt + risposta e per non far esplodere il costo su un
// singolo recap. Se il diff è più grande, tronchiamo i commit più voluminosi.
const MAX_DIFF_CHARS = 180_000;

export type RecapModel = 'claude-sonnet-5' | 'claude-opus-5' | 'claude-haiku-4-5-20251001';

export const RECAP_MODEL_LABELS: Record<RecapModel, string> = {
    'claude-sonnet-5': 'Sonnet 5 (raccomandato)',
    'claude-opus-5': 'Opus 5 (max qualità)',
    'claude-haiku-4-5-20251001': 'Haiku 4.5 (economico)',
};

export interface CommitInfo {
    sha: string;
    author: string;
    email: string;
    date: string;
    subject: string;
    body: string;
    files: string[];
    diff: string;
    diff_truncated: boolean;
}

export interface RecapResult {
    success: boolean;
    html?: string;
    commits_count?: number;
    files_count?: number;
    tokens_input?: number;
    tokens_output?: number;
    cost_estimate?: number;
    error?: string;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function getGitCwd(): string | undefined {
    const config = lockManager.getConfig();
    return config?.github_desktop_root;
}

/**
 * Determina il "ref" da interrogare: preferiamo `origin/<branch>` per essere
 * indipendenti dal branch localmente checked-out in `github_desktop_root`.
 * Se il remote tracking non esiste (repo appena clonato, remote diverso, ecc.)
 * facciamo fallback a `--all` (tutti i ref locali+remoti visibili).
 */
async function getSearchRefs(cwd: string): Promise<string[]> {
    const config = lockManager.getConfig();
    const branch = config?.github_branch;
    if (branch) {
        try {
            // Verifica che origin/<branch> esista
            await runGit(['rev-parse', '--verify', `origin/${branch}`], cwd);
            return [`origin/${branch}`];
        } catch { /* fallback sotto */ }
    }
    // Fallback: cerca in tutti i ref (locali + remoti)
    return ['--all'];
}

function runGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.execFile('git', args, { cwd, maxBuffer: 100 * 1024 * 1024 }, (err, stdout) => {
            if (err) { reject(err); return; }
            resolve(stdout);
        });
    });
}

/** Fetch silenzioso per allineare con il remote prima di interrogare git log. */
async function fetchQuiet(cwd: string): Promise<void> {
    try {
        await runGit(['fetch', '--all', '--quiet'], cwd);
    } catch { /* fetch fallito (offline o auth mancante): usiamo quello che abbiamo */ }
}

/** Lista autori distinti apparsi in `git log`. Usata per popolare il dropdown. */
export async function listAuthors(): Promise<string[]> {
    const cwd = getGitCwd();
    if (!cwd) { return []; }
    try {
        await fetchQuiet(cwd);
        const refs = await getSearchRefs(cwd);
        // ultimi 6 mesi: bilancia completezza vs velocità
        const out = await runGit(['log', ...refs, '--since=6.months.ago', '--format=%an'], cwd);
        const set = new Set<string>();
        for (const line of out.split('\n')) {
            const name = line.trim();
            if (name) { set.add(name); }
        }
        return [...set].sort((a, b) => a.localeCompare(b));
    } catch {
        return [];
    }
}

/**
 * Ritorna i commit di un autore in un intervallo, con diff completo per commit.
 * Se il diff totale supera MAX_DIFF_CHARS, tronca i commit più grossi ma
 * mantiene comunque il metadata (sha, subject, files) per non perdere pezzi
 * dal recap narrativo.
 */
export async function getCommitLog(
    author: string,
    fromDate: string,   // YYYY-MM-DD
    toDate: string,     // YYYY-MM-DD
): Promise<CommitInfo[]> {
    const cwd = getGitCwd();
    if (!cwd) { throw new Error('github_desktop_root non configurato'); }

    // Allinea con il remote e usa origin/<branch> come ref (o --all se il
    // remote tracking non esiste). Senza questo, git log leggerebbe HEAD
    // = branch locale checked-out, che spesso non contiene i commit di
    // altri dev spinti sul remote.
    await fetchQuiet(cwd);
    const refs = await getSearchRefs(cwd);

    // Parser design:
    // - COMMIT_START marca l'inizio di ogni commit → primo split
    // - FILES_START separa la metadata dai file (mangia il fatto che %b può
    //   contenere newline e che --name-only stampa i file dopo il format)
    // - FIELD separa i campi della metadata (sha/author/email/date/subject/body)
    //
    // Formato: <COMMIT_START>sha<F>an<F>ae<F>date<F>subject<F>body<FILES_START>
    //          file1
    //          file2
    // La vecchia versione aveva SEP alla fine del format e --name-only appendeva
    // i file dopo: il chunk risultante mischiava files del commit N col meta del
    // commit N+1 → solo il primo commit sopravviveva al parse, tutti gli altri
    // fallivano il check parts.length < 6 e venivano skippati.
    const COMMIT_START = '@@VSC_COMMIT@@';
    const FILES_START = '@@VSC_FILES@@';
    const FIELD = '@@VSC_FIELD@@';

    const format = COMMIT_START + ['%H', '%an', '%ae', '%aI', '%s', '%b'].join(FIELD) + FILES_START;

    // Git interpreta --since/--until senza orario come "quel giorno ALL'ORA
    // CORRENTE", non a mezzanotte. Quando from == to (o range molto stretto)
    // questo taglia via metà giornata e da 0 risultati. Fissiamo esplicito:
    // - since = inizio giornata (00:00:00)
    // - until = fine giornata (23:59:59)
    const sinceInclusive = `${fromDate} 00:00:00`;
    const untilInclusive = `${toDate} 23:59:59`;

    const out = await runGit(
        [
            'log',
            ...refs,
            `--author=${author}`,
            `--since=${sinceInclusive}`,
            `--until=${untilInclusive}`,
            `--pretty=format:${format}`,
            '--name-only',
            '--no-merges',
        ],
        cwd,
    );

    const commits: CommitInfo[] = [];
    for (const chunk of out.split(COMMIT_START)) {
        if (!chunk.trim()) { continue; }
        const parts = chunk.split(FILES_START);
        if (parts.length < 2) { continue; }
        const [metaBlock, filesBlock] = parts;
        const metaParts = metaBlock.split(FIELD);
        if (metaParts.length < 6) { continue; }
        const [sha, an, ae, adate, subject, body] = metaParts;
        const files = filesBlock.split('\n').map(l => l.trim()).filter(Boolean);
        commits.push({
            sha, author: an, email: ae, date: adate,
            subject, body,
            files,
            diff: '',
            diff_truncated: false,
        });
    }

    // Scarica il diff per ogni commit
    for (const c of commits) {
        try {
            c.diff = await runGit(['show', '--no-color', '--format=', c.sha], cwd);
        } catch {
            c.diff = '(diff non recuperabile)';
        }
    }

    // Se il totale supera MAX_DIFF_CHARS, tronca i più grandi
    let total = commits.reduce((s, c) => s + c.diff.length, 0);
    if (total > MAX_DIFF_CHARS) {
        // Ordina per diff.length desc e tronca finché sotto soglia
        const sorted = [...commits].sort((a, b) => b.diff.length - a.diff.length);
        for (const c of sorted) {
            if (total <= MAX_DIFF_CHARS) { break; }
            const target = Math.max(2000, c.diff.length - (total - MAX_DIFF_CHARS));
            if (target < c.diff.length) {
                c.diff = c.diff.slice(0, target) + '\n\n[... diff troncato per lunghezza ...]';
                c.diff_truncated = true;
                total = commits.reduce((s, x) => s + x.diff.length, 0);
            }
        }
    }

    return commits;
}

// ---------------------------------------------------------------------------
// Claude API
// ---------------------------------------------------------------------------

function getApiKey(): string {
    return vscode.workspace.getConfiguration('vibesync').get<string>('anthropicApiKey', '');
}

// Pricing (per milione di token). Fonte: pricing Anthropic pubblico.
// Aggiornare se cambia. Se non listato → costo stimato = 0.
const PRICING: Record<string, { input: number; output: number }> = {
    'claude-sonnet-5': { input: 3, output: 15 },
    'claude-opus-5': { input: 15, output: 75 },
    'claude-haiku-4-5-20251001': { input: 0.80, output: 4 },
};

function buildSystemPrompt(): string {
    return `Sei un assistente tecnico che analizza i commit git di un developer per produrre un recap narrativo.

RICEVI: log dei commit di un autore in un range di date, con diff completo di ogni commit.

DEVI PRODURRE: un documento HTML in italiano, sintetico ma tecnicamente preciso, che aiuti un collega a capire velocemente cosa è stato fatto.

STRUTTURA OBBLIGATORIA dell'output:

<div class="recap-summary">
  <p><strong>Autore:</strong> ... · <strong>Range:</strong> ... · <strong>Commit:</strong> N · <strong>File toccati:</strong> N</p>
</div>

<h2>🎯 Panoramica</h2>
<p>Un paragrafo di 2-4 frasi che riassume in una vista d'insieme cosa è stato fatto (temi principali, direzione del lavoro).</p>

<h2>📦 Per area funzionale</h2>
<p>Raggruppa i commit per AREA FUNZIONALE dedotta dai path dei file e dai commit message. Esempi di aree tipiche: "Contabilità Generale (CoGe)", "Rilievi CRIF", "Business Intelligence", "Motori BI (AFL)", "Frontend UI", "Sicurezza / Auth", "Migration / DDL", "VibeSync (tooling)". Adatta i nomi al contenuto reale che vedi.</p>

<h3>[Nome area 1]</h3>
<ul>
  <li><strong>path/al/file.py</strong>: cosa cambia in questo file, cosa fa la modifica dal punto di vista tecnico. Non ripetere il codice, spiega il comportamento.</li>
  <li>...</li>
</ul>

<h3>[Nome area 2]</h3>
<ul>...</ul>

<h2>⚠️ Punti di attenzione</h2>
<ul>
  <li>Elenca modifiche potenzialmente rischiose o da rivedere: nuove query SQL non parametrizzate, cambi ad auth/middleware, rimozioni di file, modifiche a migration/DDL, cambi ai file di config critici, endpoint pubblici nuovi, deps aggiunte.</li>
  <li>Se non ce ne sono, scrivi <em>"Nessun cambio critico rilevato."</em></li>
</ul>

<h2>📝 Cronologia commit</h2>
<ol>
  <li><code>sha-short</code> <em>data</em> — <strong>subject</strong> (N file)</li>
  <li>...</li>
</ol>

REGOLE:
- Restituisci SOLO l'HTML descritto sopra, senza <!DOCTYPE>, senza <html>, senza <body>, senza <style>, senza \`\`\`html.
- Italiano tecnico, secondo, sintetico. Niente promozionalismo ("importante refactor!") — solo descrizione.
- Nei bullet <strong> usalo per nomi di file, funzioni, tabelle DB, simboli. <code> per snippet brevi (max 40 char).
- Non ripetere codice del diff. Descrivi COSA fa e PERCHÉ (dedotto dal contesto).
- Se un commit è troppo grande e trovi "[... diff troncato per lunghezza ...]", segnalalo per quel file nel bullet con "(diff parziale)".
- Per la cronologia in fondo: sha-short = primi 7 caratteri di sha. Data in formato "gg/mm hh:mm".
`;
}

function buildUserPrompt(commits: CommitInfo[], author: string, fromDate: string, toDate: string): string {
    const lines: string[] = [];
    lines.push(`Autore: ${author}`);
    lines.push(`Range: dal ${fromDate} al ${toDate}`);
    lines.push(`Commit totali: ${commits.length}`);
    const allFiles = new Set<string>();
    for (const c of commits) { for (const f of c.files) { allFiles.add(f); } }
    lines.push(`File toccati unici: ${allFiles.size}`);
    lines.push('');
    lines.push('=== COMMIT LOG ===');
    lines.push('');

    for (const c of commits) {
        lines.push(`## commit ${c.sha}`);
        lines.push(`data: ${c.date}`);
        lines.push(`subject: ${c.subject}`);
        if (c.body) { lines.push(`body: ${c.body}`); }
        lines.push(`files (${c.files.length}):`);
        for (const f of c.files) { lines.push(`  - ${f}`); }
        lines.push('');
        lines.push('```diff');
        lines.push(c.diff);
        lines.push('```');
        if (c.diff_truncated) { lines.push('[diff troncato]'); }
        lines.push('');
    }

    return lines.join('\n');
}

export function callClaude(model: RecapModel, systemPrompt: string, userPrompt: string): Promise<{
    text: string;
    input_tokens: number;
    output_tokens: number;
}> {
    return new Promise((resolve, reject) => {
        const apiKey = getApiKey();
        if (!apiKey) {
            reject(new Error('vibesync.anthropicApiKey non configurata. Impostala nelle settings VS Code.'));
            return;
        }

        const body = JSON.stringify({
            model,
            max_tokens: 8000,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
        });

        const options = {
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Length': Buffer.byteLength(body),
            },
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) {
                        reject(new Error(parsed.error.message || `API error ${res.statusCode}`));
                        return;
                    }
                    // Estrai TUTTI i blocchi di tipo 'text' (Claude può
                    // ritornare content = [thinking, text, ...] con extended
                    // thinking abilitato; il vecchio codice prendeva solo
                    // content[0].text e con thinking usciva stringa vuota).
                    const blocks = Array.isArray(parsed.content) ? parsed.content : [];
                    const text = blocks
                        .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
                        .map((b: any) => b.text)
                        .join('\n');
                    resolve({
                        text,
                        input_tokens: parsed.usage?.input_tokens || 0,
                        output_tokens: parsed.usage?.output_tokens || 0,
                    });
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        // Timeout largo: chiamate a Sonnet su prompt grossi possono richiedere 30-60s
        req.setTimeout(120_000, () => { req.destroy(); reject(new Error('Timeout dopo 120s')); });
        req.write(body);
        req.end();
    });
}

function estimateCost(model: RecapModel, inputTokens: number, outputTokens: number): number {
    const p = PRICING[model];
    if (!p) { return 0; }
    return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function generateRecap(
    author: string,
    fromDate: string,
    toDate: string,
    model: RecapModel,
): Promise<RecapResult> {
    try {
        const commits = await getCommitLog(author, fromDate, toDate);
        if (commits.length === 0) {
            const cwd = getGitCwd();
            const refs = cwd ? await getSearchRefs(cwd) : ['(no repo)'];
            const config = lockManager.getConfig();
            return {
                success: true,
                html: `<div class="recap-summary">
                    <p><strong>Nessun commit trovato</strong> per <em>${author}</em> tra ${fromDate} e ${toDate}.</p>
                    <p style="margin-top:8px;font-size:12px;opacity:0.7;">
                        Ref interrogato: <code>${refs.join(' ')}</code><br>
                        Branch configurato (<code>github_branch</code>): <code>${config?.github_branch || '(non configurato)'}</code><br>
                        Repo: <code>${cwd || '(non configurato)'}</code>
                    </p>
                    <p style="margin-top:8px;font-size:12px;opacity:0.7;">
                        Se sei sicuro che i commit esistono: verifica il nome esatto dell'autore
                        (matcha per stringa in <code>%an</code>), controlla che <code>github_branch</code>
                        nel config VibeSync punti al branch giusto, e che GitHub Desktop abbia fatto pull di recente.
                    </p>
                </div>`,
                commits_count: 0,
                files_count: 0,
            };
        }

        const allFiles = new Set<string>();
        for (const c of commits) { for (const f of c.files) { allFiles.add(f); } }

        const systemPrompt = buildSystemPrompt();
        const userPrompt = buildUserPrompt(commits, author, fromDate, toDate);

        const { text, input_tokens, output_tokens } = await callClaude(model, systemPrompt, userPrompt);

        return {
            success: true,
            html: text,
            commits_count: commits.length,
            files_count: allFiles.size,
            tokens_input: input_tokens,
            tokens_output: output_tokens,
            cost_estimate: estimateCost(model, input_tokens, output_tokens),
        };
    } catch (err: any) {
        return { success: false, error: err.message || String(err) };
    }
}

// ---------------------------------------------------------------------------
// Salvataggio su disco
// ---------------------------------------------------------------------------

/** Salva l'HTML del recap in un file wrapper standalone. Ritorna il path. */
export function saveRecap(
    html: string,
    author: string,
    fromDate: string,
    toDate: string,
    meta: { commits_count?: number; files_count?: number; model?: string },
): string {
    fs.mkdirSync(RECAP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeAuthor = author.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `${stamp}_${safeAuthor}_${fromDate}_${toDate}.html`;
    const fullPath = path.join(RECAP_DIR, filename);

    const wrapped = wrapStandalone(html, author, fromDate, toDate, meta);
    fs.writeFileSync(fullPath, wrapped, 'utf-8');
    return fullPath;
}

function wrapStandalone(
    html: string,
    author: string,
    fromDate: string,
    toDate: string,
    meta: { commits_count?: number; files_count?: number; model?: string },
): string {
    return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<title>Recap ${author} — ${fromDate} → ${toDate}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, 'Segoe UI', Roboto, sans-serif; background: #0a141e; color: rgba(255,255,255,0.9); padding: 32px 40px; line-height: 1.65; max-width: 960px; margin: 0 auto; }
h1 { font-size: 26px; background: linear-gradient(135deg, #667eea 0%, #764ba2 50%, #4facfe 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 8px; }
.meta { font-size: 12px; color: rgba(255,255,255,0.5); margin-bottom: 24px; }
h2 { font-size: 20px; color: #4facfe; margin: 28px 0 12px; padding-bottom: 6px; border-bottom: 1px solid rgba(102,126,234,0.3); }
h3 { font-size: 16px; color: #2dd4bf; margin: 18px 0 8px; }
p { margin-bottom: 10px; color: rgba(255,255,255,0.82); }
ul, ol { padding-left: 22px; margin-bottom: 12px; }
li { margin-bottom: 6px; color: rgba(255,255,255,0.78); }
strong { color: #f093fb; font-weight: 600; }
code { background: rgba(0,0,0,0.4); padding: 1px 6px; border-radius: 4px; font-family: 'SF Mono', Monaco, monospace; font-size: 12.5px; color: #7df3dd; }
em { color: rgba(255,255,255,0.6); font-style: italic; }
.recap-summary { background: linear-gradient(135deg, rgba(102,126,234,0.15) 0%, rgba(118,75,162,0.10) 100%); border: 1px solid rgba(102,126,234,0.3); border-radius: 10px; padding: 14px 20px; margin-bottom: 24px; }
.recap-summary p { color: rgba(255,255,255,0.9); margin: 0; }
</style>
</head>
<body>
<h1>Recap: ${escapeAttr(author)}</h1>
<div class="meta">
    Range: ${fromDate} → ${toDate} · Commit: ${meta.commits_count ?? '?'} · File: ${meta.files_count ?? '?'} · Modello: ${meta.model ?? '?'} · Generato: ${new Date().toLocaleString('it-IT')}
</div>
${html}
</body>
</html>`;
}

function escapeAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function getRecapDir(): string {
    return RECAP_DIR;
}
