/**
 * VibeSync Notification Manager
 * Confronta lo stato dei lock ad ogni polling e mostra toast notifications
 * quando un altro developer locka/sblocca un file.
 */

import * as vscode from 'vscode';
import * as lockManager from './lockManager';
import { t } from './i18n';

let previousLocks: lockManager.LockEntry[] = [];
let initialized = false;

export function checkForChanges(currentLocks: lockManager.LockEntry[]): void {
    const enabled = vscode.workspace.getConfiguration('vibesync').get<boolean>('enableNotifications', true);
    if (!enabled) { return; }

    const developer = lockManager.getDeveloperName();

    if (!initialized) {
        previousLocks = [...currentLocks];
        initialized = true;
        return;
    }

    const prevFiles = new Set(previousLocks.map(l => `${l.file}::${l.developer}`));
    const currFiles = new Set(currentLocks.map(l => `${l.file}::${l.developer}`));

    for (const lock of currentLocks) {
        if (lock.developer === developer) { continue; }
        const key = `${lock.file}::${lock.developer}`;
        if (!prevFiles.has(key)) {
            vscode.window.showInformationMessage(t('notify.startedWorking', lock.developer, lock.file));
        }
    }

    for (const lock of previousLocks) {
        if (lock.developer === developer) { continue; }
        const key = `${lock.file}::${lock.developer}`;
        if (!currFiles.has(key)) {
            vscode.window.showInformationMessage(t('notify.stoppedWorking', lock.developer, lock.file));
        }
    }

    const staleThreshold = 24 * 60 * 60 * 1000;
    const staleLocks = currentLocks.filter(l => {
        const age = Date.now() - new Date(l.timestamp).getTime();
        return age > staleThreshold;
    });

    if (staleLocks.length > 0) {
        const prevStaleFiles = new Set(
            previousLocks
                .filter(l => Date.now() - new Date(l.timestamp).getTime() > staleThreshold)
                .map(l => l.file)
        );

        const newStaleLocks = staleLocks.filter(l => !prevStaleFiles.has(l.file));
        if (newStaleLocks.length > 0) {
            const cleanLabel = t('notify.cleanNow');
            vscode.window.showWarningMessage(
                t('notify.staleLocks', staleLocks.length),
                cleanLabel
            ).then(action => {
                if (action === cleanLabel) {
                    vscode.commands.executeCommand('vibesync.forceUnlock');
                }
            });
        }
    }

    previousLocks = [...currentLocks];
}

export function reset(): void {
    previousLocks = [];
    initialized = false;
}
