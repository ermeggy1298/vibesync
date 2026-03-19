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
