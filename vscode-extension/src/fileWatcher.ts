/**
 * VibeSync File Watcher
 * FileSystemWatcher per proteggere i file durante lo sviluppo manuale (senza Claude Code).
 */

import * as vscode from 'vscode';
import * as lockManager from './lockManager';
import { t } from './i18n';

let watcher: vscode.FileSystemWatcher | undefined;

const recentlyChecked = new Map<string, number>();
const DEBOUNCE_MS = 3000;

// Path da ignorare temporaneamente (es. file appena copiati da git: non vogliamo
// che il watcher li veda come modifiche e li metta in RELEASE_QUEUE).
// chiave: path assoluto normalizzato (slash forward, lowercase su Windows);
// valore: timestamp epoch ms in cui scade l'ignore.
const ignoredPaths = new Map<string, number>();

const IS_WINDOWS = process.platform === 'win32';

// Normalizzazione canonica per confronto path:
// - forward slash sempre
// - su Windows tutto lowercase (filesystem case-insensitive; VS Code restituisce
//   spesso il drive letter minuscolo mentre altri sorgenti lo passano maiuscolo)
function normPath(p: string): string {
    const s = p.replace(/\\/g, '/');
    return IS_WINDOWS ? s.toLowerCase() : s;
}

export function ignorePathsFor(absolutePaths: string[], ttlMs: number): void {
    const expire = Date.now() + ttlMs;
    for (const p of absolutePaths) {
        ignoredPaths.set(normPath(p), expire);
    }
    // Pulizia opportunistica delle voci scadute per non far crescere la Map all'infinito
    if (ignoredPaths.size > 500) {
        const now = Date.now();
        for (const [key, exp] of ignoredPaths) {
            if (exp <= now) { ignoredPaths.delete(key); }
        }
    }
}

export function startFileWatcher(context: vscode.ExtensionContext): void {
    const config = lockManager.getConfig();
    if (!config) { return; }

    const enabled = vscode.workspace.getConfiguration('vibesync').get<boolean>('enableFileWatcher', true);
    if (!enabled) { return; }

    const localRoot = config.local_root.replace(/\\/g, '/');
    const pattern = new vscode.RelativePattern(vscode.Uri.file(localRoot), '**/*');
    watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidChange((uri) => handleFileChange(uri));
    watcher.onDidCreate((uri) => handleFileChange(uri));

    context.subscriptions.push(watcher);
}

async function handleFileChange(uri: vscode.Uri): Promise<void> {
    const filePath = uri.fsPath;

    // Skip se path appena toccato da una copia VibeSync (es. "Copia da Git"):
    // l'evento del filesystem arriva async dopo shutil.copy2, qui lo intercettiamo.
    // Confronto sempre normalizzato (case-insensitive su Windows) perche' VS Code
    // spesso restituisce il drive letter in minuscolo (c:) mentre il config lo
    // memorizza in maiuscolo (C:), col match case-sensitive il fix non scattava.
    const fpNorm = normPath(filePath);
    const expire = ignoredPaths.get(fpNorm);
    if (expire !== undefined) {
        if (Date.now() < expire) { return; }
        ignoredPaths.delete(fpNorm);
    }

    if (!lockManager.shouldProtect(filePath)) { return; }

    const now = Date.now();
    const lastChecked = recentlyChecked.get(filePath);
    if (lastChecked && (now - lastChecked) < DEBOUNCE_MS) { return; }
    recentlyChecked.set(filePath, now);

    if (recentlyChecked.size > 100) {
        for (const [key, time] of recentlyChecked) {
            if (now - time > 60000) { recentlyChecked.delete(key); }
        }
    }

    const relPath = lockManager.getRelativePath(filePath);
    if (!relPath) { return; }

    const result = await lockManager.checkLock(relPath);

    if (!result.success) { return; }

    if (result.locked && !result.is_own_lock) {
        const yesLabel = t('fw.yesContinue');
        const detailsLabel = t('fw.showDetails');
        const action = await vscode.window.showWarningMessage(
            t('fw.fileInUse', relPath, result.developer!, result.timestamp!, result.source!),
            yesLabel,
            detailsLabel
        );

        if (action === detailsLabel) {
            vscode.window.showInformationMessage(
                t('fw.lockDetails', relPath, result.developer!, result.timestamp!, result.session_id!, result.source!)
            );
        }
        return;
    }

    if (!result.locked) {
        const lockResult = await lockManager.acquireLock(relPath);
        if (lockResult.success && lockResult.action === 'locked') {
            vscode.commands.executeCommand('vibesync.refreshTreeView');
        }
    }
}

export function stopFileWatcher(): void {
    if (watcher) {
        watcher.dispose();
        watcher = undefined;
    }
}
