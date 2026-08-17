/**
 * VibeBuddy Panel — Sidebar Webview View
 * 3D avatar with expressions, lip sync, message display.
 * Renders in the VibeSync sidebar as a webview view.
 */

import * as vscode from 'vscode';

let buddyView: BuddyViewProvider | undefined;

export class BuddyViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'vibesync-buddy';
    private _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) {
        buddyView = this;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'media'),
            ],
        };

        const avatarUri = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'avatars', 'buddy_default.glb')
        );
        const threeUri = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'js', 'three-bundle.js')
        );

        webviewView.webview.html = getBuddyHtml(avatarUri.toString(), threeUri.toString());

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'buddyReady') {
                this.setState('idle');
            } else if (msg.command === 'log') {
                console.log('[VibeBuddy]', msg.text);
            } else if (msg.command === 'chat') {
                const { chatWithBuddy } = await import('./buddyEngine');
                chatWithBuddy(msg.text);
            }
        });
    }

    public setState(state: string): void {
        this._view?.webview.postMessage({ command: 'setState', state });
    }

    public showMessage(text: string, emotion?: string): void {
        this._view?.webview.postMessage({ command: 'showMessage', text, emotion });
    }

    public sendTokenUpdate(inputTokens: number, outputTokens: number, calls: number, cost: number): void {
        this._view?.webview.postMessage({ command: 'tokenUpdate', inputTokens, outputTokens, calls, cost });
    }
}

/** Send a state change to the buddy view */
export function setBuddyState(state: 'idle' | 'smile' | 'thinking' | 'talking' | 'celebrating' | 'warning' | 'welcome' | 'surprise'): void {
    buddyView?.setState(state);
}

/** Send a message for buddy to display */
export function sendBuddyMessage(text: string, emotion?: string): void {
    buddyView?.showMessage(text, emotion);
}

/** Send token usage update to the webview */
export function sendBuddyTokenUpdate(inputTokens: number, outputTokens: number, calls: number, cost: number): void {
    buddyView?.sendTokenUpdate(inputTokens, outputTokens, calls, cost);
}

/** Show the buddy panel (focus the sidebar view) */
export function showBuddyPanel(_context: vscode.ExtensionContext): void {
    vscode.commands.executeCommand('vibesync-buddy.focus');
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function getBuddyHtml(avatarUri: string, threeUri: string): string {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
    font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
    font-size: 13px;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    height: 100%;
    overflow: hidden;
}
#wrap { display: flex; flex-direction: column; height: 100%; }

/* Avatar viewport */
#avatar-box {
    width: 100%;
    aspect-ratio: 1 / 1;
    max-height: 300px;
    position: relative;
    cursor: grab;
    flex-shrink: 0;
}
#avatar-box:active { cursor: grabbing; }
#avatar-box canvas { display: block; width: 100% !important; height: 100% !important; }
#loading {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    color: var(--vscode-foreground); opacity: 0.4; font-size: 11px;
}
.spinner { width: 24px; height: 24px; border: 2px solid var(--vscode-widget-border, #444); border-top-color: var(--vscode-focusBorder, #007acc); border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* Message area */
#msg-area {
    padding: 8px 10px;
    border-top: 1px solid var(--vscode-widget-border, #333);
    min-height: 40px;
    flex: 1;
    overflow-y: auto;
}
#msg-bubble {
    font-size: 12px; line-height: 1.6; opacity: 0; transition: opacity 0.3s;
}
#msg-bubble.visible { opacity: 1; }

/* Token bar */
#token-bar {
    padding: 3px 10px;
    border-top: 1px solid var(--vscode-widget-border, #333);
    font-size: 9px;
    opacity: 0.35;
    display: flex;
    gap: 8px;
    flex-shrink: 0;
    font-family: var(--vscode-editor-font-family, monospace);
}

/* Chat input */
#chat-input {
    display: flex; gap: 4px; padding: 6px 10px;
    border-top: 1px solid var(--vscode-widget-border, #333);
    flex-shrink: 0;
}
#userInput {
    flex: 1; padding: 5px 8px; font-size: 12px;
    background: var(--vscode-input-background, #1e1e1e);
    color: var(--vscode-input-foreground, #ccc);
    border: 1px solid var(--vscode-input-border, #444);
    border-radius: 4px; outline: none;
}
#userInput:focus { border-color: var(--vscode-focusBorder, #007acc); }

/* Timeline */
#timeline {
    max-height: 80px; overflow-y: auto; padding: 4px 10px;
    border-top: 1px solid var(--vscode-widget-border, #333);
    font-size: 10px; opacity: 0.5;
    flex-shrink: 0;
}
.tl-e { display: flex; gap: 6px; padding: 1px 0; }
.tl-t { opacity: 0.4; flex-shrink: 0; }
.tl-x { opacity: 0.7; }

/* Expression buttons */
#expr {
    padding: 6px 10px;
    border-top: 1px solid var(--vscode-widget-border, #333);
    display: flex; gap: 4px; flex-wrap: wrap;
}
.eb {
    padding: 2px 6px; font-size: 9px;
    border: 1px solid var(--vscode-widget-border, #444);
    border-radius: 3px; background: transparent;
    color: var(--vscode-foreground); cursor: pointer; opacity: 0.4;
}
.eb:hover { opacity: 1; }

/* Controls */
#ctrl {
    padding: 6px 10px;
    border-top: 1px solid var(--vscode-widget-border, #333);
    display: flex; align-items: center; gap: 8px; flex-shrink: 0;
}
.cl { font-size: 9px; opacity: 0.4; }
#verb { flex: 1; max-width: 80px; accent-color: var(--vscode-focusBorder, #007acc); }
.cb {
    background: none; border: 1px solid var(--vscode-widget-border, #444);
    border-radius: 3px; color: var(--vscode-foreground);
    padding: 2px 6px; font-size: 9px; cursor: pointer; opacity: 0.5;
}
.cb:hover { opacity: 1; }
.cb.active { opacity: 1; background: var(--vscode-focusBorder, #007acc); color: #fff; }
</style>
</head>
<body>
<div id="wrap">

<div id="avatar-box">
    <div id="loading"><div class="spinner"></div><span>Loading...</span></div>
</div>

<div id="msg-area"><div id="msg-bubble"></div></div>

<div id="chat-input">
    <input type="text" id="userInput" placeholder="Ask Buddy..." onkeydown="if(event.key==='Enter')sendChat()" />
    <button class="cb" onclick="sendChat()">Send</button>
</div>

<div id="timeline"></div>

<div id="expr">
    <button class="eb" onclick="doExpr('idle')">Idle</button>
    <button class="eb" onclick="doExpr('smile')">Smile</button>
    <button class="eb" onclick="doExpr('thinking')">Think</button>
    <button class="eb" onclick="doExpr('talking')">Talk</button>
    <button class="eb" onclick="doExpr('surprise')">Surprise</button>
    <button class="eb" onclick="doExpr('warning')">Warning</button>
    <button class="eb" onclick="doLipSync()">Lip Sync</button>
</div>

<div id="token-bar"></div>
<div id="ctrl">
    <span class="cl">Quiet</span>
    <input type="range" id="verb" min="0" max="2" value="1" step="1" />
    <span class="cl">Chatty</span>
    <button class="cb" id="ttsBtn" onclick="toggleTTS()">TTS</button>
    <button class="cb" id="muteBtn" onclick="toggleMute()">Mute</button>
</div>

</div>

<script src="${threeUri}"></script>
<script>
var vscode = acquireVsCodeApi();
var container = document.getElementById('avatar-box');
var loadingEl = document.getElementById('loading');

function log(m) { console.log('[VibeBuddy]', m); vscode.postMessage({command:'log',text:m}); }
log('Script started');

// ── Scene ───────────────────────────────────────────────────────
var scene = new THREE.Scene();
var w = container.clientWidth || 300, h = container.clientHeight || 300;
var camera = new THREE.PerspectiveCamera(25, w / h, 0.1, 100);
camera.position.set(0, 1.68, 0.6);

var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(w, h);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

scene.add(new THREE.AmbientLight(0xffffff, 0.7));
var kl = new THREE.DirectionalLight(0xffffff, 0.9); kl.position.set(1, 2, 2); scene.add(kl);
var fl = new THREE.DirectionalLight(0x8888ff, 0.3); fl.position.set(-1, 1, -1); scene.add(fl);

var controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.68, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.4;
controls.maxDistance = 3;
controls.update();

log('Scene ready');

// ── Load Avatar ─────────────────────────────────────────────────
var allMorphMeshes = [];

var loader = new THREE.GLTFLoader();
loader.load('${avatarUri}',
    function(gltf) {
        log('Avatar loaded');
        scene.add(gltf.scene);
        gltf.scene.traverse(function(node) {
            if (node.isMesh && node.morphTargetInfluences && node.morphTargetDictionary) {
                allMorphMeshes.push(node);
                log('Morph: ' + node.name + ' (' + Object.keys(node.morphTargetDictionary).length + ')');
            }
        });
        loadingEl.style.display = 'none';
        vscode.postMessage({ command: 'buddyReady' });
        startIdleAnim();
    },
    function(p) {
        if (p.total) loadingEl.querySelector('span').textContent = Math.round(p.loaded/p.total*100) + '%';
    },
    function(e) {
        log('ERROR: ' + e.message);
        loadingEl.querySelector('span').textContent = 'Error';
    }
);

// ── Morph Helpers ───────────────────────────────────────────────
function setM(name, val) {
    for (var i = 0; i < allMorphMeshes.length; i++) {
        var mesh = allMorphMeshes[i];
        var idx = mesh.morphTargetDictionary[name];
        if (idx !== undefined) mesh.morphTargetInfluences[idx] = val;
    }
}
function resetM() {
    for (var i = 0; i < allMorphMeshes.length; i++) {
        var mesh = allMorphMeshes[i];
        for (var j = 0; j < mesh.morphTargetInfluences.length; j++) mesh.morphTargetInfluences[j] = 0;
    }
}

// ── Expressions ─────────────────────────────────────────────────
var expr = {
    idle: function() { resetM(); },
    smile: function() { resetM(); setM('mouthSmile',0.6); setM('mouthSmileLeft',0.5); setM('mouthSmileRight',0.5); setM('cheekSquintLeft',0.3); setM('cheekSquintRight',0.3); },
    thinking: function() { resetM(); setM('browInnerUp',0.4); setM('eyeLookUpLeft',0.6); setM('eyeLookUpRight',0.6); setM('mouthRight',0.2); },
    talking: function() { resetM(); setM('mouthOpen',0.3); setM('viseme_aa',0.5); },
    surprise: function() { resetM(); setM('browOuterUpLeft',0.7); setM('browOuterUpRight',0.7); setM('eyeWideLeft',0.6); setM('eyeWideRight',0.6); setM('jawOpen',0.3); },
    warning: function() { resetM(); setM('browDownLeft',0.6); setM('browDownRight',0.6); setM('mouthFrownLeft',0.3); setM('mouthFrownRight',0.3); },
};
window.doExpr = function(n) { if (expr[n]) expr[n](); };

// ── Idle Animation ──────────────────────────────────────────────
function startIdleAnim() {
    var t = 0, nb = 2000 + Math.random()*3000, bs = 0;
    function tick() {
        t += 16;
        if (t > nb) { bs = t; nb = t + 2000 + Math.random()*4000; }
        var be = t - bs;
        if (be < 200) {
            var v = be < 100 ? be/100 : (200-be)/100;
            setM('eyeBlinkLeft',v); setM('eyeBlinkRight',v);
        }
        requestAnimationFrame(tick);
    }
    tick();
}

// ── Lip Sync Demo ───────────────────────────────────────────────
var visemes = ['viseme_sil','viseme_PP','viseme_FF','viseme_TH','viseme_DD','viseme_kk','viseme_CH','viseme_SS','viseme_nn','viseme_RR','viseme_aa','viseme_E','viseme_I','viseme_O','viseme_U'];
var lsI = null;
window.doLipSync = function() {
    if (lsI) { clearInterval(lsI); lsI=null; visemes.forEach(function(v){setM(v,0);}); setM('jawOpen',0); return; }
    var i=0;
    lsI = setInterval(function() {
        visemes.forEach(function(v){setM(v,0);});
        setM(visemes[i%visemes.length],0.8);
        setM('jawOpen', i%visemes.length===0?0:0.15);
        i++;
    }, 120);
    setTimeout(function(){ if(lsI){clearInterval(lsI);lsI=null;visemes.forEach(function(v){setM(v,0);});setM('jawOpen',0);} }, 3000);
};

// ── TTS + Lip Sync ──────────────────────────────────────────────
var ttsEnabled = false;
var muted = false;
var currentUtterance = null;
var lipSyncActive = false;

// Phoneme-to-viseme mapping (approximate)
var charToViseme = {
    'a': 'viseme_aa', 'e': 'viseme_E', 'i': 'viseme_I', 'o': 'viseme_O', 'u': 'viseme_U',
    'à': 'viseme_aa', 'è': 'viseme_E', 'é': 'viseme_E', 'ì': 'viseme_I', 'ò': 'viseme_O', 'ù': 'viseme_U',
    'p': 'viseme_PP', 'b': 'viseme_PP', 'm': 'viseme_PP',
    'f': 'viseme_FF', 'v': 'viseme_FF',
    't': 'viseme_DD', 'd': 'viseme_DD', 'n': 'viseme_nn', 'l': 'viseme_nn',
    'k': 'viseme_kk', 'g': 'viseme_kk', 'c': 'viseme_kk', 'q': 'viseme_kk',
    's': 'viseme_SS', 'z': 'viseme_SS',
    'r': 'viseme_RR',
    'j': 'viseme_CH', 'x': 'viseme_CH',
    'w': 'viseme_U',
    'h': 'viseme_sil',
    ' ': 'viseme_sil', '.': 'viseme_sil', ',': 'viseme_sil',
};

function startLipSyncForText(text) {
    if (lipSyncActive) stopLipSync();
    lipSyncActive = true;
    var chars = text.toLowerCase().split('');
    var idx = 0;
    var speed = 55; // ms per char — sync roughly with TTS speed

    function tick() {
        if (!lipSyncActive || idx >= chars.length) { stopLipSync(); return; }
        visemes.forEach(function(v) { setM(v, 0); });
        var ch = chars[idx];
        var vis = charToViseme[ch] || 'viseme_DD';
        if (ch === ' ' || ch === '.' || ch === ',') {
            setM('viseme_sil', 1); setM('jawOpen', 0);
        } else {
            setM(vis, 0.7); setM('jawOpen', 0.12);
        }
        idx++;
        setTimeout(tick, speed);
    }
    tick();
}

function stopLipSync() {
    lipSyncActive = false;
    visemes.forEach(function(v) { setM(v, 0); });
    setM('jawOpen', 0);
}

var bestVoice = null;
var voicesLoaded = false;

function loadVoices() {
    var voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) return;
    voicesLoaded = true;

    // Log all voices for debugging
    log('Available voices: ' + voices.length);
    voices.forEach(function(v) { log('  ' + v.name + ' [' + v.lang + '] ' + (v.localService ? 'local' : 'online')); });

    // Priority: prefer "Online" / "Natural" voices, then match language
    var langPrefix = 'en';
    // Detect from VibeSync setting
    var htmlLang = document.documentElement.lang;
    if (htmlLang && htmlLang.startsWith('it')) langPrefix = 'it';

    var langVoices = voices.filter(function(v) { return v.lang.toLowerCase().startsWith(langPrefix); });

    // Prefer online/natural voices (much better quality)
    var online = langVoices.filter(function(v) { return !v.localService || v.name.toLowerCase().indexOf('online') >= 0 || v.name.toLowerCase().indexOf('natural') >= 0; });
    if (online.length > 0) { bestVoice = online[0]; }
    else if (langVoices.length > 0) { bestVoice = langVoices[0]; }
    else if (voices.length > 0) { bestVoice = voices[0]; }

    log('Selected voice: ' + (bestVoice ? bestVoice.name + ' [' + bestVoice.lang + ']' : 'none'));
}

// Voices may load async
if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = loadVoices;
    loadVoices();
}

function speak(text) {
    if (muted || !ttsEnabled) return;
    if (!window.speechSynthesis) { log('TTS not available'); return; }

    window.speechSynthesis.cancel();

    if (!voicesLoaded) loadVoices();

    var utter = new SpeechSynthesisUtterance(text);
    utter.rate = 0.95;
    utter.pitch = 1.05;
    utter.volume = 1.0;

    if (bestVoice) utter.voice = bestVoice;

    utter.onstart = function() { startLipSyncForText(text); };
    utter.onend = function() { stopLipSync(); };
    utter.onerror = function() { stopLipSync(); };

    window.speechSynthesis.speak(utter);
}

// ── Messages ────────────────────────────────────────────────────
function showMsg(text) {
    var b = document.getElementById('msg-bubble');
    b.textContent=''; b.classList.add('visible');
    var i=0;
    var iv=setInterval(function(){if(i<text.length){b.textContent+=text[i];i++;}else clearInterval(iv);},25);
    var tl=document.getElementById('timeline');
    var now=new Date();
    var e=document.createElement('div');e.className='tl-e';
    e.innerHTML='<span class="tl-t">'+now.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+'</span><span class="tl-x">'+text.substring(0,60)+'</span>';
    tl.insertBefore(e,tl.firstChild);

    // Speak it
    speak(text);
}

// ── Controls ────────────────────────────────────────────────────
window.toggleTTS = function() {
    ttsEnabled = !ttsEnabled;
    document.getElementById('ttsBtn').classList.toggle('active', ttsEnabled);
    if (ttsEnabled) {
        // Load voices (some browsers need this trigger)
        window.speechSynthesis.getVoices();
    }
};
window.toggleMute = function() {
    muted = !muted;
    document.getElementById('muteBtn').classList.toggle('active', muted);
    if (muted) { window.speechSynthesis.cancel(); stopLipSync(); }
};

// ── Chat input ──────────────────────────────────────────────────
window.sendChat = function() {
    var input = document.getElementById('userInput');
    var text = input.value.trim();
    if (!text) return;
    input.value = '';

    // Show user message in timeline
    var tl = document.getElementById('timeline');
    var now = new Date();
    var ue = document.createElement('div'); ue.className = 'tl-e';
    ue.innerHTML = '<span class="tl-t">' + now.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) + '</span><span class="tl-x" style="opacity:1;color:var(--vscode-focusBorder,#007acc);">You: ' + text.substring(0,60) + '</span>';
    tl.insertBefore(ue, tl.firstChild);

    // Send to extension for Haiku processing
    vscode.postMessage({ command: 'chat', text: text });

    // Show thinking state
    if (expr.thinking) expr.thinking();
};

// ── Extension messages ──────────────────────────────────────────
window.addEventListener('message', function(e) {
    var msg = e.data;
    if (msg.command==='setState' && expr[msg.state]) expr[msg.state]();
    if (msg.command==='showMessage') { showMsg(msg.text); if(msg.emotion && expr[msg.emotion]) expr[msg.emotion](); }
    if (msg.command==='tokenUpdate') {
        var tb = document.getElementById('token-bar');
        var total = msg.inputTokens + msg.outputTokens;
        tb.innerHTML = 'Tokens: ' + total.toLocaleString() +
            ' (in:' + msg.inputTokens.toLocaleString() + ' out:' + msg.outputTokens.toLocaleString() + ')' +
            ' &middot; Calls: ' + msg.calls +
            ' &middot; Cost: $' + msg.cost.toFixed(4);
    }
});

// ── Render ──────────────────────────────────────────────────────
function animate() { requestAnimationFrame(animate); controls.update(); renderer.render(scene,camera); }
animate();

// ── Resize ──────────────────────────────────────────────────────
new ResizeObserver(function() {
    var w=container.clientWidth, h=container.clientHeight;
    if(w>0 && h>0) { camera.aspect=w/h; camera.updateProjectionMatrix(); renderer.setSize(w,h); }
}).observe(container);

log('Render loop started');
</script>
</body>
</html>`;
}
