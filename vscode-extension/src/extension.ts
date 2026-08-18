/**
 * VibeSync — Extension Entry Point
 *
 * Two modes:
 *   - Chat Manager only (no config needed): search, rename, projects
 *   - Full mode (with config): + file locking, sync, release, notifications
 */

import * as vscode from 'vscode';
import * as lockManager from './lockManager';
import * as statusBar from './statusBar';
import * as fileWatcher from './fileWatcher';
import * as notificationManager from './notificationManager';
import { showReleasePanel, showLocksPanel, showMarkReleasedPanel, showPurgeReleasedPanel, showUnlockMyLocksPanel } from './releasePanel';
import { showSyncDashboard } from './syncPanel';
import { showConfigPanel } from './configPanel';
import { BuddyViewProvider, showBuddyPanel } from './buddyPanel';
import { testBuddy } from './buddyEngine';
import { showSearchPanel } from './searchPanel';
import { showRecapPanel } from './recapPanel';
import { showChatPanel, initChatBackground, prefillWithAnchor } from './chatPanel';
import { hashSnippet } from './chatTelegram';
import { MyLocksProvider, OtherLocksProvider, ReleaseQueueProvider } from './treeViewProvider';
import { ActionsProvider } from './actionsProvider';
import { initLang, t } from './i18n';

let pollingInterval: ReturnType<typeof setInterval> | undefined;
let myLocksProvider: MyLocksProvider;
let otherLocksProvider: OtherLocksProvider;
let releaseQueueProvider: ReleaseQueueProvider;

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // 0. Init i18n
    initLang();

    // 1. VibeBuddy sidebar view (always registered)
    const buddyProvider = new BuddyViewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(BuddyViewProvider.viewType, buddyProvider),
    );

    // 2. Commands that ALWAYS work (no config needed)
    context.subscriptions.push(
        vscode.commands.registerCommand('vibesync.settings', () => showConfigPanel()),
        vscode.commands.registerCommand('vibesync.searchChats', () => showSearchPanel('search')),
        vscode.commands.registerCommand('vibesync.chatProjects', () => showSearchPanel('projects')),
        vscode.commands.registerCommand('vibesync.showBuddy', () => showBuddyPanel(context)),
        vscode.commands.registerCommand('vibesync.testBuddy', () => testBuddy()),
        vscode.commands.registerCommand('vibesync.showRecap', () => showRecapPanel()),
        vscode.commands.registerCommand('vibesync.openChat', () => showChatPanel(context)),
        vscode.commands.registerCommand('vibesync.chatSelection', () => {
            // "Chatta selezione": prende selezione attiva nell'editor, calcola
            // l'anchor relativa al local_root del workspace VibeSync, apre il
            // chat panel con quell'anchor precompilata nell'input.
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('VibeSync Chat: nessun editor attivo.');
                return;
            }
            const cfg = lockManager.getConfig();
            if (!cfg?.local_root) {
                vscode.window.showWarningMessage('VibeSync Chat: local_root non configurato.');
                return;
            }
            const filePath = editor.document.uri.fsPath.replace(/\\/g, '/');
            const rootNorm = cfg.local_root.replace(/\\/g, '/').replace(/\/$/, '');
            // Case-insensitive match su Windows (drive letter puo' variare)
            const isWin = process.platform === 'win32';
            const filePathCmp = isWin ? filePath.toLowerCase() : filePath;
            const rootCmp = isWin ? rootNorm.toLowerCase() : rootNorm;
            if (!filePathCmp.startsWith(rootCmp + '/')) {
                vscode.window.showWarningMessage(`VibeSync Chat: il file non e' dentro local_root (${rootNorm}).`);
                return;
            }
            const relPath = filePath.slice(rootNorm.length + 1);
            const start = editor.selection.start.line + 1;
            const end = editor.selection.end.line + 1;

            // Iter 2: cattura snippet con ±3 righe di contesto e SHA-1 per il
            // detect di "codice cambiato" al click. Limite: 8 righe totali max
            // per contenere la dimensione del payload Telegram (max 4096 char).
            const doc = editor.document;
            const CONTEXT = 3;
            const MAX_LINES = 8;
            const rawFrom = Math.max(0, start - 1 - CONTEXT);
            const rawTo = Math.min(doc.lineCount - 1, end - 1 + CONTEXT);
            const capTo = Math.min(rawTo, rawFrom + MAX_LINES - 1);
            const snippet = doc.getText(new vscode.Range(
                new vscode.Position(rawFrom, 0),
                new vscode.Position(capTo, Number.MAX_SAFE_INTEGER),
            ));
            const hash = hashSnippet(snippet);

            const anchor: any = { file: relPath, start, snippet, hash };
            if (start !== end) { anchor.end = end; }
            prefillWithAnchor(context, anchor);
        }),
        // Diff navigation (delegano ai comandi built-in di VS Code; aggiungono solo
        // un alias coerente, keybindings F7/Shift+F7 e bottoni nella title bar).
        vscode.commands.registerCommand('vibesync.nextDiffChange', async () => {
            await vscode.commands.executeCommand('workbench.action.compareEditor.nextChange');
        }),
        vscode.commands.registerCommand('vibesync.prevDiffChange', async () => {
            await vscode.commands.executeCommand('workbench.action.compareEditor.previousChange');
        }),
    );

    // 2. Check config — determines full mode vs chat-only mode
    const config = lockManager.loadConfig();
    const fullMode = !!config;

    // 3. Actions sidebar — ALWAYS registered, shows different items based on mode
    const actionsProvider = new ActionsProvider(fullMode);
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('vibesync-actions', actionsProvider),
    );

    // ── Chat-only mode: stop here ───────────────────────────────────────
    if (!fullMode) {
        // Register empty tree providers so VS Code doesn't complain
        const emptyProvider = { onDidChangeTreeData: new vscode.EventEmitter().event, getTreeItem: (e: any) => e, getChildren: async () => [] };
        context.subscriptions.push(
            vscode.window.registerTreeDataProvider('vibesync-my-locks', emptyProvider as any),
            vscode.window.registerTreeDataProvider('vibesync-other-locks', emptyProvider as any),
            vscode.window.registerTreeDataProvider('vibesync-release-queue', emptyProvider as any),
        );
        return;
    }

    // ── Full mode: locking, sync, release, notifications ────────────────

    // 4. Status Bar
    statusBar.createStatusBarItems(context);

    // 5. TreeView Providers
    myLocksProvider = new MyLocksProvider();
    otherLocksProvider = new OtherLocksProvider();
    releaseQueueProvider = new ReleaseQueueProvider();

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('vibesync-my-locks', myLocksProvider),
        vscode.window.registerTreeDataProvider('vibesync-other-locks', otherLocksProvider),
        vscode.window.registerTreeDataProvider('vibesync-release-queue', releaseQueueProvider),
    );

    // 6. FileSystemWatcher
    fileWatcher.startFileWatcher(context);

    // 7. Full mode commands
    context.subscriptions.push(
        vscode.commands.registerCommand('vibesync.showQueue', () => showReleasePanel()),
        vscode.commands.registerCommand('vibesync.release', () => showReleasePanel()),
        vscode.commands.registerCommand('vibesync.markReleased', () => showMarkReleasedPanel()),
        vscode.commands.registerCommand('vibesync.purgeReleased', () => showPurgeReleasedPanel()),
        vscode.commands.registerCommand('vibesync.showLocks', () => showLocksPanel()),
        vscode.commands.registerCommand('vibesync.syncDashboard', () => showSyncDashboard()),

        vscode.commands.registerCommand('vibesync.fetchNow', async () => {
            await pollLocks();
            vscode.window.showInformationMessage(t('ext.fetchDone'));
        }),

        vscode.commands.registerCommand('vibesync.unlockMyFiles', async () => {
            // Apre QuickPick multi-select con i lock dell'utente (tutti pre-selezionati).
            // Permette di deselezionare quelli da mantenere prima dello sblocco.
            await showUnlockMyLocksPanel();
            await pollLocks();
        }),

        vscode.commands.registerCommand('vibesync.forceUnlock', async () => {
            const state = lockManager.getCurrentLocks();
            const staleThreshold = 24 * 60 * 60 * 1000;
            const staleLocks = state.locks.filter(l => {
                const age = Date.now() - new Date(l.timestamp).getTime();
                return age > staleThreshold;
            });

            if (staleLocks.length === 0) {
                vscode.window.showInformationMessage(t('ext.noStaleLocks'));
                return;
            }

            const unlockAllLabel = t('ext.unlockAll');
            const confirm = await vscode.window.showWarningMessage(
                t('ext.staleLocks', staleLocks.length),
                unlockAllLabel,
                t('ext.cancel')
            );

            if (confirm !== unlockAllLabel) { return; }

            let released = 0;
            for (const lock of staleLocks) {
                const result = await lockManager.releaseLock(lock.file);
                if (result.success) { released++; }
            }

            vscode.window.showInformationMessage(
                t('ext.locksUnlocked', released, staleLocks.length)
            );
            await pollLocks();
        }),

        vscode.commands.registerCommand('vibesync.refreshTreeView', () => {
            refreshAll();
        }),
    );

    // 8. First fetch
    await pollLocks();

    // 9. Periodic polling
    const intervalSec = vscode.workspace.getConfiguration('vibesync')
        .get<number>('pollingIntervalSeconds', 30);

    pollingInterval = setInterval(() => pollLocks(), intervalSec * 1000);
    context.subscriptions.push({ dispose: () => clearInterval(pollingInterval!) });

    // 10. Chat background — avvia long polling Telegram se configurato.
    // Cosi' ricevi i messaggi anche se il panel chat e' chiuso: notifica toast + persistenza.
    initChatBackground();
}

// ---------------------------------------------------------------------------
// Deactivate
// ---------------------------------------------------------------------------

export async function deactivate(): Promise<void> {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = undefined;
    }

    fileWatcher.stopFileWatcher();

    try {
        await lockManager.releaseAllManualLocks();
    } catch {
        // silent — extension shutting down
    }

    notificationManager.reset();
}

// ---------------------------------------------------------------------------
// Polling & Refresh
// ---------------------------------------------------------------------------

async function pollLocks(): Promise<void> {
    try {
        const state = await lockManager.fetchLocksFromGitHub();

        statusBar.updateLockStatus(state.locks);
        statusBar.updateQueueCount();
        notificationManager.checkForChanges(state.locks);

        refreshAll();
    } catch {
        statusBar.setOfflineStatus();
    }
}

function refreshAll(): void {
    myLocksProvider?.refresh();
    otherLocksProvider?.refresh();
    releaseQueueProvider?.refresh();
}
