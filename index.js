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
    overlayTheme: 'custom',     // 'light' | 'dark' | 'custom'
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


// ── Chirp Social Defaults (appended to settings at runtime) ─────
const chirpDefaults = {
    chirpUserProfile: { name: 'You', username: 'player', avatar: null, banner: null, bio: '' },
    chirpPostCount: 4,
    chirpFeedPrompt: `You are generating posts for Deerly, a cozy social network in a roleplay.

NPC characters:
{{npc_cards}}

Recent story events:
{{context}}

Generate exactly {{post_count}} posts as a JSON array. Rules:
- IMPORTANT: Mix post types. About half should be NPCs posting about their OWN life (daily activities, hobbies, random thoughts, food, mood — independent of story events). The other half may react to story events.
- NPCs may @mention each other or @{{user_handle}} naturally in their posts
- NPCs may reply to each other (set "replyTo": INDEX 0-based) or null
- Max 260 chars per post. In-character, authentic voice. No forced hashtags.

Respond ONLY with valid JSON: [{"npcId":"id","content":"text","replyTo":null}]`,
    chirpDmPrompt: `You are {{npc_name}} (@{{npc_username}}) on Deerly, a social network in a roleplay.
Personality: {{personality}}
Post style: {{post_style}}

{{user_name}} (@{{user_username}}) is DMing you.
Story context: {{context}}

Reply in character. 1-3 short sentences. Stay in persona.`,
};

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
    // Merge Chirp social defaults
    for (const key of Object.keys(chirpDefaults)) {
        if (!Object.hasOwn(s, key)) {
            s[key] = JSON.parse(JSON.stringify(chirpDefaults[key]));
        }
    }
    if (!s.chirpUserProfile) s.chirpUserProfile = JSON.parse(JSON.stringify(chirpDefaults.chirpUserProfile));
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

// ── NPC PNG Export ──────────────────────────────────────────────

async function exportNpcToPng(npc) {
    const canvas = document.createElement('canvas');
    canvas.width = 400; canvas.height = 400;
    const c = canvas.getContext('2d');
    if (npc.avatar) {
        const img = new Image();
        await new Promise((r, e) => { img.onload = r; img.onerror = e; img.src = npc.avatar; });
        c.drawImage(img, 0, 0, 400, 400);
    } else {
        const g = c.createLinearGradient(0, 0, 400, 400);
        g.addColorStop(0, '#1da1f2'); g.addColorStop(1, '#0d47a1');
        c.fillStyle = g; c.fillRect(0, 0, 400, 400);
        c.fillStyle = '#fff'; c.font = 'bold 44px sans-serif';
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(npc.name || 'NPC', 200, 160);
        c.font = '22px sans-serif'; c.globalAlpha = 0.7;
        c.fillText('@' + (npc.username || 'npc'), 200, 210);
        c.font = '18px sans-serif'; c.globalAlpha = 0.5;
        c.fillText('Whispers NPC', 200, 260); c.globalAlpha = 1;
    }
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    const pngBytes = new Uint8Array(await blob.arrayBuffer());
    const data = {
        type: 'npc',
        name: npc.name, username: npc.username, character: npc.character,
        bans: npc.bans, postExample: npc.postExample, avatar: npc.avatar || null,
    };
    const result = injectTextChunk(pngBytes, 'whispers', JSON.stringify(data));
    const dlBlob = new Blob([result], { type: 'image/png' });
    const url = URL.createObjectURL(dlBlob);
    const a = document.createElement('a');
    a.href = url; a.download = `${npc.name || 'npc'}.png`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function exportNpcFolderToPng(folder, npcs) {
    const canvas = document.createElement('canvas');
    canvas.width = 400; canvas.height = 400;
    const c = canvas.getContext('2d');
    const g = c.createLinearGradient(0, 0, 400, 400);
    g.addColorStop(0, folder.color || '#1da1f2');
    g.addColorStop(1, '#111');
    c.fillStyle = g; c.fillRect(0, 0, 400, 400);
    c.fillStyle = '#fff'; c.font = 'bold 38px sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(folder.name || 'Folder', 200, 170);
    c.font = '20px sans-serif'; c.globalAlpha = 0.6;
    c.fillText(`${npcs.length} NPC(s)`, 200, 220);
    c.font = '16px sans-serif'; c.globalAlpha = 0.4;
    c.fillText('Whispers NPC Folder', 200, 260);
    c.globalAlpha = 1;

    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    const pngBytes = new Uint8Array(await blob.arrayBuffer());
    const data = {
        type: 'npc_folder',
        folder: { name: folder.name, icon: folder.icon, color: folder.color, note: folder.note },
        npcs: npcs.map(n => ({ name: n.name, username: n.username, character: n.character, bans: n.bans, postExample: n.postExample, avatar: n.avatar })),
    };
    const result = injectTextChunk(pngBytes, 'whispers', JSON.stringify(data));
    const dlBlob = new Blob([result], { type: 'image/png' });
    const url = URL.createObjectURL(dlBlob);
    const a = document.createElement('a');
    a.href = url; a.download = `${folder.name || 'npc_folder'}.png`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function importFromPng(file) {
    const pngBytes = new Uint8Array(await file.arrayBuffer());
    const jsonStr = extractTextChunk(pngBytes, 'whispers');
    if (!jsonStr) { toastr.error('No Whispers data in this PNG.'); return null; }
    try {
        const d = JSON.parse(jsonStr);
        if (d.type === 'npc_folder') {
            return { type: 'npc_folder', data: d };
        }
        if (d.type === 'npc') {
            return {
                type: 'npc',
                data: { id: generateId(), name: d.name || 'Imported NPC', username: d.username || 'npc', character: d.character || '', bans: d.bans || '', postExample: d.postExample || '', avatar: d.avatar || null, binding: 'global', bindingTarget: null, folderId: null }
            };
        }
        if (d.type === 'folder') {
            return { type: 'folder', data: d };
        }
        // Single assistant (legacy)
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
                    <label class="whispers-tab" data-tab="social">
                        <input type="radio" name="whispers-tab" value="social">
                        <i class="fa-solid fa-feather-pointed"></i> Social
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
                            <button class="menu_button" id="whispers-btn-npc-import" title="Import NPC PNG"><i class="fa-solid fa-file-import"></i> Import</button>
                        </div>
                        <input type="file" accept=".png" class="whispers-hidden-input" id="whispers-npc-import-file">
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
                        <label><i class="fa-solid fa-palette"></i> Chat Theme</label>
                        <div class="whispers-theme-cards">
                            <label class="whispers-theme-card" data-theme-value="light">
                                <input type="radio" name="whispers-overlay-theme" value="light">
                                <div class="whispers-theme-preview whispers-theme-preview-light">
                                    <div class="wtp-header"></div>
                                    <div class="wtp-body">
                                        <div class="wtp-bubble wtp-bubble-left"></div>
                                        <div class="wtp-bubble wtp-bubble-right"></div>
                                        <div class="wtp-bubble wtp-bubble-left wtp-short"></div>
                                    </div>
                                    <div class="wtp-footer"></div>
                                </div>
                                <span class="whispers-theme-label">Light</span>
                            </label>
                            <label class="whispers-theme-card" data-theme-value="dark">
                                <input type="radio" name="whispers-overlay-theme" value="dark">
                                <div class="whispers-theme-preview whispers-theme-preview-dark">
                                    <div class="wtp-header"></div>
                                    <div class="wtp-body">
                                        <div class="wtp-bubble wtp-bubble-left"></div>
                                        <div class="wtp-bubble wtp-bubble-right"></div>
                                        <div class="wtp-bubble wtp-bubble-left wtp-short"></div>
                                    </div>
                                    <div class="wtp-footer"></div>
                                </div>
                                <span class="whispers-theme-label">Dark</span>
                            </label>
                            <label class="whispers-theme-card" data-theme-value="custom">
                                <input type="radio" name="whispers-overlay-theme" value="custom" checked>
                                <div class="whispers-theme-preview whispers-theme-preview-custom">
                                    <div class="wtp-header"></div>
                                    <div class="wtp-body">
                                        <div class="wtp-bubble wtp-bubble-left"></div>
                                        <div class="wtp-bubble wtp-bubble-right"></div>
                                        <div class="wtp-bubble wtp-bubble-left wtp-short"></div>
                                    </div>
                                    <div class="wtp-footer"></div>
                                </div>
                                <span class="whispers-theme-label">Auto</span>
                            </label>
                        </div>
                    </div>
                    <div class="whispers-divider"></div>
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

                <!-- ═══ Tab: Social / Chirp ═══ -->
                <div class="whispers-tab-content" id="whispers-tab-social" style="display:none;">
                    <div class="whispers-subsection">
                        <div class="whispers-subsection-header"><i class="fa-solid fa-user-circle"></i> Your Chirp Profile</div>
                        <div class="chirp-user-profile-row">
                            <div class="chirp-settings-av" id="chirp-st-av" title="Click to upload avatar" style="cursor:pointer;">
                                <i class="fa-solid fa-user"></i>
                            </div>
                            <div style="flex:1;display:flex;flex-direction:column;gap:5px;">
                                <input type="text" id="chirp-st-name" placeholder="Display Name" style="padding:6px 8px;border:1px solid var(--SmartThemeBorderColor);border-radius:8px;background:var(--SmartThemeBlurTintColor);color:var(--SmartThemeBodyColor);font-size:0.87em;width:100%;box-sizing:border-box;">
                                <input type="text" id="chirp-st-handle" placeholder="handle (no @)" style="padding:6px 8px;border:1px solid var(--SmartThemeBorderColor);border-radius:8px;background:var(--SmartThemeBlurTintColor);color:var(--SmartThemeBodyColor);font-size:0.87em;width:100%;box-sizing:border-box;">
                                <textarea id="chirp-st-bio" placeholder="Bio" rows="2" style="padding:6px 8px;border:1px solid var(--SmartThemeBorderColor);border-radius:8px;background:var(--SmartThemeBlurTintColor);color:var(--SmartThemeBodyColor);font-size:0.87em;width:100%;box-sizing:border-box;resize:vertical;font-family:inherit;"></textarea>
                            </div>
                        </div>
                        <input type="file" accept="image/*" id="chirp-st-av-file" style="display:none;">
                    </div>
                    <div class="whispers-divider"></div>
                    <div class="whispers-subsection">
                        <div class="whispers-subsection-header"><i class="fa-solid fa-feather-pointed"></i> Feed Settings</div>
                        <div class="whispers-field-group">
                            <label>Posts per batch</label>
                            <input type="number" id="chirp-st-count" min="1" max="20" value="4" style="width:70px;padding:5px 8px;border:1px solid var(--SmartThemeBorderColor);border-radius:8px;background:var(--SmartThemeBlurTintColor);color:var(--SmartThemeBodyColor);">
                        </div>
                        <div class="whispers-field-group">
                            <label>Feed Prompt</label>
                            <textarea id="chirp-st-feed-prompt" rows="4" style="width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--SmartThemeBorderColor);border-radius:8px;background:var(--SmartThemeBlurTintColor);color:var(--SmartThemeBodyColor);font-family:inherit;font-size:0.82em;resize:vertical;"></textarea>
                        </div>
                        <div class="whispers-field-group">
                            <label>DM Prompt</label>
                            <textarea id="chirp-st-dm-prompt" rows="3" style="width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--SmartThemeBorderColor);border-radius:8px;background:var(--SmartThemeBlurTintColor);color:var(--SmartThemeBodyColor);font-family:inherit;font-size:0.82em;resize:vertical;"></textarea>
                        </div>
                        <div class="whispers-row">
                            <button class="menu_button whispers-btn-small" id="chirp-st-reset-prompts" title="Reset prompts to default"><i class="fa-solid fa-rotate-left"></i> Reset Prompts</button>
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
                <button class="whispers-overlay-tab" data-panel="twitter"><span class="deerly-tab-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="currentColor" width="16" height="16" style="display:inline-block;vertical-align:middle;"><path d="M50,62 C44,62 38,58 36,52 C34,46 36,40 40,38 C38,34 32,28 28,20 C30,20 34,22 36,26 C36,22 34,16 32,10 C36,12 40,18 40,24 C42,20 44,14 46,10 C46,18 44,26 46,30 C47,28 48,24 50,22 C52,24 53,28 54,30 C56,26 54,18 54,10 C56,14 58,20 60,24 C60,18 64,12 68,10 C66,16 64,22 64,26 C66,22 70,20 72,20 C68,28 62,34 60,38 C64,40 66,46 64,52 C62,58 56,62 50,62 Z M50,64 C46,64 43,66 42,70 L42,88 C42,90 44,92 46,92 L48,92 L48,80 L52,80 L52,92 L54,92 C56,92 58,90 58,88 L58,70 C57,66 54,64 50,64 Z"/></svg></span> Deerly</button>
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

            <!-- Twitter / Chirp Social panel - full sub-app -->
            <div class="whispers-panel" id="whispers-panel-twitter" style="display:none;">
                <div class="chirp-sub-panel active" id="chirp-sp-home">
                    <div class="chirp-compose-bar">
                        <div class="chirp-compose-av" id="chirp-compose-av-el" style="cursor:pointer;"><i class="fa-solid fa-user"></i></div>
                        <div class="chirp-compose-right">
                            <textarea class="chirp-compose-input" id="chirp-compose-input" placeholder="What's happening?" rows="1" maxlength="280"></textarea>
                            <div class="chirp-compose-footer">
                                <span class="chirp-char-count" id="chirp-char-count">280</span>
                                <button class="chirp-post-btn" id="chirp-post-btn" disabled>Post</button>
                            </div>
                        </div>
                    </div>
                    <div class="chirp-feed-toolbar">
                        <span class="chirp-feed-label"><span class="deerly-fox-logo"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 157" fill="currentColor" width="20" height="13"><path d="M253.823,41.499l-0.325,0.734c-2.41,5.503-8.319,9.204-14.332,9.204h-16.73v3.936c0,19.682-8.442,43.562-31.479,50.726l-3.909,41.513c2.862,1.12,4.892,3.898,4.892,7.156h-11.96l-4.781-51.275l-39-6.766c-10.755,13.121-27.175,23.474-44.585,26.549l-3.695,24.37c2.811,1.144,4.795,3.899,4.795,7.121H80.756l0.001-44.671c10.414-6.433,18.847-17.179,20.897-29.737c0,0-43.871,42.034-56.708,49.933c-5.012,3.084-10.609,4.676-16.121,4.676c-6.622,0-13.123-2.296-18.348-7.06c-9.654-8.802-11.272-23.402-3.78-34.105l0.722-1.035c5.007,5.223,11.765,7.918,18.623,7.918c4.441,0,8.925-1.131,13.003-3.438c12.878-7.285,33.765-21.585,41.987-26.531c5.561-3.345,13.409-6.095,19.728-7.581c15.761-3.706,67.877-8.57,67.877-8.57l53.797-52.336v16.513c0.079,0.006,0.411,0.059,1.616,0.298c4.89,0.973,9.251,3.723,12.227,7.723l5.686,7.642l10.742,4.341C253.79,39.186,254.295,40.431,253.823,41.499z M151.684,105.406l-13.191-2.288c-4.227,4.708-9.067,8.946-14.301,12.598l13.93,39.052h11.96c0-4.146-3.284-7.517-7.392-7.673l-5.613-27.44C142.607,115.672,147.418,110.796,151.684,105.406z M215.871,147.169l-6.906-44.331c-3.616,3.299-8.228,6.044-12.473,7.63l13.996,44.3h11.96C222.447,150.9,219.589,147.709,215.871,147.169z"/></svg></span></span>
                        <button class="chirp-gen-btn" id="chirp-gen-btn"><i class="fa-solid fa-wand-magic-sparkles"></i> Generate</button>
                    </div>
                    <div class="chirp-feed-scroll" id="chirp-feed-scroll">
                        <div class="chirp-empty-state" id="chirp-feed-empty"><i class="fa-solid fa-feather-pointed"></i><div class="chirp-empty-title">Nothing here yet</div><div class="chirp-empty-sub">Hit Generate or write a post!</div></div>
                    </div>
                </div>
                <div class="chirp-sub-panel" id="chirp-sp-notifs">
                    <div class="chirp-divider-label">Notifications</div>
                    <div class="chirp-feed-scroll" id="chirp-notifs-scroll">
                        <div class="chirp-empty-state"><i class="fa-regular fa-bell"></i><div class="chirp-empty-title">All caught up!</div></div>
                    </div>
                </div>
                <div class="chirp-sub-panel" id="chirp-sp-dms">
                    <div class="chirp-dm-layout">
                        <div class="chirp-dm-sidebar">
                            <div class="chirp-dm-sidebar-hdr">Messages</div>
                            <div class="chirp-dm-list" id="chirp-dm-list-el"></div>
                        </div>
                        <div class="chirp-dm-chat" id="chirp-dm-chat-area">
                            <div class="chirp-empty-state" style="padding:20px;"><i class="fa-regular fa-comment-dots" style="font-size:1.8em;opacity:0.3;"></i><div style="font-weight:700;">Select a conversation</div></div>
                        </div>
                    </div>
                </div>
                <div class="chirp-sub-panel" id="chirp-sp-profile">
                    <div class="chirp-profile-scroll" id="chirp-profile-content"></div>
                </div>
                <div id="chirp-modal-layer" style="display:none;position:absolute;inset:0;z-index:50;flex-direction:column;background:var(--SmartThemeChatTintColor,var(--SmartThemeBlurTintColor));">
                    <div class="chirp-modal-topbar">
                        <button class="chirp-modal-back" id="chirp-modal-back"><i class="fa-solid fa-arrow-left"></i></button>
                        <span class="chirp-modal-title" id="chirp-modal-title">Profile</span>
                    </div>
                    <div class="chirp-modal-scroll" id="chirp-modal-scroll"></div>
                </div>
                <!-- Bookmarks sub-panel -->
                <div class="chirp-sub-panel" id="chirp-sp-bookmarks">
                    <div class="chirp-divider-label">Bookmarks</div>
                    <div class="chirp-feed-scroll" id="chirp-bm-scroll">
                        <div class="chirp-empty-state"><i class="fa-regular fa-bookmark"></i><div class="chirp-empty-title">No bookmarks yet</div></div>
                    </div>
                </div>
                <nav class="chirp-bottom-nav">
                    <button class="chirp-nav-btn active" data-sp="home"><div class="chirp-nav-badge" data-sp="home"></div><i class="fa-solid fa-house"></i><span>Home</span></button>
                    <button class="chirp-nav-btn" data-sp="notifs"><div class="chirp-nav-badge" data-sp="notifs"></div><i class="fa-regular fa-bell"></i><span>Notifs</span></button>
                    <button class="chirp-nav-btn" data-sp="dms"><div class="chirp-nav-badge" data-sp="dms"></div><i class="fa-regular fa-envelope"></i><span>DMs</span></button>
                    <button class="chirp-nav-btn" data-sp="bookmarks"><div class="chirp-nav-badge" data-sp="bookmarks"></div><i class="fa-regular fa-bookmark"></i><span>Saved</span></button>
                    <button class="chirp-nav-btn" data-sp="profile"><div class="chirp-nav-badge" data-sp="profile"></div><i class="fa-regular fa-user"></i><span>Profile</span></button>
                </nav>
            </div>
        </div>
    </div>`
}

function buildChatBarButton() {
    return `<div id="whispers-chat-btn" title="Open Whispers" class="interactable">
        <i class="fa-solid fa-ghost"></i>
        <div class="whispers-notif-dot" id="whispers-notif-dot"></div>
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

        const _folderOn = folder.enabled !== false;
        if (!_folderOn) folderEl.classList.add('disabled');
        folderEl.innerHTML = `
            <div class="whispers-folder-header">
                <span class="whispers-folder-icon" style="color:${folder.color || 'inherit'}">
                    <i class="fa-solid ${folder.icon || 'fa-folder'}"></i>
                </span>
                <span class="whispers-folder-name">${escapeHtml(folder.name || 'Folder')}</span>
                <span class="whispers-folder-count">${folderNpcs.length}</span>
                <span class="whispers-folder-actions">
                    <button class="toggle-folder-en" title="${_folderOn ? 'Выключить' : 'Включить'} папку"><i class="fa-solid ${_folderOn ? 'fa-toggle-on' : 'fa-toggle-off'}" style="color:${_folderOn ? '#00ba7c' : 'inherit'}"></i></button>
                    <button class="edit-folder-btn" title="Edit"><i class="fa-solid fa-pen"></i></button>
                    <button class="export-folder-btn" title="Export"><i class="fa-solid fa-file-export"></i></button>
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

        folderEl.querySelector('.toggle-folder-en').addEventListener('click', (e) => {
            e.stopPropagation();
            folder.enabled = (folder.enabled === false) ? true : false;
            saveSettings();
            renderNpcList();
        });
        folderEl.querySelector('.edit-folder-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            showNpcFolderEditPopup(folder);
        });

        folderEl.querySelector('.export-folder-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            exportNpcFolderToPng(folder, folderNpcs);
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
                <button class="export-btn" title="Export"><i class="fa-solid fa-file-export"></i></button>
                <button class="delete-btn" title="Delete"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>
    `;

    const item = container.firstElementChild;

    item.querySelector('.edit-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        showNpcEditPopup(npc);
    });

    item.querySelector('.export-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        exportNpcToPng(npc);
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
                    <label><i class="fa-solid fa-folder"></i> Folder</label>
                    <select class="w-edit-folder">
                        <option value="">— No folder —</option>
                        ${(getSettings().npcFolders||[]).map(f=>`<option value="${escapeHtml(f.id)}" ${npc.folderId===f.id?'selected':''}>${escapeHtml(f.name)}</option>`).join('')}
                    </select>
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

        const _folderVal = body.querySelector('.w-edit-folder')?.value || '';
        npc.folderId = _folderVal || null;

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
    // Expand window when chirp feed is active
    const overlay = document.getElementById('whispers-overlay');
    const win = overlay?.querySelector('.whispers-chat-window');
    if (win) {
        const s = getSettings();
        win.classList.toggle('chirp-expanded', s.twitterMode === true);
    }
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
            post.replies.forEach((reply, ri) => {
                wrap.appendChild(buildReplyElement(reply, index, ri));
            });
        }

        feed.appendChild(wrap);
    });
}

function buildReplyElement(reply, postIndex, replyIndex) {
    const el = document.createElement('div');
    el.className = 'whispers-tweet whispers-tweet-reply';
    el.dataset.replyIndex = replyIndex;

    const isUser = reply.isUser;
    const avatarHtml = reply.avatar
        ? `<img class="whispers-tweet-avatar" src="${reply.avatar}" alt="">`
        : `<div class="whispers-tweet-avatar whispers-tweet-avatar-placeholder"><i class="fa-solid ${isUser ? 'fa-user-pen' : 'fa-user'}"></i></div>`;

    const timeAgo = reply.timestamp ? getTimeAgo(reply.timestamp) : 'now';

    // Action buttons: delete always, retry for NPC replies
    let actionsHtml = `<button class="whispers-reply-action-btn whispers-reply-delete" title="Delete"><i class="fa-solid fa-trash"></i></button>`;
    if (!isUser) {
        actionsHtml = `<button class="whispers-reply-action-btn whispers-reply-retry" title="Retry"><i class="fa-solid fa-rotate-right"></i></button>` + actionsHtml;
    }

    el.innerHTML = `
        ${avatarHtml}
        <div class="whispers-tweet-body">
            <div class="whispers-tweet-header">
                <span class="whispers-tweet-name">${escapeHtml(reply.name || 'Anon')}</span>
                <span class="whispers-tweet-username">@${escapeHtml(reply.username || 'user')}</span>
                <span class="whispers-tweet-time">· ${timeAgo}</span>
                <span class="whispers-reply-actions">${actionsHtml}</span>
            </div>
            <div class="whispers-tweet-text">${escapeHtml(reply.content || '')}</div>
        </div>
    `;

    // Delete handler
    el.querySelector('.whispers-reply-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteTweetReply(postIndex, replyIndex, el);
    });

    // Retry handler (NPC only)
    const retryBtn = el.querySelector('.whispers-reply-retry');
    if (retryBtn) {
        retryBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            retryTweetReply(postIndex, replyIndex, el);
        });
    }

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
        const replyIdx = posts[postIndex].replies.length - 1;
        wrapEl.appendChild(buildReplyElement(userReply, postIndex, replyIdx));

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
            const npcReplyIdx = posts[postIndex].replies.length - 1;
            wrapEl.appendChild(buildReplyElement(npcReplyData, postIndex, npcReplyIdx));
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
    history.forEach((msg, index) => {
        el.appendChild(buildChatBubble(msg, index));
    });
    el.scrollTop = el.scrollHeight;
}

function addBubble(role, content) {
    const el = document.getElementById('whispers-messages');
    const empty = document.getElementById('whispers-empty-state');
    if (!el) return;
    if (empty) empty.style.display = 'none';
    const history = getWhispersHistory();
    const index = history.length - 1;
    el.appendChild(buildChatBubble({ role, content, timestamp: Date.now() }, index));
    el.scrollTop = el.scrollHeight;
}

function buildChatBubble(msg, index) {
    const b = document.createElement('div');
    b.className = `whispers-msg whispers-msg-${msg.role}`;
    b.dataset.index = index;
    const t = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

    // Action buttons
    let actionsHtml = '';
    if (msg.role === 'assistant') {
        actionsHtml = `<span class="whispers-msg-actions">
            <button class="whispers-msg-action-btn whispers-msg-retry" title="Retry"><i class="fa-solid fa-rotate-right"></i></button>
            <button class="whispers-msg-action-btn whispers-msg-delete" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </span>`;
    } else {
        actionsHtml = `<span class="whispers-msg-actions">
            <button class="whispers-msg-action-btn whispers-msg-delete" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </span>`;
    }

    b.innerHTML = `${escapeHtml(msg.content)}<span class="whispers-msg-time">${t}</span>${actionsHtml}`;

    // Delete handler
    b.querySelector('.whispers-msg-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteChatMessage(index);
    });

    // Retry handler (assistant only)
    const retryBtn = b.querySelector('.whispers-msg-retry');
    if (retryBtn) {
        retryBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            retryChatMessage(index);
        });
    }

    return b;
}

// ── Chat Message Delete / Retry ─────────────────────────────────

async function deleteChatMessage(index) {
    const history = getWhispersHistory();
    if (index < 0 || index >= history.length) return;
    history.splice(index, 1);
    await saveChatMeta();
    renderChatMessages();
}

async function retryChatMessage(index) {
    if (isGenerating) return;
    const history = getWhispersHistory();
    if (index < 0 || index >= history.length) return;
    const msg = history[index];
    if (msg.role !== 'assistant') return;

    // Remove the assistant message
    history.splice(index, 1);
    await saveChatMeta();
    renderChatMessages();

    // Find the last user message before this
    const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) return;

    const assistant = getActiveAssistant();
    if (!assistant) { toastr.warning('No assistant configured.'); return; }

    isGenerating = true;
    const sendBtn = document.getElementById('whispers-send');
    if (sendBtn) sendBtn.disabled = true;
    const statusEl = document.getElementById('whispers-chat-status');
    if (statusEl) statusEl.textContent = 'Typing...';
    showTyping();

    try {
        const response = await generateResponse(lastUserMsg.content);
        hideTyping();
        history.push({ role: 'assistant', content: response, timestamp: Date.now() });
        await saveChatMeta();
        addBubble('assistant', response);
    } catch (err) {
        hideTyping();
        toastr.error(`Retry failed: ${err.message}`);
        history.push({ role: 'assistant', content: `Error: ${err.message}`, timestamp: Date.now() });
        await saveChatMeta();
        addBubble('assistant', `Error: ${err.message}`);
    } finally {
        isGenerating = false;
        if (sendBtn) sendBtn.disabled = false;
        if (statusEl) statusEl.textContent = 'Online';
    }
}

// ── Tweet Reply Delete / Retry ──────────────────────────────────

function deleteTweetReply(postIndex, replyIndex, replyEl) {
    const posts = getTwitterPosts();
    if (!posts[postIndex] || !posts[postIndex].replies) return;
    posts[postIndex].replies.splice(replyIndex, 1);
    setTwitterPosts(posts);
    replyEl.remove();
    // Re-index remaining reply elements
    const wrapEl = replyEl.closest('.whispers-tweet-wrap');
    if (wrapEl) {
        wrapEl.querySelectorAll('.whispers-tweet-reply').forEach((el, i) => {
            el.dataset.replyIndex = i;
        });
    }
}

async function retryTweetReply(postIndex, replyIndex, replyEl) {
    const posts = getTwitterPosts();
    if (!posts[postIndex] || !posts[postIndex].replies) return;
    const npcReply = posts[postIndex].replies[replyIndex];
    if (!npcReply || npcReply.isUser) return;

    // Find the user reply that triggered this NPC reply (the one right before it)
    let userReply = null;
    for (let i = replyIndex - 1; i >= 0; i--) {
        if (posts[postIndex].replies[i].isUser) {
            userReply = posts[postIndex].replies[i];
            break;
        }
    }
    if (!userReply) return;

    // Remove old NPC reply
    posts[postIndex].replies.splice(replyIndex, 1);
    setTwitterPosts(posts);
    const wrapEl = replyEl.closest('.whispers-tweet-wrap');
    replyEl.remove();

    // Re-generate
    if (wrapEl) {
        await generateTweetReply(posts[postIndex], userReply, postIndex, wrapEl);
        // Re-index
        wrapEl.querySelectorAll('.whispers-tweet-reply').forEach((el, i) => {
            el.dataset.replyIndex = i;
        });
    }
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

function applyOverlayTheme() {
    const o = document.getElementById('whispers-overlay');
    if (!o) return;
    const theme = getSettings().overlayTheme || 'custom';
    o.setAttribute('data-whispers-theme', theme);
}

function openChat() {
    const o = document.getElementById('whispers-overlay');
    if (o) {
        applyOverlayTheme();
        o.classList.add('open');
        updateChatHeader();
        renderChatMessages();
        const s = getSettings();
        const win = o.querySelector('.whispers-chat-window');
        if (win) win.classList.toggle('chirp-expanded', s.twitterMode === true);
        if (s.twitterMode) {
            chirpRenderComposeAv();
            if (chirpActiveSubPanel === 'home') chirpRenderFeed();
            else if (chirpActiveSubPanel === 'profile') chirpRenderProfile(null);
            chirpUpdateNotifBadge();
        }
        setTimeout(() => document.getElementById('whispers-input')?.focus(), 350);
    }
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

    // Theme radio
    const themeRadio = document.querySelector(`input[name="whispers-overlay-theme"][value="${s.overlayTheme || 'custom'}"]`);
    if (themeRadio) themeRadio.checked = true;
    // Highlight active theme card
    document.querySelectorAll('.whispers-theme-card').forEach(card => {
        card.classList.toggle('active', card.dataset.themeValue === (s.overlayTheme || 'custom'));
    });

    // Setup tab switching
    setupTabs();

    renderItemList();
    renderNpcList();
    chirpLoadSocialSettings();
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

    // NPC Import
    el('whispers-btn-npc-import')?.addEventListener('click', () => el('whispers-npc-import-file')?.click());
    el('whispers-npc-import-file')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const result = await importFromPng(file);
        if (!result) { e.target.value = ''; return; }
        const settings = getSettings();

        if (result.type === 'npc_folder') {
            const fd = result.data;
            const newFolder = { id: generateId(), name: fd.folder.name, icon: fd.folder.icon, color: fd.folder.color, note: fd.folder.note || '' };
            if (!settings.npcFolders) settings.npcFolders = [];
            settings.npcFolders.push(newFolder);
            for (const nd of fd.npcs) {
                if (!settings.npcAssistants) settings.npcAssistants = [];
                settings.npcAssistants.push({
                    id: generateId(), name: nd.name, username: nd.username || 'npc',
                    character: nd.character, bans: nd.bans, postExample: nd.postExample || '',
                    avatar: nd.avatar, binding: 'global', bindingTarget: null, folderId: newFolder.id
                });
            }
            toastr.success(`Imported NPC folder: ${newFolder.name} (${fd.npcs.length} NPC(s))`);
        } else if (result.type === 'npc') {
            if (!settings.npcAssistants) settings.npcAssistants = [];
            settings.npcAssistants.push(result.data);
            toastr.success(`Imported NPC: ${result.data.name}`);
        } else {
            toastr.warning('This PNG contains a chat assistant, not an NPC. Use the Chat Assistants import button.');
            e.target.value = '';
            return;
        }
        saveSettings();
        renderNpcList();
        e.target.value = '';
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

    // ── Settings tab: Theme selector ──────────────────────────────
    document.querySelectorAll('input[name="whispers-overlay-theme"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            getSettings().overlayTheme = e.target.value;
            saveSettings();
            applyOverlayTheme();
            document.querySelectorAll('.whispers-theme-card').forEach(card => {
                card.classList.toggle('active', card.dataset.themeValue === e.target.value);
            });
        });
    });

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

    // ── Social / Chirp tab events ─────────────────────────────
    chirpBindSocialSettingsEvents();

    // ── Chirp bottom nav ──────────────────────────────────────
    document.querySelectorAll('.chirp-nav-btn[data-sp]').forEach(btn => {
        btn.addEventListener('click', () => chirpSwitchSubPanel(btn.dataset.sp));
    });

    // ── Chirp compose ─────────────────────────────────────────
    const chirpInput = document.getElementById('chirp-compose-input');
    const chirpPostBtn = document.getElementById('chirp-post-btn');
    const chirpCharCount = document.getElementById('chirp-char-count');
    if (chirpInput) {
        chirpInput.addEventListener('input', () => {
            const len = chirpInput.value.length;
            const rem = 280 - len;
            if (chirpCharCount) {
                chirpCharCount.textContent = rem;
                chirpCharCount.className = 'chirp-char-count' + (rem < 20 ? ' warn' : '') + (rem < 0 ? ' over' : '');
            }
            if (chirpPostBtn) chirpPostBtn.disabled = len === 0 || len > 280;
            chirpInput.style.height = 'auto';
            chirpInput.style.height = Math.min(chirpInput.scrollHeight, 110) + 'px';
        });
        chirpInput.addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!chirpPostBtn?.disabled) chirpPostBtn.click(); }
        });
    }
    chirpPostBtn?.addEventListener('click', async () => {
        const content = chirpInput?.value?.trim();
        if (!content) return;
        chirpPostBtn.disabled = true;
        const _qid = chirpInput?.dataset?.quotedPostId || null;
        await chirpPostUserTweet(content, _qid);
        if (chirpInput) { chirpInput.value = ''; chirpInput.style.height = 'auto'; delete chirpInput.dataset.quotedPostId; }
        document.getElementById('chirp-compose-quote-preview')?.remove();
        if (chirpCharCount) { chirpCharCount.textContent = '280'; chirpCharCount.className = 'chirp-char-count'; }
        chirpPostBtn.disabled = false;
    });

    // ── Chirp generate btn ────────────────────────────────────
    document.getElementById('chirp-gen-btn')?.addEventListener('click', chirpGenerateFeed);

    // ── Chirp compose avatar → profile ───────────────────────
    document.getElementById('chirp-compose-av-el')?.addEventListener('click', () => {
        chirpSwitchSubPanel('profile');
        chirpRenderProfile(null);
    });

    // ── Chirp modal back ──────────────────────────────────────
    document.getElementById('chirp-modal-back')?.addEventListener('click', () => {
        const layer = document.getElementById('chirp-modal-layer');
        if (layer) layer.style.display = 'none';
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
        chirpActiveDmNpcId = null;
        if (getSettings().twitterMode) chirpRenderFeed();
        chirpUpdateNotifBadge();
    });

    // Hook into main chat messages for automation
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        onMainChatMessage();
    });

    console.log('[Whispers] Extension loaded v2');
})();

// ============================================================
// ██████████ CHIRP SOCIAL SYSTEM — Whispers v2.1 ████████████
// ============================================================

// ── State ────────────────────────────────────────────────────────
let chirpActiveSubPanel = 'home';
let chirpActiveDmNpcId = null;
let chirpGenerating = false;
let chirpCtxMenu = null;
let chirpOpenReplyPostId = null;

// ── Tiny helpers ──────────────────────────────────────────────────
function chirpEl(id) { return document.getElementById(id); }
function chirpEsc(t) { const d = document.createElement('div'); d.textContent = String(t ?? ''); return d.innerHTML; }
function chirpRelTime(ts) {
    if (!ts) return '';
    const d = Date.now() - ts;
    if (d < 60000) return 'now';
    if (d < 3600000) return Math.floor(d / 60000) + 'm';
    if (d < 86400000) return Math.floor(d / 3600000) + 'h';
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── Storage ───────────────────────────────────────────────────────
function chirpGetPosts() { const m = getChatMeta(); if (!m) return []; return (m.chirp_posts = m.chirp_posts || []); }
function chirpSavePosts(p) { const m = getChatMeta(); if (m) { m.chirp_posts = p; } }
function chirpGetDMs() { const m = getChatMeta(); if (!m) return {}; return (m.chirp_dms = m.chirp_dms || {}); }
function chirpSaveDMs(d) { const m = getChatMeta(); if (m) m.chirp_dms = d; }
function chirpGetNotifs() { const m = getChatMeta(); if (!m) return []; return (m.chirp_notifs = m.chirp_notifs || []); }
function chirpSaveNotifs(n) { const m = getChatMeta(); if (m) m.chirp_notifs = n; }
function chirpGetBookmarks() { const m = getChatMeta(); if (!m) return []; return (m.chirp_bookmarks = m.chirp_bookmarks || []); }
function chirpSaveBookmarks(b) { const m = getChatMeta(); if (m) m.chirp_bookmarks = b; }

function chirpAddNotif(notif) {
    const n = chirpGetNotifs();
    n.unshift({ id: generateId(), read: false, timestamp: Date.now(), ...notif });
    if (n.length > 80) n.splice(80);
    chirpSaveNotifs(n);
    chirpUpdateBadges();
}

function chirpUpdateBadges() {
    const unreadN = chirpGetNotifs().filter(n => !n.read).length;
    const badge = document.querySelector('.chirp-nav-badge[data-sp="notifs"]');
    if (badge) { badge.textContent = unreadN > 99 ? '99+' : unreadN; badge.classList.toggle('show', unreadN > 0); }

    const dms = chirpGetDMs(); let unreadDM = 0;
    for (const conv of Object.values(dms)) if (Array.isArray(conv)) unreadDM += conv.filter(m => m.role === 'npc' && !m.read).length;
    const dmBadge = document.querySelector('.chirp-nav-badge[data-sp="dms"]');
    if (dmBadge) { dmBadge.textContent = unreadDM > 99 ? '99+' : unreadDM; dmBadge.classList.toggle('show', unreadDM > 0); }

    const total = unreadN + unreadDM;
    const dot = chirpEl('whispers-notif-dot');
    if (dot) dot.style.display = total > 0 ? 'block' : 'none';
    const ghostBtn = chirpEl('whispers-chat-btn');
    if (ghostBtn) ghostBtn.classList.toggle('has-notifs', total > 0);
}

// ── NPC helpers ───────────────────────────────────────────────────
function chirpGetActiveNpcs() { return getActiveNpcs(); }
function chirpGetNpcById(id) { return (getSettings().npcAssistants || []).find(n => n.id === id) || null; }
function chirpGetAuthor(authorId) {
    if (!authorId || authorId === 'user') { const u = getSettings().chirpUserProfile; return { name: u.name || 'You', username: u.username || 'player', avatar: u.avatar || null, isUser: true }; }
    const npc = chirpGetNpcById(authorId);
    return npc ? { name: npc.name, username: npc.username, avatar: npc.avatar || null, isUser: false } : { name: 'Unknown', username: 'unknown', avatar: null, isUser: false };
}

// ── Affection / Love system ────────────────────────────────────────
const LOVE_STAGES = [
    { min: 0,  max: 19,  label: 'Stranger',     icon: '<i class="fa-regular fa-circle-dot" style="color:#888"></i>',  color: '#888',    hearts: 0 },
    { min: 20, max: 39,  label: 'Acquaintance',  icon: '<i class="fa-solid fa-circle-dot" style="color:#8ab77a"></i>', color: '#8ab77a', hearts: 1 },
    { min: 40, max: 59,  label: 'Friend',        icon: '<i class="fa-solid fa-star" style="color:#5ab4f0"></i>',        color: '#5ab4f0', hearts: 2 },
    { min: 60, max: 79,  label: 'Close Friend',  icon: '<i class="fa-solid fa-star-half-stroke" style="color:#a86fd1"></i>', color: '#a86fd1', hearts: 3 },
    { min: 80, max: 94,  label: 'Devoted',       icon: '<i class="fa-solid fa-heart" style="color:#e07840"></i>',       color: '#e07840', hearts: 4 },
    { min: 95, max: 100, label: 'Soulbound',     icon: '<i class="fa-solid fa-heart-pulse" style="color:#e04060"></i>', color: '#e04060', hearts: 5 },
];

function chirpGetLoveStage(affection) { return LOVE_STAGES.find(s => affection >= s.min && affection <= s.max) || LOVE_STAGES[0]; }
function chirpGetAffection(npcId) { const npc = chirpGetNpcById(npcId); return npc ? (npc._affection || 0) : 0; }

// Affection reasons
const CHIRP_AFF_REASONS = {
    dm_reply:    { delta: 2, label: 'ответ в личке' },
    dm_first:    { delta: 4, label: 'первое сообщение!' },
    post_liked:  { delta: 1, label: 'лайкнул пост' },
    npc_reply:   { delta: 1, label: 'ответил в треде' },
    user_reply:  { delta: 1, label: 'твой ответ' },
};

function chirpAddAffectionReason(npcId, reasonKey) {
    const cfg = CHIRP_AFF_REASONS[reasonKey] || { delta: 1, label: 'взаимодействие' };
    _chirpApplyAffDelta(npcId, cfg.delta, cfg.label);
}

function chirpAddAffection(npcId, delta) {
    _chirpApplyAffDelta(npcId, delta, 'взаимодействие');
}

function _chirpApplyAffDelta(npcId, delta, label) {
    const s = getSettings();
    const npc = s.npcAssistants?.find(n => n.id === npcId);
    if (!npc) return;
    const prev = npc._affection || 0;
    npc._affection = Math.max(0, Math.min(100, prev + delta));
    if (!npc._affectionLog) npc._affectionLog = [];
    npc._affectionLog.unshift({ ts: Date.now(), delta, label });
    if (npc._affectionLog.length > 25) npc._affectionLog.pop();
    const prevStage = chirpGetLoveStage(prev);
    const newStage = chirpGetLoveStage(npc._affection);
    if (prevStage.label !== newStage.label) chirpShowLoveEvent(npc, newStage);
    saveSettings();
}

function chirpShowLoveEvent(npc, stage) {
    const popup = document.createElement('div');
    popup.className = 'chirp-love-popup';
    popup.innerHTML = `
        <div class="chirp-love-popup-inner">
            <div class="chirp-love-popup-av">${npc.avatar ? `<img src="${chirpEsc(npc.avatar)}" alt="">` : chirpEsc((npc.name||'?')[0])}</div>
            <div class="chirp-love-popup-icon">${stage.icon}</div>
            <div class="chirp-love-popup-name">${chirpEsc(npc.name)}</div>
            <div class="chirp-love-popup-stage" style="color:${stage.color};">${stage.label}</div>
            <div class="chirp-love-popup-msg">Your relationship has changed!</div>
        </div>`;
    document.body.appendChild(popup);
    setTimeout(() => popup.classList.add('visible'), 50);
    setTimeout(() => { popup.classList.remove('visible'); setTimeout(() => popup.remove(), 600); }, 3500);
}

function chirpHeartsHtml(affection, size = 'sm') {
    const stage = chirpGetLoveStage(affection);
    const pct = Math.round(((affection - stage.min) / (stage.max - stage.min || 1)) * 100);
    const filled = stage.hearts;
    const total = 5;
    let h = '';
    for (let i = 0; i < total; i++) {
        h += `<span style="color:${i < filled ? stage.color : 'rgba(128,128,128,0.25)'}">♥</span>`;
    }
    return `<span class="chirp-hearts chirp-hearts-${size}" title="${stage.label} (${affection}/100)">${h}</span>`;
}

// ── API wrapper ───────────────────────────────────────────────────
async function chirpCallApi(messages) { return await callApi(messages); }

// ── Generate feed ─────────────────────────────────────────────────
async function chirpGenerateFeed() {
    if (chirpGenerating) return;
    const npcs = chirpGetActiveNpcs();
    if (!npcs.length) { toastr.warning('No active NPC Assistants. Add some in Settings → Assistants → NPC Assistants.'); return; }
    chirpGenerating = true;
    const genBtn = chirpEl('chirp-gen-btn');
    if (genBtn) { genBtn.disabled = true; genBtn.innerHTML = '<div class="chirp-spin"></div> Generating…'; }
    try {
        const s = getSettings();
        const npcCards = npcs.map(n => `ID: ${n.id}\nName: ${n.name}\nHandle: @${n.username}\nPersonality: ${n.character || 'Friendly'}\nPost style: ${n.postExample || 'Casual'}`).join('\n\n');
        const context = gatherContext();
        const count = s.chirpPostCount || 4;
        const _userHandle = s.chirpUserProfile?.username || 'player';
        let prompt = (s.chirpFeedPrompt || chirpDefaults.chirpFeedPrompt)
            .replace(/\{\{npc_cards\}\}/g, npcCards)
            .replace(/\{\{context\}\}/g, context)
            .replace(/\{\{post_count\}\}/g, count)
            .replace(/\{\{user_handle\}\}/g, _userHandle);
        const raw = await chirpCallApi([
            { role: 'system', content: 'Output ONLY valid JSON arrays. No markdown fences, no explanations.' },
            { role: 'user', content: prompt }
        ]);
        let parsed;
        try { parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
        catch { toastr.error('Failed to parse feed posts. Try again.'); return; }
        const posts = chirpGetPosts();
        const now = Date.now();
        const batch = [];
        for (let i = 0; i < parsed.length; i++) {
            const p = parsed[i];
            if (!p.npcId || !p.content) continue;
            const npc = npcs.find(n => n.id === p.npcId) || npcs[i % npcs.length];
            if (!npc) continue;
            const post = { id: generateId(), authorId: npc.id, content: String(p.content).slice(0, 280), timestamp: now - (parsed.length - i) * 11000, likes: [], retweets: [], replies: [], replyToId: null };
            if (p.replyTo != null && batch[p.replyTo]) {
                post.replyToId = batch[p.replyTo].id;
                batch[p.replyTo].replies.push(post.id);
            }
            batch.push(post);
        }
        posts.unshift(...batch);
        if (posts.length > 400) posts.splice(400);
        chirpSavePosts(posts);
        await saveChatMeta();
        chirpRenderFeed();
        toastr.success(`${batch.length} posts generated!`);
        setTimeout(() => chirpGenerateOrganicReactions(batch), 900);
    } catch (err) {
        console.error('[Chirp] Generate error:', err);
        toastr.error('Generation failed: ' + err.message);
    } finally {
        chirpGenerating = false;
        if (genBtn) { genBtn.disabled = false; genBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate'; }
    }
}

// ── Post user tweet ───────────────────────────────────────────────
async function chirpPostUserTweet(text, quotedPostId = null) {
    const post = { id: generateId(), authorId: 'user', content: text.slice(0, 280), timestamp: Date.now(), likes: [], retweets: [], replies: [], replyToId: null, quotedPostId: quotedPostId || null };
    const posts = chirpGetPosts();
    posts.unshift(post);
    chirpSavePosts(posts);
    await saveChatMeta();
    chirpRenderFeed();
    setTimeout(() => chirpApplyGrowthReactions(post.id), 700);
}


// ── Text formatting (markdown-lite + @mention) ───────────────────
function chirpFormatContent(text) {
    let h = String(text)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    h = h.replace(/\*\*\*((?:.)*?)\*\*\*/g,'<strong><em>$1</em></strong>');
    h = h.replace(/\*\*((?:.)*?)\*\*/g,'<strong>$1</strong>');
    h = h.replace(/\*((?:.)*?)\*/g,'<em>$1</em>');
    h = h.replace(/~~((?:.)*?)~~/g,'<del>$1</del>');
    h = h.replace(/@(\w+)/g,'<span class="chirp-mention" data-mention="$1">@$1</span>');
    h = h.replace(/\n/g,'<br>');
    return h;
}

// ── Growth reactions (token-free) ────────────────────────────────
function chirpApplyGrowthReactions(postId) {
    const posts = chirpGetPosts();
    const post = posts.find(p => p.id === postId);
    if (!post) return;
    const npcs = chirpGetActiveNpcs();
    if (!npcs.length) return;
    const s = getSettings();
    let changed = false;
    for (const npc of npcs) {
        if (npc.id !== post.authorId && Math.random() < 0.35 && !post.likes.includes(npc.id)) {
            post.likes.push(npc.id);
            chirpAddAffectionReason(npc.id, 'post_liked');
            chirpAddNotif({ type: 'like', actorId: npc.id, actorName: npc.name, actorAvatar: npc.avatar, postId, message: 'лайкнул твой пост', quote: post.content.slice(0,70) });
            changed = true;
        }
        if (Math.random() < 0.10) {
            if (!s.chirpUserProfile._followers) s.chirpUserProfile._followers = 0;
            s.chirpUserProfile._followers++;
            saveSettings();
        }
    }
    if (changed) { chirpSavePosts(posts); saveChatMeta(); chirpUpdateBadges(); if (chirpActiveSubPanel==='home') chirpRenderFeed(); }
}

// ── Post-generate organic reactions ──────────────────────────────
function chirpGenerateOrganicReactions(batch) {
    const posts = chirpGetPosts();
    let changed = false;
    for (let i = 0; i < batch.length; i++) {
        const post = posts.find(p => p.id === batch[i].id);
        if (!post) continue;
        for (let j = 0; j < batch.length; j++) {
            if (i === j) continue;
            const otherId = batch[j].authorId;
            if (otherId !== post.authorId && Math.random() < 0.4 && !post.likes.includes(otherId)) {
                post.likes.push(otherId);
                changed = true;
            }
        }
    }
    const userPosts = posts.filter(p => p.authorId === 'user').slice(0, 3);
    const activeNpcs = chirpGetActiveNpcs();
    if (userPosts.length && activeNpcs.length && Math.random() < 0.25) {
        const target = userPosts[Math.floor(Math.random() * userPosts.length)];
        const npc = activeNpcs[Math.floor(Math.random() * activeNpcs.length)];
        setTimeout(() => chirpNpcAutoReplyTo(target.id, npc), 1300);
    }
    if (changed) { chirpSavePosts(posts); saveChatMeta(); if (chirpActiveSubPanel==='home') chirpRenderFeed(); }
}

// ── NPC auto-reply to a post ──────────────────────────────────────
async function chirpNpcAutoReplyTo(replyPostId, npc) {
    const posts = chirpGetPosts();
    const post = posts.find(p => p.id === replyPostId);
    if (!post) return;
    try {
        const u = getSettings().chirpUserProfile;
        const pAuthor = chirpGetAuthor(post.authorId);
        const sys = `You are ${npc.name} (@${npc.username}) on Deerly. Personality: ${npc.character || 'Friendly'}.\n@${pAuthor.username} wrote: "${post.content}"\nWrite a short reply (max 200 chars). Plain text only.`;
        const raw = await chirpCallApi([{ role:'system', content:sys },{ role:'user', content:'Reply:' }]);
        if (raw?.trim()) {
            const freshPosts = chirpGetPosts();
            const freshPost = freshPosts.find(p => p.id === replyPostId);
            if (!freshPost) return;
            const npcReply = { id: generateId(), authorId: npc.id, content: raw.trim().slice(0, 240), timestamp: Date.now(), likes: [], retweets: [], replies: [], replyToId: replyPostId };
            freshPost.replies.push(npcReply.id);
            freshPosts.unshift(npcReply);
            chirpAddAffectionReason(npc.id, 'npc_reply');
            chirpSavePosts(freshPosts);
            await saveChatMeta();
            chirpAddNotif({ type:'reply', actorId:npc.id, actorName:npc.name, actorAvatar:npc.avatar, postId:npcReply.id, message:'ответил на твой пост', quote:npcReply.content.slice(0,70) });
            chirpUpdateBadges();
            if (chirpActiveSubPanel === 'home') chirpRenderFeed();
        }
    } catch (err) { console.error('[Deerly] NPC auto-reply:', err); }
}

// ── Feed prompt update: user_handle placeholder ───────────────────

// ── Tweet card builder ────────────────────────────────────────────
function chirpBuildCard(post, opts = {}) {
    const { compact = false } = opts;
    const author = chirpGetAuthor(post.authorId);
    const isLiked = post.likes.includes('user');
    const isRted = post.retweets.includes('user');
    const bookmarks = chirpGetBookmarks();
    const isBookmarked = bookmarks.includes(post.id);

    let quoteHtml = '';
    if (post.quotedPostId) {
        const qp = chirpGetPosts().find(p => p.id === post.quotedPostId);
        if (qp) {
            const qa = chirpGetAuthor(qp.authorId);
            quoteHtml = `<div class="chirp-quote-block"><div class="chirp-quote-head"><b>${chirpEsc(qa.name)}</b> <span style="opacity:0.5">@${chirpEsc(qa.username)}</span></div><div class="chirp-quote-txt">${chirpFormatContent(qp.content)}</div></div>`;
        }
    }

    const avContent = author.avatar ? `<img src="${chirpEsc(author.avatar)}" alt="">` : `<span style="font-size:15px;font-weight:700;">${chirpEsc((author.name||'?')[0])}</span>`;

    return `
<div class="chirp-tweet-card${compact?' chirp-card-compact':''}" data-pid="${post.id}">
  <div class="chirp-card-inner">
    <div class="chirp-tweet-av chirp-av-click" data-author="${chirpEsc(post.authorId)}">${avContent}</div>
    <div class="chirp-tweet-main">
      <div class="chirp-tweet-head">
        <span class="chirp-tweet-name chirp-author-click" data-author="${chirpEsc(post.authorId)}">${chirpEsc(author.name)}</span>
        <span class="chirp-tweet-handle">@${chirpEsc(author.username)}</span>
        <span class="chirp-tweet-dot">·</span>
        <span class="chirp-tweet-ts">${chirpRelTime(post.timestamp)}</span>
        <button class="chirp-more-btn" data-pid="${post.id}"><i class="fa-solid fa-ellipsis"></i></button>
      </div>
      <div class="chirp-tweet-txt chirp-open-thread" data-pid="${post.id}">${chirpFormatContent(post.content)}</div>
      ${quoteHtml}
      <div class="chirp-tweet-actions-row">
        <button class="chirp-act-btn chirp-reply-act" data-pid="${post.id}"><i class="fa-regular fa-comment"></i><span>${post.replies.length||''}</span></button>
        <button class="chirp-act-btn chirp-rt-act${isRted?' rted':''}" data-pid="${post.id}"><i class="fa-solid fa-retweet"></i><span>${post.retweets.length||''}</span></button>
        <button class="chirp-act-btn chirp-like-act${isLiked?' liked':''}" data-pid="${post.id}"><i class="${isLiked?'fa-solid':'fa-regular'} fa-heart"></i><span>${post.likes.length||''}</span></button>
        <button class="chirp-act-btn chirp-bookmark-act${isBookmarked?' bookmarked':''}" data-pid="${post.id}" title="${isBookmarked?'Remove bookmark':'Bookmark'}"><i class="${isBookmarked?'fa-solid':'fa-regular'} fa-bookmark"></i></button>
      </div>
    </div>
  </div>
</div>`;
}

// ── Feed render ───────────────────────────────────────────────────
function chirpRenderFeed() {
    const scroll = chirpEl('chirp-feed-scroll');
    if (!scroll) return;
    const posts = chirpGetPosts();
    scroll.innerHTML = '';
    if (!posts.length) {
        scroll.innerHTML = `<div class="chirp-empty-state"><i class="fa-solid fa-feather-pointed"></i><div class="chirp-empty-title">Nothing here yet</div><div class="chirp-empty-sub">Hit Generate or write your first post!</div></div>`;
        return;
    }
    const topPosts = posts.filter(p => !p.replyToId).slice(0, 60);
    for (const post of topPosts) {
        scroll.insertAdjacentHTML('beforeend', chirpBuildCard(post));
        // Show 1 preview reply
        const replyIds = post.replies || [];
        if (replyIds.length > 0) {
            const firstReply = posts.find(p => p.id === replyIds[0]);
            if (firstReply) {
                const wrap = document.createElement('div');
                wrap.style.paddingLeft = '52px';
                wrap.innerHTML = chirpBuildCard(firstReply, { compact: true });
                scroll.appendChild(wrap);
                if (replyIds.length > 1) {
                    const more = document.createElement('div');
                    more.className = 'chirp-show-more-replies';
                    more.dataset.pid = post.id;
                    more.innerHTML = `<i class="fa-solid fa-turn-down-right" style="transform:rotate(180deg);margin-right:5px;opacity:0.5;"></i> ${replyIds.length - 1} more repl${replyIds.length-1===1?'y':'ies'}`;
                    scroll.appendChild(more);
                }
            }
        }
    }
    chirpBindFeedEvents(scroll);
}

function chirpBindFeedEvents(container) {
    container.querySelectorAll('.chirp-mention').forEach(span => span.addEventListener('click', e => {
        e.stopPropagation();
        const _mHandle = span.dataset.mention;
        if (!_mHandle) return;
        const _mNpc = (getSettings().npcAssistants||[]).find(n => n.username === _mHandle);
        if (_mNpc) chirpOpenProfileModal(_mNpc.id);
    }));
    container.querySelectorAll('.chirp-like-act').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); chirpToggleLike(b.dataset.pid); }));
    container.querySelectorAll('.chirp-rt-act').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); chirpShowRtMenu(b.dataset.pid, e); }));
    container.querySelectorAll('.chirp-reply-act').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); chirpOpenThread(b.dataset.pid, true); }));
    container.querySelectorAll('.chirp-bookmark-act').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); chirpToggleBookmark(b.dataset.pid); }));
    container.querySelectorAll('.chirp-more-btn').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); chirpShowCtxMenu(b.dataset.pid, e); }));
    container.querySelectorAll('.chirp-author-click,.chirp-av-click').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); chirpOpenProfileModal(el.dataset.author || el.dataset.avAuthor || el.dataset.author); }));
    container.querySelectorAll('.chirp-open-thread').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); chirpOpenThread(el.dataset.pid, false); }));
    container.querySelectorAll('.chirp-show-more-replies').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); chirpOpenThread(el.dataset.pid, false); }));
}

// ── Thread view ───────────────────────────────────────────────────
function chirpOpenThread(pid, focusReply) {
    const layer = chirpEl('chirp-modal-layer');
    if (!layer) return;
    layer.style.display = 'flex';
    layer.dataset.mode = 'thread';
    const titleEl = chirpEl('chirp-modal-title');
    if (titleEl) titleEl.textContent = 'Thread';

    const scroll = chirpEl('chirp-modal-scroll');
    if (!scroll) return;

    const posts = chirpGetPosts();
    const post = posts.find(p => p.id === pid);
    if (!post) return;

    // Build parent chain
    const chain = [];
    let cur = post;
    while (cur.replyToId) { const parent = posts.find(p => p.id === cur.replyToId); if (!parent) break; chain.unshift(parent); cur = parent; }

    scroll.innerHTML = '';

    // Parent chain (greyed)
    for (const p of chain) {
        const wrapper = document.createElement('div');
        wrapper.style.opacity = '0.65';
        wrapper.innerHTML = chirpBuildCard(p, { compact: true });
        const connector = document.createElement('div');
        connector.className = 'chirp-thread-connector';
        scroll.appendChild(wrapper);
        scroll.appendChild(connector);
    }

    // Main post
    scroll.insertAdjacentHTML('beforeend', chirpBuildCard(post));

    // Divider
    scroll.insertAdjacentHTML('beforeend', `<div class="chirp-divider-label" style="margin:0;"><i class="fa-solid fa-reply"></i> Replies</div>`);

    // All replies recursively
    function appendReplies(replyIds, depth) {
        for (const rid of replyIds) {
            const r = posts.find(p => p.id === rid);
            if (!r) continue;
            const wrapper = document.createElement('div');
            wrapper.style.paddingLeft = Math.min(depth * 24, 72) + 'px';
            wrapper.innerHTML = chirpBuildCard(r, { compact: depth > 0 });
            scroll.appendChild(wrapper);
            if (r.replies?.length) appendReplies(r.replies, depth + 1);
        }
    }
    appendReplies(post.replies || [], 0);

    // Reply composer at bottom
    const u = getSettings().chirpUserProfile;
    const avHtml = u.avatar ? `<img src="${chirpEsc(u.avatar)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">` : `<span style="font-size:14px;font-weight:700;">${chirpEsc((u.name||'?')[0])}</span>`;
    const composer = document.createElement('div');
    composer.className = 'chirp-thread-composer';
    composer.innerHTML = `<div class="chirp-thread-composer-av">${avHtml}</div><div style="flex:1;"><textarea class="chirp-reply-field" id="chirp-thread-reply-field" placeholder="Reply to ${chirpEsc(chirpGetAuthor(post.authorId).name)}…" rows="1" maxlength="280"></textarea></div><button class="chirp-reply-send-btn" id="chirp-thread-reply-send">Reply</button>`;
    scroll.appendChild(composer);

    chirpBindFeedEvents(scroll);

    const field = chirpEl('chirp-thread-reply-field');
    const send = chirpEl('chirp-thread-reply-send');
    if (field) {
        field.addEventListener('input', () => { send.disabled = !field.value.trim(); field.style.height = 'auto'; field.style.height = field.scrollHeight + 'px'; });
        field.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!send?.disabled) send.click(); } });
    }
    send?.addEventListener('click', async () => {
        const text = field?.value?.trim(); if (!text) return;
        send.disabled = true;
        await chirpSubmitReply(pid, text);
        layer.style.display = 'none';
        setTimeout(() => chirpOpenThread(pid, false), 50);
    });

    if (focusReply) setTimeout(() => field?.focus(), 100);
}

// ── Like / RT / Bookmark ──────────────────────────────────────────
function chirpToggleLike(pid) {
    const posts = chirpGetPosts(); const post = posts.find(p => p.id === pid); if (!post) return;
    const idx = post.likes.indexOf('user');
    if (idx > -1) { post.likes.splice(idx, 1); }
    else {
        post.likes.push('user');
    }
    chirpSavePosts(posts); saveChatMeta().then(() => chirpRenderFeed());
}

function chirpShowRtMenu(pid, evt) {
    chirpCloseCtxMenu();
    const menu = document.createElement('div');
    menu.className = 'chirp-ctx-menu';
    menu.style.left = evt.clientX + 'px'; menu.style.top = evt.clientY + 'px';
    menu.innerHTML = `<div class="chirp-ctx-item" data-a="rt"><i class="fa-solid fa-retweet"></i> Repost</div><div class="chirp-ctx-item" data-a="quote"><i class="fa-solid fa-quote-left"></i> Quote</div>`;
    menu.addEventListener('click', e => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (a === 'rt') chirpDoRetweet(pid);
        if (a === 'quote') chirpOpenQuoteCompose(pid);
        chirpCloseCtxMenu();
    });
    document.body.appendChild(menu); chirpCtxMenu = menu;
    requestAnimationFrame(() => {
        const r = menu.getBoundingClientRect();
        if (r.right > window.innerWidth) menu.style.left = (window.innerWidth - r.width - 6) + 'px';
        if (r.bottom > window.innerHeight) menu.style.top = (evt.clientY - r.height) + 'px';
    });
}

function chirpDoRetweet(pid) {
    const posts = chirpGetPosts(); const post = posts.find(p => p.id === pid); if (!post) return;
    const idx = post.retweets.indexOf('user');
    if (idx > -1) { post.retweets.splice(idx, 1); }
    else {
        post.retweets.push('user');
    }
    chirpSavePosts(posts); saveChatMeta().then(() => chirpRenderFeed());
}

function chirpOpenQuoteCompose(quotedPostId) {
    chirpSwitchSubPanel('home');
    const input = chirpEl('chirp-compose-input'); if (!input) return;
    input.dataset.quotedPostId = quotedPostId;
    const qp = chirpGetPosts().find(p => p.id === quotedPostId);
    const qa = qp ? chirpGetAuthor(qp.authorId) : null;
    let preview = chirpEl('chirp-compose-quote-preview');
    if (!preview) { preview = document.createElement('div'); preview.id = 'chirp-compose-quote-preview'; preview.className = 'chirp-compose-quote-preview'; const composeRight = input.parentElement; if (composeRight) composeRight.insertBefore(preview, composeRight.lastElementChild); }
    preview.innerHTML = qp ? `<div class="chirp-quote-block"><div class="chirp-quote-head"><b>${chirpEsc(qa.name)}</b> <span style="opacity:0.5">@${chirpEsc(qa.username)}</span></div><div class="chirp-quote-txt">${chirpEsc(qp.content)}</div></div><button onclick="this.closest('#chirp-compose-quote-preview').remove();delete document.getElementById('chirp-compose-input')?.dataset.quotedPostId;" style="float:right;background:transparent;border:none;color:var(--chirp-muted);cursor:pointer;font-size:12px;">✕</button>` : '';
    input.focus();
}

function chirpToggleBookmark(pid) {
    const bookmarks = chirpGetBookmarks();
    const idx = bookmarks.indexOf(pid);
    if (idx > -1) { bookmarks.splice(idx, 1); toastr.info('Removed from bookmarks'); }
    else { bookmarks.push(pid); toastr.success('Bookmarked!'); }
    chirpSaveBookmarks(bookmarks); saveChatMeta();
    if (chirpActiveSubPanel === 'home') chirpRenderFeed();
    else if (chirpActiveSubPanel === 'bookmarks') chirpRenderBookmarks();
}

// ── Submit reply ──────────────────────────────────────────────────
async function chirpSubmitReply(replyToId, text) {
    const posts = chirpGetPosts();
    const parent = posts.find(p => p.id === replyToId); if (!parent) return;
    const reply = { id: generateId(), authorId: 'user', content: text.slice(0, 280), timestamp: Date.now(), likes: [], retweets: [], replies: [], replyToId };
    parent.replies.push(reply.id);
    posts.unshift(reply);
    chirpSavePosts(posts);
    await saveChatMeta();
    if (parent.authorId && parent.authorId !== 'user') {
        const _rNpc = chirpGetNpcById(parent.authorId);
        if (_rNpc) setTimeout(() => chirpNpcAutoReplyTo(reply.id, _rNpc), 900);
    }
}

// ── NPC react to post ─────────────────────────────────────────────
async function chirpNpcReact(pid) {
    const npcs = chirpGetActiveNpcs(); if (!npcs.length) { toastr.warning('No active NPCs'); return; }
    const posts = chirpGetPosts(); const post = posts.find(p => p.id === pid); if (!post) return;
    const cands = npcs.filter(n => n.id !== post.authorId);
    const npc = cands.length ? cands[Math.floor(Math.random() * cands.length)] : npcs[0];
    const btn = document.querySelector(`.chirp-npc-react-act[data-pid="${pid}"]`);
    if (btn) { btn.disabled = true; btn.innerHTML = '<div class="chirp-spin"></div>'; }
    try {
        const pAuthor = chirpGetAuthor(post.authorId);
        const sys = `You are ${npc.name} (@${npc.username}) on Deerly. ${npc.character || 'Friendly'}\nReply to this post in max 220 chars. Just plain text:\n"${post.content}" — by @${pAuthor.username}`;
        const raw = await chirpCallApi([{ role: 'system', content: sys }, { role: 'user', content: 'Write your reply:' }]);
        if (raw?.trim()) {
            const replyPost = { id: generateId(), authorId: npc.id, content: raw.trim().slice(0, 240), timestamp: Date.now(), likes: [], retweets: [], replies: [], replyToId: pid };
            post.replies.push(replyPost.id); posts.unshift(replyPost);
            chirpSavePosts(posts); await saveChatMeta(); chirpRenderFeed();
        }
    } catch (err) { toastr.error('NPC react failed: ' + err.message); }
    finally { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-robot"></i>'; } }
}

// ── Context menu ──────────────────────────────────────────────────
function chirpShowCtxMenu(pid, evt) {
    chirpCloseCtxMenu();
    const post = chirpGetPosts().find(p => p.id === pid); if (!post) return;
    const isOwn = post.authorId === 'user';
    const bookmarks = chirpGetBookmarks();
    const isBookmarked = bookmarks.includes(pid);
    const menu = document.createElement('div');
    menu.className = 'chirp-ctx-menu';
    menu.style.left = evt.clientX + 'px'; menu.style.top = evt.clientY + 'px';
    menu.innerHTML = `
      <div class="chirp-ctx-item" data-a="open"><i class="fa-regular fa-comment-dots"></i> Open thread</div>
      <div class="chirp-ctx-item" data-a="copy"><i class="fa-regular fa-copy"></i> Copy text</div>
      <div class="chirp-ctx-item" data-a="quote"><i class="fa-solid fa-quote-left"></i> Quote post</div>
      <div class="chirp-ctx-item" data-a="npc"><i class="fa-solid fa-robot"></i> NPC reaction</div>
      <div class="chirp-ctx-item" data-a="bm"><i class="${isBookmarked?'fa-solid':'fa-regular'} fa-bookmark"></i> ${isBookmarked?'Remove bookmark':'Bookmark'}</div>
      ${isOwn ? '<div class="chirp-ctx-item danger" data-a="del"><i class="fa-solid fa-trash"></i> Delete post</div>' : '<div class="chirp-ctx-item" data-a="profile"><i class="fa-regular fa-user"></i> View profile</div>'}`;
    menu.addEventListener('click', e => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (a === 'open') chirpOpenThread(pid, false);
        if (a === 'copy') { navigator.clipboard?.writeText(post.content); toastr.success('Copied!'); }
        if (a === 'quote') chirpOpenQuoteCompose(pid);
        if (a === 'npc') chirpNpcReact(pid);
        if (a === 'bm') chirpToggleBookmark(pid);
        if (a === 'del') {
            const ps = chirpGetPosts(); const i = ps.findIndex(p => p.id === pid);
            if (i > -1) { ps.splice(i, 1); ps.forEach(p => { if (p.replies) p.replies = p.replies.filter(r => r !== pid); }); chirpSavePosts(ps); saveChatMeta().then(() => chirpRenderFeed()); }
        }
        if (a === 'profile') chirpOpenProfileModal(post.authorId);
        chirpCloseCtxMenu();
    });
    document.body.appendChild(menu); chirpCtxMenu = menu;
    requestAnimationFrame(() => {
        const r = menu.getBoundingClientRect();
        if (r.right > window.innerWidth) menu.style.left = (window.innerWidth - r.width - 6) + 'px';
        if (r.bottom > window.innerHeight) menu.style.top = (evt.clientY - r.height) + 'px';
    });
}
function chirpCloseCtxMenu() { if (chirpCtxMenu) { chirpCtxMenu.remove(); chirpCtxMenu = null; } }
document.addEventListener('click', () => chirpCloseCtxMenu());
document.addEventListener('keydown', e => { if (e.key === 'Escape') { chirpCloseCtxMenu(); const layer = chirpEl('chirp-modal-layer'); if (layer?.style.display !== 'none') layer.style.display = 'none'; } });

// ── Bookmarks panel ───────────────────────────────────────────────
function chirpRenderBookmarks() {
    const scroll = chirpEl('chirp-bm-scroll'); if (!scroll) return;
    const bookmarks = chirpGetBookmarks();
    const posts = chirpGetPosts();
    scroll.innerHTML = '';
    if (!bookmarks.length) { scroll.innerHTML = `<div class="chirp-empty-state"><i class="fa-regular fa-bookmark"></i><div class="chirp-empty-title">No bookmarks yet</div><div class="chirp-empty-sub">Tap the bookmark icon on any post</div></div>`; return; }
    for (const bid of bookmarks) {
        const p = posts.find(x => x.id === bid);
        if (p) scroll.insertAdjacentHTML('beforeend', chirpBuildCard(p));
    }
    chirpBindFeedEvents(scroll);
}

// ── DM System ─────────────────────────────────────────────────────
function chirpRenderDmSidebar() {
    const listEl = chirpEl('chirp-dm-list-el'); if (!listEl) return;
    const npcs = chirpGetActiveNpcs();
    const dms = chirpGetDMs();
    listEl.innerHTML = '';
    if (!npcs.length) {
        listEl.innerHTML = `<div class="chirp-empty-state" style="padding:16px 8px;"><i class="fa-regular fa-envelope"></i><div class="chirp-empty-sub" style="font-size:0.76em;text-align:center;">Add NPC Assistants<br>in Settings</div></div>`;
        return;
    }
    for (const npc of npcs) {
        const conv = dms[npc.id] || [];
        const last = conv[conv.length - 1];
        const unread = npc.id !== chirpActiveDmNpcId && conv.some(m => m.role === 'npc' && !m.read);
        const affection = chirpGetAffection(npc.id);
        const stage = chirpGetLoveStage(affection);
        const row = document.createElement('div');
        row.className = 'chirp-dm-row' + (npc.id === chirpActiveDmNpcId ? ' active' : '') + (unread ? ' unread' : '');
        row.innerHTML = `
          <div class="chirp-dm-row-av">
            ${npc.avatar ? `<img src="${chirpEsc(npc.avatar)}" alt="">` : `<span style="font-size:14px;font-weight:700;">${chirpEsc((npc.name||'?')[0])}</span>`}
            <div class="chirp-dm-online"></div>
          </div>
          <div class="chirp-dm-row-info">
            <div class="chirp-dm-row-name">${chirpEsc(npc.name)}</div>
            <div class="chirp-dm-row-preview">${chirpEsc(last ? last.content.slice(0, 36) : 'Say hello!')}</div>
          </div>
          <div class="chirp-dm-unread-dot"></div>`;
        row.addEventListener('click', () => chirpOpenDm(npc.id));
        listEl.appendChild(row);
    }
}

function chirpOpenDm(npcId) {
    chirpActiveDmNpcId = npcId;
    const dms = chirpGetDMs();
    const conv = dms[npcId] || [];
    conv.forEach(m => { if (m.role === 'npc') m.read = true; });
    chirpSaveDMs(dms);
    saveChatMeta();
    chirpRenderDmSidebar();
    chirpRenderDmChat(npcId);
    chirpUpdateBadges();
}

function chirpRenderDmChat(npcId) {
    const chatArea = chirpEl('chirp-dm-chat-area'); if (!chatArea) return;
    const npc = chirpGetNpcById(npcId); if (!npc) return;

    const dmsObj = chirpGetDMs();
    const conv = Array.isArray(dmsObj[npcId]) ? dmsObj[npcId] : [];
    const u = getSettings().chirpUserProfile;

    const affection = chirpGetAffection(npcId);
    const stage = chirpGetLoveStage(affection);
    const npcAv = npc.avatar ? `<img src="${chirpEsc(npc.avatar)}" alt="">` : `<span style="font-size:13px;font-weight:700;">${chirpEsc((npc.name||'?')[0])}</span>`;
    const uAv = u.avatar ? `<img src="${chirpEsc(u.avatar)}" alt="">` : `<span style="font-size:11px;font-weight:700;">${chirpEsc((u.name||'?')[0])}</span>`;

    chatArea.innerHTML = `
      <div class="chirp-dm-chat-hdr">
        <div class="chirp-dm-av-online chirp-dm-chat-hdr-av chirp-author-click" data-author="${chirpEsc(npc.id)}" style="cursor:pointer;"><span class="chirp-dm-av-inner">${npcAv}</span><span class="chirp-online-dot"></span></div>
        <div class="chirp-dm-chat-info" style="cursor:pointer;" data-author="${chirpEsc(npc.id)}" class="chirp-author-click">
          <div class="chirp-dm-chat-name">${chirpEsc(npc.name)}</div>
          <div class="chirp-dm-chat-handle">@${chirpEsc(npc.username)} <span style="font-size:0.78em;color:${stage.color};margin-left:4px;">${stage.icon} ${stage.label}</span></div>
        </div>
        <div style="display:flex;align-items:center;gap:5px;margin-left:auto;">
          <div class="chirp-affection-bar" title="${affection}/100"><div class="chirp-affection-fill" style="width:${affection}%;background:${stage.color};"></div></div>
        </div>
      </div>
      <div class="chirp-dm-messages" id="chirp-dm-msgs-${npcId}">
        ${conv.length === 0 ? `<div class="chirp-empty-state" style="padding:24px;"><i class="fa-regular fa-comments" style="font-size:2em;opacity:0.3;"></i><div class="chirp-empty-title">${chirpEsc(npc.name)}</div><div class="chirp-empty-sub">Напиши первым!</div></div>` : conv.map(m => {
            const isUser = m.role === 'user';
            const avHtml = isUser ? uAv : npcAv;
            return `<div class="chirp-dm-msg ${isUser?'me':'them'}">
              <div class="chirp-dm-msg-av">${avHtml}</div>
              <div>
                <div class="chirp-dm-bubble">${chirpFormatContent(m.content)}
                  <span class="chirp-dm-bubble-ts">${chirpRelTime(m.timestamp)}</span>
                </div>
              </div>
            </div>`;
        }).join('')}
      </div>
      <div class="chirp-dm-toolbar">
        <button class="chirp-dm-tool-btn" id="chirp-dm-clear-${npcId}" title="Очистить историю"><i class="fa-regular fa-trash-can"></i></button>
        <button class="chirp-dm-tool-btn" id="chirp-dm-profile-${npcId}" title="Профиль"><i class="fa-regular fa-user"></i></button>
        <button class="chirp-dm-tool-btn" id="chirp-dm-export-${npcId}" title="Экспорт диалога"><i class="fa-solid fa-arrow-up-from-bracket"></i></button>
      </div>
      <div class="chirp-dm-input-bar">
        <textarea class="chirp-dm-field" id="chirp-dm-field-${npcId}" placeholder="Сообщение для ${chirpEsc(npc.name)}…" rows="1" maxlength="500"></textarea>
        <button class="chirp-dm-send-btn" id="chirp-dm-send-${npcId}" disabled title="Отправить"><i class="fa-solid fa-paper-plane"></i></button>
      </div>`;

    // Bind events
    chatArea.querySelectorAll('.chirp-author-click').forEach(el => el.addEventListener('click', () => chirpOpenProfileModal(el.dataset.author)));

    // Toolbar buttons
    chirpEl(`chirp-dm-clear-${npcId}`)?.addEventListener('click', () => {
        if (!confirm(`Очистить переписку с ${npc.name}?`)) return;
        const dmsObj = chirpGetDMs();
        dmsObj[npcId] = [];
        chirpSaveDMs(dmsObj);
        saveChatMeta();
        chirpRenderDmChat(npcId);
        toastr.success('История очищена');
    });
    chirpEl(`chirp-dm-profile-${npcId}`)?.addEventListener('click', () => chirpOpenProfileModal(npcId));
    chirpEl(`chirp-dm-export-${npcId}`)?.addEventListener('click', () => {
        const dmsObj = chirpGetDMs();
        const conv = Array.isArray(dmsObj[npcId]) ? dmsObj[npcId] : [];
        if (!conv.length) { toastr.info('Нет сообщений для экспорта'); return; }
        const text = conv.map(m => `[${new Date(m.timestamp).toLocaleString()}] ${m.role === 'user' ? (getSettings().chirpUserProfile.name||'You') : npc.name}: ${m.content}`).join('\n');
        const blob = new Blob([text], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `deerly-dm-${npc.username}.txt`;
        a.click();
        URL.revokeObjectURL(a.href);
    });

    const field = chirpEl(`chirp-dm-field-${npcId}`);
    const send = chirpEl(`chirp-dm-send-${npcId}`);
    if (field && send) {
        field.addEventListener('input', () => {
            send.disabled = !field.value.trim();
            field.style.height = 'auto';
            const sh = field.scrollHeight;
            field.style.height = Math.min(sh, 90) + 'px';
            field.style.overflowY = sh > 90 ? 'auto' : 'hidden';
        });
        field.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!send.disabled) chirpSendDm(npcId); } });
        send.addEventListener('click', () => chirpSendDm(npcId));
    }

    // Scroll to bottom
    requestAnimationFrame(() => {
        const msgs = chirpEl(`chirp-dm-msgs-${npcId}`);
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
    });
}

async function chirpSendDm(npcId) {
    const field = chirpEl(`chirp-dm-field-${npcId}`);
    if (!field) return;
    const text = field.value.trim();
    if (!text) return;

    // Clear input immediately
    field.value = '';
    field.style.height = 'auto';
    field.style.overflowY = 'hidden';
    const send = chirpEl(`chirp-dm-send-${npcId}`);
    if (send) send.disabled = true;

    // Save user message
    const dmsObj = chirpGetDMs();
    if (!Array.isArray(dmsObj[npcId])) dmsObj[npcId] = [];
    const userMsg = { role: 'user', content: text, timestamp: Date.now(), read: true };
    dmsObj[npcId].push(userMsg);
    chirpSaveDMs(dmsObj);
    await saveChatMeta();

    // Re-render to show user message immediately
    chirpRenderDmChat(npcId);
    chirpRenderDmSidebar();

    // Typing indicator
    const msgs = chirpEl(`chirp-dm-msgs-${npcId}`);
    if (msgs) {
        const typingEl = document.createElement('div');
        typingEl.className = 'chirp-dm-msg them';
        typingEl.id = `chirp-typing-${npcId}`;
        typingEl.innerHTML = `<div class="chirp-dm-msg-av">${chirpEl('chirp-dm-chat-area')?.querySelector('.chirp-dm-chat-hdr-av')?.innerHTML || ''}</div><div class="chirp-dm-typing-wrap"><div class="chirp-dm-typing-dot"></div><div class="chirp-dm-typing-dot"></div><div class="chirp-dm-typing-dot"></div></div>`;
        msgs.appendChild(typingEl);
        msgs.scrollTop = msgs.scrollHeight;
    }

    try {
        const npc = chirpGetNpcById(npcId);
        const s = getSettings();
        const u = s.chirpUserProfile;
        let prompt = (s.chirpDmPrompt || chirpDefaults.chirpDmPrompt)
            .replace(/\{\{npc_name\}\}/g, npc.name)
            .replace(/\{\{npc_username\}\}/g, npc.username)
            .replace(/\{\{personality\}\}/g, npc.character || 'Friendly')
            .replace(/\{\{post_style\}\}/g, npc.postExample ? `Style: ${npc.postExample}` : 'Casual')
            .replace(/\{\{user_name\}\}/g, u.name || 'Player')
            .replace(/\{\{user_username\}\}/g, u.username || 'player')
            .replace(/\{\{context\}\}/g, gatherContext());
        const freshDms = chirpGetDMs();
        const conv = Array.isArray(freshDms[npcId]) ? freshDms[npcId] : [];
        const history = conv.slice(-8).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));
        const reply = await chirpCallApi([{ role: 'system', content: prompt }, ...history]);
        if (reply?.trim()) {
            const npcMsg = { role: 'npc', content: reply.trim(), timestamp: Date.now(), read: false };
            const dmsObj2 = chirpGetDMs();
            if (!Array.isArray(dmsObj2[npcId])) dmsObj2[npcId] = [];
            dmsObj2[npcId].push(npcMsg);
            chirpSaveDMs(dmsObj2);
            await saveChatMeta();
            // Increase affection with reason
            const _dmsCount = (chirpGetDMs()[npcId] || []).length;
            chirpAddAffectionReason(npcId, _dmsCount <= 2 ? 'dm_first' : 'dm_reply');
            chirpAddNotif({ type: 'dm', actorId: npcId, actorName: npc.name, actorAvatar: npc.avatar, message: 'replied to your message', quote: reply.trim().slice(0, 70) });
        }
    } catch (err) {
        console.error('[Chirp] DM error:', err);
        toastr.error('DM failed: ' + err.message);
    } finally {
        chirpEl(`chirp-typing-${npcId}`)?.remove();
        chirpRenderDmChat(npcId);
        chirpRenderDmSidebar();
        chirpUpdateBadges();
    }
}

// ── Notifications ─────────────────────────────────────────────────
function chirpRenderNotifications() {
    const scroll = chirpEl('chirp-notifs-scroll'); if (!scroll) return;
    const notifs = chirpGetNotifs();
    scroll.innerHTML = '';
    if (!notifs.length) { scroll.innerHTML = `<div class="chirp-empty-state"><i class="fa-regular fa-bell"></i><div class="chirp-empty-title">All caught up!</div></div>`; return; }
    const unread = notifs.filter(n => !n.read).length;
    if (unread > 0) {
        const bar = document.createElement('div');
        bar.style.cssText = 'padding:5px 14px;text-align:right;border-bottom:1px solid var(--chirp-border);';
        bar.innerHTML = `<button style="background:transparent;border:none;color:var(--chirp-accent);font-size:0.79em;cursor:pointer;font-family:inherit;padding:3px 6px;">Mark all as read</button>`;
        bar.querySelector('button').addEventListener('click', () => { chirpGetNotifs().forEach(n => n.read = true); saveChatMeta(); chirpUpdateBadges(); chirpRenderNotifications(); });
        scroll.appendChild(bar);
    }
    const iconMap = { like: { cls: 'like', icon: 'fa-heart' }, retweet: { cls: 'retweet', icon: 'fa-retweet' }, reply: { cls: 'reply', icon: 'fa-reply' }, dm: { cls: 'dm', icon: 'fa-envelope' } };
    for (const n of notifs.slice(0, 60)) {
        const { cls, icon } = iconMap[n.type] || { cls: 'reply', icon: 'fa-bell' };
        const avHtml = n.actorAvatar ? `<img src="${chirpEsc(n.actorAvatar)}" alt="">` : chirpEsc((n.actorName||'?')[0]);
        const item = document.createElement('div');
        item.className = 'chirp-notif-item' + (n.read ? '' : ' unread');
        item.innerHTML = `<div class="chirp-notif-icon ${cls}"><i class="fa-solid ${icon}"></i></div><div class="chirp-notif-av">${avHtml}</div><div class="chirp-notif-body"><span class="chirp-notif-actor">${chirpEsc(n.actorName||'?')}</span> <span class="chirp-notif-txt">${chirpEsc(n.message)}</span>${n.quote ? `<div class="chirp-notif-quote">${chirpFormatContent(n.quote)}</div>` : ''}</div><span class="chirp-notif-time">${chirpRelTime(n.timestamp)}</span>`;
        item.addEventListener('click', () => {
            n.read = true; saveChatMeta(); chirpUpdateBadges();
            if (n.postId) { chirpSwitchSubPanel('home'); setTimeout(() => chirpOpenThread(n.postId, false), 100); }
            else if (n.type === 'dm' && n.actorId) { chirpSwitchSubPanel('dms'); setTimeout(() => chirpOpenDm(n.actorId), 100); }
            chirpRenderNotifications();
        });
        scroll.appendChild(item);
    }
}

// ── Profile ───────────────────────────────────────────────────────
function chirpRenderProfile(targetId) {
    const cont = chirpEl('chirp-profile-content'); if (!cont) return;
    const s = getSettings();
    const isOwn = !targetId || targetId === 'user';
    let profile;
    if (isOwn) { profile = s.chirpUserProfile; }
    else { const npc = chirpGetNpcById(targetId); if (!npc) return; profile = { name: npc.name, username: npc.username, avatar: npc.avatar, banner: npc.banner, bio: npc.bio || npc.character || '', _npcId: targetId }; }
    chirpRenderProfileInto(cont, profile, isOwn);
}

function chirpRenderProfileInto(cont, profile, isOwn) {
    const s = getSettings();
    const npcId = profile._npcId;
    const posts = chirpGetPosts().filter(p => p.authorId === (isOwn ? 'user' : npcId));
    const affection = !isOwn && npcId ? chirpGetAffection(npcId) : 0;
    const stage = chirpGetLoveStage(affection);
    const fl = profile._fl || (profile._fl = Math.floor(Math.random() * 8000 + 100));
    const fg = profile._fg || (profile._fg = Math.floor(Math.random() * 400 + 20));
    const bannerStyle = profile.banner ? `style="background-image:url('${chirpEsc(profile.banner)}');background-size:cover;background-position:center;"` : '';
    const avHtml = profile.avatar ? `<img src="${chirpEsc(profile.avatar)}" alt="">` : `<span style="font-size:25px;font-weight:700;">${chirpEsc((profile.name||'?')[0])}</span>`;

    cont.innerHTML = `
      <div class="chirp-profile-banner" id="chirp-pf-banner" ${bannerStyle}>
        <div class="chirp-profile-banner-edit"><i class="fa-solid fa-camera"></i> Change banner</div>
      </div>
      <div class="chirp-profile-info-row">
        <div class="chirp-profile-av-wrap" id="chirp-pav-wrap"><div class="chirp-profile-av">${avHtml}</div>${isOwn||!isOwn?`<div class="chirp-profile-av-edit"><i class="fa-solid fa-camera"></i></div>`:''}</div>
        ${isOwn ? `<button class="chirp-profile-edit-btn" id="chirp-pedit-btn"><i class="fa-solid fa-pen"></i> Edit profile</button>` : `<div style="display:flex;gap:6px;"><button class="chirp-profile-follow-btn ${profile._following?'following':''}" id="chirp-follow-btn">${profile._following?'Following':'Follow'}</button><button style="background:transparent;border:1px solid var(--chirp-border);border-radius:20px;padding:6px 12px;font-size:0.84em;color:var(--chirp-text);cursor:pointer;font-family:inherit;" id="chirp-dm-from-p"><i class="fa-regular fa-envelope"></i></button></div>`}
      </div>
      <div class="chirp-profile-meta">
        <div style="display:flex;align-items:center;gap:5px;margin-bottom:2px;flex-wrap:wrap;">
          <span class="chirp-profile-name">${chirpEsc(profile.name||'User')}</span>
          <span class="chirp-profile-verified"><i class="fa-solid fa-circle-check"></i></span>
          ${!isOwn ? chirpHeartsHtml(affection, 'lg') : ''}
        </div>
        <div class="chirp-profile-handle">@${chirpEsc(profile.username||'user')}</div>
        ${!isOwn ? `<div class="chirp-love-bar-row" style="margin:6px 0;">
          <div style="font-size:0.8em;color:${stage.color};font-weight:700;margin-bottom:4px;">${stage.icon} <span>${stage.label}</span> — ${affection}/100</div>
          <div style="background:rgba(128,128,128,0.15);border-radius:10px;height:5px;overflow:hidden;margin-bottom:8px;"><div style="height:100%;width:${affection}%;background:${stage.color};border-radius:10px;transition:width 0.4s;"></div></div>
          ${(() => {
            const _npcLogObj = s.npcAssistants?.find(n=>n.id===npcId);
            const _log = _npcLogObj?._affectionLog||[];
            return _log.length ? `<div class="chirp-afflog">${_log.slice(0,8).map(e=>{const d=new Date(e.ts);const when=d.toLocaleDateString('ru',{day:'numeric',month:'short'});return `<div class="chirp-afflog-item"><span class="chirp-afflog-delta ${e.delta>0?'pos':'neg'}">${e.delta>0?'+'+e.delta:e.delta}</span><span class="chirp-afflog-label">${e.label}</span><span class="chirp-afflog-time">${when}</span></div>`;}).join('')}</div>` : '';
          })()}
        </div>` : ''}
        <div class="chirp-profile-bio" id="chirp-pbio">${chirpEsc(profile.bio||'')}</div>
        <div class="chirp-profile-stats">
          <div class="chirp-stat"><span class="chirp-stat-num">${posts.length}</span> <span class="chirp-stat-label">Posts</span></div>
          <div class="chirp-stat"><span class="chirp-stat-num">${fl}</span> <span class="chirp-stat-label">Followers</span></div>
          <div class="chirp-stat"><span class="chirp-stat-num">${fg}</span> <span class="chirp-stat-label">Following</span></div>
        </div>
      </div>
      <div class="chirp-profile-tabs">
        <button class="chirp-profile-tab active" data-pt="posts">Posts</button>
        <button class="chirp-profile-tab" data-pt="likes">Likes</button>
      </div>
      <div id="chirp-profile-posts">${posts.length ? posts.slice(0,40).map(p => chirpBuildCard(p, {compact:true})).join('') : '<div class="chirp-empty-state" style="padding:24px;"><i class="fa-regular fa-newspaper"></i><div class="chirp-empty-title">No posts yet</div></div>'}</div>`;

    // Banner upload (works for both own and NPC)
    cont.querySelector('#chirp-pf-banner')?.addEventListener('click', () => {
        const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
        inp.onchange = e => chirpReadImg(e.target.files[0], url => {
            if (isOwn) { s.chirpUserProfile.banner = url; saveSettings(); }
            else { const npc = s.npcAssistants?.find(n => n.id === npcId); if (npc) { npc.banner = url; saveSettings(); } }
            chirpRenderProfileInto(cont, { ...profile, banner: url }, isOwn);
        });
        inp.click();
    });

    // Avatar click
    cont.querySelector('#chirp-pav-wrap')?.addEventListener('click', () => {
        const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
        inp.onchange = e => chirpReadImg(e.target.files[0], url => {
            if (isOwn) { s.chirpUserProfile.avatar = url; saveSettings(); chirpRenderComposeAv(); chirpLoadSocialSettings(); }
            else { const npc = s.npcAssistants?.find(n => n.id === npcId); if (npc) { npc.avatar = url; saveSettings(); renderNpcList(); } }
            chirpRenderProfileInto(cont, { ...profile, avatar: url }, isOwn);
        });
        inp.click();
    });

    // Edit / Follow / DM buttons
    if (isOwn) {
        chirpEl('chirp-pedit-btn')?.addEventListener('click', () => chirpShowProfileEditForm(cont, s.chirpUserProfile));
    } else {
        chirpEl('chirp-follow-btn')?.addEventListener('click', e => {
            profile._following = !profile._following;
            const npc = s.npcAssistants?.find(n => n.id === npcId);
            if (npc) { npc._following = profile._following; saveSettings(); }
            e.target.textContent = profile._following ? 'Following' : 'Follow';
            e.target.classList.toggle('following', profile._following);
        });
        chirpEl('chirp-dm-from-p')?.addEventListener('click', () => { chirpSwitchSubPanel('dms'); setTimeout(() => chirpOpenDm(npcId), 80); });
    }

    // Profile tabs
    cont.querySelectorAll('.chirp-profile-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            cont.querySelectorAll('.chirp-profile-tab').forEach(t => t.classList.remove('active')); tab.classList.add('active');
            const pc = chirpEl('chirp-profile-posts'); if (!pc) return;
            const all = chirpGetPosts().filter(p => p.authorId === (isOwn ? 'user' : npcId));
            if (tab.dataset.pt === 'likes') {
                const liked = chirpGetPosts().filter(p => p.likes.includes(isOwn ? 'user' : npcId));
                pc.innerHTML = liked.length ? liked.map(p => chirpBuildCard(p, {compact:true})).join('') : '<div class="chirp-empty-state" style="padding:24px;"><div class="chirp-empty-title">No liked posts</div></div>';
            } else {
                pc.innerHTML = all.length ? all.slice(0,40).map(p => chirpBuildCard(p, {compact:true})).join('') : '<div class="chirp-empty-state" style="padding:24px;"><i class="fa-regular fa-newspaper"></i><div class="chirp-empty-title">No posts yet</div></div>';
            }
            chirpBindFeedEvents(pc);
        });
    });
    chirpBindFeedEvents(cont);
}

function chirpShowProfileEditForm(cont, profile) {
    const bioEl = chirpEl('chirp-pbio'); if (!bioEl) return;
    const s = getSettings();
    bioEl.outerHTML = `<div id="chirp-edit-form" style="padding-bottom:10px;">
      <div style="display:flex;flex-direction:column;gap:5px;">
        <label style="font-size:0.74em;color:var(--chirp-accent);">Display name</label>
        <input type="text" id="chirp-ef-name" value="${chirpEsc(profile.name||'')}" style="padding:7px 10px;border:1px solid var(--chirp-border);border-radius:6px;background:transparent;color:var(--chirp-text);font-size:0.9em;">
        <label style="font-size:0.74em;color:var(--chirp-accent);">Handle (no @)</label>
        <input type="text" id="chirp-ef-handle" value="${chirpEsc(profile.username||'')}" style="padding:7px 10px;border:1px solid var(--chirp-border);border-radius:6px;background:transparent;color:var(--chirp-text);font-size:0.9em;">
        <label style="font-size:0.74em;color:var(--chirp-accent);">Bio</label>
        <textarea id="chirp-ef-bio" rows="2" style="padding:7px 10px;border:1px solid var(--chirp-border);border-radius:6px;background:transparent;color:var(--chirp-text);font-size:0.9em;resize:vertical;font-family:inherit;">${chirpEsc(profile.bio||'')}</textarea>
        <div style="display:flex;gap:7px;margin-top:2px;">
          <button id="chirp-ef-save" style="background:var(--chirp-accent);border:none;border-radius:20px;color:#fff;font-size:0.84em;font-weight:700;padding:6px 16px;cursor:pointer;font-family:inherit;">Save</button>
          <button id="chirp-ef-cancel" style="background:transparent;border:1px solid var(--chirp-border);border-radius:20px;color:var(--chirp-text);font-size:0.84em;padding:6px 14px;cursor:pointer;font-family:inherit;">Cancel</button>
        </div>
      </div>
    </div>`;
    chirpEl('chirp-ef-save')?.addEventListener('click', () => {
        const n = chirpEl('chirp-ef-name')?.value.trim(); if (n) { s.chirpUserProfile.name = n; profile.name = n; }
        const h = chirpEl('chirp-ef-handle')?.value.trim().replace(/^@/,''); if (h) { s.chirpUserProfile.username = h; profile.username = h; }
        const b = chirpEl('chirp-ef-bio')?.value || ''; s.chirpUserProfile.bio = b; profile.bio = b;
        saveSettings(); chirpRenderProfile(null); chirpRenderComposeAv(); chirpLoadSocialSettings();
    });
    chirpEl('chirp-ef-cancel')?.addEventListener('click', () => chirpRenderProfile(null));
}

// ── NPC Profile modal ─────────────────────────────────────────────
function chirpOpenProfileModal(authorId) {
    if (!authorId || authorId === 'user') {
        if (chirpActiveSubPanel === 'profile') { chirpRenderProfile(null); return; }
        chirpSwitchSubPanel('profile'); return;
    }
    const npc = chirpGetNpcById(authorId); if (!npc) return;
    const layer = chirpEl('chirp-modal-layer'); if (!layer) return;
    layer.style.display = 'flex';
    layer.dataset.mode = 'profile';
    const titleEl = chirpEl('chirp-modal-title'); if (titleEl) titleEl.textContent = npc.name;
    const scroll = chirpEl('chirp-modal-scroll'); if (!scroll) return;
    scroll.innerHTML = '';
    const fakeProfile = { name: npc.name, username: npc.username, avatar: npc.avatar, banner: npc.banner, bio: npc.bio || npc.character || '', _npcId: authorId, _following: npc._following };
    chirpRenderProfileInto(scroll, fakeProfile, false);
}

// ── Sub-panel switching ───────────────────────────────────────────
function chirpSwitchSubPanel(name) {
    chirpActiveSubPanel = name;
    document.querySelectorAll('.chirp-sub-panel').forEach(p => p.classList.remove('active'));
    const panel = chirpEl(`chirp-sp-${name}`); if (panel) panel.classList.add('active');
    document.querySelectorAll('.chirp-nav-btn[data-sp]').forEach(b => b.classList.toggle('active', b.dataset.sp === name));
    // Close modal if open
    const layer = chirpEl('chirp-modal-layer'); if (layer) layer.style.display = 'none';
    if (name === 'home') chirpRenderFeed();
    else if (name === 'notifs') {
        chirpRenderNotifications();
        setTimeout(() => { chirpGetNotifs().forEach(n => n.read = true); saveChatMeta(); chirpUpdateBadges(); }, 2500);
    }
    else if (name === 'dms') { chirpRenderDmSidebar(); if (chirpActiveDmNpcId) chirpRenderDmChat(chirpActiveDmNpcId); }
    else if (name === 'profile') chirpRenderProfile(null);
    else if (name === 'bookmarks') chirpRenderBookmarks();
}

// ── Compose avatar ────────────────────────────────────────────────
function chirpRenderComposeAv() {
    const el = chirpEl('chirp-compose-av-el'); if (!el) return;
    const u = getSettings().chirpUserProfile;
    el.innerHTML = u.avatar ? `<img src="${chirpEsc(u.avatar)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">` : `<span style="font-size:16px;font-weight:700;">${chirpEsc((u.name||'?')[0])}</span>`;
}

// ── Settings: Social tab ──────────────────────────────────────────
function chirpLoadSocialSettings() {
    const s = getSettings(); const u = s.chirpUserProfile || {};
    const el = id => chirpEl(id);
    if (el('chirp-st-name')) el('chirp-st-name').value = u.name || '';
    if (el('chirp-st-handle')) el('chirp-st-handle').value = u.username || '';
    if (el('chirp-st-bio')) el('chirp-st-bio').value = u.bio || '';
    if (el('chirp-st-count')) el('chirp-st-count').value = s.chirpPostCount || 4;
    if (el('chirp-st-feed-prompt')) el('chirp-st-feed-prompt').value = s.chirpFeedPrompt || chirpDefaults.chirpFeedPrompt;
    if (el('chirp-st-dm-prompt')) el('chirp-st-dm-prompt').value = s.chirpDmPrompt || chirpDefaults.chirpDmPrompt;
    if (el('chirp-st-av')) el('chirp-st-av').innerHTML = u.avatar ? `<img src="${chirpEsc(u.avatar)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">` : '<i class="fa-solid fa-user"></i>';
}

function chirpBindSocialSettingsEvents() {
    let st; const debounce = (delay, fn) => (...a) => { clearTimeout(st); st = setTimeout(() => fn(...a), delay); };
    const saveProfile = debounce(400, () => {
        const s = getSettings();
        const n = chirpEl('chirp-st-name')?.value.trim(); if (n) s.chirpUserProfile.name = n;
        const h = chirpEl('chirp-st-handle')?.value.trim().replace(/^@/,''); if (h) s.chirpUserProfile.username = h;
        s.chirpUserProfile.bio = chirpEl('chirp-st-bio')?.value || '';
        s.chirpPostCount = parseInt(chirpEl('chirp-st-count')?.value) || 4;
        saveSettings(); chirpRenderComposeAv();
    });
    chirpEl('chirp-st-name')?.addEventListener('input', saveProfile);
    chirpEl('chirp-st-handle')?.addEventListener('input', saveProfile);
    chirpEl('chirp-st-bio')?.addEventListener('input', saveProfile);
    chirpEl('chirp-st-count')?.addEventListener('change', saveProfile);
    chirpEl('chirp-st-feed-prompt')?.addEventListener('input', debounce(700, () => { const s = getSettings(); s.chirpFeedPrompt = chirpEl('chirp-st-feed-prompt')?.value || ''; saveSettings(); }));
    chirpEl('chirp-st-dm-prompt')?.addEventListener('input', debounce(700, () => { const s = getSettings(); s.chirpDmPrompt = chirpEl('chirp-st-dm-prompt')?.value || ''; saveSettings(); }));
    chirpEl('chirp-st-av')?.addEventListener('click', () => {
        const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
        inp.onchange = e => chirpReadImg(e.target.files[0], url => {
            const s = getSettings(); s.chirpUserProfile.avatar = url; saveSettings();
            const av = chirpEl('chirp-st-av'); if (av) av.innerHTML = `<img src="${chirpEsc(url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
            chirpRenderComposeAv();
        });
        inp.click();
    });
    chirpEl('chirp-st-reset-prompts')?.addEventListener('click', () => {
        const s = getSettings();
        s.chirpFeedPrompt = chirpDefaults.chirpFeedPrompt;
        s.chirpDmPrompt = chirpDefaults.chirpDmPrompt;
        saveSettings(); chirpLoadSocialSettings();
        toastr.success('Prompts reset to default');
    });
}

function chirpReadImg(file, cb) { if (!file) return; const r = new FileReader(); r.onload = e => cb(e.target.result); r.readAsDataURL(file); }
