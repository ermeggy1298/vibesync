/**
 * VibeSync Actions Provider
 * Sezione sidebar con link rapidi.
 * Mostra azioni diverse in base alla presenza del config (Chat-only vs Full mode).
 */

import * as vscode from 'vscode';
import { t } from './i18n';

class ActionItem extends vscode.TreeItem {
    constructor(
        label: string,
        icon: string,
        commandId: string,
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon);
        this.command = { command: commandId, title: label };
    }
}

export class ActionsProvider implements vscode.TreeDataProvider<ActionItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ActionItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly fullMode: boolean = false) {}

    refresh(): void { this._onDidChangeTreeData.fire(); }

    getTreeItem(element: ActionItem): vscode.TreeItem {
        return element;
    }

    async getChildren(): Promise<ActionItem[]> {
        // Chat Manager — always available, no config needed
        const items: ActionItem[] = [
            new ActionItem(t('actions.searchChats'), 'search', 'vibesync.searchChats'),
            new ActionItem(t('actions.chatProjects'), 'folder-library', 'vibesync.chatProjects'),
        ];

        // Full mode — locking, sync, release (requires config)
        if (this.fullMode) {
            items.push(
                new ActionItem(t('actions.syncDashboard'), 'sync', 'vibesync.syncDashboard'),
                new ActionItem(t('actions.releaseFiles'), 'cloud-upload', 'vibesync.release'),
                new ActionItem(t('actions.fetchGithub'), 'cloud-download', 'vibesync.fetchNow'),
                new ActionItem(t('actions.unlockMyLocks'), 'unlock', 'vibesync.unlockMyFiles'),
            );
        }

        // Settings — always available
        items.push(new ActionItem(t('actions.settings'), 'gear', 'vibesync.settings'));

        return items;
    }
}
