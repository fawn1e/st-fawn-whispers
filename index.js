/* ============================================================
   Whispers — AI Assistant Extension for SillyTavern
   v2: folders, inline editing, per-assistant binding,
       API key + model selector, collapsible panel
   ============================================================ */

const MODULE_NAME = 'whispers';

// ── Default Settings ────────────────────────────────────────────
const defaultSettings = Object.freeze({
    enabled: true,
    assistants: [],
    folders: [],
    npcAssistants: [],
    npcFolders: [],
    extraApiUrl: '',
    extraApiKey: '',
    extraApiModel: '',
    messageLimit: 20,
    useExtraApi: false,
    chatMode: true,
    twitterMode: false,
    chatAutoMode: 'button',    // 'every' | 'button' | 'custom'
    twitterAutoMode: 'button', // 'every' | 'button' | 'custom'
    chatAutoInterval: 3,
    twitterAutoInterval: 5,
    chatProactive: 'none',     // 'none' | 'comment' | 'advice' | 'checkin'
    mainPromptTemplate: `You are a personal assistant in a chat application. Respond concisely and helpfully. Format your response as plain text.

Your identity:
Name — {{name}}
Character — {{character}}
Bans — {{bans}}

Conversation context (last messages from the main chat):
{{context}}

Now respond to the user's message in the assistant chat.`,
    twitterPromptTemplate: `You are generating social media commentary posts about an ongoing roleplay conversation. Write as if multiple people are reacting to the events in the story on a Twitter-like platform.

{{npc_cards}}

Conversation context (latest events):
{{context}}

Generate exactly {{post_count}} short social media posts reacting to the latest events. Each post should be in-character, witty, and feel like a genuine social media reaction.

RESPOND ONLY with a JSON array in this exact format, no other text:
[{"name": "Display Name", "username": "handle", "content": "Post text here"}]`,
});

// ── Helpers ─────────────────────────────────────────────────────

function generateId() {
    return 'w_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    const s = extensionSettings[MODULE_NAME];
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(s, key)) {
            s[key] = structuredClone(defaultSettings[key]);
        }
    }
    return s;
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

function getChatMeta() {
    return SillyTavern.getContext().chatMetadata;
}

async function saveChatMeta() {
    await SillyTavern.getContext().saveMetadata();
}

function getWhispersHistory() {
    const meta = getChatMeta();
    if (!meta) return [];
    if (!meta.whispers_history) meta.whispers_history = [];
    return meta.whispers_history;
}

function getCurrentCharName() {
    const ctx = SillyTavern.getContext();
    if (ctx.characterId !== undefined && ctx.characters[ctx.characterId]) {
        return ctx.characters[ctx.characterId].name;
    }
    return null;
}

function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

// ── Assistant Model ─────────────────────────────────────────────
// Each assistant: { id, name, character, bans, avatar, binding, bindingTarget, folderId }
// binding: 'global' | 'character' | 'chat' | 'none'
// bindingTarget: charName (for character binding) or null

function getActiveAssistant() {
    const settings = getSettings();
    const meta = getChatMeta();
    const charName = getCurrentCharName();

    // 1. Chat-bound assistant
    if (meta && meta.whispers_assistant_id) {
        const a = settings.assistants.find(a => a.id === meta.whispers_assistant_id);
        if (a) return a;
    }

    // 2. Character-bound
    if (charName) {
        const a = settings.assistants.find(a => a.binding === 'character' && a.bindingTarget === charName);
        if (a) return a;
    }

    // 3. Global
    const g = settings.assistants.find(a => a.binding === 'global');
    if (g) return g;

    // 4. First available
    return settings.assistants.length > 0 ? settings.assistants[0] : null;
}

function buildSystemPrompt(assistant) {
    const settings = getSettings();
    let prompt = settings.mainPromptTemplate;
    prompt = prompt.replace(/\{\{name\}\}/g, assistant.name || 'Assistant');
    prompt = prompt.replace(/\{\{character\}\}/g, assistant.character || 'Helpful and friendly');
    prompt = prompt.replace(/\{\{bans\}\}/g, assistant.bans || 'None');

    // Inject message example if present
    if (assistant.messageExample) {
        prompt += '\n\nExample of how you should write:\n' + assistant.messageExample;
    }

    const ctx = SillyTavern.getContext();
    const chat = ctx.chat || [];
    const limit = settings.messageLimit || 20;
    const contextStr = chat.slice(-limit).map(m => {
        const role = m.is_user ? 'User' : (m.name || 'Character');
        return `${role}: ${m.mes}`;
    }).join('\n');
    prompt = prompt.replace(/\{\{context\}\}/g, contextStr);

    return prompt;
}

// ── PNG Import/Export ───────────────────────────────────────────

async function exportAssistantToPng(assistant) {
    const canvas = document.createElement('canvas');
    canvas.width = 400; canvas.height = 400;
    const c = canvas.getContext('2d');
    if (assistant.avatar) {
        const img = new Image();
        await new Promise((r, e) => { img.onload = r; img.onerror = e; img.src = assistant.avatar; });
        c.drawImage(img, 0, 0, 400, 400);
    } else {
        const g = c.createLinearGradient(0, 0, 400, 400);
        g.addColorStop(0, '#667eea'); g.addColorStop(1, '#764ba2');
        c.fillStyle = g; c.fillRect(0, 0, 400, 400);
        c.fillStyle = '#fff'; c.font = 'bold 48px sans-serif';
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(assistant.name || 'Assistant', 200, 180);
        c.font = '24px sans-serif'; c.globalAlpha = 0.7;
        c.fillText('Whispers', 200, 240); c.globalAlpha = 1;
    }
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    const pngBytes = new Uint8Array(await blob.arrayBuffer());
    const data = { name: assistant.name, character: assistant.character, bans: assistant.bans, avatar: assistant.avatar || null };
    const result = injectTextChunk(pngBytes, 'whispers', JSON.stringify(data));
    const dlBlob = new Blob([result], { type: 'image/png' });
    const url = URL.createObjectURL(dlBlob);
    const a = document.createElement('a');
    a.href = url; a.download = `${assistant.name || 'assistant'}.png`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function importAssistantFromPng(file) {
    const pngBytes = new Uint8Array(await file.arrayBuffer());
    const jsonStr = extractTextChunk(pngBytes, 'whispers');
    if (!jsonStr) { toastr.error('This PNG does not contain Whispers data.'); return null; }
    try {
        const d = JSON.parse(jsonStr);
        return { id: generateId(), name: d.name || 'Imported', character: d.character || '', bans: d.bans || '', avatar: d.avatar || null, binding: 'none', bindingTarget: null, folderId: null };
    } catch { toastr.error('Failed to parse assistant data.'); return null; }
}

// Folder export: exports folder + all its assistants
async function exportFolderToPng(folder, assistants) {
    const canvas = document.createElement('canvas');
    canvas.width = 400; canvas.height = 400;
    const c = canvas.getContext('2d');
    const g = c.createLinearGradient(0, 0, 400, 400);
    g.addColorStop(0, folder.color || '#667eea');
    g.addColorStop(1, '#222');
    c.fillStyle = g; c.fillRect(0, 0, 400, 400);
    c.fillStyle = '#fff'; c.font = 'bold 40px sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(folder.name || 'Folder', 200, 180);
    c.font = '20px sans-serif'; c.globalAlpha = 0.6;
    c.fillText(`${assistants.length} assistant(s)`, 200, 230);
    c.globalAlpha = 1;

    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    const pngBytes = new Uint8Array(await blob.arrayBuffer());
    const data = {
        type: 'folder',
        folder: { name: folder.name, icon: folder.icon, color: folder.color, note: folder.note },
        assistants: assistants.map(a => ({ name: a.name, character: a.character, bans: a.bans, avatar: a.avatar })),
    };
    const result = injectTextChunk(pngBytes, 'whispers', JSON.stringify(data));
    const dlBlob = new Blob([result], { type: 'image/png' });
    const url = URL.createObjectURL(dlBlob);
    const a = document.createElement('a');
    a.href = url; a.download = `${folder.name || 'folder'}.png`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function importFromPng(file) {
    const pngBytes = new Uint8Array(await file.arrayBuffer());
    const jsonStr = extractTextChunk(pngBytes, 'whispers');
    if (!jsonStr) { toastr.error('No Whispers data in this PNG.'); return null; }
    try {
        const d = JSON.parse(jsonStr);
        if (d.type === 'folder') {
            return { type: 'folder', data: d };
        }
        // Single assistant
        return {
            type: 'assistant',
            data: { id: generateId(), name: d.name || 'Imported', character: d.character || '', bans: d.bans || '', avatar: d.avatar || null, binding: 'none', bindingTarget: null, folderId: null }
        };
    } catch { toastr.error('Failed to parse data.'); return null; }
}

// ── PNG chunk utilities ─────────────────────────────────────────

function injectTextChunk(pngBytes, keyword, text) {
    const enc = new TextEncoder();
    const kw = enc.encode(keyword), tx = enc.encode(text);
    const chunkData = new Uint8Array(kw.length + 1 + tx.length);
    chunkData.set(kw); chunkData[kw.length] = 0; chunkData.set(tx, kw.length + 1);
    const ct = enc.encode('tEXt');
    const crcIn = new Uint8Array(4 + chunkData.length);
    crcIn.set(ct); crcIn.set(chunkData, 4);
    const chunk = new Uint8Array(12 + chunkData.length);
    const v = new DataView(chunk.buffer);
    v.setUint32(0, chunkData.length);
    chunk.set(ct, 4); chunk.set(chunkData, 8);
    v.setUint32(chunk.length - 4, crc32(crcIn));
    const iend = findChunkPos(pngBytes, 'IEND');
    const pos = iend !== -1 ? iend : pngBytes.length - 12;
    const out = new Uint8Array(pngBytes.length + chunk.length);
    out.set(pngBytes.subarray(0, pos));
    out.set(chunk, pos);
    out.set(pngBytes.subarray(pos), pos + chunk.length);
    return out;
}

function extractTextChunk(pngBytes, keyword) {
    const dec = new TextDecoder();
    let off = 8;
    while (off < pngBytes.length) {
        const v = new DataView(pngBytes.buffer, pngBytes.byteOffset + off);
        const len = v.getUint32(0);
        const type = dec.decode(pngBytes.subarray(off + 4, off + 8));
        if (type === 'tEXt') {
            const data = pngBytes.subarray(off + 8, off + 8 + len);
            let ni = -1;
            for (let i = 0; i < data.length; i++) { if (data[i] === 0) { ni = i; break; } }
            if (ni > 0 && dec.decode(data.subarray(0, ni)) === keyword) {
                return dec.decode(data.subarray(ni + 1));
            }
        }
        if (type === 'IEND') break;
        off += 12 + len;
    }
    return null;
}

function findChunkPos(png, name) {
    const d = new TextDecoder(); let o = 8;
    while (o < png.length) {
        const v = new DataView(png.buffer, png.byteOffset + o);
        const l = v.getUint32(0);
        if (d.decode(png.subarray(o + 4, o + 8)) === name) return o;
        o += 12 + l;
    }
    return -1;
}

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0); }
    return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── Generation ──────────────────────────────────────────────────

async function generateResponse(userMessage) {
    const settings = getSettings();
    const assistant = getActiveAssistant();
    if (!assistant) throw new Error('No assistant configured');

    const systemPrompt = buildSystemPrompt(assistant);
    const history = getWhispersHistory();
    const limit = settings.messageLimit || 20;
    const recentHistory = history.slice(-limit);

    if (settings.useExtraApi && settings.extraApiUrl) {
        return await generateViaExtraApi(systemPrompt, recentHistory, userMessage, settings);
    } else {
        return await generateViaST(systemPrompt, recentHistory, userMessage);
    }
}

async function generateViaExtraApi(systemPrompt, history, userMessage, settings) {
    const messages = [{ role: 'system', content: systemPrompt }];
    for (const m of history) messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content });
    messages.push({ role: 'user', content: userMessage });

    const url = new URL(settings.extraApiUrl);
    if (!url.pathname.endsWith('/generate') && !url.pathname.endsWith('/chat/completions')) {
        url.pathname = url.pathname.replace(/\/$/, '') + '/v1/chat/completions';
    }

    const headers = { 'Content-Type': 'application/json' };
    if (settings.extraApiKey) headers['Authorization'] = `Bearer ${settings.extraApiKey}`;

    const body = { messages, temperature: 0.7, max_tokens: 1024 };
    if (settings.extraApiModel) body.model = settings.extraApiModel;

    const resp = await fetch(url.toString(), { method: 'POST', headers, body: JSON.stringify(body) });
    if (!resp.ok) throw new Error(`API error: ${resp.status}`);
    const data = await resp.json();

    if (data.choices?.length > 0) return data.choices[0].message?.content || data.choices[0].text || '';
    return data.response || data.content || data.result || JSON.stringify(data);
}

async function generateViaST(systemPrompt, history, userMessage) {
    const { generateRaw } = SillyTavern.getContext();
    let conv = '';
    for (const m of history) conv += `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}\n`;
    conv += `User: ${userMessage}\nAssistant:`;
    return (await generateRaw({ systemPrompt, prompt: conv, prefill: '' })) || '';
}

// ── Generic Helpers for Twitter/NPC ─────────────────────────────

function gatherContext() {
    const settings = getSettings();
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat || [];
    const limit = settings.messageLimit || 20;
    return chat.slice(-limit).map(m => {
        const role = m.is_user ? 'User' : (m.name || 'Character');
        return `${role}: ${m.mes}`;
    }).join('\n');
}

async function callApi(messages) {
    const settings = getSettings();
    if (settings.useExtraApi && settings.extraApiUrl) {
        const url = new URL(settings.extraApiUrl);
        if (!url.pathname.endsWith('/generate') && !url.pathname.endsWith('/chat/completions')) {
            url.pathname = url.pathname.replace(/\/$/, '') + '/v1/chat/completions';
        }
        const headers = { 'Content-Type': 'application/json' };
        if (settings.extraApiKey) headers['Authorization'] = `Bearer ${settings.extraApiKey}`;
        const body = { messages, temperature: 0.8, max_tokens: 1500 };
        if (settings.extraApiModel) body.model = settings.extraApiModel;
        const resp = await fetch(url.toString(), { method: 'POST', headers, body: JSON.stringify(body) });
        if (!resp.ok) throw new Error(`API error: ${resp.status}`);
        const data = await resp.json();
        if (data.choices?.length > 0) return data.choices[0].message?.content || data.choices[0].text || '';
        return data.response || data.content || data.result || JSON.stringify(data);
    } else {
        const { generateRaw } = SillyTavern.getContext();
        const systemPrompt = messages.find(m => m.role === 'system')?.content || '';
        const prompt = messages.filter(m => m.role !== 'system').map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n') + '\nAssistant:';
        return (await generateRaw({ systemPrompt, prompt, prefill: '' })) || '';
    }
}



async function fetchModels() {
    const settings = getSettings();
    if (!settings.extraApiUrl) { toastr.warning('Set API URL first'); return []; }

    const url = new URL(settings.extraApiUrl);
    url.pathname = url.pathname.replace(/\/$/, '') + '/v1/models';

    const headers = {};
    if (settings.extraApiKey) headers['Authorization'] = `Bearer ${settings.extraApiKey}`;

    try {
        const resp = await fetch(url.toString(), { headers });
        if (!resp.ok) throw new Error(`${resp.status}`);
        const data = await resp.json();
        return (data.data || data.models || []).map(m => m.id || m.name || m);
    } catch (err) {
        toastr.error(`Failed to fetch models: ${err.message}`);
        return [];
    }
}

// ── State ───────────────────────────────────────────────────────

let editingAssistantId = null;
let editingFolderId = null;
let isGenerating = false;

// ── Update Check ────────────────────────────────────────────────

async function checkForUpdate() {
    try {
        const { getRequestHeaders } = SillyTavern.getContext();
        const resp = await fetch('/api/extensions/version', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ extensionName: `third-party/${MODULE_NAME}` }),
        });
        if (!resp.ok) return;
        const data = await resp.json();
        const btn = document.getElementById('whispers-btn-update');
        if (btn && data.isUpToDate === false) {
            btn.style.display = '';
            btn.title = 'Update available — click to update and reload';
        }
    } catch (e) {
        console.log('[Whispers] Update check failed:', e);
    }
}

async function performUpdate() {
    try {
        const { getRequestHeaders } = SillyTavern.getContext();
        toastr.info('Updating Whispers...');
        const resp = await fetch('/api/extensions/update', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ extensionName: `third-party/${MODULE_NAME}` }),
        });
        if (resp.ok) {
            toastr.success('Updated! Reloading...');
            setTimeout(() => location.reload(), 1500);
        } else {
            toastr.error('Update failed');
        }
    } catch (e) {
        toastr.error('Update failed: ' + e.message);
    }
}

// ── UI: Settings Panel HTML ─────────────────────────────────────

function buildSettingsHtml() {
    return `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b><i class="fa-solid fa-ghost"></i> Whispers</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" id="whispers-settings-panel">
            <div class="whispers-settings">

                <!-- Tab Switcher -->
                <div class="whispers-tabs">
                    <label class="whispers-tab active" data-tab="general">
                        <input type="radio" name="whispers-tab" value="general" checked>
                        <i class="fa-solid fa-house"></i> General
                    </label>
                    <label class="whispers-tab" data-tab="assistants">
                        <input type="radio" name="whispers-tab" value="assistants">
                        <i class="fa-solid fa-users"></i> Assistants
                    </label>
                    <label class="whispers-tab" data-tab="api">
                        <input type="radio" name="whispers-tab" value="api">
                        <i class="fa-solid fa-server"></i> API
                    </label>
                    <label class="whispers-tab" data-tab="settings">
                        <input type="radio" name="whispers-tab" value="settings">
                        <i class="fa-solid fa-sliders"></i> Settings
                    </label>
                </div>

                <!-- ═══ Tab: General ═══ -->
                <div class="whispers-tab-content" id="whispers-tab-general">
                    <div class="whispers-toggle-row">
                        <label><i class="fa-solid fa-power-off"></i> Enable Extension</label>
                        <input type="checkbox" id="whispers-enabled" checked>
                    </div>
                    <div class="whispers-divider"></div>
                    <div class="whispers-version-row">
                        <span class="whispers-version-label"><i class="fa-solid fa-code-branch"></i> Version <strong id="whispers-version">1.0.0</strong></span>
                        <button class="menu_button whispers-btn-small" id="whispers-btn-update" style="display:none;" title="Update available">
                            <i class="fa-solid fa-download"></i> Update
                        </button>
                    </div>
                    <div class="whispers-divider"></div>
                    <div class="whispers-credits">
                        <div class="whispers-credits-text">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> Made with love by <strong>fawn1e</strong>
                        </div>
                        <div class="whispers-credits-links">
                            <a href="#" id="whispers-link-docs" title="Documentation & Guide" class="whispers-credit-link">
                                <i class="fa-solid fa-book"></i>
                            </a>
                            <a href="#" id="whispers-link-telegram" title="Telegram Channel" class="whispers-credit-link" target="_blank">
                                <i class="fa-brands fa-telegram"></i>
                            </a>
                        </div>
                    </div>
                </div>

                <!-- ═══ Tab: Assistants ═══ -->
                <div class="whispers-tab-content" id="whispers-tab-assistants" style="display:none;">
                    <div class="whispers-subsection">
                        <div class="whispers-subsection-header"><i class="fa-solid fa-comments"></i> Chat Assistants</div>
                        <div class="whispers-item-list" id="whispers-item-list"></div>
                        <div class="whispers-row">
                            <button class="menu_button" id="whispers-btn-new-assistant" title="New assistant"><i class="fa-solid fa-plus"></i> Assistant</button>
                            <button class="menu_button" id="whispers-btn-new-folder" title="New folder"><i class="fa-solid fa-folder-plus"></i> Folder</button>
                            <button class="menu_button" id="whispers-btn-import" title="Import PNG"><i class="fa-solid fa-file-import"></i> Import</button>
                        </div>
                        <input type="file" accept=".png" class="whispers-hidden-input" id="whispers-import-file">
                        <input type="file" accept="image/*" class="whispers-hidden-input" id="whispers-avatar-file">
                    </div>
                    <div class="whispers-divider"></div>
                    <div class="whispers-subsection">
                        <div class="whispers-subsection-header"><i class="fa-brands fa-twitter"></i> NPC Assistants</div>
                        <div class="whispers-item-list" id="whispers-npc-list"></div>
                        <div class="whispers-row">
                            <button class="menu_button" id="whispers-btn-new-npc" title="New NPC"><i class="fa-solid fa-plus"></i> NPC</button>
                            <button class="menu_button" id="whispers-btn-new-npc-folder" title="New NPC folder"><i class="fa-solid fa-folder-plus"></i> Folder</button>
                        </div>
                        <input type="file" accept="image/*" class="whispers-hidden-input" id="whispers-npc-avatar-file">
                    </div>
                </div>

                <!-- ═══ Tab: API ═══ -->
                <div class="whispers-tab-content" id="whispers-tab-api" style="display:none;">
                    <div class="whispers-toggle-row">
                        <label><i class="fa-solid fa-plug"></i> Use External API</label>
                        <input type="checkbox" id="whispers-use-extra-api">
                    </div>
                    <div id="whispers-api-section" style="display:none;">
                        <div class="whispers-field-group" style="margin-bottom:6px;">
                            <label>API URL</label>
                            <input type="url" id="whispers-api-url" placeholder="http://localhost:5001">
                        </div>
                        <div class="whispers-field-group" style="margin-bottom:6px;">
                            <label><i class="fa-solid fa-key"></i> API Key</label>
                            <input type="password" id="whispers-api-key" placeholder="sk-... (optional)">
                        </div>
                        <div class="whispers-field-group">
                            <label><i class="fa-solid fa-microchip"></i> Model</label>
                            <div class="whispers-model-row">
                                <select id="whispers-model-select"><option value="">Default</option></select>
                                <button class="menu_button whispers-btn-small whispers-btn-icon" id="whispers-btn-refresh-models" title="Refresh models">
                                    <i class="fa-solid fa-arrows-rotate"></i>
                                </button>
                            </div>
                        </div>
                    </div>
                    <div class="whispers-field-group">
                        <label><i class="fa-solid fa-list-ol"></i> Message Limit (context)</label>
                        <input type="number" id="whispers-msg-limit" min="1" max="100" value="20">
                    </div>
                </div>

                <!-- ═══ Tab: Settings ═══ -->
                <div class="whispers-tab-content" id="whispers-tab-settings" style="display:none;">
                    <div class="whispers-field-group">
                        <label><i class="fa-solid fa-toggle-on"></i> Active Modes</label>
                        <div class="whispers-mode-toggles">
                            <label class="whispers-toggle-row"><span><i class="fa-solid fa-comments"></i> Chat Assistant</span><input type="checkbox" id="whispers-mode-chat" checked></label>
                            <label class="whispers-toggle-row"><span><i class="fa-brands fa-twitter"></i> Twitter Feed</span><input type="checkbox" id="whispers-mode-twitter"></label>
                        </div>
                    </div>
                    <div class="whispers-divider"></div>
                    <div class="whispers-field-group" id="whispers-chat-auto-section">
                        <label><i class="fa-solid fa-robot"></i> Chat Automation</label>
                        <div class="whispers-radio-group">
                            <label><input type="radio" name="whispers-chat-auto" value="every"> Every message</label>
                            <label><input type="radio" name="whispers-chat-auto" value="button" checked> Button only</label>
                            <label class="whispers-radio-with-input"><input type="radio" name="whispers-chat-auto" value="custom"> Custom: <input type="number" id="whispers-chat-interval" min="1" max="100" value="3" class="whispers-inline-number"> msgs</label>
                        </div>
                    </div>
                    <div class="whispers-field-group" id="whispers-chat-proactive-section">
                        <label><i class="fa-solid fa-comment-dots"></i> Assistant Initiates</label>
                        <div class="whispers-radio-group">
                            <label><input type="radio" name="whispers-chat-proactive" value="none" checked> Disabled</label>
                            <label><input type="radio" name="whispers-chat-proactive" value="comment"> Comment on situation</label>
                            <label><input type="radio" name="whispers-chat-proactive" value="advice"> Give advice</label>
                            <label><input type="radio" name="whispers-chat-proactive" value="checkin"> Check in</label>
                        </div>
                    </div>
                    <div class="whispers-divider"></div>
                    <div class="whispers-field-group" id="whispers-twitter-auto-section">
                        <label><i class="fa-brands fa-twitter"></i> Twitter Automation</label>
                        <div class="whispers-radio-group">
                            <label><input type="radio" name="whispers-twitter-auto" value="every"> Every message</label>
                            <label><input type="radio" name="whispers-twitter-auto" value="button" checked> Button only</label>
                            <label class="whispers-radio-with-input"><input type="radio" name="whispers-twitter-auto" value="custom"> Custom: <input type="number" id="whispers-twitter-interval" min="1" max="100" value="5" class="whispers-inline-number"> msgs</label>
                        </div>
                    </div>
                </div>

            </div>
        </div>
    </div>`;
}

function buildChatOverlayHtml() {
    return `
    <div class="whispers-overlay" id="whispers-overlay">
        <div class="whispers-chat-window">
            <div class="whispers-chat-header">
                <div class="whispers-chat-header-avatar-placeholder" id="whispers-chat-avatar">
                    <i class="fa-solid fa-ghost"></i>
                </div>
                <div class="whispers-chat-header-info">
                    <div class="whispers-chat-header-name" id="whispers-chat-name">Whispers</div>
                    <div class="whispers-chat-header-status" id="whispers-chat-status">Online</div>
                </div>
                <button class="whispers-chat-clear" id="whispers-chat-clear" title="Clear history">
                    <i class="fa-solid fa-broom"></i>
                </button>
                <button class="whispers-chat-close" id="whispers-chat-close" title="Close">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>

            <!-- Mode tabs (visible when both chat + twitter are active) -->
            <div class="whispers-overlay-tabs" id="whispers-overlay-tabs" style="display:none;">
                <button class="whispers-overlay-tab active" data-panel="chat"><i class="fa-solid fa-comments"></i> Chat</button>
                <button class="whispers-overlay-tab" data-panel="twitter"><i class="fa-brands fa-twitter"></i> Feed</button>
            </div>

            <!-- Chat panel -->
            <div class="whispers-panel" id="whispers-panel-chat">
                <div class="whispers-messages" id="whispers-messages">
                    <div class="whispers-empty-state" id="whispers-empty-state">
                        <i class="fa-solid fa-ghost"></i>
                        <span>Start a conversation with your assistant</span>
                    </div>
                </div>
                <div class="whispers-input-bar">
                    <textarea class="whispers-input-field" id="whispers-input" placeholder="Type a message..." rows="1"></textarea>
                    <button class="whispers-send-btn" id="whispers-send" title="Send">
                        <i class="fa-solid fa-paper-plane"></i>
                    </button>
                </div>
            </div>

            <!-- Twitter panel -->
            <div class="whispers-panel" id="whispers-panel-twitter" style="display:none;">
                <div class="whispers-twitter-feed" id="whispers-twitter-feed">
                    <div class="whispers-twitter-empty" id="whispers-twitter-empty">
                        <i class="fa-brands fa-twitter"></i>
                        <span>No posts yet. Click "Get Opinion" or wait for auto-generation.</span>
                    </div>
                </div>
                <div class="whispers-twitter-bar">
                    <button class="menu_button whispers-tweet-refresh" id="whispers-tweet-refresh">
                        <i class="fa-solid fa-comment-dots"></i> Get Opinion
                    </button>
                </div>
            </div>
        </div>
    </div>`;
}

function buildChatBarButton() {
    return `<div id="whispers-chat-btn" title="Open Whispers Assistant" class="interactable">
        <i class="fa-solid fa-ghost"></i>
    </div>`;
}

// ── NPC Helpers ─────────────────────────────────────────────────

function getActiveNpcs() {
    const s = getSettings();
    const charName = getCurrentCharName();
    const meta = getChatMeta();
    return (s.npcAssistants || []).filter(npc => {
        if (npc.binding === 'global') return true;
        if (npc.binding === 'character' && npc.bindingTarget === charName) return true;
        if (npc.binding === 'chat' && meta && meta.whispers_npc_ids && meta.whispers_npc_ids.includes(npc.id)) return true;
        return false;
    });
}

function getTwitterPosts() {
    const meta = getChatMeta();
    return meta ? (meta.whispers_twitter_posts || []) : [];
}

function setTwitterPosts(posts) {
    const meta = getChatMeta();
    if (!meta) return;
    meta.whispers_twitter_posts = posts;
    saveChatMeta();
}

function getMsgCounter() {
    const meta = getChatMeta();
    return meta ? (meta.whispers_msg_counter || 0) : 0;
}

function incrementMsgCounter() {
    const meta = getChatMeta();
    if (!meta) return 0;
    meta.whispers_msg_counter = (meta.whispers_msg_counter || 0) + 1;
    saveChatMeta();
    return meta.whispers_msg_counter;
}

// ── NPC Render List ─────────────────────────────────────────────

function renderNpcList() {
    const settings = getSettings();
    const list = document.getElementById('whispers-npc-list');
    if (!list) return;
    list.innerHTML = '';

    const npcFolders = settings.npcFolders || [];
    const npcAssistants = settings.npcAssistants || [];

    // Render folders
    for (const folder of npcFolders) {
        const folderNpcs = npcAssistants.filter(n => n.folderId === folder.id);
        const folderEl = document.createElement('div');
        folderEl.className = 'whispers-folder';
        folderEl.dataset.id = folder.id;
        folderEl.style.setProperty('--folder-color', folder.color || '#888');

        folderEl.innerHTML = `
            <div class="whispers-folder-header">
                <span class="whispers-folder-icon" style="color:${folder.color || 'inherit'}">
                    <i class="fa-solid ${folder.icon || 'fa-folder'}"></i>
                </span>
                <span class="whispers-folder-name">${escapeHtml(folder.name || 'Folder')}</span>
                <span class="whispers-folder-count">${folderNpcs.length}</span>
                <span class="whispers-folder-actions">
                    <button class="edit-folder-btn" title="Edit"><i class="fa-solid fa-pen"></i></button>
                    <button class="delete-btn" title="Delete"><i class="fa-solid fa-trash"></i></button>
                </span>
                <i class="fa-solid fa-chevron-right whispers-folder-chevron"></i>
            </div>
            <div class="whispers-folder-children"></div>
        `;

        const header = folderEl.querySelector('.whispers-folder-header');
        header.addEventListener('click', (e) => {
            if (e.target.closest('.whispers-folder-actions')) return;
            folderEl.classList.toggle('open');
        });

        folderEl.querySelector('.edit-folder-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            showNpcFolderEditPopup(folder);
        });

        folderEl.querySelector('.delete-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            showConfirmationPopup(`Delete NPC folder "${folder.name}" and all NPCs inside?`, () => {
                settings.npcFolders = settings.npcFolders.filter(f => f.id !== folder.id);
                settings.npcAssistants = settings.npcAssistants.filter(n => n.folderId !== folder.id);
                saveSettings();
                renderNpcList();
                toastr.success('NPC folder deleted');
            });
        });

        const children = folderEl.querySelector('.whispers-folder-children');
        for (const npc of folderNpcs) {
            children.appendChild(buildNpcItem(npc));
        }

        list.appendChild(folderEl);
    }

    // Render unfoldered NPCs
    const unfoldered = npcAssistants.filter(n => !n.folderId);
    for (const npc of unfoldered) {
        list.appendChild(buildNpcItem(npc));
    }
}

function buildNpcItem(npc) {
    const container = document.createElement('div');
    const avatarHtml = npc.avatar
        ? `<img src="${npc.avatar}" alt="" class="whispers-avatar-mini">`
        : '<i class="fa-solid fa-user-ninja"></i>';

    container.innerHTML = `
        <div class="whispers-assistant-item" data-id="${npc.id}">
            <div class="whispers-avatar-mini-wrap">${avatarHtml}</div>
            <div class="whispers-assistant-info">
                <span class="whispers-assistant-name">${escapeHtml(npc.name || 'NPC')}</span>
                <span class="whispers-assistant-sub">@${escapeHtml(npc.username || 'unknown')}</span>
            </div>
            <div class="whispers-assistant-actions">
                <button class="edit-btn" title="Edit"><i class="fa-solid fa-pen"></i></button>
                <button class="delete-btn" title="Delete"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>
    `;

    const item = container.firstElementChild;

    item.querySelector('.edit-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        showNpcEditPopup(npc);
    });

    item.querySelector('.delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        showConfirmationPopup(`Delete NPC "${npc.name}"?`, () => {
            const s = getSettings();
            s.npcAssistants = s.npcAssistants.filter(n => n.id !== npc.id);
            saveSettings();
            renderNpcList();
            toastr.success('NPC deleted');
        });
    });

    container.appendChild(item);
    return container;
}

// ── NPC Edit Popup ──────────────────────────────────────────────

function showNpcEditPopup(npc) {
    closeAllPopups();
    const charName = getCurrentCharName();

    const overlay = document.createElement('div');
    overlay.className = 'whispers-edit-popup-overlay';
    overlay.innerHTML = `
        <div class="whispers-edit-popup">
            <div class="whispers-edit-popup-header">
                <i class="fa-solid fa-user-ninja"></i>
                <strong>Edit NPC</strong>
                <span style="flex:1"></span>
                <button class="whispers-edit-popup-close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="whispers-edit-popup-body">
                <div class="whispers-avatar-upload">
                    <div class="whispers-avatar-preview-placeholder" id="whispers-npc-popup-avatar" title="Click to set avatar" style="cursor:pointer;">
                        ${npc.avatar ? `<img class="whispers-avatar-preview" src="${npc.avatar}" alt="">` : '<i class="fa-solid fa-user-ninja"></i>'}
                    </div>
                    <span style="font-size:0.8em;opacity:0.6;">Click to set avatar</span>
                </div>
                <div class="whispers-field-group">
                    <label><i class="fa-solid fa-signature"></i> Name</label>
                    <input type="text" class="w-edit-name" value="${escapeHtml(npc.name || '')}" placeholder="Display Name">
                </div>
                <div class="whispers-field-group">
                    <label><i class="fa-solid fa-at"></i> Username</label>
                    <input type="text" class="w-edit-username" value="${escapeHtml(npc.username || '')}" placeholder="handle (without @)">
                </div>
                <div class="whispers-field-group">
                    <label><i class="fa-solid fa-masks-theater"></i> Character</label>
                    <textarea class="w-edit-character" rows="3" placeholder="Personality, tone, style...">${escapeHtml(npc.character || '')}</textarea>
                </div>
                <div class="whispers-field-group">
                    <label><i class="fa-solid fa-comment-dots"></i> Post Example</label>
                    <textarea class="w-edit-example" rows="2" placeholder="Example tweet...">${escapeHtml(npc.postExample || '')}</textarea>
                </div>
                <div class="whispers-field-group">
                    <label><i class="fa-solid fa-ban"></i> Bans</label>
                    <textarea class="w-edit-bans" rows="2" placeholder="Never mention...">${escapeHtml(npc.bans || '')}</textarea>
                </div>
                <div class="whispers-field-group">
                    <label><i class="fa-solid fa-link"></i> Binding</label>
                    <select class="w-edit-binding">
                        <option value="none" ${npc.binding === 'none' || !npc.binding ? 'selected' : ''}>None</option>
                        <option value="global" ${npc.binding === 'global' ? 'selected' : ''}>Global (all chats)</option>
                        <option value="character" ${npc.binding === 'character' ? 'selected' : ''}>Character${charName ? ` (${charName})` : ''}</option>
                        <option value="chat" ${npc.binding === 'chat' ? 'selected' : ''}>This Chat</option>
                    </select>
                </div>
                <div class="whispers-row">
                    <button class="menu_button w-save-btn"><i class="fa-solid fa-floppy-disk"></i> Save</button>
                </div>
            </div>
        </div>
    `;

    overlay.addEventListener('mousedown', (e) => e.stopPropagation());
    overlay.addEventListener('click', (e) => { e.stopPropagation(); if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.whispers-edit-popup-close').addEventListener('click', (e) => { e.stopPropagation(); overlay.remove(); });

    const body = overlay.querySelector('.whispers-edit-popup-body');

    // Avatar click
    body.querySelector('#whispers-npc-popup-avatar').addEventListener('click', () => {
        const fileInput = document.getElementById('whispers-npc-avatar-file');
        fileInput.dataset.targetNpc = npc.id;
        fileInput.click();
    });

    // Save
    body.querySelector('.w-save-btn').addEventListener('click', () => {
        npc.name = body.querySelector('.w-edit-name').value || 'NPC';
        npc.username = body.querySelector('.w-edit-username').value.replace(/^@/, '') || 'npc';
        npc.character = body.querySelector('.w-edit-character').value || '';
        npc.postExample = body.querySelector('.w-edit-example').value || '';
        npc.bans = body.querySelector('.w-edit-bans').value || '';

        const newBinding = body.querySelector('.w-edit-binding').value;
        npc.binding = newBinding;
        if (newBinding === 'character') {
            npc.bindingTarget = getCurrentCharName();
        } else if (newBinding === 'chat') {
            const meta = getChatMeta();
            if (meta) {
                if (!meta.whispers_npc_ids) meta.whispers_npc_ids = [];
                if (!meta.whispers_npc_ids.includes(npc.id)) meta.whispers_npc_ids.push(npc.id);
                saveChatMeta();
            }
        } else {
            npc.bindingTarget = null;
        }

        saveSettings();
        renderNpcList();
        overlay.remove();
        toastr.success('NPC saved');
    });

    document.body.appendChild(overlay);
}

function showNpcFolderEditPopup(folder) {
    closeAllPopups();
    const overlay = document.createElement('div');
    overlay.className = 'whispers-edit-popup-overlay';
    overlay.innerHTML = `
        <div class="whispers-edit-popup">
            <div class="whispers-edit-popup-header">
                <span style="color:${folder.color || 'inherit'}"><i class="fa-solid ${folder.icon || 'fa-folder'}"></i></span>
                <strong>Edit NPC Folder</strong>
                <span style="flex:1"></span>
                <button class="whispers-edit-popup-close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="whispers-edit-popup-body">
                <div class="whispers-field-group">
                    <label><i class="fa-solid fa-pen"></i> Name</label>
                    <input type="text" class="wf-name" value="${escapeHtml(folder.name || '')}">
                </div>
                <div class="whispers-field-group">
                    <label><i class="fa-solid fa-icons"></i> Icon</label>
                    <div class="whispers-icon-picker" id="wf-npc-icon-picker"></div>
                </div>
                <div class="whispers-color-row">
                    <label><i class="fa-solid fa-palette"></i> Color</label>
                    <input type="color" class="wf-color" value="${folder.color || '#667eea'}">
                </div>
                <div class="whispers-row">
                    <button class="menu_button wf-save"><i class="fa-solid fa-floppy-disk"></i> Save</button>
                </div>
            </div>
        </div>
    `;

    overlay.addEventListener('mousedown', (e) => e.stopPropagation());
    overlay.addEventListener('click', (e) => { e.stopPropagation(); if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.whispers-edit-popup-close').addEventListener('click', (e) => { e.stopPropagation(); overlay.remove(); });

    const pickerGrid = overlay.querySelector('#wf-npc-icon-picker');
    let selectedIcon = folder.icon || 'fa-folder';
    for (const iconName of FA_ICONS) {
        const iconBtn = document.createElement('button');
        iconBtn.type = 'button';
        iconBtn.className = 'whispers-icon-btn' + (iconName === selectedIcon ? ' selected' : '');
        iconBtn.title = iconName;
        iconBtn.innerHTML = `<i class="fa-solid ${iconName}"></i>`;
        iconBtn.addEventListener('click', () => {
            pickerGrid.querySelectorAll('.whispers-icon-btn').forEach(b => b.classList.remove('selected'));
            iconBtn.classList.add('selected');
            selectedIcon = iconName;
        });
        pickerGrid.appendChild(iconBtn);
    }

    const body = overlay.querySelector('.whispers-edit-popup-body');
    body.querySelector('.wf-save').addEventListener('click', () => {
        folder.name = body.querySelector('.wf-name').value || 'Folder';
        folder.icon = selectedIcon;
        folder.color = body.querySelector('.wf-color').value || '#667eea';
        saveSettings();
        renderNpcList();
        overlay.remove();
        toastr.success('NPC folder saved');
    });

    document.body.appendChild(overlay);
}

// ── Overlay Panel Switching ─────────────────────────────────────

function updateOverlayPanels() {
    const s = getSettings();
    const tabBar = document.getElementById('whispers-overlay-tabs');
    const chatPanel = document.getElementById('whispers-panel-chat');
    const twitterPanel = document.getElementById('whispers-panel-twitter');
    if (!tabBar || !chatPanel || !twitterPanel) return;

    const chatOn = s.chatMode !== false;
    const twitterOn = s.twitterMode === true;

    if (chatOn && twitterOn) {
        tabBar.style.display = '';
        // Show whichever tab is active
        const activeTab = tabBar.querySelector('.whispers-overlay-tab.active');
        const panel = activeTab?.dataset.panel || 'chat';
        chatPanel.style.display = panel === 'chat' ? '' : 'none';
        twitterPanel.style.display = panel === 'twitter' ? '' : 'none';
    } else if (twitterOn) {
        tabBar.style.display = 'none';
        chatPanel.style.display = 'none';
        twitterPanel.style.display = '';
    } else {
        tabBar.style.display = 'none';
        chatPanel.style.display = '';
        twitterPanel.style.display = 'none';
    }
}

// ── Twitter Feed Rendering ──────────────────────────────────────

function getUserName() {
    const ctx = SillyTavern.getContext();
    return ctx.name1 || 'User';
}

function renderTwitterFeed() {
    const feed = document.getElementById('whispers-twitter-feed');
    const empty = document.getElementById('whispers-twitter-empty');
    if (!feed) return;

    // Clear existing tweets
    feed.querySelectorAll('.whispers-tweet-wrap').forEach(e => e.remove());
    // Also clear old-style tweets (backward compat)
    feed.querySelectorAll('.whispers-tweet').forEach(e => {
        if (!e.closest('.whispers-tweet-wrap')) e.remove();
    });

    const posts = getTwitterPosts();
    if (!posts || posts.length === 0) {
        if (empty) empty.style.display = '';
        return;
    }
    if (empty) empty.style.display = 'none';

    posts.forEach((post, index) => {
        const wrap = document.createElement('div');
        wrap.className = 'whispers-tweet-wrap';
        wrap.dataset.index = index;

        const tweet = document.createElement('div');
        tweet.className = 'whispers-tweet';

        const avatarHtml = post.avatar
            ? `<img class="whispers-tweet-avatar" src="${post.avatar}" alt="">`
            : `<div class="whispers-tweet-avatar whispers-tweet-avatar-placeholder"><i class="fa-solid fa-user"></i></div>`;

        const timeAgo = post.timestamp ? getTimeAgo(post.timestamp) : 'now';

        tweet.innerHTML = `
            ${avatarHtml}
            <div class="whispers-tweet-body">
                <div class="whispers-tweet-header">
                    <span class="whispers-tweet-name">${escapeHtml(post.name || 'Anon')}</span>
                    <span class="whispers-tweet-username">@${escapeHtml(post.username || 'user')}</span>
                    <span class="whispers-tweet-time">· ${timeAgo}</span>
                </div>
                <div class="whispers-tweet-text">${escapeHtml(post.content || '')}</div>
                <div class="whispers-tweet-actions">
                    <button class="whispers-tweet-reply-btn" title="Reply"><i class="fa-solid fa-reply"></i></button>
                </div>
            </div>
        `;

        // Reply button handler
        tweet.querySelector('.whispers-tweet-reply-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            showReplyInput(wrap, post, index);
        });

        wrap.appendChild(tweet);

        // Render existing replies
        if (post.replies && post.replies.length > 0) {
            for (const reply of post.replies) {
                wrap.appendChild(buildReplyElement(reply));
            }
        }

        feed.appendChild(wrap);
    });
}

function buildReplyElement(reply) {
    const el = document.createElement('div');
    el.className = 'whispers-tweet whispers-tweet-reply';

    const isUser = reply.isUser;
    const avatarHtml = reply.avatar
        ? `<img class="whispers-tweet-avatar" src="${reply.avatar}" alt="">`
        : `<div class="whispers-tweet-avatar whispers-tweet-avatar-placeholder"><i class="fa-solid ${isUser ? 'fa-user-pen' : 'fa-user'}"></i></div>`;

    const timeAgo = reply.timestamp ? getTimeAgo(reply.timestamp) : 'now';

    el.innerHTML = `
        ${avatarHtml}
        <div class="whispers-tweet-body">
            <div class="whispers-tweet-header">
                <span class="whispers-tweet-name">${escapeHtml(reply.name || 'Anon')}</span>
                <span class="whispers-tweet-username">@${escapeHtml(reply.username || 'user')}</span>
                <span class="whispers-tweet-time">· ${timeAgo}</span>
            </div>
            <div class="whispers-tweet-text">${escapeHtml(reply.content || '')}</div>
        </div>
    `;
    return el;
}

function showReplyInput(wrapEl, post, postIndex) {
    // Don't show if already visible
    if (wrapEl.querySelector('.whispers-tweet-reply-input')) return;

    const userName = getUserName();
    const inputWrap = document.createElement('div');
    inputWrap.className = 'whispers-tweet-reply-input';
    inputWrap.innerHTML = `
        <div class="whispers-tweet-reply-input-row">
            <span class="whispers-tweet-reply-as"><i class="fa-solid fa-user-pen"></i> ${escapeHtml(userName)}</span>
            <textarea class="whispers-tweet-reply-field" placeholder="Write a reply..." rows="1"></textarea>
            <button class="whispers-tweet-reply-send" title="Send reply"><i class="fa-solid fa-paper-plane"></i></button>
        </div>
    `;

    const textarea = inputWrap.querySelector('.whispers-tweet-reply-field');
    const sendBtn = inputWrap.querySelector('.whispers-tweet-reply-send');

    // Auto-resize
    textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
    });

    // Send on Enter (no shift)
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submitReply();
        }
    });

    sendBtn.addEventListener('click', submitReply);

    async function submitReply() {
        const text = textarea.value.trim();
        if (!text) return;

        sendBtn.disabled = true;
        textarea.disabled = true;

        // Add user reply to posts
        const posts = getTwitterPosts();
        if (!posts[postIndex]) return;
        if (!posts[postIndex].replies) posts[postIndex].replies = [];

        const userReply = {
            name: userName,
            username: userName.toLowerCase().replace(/\s+/g, '_'),
            content: text,
            isUser: true,
            timestamp: Date.now(),
        };
        posts[postIndex].replies.push(userReply);
        setTwitterPosts(posts);

        // Remove input, render user reply
        inputWrap.remove();
        wrapEl.appendChild(buildReplyElement(userReply));

        // Now generate NPC reaction
        await generateTweetReply(post, userReply, postIndex, wrapEl);
    }

    wrapEl.appendChild(inputWrap);
    textarea.focus();
}

async function generateTweetReply(originalPost, userReply, postIndex, wrapEl) {
    const s = getSettings();
    if (!s.enabled) return;

    // Find the NPC who made the original post
    const activeNpcs = getActiveNpcs();
    const npc = activeNpcs.find(n =>
        n.username.toLowerCase() === (originalPost.username || '').toLowerCase() ||
        n.name.toLowerCase() === (originalPost.name || '').toLowerCase()
    );

    let npcContext = '';
    if (npc) {
        npcContext = `You are ${npc.name} (@${npc.username}).`;
        if (npc.character) npcContext += ` Character: ${npc.character}.`;
        if (npc.postExample) npcContext += ` Example of your style: "${npc.postExample}".`;
        if (npc.bans) npcContext += ` Never say: ${npc.bans}.`;
    } else {
        npcContext = `You are ${originalPost.name} (@${originalPost.username}), a social media user.`;
    }

    const prompt = `${npcContext}

You wrote this post on social media:
"${originalPost.content}"

A user named ${userReply.name} (@${userReply.username}) just replied to your post:
"${userReply.content}"

Write a SHORT reply back to them (1-3 sentences). Stay in character. Be reactive — if they're being rude, you can be sassy or upset. If they're nice, be friendly. React naturally and emotionally. Do NOT use any JSON formatting, just write the reply text directly.`;

    try {
        // Show loading indicator
        const loader = document.createElement('div');
        loader.className = 'whispers-tweet-reply-loading';
        loader.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> typing...';
        wrapEl.appendChild(loader);

        const messages = [{ role: 'system', content: prompt }];
        const responseText = await callApi(messages);

        loader.remove();

        // Clean response
        const cleanReply = responseText.trim().replace(/^["']|["']$/g, '');

        if (cleanReply) {
            const npcReplyData = {
                name: originalPost.name,
                username: originalPost.username,
                content: cleanReply,
                avatar: originalPost.avatar || (npc?.avatar || null),
                isUser: false,
                timestamp: Date.now(),
            };

            // Save to posts
            const posts = getTwitterPosts();
            if (posts[postIndex]) {
                if (!posts[postIndex].replies) posts[postIndex].replies = [];
                posts[postIndex].replies.push(npcReplyData);
                setTwitterPosts(posts);
            }

            // Render
            wrapEl.appendChild(buildReplyElement(npcReplyData));
        }
    } catch (err) {
        console.error('[Whispers] Tweet reply error:', err);
        toastr.error(`Reply failed: ${err.message}`);
    }
}


function getTimeAgo(timestamp) {
    const diff = Date.now() - timestamp;
    if (diff < 60000) return 'now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h';
    return Math.floor(diff / 86400000) + 'd';
}

// ── Twitter Post Generation ─────────────────────────────────────

let isGeneratingTwitter = false;

async function generateTwitterPosts() {
    if (isGeneratingTwitter) return;
    const s = getSettings();
    if (!s.enabled) return;

    isGeneratingTwitter = true;
    const refreshBtn = document.getElementById('whispers-tweet-refresh');
    if (refreshBtn) refreshBtn.disabled = true;

    try {
        const context = gatherContext();
        const activeNpcs = getActiveNpcs();
        const postCount = Math.max(3, Math.min(5, activeNpcs.length > 0 ? activeNpcs.length + 1 : 4));

        let npcCardsText = '';
        if (activeNpcs.length > 0) {
            npcCardsText = 'The following NPC characters MUST appear in the posts. Use their exact names and usernames:\n\n';
            for (const npc of activeNpcs) {
                npcCardsText += `- Name: ${npc.name}, Username: @${npc.username}`;
                if (npc.character) npcCardsText += `, Character: ${npc.character}`;
                if (npc.postExample) npcCardsText += `, Example post: "${npc.postExample}"`;
                if (npc.bans) npcCardsText += `, Never say: ${npc.bans}`;
                npcCardsText += '\n';
            }
            npcCardsText += '\nYou may add 1-2 additional made-up commenters for variety.';
        } else {
            npcCardsText = 'No specific NPCs are configured. Invent 3-5 diverse, creative social media users with unique personalities.';
        }

        let prompt = s.twitterPromptTemplate || defaultSettings.twitterPromptTemplate;
        prompt = prompt.replace('{{npc_cards}}', npcCardsText);
        prompt = prompt.replace('{{context}}', context);
        prompt = prompt.replace('{{post_count}}', String(postCount));

        const messages = [{ role: 'system', content: prompt }];
        const responseText = await callApi(messages);

        // Parse JSON from response
        const posts = parseTwitterResponse(responseText, activeNpcs);
        if (posts.length > 0) {
            setTwitterPosts(posts);
            renderTwitterFeed();
        }
    } catch (err) {
        console.error('[Whispers] Twitter generation error:', err);
        toastr.error(`Twitter feed: ${err.message}`);
    } finally {
        isGeneratingTwitter = false;
        if (refreshBtn) refreshBtn.disabled = false;
    }
}

function parseTwitterResponse(text, activeNpcs) {
    // Try to extract JSON array from response
    let posts = [];
    try {
        // Find JSON array in the response
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed)) {
                posts = parsed.map(p => ({
                    name: p.name || 'Anon',
                    username: (p.username || 'user').replace(/^@/, ''),
                    content: p.content || p.text || '',
                    avatar: findNpcAvatar(p.username || p.name, activeNpcs),
                    timestamp: Date.now(),
                })).filter(p => p.content.length > 0);
            }
        }
    } catch (e) {
        console.warn('[Whispers] Failed to parse Twitter JSON, trying fallback:', e);
    }

    // Fallback: try line-by-line parsing
    if (posts.length === 0) {
        const lines = text.split('\n').filter(l => l.trim().length > 10);
        for (const line of lines.slice(0, 5)) {
            posts.push({
                name: 'User',
                username: 'user',
                content: line.trim().replace(/^[-*•]\s*/, ''),
                timestamp: Date.now(),
            });
        }
    }

    return posts;
}

function findNpcAvatar(usernameOrName, npcs) {
    if (!npcs || npcs.length === 0) return null;
    const clean = (usernameOrName || '').replace(/^@/, '').toLowerCase();
    const match = npcs.find(n =>
        n.username.toLowerCase() === clean ||
        n.name.toLowerCase() === clean
    );
    return match?.avatar || null;
}

// ── Proactive Chat Messages ─────────────────────────────────────

async function triggerProactiveChat() {
    const s = getSettings();
    if (!s.chatMode || s.chatProactive === 'none') return;
    const assistant = getActiveAssistant();
    if (!assistant) return;

    const context = gatherContext();
    let instruction = '';
    switch (s.chatProactive) {
        case 'comment':
            instruction = 'React to the latest events in the main chat. Comment on what just happened — be witty or insightful.';
            break;
        case 'advice':
            instruction = 'Give the user a helpful suggestion or advice based on the current conversation context.';
            break;
        case 'checkin':
            instruction = 'Check in on the user casually. Be friendly and ask how things are going. If something interesting happened recently, mention it.';
            break;
        default: return;
    }

    const history = getWhispersHistory();
    const prompt = (s.mainPromptTemplate || defaultSettings.mainPromptTemplate)
        .replace('{{name}}', assistant.name || 'Assistant')
        .replace('{{character}}', assistant.character || '')
        .replace('{{bans}}', assistant.bans || '')
        .replace('{{context}}', context);

    const messages = [
        { role: 'system', content: prompt },
        ...history.slice(-10).map(m => ({ role: m.role, content: m.content })),
        { role: 'system', content: `[Instruction: ${instruction}. Respond naturally as the assistant, don't mention that you were prompted.]` }
    ];

    try {
        showTyping();
        const statusEl = document.getElementById('whispers-chat-status');
        if (statusEl) statusEl.textContent = 'Typing...';

        const response = await callApi(messages);
        hideTyping();

        history.push({ role: 'assistant', content: response, timestamp: Date.now() });
        await saveChatMeta();
        addBubble('assistant', response);

        if (statusEl) statusEl.textContent = 'Online';
    } catch (err) {
        hideTyping();
        console.error('[Whispers] Proactive chat error:', err);
    }
}

// ── Automation Handler ──────────────────────────────────────────

async function onMainChatMessage() {
    const s = getSettings();
    if (!s.enabled) return;

    const counter = incrementMsgCounter();

    // Twitter automation
    if (s.twitterMode) {
        const shouldTriggerTwitter =
            s.twitterAutoMode === 'every' ||
            (s.twitterAutoMode === 'custom' && counter % (s.twitterAutoInterval || 5) === 0);
        if (shouldTriggerTwitter) {
            generateTwitterPosts();
        }
    }

    // Chat proactive automation
    if (s.chatMode && s.chatProactive !== 'none') {
        const shouldTriggerChat =
            s.chatAutoMode === 'every' ||
            (s.chatAutoMode === 'custom' && counter % (s.chatAutoInterval || 3) === 0);
        if (shouldTriggerChat) {
            triggerProactiveChat();
        }
    }
}



const FA_ICONS = [
    'fa-folder','fa-folder-open','fa-star','fa-heart','fa-fire','fa-bolt',
    'fa-crown','fa-gem','fa-shield','fa-wand-magic-sparkles','fa-hat-wizard',
    'fa-dragon','fa-ghost','fa-skull','fa-cat','fa-dog','fa-paw','fa-feather',
    'fa-dove','fa-fish','fa-spider','fa-bug','fa-leaf','fa-tree','fa-seedling',
    'fa-sun','fa-moon','fa-cloud','fa-snowflake','fa-rainbow','fa-umbrella',
    'fa-music','fa-guitar','fa-headphones','fa-gamepad','fa-puzzle-piece',
    'fa-dice','fa-chess','fa-palette','fa-brush','fa-pen-fancy','fa-book',
    'fa-book-open','fa-scroll','fa-graduation-cap','fa-flask','fa-atom',
    'fa-rocket','fa-plane','fa-car','fa-bicycle','fa-ship','fa-anchor',
    'fa-compass','fa-map','fa-mountain','fa-water','fa-campground',
    'fa-house','fa-building','fa-store','fa-hospital','fa-church',
    'fa-landmark','fa-trophy','fa-medal','fa-flag','fa-gift','fa-cake-candles',
    'fa-champagne-glasses','fa-bell','fa-envelope','fa-comment','fa-comments',
    'fa-circle-info','fa-lightbulb','fa-gear','fa-wrench','fa-hammer',
    'fa-screwdriver-wrench','fa-key','fa-lock','fa-unlock','fa-eye',
    'fa-hand','fa-thumbs-up','fa-face-smile','fa-face-laugh','fa-masks-theater',
    'fa-robot','fa-microchip','fa-code','fa-terminal','fa-database',
    'fa-server','fa-network-wired','fa-wifi','fa-globe','fa-earth-americas',
    'fa-user','fa-users','fa-user-secret','fa-people-group',
    'fa-suitcase','fa-briefcase','fa-box','fa-cubes','fa-tag','fa-tags',
];

// ── UI: Render Item List (Folders + Assistants) ─────────────────

function renderItemList() {
    const settings = getSettings();
    const list = document.getElementById('whispers-item-list');
    if (!list) return;
    list.innerHTML = '';

    // Render folders
    for (const folder of settings.folders) {
        const folderAssistants = settings.assistants.filter(a => a.folderId === folder.id);
        const folderEl = document.createElement('div');
        folderEl.className = 'whispers-folder';
        folderEl.dataset.id = folder.id;
        folderEl.style.setProperty('--folder-color', folder.color || '#888');

        folderEl.innerHTML = `
            <div class="whispers-folder-header">
                <span class="whispers-folder-icon" style="color:${folder.color || 'inherit'}">
                    <i class="fa-solid ${folder.icon || 'fa-folder'}"></i>
                </span>
                <span class="whispers-folder-name">${escapeHtml(folder.name || 'Folder')}</span>
                <span class="whispers-folder-count">${folderAssistants.length}</span>
                <span class="whispers-folder-actions">
                    <button class="folder-info-btn" title="Author's Note"><i class="fa-solid fa-circle-info"></i></button>
                    <button class="edit-folder-btn" title="Edit"><i class="fa-solid fa-pen"></i></button>
                    <button class="export-folder-btn" title="Export"><i class="fa-solid fa-file-export"></i></button>
                    <button class="delete-btn" title="Delete"><i class="fa-solid fa-trash"></i></button>
                </span>
                <i class="fa-solid fa-chevron-right whispers-folder-chevron"></i>
            </div>
            <div class="whispers-folder-children"></div>
        `;

        // Folder header click to expand/collapse
        const header = folderEl.querySelector('.whispers-folder-header');
        header.addEventListener('click', (e) => {
            if (e.target.closest('.whispers-folder-actions')) return;
            folderEl.classList.toggle('open');
        });

        // Author's note popup (always visible)
        folderEl.querySelector('.folder-info-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            showNotePopup(folder);
        });

        // Edit folder
        folderEl.querySelector('.edit-folder-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            showFolderEditPopup(folder);
        });

        // Export folder
        folderEl.querySelector('.export-folder-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            exportFolderToPng(folder, folderAssistants);
        });

        // Delete folder
        folderEl.querySelector('.delete-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            showConfirmationPopup(`Delete folder "${folder.name}" and all its assistants?`, () => {
                // Delete folder
                settings.folders = settings.folders.filter(f => f.id !== folder.id);
                // Delete assistants in folder
                settings.assistants = settings.assistants.filter(a => a.folderId !== folder.id);
                // Clear selection if needed
                if (editingAssistantId) {
                    const exists = settings.assistants.find(a => a.id === editingAssistantId);
                    if (!exists) editingAssistantId = null;
                }
                const meta = getChatMeta();
                if (meta && meta.whispers_assistant_id) {
                    const exists = settings.assistants.find(a => a.id === meta.whispers_assistant_id);
                    if (!exists) { delete meta.whispers_assistant_id; saveChatMeta(); }
                }

                saveSettings();
                renderItemList();
                updateChatHeader();
                toastr.success('Folder and contents deleted');
            });
        });

        // Drag-and-drop: folder as drop target
        const childrenEl = folderEl.querySelector('.whispers-folder-children');
        folderEl.addEventListener('dragover', (e) => {
            e.preventDefault();
            folderEl.classList.add('drag-over');
        });
        folderEl.addEventListener('dragleave', (e) => {
            if (!folderEl.contains(e.relatedTarget)) folderEl.classList.remove('drag-over');
        });
        folderEl.addEventListener('drop', (e) => {
            e.preventDefault();
            folderEl.classList.remove('drag-over');
            const asstId = e.dataTransfer.getData('text/plain');
            if (asstId) {
                const asst = settings.assistants.find(a => a.id === asstId);
                if (asst) {
                    asst.folderId = folder.id;
                    saveSettings();
                    renderItemList();
                    toastr.success(`Moved "${asst.name}" to "${folder.name}"`);
                }
            }
        });

        // Add assistants inside folder
        for (const asst of folderAssistants) {
            childrenEl.appendChild(createAssistantItem(asst));
        }

        list.appendChild(folderEl);
    }

    // Render unfoldered assistants
    const unfoldered = settings.assistants.filter(a => !a.folderId);
    for (const asst of unfoldered) {
        list.appendChild(createAssistantItem(asst));
    }

    // Drop-to-root zone
    list.addEventListener('dragover', (e) => { e.preventDefault(); });
    list.addEventListener('drop', (e) => {
        if (e.target.closest('.whispers-folder')) return; // handled by folder
        e.preventDefault();
        const asstId = e.dataTransfer.getData('text/plain');
        if (asstId) {
            const asst = settings.assistants.find(a => a.id === asstId);
            if (asst && asst.folderId) {
                asst.folderId = null;
                saveSettings();
                renderItemList();
                toastr.info(`Removed "${asst.name}" from folder`);
            }
        }
    });

    if (settings.folders.length === 0 && settings.assistants.length === 0) {
        list.innerHTML = '<div style="opacity:0.4;font-size:0.85em;text-align:center;padding:10px;">No assistants yet</div>';
    }
}

function createAssistantItem(asst) {
    const settings = getSettings();
    const container = document.createElement('div');

    // Item row
    const item = document.createElement('div');
    item.className = 'whispers-assistant-item';
    item.dataset.id = asst.id;
    item.draggable = true;

    const avatarHtml = asst.avatar
        ? `<img class="whispers-assistant-avatar" src="${asst.avatar}" alt="">`
        : `<div class="whispers-assistant-avatar-placeholder"><i class="fa-solid fa-ghost"></i></div>`;

    // Binding badge
    let badge = '';
    if (asst.binding === 'global') badge = '<i class="fa-solid fa-globe whispers-badge" title="Global"></i>';
    else if (asst.binding === 'character') badge = `<i class="fa-solid fa-user whispers-badge" title="Character: ${escapeHtml(asst.bindingTarget || '')}"></i>`;
    else if (asst.binding === 'chat') badge = '<i class="fa-solid fa-comment whispers-badge" title="Chat-bound"></i>';

    item.innerHTML = `
        ${avatarHtml}
        <span class="whispers-assistant-name">${escapeHtml(asst.name || 'Unnamed')}</span>
        <span class="whispers-assistant-badges">${badge}</span>
        <span class="whispers-assistant-actions">
            <button class="asst-info-btn" title="Author's Note"><i class="fa-solid fa-circle-info"></i></button>
            <button class="edit-asst-btn" title="Edit"><i class="fa-solid fa-pen"></i></button>
            <button class="export-btn" title="Export PNG"><i class="fa-solid fa-file-export"></i></button>
            <button class="delete-btn" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </span>
    `;

    // Drag start
    item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', asst.id);
        e.dataTransfer.effectAllowed = 'move';
        item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
    });

    // Click row to open edit popup
    item.addEventListener('click', (e) => {
        if (e.target.closest('.whispers-assistant-actions')) return;
        showAssistantEditPopup(asst);
    });

    // Info (author's note)
    item.querySelector('.asst-info-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        showAssistantNotePopup(asst);
    });

    // Edit
    item.querySelector('.edit-asst-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        showAssistantEditPopup(asst);
    });

    // Export
    item.querySelector('.export-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        exportAssistantToPng(asst);
    });

    // Delete
    item.querySelector('.delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        showConfirmationPopup(`Delete "${asst.name}"?`, () => {
            settings.assistants = settings.assistants.filter(a => a.id !== asst.id);
            if (editingAssistantId === asst.id) editingAssistantId = null;
            const meta = getChatMeta();
            if (meta && meta.whispers_assistant_id === asst.id) delete meta.whispers_assistant_id;
            saveSettings();
            renderItemList();
            updateChatHeader();
            toastr.success('Assistant deleted');
        });
    });

    container.appendChild(item);
    return container;
}

// ── Assistant Edit Popup ────────────────────────────────────────

function showAssistantEditPopup(asst) {
    closeAllPopups();
    const charName = getCurrentCharName();

    const overlay = document.createElement('div');
    overlay.className = 'whispers-edit-popup-overlay';
    overlay.innerHTML = `
        <div class="whispers-edit-popup">
            <div class="whispers-edit-popup-header">
                <i class="fa-solid fa-ghost"></i>
                <strong>Edit Assistant</strong>
                <span style="flex:1"></span>
                <button class="whispers-edit-popup-close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="whispers-edit-popup-body">
                <div class="whispers-avatar-upload">
                    <div class="whispers-avatar-preview-placeholder" id="whispers-popup-avatar" title="Click to set avatar" style="cursor:pointer;">
                        ${asst.avatar ? `<img class="whispers-avatar-preview" src="${asst.avatar}" alt="">` : '<i class="fa-solid fa-image"></i>'}
                    </div>
                    <span style="font-size:0.8em;opacity:0.6;">Click to set avatar</span>
                </div>
                <div class="whispers-field-group">
                    <label><i class="fa-solid fa-signature"></i> Name</label>
                    <input type="text" class="w-edit-name" value="${escapeHtml(asst.name || '')}" placeholder="Name">
                </div>
                <div class="whispers-field-group">
                    <label><i class="fa-solid fa-masks-theater"></i> Character</label>
                    <textarea class="w-edit-character" rows="3" placeholder="Personality...">${escapeHtml(asst.character || '')}</textarea>
                </div>
                <div class="whispers-field-group">
                    <label><i class="fa-solid fa-ban"></i> Bans</label>
                    <textarea class="w-edit-bans" rows="2" placeholder="Never say...">${escapeHtml(asst.bans || '')}</textarea>
                </div>
                <div class="whispers-field-group">
                    <label><i class="fa-solid fa-comment-dots"></i> Message Example</label>
                    <textarea class="w-edit-example" rows="3" placeholder="Write an example of how this assistant should respond...">${escapeHtml(asst.messageExample || '')}</textarea>
                </div>
                <div class="whispers-field-group">
                    <label><i class="fa-solid fa-link"></i> Binding</label>
                    <select class="w-edit-binding">
                        <option value="none" ${asst.binding === 'none' || !asst.binding ? 'selected' : ''}>None</option>
                        <option value="global" ${asst.binding === 'global' ? 'selected' : ''}>Global (all chats)</option>
                        <option value="character" ${asst.binding === 'character' ? 'selected' : ''}>Character${charName ? ` (${charName})` : ''}</option>
                        <option value="chat" ${asst.binding === 'chat' ? 'selected' : ''}>This Chat</option>
                    </select>
                </div>
                <div class="whispers-field-group">
                    <label><i class="fa-solid fa-note-sticky"></i> Author's Note <span style="font-size:0.75em;opacity:0.5;">(HTML supported)</span></label>
                    <textarea class="w-edit-note" rows="3" placeholder="Notes about this assistant...">${escapeHtml(asst.note || '')}</textarea>
                </div>
                <div class="whispers-row">
                    <button class="menu_button w-save-btn"><i class="fa-solid fa-floppy-disk"></i> Save</button>
                </div>
            </div>
        </div>
    `;

    // Close — stopPropagation prevents ST drawer from collapsing
    overlay.addEventListener('mousedown', (e) => e.stopPropagation());
    overlay.addEventListener('click', (e) => { e.stopPropagation(); if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.whispers-edit-popup-close').addEventListener('click', (e) => { e.stopPropagation(); overlay.remove(); });

    const body = overlay.querySelector('.whispers-edit-popup-body');

    // Avatar click
    body.querySelector('#whispers-popup-avatar').addEventListener('click', () => {
        const fileInput = document.getElementById('whispers-avatar-file');
        fileInput.dataset.targetAssistant = asst.id;
        fileInput.click();
    });

    // Save
    body.querySelector('.w-save-btn').addEventListener('click', () => {
        asst.name = body.querySelector('.w-edit-name').value || 'Unnamed';
        asst.character = body.querySelector('.w-edit-character').value || '';
        asst.bans = body.querySelector('.w-edit-bans').value || '';
        asst.messageExample = body.querySelector('.w-edit-example').value || '';
        asst.note = body.querySelector('.w-edit-note').value || '';

        const newBinding = body.querySelector('.w-edit-binding').value;
        asst.binding = newBinding;
        if (newBinding === 'character') {
            asst.bindingTarget = getCurrentCharName();
        } else if (newBinding === 'chat') {
            const meta = getChatMeta();
            if (meta) meta.whispers_assistant_id = asst.id;
            saveChatMeta();
        } else {
            asst.bindingTarget = null;
        }

        saveSettings();
        renderItemList();
        updateChatHeader();
        overlay.remove();
        toastr.success('Assistant saved');
    });

    document.body.appendChild(overlay);
}

// ── Folder Edit Popup ───────────────────────────────────────────

function showFolderEditPopup(folder) {
    closeAllPopups();

    const overlay = document.createElement('div');
    overlay.className = 'whispers-edit-popup-overlay';
    overlay.innerHTML = `
        <div class="whispers-edit-popup">
            <div class="whispers-edit-popup-header">
                <span style="color:${folder.color || 'inherit'}"><i class="fa-solid ${folder.icon || 'fa-folder'}"></i></span>
                <strong>Edit Folder</strong>
                <span style="flex:1"></span>
                <button class="whispers-edit-popup-close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="whispers-edit-popup-body">
                <div class="whispers-field-group">
                    <label><i class="fa-solid fa-pen"></i> Name</label>
                    <input type="text" class="wf-name" value="${escapeHtml(folder.name || '')}">
                </div>
                <div class="whispers-field-group">
                    <label><i class="fa-solid fa-icons"></i> Icon</label>
                    <div class="whispers-icon-picker" id="wf-icon-picker"></div>
                </div>
                <div class="whispers-color-row">
                    <label><i class="fa-solid fa-palette"></i> Color</label>
                    <input type="color" class="wf-color" value="${folder.color || '#667eea'}">
                </div>
                <div class="whispers-field-group">
                    <label><i class="fa-solid fa-note-sticky"></i> Author's Note <span style="font-size:0.75em;opacity:0.5;">(HTML supported)</span></label>
                    <textarea class="wf-note" rows="3" placeholder="Describe what's in this folder...">${escapeHtml(folder.note || '')}</textarea>
                </div>
                <div class="whispers-row">
                    <button class="menu_button wf-save"><i class="fa-solid fa-floppy-disk"></i> Save</button>
                </div>
            </div>
        </div>
    `;

    // Close — stopPropagation prevents ST drawer from collapsing
    overlay.addEventListener('mousedown', (e) => e.stopPropagation());
    overlay.addEventListener('click', (e) => { e.stopPropagation(); if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.whispers-edit-popup-close').addEventListener('click', (e) => { e.stopPropagation(); overlay.remove(); });

    // Build icon picker grid
    const pickerGrid = overlay.querySelector('#wf-icon-picker');
    let selectedIcon = folder.icon || 'fa-folder';
    for (const iconName of FA_ICONS) {
        const iconBtn = document.createElement('button');
        iconBtn.type = 'button';
        iconBtn.className = 'whispers-icon-btn' + (iconName === selectedIcon ? ' selected' : '');
        iconBtn.title = iconName;
        iconBtn.innerHTML = `<i class="fa-solid ${iconName}"></i>`;
        iconBtn.addEventListener('click', () => {
            pickerGrid.querySelectorAll('.whispers-icon-btn').forEach(b => b.classList.remove('selected'));
            iconBtn.classList.add('selected');
            selectedIcon = iconName;
        });
        pickerGrid.appendChild(iconBtn);
    }

    // Save
    const body = overlay.querySelector('.whispers-edit-popup-body');
    body.querySelector('.wf-save').addEventListener('click', () => {
        folder.name = body.querySelector('.wf-name').value || 'Folder';
        folder.icon = selectedIcon;
        folder.color = body.querySelector('.wf-color').value || '#667eea';
        folder.note = body.querySelector('.wf-note').value || '';
        saveSettings();
        renderItemList();
        overlay.remove();
        toastr.success('Folder saved');
    });

    document.body.appendChild(overlay);
}

// ── Author's Note Popup ─────────────────────────────────────────

function showNotePopup(folder) {
    closeAllPopups();

    const overlay = document.createElement('div');
    overlay.className = 'whispers-edit-popup-overlay';
    overlay.innerHTML = `
        <div class="whispers-note-popup">
            <div class="whispers-note-popup-header">
                <span style="color:${folder.color || 'inherit'}">
                    <i class="fa-solid ${folder.icon || 'fa-folder'}"></i>
                </span>
                <strong>${escapeHtml(folder.name || 'Folder')}</strong>
                <span style="flex:1"></span>
                <button class="whispers-note-popup-close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="whispers-note-popup-body">${folder.note || '<em style="opacity:0.5;">No notes yet</em>'}</div>
        </div>
    `;

    overlay.addEventListener('mousedown', (e) => e.stopPropagation());
    overlay.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.target === overlay) overlay.remove();
    });
    overlay.querySelector('.whispers-note-popup-close').addEventListener('click', (e) => { e.stopPropagation(); overlay.remove(); });

    document.body.appendChild(overlay);
}

// ── Assistant Note Popup ────────────────────────────────────────

function showAssistantNotePopup(asst) {
    closeAllPopups();

    const overlay = document.createElement('div');
    overlay.className = 'whispers-edit-popup-overlay';

    const avatarHtml = asst.avatar
        ? `<img src="${asst.avatar}" alt="" style="width:20px;height:20px;border-radius:50%;object-fit:cover;">`
        : '<i class="fa-solid fa-ghost"></i>';

    overlay.innerHTML = `
        <div class="whispers-note-popup">
            <div class="whispers-note-popup-header">
                ${avatarHtml}
                <strong>${escapeHtml(asst.name || 'Assistant')}</strong>
                <span style="flex:1"></span>
                <button class="whispers-note-popup-close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="whispers-note-popup-body">${asst.note || '<em style="opacity:0.5;">No notes yet</em>'}</div>
        </div>
    `;

    overlay.addEventListener('mousedown', (e) => e.stopPropagation());
    overlay.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.target === overlay) overlay.remove();
    });
    overlay.querySelector('.whispers-note-popup-close').addEventListener('click', (e) => { e.stopPropagation(); overlay.remove(); });

    document.body.appendChild(overlay);
}

// ── Confirmation Popup ────────────────────────────────────────

function showConfirmationPopup(message, onConfirm) {
    closeAllPopups();
    const overlay = document.createElement('div');
    overlay.className = 'whispers-edit-popup-overlay';
    overlay.innerHTML = `
        <div class="whispers-edit-popup" style="width: min(320px, 90vw);">
            <div class="whispers-edit-popup-header">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <strong>Confirm Action</strong>
            </div>
            <div class="whispers-edit-popup-body" style="text-align:center; padding: 20px;">
                <p>${escapeHtml(message)}</p>
                <div class="whispers-row" style="justify-content:center; gap:10px; margin-top:10px;">
                    <button class="menu_button wf-confirm-yes" style="background:var(--SmartThemeQuoteColor); color:var(--SmartThemeQuoteFontColor);"><i class="fa-solid fa-check"></i> Yes</button>
                    <button class="menu_button wf-confirm-no"><i class="fa-solid fa-xmark"></i> No</button>
                </div>
            </div>
        </div>
    `;

    overlay.addEventListener('mousedown', (e) => e.stopPropagation());
    overlay.addEventListener('click', (e) => { e.stopPropagation(); if (e.target === overlay) overlay.remove(); });
    
    overlay.querySelector('.wf-confirm-yes').addEventListener('click', () => {
        onConfirm();
        overlay.remove();
    });
    
    overlay.querySelector('.wf-confirm-no').addEventListener('click', () => {
        overlay.remove();
    });

    document.body.appendChild(overlay);
}

// ── Helper: close all popups ────────────────────────────────────

function closeAllPopups() {
    document.querySelectorAll('.whispers-edit-popup-overlay').forEach(el => el.remove());
}

// ── Chat UI ─────────────────────────────────────────────────────

function renderChatMessages() {
    const el = document.getElementById('whispers-messages');
    const empty = document.getElementById('whispers-empty-state');
    if (!el) return;
    el.querySelectorAll('.whispers-msg, .whispers-typing').forEach(e => e.remove());
    const history = getWhispersHistory();
    if (history.length === 0) { if (empty) empty.style.display = ''; return; }
    if (empty) empty.style.display = 'none';
    for (const msg of history) {
        const b = document.createElement('div');
        b.className = `whispers-msg whispers-msg-${msg.role}`;
        const t = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        b.innerHTML = `${escapeHtml(msg.content)}<span class="whispers-msg-time">${t}</span>`;
        el.appendChild(b);
    }
    el.scrollTop = el.scrollHeight;
}

function addBubble(role, content) {
    const el = document.getElementById('whispers-messages');
    const empty = document.getElementById('whispers-empty-state');
    if (!el) return;
    if (empty) empty.style.display = 'none';
    const b = document.createElement('div');
    b.className = `whispers-msg whispers-msg-${role}`;
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    b.innerHTML = `${escapeHtml(content)}<span class="whispers-msg-time">${t}</span>`;
    el.appendChild(b);
    el.scrollTop = el.scrollHeight;
}

function showTyping() {
    const el = document.getElementById('whispers-messages');
    if (!el) return;
    hideTyping();
    const t = document.createElement('div');
    t.className = 'whispers-typing'; t.id = 'whispers-typing-indicator';
    t.innerHTML = '<div class="whispers-typing-dot"></div><div class="whispers-typing-dot"></div><div class="whispers-typing-dot"></div>';
    el.appendChild(t);
    el.scrollTop = el.scrollHeight;
}

function hideTyping() {
    document.getElementById('whispers-typing-indicator')?.remove();
}

function updateChatHeader() {
    const a = getActiveAssistant();
    const nameEl = document.getElementById('whispers-chat-name');
    const avatarEl = document.getElementById('whispers-chat-avatar');
    const statusEl = document.getElementById('whispers-chat-status');
    if (a) {
        if (nameEl) nameEl.textContent = a.name || 'Assistant';
        if (statusEl) statusEl.textContent = 'Online';
        if (avatarEl) {
            if (a.avatar) {
                avatarEl.innerHTML = `<img class="whispers-chat-header-avatar" src="${a.avatar}" alt="">`;
                avatarEl.className = '';
            } else {
                avatarEl.innerHTML = '<i class="fa-solid fa-ghost"></i>';
                avatarEl.className = 'whispers-chat-header-avatar-placeholder';
            }
        }
    } else {
        if (nameEl) nameEl.textContent = 'Whispers';
        if (statusEl) statusEl.textContent = 'No assistant configured';
        if (avatarEl) { avatarEl.innerHTML = '<i class="fa-solid fa-ghost"></i>'; avatarEl.className = 'whispers-chat-header-avatar-placeholder'; }
    }
}

function openChat() {
    const o = document.getElementById('whispers-overlay');
    if (o) { o.classList.add('open'); updateChatHeader(); renderChatMessages(); setTimeout(() => document.getElementById('whispers-input')?.focus(), 350); }
}

function closeChat() {
    document.getElementById('whispers-overlay')?.classList.remove('open');
}

// ── Send Message ────────────────────────────────────────────────

async function sendMessage() {
    if (isGenerating) return;
    const input = document.getElementById('whispers-input');
    const sendBtn = document.getElementById('whispers-send');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;

    const assistant = getActiveAssistant();
    if (!assistant) { toastr.warning('No assistant configured.'); return; }

    const history = getWhispersHistory();
    history.push({ role: 'user', content: text, timestamp: Date.now() });
    await saveChatMeta();

    input.value = ''; autoResize();
    addBubble('user', text);
    showTyping();

    isGenerating = true;
    if (sendBtn) sendBtn.disabled = true;
    const statusEl = document.getElementById('whispers-chat-status');
    if (statusEl) statusEl.textContent = 'Typing...';

    try {
        const response = await generateResponse(text);
        hideTyping();
        history.push({ role: 'assistant', content: response, timestamp: Date.now() });
        await saveChatMeta();
        addBubble('assistant', response);
    } catch (err) {
        hideTyping();
        toastr.error(`Whispers: ${err.message}`);
        addBubble('assistant', `Error: ${err.message}`);
    } finally {
        isGenerating = false;
        if (sendBtn) sendBtn.disabled = false;
        if (statusEl) statusEl.textContent = 'Online';
    }
}

function autoResize() {
    const input = document.getElementById('whispers-input');
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}

// ── Load Settings UI ────────────────────────────────────────────

function loadSettingsUI() {
    const s = getSettings();
    const el = (id) => document.getElementById(id);

    // Enabled toggle
    const enabledCheck = el('whispers-enabled');
    if (enabledCheck) enabledCheck.checked = s.enabled !== false;

    if (el('whispers-api-url')) el('whispers-api-url').value = s.extraApiUrl || '';
    if (el('whispers-api-key')) el('whispers-api-key').value = s.extraApiKey || '';
    if (el('whispers-msg-limit')) el('whispers-msg-limit').value = s.messageLimit || 20;

    const extraCheck = el('whispers-use-extra-api');
    if (extraCheck) {
        extraCheck.checked = s.useExtraApi || false;
        toggleApiSection(s.useExtraApi);
    }

    if (s.extraApiModel) {
        const select = el('whispers-model-select');
        if (select && !select.querySelector(`option[value="${s.extraApiModel}"]`)) {
            const opt = document.createElement('option');
            opt.value = s.extraApiModel;
            opt.textContent = s.extraApiModel;
            opt.selected = true;
            select.appendChild(opt);
        } else if (select) {
            select.value = s.extraApiModel;
        }
    }

    // Mode toggles
    const modeChat = el('whispers-mode-chat');
    if (modeChat) modeChat.checked = s.chatMode !== false;
    const modeTwitter = el('whispers-mode-twitter');
    if (modeTwitter) modeTwitter.checked = s.twitterMode === true;

    // Automation radios
    const chatAutoRadio = document.querySelector(`input[name="whispers-chat-auto"][value="${s.chatAutoMode || 'button'}"]`);
    if (chatAutoRadio) chatAutoRadio.checked = true;
    const twitterAutoRadio = document.querySelector(`input[name="whispers-twitter-auto"][value="${s.twitterAutoMode || 'button'}"]`);
    if (twitterAutoRadio) twitterAutoRadio.checked = true;

    if (el('whispers-chat-interval')) el('whispers-chat-interval').value = s.chatAutoInterval || 3;
    if (el('whispers-twitter-interval')) el('whispers-twitter-interval').value = s.twitterAutoInterval || 5;

    // Proactive radio
    const proactiveRadio = document.querySelector(`input[name="whispers-chat-proactive"][value="${s.chatProactive || 'none'}"]`);
    if (proactiveRadio) proactiveRadio.checked = true;

    // Setup tab switching
    setupTabs();

    renderItemList();
    renderNpcList();
}

function setupTabs() {
    const tabs = document.querySelectorAll('.whispers-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.tab;
            // Update active tab
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            // Show/hide content
            document.querySelectorAll('.whispers-tab-content').forEach(c => c.style.display = 'none');
            const content = document.getElementById(`whispers-tab-${target}`);
            if (content) content.style.display = '';
        });
    });
}

function toggleApiSection(show) {
    const sec = document.getElementById('whispers-api-section');
    if (sec) sec.style.display = show ? '' : 'none';
}

// ── Event Binding ───────────────────────────────────────────────

function bindEvents() {
    const el = (id) => document.getElementById(id);

    // Chat
    el('whispers-chat-btn')?.addEventListener('click', openChat);
    el('whispers-chat-close')?.addEventListener('click', closeChat);
    el('whispers-overlay')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeChat(); });
    el('whispers-send')?.addEventListener('click', sendMessage);
    el('whispers-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
    el('whispers-input')?.addEventListener('input', autoResize);
    el('whispers-chat-clear')?.addEventListener('click', async () => {
        const meta = getChatMeta();
        if (meta) { meta.whispers_history = []; await saveChatMeta(); }
        renderChatMessages();
    });

    // New assistant
    el('whispers-btn-new-assistant')?.addEventListener('click', () => {
        const settings = getSettings();
        const a = { id: generateId(), name: 'New Assistant', character: '', bans: '', avatar: null, binding: 'none', bindingTarget: null, folderId: null };
        settings.assistants.push(a);
        saveSettings();
        editingAssistantId = a.id;
        renderItemList();
    });

    // New folder
    el('whispers-btn-new-folder')?.addEventListener('click', () => {
        const settings = getSettings();
        const f = { id: generateId(), name: 'New Folder', icon: 'fa-folder', color: '#667eea', note: '' };
        settings.folders.push(f);
        saveSettings();
        renderItemList();
        showFolderEditPopup(f);
    });

    // Enable toggle
    el('whispers-enabled')?.addEventListener('change', (e) => {
        getSettings().enabled = e.target.checked;
        saveSettings();
    });

    // Update button
    el('whispers-btn-update')?.addEventListener('click', performUpdate);

    // Import
    el('whispers-btn-import')?.addEventListener('click', () => el('whispers-import-file')?.click());
    el('whispers-import-file')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const result = await importFromPng(file);
        if (!result) { e.target.value = ''; return; }
        const settings = getSettings();

        if (result.type === 'folder') {
            const fd = result.data;
            const newFolder = { id: generateId(), name: fd.folder.name, icon: fd.folder.icon, color: fd.folder.color, note: fd.folder.note || '' };
            settings.folders.push(newFolder);
            for (const ad of fd.assistants) {
                settings.assistants.push({
                    id: generateId(), name: ad.name, character: ad.character, bans: ad.bans,
                    avatar: ad.avatar, binding: 'none', bindingTarget: null, folderId: newFolder.id
                });
            }
            toastr.success(`Imported folder: ${newFolder.name}`);
        } else {
            settings.assistants.push(result.data);
            toastr.success(`Imported: ${result.data.name}`);
        }
        saveSettings();
        renderItemList();
        e.target.value = '';
    });

    // Avatar file
    el('whispers-avatar-file')?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        const targetId = e.target.dataset.targetAssistant;
        if (!file || !targetId) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const settings = getSettings();
            const asst = settings.assistants.find(a => a.id === targetId);
            if (asst) {
                asst.avatar = ev.target.result;
                saveSettings();
                renderItemList();
            }
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    });

    // API settings
    el('whispers-use-extra-api')?.addEventListener('change', (e) => {
        const s = getSettings();
        s.useExtraApi = e.target.checked;
        saveSettings();
        toggleApiSection(e.target.checked);
    });

    el('whispers-api-url')?.addEventListener('input', (e) => {
        getSettings().extraApiUrl = e.target.value;
        saveSettings();
    });

    el('whispers-api-key')?.addEventListener('input', (e) => {
        getSettings().extraApiKey = e.target.value;
        saveSettings();
    });

    el('whispers-model-select')?.addEventListener('change', (e) => {
        getSettings().extraApiModel = e.target.value;
        saveSettings();
    });

    el('whispers-btn-refresh-models')?.addEventListener('click', async () => {
        const btn = el('whispers-btn-refresh-models');
        if (btn) btn.disabled = true;
        const models = await fetchModels();
        const select = el('whispers-model-select');
        if (select) {
            const current = getSettings().extraApiModel;
            select.innerHTML = '<option value="">Default</option>';
            for (const m of models) {
                const opt = document.createElement('option');
                opt.value = m; opt.textContent = m;
                if (m === current) opt.selected = true;
                select.appendChild(opt);
            }
        }
        if (btn) btn.disabled = false;
        if (models.length > 0) toastr.success(`Found ${models.length} model(s)`);
    });

    el('whispers-msg-limit')?.addEventListener('input', (e) => {
        getSettings().messageLimit = parseInt(e.target.value, 10) || 20;
        saveSettings();
    });

    // ── NPC buttons ─────────────────────────────────────────────
    el('whispers-btn-new-npc')?.addEventListener('click', () => {
        const settings = getSettings();
        const npc = { id: generateId(), name: 'New NPC', username: 'npc', character: '', postExample: '', bans: '', avatar: null, binding: 'none', bindingTarget: null, folderId: null };
        settings.npcAssistants.push(npc);
        saveSettings();
        renderNpcList();
        showNpcEditPopup(npc);
    });

    el('whispers-btn-new-npc-folder')?.addEventListener('click', () => {
        const settings = getSettings();
        const f = { id: generateId(), name: 'New Folder', icon: 'fa-folder', color: '#667eea' };
        if (!settings.npcFolders) settings.npcFolders = [];
        settings.npcFolders.push(f);
        saveSettings();
        renderNpcList();
        showNpcFolderEditPopup(f);
    });

    el('whispers-npc-avatar-file')?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        const targetId = e.target.dataset.targetNpc;
        if (!file || !targetId) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const settings = getSettings();
            const npc = (settings.npcAssistants || []).find(n => n.id === targetId);
            if (npc) {
                npc.avatar = ev.target.result;
                saveSettings();
                renderNpcList();
                // Update popup avatar if open
                const avEl = document.getElementById('whispers-npc-popup-avatar');
                if (avEl) avEl.innerHTML = `<img class="whispers-avatar-preview" src="${ev.target.result}" alt="">`;
            }
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    });

    // ── Overlay tabs (Chat / Feed) ──────────────────────────────
    document.querySelectorAll('.whispers-overlay-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.whispers-overlay-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            updateOverlayPanels();
        });
    });

    // ── Twitter refresh ─────────────────────────────────────────
    el('whispers-tweet-refresh')?.addEventListener('click', generateTwitterPosts);

    // ── Settings tab: Mode toggles ──────────────────────────────
    el('whispers-mode-chat')?.addEventListener('change', (e) => {
        getSettings().chatMode = e.target.checked;
        saveSettings();
        updateOverlayPanels();
    });

    el('whispers-mode-twitter')?.addEventListener('change', (e) => {
        getSettings().twitterMode = e.target.checked;
        saveSettings();
        updateOverlayPanels();
    });

    // ── Settings tab: Automation radios ─────────────────────────
    document.querySelectorAll('input[name="whispers-chat-auto"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            getSettings().chatAutoMode = e.target.value;
            saveSettings();
        });
    });

    document.querySelectorAll('input[name="whispers-twitter-auto"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            getSettings().twitterAutoMode = e.target.value;
            saveSettings();
        });
    });

    el('whispers-chat-interval')?.addEventListener('input', (e) => {
        getSettings().chatAutoInterval = parseInt(e.target.value, 10) || 3;
        saveSettings();
    });

    el('whispers-twitter-interval')?.addEventListener('input', (e) => {
        getSettings().twitterAutoInterval = parseInt(e.target.value, 10) || 5;
        saveSettings();
    });

    // ── Settings tab: Proactive radios ──────────────────────────
    document.querySelectorAll('input[name="whispers-chat-proactive"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            getSettings().chatProactive = e.target.value;
            saveSettings();
        });
    });

}

// ── Init ────────────────────────────────────────────────────────

(function init() {
    const { eventSource, event_types } = SillyTavern.getContext();

    // Settings panel
    const container = document.getElementById('extensions_settings2');
    if (container) {
        const w = document.createElement('div');
        w.innerHTML = buildSettingsHtml();
        container.appendChild(w);
    }

    // Chat overlay
    document.body.insertAdjacentHTML('beforeend', buildChatOverlayHtml());

    // Chat bar button — insert next to #extensionsMenuButton (wand icon)
    const extMenuBtn = document.getElementById('extensionsMenuButton');
    if (extMenuBtn) {
        extMenuBtn.insertAdjacentHTML('afterend', buildChatBarButton());
    } else {
        // Fallback: insert into #leftSendForm
        const leftSendForm = document.getElementById('leftSendForm');
        if (leftSendForm) {
            leftSendForm.insertAdjacentHTML('beforeend', buildChatBarButton());
        } else {
            const sendForm = document.getElementById('send_form');
            if (sendForm) sendForm.insertAdjacentHTML('afterbegin', buildChatBarButton());
        }
    }

    bindEvents();
    loadSettingsUI();
    checkForUpdate();
    updateOverlayPanels();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        updateChatHeader();
        renderChatMessages();
        renderItemList();
        renderNpcList();
        renderTwitterFeed();
        updateOverlayPanels();
    });

    // Hook into main chat messages for automation
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        onMainChatMessage();
    });

    console.log('[Whispers] Extension loaded v2');
})();
