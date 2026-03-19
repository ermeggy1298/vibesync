/**
 * VibeSync TreeView Provider
 * Dashboard laterale con 3 sezioni: I Miei Lock, Lock di Altri, Coda Rilascio.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as lockManager from './lockManager';
import { t, getLang } from './i18n';

// ---------------------------------------------------------------------------
// TreeItem
// ---------------------------------------------------------------------------

class VibesyncTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly itemType: 'lock' | 'queue' | 'header',
        public readonly filePath?: string,
        public readonly detail?: string,
    ) {
        super(label, collapsibleState);

        if (filePath) {
            this.tooltip = `${filePath}\n${detail || ''}`;
            this.command = {
                command: 'vscode.open',
                title: t('tree.openFile'),
                arguments: [vscode.Uri.file(filePath)],
            };
        }
    }
}

// ---------------------------------------------------------------------------
// My Locks Provider
// ---------------------------------------------------------------------------

export class MyLocksProvider implements vscode.TreeDataProvider<VibesyncTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<VibesyncTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void { this._onDidChangeTreeData.fire(); }
    getTreeItem(element: VibesyncTreeItem): vscode.TreeItem { return element; }

    async getChildren(): Promise<VibesyncTreeItem[]> {
        const state = lockManager.getCurrentLocks();
        const developer = lockManager.getDeveloperName();
        const localRoot = lockManager.getLocalRoot();
        const myLocks = state.locks.filter(l => l.developer === developer);

        if (myLocks.length === 0) {
            const item = new VibesyncTreeItem(t('tree.noLockedFiles'), vscode.TreeItemCollapsibleState.None, 'header');
            item.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
            return [item];
        }

        return myLocks.map(lock => {
            const sourceLabel = lock.source === 'claude_code' ? t('tree.sourceLabel.cc') : '✋';
            const timeStr = formatTime(lock.timestamp);
            const fullPath = path.join(localRoot, lock.file);

            const item = new VibesyncTreeItem(lock.file, vscode.TreeItemCollapsibleState.None, 'lock', fullPath, t('tree.lockDetail', sourceLabel, timeStr));
            item.description = `${sourceLabel}, ${timeStr}`;
            item.iconPath = new vscode.ThemeIcon('lock', new vscode.ThemeColor('testing.iconPassed'));
            item.contextValue = 'myLock';
            return item;
        });
    }
}

// ---------------------------------------------------------------------------
// Other Locks Provider
// ---------------------------------------------------------------------------

export class OtherLocksProvider implements vscode.TreeDataProvider<VibesyncTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<VibesyncTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void { this._onDidChangeTreeData.fire(); }
    getTreeItem(element: VibesyncTreeItem): vscode.TreeItem { return element; }

    async getChildren(): Promise<VibesyncTreeItem[]> {
        const state = lockManager.getCurrentLocks();
        const developer = lockManager.getDeveloperName();
        const localRoot = lockManager.getLocalRoot();
        const otherLocks = state.locks.filter(l => l.developer !== developer);

        if (otherLocks.length === 0) {
            const item = new VibesyncTreeItem(t('tree.noOtherLocks'), vscode.TreeItemCollapsibleState.None, 'header');
            item.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
            return [item];
        }

        return otherLocks.map(lock => {
            const sourceLabel = lock.source === 'claude_code' ? t('tree.sourceLabel.cc') : '✋';
            const timeStr = formatTime(lock.timestamp);
            const fullPath = path.join(localRoot, lock.file);

            const item = new VibesyncTreeItem(lock.file, vscode.TreeItemCollapsibleState.None, 'lock', fullPath, `${lock.developer}, ${sourceLabel}, ${timeStr}`);
            item.description = `${lock.developer}, ${timeStr}`;
            item.iconPath = new vscode.ThemeIcon('lock', new vscode.ThemeColor('testing.iconFailed'));

            const lockAge = Date.now() - new Date(lock.timestamp).getTime();
            if (lockAge > 24 * 60 * 60 * 1000) {
                item.description += t('tree.expired');
                item.contextValue = 'staleLock';
            }

            return item;
        });
    }
}

// ---------------------------------------------------------------------------
// Release Queue Provider
// ---------------------------------------------------------------------------

export class ReleaseQueueProvider implements vscode.TreeDataProvider<VibesyncTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<VibesyncTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void { this._onDidChangeTreeData.fire(); }
    getTreeItem(element: VibesyncTreeItem): vscode.TreeItem { return element; }

    async getChildren(): Promise<VibesyncTreeItem[]> {
        const state = lockManager.getCurrentLocks();
        const developer = lockManager.getDeveloperName();
        const localRoot = lockManager.getLocalRoot();
        const myLocks = state.locks.filter(l => l.developer === developer);

        if (myLocks.length === 0) {
            const item = new VibesyncTreeItem(t('tree.noFilesToSync'), vscode.TreeItemCollapsibleState.None, 'header');
            item.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
            return [item];
        }

        const header = new VibesyncTreeItem(t('tree.filesToSync', myLocks.length), vscode.TreeItemCollapsibleState.None, 'header');
        header.iconPath = new vscode.ThemeIcon('cloud-upload', new vscode.ThemeColor('editorWarning.foreground'));

        const items: VibesyncTreeItem[] = [header];

        for (const lock of myLocks) {
            const fullPath = path.join(localRoot, lock.file);
            const timeStr = formatTime(lock.timestamp);
            const sourceLabel = lock.source === 'claude_code' ? t('tree.sourceLabel.cc') : '✋';

            const item = new VibesyncTreeItem(lock.file, vscode.TreeItemCollapsibleState.None, 'queue', fullPath, t('tree.lockDetailQueue', sourceLabel, timeStr));
            item.description = `${sourceLabel}, ${timeStr}`;
            item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('editorWarning.foreground'));
            items.push(item);
        }

        return items;
    }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function formatTime(isoTimestamp: string): string {
    try {
        const date = new Date(isoTimestamp);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMin = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);

        if (diffMin < 1) { return t('tree.now'); }
        if (diffMin < 60) { return t('tree.minAgo', diffMin); }
        if (diffHours < 24) { return t('tree.hoursAgo', diffHours); }

        const locale = getLang() === 'en' ? 'en-GB' : 'it-IT';
        return date.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch {
        return isoTimestamp;
    }
}
