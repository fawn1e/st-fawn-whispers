/* ============================================================
   Whispers — AI Assistant Extension for SillyTavern
   ============================================================ */

const MODULE_NAME = 'whispers';

// ── Default Settings ────────────────────────────────────────────
const defaultSettings = Object.freeze({
    enabled: true,
    assistants: [],
    extraApiUrl: '',
    messageLimit: 20,
    globalAssistantId: '',
    characterBindings: {},
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
    const { saveSettingsDebounced } = SillyTavern.getContext();
    saveSettingsDebounced();
}

function getChatMeta() {
    return SillyTavern.getContext().chatMetadata;
}

async function saveChatMeta() {
    const { saveMetadata } = SillyTavern.getContext();
    await saveMetadata();
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

/** Determine which assistant to use (chat > character > global) */
function getActiveAssistant() {
    const settings = getSettings();
    const meta = getChatMeta();

    // 1. Per-chat binding
    if (meta && meta.whispers_assistant_id) {
        const a = settings.assistants.find(a => a.id === meta.whispers_assistant_id);
        if (a) return a;
    }

    // 2. Per-character binding
    const charName = getCurrentCharName();
    if (charName && settings.characterBindings[charName]) {
        const a = settings.assistants.find(a => a.id === settings.characterBindings[charName]);
        if (a) return a;
    }

    // 3. Global
    if (settings.globalAssistantId) {
        const a = settings.assistants.find(a => a.id === settings.globalAssistantId);
        if (a) return a;
    }

    // 4. First available
    return settings.assistants.length > 0 ? settings.assistants[0] : null;
}

/** Build the system prompt from template + assistant data */
function buildSystemPrompt(assistant) {
    const settings = getSettings();
    let prompt = settings.mainPromptTemplate;

    prompt = prompt.replace(/\{\{name\}\}/g, assistant.name || 'Assistant');
    prompt = prompt.replace(/\{\{character\}\}/g, assistant.character || 'Helpful and friendly');
    prompt = prompt.replace(/\{\{bans\}\}/g, assistant.bans || 'None');

    // Inject recent main chat messages as context
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat || [];
    const limit = settings.messageLimit || 20;
    const recentMessages = chat.slice(-limit);
    const contextStr = recentMessages.map(m => {
        const role = m.is_user ? 'User' : (m.name || 'Character');
        return `${role}: ${m.mes}`;
    }).join('\n');

    prompt = prompt.replace(/\{\{context\}\}/g, contextStr);

    return prompt;
}

// ── PNG Import/Export (tEXt chunk steganography) ────────────────

/** Encode assistant data into a PNG as a tEXt chunk */
async function exportAssistantToPng(assistant) {
    // Create a canvas with the avatar or a default image
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 400;
    const cCtx = canvas.getContext('2d');

    if (assistant.avatar) {
        const img = new Image();
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = assistant.avatar;
        });
        cCtx.drawImage(img, 0, 0, 400, 400);
    } else {
        // Gradient background
        const grad = cCtx.createLinearGradient(0, 0, 400, 400);
        grad.addColorStop(0, '#667eea');
        grad.addColorStop(1, '#764ba2');
        cCtx.fillStyle = grad;
        cCtx.fillRect(0, 0, 400, 400);
        // Name text
        cCtx.fillStyle = '#fff';
        cCtx.font = 'bold 48px sans-serif';
        cCtx.textAlign = 'center';
        cCtx.textBaseline = 'middle';
        cCtx.fillText(assistant.name || 'Assistant', 200, 180);
        cCtx.font = '24px sans-serif';
        cCtx.globalAlpha = 0.7;
        cCtx.fillText('Whispers Assistant', 200, 240);
        cCtx.globalAlpha = 1;
    }

    // Get the raw PNG bytes
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const arrayBuf = await blob.arrayBuffer();
    const pngBytes = new Uint8Array(arrayBuf);

    // Inject tEXt chunk with assistant data
    const exportData = {
        name: assistant.name,
        character: assistant.character,
        bans: assistant.bans,
        avatar: assistant.avatar || null,
    };
    const jsonStr = JSON.stringify(exportData);
    const withChunk = injectTextChunk(pngBytes, 'whispers', jsonStr);

    // Download
    const dlBlob = new Blob([withChunk], { type: 'image/png' });
    const url = URL.createObjectURL(dlBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${assistant.name || 'assistant'}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/** Import assistant from a PNG file */
async function importAssistantFromPng(file) {
    const arrayBuf = await file.arrayBuffer();
    const pngBytes = new Uint8Array(arrayBuf);
    const jsonStr = extractTextChunk(pngBytes, 'whispers');

    if (!jsonStr) {
        toastr.error('This PNG does not contain Whispers assistant data.');
        return null;
    }

    try {
        const data = JSON.parse(jsonStr);
        return {
            id: generateId(),
            name: data.name || 'Imported Assistant',
            character: data.character || '',
            bans: data.bans || '',
            avatar: data.avatar || null,
        };
    } catch (e) {
        toastr.error('Failed to parse assistant data from PNG.');
        return null;
    }
}

/** Inject a tEXt chunk into PNG bytes */
function injectTextChunk(pngBytes, keyword, text) {
    // PNG structure: 8-byte signature, then chunks
    // We'll insert our tEXt chunk before IEND
    const encoder = new TextEncoder();
    const keywordBytes = encoder.encode(keyword);
    const textBytes = encoder.encode(text);

    // tEXt chunk data: keyword + null byte + text
    const chunkData = new Uint8Array(keywordBytes.length + 1 + textBytes.length);
    chunkData.set(keywordBytes, 0);
    chunkData[keywordBytes.length] = 0; // null separator
    chunkData.set(textBytes, keywordBytes.length + 1);

    // Build the chunk: length (4) + type (4) + data + CRC (4)
    const chunkType = encoder.encode('tEXt');
    const chunkLength = chunkData.length;

    // Calculate CRC over type + data
    const crcInput = new Uint8Array(4 + chunkData.length);
    crcInput.set(chunkType, 0);
    crcInput.set(chunkData, 4);
    const crc = crc32(crcInput);

    const chunk = new Uint8Array(4 + 4 + chunkData.length + 4);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, chunkLength);
    chunk.set(chunkType, 4);
    chunk.set(chunkData, 8);
    view.setUint32(chunk.length - 4, crc);

    // Find IEND position
    const iendPos = findChunkPosition(pngBytes, 'IEND');
    if (iendPos === -1) {
        // Fallback: append before last 12 bytes (IEND chunk)
        const result = new Uint8Array(pngBytes.length + chunk.length);
        result.set(pngBytes.subarray(0, pngBytes.length - 12), 0);
        result.set(chunk, pngBytes.length - 12);
        result.set(pngBytes.subarray(pngBytes.length - 12), pngBytes.length - 12 + chunk.length);
        return result;
    }

    const result = new Uint8Array(pngBytes.length + chunk.length);
    result.set(pngBytes.subarray(0, iendPos), 0);
    result.set(chunk, iendPos);
    result.set(pngBytes.subarray(iendPos), iendPos + chunk.length);
    return result;
}

/** Extract a tEXt chunk value from PNG bytes */
function extractTextChunk(pngBytes, keyword) {
    const decoder = new TextDecoder();
    let offset = 8; // Skip PNG signature

    while (offset < pngBytes.length) {
        const view = new DataView(pngBytes.buffer, pngBytes.byteOffset + offset);
        const length = view.getUint32(0);
        const type = decoder.decode(pngBytes.subarray(offset + 4, offset + 8));

        if (type === 'tEXt') {
            const data = pngBytes.subarray(offset + 8, offset + 8 + length);
            // Find null separator
            let nullIdx = -1;
            for (let i = 0; i < data.length; i++) {
                if (data[i] === 0) { nullIdx = i; break; }
            }
            if (nullIdx > 0) {
                const key = decoder.decode(data.subarray(0, nullIdx));
                if (key === keyword) {
                    return decoder.decode(data.subarray(nullIdx + 1));
                }
            }
        }

        if (type === 'IEND') break;
        offset += 12 + length; // 4 length + 4 type + data + 4 CRC
    }
    return null;
}

/** Find the byte position of a named chunk in PNG */
function findChunkPosition(pngBytes, chunkName) {
    const decoder = new TextDecoder();
    let offset = 8;
    while (offset < pngBytes.length) {
        const view = new DataView(pngBytes.buffer, pngBytes.byteOffset + offset);
        const length = view.getUint32(0);
        const type = decoder.decode(pngBytes.subarray(offset + 4, offset + 8));
        if (type === chunkName) return offset;
        offset += 12 + length;
    }
    return -1;
}

/** CRC32 for PNG chunks */
function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
        }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── Generation ──────────────────────────────────────────────────

async function generateResponse(userMessage) {
    const settings = getSettings();
    const assistant = getActiveAssistant();
    if (!assistant) throw new Error('No assistant configured');

    const systemPrompt = buildSystemPrompt(assistant);

    // Build conversation from whispers history
    const history = getWhispersHistory();
    const limit = settings.messageLimit || 20;
    const recentHistory = history.slice(-limit);

    if (settings.useExtraApi && settings.extraApiUrl) {
        return await generateViaExtraApi(systemPrompt, recentHistory, userMessage, settings.extraApiUrl);
    } else {
        return await generateViaSillyTavern(systemPrompt, recentHistory, userMessage);
    }
}

async function generateViaExtraApi(systemPrompt, history, userMessage, apiUrl) {
    // Build messages array
    const messages = [
        { role: 'system', content: systemPrompt },
    ];
    for (const msg of history) {
        messages.push({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content,
        });
    }
    messages.push({ role: 'user', content: userMessage });

    try {
        const url = new URL(apiUrl);
        if (!url.pathname.endsWith('/generate') && !url.pathname.endsWith('/chat/completions')) {
            url.pathname = url.pathname.replace(/\/$/, '') + '/v1/chat/completions';
        }

        const response = await fetch(url.toString(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messages: messages,
                temperature: 0.7,
                max_tokens: 1024,
            }),
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();

        // Support OpenAI-compatible format
        if (data.choices && data.choices.length > 0) {
            return data.choices[0].message?.content || data.choices[0].text || '';
        }
        // Fallback formats
        if (data.response) return data.response;
        if (data.content) return data.content;
        if (data.result) return data.result;

        return JSON.stringify(data);
    } catch (err) {
        console.error('[Whispers] Extra API error:', err);
        throw err;
    }
}

async function generateViaSillyTavern(systemPrompt, history, userMessage) {
    const { generateRaw } = SillyTavern.getContext();

    // Build prompt from history
    let conversationStr = '';
    for (const msg of history) {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        conversationStr += `${role}: ${msg.content}\n`;
    }
    conversationStr += `User: ${userMessage}\nAssistant:`;

    const result = await generateRaw({
        systemPrompt: systemPrompt,
        prompt: conversationStr,
        prefill: '',
    });

    return result || '';
}

// ── UI Building ─────────────────────────────────────────────────

function buildSettingsHtml() {
    return `
    <div class="whispers-settings" id="whispers-settings-panel">
        <h3>
            <i class="fa-solid fa-ghost"></i>
            <span data-i18n="Whispers">Whispers</span>
        </h3>
        <div class="whispers-divider"></div>

        <!-- Assistant List -->
        <h4><i class="fa-solid fa-users"></i> Assistants</h4>
        <div class="whispers-assistant-list" id="whispers-assistant-list"></div>
        <div class="whispers-row">
            <button class="menu_button" id="whispers-btn-new" title="Create new assistant">
                <i class="fa-solid fa-plus"></i> New
            </button>
            <button class="menu_button" id="whispers-btn-import" title="Import from PNG">
                <i class="fa-solid fa-file-import"></i> Import
            </button>
        </div>
        <input type="file" accept=".png" class="whispers-hidden-input" id="whispers-import-file">

        <div class="whispers-divider"></div>

        <!-- Edit Section -->
        <div class="whispers-edit-section" id="whispers-edit-section" style="display:none;">
            <div class="whispers-edit-header" id="whispers-edit-toggle">
                <h4><i class="fa-solid fa-pen-to-square"></i> Edit Assistant</h4>
                <i class="fa-solid fa-chevron-down"></i>
            </div>
            <div class="whispers-edit-body" id="whispers-edit-body">
                <div class="whispers-avatar-upload">
                    <div class="whispers-avatar-preview-placeholder" id="whispers-edit-avatar" title="Click to set avatar">
                        <i class="fa-solid fa-image"></i>
                    </div>
                    <input type="file" accept="image/*" class="whispers-hidden-input" id="whispers-avatar-file">
                    <span style="font-size:0.8em;opacity:0.6;">Click to set avatar</span>
                </div>
                <div class="whispers-field-group">
                    <label><i class="fa-solid fa-signature"></i> Name</label>
                    <input type="text" id="whispers-edit-name" placeholder="Assistant name">
                </div>
                <div class="whispers-field-group">
                    <label><i class="fa-solid fa-masks-theater"></i> Character</label>
                    <textarea id="whispers-edit-character" placeholder="Describe the personality of the assistant..."></textarea>
                </div>
                <div class="whispers-field-group">
                    <label><i class="fa-solid fa-ban"></i> Bans</label>
                    <textarea id="whispers-edit-bans" placeholder="Things the assistant would never say..."></textarea>
                </div>
                <div class="whispers-row">
                    <button class="menu_button" id="whispers-btn-save">
                        <i class="fa-solid fa-floppy-disk"></i> Save
                    </button>
                    <button class="menu_button" id="whispers-btn-export" title="Export as PNG">
                        <i class="fa-solid fa-file-export"></i> Export PNG
                    </button>
                    <button class="menu_button whispers-btn-danger" id="whispers-btn-delete">
                        <i class="fa-solid fa-trash"></i> Delete
                    </button>
                </div>
            </div>
        </div>

        <div class="whispers-divider"></div>

        <!-- Binding -->
        <h4><i class="fa-solid fa-link"></i> Binding</h4>
        <div class="whispers-binding-section">
            <div class="whispers-field-group">
                <label>Scope</label>
                <select id="whispers-binding-scope">
                    <option value="global">Global (all chats)</option>
                    <option value="character">Per Character</option>
                    <option value="chat">This Chat Only</option>
                </select>
            </div>
            <button class="menu_button" id="whispers-btn-bind">
                <i class="fa-solid fa-link"></i> Bind Selected
            </button>
        </div>

        <div class="whispers-divider"></div>

        <!-- API Settings -->
        <h4><i class="fa-solid fa-server"></i> API Settings</h4>
        <div class="whispers-toggle-row">
            <label><i class="fa-solid fa-plug"></i> Use External API</label>
            <input type="checkbox" id="whispers-use-extra-api">
        </div>
        <div class="whispers-field-group" id="whispers-api-url-group">
            <label>API URL</label>
            <input type="url" id="whispers-api-url" placeholder="http://localhost:5001">
        </div>
        <div class="whispers-field-group">
            <label><i class="fa-solid fa-list-ol"></i> Message Limit (context)</label>
            <input type="number" id="whispers-msg-limit" min="1" max="100" value="20">
        </div>

        <div class="whispers-divider"></div>

        <!-- Prompt Template -->
        <h4><i class="fa-solid fa-scroll"></i> Prompt Template</h4>
        <div class="whispers-field-group">
            <textarea id="whispers-prompt-template" rows="6" placeholder="Main prompt template..."></textarea>
            <span style="font-size:0.75em;opacity:0.5;">
                Variables: {{name}}, {{character}}, {{bans}}, {{context}}
            </span>
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

// ── State ───────────────────────────────────────────────────────

let selectedAssistantId = null;
let isGenerating = false;

// ── UI Logic ────────────────────────────────────────────────────

function refreshAssistantList() {
    const settings = getSettings();
    const listEl = document.getElementById('whispers-assistant-list');
    if (!listEl) return;

    listEl.innerHTML = '';

    if (settings.assistants.length === 0) {
        listEl.innerHTML = '<div style="opacity:0.4;font-size:0.85em;text-align:center;padding:10px;">No assistants yet</div>';
        return;
    }

    for (const asst of settings.assistants) {
        const item = document.createElement('div');
        item.className = 'whispers-assistant-item' + (asst.id === selectedAssistantId ? ' active' : '');
        item.dataset.id = asst.id;

        const avatarHtml = asst.avatar
            ? `<img class="whispers-assistant-avatar" src="${asst.avatar}" alt="">`
            : `<div class="whispers-assistant-avatar-placeholder"><i class="fa-solid fa-ghost"></i></div>`;

        // Determine binding badge
        let badge = '';
        if (settings.globalAssistantId === asst.id) badge = '<i class="fa-solid fa-globe" title="Global" style="opacity:0.5;font-size:0.8em;"></i>';
        const charName = getCurrentCharName();
        if (charName && settings.characterBindings[charName] === asst.id) badge = '<i class="fa-solid fa-user" title="Bound to character" style="opacity:0.5;font-size:0.8em;"></i>';
        const meta = getChatMeta();
        if (meta && meta.whispers_assistant_id === asst.id) badge = '<i class="fa-solid fa-comment" title="Bound to chat" style="opacity:0.5;font-size:0.8em;"></i>';

        item.innerHTML = `${avatarHtml}<span class="whispers-assistant-name">${asst.name || 'Unnamed'}</span>${badge}`;

        item.addEventListener('click', () => {
            selectedAssistantId = asst.id;
            refreshAssistantList();
            loadAssistantEditor(asst);
        });

        listEl.appendChild(item);
    }
}

function loadAssistantEditor(assistant) {
    const section = document.getElementById('whispers-edit-section');
    if (!section) return;
    section.style.display = '';

    document.getElementById('whispers-edit-name').value = assistant.name || '';
    document.getElementById('whispers-edit-character').value = assistant.character || '';
    document.getElementById('whispers-edit-bans').value = assistant.bans || '';

    // Avatar
    const avatarEl = document.getElementById('whispers-edit-avatar');
    if (assistant.avatar) {
        avatarEl.innerHTML = `<img class="whispers-avatar-preview" src="${assistant.avatar}" alt="">`;
    } else {
        avatarEl.innerHTML = '<i class="fa-solid fa-image"></i>';
        avatarEl.className = 'whispers-avatar-preview-placeholder';
    }
}

function clearEditor() {
    const section = document.getElementById('whispers-edit-section');
    if (section) section.style.display = 'none';
    selectedAssistantId = null;
}

function loadSettingsUI() {
    const settings = getSettings();

    const urlInput = document.getElementById('whispers-api-url');
    if (urlInput) urlInput.value = settings.extraApiUrl || '';

    const limitInput = document.getElementById('whispers-msg-limit');
    if (limitInput) limitInput.value = settings.messageLimit || 20;

    const extraCheck = document.getElementById('whispers-use-extra-api');
    if (extraCheck) {
        extraCheck.checked = settings.useExtraApi || false;
        toggleApiUrlVisibility(settings.useExtraApi);
    }

    const promptInput = document.getElementById('whispers-prompt-template');
    if (promptInput) promptInput.value = settings.mainPromptTemplate || defaultSettings.mainPromptTemplate;

    refreshAssistantList();
}

function toggleApiUrlVisibility(show) {
    const group = document.getElementById('whispers-api-url-group');
    if (group) group.style.display = show ? '' : 'none';
}

// ── Chat UI ─────────────────────────────────────────────────────

function renderChatMessages() {
    const messagesEl = document.getElementById('whispers-messages');
    const emptyEl = document.getElementById('whispers-empty-state');
    if (!messagesEl) return;

    const history = getWhispersHistory();

    // Remove existing messages (keep empty state)
    const existing = messagesEl.querySelectorAll('.whispers-msg, .whispers-typing');
    existing.forEach(el => el.remove());

    if (history.length === 0) {
        if (emptyEl) emptyEl.style.display = '';
        return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    for (const msg of history) {
        const bubble = document.createElement('div');
        bubble.className = `whispers-msg whispers-msg-${msg.role}`;
        const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        bubble.innerHTML = `${escapeHtml(msg.content)}<span class="whispers-msg-time">${time}</span>`;
        messagesEl.appendChild(bubble);
    }

    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessageBubble(role, content) {
    const messagesEl = document.getElementById('whispers-messages');
    const emptyEl = document.getElementById('whispers-empty-state');
    if (!messagesEl) return;

    if (emptyEl) emptyEl.style.display = 'none';

    const bubble = document.createElement('div');
    bubble.className = `whispers-msg whispers-msg-${role}`;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    bubble.innerHTML = `${escapeHtml(content)}<span class="whispers-msg-time">${time}</span>`;
    messagesEl.appendChild(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showTypingIndicator() {
    const messagesEl = document.getElementById('whispers-messages');
    if (!messagesEl) return;

    removeTypingIndicator();

    const typing = document.createElement('div');
    typing.className = 'whispers-typing';
    typing.id = 'whispers-typing-indicator';
    typing.innerHTML = '<div class="whispers-typing-dot"></div><div class="whispers-typing-dot"></div><div class="whispers-typing-dot"></div>';
    messagesEl.appendChild(typing);
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function removeTypingIndicator() {
    const el = document.getElementById('whispers-typing-indicator');
    if (el) el.remove();
}

function updateChatHeader() {
    const assistant = getActiveAssistant();
    const nameEl = document.getElementById('whispers-chat-name');
    const avatarEl = document.getElementById('whispers-chat-avatar');
    const statusEl = document.getElementById('whispers-chat-status');

    if (assistant) {
        if (nameEl) nameEl.textContent = assistant.name || 'Assistant';
        if (statusEl) statusEl.textContent = 'Online';
        if (avatarEl) {
            if (assistant.avatar) {
                avatarEl.innerHTML = `<img class="whispers-chat-header-avatar" src="${assistant.avatar}" alt="">`;
                avatarEl.className = '';
            } else {
                avatarEl.innerHTML = '<i class="fa-solid fa-ghost"></i>';
                avatarEl.className = 'whispers-chat-header-avatar-placeholder';
            }
        }
    } else {
        if (nameEl) nameEl.textContent = 'Whispers';
        if (statusEl) statusEl.textContent = 'No assistant configured';
        if (avatarEl) {
            avatarEl.innerHTML = '<i class="fa-solid fa-ghost"></i>';
            avatarEl.className = 'whispers-chat-header-avatar-placeholder';
        }
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function openChat() {
    const overlay = document.getElementById('whispers-overlay');
    if (overlay) {
        overlay.classList.add('open');
        updateChatHeader();
        renderChatMessages();
        const input = document.getElementById('whispers-input');
        if (input) setTimeout(() => input.focus(), 350);
    }
}

function closeChat() {
    const overlay = document.getElementById('whispers-overlay');
    if (overlay) overlay.classList.remove('open');
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
    if (!assistant) {
        toastr.warning('No assistant configured. Create one in the Whispers settings.');
        return;
    }

    // Add user message
    const history = getWhispersHistory();
    history.push({
        role: 'user',
        content: text,
        timestamp: Date.now(),
    });
    await saveChatMeta();

    input.value = '';
    autoResizeInput();
    addMessageBubble('user', text);
    showTypingIndicator();

    isGenerating = true;
    if (sendBtn) sendBtn.disabled = true;

    const statusEl = document.getElementById('whispers-chat-status');
    if (statusEl) statusEl.textContent = 'Typing...';

    try {
        const response = await generateResponse(text);
        removeTypingIndicator();

        // Add assistant message
        history.push({
            role: 'assistant',
            content: response,
            timestamp: Date.now(),
        });
        await saveChatMeta();

        addMessageBubble('assistant', response);
    } catch (err) {
        removeTypingIndicator();
        toastr.error(`Whispers error: ${err.message}`);
        addMessageBubble('assistant', `Error: ${err.message}`);
    } finally {
        isGenerating = false;
        if (sendBtn) sendBtn.disabled = false;
        if (statusEl) statusEl.textContent = 'Online';
    }
}

// ── Auto-resize textarea ────────────────────────────────────────

function autoResizeInput() {
    const input = document.getElementById('whispers-input');
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}

// ── Event Handlers ──────────────────────────────────────────────

function bindEvents() {
    // Chat bar button
    document.getElementById('whispers-chat-btn')?.addEventListener('click', openChat);

    // Close overlay
    document.getElementById('whispers-chat-close')?.addEventListener('click', closeChat);
    document.getElementById('whispers-overlay')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeChat();
    });

    // Send message
    document.getElementById('whispers-send')?.addEventListener('click', sendMessage);
    document.getElementById('whispers-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
    document.getElementById('whispers-input')?.addEventListener('input', autoResizeInput);

    // Clear history
    document.getElementById('whispers-chat-clear')?.addEventListener('click', async () => {
        const meta = getChatMeta();
        if (meta) {
            meta.whispers_history = [];
            await saveChatMeta();
        }
        renderChatMessages();
    });

    // New assistant
    document.getElementById('whispers-btn-new')?.addEventListener('click', () => {
        const settings = getSettings();
        const newAssistant = {
            id: generateId(),
            name: 'New Assistant',
            character: '',
            bans: '',
            avatar: null,
        };
        settings.assistants.push(newAssistant);
        saveSettings();
        selectedAssistantId = newAssistant.id;
        refreshAssistantList();
        loadAssistantEditor(newAssistant);
    });

    // Save assistant
    document.getElementById('whispers-btn-save')?.addEventListener('click', () => {
        if (!selectedAssistantId) return;
        const settings = getSettings();
        const asst = settings.assistants.find(a => a.id === selectedAssistantId);
        if (!asst) return;

        asst.name = document.getElementById('whispers-edit-name')?.value || 'Unnamed';
        asst.character = document.getElementById('whispers-edit-character')?.value || '';
        asst.bans = document.getElementById('whispers-edit-bans')?.value || '';

        saveSettings();
        refreshAssistantList();
        updateChatHeader();
        toastr.success('Assistant saved');
    });

    // Delete assistant
    document.getElementById('whispers-btn-delete')?.addEventListener('click', () => {
        if (!selectedAssistantId) return;
        const settings = getSettings();
        settings.assistants = settings.assistants.filter(a => a.id !== selectedAssistantId);

        // Clean up bindings
        if (settings.globalAssistantId === selectedAssistantId) settings.globalAssistantId = '';
        for (const key of Object.keys(settings.characterBindings)) {
            if (settings.characterBindings[key] === selectedAssistantId) delete settings.characterBindings[key];
        }

        saveSettings();
        clearEditor();
        refreshAssistantList();
        updateChatHeader();
        toastr.info('Assistant deleted');
    });

    // Export PNG
    document.getElementById('whispers-btn-export')?.addEventListener('click', () => {
        if (!selectedAssistantId) return;
        const settings = getSettings();
        const asst = settings.assistants.find(a => a.id === selectedAssistantId);
        if (asst) exportAssistantToPng(asst);
    });

    // Import PNG
    document.getElementById('whispers-btn-import')?.addEventListener('click', () => {
        document.getElementById('whispers-import-file')?.click();
    });

    document.getElementById('whispers-import-file')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const assistant = await importAssistantFromPng(file);
        if (assistant) {
            const settings = getSettings();
            settings.assistants.push(assistant);
            saveSettings();
            selectedAssistantId = assistant.id;
            refreshAssistantList();
            loadAssistantEditor(assistant);
            toastr.success(`Imported: ${assistant.name}`);
        }
        e.target.value = '';
    });

    // Avatar upload
    document.getElementById('whispers-edit-avatar')?.addEventListener('click', () => {
        document.getElementById('whispers-avatar-file')?.click();
    });

    document.getElementById('whispers-avatar-file')?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (!file || !selectedAssistantId) return;

        const reader = new FileReader();
        reader.onload = (ev) => {
            const settings = getSettings();
            const asst = settings.assistants.find(a => a.id === selectedAssistantId);
            if (asst) {
                asst.avatar = ev.target.result;
                saveSettings();
                loadAssistantEditor(asst);
                refreshAssistantList();
            }
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    });

    // Binding
    document.getElementById('whispers-btn-bind')?.addEventListener('click', async () => {
        if (!selectedAssistantId) {
            toastr.warning('Select an assistant first');
            return;
        }

        const settings = getSettings();
        const scope = document.getElementById('whispers-binding-scope')?.value;

        if (scope === 'global') {
            settings.globalAssistantId = selectedAssistantId;
            saveSettings();
            toastr.success('Set as global assistant');
        } else if (scope === 'character') {
            const charName = getCurrentCharName();
            if (!charName) {
                toastr.warning('No character selected');
                return;
            }
            settings.characterBindings[charName] = selectedAssistantId;
            saveSettings();
            toastr.success(`Bound to character: ${charName}`);
        } else if (scope === 'chat') {
            const meta = getChatMeta();
            if (!meta) {
                toastr.warning('No active chat');
                return;
            }
            meta.whispers_assistant_id = selectedAssistantId;
            await saveChatMeta();
            toastr.success('Bound to this chat');
        }

        refreshAssistantList();
        updateChatHeader();
    });

    // API settings
    document.getElementById('whispers-use-extra-api')?.addEventListener('change', (e) => {
        const settings = getSettings();
        settings.useExtraApi = e.target.checked;
        saveSettings();
        toggleApiUrlVisibility(e.target.checked);
    });

    document.getElementById('whispers-api-url')?.addEventListener('input', (e) => {
        const settings = getSettings();
        settings.extraApiUrl = e.target.value;
        saveSettings();
    });

    document.getElementById('whispers-msg-limit')?.addEventListener('input', (e) => {
        const settings = getSettings();
        settings.messageLimit = parseInt(e.target.value, 10) || 20;
        saveSettings();
    });

    document.getElementById('whispers-prompt-template')?.addEventListener('input', (e) => {
        const settings = getSettings();
        settings.mainPromptTemplate = e.target.value;
        saveSettings();
    });

    // Edit section toggle
    document.getElementById('whispers-edit-toggle')?.addEventListener('click', () => {
        const section = document.getElementById('whispers-edit-section');
        if (section) section.classList.toggle('collapsed');
    });
}

// ── Init ────────────────────────────────────────────────────────

(function init() {
    const context = SillyTavern.getContext();
    const { eventSource, event_types } = context;

    // Inject settings panel into extensions menu
    const settingsContainer = document.getElementById('extensions_settings2');
    if (settingsContainer) {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = buildSettingsHtml();
        settingsContainer.appendChild(wrapper);
    }

    // Inject chat overlay
    document.body.insertAdjacentHTML('beforeend', buildChatOverlayHtml());

    // Inject chat bar button
    const formSheld = document.getElementById('form_sheld');
    if (formSheld) {
        const sendForm = formSheld.querySelector('#send_form');
        if (sendForm) {
            sendForm.insertAdjacentHTML('afterbegin', buildChatBarButton());
        } else {
            formSheld.insertAdjacentHTML('afterbegin', buildChatBarButton());
        }
    }

    // Bind events
    bindEvents();

    // Load settings
    loadSettingsUI();

    // Listen for chat changes
    eventSource.on(event_types.CHAT_CHANGED, () => {
        updateChatHeader();
        renderChatMessages();
        refreshAssistantList();
    });

    console.log('[Whispers] Extension loaded');
})();
