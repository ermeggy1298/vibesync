/**
 * VibeSync i18n — Internationalization module
 * Supports: Italian (it), English (en)
 */

import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Lang = 'it' | 'en';
export type TranslationKey = keyof typeof translations.it;

// ---------------------------------------------------------------------------
// Current language
// ---------------------------------------------------------------------------

let currentLang: Lang = 'it';

export function initLang(): void {
    currentLang = vscode.workspace.getConfiguration('vibesync')
        .get<string>('language', 'it') as Lang;
    if (currentLang !== 'en') { currentLang = 'it'; }
}

export function getLang(): Lang {
    return currentLang;
}

// ---------------------------------------------------------------------------
// Translation function
// ---------------------------------------------------------------------------

export function t(key: TranslationKey, ...args: (string | number)[]): string {
    const dict = translations[currentLang] || translations.it;
    let text: string = dict[key] || translations.it[key] || key;
    // Replace {0}, {1}, ... placeholders
    for (let i = 0; i < args.length; i++) {
        text = text.replace(`{${i}}`, String(args[i]));
    }
    return text;
}

/**
 * Returns all translations for the current language as a flat object.
 * Used to inject translations into webviews.
 */
export function getWebviewTranslations(): Record<string, string> {
    return { ...translations[currentLang] };
}

// ---------------------------------------------------------------------------
// Translation dictionaries
// ---------------------------------------------------------------------------

const translations = {

// ═══════════════════════════════════════════════════════════════════════════
// ITALIAN
// ═══════════════════════════════════════════════════════════════════════════
it: {
    // ── extension.ts ────────────────────────────────────────────────────
    'ext.configNotFound': 'VibeSync: config non trovata (~/.vibesync/config.json). Estensione disattivata.',
    'ext.fetchDone': 'VibeSync: fetch completato',
    'ext.manualLocksReleased': 'VibeSync: {0} lock manuali rilasciati',
    'ext.unlockError': 'VibeSync: errore sblocco — {0}',
    'ext.noStaleLocks': 'VibeSync: nessun lock scaduto',
    'ext.staleLocks': 'VibeSync: {0} lock scaduti. Vuoi forzare lo sblocco?',
    'ext.unlockAll': 'Sblocca tutti',
    'ext.cancel': 'Annulla',
    'ext.locksUnlocked': 'VibeSync: {0}/{1} lock sbloccati',

    // ── actionsProvider.ts ──────────────────────────────────────────────
    'actions.syncDashboard': 'Sync Dashboard',
    'actions.searchChats': 'Cerca nelle Chat',
    'actions.chatProjects': 'Progetti Chat',
    'actions.settings': 'Impostazioni',
    'actions.releaseFiles': 'Rilascia File',
    'actions.fetchGithub': 'Fetch da GitHub',
    'actions.unlockMyLocks': 'Sblocca i miei lock',

    // ── statusBar.ts ────────────────────────────────────────────────────
    'status.lockTooltip': 'VibeSync: stato lock file corrente',
    'status.free': '$(lock) VibeSync: Libero',
    'status.queueTooltip': 'VibeSync: file in coda per rilascio',
    'status.queueCount': '$(list-unordered) {0} in coda',
    'status.releaseTooltip': 'VibeSync: rilascia file su GitHub Desktop',
    'status.release': '$(cloud-upload) Rilascia',
    'status.fetchTooltip': 'VibeSync: fetch da GitHub e aggiorna stato',
    'status.fetch': '$(sync) Fetch',
    'status.locked': '$(lock) Locked: {0} ({1}){2}',
    'status.myLocks': '$(lock) I miei lock: {0}',
    'status.offline': '$(warning) VibeSync: Offline',

    // ── treeViewProvider.ts ─────────────────────────────────────────────
    'tree.openFile': 'Apri file',
    'tree.noLockedFiles': 'Nessun file lockato',
    'tree.noOtherLocks': 'Nessun lock da altri',
    'tree.expired': ' (SCADUTO)',
    'tree.noFilesToSync': 'Nessun file da sincronizzare',
    'tree.filesToSync': '{0} file da portare su GitHub Desktop',
    'tree.now': 'adesso',
    'tree.minAgo': '{0}min fa',
    'tree.hoursAgo': '{0}h fa',
    'tree.sourceLabel.cc': 'CC',
    'tree.sourceLabel.manual': '✋',
    'tree.lockDetail': '{0}, da {1}',
    'tree.lockDetailQueue': '{0}, lockato {1}',

    // ── fileWatcher.ts ──────────────────────────────────────────────────
    'fw.fileInUse': 'VibeSync: {0} è in uso da {1} (dalle {2}, source: {3}). Vuoi continuare comunque?',
    'fw.yesContinue': 'Sì, continua',
    'fw.showDetails': 'Mostra dettagli',
    'fw.lockDetails': 'Lock su {0}:\nDeveloper: {1}\nDa: {2}\nSessione: {3}\nSource: {4}',

    // ── notificationManager.ts ──────────────────────────────────────────
    'notify.startedWorking': 'VibeSync: {0} ha iniziato a lavorare su {1}',
    'notify.stoppedWorking': 'VibeSync: {0} ha terminato di lavorare su {1}',
    'notify.staleLocks': 'VibeSync: {0} lock scaduti (più vecchi di 24h)',
    'notify.cleanNow': 'Pulisci ora',

    // ── releasePanel.ts ─────────────────────────────────────────────────
    'rel.queueError': 'VibeSync: errore lettura coda — {0}',
    'rel.noFilesInQueue': 'VibeSync: nessun file in coda da rilasciare',
    'rel.today': 'oggi',
    'rel.daysAgo': '{0} giorni fa',
    'rel.selectFiles': 'Seleziona i file da copiare su GitHub Desktop',
    'rel.releaseTitle': 'VibeSync — Rilascio File',
    'rel.previewError': 'VibeSync: errore preview — {0}',
    'rel.diffTitle': '{0}: GitHub Desktop ↔ Locale',
    'rel.conflictsFound': 'VibeSync: {0} file hanno conflitti (diff aperti nell\'editor). Vuoi sovrascrivere?',
    'rel.overwriteAll': 'Sovrascrivi tutti',
    'rel.releaseCancelled': 'VibeSync: rilascio annullato',
    'rel.filesCopied': 'VibeSync: {0} file copiati in GitHub Desktop — pronti per commit',
    'rel.releaseErrors': 'VibeSync: errori durante il rilascio:\n{0}',
    'rel.noActiveLocks': 'VibeSync: nessun lock attivo',
    'rel.activeLocks': 'Lock attivi',
    'rel.activeLocksTitle': 'VibeSync — Lock Attivi',

    // ── configPanel.ts ──────────────────────────────────────────────────
    'cfg.title': 'VibeSync — Impostazioni',
    'cfg.saved': 'VibeSync: configurazione salvata',
    'cfg.saveError': 'VibeSync: errore salvataggio — {0}',
    'cfg.folderError': 'VibeSync: errore lettura cartelle — {0}',
    'cfg.selectFolder': 'VibeSync: seleziona cartella per {0}',
    'cfg.remove': 'Rimuovi',
    'cfg.showHide': '[mostra/nascondi]',
    'cfg.repoFormat': 'Formato: owner/repo',
    'cfg.devNameHint': 'Usato per identificare i lock',
    'cfg.localFolderHint': 'Cartella di sviluppo locale',
    'cfg.browse': 'Sfoglia...',
    'cfg.ghDesktopHint': 'Cartella del repo GitHub Desktop',
    'cfg.excludedDirs': 'Cartelle Escluse',
    'cfg.excludedDirsHint': 'Queste cartelle vengono ignorate da lock, sync e release',
    'cfg.addPlaceholder': 'Nome cartella da escludere...',
    'cfg.add': '+ Aggiungi',
    'cfg.browseFolders': 'Sfoglia cartelle',
    'cfg.saveConfig': 'Salva configurazione',
    'cfg.noChanges': 'Nessuna modifica',
    'cfg.unsavedChanges': 'Modifiche non salvate',
    'cfg.excluded': '✓ esclusa',
    'cfg.savedStatus': 'Salvato!',

    // ── syncPanel.ts ────────────────────────────────────────────────────
    'sync.title': 'VibeSync — Sync Dashboard',
    'sync.unknownError': 'Errore sconosciuto',
    'sync.noFilesSelected': 'VibeSync Sync: nessun file selezionato',
    'sync.confirmCopy': 'VibeSync Sync: copiare {0} file su GitHub Desktop?',
    'sync.copy': 'Copia',
    'sync.filesCopied': 'VibeSync Sync: {0} file copiati su GitHub Desktop e lock rilasciati',
    'sync.copyWithErrors': 'VibeSync Sync: {0} copiati, {1} errori',
    'sync.diffTitle': '{0}  (Locale tuo ← → GitHub Desktop)',
    'sync.addedToExclusions': 'VibeSync: "{0}" aggiunto alle esclusioni',
    'sync.configSaveError': 'VibeSync: errore salvataggio config — {0}',
    'sync.scanning': 'Scansione in corso...',
    'sync.errorPrefix': 'Errore: {0}',
    'sync.excludeFolder': 'Escludi questa cartella dal sync',
    'sync.excludeFolderBtn': '✕ Escludi cartella',
    'sync.openFile': 'Apri file',
    'sync.excludeFile': 'Escludi questo file dal sync',
    'sync.showDiff': 'Mostra diff',
    'sync.newFiles': 'File nuovi',
    'sync.modifiedFiles': 'File modificati',
    'sync.synced': 'Già sincronizzati',
    'sync.totalSize': 'Dimensione totale',
    'sync.rescan': '⟳ Riscansiona',
    'sync.selectAll': 'Seleziona tutti',
    'sync.deselectAll': 'Deseleziona tutti',
    'sync.newOnly': 'Solo nuovi',
    'sync.modifiedOnly': 'Solo modificati',
    'sync.copySelected': 'Copia selezionati ({0})',
    'sync.newFilesSection': 'File Nuovi',
    'sync.modifiedFilesSection': 'File Modificati',
    'sync.allSynced': 'Tutto sincronizzato, nulla da fare.',
    'sync.copying': 'Copia in corso...',
    'sync.filesSelected': '{0} file selezionati',
    'sync.copyingN': 'Copia di {0} file in corso...',

    // ── searchPanel.ts ──────────────────────────────────────────────────
    'search.panelTitle': 'VibeSync — Chat',
    'search.tabSearch': '🔍 Ricerca',
    'search.tabProjects': '📁 Progetti',
    'search.placeholder': 'Cerca nelle chat...',
    'search.searchBtn': 'Cerca',
    'search.projectLabel': 'Progetto Claude:',
    'search.allProjects': 'Tutti',
    'search.messagesLabel': 'Messaggi:',
    'search.msgAll': 'Tutti',
    'search.msgUser': 'User',
    'search.msgClaude': 'Claude',
    'search.searching': 'Ricerca in corso...',
    'search.enterKeyword': 'Inserisci una parola chiave e premi Cerca',
    'search.enterKeywordToSearch': 'Inserisci una parola chiave per cercare',
    'search.noResults': 'Nessun risultato per "{0}"',
    'search.resultsCount': '{0} risultati in {1} conversazioni per "{2}"',
    'search.noName': 'senza-nome',
    'search.resumeChat': '▶ Riprendi Chat',
    'search.projectBtn': '📁 Progetto',
    'search.newProject': '＋ Nuovo progetto',
    'search.loading': 'Caricamento...',
    'search.loadingChats': 'Caricamento chat...',
    'search.noProjects': 'Nessun progetto. Crea il primo con "＋ Nuovo".',
    'search.noChatsAssigned': 'Nessuna chat assegnata. Cercane una e assegnala con "📁 Progetto".',
    'search.unassigned': 'Senza progetto',
    'search.andMore': '... e altre {0} chat',
    'search.newBtn': '＋ Nuovo',
    'search.projectPlaceholder': 'Nome progetto...',
    'search.create': 'Crea',
    'search.removeFromProject': 'Rimuovi dal progetto',
    'search.resumeShort': '▶',
    'search.removeFrom': 'Rimuovi da {0}',
    'search.editMeta': 'Modifica titolo e descrizione',
    'search.titleLabel': 'Titolo',
    'search.titlePlaceholder': 'Titolo personalizzato...',
    'search.descLabel': 'Descrizione',
    'search.descPlaceholder': 'Max 50 caratteri...',
    'search.save': 'Salva',
    'search.removeTitle': 'Rimuovi titolo',
    'search.messages': 'messaggi',
    'search.chats': 'chat',
    'search.promptNewProject': 'Nome del nuovo progetto',
    'search.promptNewProjectPlaceholder': 'Es. Feature Login, Refactor API...',
    'search.promptRename': 'Nuovo nome per il progetto',
    'search.confirmDelete': 'Eliminare il progetto "{0}"? Le chat non verranno eliminate.',
    'search.delete': 'Elimina',
    'search.saveError': 'VibeSync: errore salvataggio progetti — {0}',
    'search.hideChat': 'Nascondi in VibeSync',
    'search.unhideChat': 'Mostra di nuovo',
    'search.deleteChat': 'Elimina definitivamente',
    'search.confirmDeleteChat': 'Eliminare DEFINITIVAMENTE la chat "{0}"? Il file .jsonl verrà cancellato e non sarà più recuperabile.',
    'search.showHidden': 'Mostra nascoste',
    'search.hideHidden': 'Nascondi',
    'search.hiddenCount': '{0} nascoste',
    'search.chatHidden': 'Chat nascosta',
    'search.chatDeleted': 'Chat eliminata',
},

// ═══════════════════════════════════════════════════════════════════════════
// ENGLISH
// ═══════════════════════════════════════════════════════════════════════════
en: {
    // ── extension.ts ────────────────────────────────────────────────────
    'ext.configNotFound': 'VibeSync: config not found (~/.vibesync/config.json). Extension disabled.',
    'ext.fetchDone': 'VibeSync: fetch completed',
    'ext.manualLocksReleased': 'VibeSync: {0} manual locks released',
    'ext.unlockError': 'VibeSync: unlock error — {0}',
    'ext.noStaleLocks': 'VibeSync: no stale locks',
    'ext.staleLocks': 'VibeSync: {0} stale locks found. Force unlock?',
    'ext.unlockAll': 'Unlock all',
    'ext.cancel': 'Cancel',
    'ext.locksUnlocked': 'VibeSync: {0}/{1} locks unlocked',

    // ── actionsProvider.ts ──────────────────────────────────────────────
    'actions.syncDashboard': 'Sync Dashboard',
    'actions.searchChats': 'Search Chats',
    'actions.chatProjects': 'Chat Projects',
    'actions.settings': 'Settings',
    'actions.releaseFiles': 'Release Files',
    'actions.fetchGithub': 'Fetch from GitHub',
    'actions.unlockMyLocks': 'Unlock my locks',

    // ── statusBar.ts ────────────────────────────────────────────────────
    'status.lockTooltip': 'VibeSync: current file lock status',
    'status.free': '$(lock) VibeSync: Free',
    'status.queueTooltip': 'VibeSync: files queued for release',
    'status.queueCount': '$(list-unordered) {0} queued',
    'status.releaseTooltip': 'VibeSync: release files to GitHub Desktop',
    'status.release': '$(cloud-upload) Release',
    'status.fetchTooltip': 'VibeSync: fetch from GitHub and update status',
    'status.fetch': '$(sync) Fetch',
    'status.locked': '$(lock) Locked: {0} ({1}){2}',
    'status.myLocks': '$(lock) My locks: {0}',
    'status.offline': '$(warning) VibeSync: Offline',

    // ── treeViewProvider.ts ─────────────────────────────────────────────
    'tree.openFile': 'Open file',
    'tree.noLockedFiles': 'No locked files',
    'tree.noOtherLocks': 'No locks by others',
    'tree.expired': ' (EXPIRED)',
    'tree.noFilesToSync': 'No files to sync',
    'tree.filesToSync': '{0} files to push to GitHub Desktop',
    'tree.now': 'now',
    'tree.minAgo': '{0}min ago',
    'tree.hoursAgo': '{0}h ago',
    'tree.sourceLabel.cc': 'CC',
    'tree.sourceLabel.manual': '✋',
    'tree.lockDetail': '{0}, since {1}',
    'tree.lockDetailQueue': '{0}, locked {1}',

    // ── fileWatcher.ts ──────────────────────────────────────────────────
    'fw.fileInUse': 'VibeSync: {0} is in use by {1} (since {2}, source: {3}). Continue anyway?',
    'fw.yesContinue': 'Yes, continue',
    'fw.showDetails': 'Show details',
    'fw.lockDetails': 'Lock on {0}:\nDeveloper: {1}\nSince: {2}\nSession: {3}\nSource: {4}',

    // ── notificationManager.ts ──────────────────────────────────────────
    'notify.startedWorking': 'VibeSync: {0} started working on {1}',
    'notify.stoppedWorking': 'VibeSync: {0} stopped working on {1}',
    'notify.staleLocks': 'VibeSync: {0} stale locks (older than 24h)',
    'notify.cleanNow': 'Clean now',

    // ── releasePanel.ts ─────────────────────────────────────────────────
    'rel.queueError': 'VibeSync: queue read error — {0}',
    'rel.noFilesInQueue': 'VibeSync: no files in queue to release',
    'rel.today': 'today',
    'rel.daysAgo': '{0} days ago',
    'rel.selectFiles': 'Select files to copy to GitHub Desktop',
    'rel.releaseTitle': 'VibeSync — Release Files',
    'rel.previewError': 'VibeSync: preview error — {0}',
    'rel.diffTitle': '{0}: GitHub Desktop ↔ Local',
    'rel.conflictsFound': 'VibeSync: {0} files have conflicts (diffs opened in editor). Overwrite?',
    'rel.overwriteAll': 'Overwrite all',
    'rel.releaseCancelled': 'VibeSync: release cancelled',
    'rel.filesCopied': 'VibeSync: {0} files copied to GitHub Desktop — ready to commit',
    'rel.releaseErrors': 'VibeSync: release errors:\n{0}',
    'rel.noActiveLocks': 'VibeSync: no active locks',
    'rel.activeLocks': 'Active locks',
    'rel.activeLocksTitle': 'VibeSync — Active Locks',

    // ── configPanel.ts ──────────────────────────────────────────────────
    'cfg.title': 'VibeSync — Settings',
    'cfg.saved': 'VibeSync: configuration saved',
    'cfg.saveError': 'VibeSync: save error — {0}',
    'cfg.folderError': 'VibeSync: folder read error — {0}',
    'cfg.selectFolder': 'VibeSync: select folder for {0}',
    'cfg.remove': 'Remove',
    'cfg.showHide': '[show/hide]',
    'cfg.repoFormat': 'Format: owner/repo',
    'cfg.devNameHint': 'Used to identify your locks',
    'cfg.localFolderHint': 'Local development folder',
    'cfg.browse': 'Browse...',
    'cfg.ghDesktopHint': 'GitHub Desktop repo folder',
    'cfg.excludedDirs': 'Excluded Folders',
    'cfg.excludedDirsHint': 'These folders are ignored by lock, sync and release',
    'cfg.addPlaceholder': 'Folder name to exclude...',
    'cfg.add': '+ Add',
    'cfg.browseFolders': 'Browse folders',
    'cfg.saveConfig': 'Save configuration',
    'cfg.noChanges': 'No changes',
    'cfg.unsavedChanges': 'Unsaved changes',
    'cfg.excluded': '✓ excluded',
    'cfg.savedStatus': 'Saved!',

    // ── syncPanel.ts ────────────────────────────────────────────────────
    'sync.title': 'VibeSync — Sync Dashboard',
    'sync.unknownError': 'Unknown error',
    'sync.noFilesSelected': 'VibeSync Sync: no files selected',
    'sync.confirmCopy': 'VibeSync Sync: copy {0} files to GitHub Desktop?',
    'sync.copy': 'Copy',
    'sync.filesCopied': 'VibeSync Sync: {0} files copied to GitHub Desktop and locks released',
    'sync.copyWithErrors': 'VibeSync Sync: {0} copied, {1} errors',
    'sync.diffTitle': '{0}  (Your local ← → GitHub Desktop)',
    'sync.addedToExclusions': 'VibeSync: "{0}" added to exclusions',
    'sync.configSaveError': 'VibeSync: config save error — {0}',
    'sync.scanning': 'Scanning...',
    'sync.errorPrefix': 'Error: {0}',
    'sync.excludeFolder': 'Exclude this folder from sync',
    'sync.excludeFolderBtn': '✕ Exclude folder',
    'sync.openFile': 'Open file',
    'sync.excludeFile': 'Exclude this file from sync',
    'sync.showDiff': 'Show diff',
    'sync.newFiles': 'New files',
    'sync.modifiedFiles': 'Modified files',
    'sync.synced': 'Already synced',
    'sync.totalSize': 'Total size',
    'sync.rescan': '⟳ Rescan',
    'sync.selectAll': 'Select all',
    'sync.deselectAll': 'Deselect all',
    'sync.newOnly': 'New only',
    'sync.modifiedOnly': 'Modified only',
    'sync.copySelected': 'Copy selected ({0})',
    'sync.newFilesSection': 'New Files',
    'sync.modifiedFilesSection': 'Modified Files',
    'sync.allSynced': 'All synced, nothing to do.',
    'sync.copying': 'Copying...',
    'sync.filesSelected': '{0} files selected',
    'sync.copyingN': 'Copying {0} files...',

    // ── searchPanel.ts ──────────────────────────────────────────────────
    'search.panelTitle': 'VibeSync — Chat',
    'search.tabSearch': '🔍 Search',
    'search.tabProjects': '📁 Projects',
    'search.placeholder': 'Search in chats...',
    'search.searchBtn': 'Search',
    'search.projectLabel': 'Claude project:',
    'search.allProjects': 'All',
    'search.messagesLabel': 'Messages:',
    'search.msgAll': 'All',
    'search.msgUser': 'User',
    'search.msgClaude': 'Claude',
    'search.searching': 'Searching...',
    'search.enterKeyword': 'Enter a keyword and press Search',
    'search.enterKeywordToSearch': 'Enter a keyword to search',
    'search.noResults': 'No results for "{0}"',
    'search.resultsCount': '{0} results in {1} conversations for "{2}"',
    'search.noName': 'unnamed',
    'search.resumeChat': '▶ Resume Chat',
    'search.projectBtn': '📁 Project',
    'search.newProject': '＋ New project',
    'search.loading': 'Loading...',
    'search.loadingChats': 'Loading chats...',
    'search.noProjects': 'No projects. Create one with "＋ New".',
    'search.noChatsAssigned': 'No chats assigned. Search for one and assign it with "📁 Project".',
    'search.unassigned': 'Unassigned',
    'search.andMore': '... and {0} more chats',
    'search.newBtn': '＋ New',
    'search.projectPlaceholder': 'Project name...',
    'search.create': 'Create',
    'search.removeFromProject': 'Remove from project',
    'search.resumeShort': '▶',
    'search.removeFrom': 'Remove from {0}',
    'search.editMeta': 'Edit title and description',
    'search.titleLabel': 'Title',
    'search.titlePlaceholder': 'Custom title...',
    'search.descLabel': 'Description',
    'search.descPlaceholder': 'Max 50 characters...',
    'search.save': 'Save',
    'search.removeTitle': 'Remove title',
    'search.messages': 'messages',
    'search.chats': 'chats',
    'search.promptNewProject': 'New project name',
    'search.promptNewProjectPlaceholder': 'E.g. Feature Login, Refactor API...',
    'search.promptRename': 'New project name',
    'search.confirmDelete': 'Delete project "{0}"? Chats will not be deleted.',
    'search.delete': 'Delete',
    'search.saveError': 'VibeSync: project save error — {0}',
    'search.hideChat': 'Hide in VibeSync',
    'search.unhideChat': 'Show again',
    'search.deleteChat': 'Delete permanently',
    'search.confirmDeleteChat': 'PERMANENTLY delete the chat "{0}"? The .jsonl file will be removed and cannot be recovered.',
    'search.showHidden': 'Show hidden',
    'search.hideHidden': 'Hide',
    'search.hiddenCount': '{0} hidden',
    'search.chatHidden': 'Chat hidden',
    'search.chatDeleted': 'Chat deleted',
},

} as const;
