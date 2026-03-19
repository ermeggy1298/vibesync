/**
 * VibeSync Lock Manager
 * Chiama gli script Python vibesync_lock.py e vibesync_release.py
 * e gestisce lo stato dei lock in memoria.
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Tipi
// ---------------------------------------------------------------------------

export interface LockEntry {
    file: string;
    developer: string;
    timestamp: string;
    session_id: string;
    source: 'claude_code' | 'manual';
}

export interface LockCheckResult {
    success: boolean;
    locked?: boolean;
    developer?: string;
    timestamp?: string;
    session_id?: string;
    source?: string;
    is_own_lock?: boolean;
    error?: string;
}

export interface LockActionResult {
    success: boolean;
    action?: string;
    file?: string;
    developer?: string;
    session_id?: string;
    released?: string[];
    error?: string;
}

export interface ReleaseQueueItem {
    file: string;
    local_path: string;
    github_desktop_path: string;
    modified_at: string;
    days_ago: number;
    released: boolean;
    released_at?: string | null;
}

export interface ReleaseListResult {
    success: boolean;
    queue: ReleaseQueueItem[];
    error?: string;
}

export interface PreviewItem {
    file: string;
    status: 'conflict' | 'new' | 'identical' | 'error';
    diff: string | null;
    local_lines: number;
    github_lines: number;
    error?: string;
}

export interface PreviewResult {
    success: boolean;
    previews: PreviewItem[];
    error?: string;
}

export interface ReleaseResult {
    success: boolean;
    copied: string[];
    errors: { file: string; error: string }[];
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface VibesyncConfig {
    github_token: string;
    github_repo: string;
    github_branch: string;
    github_lock_branch?: string;
    developer_name: string;
    local_root: string;
    github_desktop_root: string;
    excluded_dirs?: string[];
    excluded_files?: string[];
}

let cachedConfig: VibesyncConfig | null = null;

export function loadConfig(): VibesyncConfig | null {
    try {
        const configPath = path.join(os.homedir(), '.vibesync', 'config.json');
        const raw = fs.readFileSync(configPath, 'utf-8');
        cachedConfig = JSON.parse(raw);
        return cachedConfig;
    } catch {
        return null;
    }
}

export function getConfig(): VibesyncConfig | null {
    return cachedConfig ?? loadConfig();
}

export function getDeveloperName(): string {
    return getConfig()?.developer_name ?? 'Unknown';
}

export function getLocalRoot(): string {
    return getConfig()?.local_root ?? '';
}

// ---------------------------------------------------------------------------
// Script paths
// ---------------------------------------------------------------------------

function getPythonPath(): string {
    return vscode.workspace.getConfiguration('vibesync').get<string>('pythonPath') || 'python';
}

function getLockScriptPath(): string {
    const configured = vscode.workspace.getConfiguration('vibesync').get<string>('lockScriptPath');
    if (configured) { return configured; }

    // Auto-detect: cerca vibesync_lock.py relativo al local_root
    const config = getConfig();
    if (config) {
        return path.join(config.local_root, 'vibesync', 'vibesync_lock.py');
    }
    return 'vibesync_lock.py';
}

function getReleaseScriptPath(): string {
    const configured = vscode.workspace.getConfiguration('vibesync').get<string>('releaseScriptPath');
    if (configured) { return configured; }

    const config = getConfig();
    if (config) {
        return path.join(config.local_root, 'vibesync', 'vibesync_release.py');
    }
    return 'vibesync_release.py';
}

// ---------------------------------------------------------------------------
// Esecuzione script Python
// ---------------------------------------------------------------------------

function runPythonScript(scriptPath: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const pythonPath = getPythonPath();
        const proc = cp.spawn(pythonPath, [scriptPath, ...args], {
            cwd: getLocalRoot() || undefined,
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data: Buffer) => {
            stdout += data.toString();
        });

        proc.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        proc.on('close', (code: number | null) => {
            if (code === 0 || stdout.trim()) {
                resolve(stdout.trim());
            } else {
                reject(new Error(stderr.trim() || `Exit code ${code}`));
            }
        });

        proc.on('error', (err: Error) => {
            reject(err);
        });

        // Timeout 15 secondi
        setTimeout(() => {
            proc.kill();
            reject(new Error('Timeout'));
        }, 15000);
    });
}

function parseJsonOutput<T>(output: string): T {
    return JSON.parse(output) as T;
}

// ---------------------------------------------------------------------------
// Comandi Lock
// ---------------------------------------------------------------------------

export async function checkLock(fileRel: string): Promise<LockCheckResult> {
    try {
        const output = await runPythonScript(getLockScriptPath(), ['--check', fileRel]);
        return parseJsonOutput<LockCheckResult>(output);
    } catch (err: any) {
        return { success: false, error: err.message };
    }
}

export async function acquireLock(fileRel: string): Promise<LockActionResult> {
    try {
        const output = await runPythonScript(getLockScriptPath(), ['--lock', fileRel]);
        return parseJsonOutput<LockActionResult>(output);
    } catch (err: any) {
        return { success: false, error: err.message };
    }
}

export async function releaseLock(fileRel: string): Promise<LockActionResult> {
    try {
        const output = await runPythonScript(getLockScriptPath(), ['--unlock', fileRel]);
        return parseJsonOutput<LockActionResult>(output);
    } catch (err: any) {
        return { success: false, error: err.message };
    }
}

export async function releaseAllManualLocks(): Promise<LockActionResult> {
    try {
        const output = await runPythonScript(getLockScriptPath(), ['--unlock-all']);
        return parseJsonOutput<LockActionResult>(output);
    } catch (err: any) {
        return { success: false, error: err.message };
    }
}

// ---------------------------------------------------------------------------
// Comandi Release
// ---------------------------------------------------------------------------

export async function listReleaseQueue(): Promise<ReleaseListResult> {
    try {
        const output = await runPythonScript(getReleaseScriptPath(), ['--list']);
        return parseJsonOutput<ReleaseListResult>(output);
    } catch (err: any) {
        return { success: false, queue: [], error: err.message };
    }
}

export async function previewRelease(files: string[]): Promise<PreviewResult> {
    try {
        const output = await runPythonScript(getReleaseScriptPath(), ['--preview', ...files]);
        return parseJsonOutput<PreviewResult>(output);
    } catch (err: any) {
        return { success: false, previews: [], error: err.message };
    }
}

export async function releaseFiles(files: string[]): Promise<ReleaseResult> {
    try {
        const output = await runPythonScript(getReleaseScriptPath(), ['--release', ...files]);
        return parseJsonOutput<ReleaseResult>(output);
    } catch (err: any) {
        return { success: false, copied: [], errors: [{ file: '*', error: err.message }] };
    }
}

// ---------------------------------------------------------------------------
// Stato lock in memoria (per polling e notifiche)
// ---------------------------------------------------------------------------

export interface LocksState {
    locks: LockEntry[];
    fetchedAt: string;
}

let currentLocksState: LocksState = { locks: [], fetchedAt: '' };

export function getCurrentLocks(): LocksState {
    return currentLocksState;
}

export async function fetchLocksFromGitHub(): Promise<LocksState> {
    const config = getConfig();
    if (!config) {
        return { locks: [], fetchedAt: new Date().toISOString() };
    }

    try {
        const lockBranch = config.github_lock_branch || config.github_branch;
        const url = `https://api.github.com/repos/${config.github_repo}/contents/LOCKS.json?ref=${lockBranch}`;

        const response = await fetch(url, {
            headers: {
                'Authorization': `token ${config.github_token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'VibeSync-VSCode/1.0',
            },
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json() as any;
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        const locksData = JSON.parse(content);

        currentLocksState = {
            locks: locksData.locks || [],
            fetchedAt: new Date().toISOString(),
        };

        return currentLocksState;
    } catch {
        return currentLocksState; // ritorna l'ultimo stato noto
    }
}

// ---------------------------------------------------------------------------
// Utility path
// ---------------------------------------------------------------------------

export function getRelativePath(absolutePath: string): string | null {
    const config = getConfig();
    if (!config) { return null; }

    const localRoot = config.local_root.replace(/\\/g, '/').toLowerCase();
    const filePath = absolutePath.replace(/\\/g, '/').toLowerCase();

    if (!filePath.startsWith(localRoot)) { return null; }

    const rel = absolutePath.replace(/\\/g, '/').substring(config.local_root.length).replace(/^\//, '');
    return rel;
}

const DEFAULT_EXCLUDED_DIRS = new Set([
    '__pycache__', 'node_modules', '.git', '.next', 'dist', 'build',
    '.venv', 'venv', 'env', '.env', '.tox', '.pytest_cache', '.mypy_cache',
]);

function getExclusions(): { simple: Set<string>; prefixes: string[] } {
    const config = getConfig();
    const custom = config?.excluded_dirs ?? [];
    const simple = new Set(DEFAULT_EXCLUDED_DIRS);
    const prefixes: string[] = [];
    for (const d of custom) {
        const dl = d.toLowerCase().replace(/\\/g, '/');
        if (dl.includes('/')) {
            prefixes.push(dl.replace(/\/$/, '') + '/');
        } else {
            simple.add(dl);
        }
    }
    return { simple, prefixes };
}

const EXCLUDED_EXTENSIONS = new Set([
    '.pyc', '.pyo', '.log', '.tmp', '.cache', '.map',
    '.sqlite3', '.db', '.swp', '.swo',
]);

export function shouldProtect(absolutePath: string): boolean {
    const rel = getRelativePath(absolutePath);
    if (!rel) { return false; }

    const relLower = rel.toLowerCase();
    const { simple, prefixes } = getExclusions();
    for (const prefix of prefixes) {
        if (relLower.startsWith(prefix)) { return false; }
    }
    const parts = rel.split('/');
    for (const part of parts) {
        if (simple.has(part.toLowerCase())) { return false; }
    }

    const ext = path.extname(absolutePath).toLowerCase();
    if (EXCLUDED_EXTENSIONS.has(ext)) { return false; }

    return true;
}
