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
    extraApiUrl: '',
    extraApiKey: '',
    extraApiModel: '',
    messageLimit: 20,
    useExtraApi: false,
    mainPromptTemplate: `You are a personal assistant in a chat application. Respond concisely and helpfully. Format your response as plain text.

Your identity:
Name — {{name}}
Character — {{character}}
Bans — {{bans}}

Conversation context (last messages from the main chat):
{{context}}

Now respond to the user's message in the assistant chat.`,
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

// ── Fetch Models ────────────────────────────────────────────────

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
                    <div class="whispers-item-list" id="whispers-item-list"></div>
                    <div class="whispers-row">
                        <button class="menu_button" id="whispers-btn-new-assistant" title="New assistant">
                            <i class="fa-solid fa-plus"></i> Assistant
                        </button>
                        <button class="menu_button" id="whispers-btn-new-folder" title="New folder">
                            <i class="fa-solid fa-folder-plus"></i> Folder
                        </button>
                        <button class="menu_button" id="whispers-btn-import" title="Import PNG">
                            <i class="fa-solid fa-file-import"></i> Import
                        </button>
                    </div>
                    <input type="file" accept=".png" class="whispers-hidden-input" id="whispers-import-file">
                    <input type="file" accept="image/*" class="whispers-hidden-input" id="whispers-avatar-file">
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
                                <select id="whispers-model-select">
                                    <option value="">Default</option>
                                </select>
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
    </div>`;
}

function buildChatBarButton() {
    return `<div id="whispers-chat-btn" title="Open Whispers Assistant" class="interactable">
        <i class="fa-solid fa-ghost"></i>
    </div>`;
}

// ── UI: Render Item List (Folders + Assistants) ─────────────────

// ── Popular FA icons for picker ─────────────────────────────────

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
            settings.folders = settings.folders.filter(f => f.id !== folder.id);
            settings.assistants.forEach(a => { if (a.folderId === folder.id) a.folderId = null; });
            saveSettings();
            renderItemList();
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

    // Click to open edit popup
    item.addEventListener('click', (e) => {
        if (e.target.closest('.whispers-assistant-actions')) return;
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
        settings.assistants = settings.assistants.filter(a => a.id !== asst.id);
        if (editingAssistantId === asst.id) editingAssistantId = null;
        const meta = getChatMeta();
        if (meta && meta.whispers_assistant_id === asst.id) delete meta.whispers_assistant_id;
        saveSettings();
        renderItemList();
        updateChatHeader();
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
                    <label><i class="fa-solid fa-link"></i> Binding</label>
                    <select class="w-edit-binding">
                        <option value="none" ${asst.binding === 'none' || !asst.binding ? 'selected' : ''}>None</option>
                        <option value="global" ${asst.binding === 'global' ? 'selected' : ''}>Global (all chats)</option>
                        <option value="character" ${asst.binding === 'character' ? 'selected' : ''}>Character${charName ? ` (${charName})` : ''}</option>
                        <option value="chat" ${asst.binding === 'chat' ? 'selected' : ''}>This Chat</option>
                    </select>
                </div>
                <div class="whispers-row">
                    <button class="menu_button w-save-btn"><i class="fa-solid fa-floppy-disk"></i> Save</button>
                </div>
            </div>
        </div>
    `;

    // Close
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.whispers-edit-popup-close').addEventListener('click', () => overlay.remove());

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

    // Close
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.whispers-edit-popup-close').addEventListener('click', () => overlay.remove());

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

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });
    overlay.querySelector('.whispers-note-popup-close').addEventListener('click', () => overlay.remove());

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

    // Setup tab switching
    setupTabs();

    renderItemList();
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

    // Chat bar button
    const formSheld = document.getElementById('form_sheld');
    if (formSheld) {
        const sendForm = formSheld.querySelector('#send_form');
        if (sendForm) sendForm.insertAdjacentHTML('afterbegin', buildChatBarButton());
        else formSheld.insertAdjacentHTML('afterbegin', buildChatBarButton());
    }

    bindEvents();
    loadSettingsUI();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        updateChatHeader();
        renderChatMessages();
        renderItemList();
    });

    console.log('[Whispers] Extension loaded v2');
})();
