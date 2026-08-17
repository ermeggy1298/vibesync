/**
 * VibeSync — Telegram notifications
 * Manda un messaggio Telegram ai recipient configurati quando vengono
 * rilasciati file su git dalla Sync Dashboard.
 *
 * Setup utente:
 *  1. crea un bot con @BotFather, ottieni bot_token
 *  2. ogni dev manda /start al bot e legge il proprio chat_id (es. via @userinfobot
 *     oppure curl https://api.telegram.org/bot<TOKEN>/getUpdates)
 *  3. inserisce token + recipients in ~/.vibesync/config.json → notifications.telegram
 */

import * as https from 'https';
import * as lockManager from './lockManager';

interface TelegramApiResponse {
    ok: boolean;
    description?: string;
}

function postTelegram(botToken: string, chatId: string, text: string): Promise<TelegramApiResponse> {
    return new Promise((resolve) => {
        const body = JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true });
        const options = {
            hostname: 'api.telegram.org',
            path: `/bot${botToken}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { resolve({ ok: false, description: 'invalid JSON from Telegram' }); }
            });
        });
        req.on('error', (err) => resolve({ ok: false, description: err.message }));
        req.setTimeout(10000, () => { req.destroy(); resolve({ ok: false, description: 'timeout' }); });
        req.write(body);
        req.end();
    });
}

function buildReleaseMessage(developer: string, branch: string, files: string[]): string {
    const MAX_FILES = 25;
    const shown = files.slice(0, MAX_FILES);
    const overflow = files.length - shown.length;

    const lines: string[] = [];
    lines.push(`🚀 VibeSync — Release su "${branch}"`);
    lines.push(`👤 ${developer} ha rilasciato ${files.length} file:`);
    lines.push('');
    for (const f of shown) { lines.push(`• ${f}`); }
    if (overflow > 0) { lines.push(`… e altri ${overflow} file`); }
    return lines.join('\n');
}

export interface NotifyResult {
    sent: number;
    failed: { name: string; error: string }[];
    skipped: string;
}

export async function notifyRelease(files: string[]): Promise<NotifyResult> {
    if (files.length === 0) { return { sent: 0, failed: [], skipped: 'no files' }; }

    const config = lockManager.getConfig();
    const tg = config?.notifications?.telegram;
    if (!config || !tg || !tg.bot_token || !Array.isArray(tg.recipients) || tg.recipients.length === 0) {
        return { sent: 0, failed: [], skipped: 'telegram not configured' };
    }

    const developer = config.developer_name || 'Unknown';
    const branch = config.github_branch || 'unknown';
    const message = buildReleaseMessage(developer, branch, files);

    const notifySelf = tg.notify_self === true;
    const targets = tg.recipients.filter(r =>
        notifySelf || r.name.toLowerCase() !== developer.toLowerCase()
    );

    const results = await Promise.all(targets.map(async (r) => {
        const res = await postTelegram(tg.bot_token, r.chat_id, message);
        return { recipient: r, res };
    }));

    let sent = 0;
    const failed: { name: string; error: string }[] = [];
    for (const { recipient, res } of results) {
        if (res.ok) { sent++; }
        else { failed.push({ name: recipient.name, error: res.description || 'unknown' }); }
    }
    return { sent, failed, skipped: '' };
}

export async function sendTestMessage(): Promise<NotifyResult> {
    const config = lockManager.getConfig();
    const tg = config?.notifications?.telegram;
    if (!config || !tg || !tg.bot_token || !Array.isArray(tg.recipients) || tg.recipients.length === 0) {
        return { sent: 0, failed: [], skipped: 'telegram not configured' };
    }

    const developer = config.developer_name || 'Unknown';
    const text = `🧪 VibeSync — Test notification\n👤 from ${developer}\n\nSe leggi questo messaggio, le notifiche Telegram funzionano.`;

    const results = await Promise.all(tg.recipients.map(async (r) => {
        const res = await postTelegram(tg.bot_token, r.chat_id, text);
        return { recipient: r, res };
    }));

    let sent = 0;
    const failed: { name: string; error: string }[] = [];
    for (const { recipient, res } of results) {
        if (res.ok) { sent++; }
        else { failed.push({ name: recipient.name, error: res.description || 'unknown' }); }
    }
    return { sent, failed, skipped: '' };
}
