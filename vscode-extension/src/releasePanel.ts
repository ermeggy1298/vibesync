/**
 * VibeSync Release Panel
 * QuickPick per selezionare file da rilasciare + conflict preview con vscode.diff.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as lockManager from './lockManager';
import { t } from './i18n';

export async function showReleasePanel(): Promise<void> {
    const listResult = await lockManager.listReleaseQueue();
    if (!listResult.success) {
        vscode.window.showErrorMessage(t('rel.queueError', listResult.error || ''));
        return;
    }

    const pending = listResult.queue.filter(q => !q.released);
    if (pending.length === 0) {
        vscode.window.showInformationMessage(t('rel.noFilesInQueue'));
        return;
    }

    const items: vscode.QuickPickItem[] = pending.map(entry => {
        const timeStr = entry.days_ago === 0 ? t('rel.today') : t('rel.daysAgo', entry.days_ago);
        return {
            label: entry.file,
            description: `${timeStr}`,
            picked: false,
        };
    });

    const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: t('rel.selectFiles'),
        title: t('rel.releaseTitle'),
    });

    if (!selected || selected.length === 0) { return; }

    const selectedFiles = selected.map(s => s.label);

    const previewResult = await lockManager.previewRelease(selectedFiles);
    if (!previewResult.success) {
        vscode.window.showErrorMessage(t('rel.previewError', previewResult.error || ''));
        return;
    }

    const conflicts = previewResult.previews.filter(p => p.status === 'conflict');

    if (conflicts.length > 0) {
        for (const conflict of conflicts) {
            const config = lockManager.getConfig();
            if (!config) { continue; }

            const localUri = vscode.Uri.file(path.join(config.local_root, conflict.file));
            const githubUri = vscode.Uri.file(path.join(config.github_desktop_root, conflict.file));

            await vscode.commands.executeCommand(
                'vscode.diff',
                githubUri,
                localUri,
                t('rel.diffTitle', conflict.file)
            );
        }

        const overwriteLabel = t('rel.overwriteAll');
        const confirm = await vscode.window.showWarningMessage(
            t('rel.conflictsFound', conflicts.length),
            overwriteLabel,
            t('ext.cancel')
        );

        if (confirm !== overwriteLabel) {
            vscode.window.showInformationMessage(t('rel.releaseCancelled'));
            return;
        }
    }

    const releaseResult = await lockManager.releaseFiles(selectedFiles);

    if (releaseResult.success) {
        vscode.window.showInformationMessage(t('rel.filesCopied', releaseResult.copied.length));
    } else {
        const errorMsg = releaseResult.errors.map(e => `${e.file}: ${e.error}`).join('\n');
        vscode.window.showErrorMessage(t('rel.releaseErrors', errorMsg));
    }

    vscode.commands.executeCommand('vibesync.refreshTreeView');
}

export async function showMarkReleasedPanel(): Promise<void> {
    const listResult = await lockManager.listReleaseQueue();
    if (!listResult.success) {
        vscode.window.showErrorMessage(t('rel.queueError', listResult.error || ''));
        return;
    }

    const pending = listResult.queue.filter(q => !q.released);
    if (pending.length === 0) {
        vscode.window.showInformationMessage(t('rel.noFilesInQueue'));
        return;
    }

    const items: vscode.QuickPickItem[] = pending.map(entry => {
        const timeStr = entry.days_ago === 0 ? t('rel.today') : t('rel.daysAgo', entry.days_ago);
        return {
            label: entry.file,
            description: timeStr,
            picked: false,
        };
    });

    const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: t('rel.selectMarkReleased'),
        title: t('rel.markReleasedTitle'),
    });

    if (!selected || selected.length === 0) { return; }

    const selectedFiles = selected.map(s => s.label);
    const result = await lockManager.markReleased(selectedFiles);

    if (result.success) {
        const markedCount = result.marked?.length ?? 0;
        const alreadyCount = result.already_released?.length ?? 0;
        vscode.window.showInformationMessage(
            t('rel.markedReleased', markedCount, alreadyCount)
        );
    } else {
        vscode.window.showErrorMessage(t('rel.markReleasedError', result.error || ''));
    }

    vscode.commands.executeCommand('vibesync.refreshTreeView');
}

export async function showPurgeReleasedPanel(): Promise<void> {
    // Conta voci released per dare conferma con numeri
    const listResult = await lockManager.listReleaseQueue();
    if (!listResult.success) {
        vscode.window.showErrorMessage(t('rel.queueError', listResult.error || ''));
        return;
    }
    const releasedCount = listResult.queue.filter(q => q.released).length;
    if (releasedCount === 0) {
        vscode.window.showInformationMessage(t('rel.noReleasedToPurge'));
        return;
    }

    // Scelta filtro eta'
    const ageOptions: (vscode.QuickPickItem & { days: number })[] = [
        { label: t('rel.purgeAll'), description: `(${releasedCount})`, days: 0 },
        { label: t('rel.purgeOlderThan', 7), days: 7 },
        { label: t('rel.purgeOlderThan', 30), days: 30 },
        { label: t('rel.purgeOlderThan', 90), days: 90 },
    ];
    const choice = await vscode.window.showQuickPick(ageOptions, {
        placeHolder: t('rel.purgeChoosePlaceholder'),
        title: t('rel.purgeTitle'),
    });
    if (!choice) { return; }

    // Conferma
    const confirmLabel = t('rel.purgeConfirmYes');
    const confirm = await vscode.window.showWarningMessage(
        choice.days === 0
            ? t('rel.purgeConfirmAll', releasedCount)
            : t('rel.purgeConfirmFiltered', choice.days),
        confirmLabel,
        t('ext.cancel')
    );
    if (confirm !== confirmLabel) { return; }

    const result = await lockManager.purgeReleased(choice.days);

    if (result.success) {
        vscode.window.showInformationMessage(
            t('rel.purgeDone', result.purged_count ?? 0, result.kept_count ?? 0)
        );
    } else {
        vscode.window.showErrorMessage(t('rel.purgeError', result.error || ''));
    }

    vscode.commands.executeCommand('vibesync.refreshTreeView');
}

export async function showUnlockMyLocksPanel(): Promise<void> {
    // Fetch fresh state da GitHub (non quello cached, evita di mostrare lock obsoleti)
    const state = await lockManager.fetchLocksFromGitHub();
    const myDev = lockManager.getDeveloperName();
    const myLocks = state.locks.filter(l => l.developer === myDev);

    if (myLocks.length === 0) {
        vscode.window.showInformationMessage(t('rel.noMyLocks'));
        return;
    }

    const items: vscode.QuickPickItem[] = myLocks.map(lock => {
        const sourceLabel = lock.source === 'claude_code' ? 'Claude Code' : 'Manuale';
        const ageMs = Date.now() - new Date(lock.timestamp).getTime();
        const ageMin = Math.floor(ageMs / 60000);
        let ageStr: string;
        if (ageMin < 1) {
            ageStr = t('rel.now');
        } else if (ageMin < 60) {
            ageStr = `${ageMin}min`;
        } else {
            ageStr = `${Math.floor(ageMin / 60)}h${ageMin % 60}min`;
        }
        return {
            label: lock.file,
            description: `${sourceLabel} — ${ageStr}`,
            picked: true,
        };
    });

    const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: t('rel.unlockSelectPlaceholder'),
        title: t('rel.unlockMyLocksTitle', myLocks.length),
    });

    if (selected === undefined) {
        // Annullato (Esc) — non confondere con "deselezionati tutti"
        vscode.window.showInformationMessage(t('rel.unlockCancelled'));
        return;
    }
    if (selected.length === 0) {
        vscode.window.showInformationMessage(t('rel.unlockNoneSelected'));
        return;
    }

    const filesToUnlock = selected.map(s => s.label);
    const result = await lockManager.unlockSelectedLocks(filesToUnlock);

    if (result.success) {
        const count = result.released?.length ?? 0;
        const kept = myLocks.length - count;
        vscode.window.showInformationMessage(
            kept > 0 ? t('rel.unlockedSomeKept', count, kept) : t('rel.unlockedAll', count)
        );
    } else {
        vscode.window.showErrorMessage(t('ext.unlockError', result.error || ''));
    }

    vscode.commands.executeCommand('vibesync.refreshTreeView');
}

export async function showLocksPanel(): Promise<void> {
    const state = lockManager.getCurrentLocks();

    if (state.locks.length === 0) {
        vscode.window.showInformationMessage(t('rel.noActiveLocks'));
        return;
    }

    const items: vscode.QuickPickItem[] = state.locks.map(lock => {
        const sourceLabel = lock.source === 'claude_code' ? 'CC' : '✋';
        return {
            label: `${lock.developer === lockManager.getDeveloperName() ? '$(circle-filled)' : '$(lock)'} ${lock.file}`,
            description: `${lock.developer} (${sourceLabel})`,
            detail: `${lock.timestamp} | ${lock.session_id}`,
        };
    });

    await vscode.window.showQuickPick(items, {
        placeHolder: t('rel.activeLocks'),
        title: t('rel.activeLocksTitle'),
    });
}
