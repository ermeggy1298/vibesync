/**
 * VibeBuddy Engine
 * Calls Claude Haiku API to generate Buddy's commentary based on coding events.
 */

import * as vscode from 'vscode';
import * as https from 'https';
import { getLang } from './i18n';
import { setBuddyState, sendBuddyMessage, sendBuddyTokenUpdate } from './buddyPanel';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CodingEvent {
    type: 'edit' | 'stop' | 'welcome_back';
    files?: string[];
    tools?: string[];
    linesAdded?: number;
    linesRemoved?: number;
    duration?: number;
    previousContext?: string;
}

interface BuddyResponse {
    message: string;
    emotion: 'idle' | 'smile' | 'thinking' | 'talking' | 'surprise' | 'warning';
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let lastActivityTime = Date.now();
let sessionFiles: Set<string> = new Set();
let sessionEdits = 0;
let sessionLinesAdded = 0;
let sessionLinesRemoved = 0;
const WELCOME_BACK_THRESHOLD = 15 * 60 * 1000; // 15 minutes

// Token tracking
let totalInputTokens = 0;
let totalOutputTokens = 0;
let totalCalls = 0;

// Haiku pricing (per million tokens)
const HAIKU_INPUT_PRICE = 0.80;   // $/1M input tokens
const HAIKU_OUTPUT_PRICE = 4.00;  // $/1M output tokens

function getEstimatedCost(): number {
    return (totalInputTokens / 1_000_000) * HAIKU_INPUT_PRICE
         + (totalOutputTokens / 1_000_000) * HAIKU_OUTPUT_PRICE;
}

function updateTokenDisplay(): void {
    sendBuddyTokenUpdate(totalInputTokens, totalOutputTokens, totalCalls, getEstimatedCost());
}

// ---------------------------------------------------------------------------
// API Configuration
// ---------------------------------------------------------------------------

function getApiKey(): string {
    return vscode.workspace.getConfiguration('vibesync').get<string>('anthropicApiKey', '');
}

function getVerbosity(): string {
    return vscode.workspace.getConfiguration('vibesync').get<string>('buddyVerbosity', 'normal');
}

function getSystemPrompt(): string {
    const lang = getLang();
    const verbosity = getVerbosity();
    const langInstruction = lang === 'it'
        ? 'You MUST speak in Italian.'
        : 'You MUST speak in English.';

    const verbosityInstruction = {
        quiet: 'Be extremely concise: max 1 short sentence. Only mention the most important fact.',
        normal: 'Be concise: max 2 sentences. Mention what changed and why it matters.',
        chatty: 'Be descriptive: 2-3 sentences. Explain what changed, why it matters, and add a relevant observation or suggestion.',
    }[verbosity] || 'Be concise: max 2 sentences.';

    return `You are VibeBuddy, an AI companion inside VS Code.
You observe a developer's coding session and narrate what's happening.

Personality: intellectual, precise, approachable. Like a brilliant senior developer colleague.
Occasional dry humor is welcome but never forced.
${langInstruction}
${verbosityInstruction}

RULES:
- Never suggest code changes. Only observe and explain.
- Never be annoying or state the obvious.
- Never repeat information you already said.
- Focus on WHAT changed and WHY it matters architecturally.
- If the change touches critical files (auth, middleware, database models), flag it.`;
}

// ---------------------------------------------------------------------------
// Haiku API Call
// ---------------------------------------------------------------------------

function callHaiku(eventDescription: string): Promise<BuddyResponse> {
    return new Promise((resolve, reject) => {
        const apiKey = getApiKey();
        if (!apiKey) {
            reject(new Error('No Anthropic API key configured'));
            return;
        }

        const body = JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 200,
            system: getSystemPrompt(),
            messages: [
                {
                    role: 'user',
                    content: `EVENT:\n${eventDescription}\n\nRespond with a JSON object: {"message": "your commentary", "emotion": "idle|smile|thinking|talking|surprise|warning"}`
                }
            ],
        });

        const options = {
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Length': Buffer.byteLength(body),
            },
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    if (response.error) {
                        reject(new Error(response.error.message || 'API error'));
                        return;
                    }

                    // Track tokens
                    if (response.usage) {
                        totalInputTokens += response.usage.input_tokens || 0;
                        totalOutputTokens += response.usage.output_tokens || 0;
                        totalCalls++;
                        updateTokenDisplay();
                    }

                    const text = response.content?.[0]?.text || '';
                    const jsonMatch = text.match(/\{[\s\S]*?"message"[\s\S]*?"emotion"[\s\S]*?\}/);
                    if (jsonMatch) {
                        const parsed = JSON.parse(jsonMatch[0]);
                        resolve({
                            message: parsed.message || text,
                            emotion: parsed.emotion || 'talking',
                        });
                    } else {
                        resolve({ message: text, emotion: 'talking' });
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(body);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Event Handlers (called from hooks/extension)
// ---------------------------------------------------------------------------

/**
 * Called when Claude Code starts editing a file (PreToolUse)
 */
export async function onFileEdit(file: string, tool: string): Promise<void> {
    const verbosity = getVerbosity();

    // Check for welcome back
    const timeSinceActivity = Date.now() - lastActivityTime;
    if (timeSinceActivity > WELCOME_BACK_THRESHOLD && sessionFiles.size > 0) {
        await handleWelcomeBack();
    }

    lastActivityTime = Date.now();
    sessionFiles.add(file);
    sessionEdits++;

    // In quiet mode, don't comment on individual edits
    if (verbosity === 'quiet') {
        setBuddyState('thinking');
        return;
    }

    // In normal mode, only comment on the first edit or every 5th
    if (verbosity === 'normal' && sessionEdits > 1 && sessionEdits % 5 !== 0) {
        setBuddyState('thinking');
        return;
    }

    setBuddyState('thinking');

    try {
        const result = await callHaiku(
            `Claude Code is editing file: ${file}\n` +
            `Tool used: ${tool}\n` +
            `Files touched in this session so far: ${[...sessionFiles].join(', ')}\n` +
            `Total edits so far: ${sessionEdits}`
        );
        setBuddyState(result.emotion as any);
        sendBuddyMessage(result.message, result.emotion);
    } catch (err) {
        // Silent — don't bother the user with Buddy errors
        console.log('[VibeBuddy] Haiku error:', err);
        setBuddyState('idle');
    }
}

/**
 * Called when Claude Code finishes (Stop hook)
 */
export async function onSessionStop(filesModified: string[], linesAdded: number, linesRemoved: number): Promise<void> {
    lastActivityTime = Date.now();

    if (filesModified.length === 0 && sessionFiles.size === 0) {
        setBuddyState('idle');
        return;
    }

    const allFiles = new Set([...sessionFiles, ...filesModified]);

    setBuddyState('talking');

    try {
        const result = await callHaiku(
            `Claude Code finished a coding session.\n` +
            `Files modified: ${[...allFiles].join(', ')}\n` +
            `Lines added: +${linesAdded || sessionLinesAdded}\n` +
            `Lines removed: -${linesRemoved || sessionLinesRemoved}\n` +
            `Total edits: ${sessionEdits}`
        );
        setBuddyState(result.emotion as any);
        sendBuddyMessage(result.message, result.emotion);
    } catch (err) {
        console.log('[VibeBuddy] Haiku error:', err);
        setBuddyState('smile');
        // Fallback message without API
        const lang = getLang();
        const msg = lang === 'it'
            ? `Sessione completata. ${allFiles.size} file modificati.`
            : `Session done. ${allFiles.size} files modified.`;
        sendBuddyMessage(msg, 'smile');
    }

    // Reset session
    sessionFiles.clear();
    sessionEdits = 0;
    sessionLinesAdded = 0;
    sessionLinesRemoved = 0;
}

/**
 * Called when user returns after inactivity
 */
async function handleWelcomeBack(): Promise<void> {
    setBuddyState('welcome');

    try {
        const result = await callHaiku(
            `The developer just came back after being away.\n` +
            `Last session files: ${[...sessionFiles].join(', ') || 'none tracked'}\n` +
            `Last session edits: ${sessionEdits}\n` +
            `Welcome them back and remind them what was happening.`
        );
        setBuddyState(result.emotion as any);
        sendBuddyMessage(result.message, result.emotion);
    } catch (err) {
        console.log('[VibeBuddy] Haiku error:', err);
        const lang = getLang();
        const msg = lang === 'it' ? 'Bentornato!' : 'Welcome back!';
        sendBuddyMessage(msg, 'smile');
        setBuddyState('smile');
    }
}

/**
 * Manual test: send a test message through Buddy
 */
export async function testBuddy(): Promise<void> {
    const apiKey = getApiKey();
    if (!apiKey) {
        vscode.window.showWarningMessage('VibeBuddy: Set your Anthropic API key in Settings → vibesync.anthropicApiKey');
        return;
    }

    setBuddyState('thinking');

    try {
        const result = await callHaiku(
            'The developer just activated VibeBuddy for the first time. ' +
            'Introduce yourself briefly and tell them you\'re here to help them stay aware of what\'s happening in their coding sessions.'
        );
        setBuddyState(result.emotion as any);
        sendBuddyMessage(result.message, result.emotion);
    } catch (err: any) {
        vscode.window.showErrorMessage(`VibeBuddy: API error — ${err.message}`);
        setBuddyState('warning');
    }
}

/**
 * Chat with Buddy — the user asks a question, Buddy responds with context
 */
export async function chatWithBuddy(userMessage: string): Promise<void> {
    const apiKey = getApiKey();
    if (!apiKey) {
        sendBuddyMessage('Set your Anthropic API key in Settings to chat with me!', 'warning');
        setBuddyState('warning');
        return;
    }

    setBuddyState('thinking');

    try {
        const context = sessionFiles.size > 0
            ? `Current session files: ${[...sessionFiles].join(', ')}. Edits so far: ${sessionEdits}.`
            : 'No active coding session right now.';

        const result = await callHaiku(
            `The developer is talking to you directly.\n` +
            `Session context: ${context}\n` +
            `Developer says: "${userMessage}"\n\n` +
            `Respond naturally as Buddy. Be helpful, concise, and relevant to what's happening in their coding session.`
        );
        setBuddyState(result.emotion as any);
        sendBuddyMessage(result.message, result.emotion);
    } catch (err: any) {
        console.log('[VibeBuddy] Chat error:', err);
        setBuddyState('warning');
        sendBuddyMessage('Sorry, I couldn\'t process that. Check your API key.', 'warning');
    }
}
