/**
 * VibeSync Status Bar
 * 4 elementi nella status bar: stato lock, coda rilascio, bottone rilascia, bottone fetch.
 */

import * as vscode from 'vscode';
import * as lockManager from './lockManager';
import { t } from './i18n';

let lockStatusItem: vscode.StatusBarItem;
let queueCountItem: vscode.StatusBarItem;
let releaseButtonItem: vscode.StatusBarItem;
let fetchButtonItem: vscode.StatusBarItem;

export function createStatusBarItems(context: vscode.ExtensionContext): void {
    lockStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    lockStatusItem.command = 'vibesync.showLocks';
    lockStatusItem.tooltip = t('status.lockTooltip');
    lockStatusItem.text = t('status.free');
    lockStatusItem.show();
    context.subscriptions.push(lockStatusItem);

    queueCountItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    queueCountItem.command = 'vibesync.showQueue';
    queueCountItem.tooltip = t('status.queueTooltip');
    queueCountItem.text = t('status.queueCount', 0);
    queueCountItem.show();
    context.subscriptions.push(queueCountItem);

    releaseButtonItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    releaseButtonItem.command = 'vibesync.release';
    releaseButtonItem.tooltip = t('status.releaseTooltip');
    releaseButtonItem.text = t('status.release');
    releaseButtonItem.show();
    context.subscriptions.push(releaseButtonItem);

    fetchButtonItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
    fetchButtonItem.command = 'vibesync.fetchNow';
    fetchButtonItem.tooltip = t('status.fetchTooltip');
    fetchButtonItem.text = t('status.fetch');
    fetchButtonItem.show();
    context.subscriptions.push(fetchButtonItem);
}

export function updateLockStatus(locks: lockManager.LockEntry[]): void {
    if (!lockStatusItem) { return; }

    const developer = lockManager.getDeveloperName();
    const otherLocks = locks.filter(l => l.developer !== developer);
    const myLocks = locks.filter(l => l.developer === developer);

    if (otherLocks.length === 0 && myLocks.length === 0) {
        lockStatusItem.text = t('status.free');
        lockStatusItem.backgroundColor = undefined;
    } else if (otherLocks.length > 0) {
        const first = otherLocks[0];
        const extra = otherLocks.length > 1 ? ` (+${otherLocks.length - 1})` : '';
        lockStatusItem.text = t('status.locked', first.file, first.developer, extra);
        lockStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        lockStatusItem.text = t('status.myLocks', myLocks.length);
        lockStatusItem.backgroundColor = undefined;
    }
}

export async function updateQueueCount(): Promise<void> {
    if (!queueCountItem) { return; }

    try {
        const result = await lockManager.listReleaseQueue();
        if (result.success) {
            const pending = result.queue.filter(q => !q.released);
            queueCountItem.text = t('status.queueCount', pending.length);

            if (pending.length > 0) {
                queueCountItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            } else {
                queueCountItem.backgroundColor = undefined;
            }
        }
    } catch {
        // silenzioso
    }
}

export function setOfflineStatus(): void {
    if (lockStatusItem) {
        lockStatusItem.text = t('status.offline');
        lockStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
}
