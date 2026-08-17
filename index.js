import {
    buildInjection,
    detectPatterns,
    fingerprintMessages,
    mergePatterns,
    normalizeSmartPattern,
    splitDialogueAndNarration,
    stripNonProse,
} from './detector.js';

const MODULE_NAME = 'ttotto';
const EXTENSION_PATH = 'third-party/ttotto';
const PROMPT_KEY = 'ttotto_anti_repetition';
const CHAT_STATE_KEY = 'ttotto';
const LOG_PREFIX = '[🌀또또]';
const EXTENSION_VERSION = '1.4.0';
const ALLOWED_GENERATION_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);
// SillyTavern's stable setExtensionPrompt values: IN_CHAT = 1, SYSTEM = 0.
// Using getContext() plus these primitive values avoids a fragile direct import from script.js.
const PROMPT_POSITION_IN_CHAT = 1;
const PROMPT_ROLE_SYSTEM = 0;

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    windowSize: 20,
    sensitivity: 'normal',
    narrationEnabled: true,
    dialogueEnabled: true,
    smartAnalysis: false,
    smartInterval: 3,
    smartProfileId: '',
    smartMaxTokens: 900,
    maxInjectedPatterns: 6,
    sourceMode: 'original',
    characterUuids: {},
    characterAllowances: {},
    characterBans: {},
    characterHistory: {},
    crossChatMemoryEnabled: false,
    excludeAllTaggedBlocks: true,
    excludedTags: '',
    excludedClasses: '',
});
const EMPTY_ANALYSIS = Object.freeze({
    fingerprint: '', messageFingerprint: '', messages: [], localPatterns: [], smartPatterns: [],
    permanentPatterns: [], patterns: [], prompt: '',
});

let analysisCache = null;
let uiReady = false;
let analysisTimer = null;
let smartTimer = null;
let sourceMutationTimer = null;
let pendingSourceMutationPayload = null;
let smartRunning = false;
let smartAbortController = null;
let smartForcePending = false;
let forceSmartOnNextAnalysis = false;
let runtimeActive = true;
let eventsRegistered = false;
let popupOpen = false;
let settingsHomeParent = null;
const registeredEventHandlers = [];

function getContext() {
    return SillyTavern.getContext();
}

function getEventTypes(context = getContext()) {
    return context.eventTypes ?? context.event_types ?? {};
}

function getSettings() {
    const context = getContext();
    const current = context.extensionSettings[MODULE_NAME];
    context.extensionSettings[MODULE_NAME] = {
        ...structuredClone(DEFAULT_SETTINGS),
        ...(current && typeof current === 'object' ? current : {}),
    };
    const settings = context.extensionSettings[MODULE_NAME];
    settings.sourceMode = 'original';
    settings.characterUuids = settings.characterUuids && typeof settings.characterUuids === 'object'
        ? settings.characterUuids
        : {};
    settings.characterAllowances = settings.characterAllowances && typeof settings.characterAllowances === 'object'
        ? settings.characterAllowances
        : {};
    settings.characterBans = settings.characterBans && typeof settings.characterBans === 'object'
        ? settings.characterBans
        : {};
    settings.characterHistory = settings.characterHistory && typeof settings.characterHistory === 'object'
        ? settings.characterHistory
        : {};
    settings.excludedTags = String(settings.excludedTags ?? '');
    settings.excludedClasses = String(settings.excludedClasses ?? '');
    settings.excludeAllTaggedBlocks = settings.excludeAllTaggedBlocks !== false;
    return settings;
}

function saveSettings() {
    getContext().saveSettingsDebounced();
}

function createDefaultChatState() {
    return {
        version: 4,
        enabled: true,
        skipNextGeneration: false,
        lastBanHits: [],
        ignoredKeys: [],
        ignoredPatterns: [],
        smart: {
            fingerprint: '',
            messageKeys: [],
            patterns: [],
            lastAssistantCount: 0,
            lastAssistantTotal: 0,
            lastRunAt: 0,
            error: '',
            stale: false,
        },
    };
}

function getChatState(create = true) {
    const context = getContext();
    if (!context.chatId && !context.groupId && context.characterId === undefined) return null;
    const metadata = context.chatMetadata;
    if (!metadata || typeof metadata !== 'object') return null;
    if (!metadata[CHAT_STATE_KEY] && create) metadata[CHAT_STATE_KEY] = createDefaultChatState();
    const state = metadata[CHAT_STATE_KEY];
    if (!state || typeof state !== 'object') return null;
    state.version = 4;
    state.enabled ??= true;
    state.skipNextGeneration = Boolean(state.skipNextGeneration);
    state.lastBanHits = Array.isArray(state.lastBanHits) ? state.lastBanHits.slice(0, 20) : [];
    state.ignoredKeys = Array.isArray(state.ignoredKeys) ? state.ignoredKeys : [];
    state.ignoredPatterns = Array.isArray(state.ignoredPatterns) ? state.ignoredPatterns : [];
    state.smart = {
        ...createDefaultChatState().smart,
        ...(state.smart && typeof state.smart === 'object' ? state.smart : {}),
    };
    state.smart.patterns = Array.isArray(state.smart.patterns) ? state.smart.patterns : [];
    state.smart.messageKeys = Array.isArray(state.smart.messageKeys) ? state.smart.messageKeys : [];
    for (const [index, rawPattern] of state.smart.patterns.entries()) {
        const pattern = normalizeSmartPattern(rawPattern, index);
        if (!pattern || !state.ignoredKeys.includes(pattern.key)) continue;
        if (!state.ignoredPatterns.some((ignored) => ignored?.key === pattern.key)) {
            state.ignoredPatterns.push(ignoredDescriptor(pattern));
        }
    }
    state.ignoredPatterns = state.ignoredPatterns.slice(-200);
    return state;
}

function saveChatState() {
    const context = getContext();
    if (typeof context.saveMetadataDebounced === 'function') {
        context.saveMetadataDebounced();
    } else if (typeof context.saveMetadata === 'function') {
        void context.saveMetadata();
    }
}

function saveCapturedOriginal() {
    const context = getContext();
    try {
        if (typeof context.saveChatConditional === 'function') void context.saveChatConditional();
        else if (typeof context.saveChat === 'function') void context.saveChat();
    } catch (error) {
        console.debug(`${LOG_PREFIX} 원문 메타데이터 저장을 건너뜁니다.`, error);
    }
}

function captureOriginalFromEvent(payload) {
    const context = getContext();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    let message = payload && typeof payload === 'object' && typeof payload.mes === 'string' ? payload : null;
    const index = Number(payload);
    if (!message && Number.isInteger(index) && index >= 0) message = chat[index];
    if (!message) message = [...chat].reverse().find((item) => item && !item.is_user && !item.is_system);
    const changed = preserveOriginalMessageText(message);
    if (changed) saveCapturedOriginal();
    return { message, changed };
}

function updateBanHitsForMessage(message) {
    const state = getChatState(false);
    if (!state) return;
    if (!message || message.is_user || message.is_system) {
        state.lastBanHits = [];
        saveChatState();
        return;
    }
    const identity = resolveCharacterIdentity(message);
    const text = messageText(message).normalize('NFKC').toLocaleLowerCase();
    state.lastBanHits = getCharacterBans(identity?.uuid, false)
        .filter((ban) => ban.type === 'term' && cleanBanTerm(ban.term))
        .filter((ban) => text.includes(cleanBanTerm(ban.term).toLocaleLowerCase()))
        .map((ban) => ({ term: cleanBanTerm(ban.term), characterUuid: identity.uuid }))
        .slice(0, 20);
    saveChatState();
}

function getChatIdentity(context = getContext()) {
    if (context.groupId !== undefined && context.groupId !== null && context.groupId !== '') {
        return `group:${context.groupId}:chat:${context.chatId ?? ''}`;
    }
    return `character:${context.characterId ?? ''}:chat:${context.chatId ?? ''}`;
}

function readNestedString(value, path) {
    let current = value;
    for (const key of path) {
        if (!current || typeof current !== 'object') return '';
        current = current[key];
    }
    return typeof current === 'string' ? current.trim() : '';
}

function activeSwipeMetadata(message) {
    const swipeId = Number(message?.swipe_id);
    if (!Number.isInteger(swipeId) || !Array.isArray(message?.swipe_info)) return null;
    return message.swipe_info[swipeId] ?? null;
}

export function findStoredOriginal(message) {
    // Feather keeps the real SillyTavern source in the active swipe / mes and puts
    // the Korean rendering only in extra.display_text. Always trust the canonical
    // SillyTavern source first and never inspect display_text.
    const activeSwipeId = Number(message?.swipe_id) || 0;
    const activeSwipe = Array.isArray(message?.swipes) ? message.swipes[activeSwipeId] : '';
    const sillySource = typeof activeSwipe === 'string' && activeSwipe.trim()
        ? activeSwipe.trim()
        : typeof message?.mes === 'string' ? message.mes.trim() : '';
    if (sillySource.length >= 8) return sillySource;

    const swipeMetadata = activeSwipeMetadata(message);
    const storedSwipeId = Number(message?.extra?.ttotto_source_swipe_id);
    const messageSourceMatchesSwipe = !Number.isInteger(storedSwipeId) || storedSwipeId === activeSwipeId;
    const featherRecord = message?.extra?.feather_translations?.[String(activeSwipeId)];
    const featherSources = [
        typeof featherRecord?.source === 'string' ? featherRecord.source.trim() : '',
        typeof message?.extra?.feather_active?.source === 'string' ? message.extra.feather_active.source.trim() : '',
    ];
    for (const candidate of featherSources) {
        if (candidate.length >= 8) return candidate;
    }

    const sources = [swipeMetadata, message];
    const paths = [
        ['extra', 'ttotto_source_text'],
        ['extra', 'original_text'],
        ['extra', 'original_mes'],
        ['extra', 'originalMessage'],
        ['extra', 'source_text'],
        ['extra', 'translation', 'original'],
        ['extra', 'translator', 'original'],
        ['extra', 'feather', 'original'],
        ['extra', 'featherTranslator', 'original'],
        ['extra', 'feather_original'],
        ['extra', 'featherOriginal'],
    ];

    for (const source of sources) {
        for (const path of paths) {
            if (source === message && path[1] === 'ttotto_source_text' && !messageSourceMatchesSwipe) continue;
            const candidate = readNestedString(source, path);
            if (candidate.length >= 8) return candidate;
        }
    }
    return '';
}

export function preserveOriginalMessageText(message) {
    if (!message || typeof message !== 'object') return false;
    const swipeId = Number(message.swipe_id) || 0;
    const activeSwipe = Array.isArray(message.swipes) ? message.swipes[swipeId] : '';
    const text = typeof activeSwipe === 'string' && activeSwipe.trim()
        ? activeSwipe.trim()
        : typeof message.mes === 'string' ? message.mes.trim() : '';
    if (text.length < 8) return false;
    const swipeMetadata = activeSwipeMetadata(message);
    let changed = false;
    if (swipeMetadata) {
        swipeMetadata.extra = swipeMetadata.extra && typeof swipeMetadata.extra === 'object' ? swipeMetadata.extra : {};
        if (swipeMetadata.extra.ttotto_source_text !== text) {
            swipeMetadata.extra.ttotto_source_text = text;
            changed = true;
        }
    }
    message.extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
    if (message.extra.ttotto_source_text !== text || Number(message.extra.ttotto_source_swipe_id) !== swipeId) {
        message.extra.ttotto_source_text = text;
        message.extra.ttotto_source_swipe_id = swipeId;
        changed = true;
    }
    return changed;
}

function messageText(message) {
    return findStoredOriginal(message);
}

function normalizeAvatarKey(value) {
    const clean = String(value ?? '').trim().replace(/[?#].*$/, '');
    if (!clean) return '';
    try {
        const decoded = decodeURIComponent(clean);
        return decoded.split('/').filter(Boolean).at(-1) ?? decoded;
    } catch {
        return clean.split('/').filter(Boolean).at(-1) ?? clean;
    }
}

function newCharacterUuid() {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    return `ttotto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function ensureCharacterUuid(settings, avatarKey, uuidFactory = newCharacterUuid) {
    const key = normalizeAvatarKey(avatarKey);
    if (!key) return '';
    settings.characterUuids = settings.characterUuids && typeof settings.characterUuids === 'object'
        ? settings.characterUuids
        : {};
    if (!settings.characterUuids[key]) settings.characterUuids[key] = uuidFactory();
    return String(settings.characterUuids[key]);
}

function characterAvatarCandidates(message) {
    return [
        message?.original_avatar,
        message?.force_avatar,
        message?.avatar,
        message?.extra?.avatar,
        message?.extra?.character_avatar,
    ].map(normalizeAvatarKey).filter(Boolean);
}

export function resolveCharacterAvatarKey(message, context) {
    const characters = Array.isArray(context?.characters) ? context.characters : [];
    const characterByAvatar = (avatar) => characters.find((character) => normalizeAvatarKey(character?.avatar) === avatar);

    for (const avatar of characterAvatarCandidates(message)) {
        const character = characterByAvatar(avatar);
        if (character) return normalizeAvatarKey(character.avatar);
    }

    const isGroup = context?.groupId !== undefined && context?.groupId !== null && context?.groupId !== '';
    if (!isGroup) {
        const active = characters[Number(context?.characterId)];
        return normalizeAvatarKey(active?.avatar);
    }

    const speaker = String(message?.name ?? '').trim();
    const matches = characters.filter((character) => String(character?.name ?? '').trim() === speaker);
    if (matches.length === 1) return normalizeAvatarKey(matches[0].avatar);
    return '';
}

function resolveCharacterIdentity(message, context = getContext(), settings = getSettings()) {
    const avatarKey = resolveCharacterAvatarKey(message, context);
    if (!avatarKey) return null;
    const existed = Boolean(settings.characterUuids?.[avatarKey]);
    const uuid = ensureCharacterUuid(settings, avatarKey);
    if (!existed && uuid) saveSettings();
    return { uuid, avatarKey };
}

export function currentChatCharacterUuids() {
    const context = getContext();
    const settings = getSettings();
    const avatarKeys = new Set();
    const characters = Array.isArray(context.characters) ? context.characters : [];
    const isGroup = context.groupId !== undefined && context.groupId !== null && context.groupId !== '';

    if (isGroup && Array.isArray(context.groups)) {
        const group = context.groups.find((item) => String(item?.id) === String(context.groupId));
        for (const avatar of group?.members ?? []) {
            const key = normalizeAvatarKey(avatar);
            if (key) avatarKeys.add(key);
        }
    } else {
        const active = characters[Number(context.characterId)];
        const key = normalizeAvatarKey(active?.avatar);
        if (key) avatarKeys.add(key);
    }

    // Normally the active solo card or the group's member list is authoritative.
    // Only fall back to a few recent messages when that metadata is unavailable;
    // scanning a 1,000+ message chat here made every UI refresh unnecessarily costly.
    if (!avatarKeys.size) {
        const chat = Array.isArray(context.chat) ? context.chat : [];
        for (let index = chat.length - 1, checked = 0; index >= 0 && checked < 50; index -= 1) {
            const message = chat[index];
            if (!message || message.is_user || message.is_system) continue;
            checked += 1;
            const key = resolveCharacterAvatarKey(message, context);
            if (key) avatarKeys.add(key);
        }
    }

    let settingsChanged = false;
    const uuids = [];
    for (const avatarKey of avatarKeys) {
        const existed = Boolean(settings.characterUuids?.[avatarKey]);
        const uuid = ensureCharacterUuid(settings, avatarKey);
        if (uuid) uuids.push(uuid);
        if (!existed && uuid) settingsChanged = true;
    }
    if (settingsChanged) saveSettings();
    return [...new Set(uuids)];
}

function currentCharacterOptions() {
    const context = getContext();
    const settings = getSettings();
    const characters = Array.isArray(context.characters) ? context.characters : [];
    const active = new Set(currentChatCharacterUuids());
    return characters.map((character) => {
        const avatarKey = normalizeAvatarKey(character?.avatar);
        const uuid = avatarKey ? ensureCharacterUuid(settings, avatarKey) : '';
        return uuid && active.has(uuid) ? {
            uuid,
            name: String(character?.name || '이름 없는 캐릭터'),
            avatarKey,
            label: `${String(character?.name || '이름 없는 캐릭터')} · ${avatarKey || uuid.slice(0, 8)}`,
        } : null;
    }).filter(Boolean).filter((item, index, all) => all.findIndex((other) => other.uuid === item.uuid) === index);
}

function cleanBanTerm(value) {
    const clean = String(value ?? '')
        .normalize('NFKC')
        .replace(/[<>\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return clean.length >= 1 && clean.length <= 80 ? clean : '';
}

function getCharacterBans(characterUuid, create = true) {
    const uuid = String(characterUuid ?? '');
    if (!uuid) return [];
    const settings = getSettings();
    if (!Array.isArray(settings.characterBans[uuid]) && create) settings.characterBans[uuid] = [];
    return Array.isArray(settings.characterBans[uuid]) ? settings.characterBans[uuid] : [];
}

function stableLocalId(value) {
    let hash = 0x811c9dc5;
    for (const character of String(value)) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

function addManualBan(characterUuid, rawTerm) {
    const term = cleanBanTerm(rawTerm);
    if (!term) return { ok: false, reason: '금지어는 1~80자로 입력해 주세요.' };
    const bans = getCharacterBans(characterUuid);
    if (bans.some((ban) => ban.type === 'term' && String(ban.term).toLocaleLowerCase() === term.toLocaleLowerCase())) {
        return { ok: false, reason: '이미 등록된 금지어예요.' };
    }
    if (bans.length >= 100) return { ok: false, reason: '한 캐릭터에는 최대 100개까지 저장할 수 있어요.' };
    bans.push({
        id: `term-${stableLocalId(`${term}|${Date.now()}`)}`,
        type: 'term',
        term,
        label: `금지어: ${term}`,
        characterUuid,
        createdAt: Date.now(),
    });
    saveSettings();
    return { ok: true };
}

function pinPattern(pattern) {
    const uuid = String(pattern?.characterUuid ?? '');
    const bans = getCharacterBans(uuid);
    if (!uuid) return false;
    if (bans.some((ban) => ban.type === 'pattern' && ban.key === pattern.key)) return true;
    if (bans.length >= 100) return false;
    bans.push({
        id: `pattern-${stableLocalId(`${pattern.key}|${Date.now()}`)}`,
        type: 'pattern',
        key: String(pattern.key ?? ''),
        label: String(pattern.label ?? '영구 금지 패턴').slice(0, 100),
        instruction: String(pattern.instruction ?? '').slice(0, 500),
        scope: pattern.scope === 'dialogue' ? 'dialogue' : 'narration',
        speaker: String(pattern.speaker ?? '').slice(0, 80),
        examples: (pattern.examples ?? [pattern.example]).filter(Boolean).map(String).slice(0, 3),
        characterUuid: uuid,
        createdAt: Date.now(),
    });
    saveSettings();
    return true;
}

function removePermanentBan(characterUuid, id) {
    const settings = getSettings();
    const bans = getCharacterBans(characterUuid, false);
    settings.characterBans[characterUuid] = bans.filter((ban) => ban?.id !== id);
    saveSettings();
}

function permanentPatternsForUuids(uuids) {
    return uuids.flatMap((uuid) => getCharacterBans(uuid, false).map((ban, index) => {
        const isTerm = ban.type === 'term';
        const term = cleanBanTerm(ban.term);
        if (isTerm && !term) return null;
        const instruction = isTerm
            ? `Never use or refer to the banned expression ${JSON.stringify(term)} anywhere in this character's narration or dialogue, including trivial inflections, spacing variants, or close paraphrases that name the same concept. Do not mention or discuss this ban.`
            : String(ban.instruction ?? '').trim();
        if (!instruction) return null;
        return {
            id: `pinned-${uuid}-${ban.id ?? index}`,
            banId: ban.id ?? String(index),
            key: `pinned|${uuid}|${ban.id ?? index}`,
            source: 'pinned',
            kind: isTerm ? 'permanent-term' : 'permanent-pattern',
            scope: ban.scope === 'dialogue' ? 'dialogue' : 'narration',
            characterUuid: uuid,
            speaker: String(ban.speaker ?? ''),
            label: isTerm ? `영구 금지어 · ${term}` : `영구 금지 · ${ban.label}`,
            example: isTerm ? term : String(ban.examples?.[0] ?? ''),
            examples: isTerm ? [term] : (ban.examples ?? []).map(String).slice(0, 3),
            count: 0,
            occurrences: 0,
            confidence: 1,
            score: 10000 - index,
            instruction,
        };
    }).filter(Boolean));
}

function messageKey(message, index, text) {
    const stableId = message?.extra?.message_id
        ?? message?.extra?.id
        ?? message?.send_date
        ?? `${index}`;
    return `${getChatIdentity()}:${stableId}:${Number(message?.swipe_id) || 0}:${fingerprintMessages([{ id: stableId, speaker: message?.name ?? '', text }])}`;
}

function messageMemorySlot(message, index) {
    const stableId = message?.extra?.message_id
        ?? message?.extra?.id
        ?? message?.send_date
        ?? `${index}`;
    return `${getChatIdentity()}:${stableId}:${Number(message?.swipe_id) || 0}`;
}

function collectCurrentAssistantMessages(limit = Number.POSITIVE_INFINITY) {
    const context = getContext();
    const settings = getSettings();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const candidates = [];

    const maxMessages = Number.isFinite(limit) ? Math.max(1, Number(limit) || 1) : Number.POSITIVE_INFINITY;
    for (let index = chat.length - 1; index >= 0 && candidates.length < maxMessages; index -= 1) {
        const message = chat[index];
        if (!message || message.is_user || message.is_system || typeof message.mes !== 'string') continue;
        if (message.extra?.type === 'narrator' || message.extra?.type === 'system') continue;
        const text = messageText(message).trim();
        if (text.length < 8) continue;
        const identity = resolveCharacterIdentity(message, context, settings);
        if (!identity?.uuid) continue;
        const speaker = String(message.name || context.name2 || 'Character');
        const key = messageKey(message, index, text);
        candidates.push({
            id: key,
            key,
            memorySlot: messageMemorySlot(message, index),
            speaker,
            characterUuid: identity.uuid,
            characterAvatarKey: identity.avatarKey,
            text,
            chatIndex: index,
            chatIdentity: getChatIdentity(context),
            fromMemory: false,
            capturedAt: Number(new Date(message.send_date).getTime()) || Date.now() + index,
        });
    }

    return candidates.reverse();
}

function rememberCurrentMessages(messages) {
    const settings = getSettings();
    if (!settings.crossChatMemoryEnabled) return;
    let changed = false;
    for (const message of messages) {
        const uuid = message.characterUuid;
        // Store only the prose the detector would actually analyze: the same
        // exclusion rules (info panels, tag/HTML blocks, custom tags/classes)
        // are applied before the text is persisted, so settings.json never
        // carries decorative HTML that every later analysis would strip again
        // anyway. No length limit is applied to the stored prose.
        const storedText = stripNonProse(message.text, settings, { clip: false });
        if (storedText.length < 8) continue;
        const history = Array.isArray(settings.characterHistory[uuid]) ? settings.characterHistory[uuid] : [];
        const record = {
            id: message.id,
            key: message.key,
            memorySlot: message.memorySlot,
            speaker: message.speaker,
            characterUuid: uuid,
            characterAvatarKey: message.characterAvatarKey,
            text: storedText,
            chatIdentity: message.chatIdentity,
            capturedAt: Number(message.capturedAt) || Date.now(),
        };
        const existing = history.findIndex((item) => (item?.memorySlot && item.memorySlot === record.memorySlot) || item?.key === record.key);
        if (existing >= 0) {
            if (history[existing]?.key !== record.key || history[existing]?.text !== record.text) changed = true;
            history[existing] = { ...history[existing], ...record };
        }
        else {
            history.push(record);
            changed = true;
        }
        settings.characterHistory[uuid] = history.slice(-50);
    }
    if (changed) saveSettings();
}

export function migrateStoredMemoryOnce() {
    // One-time cleanup for memories saved before v1.3.3, which stored the raw
    // message text including decorative HTML blocks. Re-strips them with the
    // current exclusion settings and drops entries that were decoration only.
    const settings = getSettings();
    if (Number(settings.memoryStripVersion) >= 1) return;
    for (const [uuid, history] of Object.entries(settings.characterHistory)) {
        settings.characterHistory[uuid] = (Array.isArray(history) ? history : [])
            .map((item) => ({ ...item, text: stripNonProse(String(item?.text ?? ''), settings, { clip: false }) }))
            .filter((item) => item.text.length >= 8)
            .slice(-50);
    }
    settings.memoryStripVersion = 1;
    saveSettings();
}

export function collectAssistantMessages({ applyWindow = true, includeMemory = true } = {}) {
    const settings = getSettings();
    const windowSize = Math.max(5, Number(settings.windowSize) || DEFAULT_SETTINGS.windowSize);
    const currentLimit = applyWindow
        ? settings.crossChatMemoryEnabled ? Math.max(windowSize, 50) : windowSize
        : Number.POSITIVE_INFINITY;
    const current = collectCurrentAssistantMessages(currentLimit);
    rememberCurrentMessages(current);
    let candidates = current;
    if (includeMemory && settings.crossChatMemoryEnabled) {
        const activeUuids = new Set(currentChatCharacterUuids());
        const merged = new Map();
        for (const uuid of activeUuids) {
            for (const item of settings.characterHistory[uuid] ?? []) {
                if (!item?.key || !item?.text) continue;
                merged.set(item.key, { ...item, id: item.key, chatIndex: null, fromMemory: true });
            }
        }
        current.forEach((item) => merged.set(item.key, item));
        candidates = [...merged.values()].sort((a, b) => Number(a.capturedAt ?? 0) - Number(b.capturedAt ?? 0));
    }

    if (!applyWindow) return candidates;
    return candidates.slice(-windowSize);
}

function countAssistantMessages() {
    const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
    let total = 0;
    for (const message of chat) {
        if (!message || message.is_user || message.is_system) continue;
        if (message.extra?.type === 'narrator' || message.extra?.type === 'system') continue;
        total += 1;
    }
    return total;
}

export function shouldRunSmartAnalysis(total, lastTotal, interval, force = false) {
    const current = Math.max(0, Number(total) || 0);
    const previous = Math.max(0, Number(lastTotal) || 0);
    const step = Math.max(1, Number(interval) || DEFAULT_SETTINGS.smartInterval);
    return Boolean(force || current < previous || current - previous >= step);
}

function normalizedPatternTokens(value) {
    return new Set(String(value ?? '')
        .normalize('NFKC')
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? []);
}

function tokenSimilarity(left, right) {
    const a = normalizedPatternTokens(left);
    const b = normalizedPatternTokens(right);
    if (!a.size || !b.size) return 0;
    const overlap = [...a].filter((token) => b.has(token)).length;
    return overlap / Math.min(a.size, b.size);
}

function ignoredDescriptor(pattern) {
    return {
        key: String(pattern.key ?? ''),
        characterUuid: String(pattern.characterUuid ?? ''),
        source: String(pattern.source ?? ''),
        kind: String(pattern.kind ?? ''),
        scope: String(pattern.scope ?? ''),
        speaker: String(pattern.speaker ?? ''),
        label: String(pattern.label ?? ''),
        instruction: String(pattern.instruction ?? ''),
        examples: Array.isArray(pattern.examples) ? pattern.examples.slice(0, 3).map(String) : [String(pattern.example ?? '')].filter(Boolean),
    };
}

function getCharacterAllowance(characterUuid, create = true) {
    const uuid = String(characterUuid ?? '');
    if (!uuid) return null;
    const settings = getSettings();
    if (!settings.characterAllowances[uuid] && create) {
        settings.characterAllowances[uuid] = { ignoredKeys: [], ignoredPatterns: [] };
    }
    const allowance = settings.characterAllowances[uuid];
    if (!allowance || typeof allowance !== 'object') return null;
    allowance.ignoredKeys = Array.isArray(allowance.ignoredKeys) ? allowance.ignoredKeys : [];
    allowance.ignoredPatterns = Array.isArray(allowance.ignoredPatterns) ? allowance.ignoredPatterns : [];
    return allowance;
}

function migrateLegacyAllowances(state, messages) {
    if (!state || state.legacyAllowancesMigrated) return;
    const uuids = [...new Set(messages.map((message) => message.characterUuid).filter(Boolean))];
    const legacyKeys = Array.isArray(state.ignoredKeys) ? state.ignoredKeys.filter(Boolean) : [];
    const legacyPatterns = Array.isArray(state.ignoredPatterns) ? state.ignoredPatterns.filter(Boolean) : [];
    if (!legacyKeys.length && !legacyPatterns.length) {
        state.legacyAllowancesMigrated = true;
        saveChatState();
        return;
    }
    // Do not mark migration complete before a character can be identified.
    if (!uuids.length) return;

    const speakerUuids = new Map();
    for (const message of messages) {
        if (!speakerUuids.has(message.speaker)) speakerUuids.set(message.speaker, new Set());
        speakerUuids.get(message.speaker).add(message.characterUuid);
    }

    let settingsChanged = false;
    let unresolved = false;
    const descriptorKeys = new Set();
    for (const raw of legacyPatterns) {
        if (raw?.key) descriptorKeys.add(raw.key);
        const possible = raw?.characterUuid
            ? [raw.characterUuid]
            : raw?.speaker && speakerUuids.get(raw.speaker)?.size === 1
                ? [...speakerUuids.get(raw.speaker)]
                : uuids.length === 1 ? uuids : [];
        if (possible.length !== 1) {
            unresolved = true;
            continue;
        }
        const allowance = getCharacterAllowance(possible[0]);
        const descriptor = { ...raw, characterUuid: possible[0] };
        if (descriptor.key && !allowance.ignoredKeys.includes(descriptor.key)) {
            allowance.ignoredKeys.push(descriptor.key);
            settingsChanged = true;
        }
        if (descriptor.key && !allowance.ignoredPatterns.some((item) => item?.key === descriptor.key)) {
            allowance.ignoredPatterns.push(descriptor);
            settingsChanged = true;
        }
    }

    const orphanKeys = legacyKeys.filter((key) => !descriptorKeys.has(key));
    if (orphanKeys.length && uuids.length === 1) {
        const allowance = getCharacterAllowance(uuids[0]);
        for (const key of orphanKeys) {
            if (!allowance.ignoredKeys.includes(key)) {
                allowance.ignoredKeys.push(key);
                settingsChanged = true;
            }
        }
    } else if (orphanKeys.length) {
        unresolved = true;
    }

    if (!unresolved) {
        state.legacyAllowancesMigrated = true;
        saveChatState();
    }
    if (settingsChanged) saveSettings();
}

export function isPatternIgnored(pattern, state) {
    const allowance = getCharacterAllowance(pattern.characterUuid, false);
    if (allowance?.ignoredKeys?.includes(pattern.key)) return true;
    for (const ignored of allowance?.ignoredPatterns ?? []) {
        if (ignored?.key === pattern.key) return true;
        if (String(ignored?.characterUuid ?? '') !== String(pattern.characterUuid ?? '')) continue;
        if (ignored?.scope !== pattern.scope || String(ignored?.speaker ?? '') !== String(pattern.speaker ?? '')) continue;
        const labelSimilarity = tokenSimilarity(ignored?.label, pattern.label);
        if (labelSimilarity >= 0.72) return true;
        if (labelSimilarity >= 0.4 && tokenSimilarity(ignored?.instruction, pattern.instruction) >= 0.82) return true;
        const previousExamples = Array.isArray(ignored?.examples) ? ignored.examples : [];
        const currentExamples = Array.isArray(pattern.examples) ? pattern.examples : [pattern.example].filter(Boolean);
        if (previousExamples.some((a) => currentExamples.some((b) => tokenSimilarity(a, b) >= 0.72))) return true;
    }
    // Compatibility only: old permissions never leave the chat where they were created.
    if (state?.ignoredKeys?.includes(pattern.key)) return true;
    return false;
}

function getContextNames() {
    const context = getContext();
    const names = [context.name1, context.name2];
    if (context.groupId && Array.isArray(context.groups)) {
        const group = context.groups.find((item) => String(item.id) === String(context.groupId));
        if (group && Array.isArray(group.members) && Array.isArray(context.characters)) {
            for (const avatar of group.members) {
                const character = context.characters.find((item) => item.avatar === avatar);
                if (character?.name) names.push(character.name);
            }
        }
    }
    return names.filter(Boolean);
}

function smartPatternsForMessages(state, messages) {
    const settings = getSettings();
    if (!settings.smartAnalysis || state?.smart?.stale || !state?.smart?.patterns?.length) return [];
    const savedKeys = state.smart.messageKeys ?? [];
    if (!savedKeys.length) return [];
    const current = new Set(messages.map((message) => message.key));
    const matched = savedKeys.filter((key) => current.has(key)).length;
    if (matched / savedKeys.length < 0.7) return [];
    return state.smart.patterns
        .map((pattern, index) => normalizeSmartPattern(pattern, index))
        .filter(Boolean)
        .filter((pattern) => pattern.scope === 'dialogue' ? settings.dialogueEnabled : settings.narrationEnabled);
}

function analyzeCurrentChat(force = false, preparedMessages = null) {
    // All source/settings mutations explicitly invalidate the cache. UI refreshes
    // can therefore reuse the finished analysis without rescanning message text.
    if (!force && analysisCache && !preparedMessages) return analysisCache;
    const settings = getSettings();
    const state = getChatState();
    const messages = preparedMessages ?? collectAssistantMessages();
    const messageFingerprint = fingerprintMessages(messages);
    if (!force && analysisCache?.messageFingerprint === messageFingerprint) return analysisCache;
    migrateLegacyAllowances(state, messages);
    const settingsKey = [
        settings.windowSize,
        settings.sensitivity,
        settings.narrationEnabled,
        settings.dialogueEnabled,
        settings.sourceMode,
        settings.crossChatMemoryEnabled,
        settings.excludeAllTaggedBlocks,
        settings.excludedTags,
        settings.excludedClasses,
    ].join('|');
    const activeUuids = [...new Set(messages.map((message) => message.characterUuid).filter(Boolean))];
    const activeAllowances = activeUuids.flatMap((uuid) => getCharacterAllowance(uuid, false)?.ignoredPatterns ?? []);
    const ignoredFingerprint = fingerprintMessages(activeAllowances.map((pattern, index) => ({
        id: index,
        speaker: pattern.speaker ?? '',
        characterUuid: pattern.characterUuid ?? '',
        text: `${pattern.key ?? ''}|${pattern.label ?? ''}|${pattern.instruction ?? ''}`,
    })));
    const permanentPatterns = permanentPatternsForUuids([...new Set([...currentChatCharacterUuids(), ...activeUuids])]);
    const permanentFingerprint = fingerprintMessages(permanentPatterns.map((pattern, index) => ({
        id: index,
        speaker: pattern.speaker,
        characterUuid: pattern.characterUuid,
        text: `${pattern.key}|${pattern.instruction}`,
    })));
    const fingerprint = `${messageFingerprint}|${settingsKey}|${ignoredFingerprint}|${permanentFingerprint}|${state?.smart?.lastRunAt ?? 0}|${state?.smart?.stale ? 1 : 0}`;
    const localPatterns = detectPatterns(messages, settings, getContextNames());
    const smartPatterns = smartPatternsForMessages(state, messages);
    const detectedPatterns = mergePatterns(localPatterns, smartPatterns).filter((pattern) => !isPatternIgnored(pattern, state));
    const patterns = [...permanentPatterns, ...detectedPatterns];
    const prompt = buildInjection(patterns, Number(settings.maxInjectedPatterns) || DEFAULT_SETTINGS.maxInjectedPatterns);

    analysisCache = {
        fingerprint,
        messageFingerprint,
        messages,
        localPatterns,
        smartPatterns,
        permanentPatterns,
        patterns,
        prompt,
    };
    return analysisCache;
}

function invalidateAnalysis() {
    analysisCache = null;
}

function clearInjectedPrompt() {
    try {
        getContext().setExtensionPrompt(
            PROMPT_KEY,
            '',
            PROMPT_POSITION_IN_CHAT,
            0,
            false,
            PROMPT_ROLE_SYSTEM,
        );
    } catch (error) {
        console.debug(`${LOG_PREFIX} 주입문 초기화 생략`, error);
    }
}

globalThis.ttottoGenerationInterceptor = async function ttottoGenerationInterceptor(_chat, _contextSize, _abort, type) {
    clearInjectedPrompt();
    try {
        const settings = getSettings();
        const state = getChatState(false);
        if (!runtimeActive || !settings.enabled || !state?.enabled) return;
        if (!ALLOWED_GENERATION_TYPES.has(String(type ?? '').toLocaleLowerCase())) return;
        if (state.skipNextGeneration) {
            state.skipNextGeneration = false;
            saveChatState();
            updateUi();
            toastr.info('이번 생성에서는 또또가 쉬어요. 다음 생성부터 자동으로 다시 켜져요.', '🌀또또');
            return;
        }
        // A generation can begin before a delayed render/update event arrives.
        // Recheck only the small recent window; rerun the detector only if it changed.
        const recentMessages = collectAssistantMessages();
        const analysis = analyzeCurrentChat(false, recentMessages);
        if (!analysis.prompt) return;
        getContext().setExtensionPrompt(
            PROMPT_KEY,
            analysis.prompt,
            PROMPT_POSITION_IN_CHAT,
            0,
            false,
            PROMPT_ROLE_SYSTEM,
        );
        console.debug(`${LOG_PREFIX} ${analysis.patterns.slice(0, settings.maxInjectedPatterns).length}개 반복 방지 항목 주입`);
    } catch (error) {
        clearInjectedPrompt();
        console.error(`${LOG_PREFIX} 생성 전 주입 실패 — 본 채팅 생성은 계속합니다.`, error);
    }
};

function buildSmartInput(messages) {
    const settings = getSettings();
    const selected = messages.slice(-Math.min(12, messages.length));
    return selected.map((message, index) => {
        const { narration, dialogue } = splitDialogueAndNarration(message.text, settings);
        const narrationText = narration.join(' ').slice(0, 1100);
        const dialogueText = dialogue.join(' / ').slice(0, 900);
        return [
            `[M${index + 1} | character_uuid=${message.characterUuid} | speaker=${message.speaker}]`,
            narrationText ? `NARRATION: ${narrationText}` : '',
            dialogueText ? `DIALOGUE: ${dialogueText}` : '',
        ].filter(Boolean).join('\n');
    }).join('\n\n');
}

function smartPromptMessages(messages) {
    const system = `You analyze repetitive prose habits in roleplay assistant outputs. Return JSON only, with no markdown.\n\nSchema:\n{"patterns":[{"character_uuid":"copy the exact UUID from the analyzed messages","scope":"narration|dialogue","speaker":"speaker name or empty","label":"short Korean UI label","instruction":"concise English instruction for the next creative-writing response","examples":["short exact excerpts"],"count":3,"confidence":0.0}]}\n\nRules:\n- Find expressions, semantic reaction beats, dialogue responses, dialogue endings, question forms, or sentence structures repeated in at least 3 different message IDs belonging to the same character_uuid.\n- Never combine messages that have different character_uuid values, even when their speaker names are identical.\n- Copy the exact character_uuid into every returned pattern.\n- Analyze dialogue separately for each speaker.\n- Do not flag names, plot facts, necessary terminology, pronouns, ordinary function words, or intentional character voice by itself.\n- Do flag a character's catchphrase only when it is functioning as repetitive filler rather than meaningful characterization.\n- Instructions must demand genuinely different construction, not synonym substitution.\n- Preserve characterization, relationship dynamics, plot, tone, intensity, and explicitness. Only vary wording and sentence construction.\n- Return at most 6 high-confidence patterns. If none qualify, return {"patterns":[]}.`;
    const user = `Inspect only the assistant outputs below. Message IDs are M1, M2, etc.\n\n${buildSmartInput(messages)}`;
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}

function parseSmartResponse(text, messages) {
    const clean = String(text ?? '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('정밀 분석 응답에 JSON 객체가 없습니다.');
    const parsed = JSON.parse(clean.slice(start, end + 1));
    const patterns = Array.isArray(parsed?.patterns) ? parsed.patterns : [];
    const knownUuids = new Set(messages.map((message) => message.characterUuid).filter(Boolean));
    const speakerUuids = new Map();
    for (const message of messages) {
        if (!speakerUuids.has(message.speaker)) speakerUuids.set(message.speaker, new Set());
        speakerUuids.get(message.speaker).add(message.characterUuid);
    }
    return patterns.map((raw, index) => {
        const declared = String(raw?.character_uuid ?? raw?.characterUuid ?? '');
        let characterUuid = knownUuids.has(declared) ? declared : '';
        if (!characterUuid && knownUuids.size === 1) characterUuid = [...knownUuids][0];
        if (!characterUuid) {
            const matches = speakerUuids.get(String(raw?.speaker ?? ''));
            if (matches?.size === 1) characterUuid = [...matches][0];
        }
        if (!characterUuid) return null;
        return normalizeSmartPattern({ ...raw, characterUuid }, index);
    }).filter(Boolean).slice(0, 6);
}

async function requestSmartAnalysis(messages, signal) {
    const context = getContext();
    const settings = getSettings();
    const prompt = smartPromptMessages(messages);
    const profileId = String(settings.smartProfileId ?? '').trim();
    const maxTokens = Number(settings.smartMaxTokens) || DEFAULT_SETTINGS.smartMaxTokens;

    if (profileId) {
        const service = context.ConnectionManagerRequestService;
        if (!service || typeof service.sendRequest !== 'function') {
            throw new Error('Connection Profiles 서비스를 사용할 수 없습니다.');
        }
        const result = await service.sendRequest(profileId, prompt, maxTokens, {
            stream: false,
            signal,
            extractData: true,
        });
        if (typeof result === 'string') return result;
        if (result && typeof result.content === 'string') return result.content;
        throw new Error('정밀 분석 연결 프로필이 텍스트를 반환하지 않았습니다.');
    }

    if (typeof context.generateRaw !== 'function') {
        throw new Error('현재 연결을 통한 백그라운드 생성을 사용할 수 없습니다.');
    }
    return context.generateRaw({
        prompt,
        responseLength: maxTokens,
        trimNames: false,
        signal,
    });
}

async function runSmartAnalysis({ manual = false } = {}) {
    const settings = getSettings();
    const state = getChatState();
    if (!runtimeActive || !state || smartRunning) return false;
    if (!settings.smartAnalysis) {
        if (manual) toastr.info('설정에서 AI 정밀 분석을 먼저 켜주세요.', '🌀또또');
        return false;
    }

    const messages = collectAssistantMessages();
    const assistantTotal = countAssistantMessages();
    const chatIdentity = getChatIdentity();
    if (messages.length < 3) {
        if (manual) toastr.info('정밀 분석에는 AI 답변이 최소 3개 필요해요.', '🌀또또');
        return false;
    }

    smartRunning = true;
    smartAbortController?.abort();
    smartAbortController = new AbortController();
    updateUi();

    try {
        const response = await requestSmartAnalysis(messages, smartAbortController.signal);
        if (!runtimeActive || chatIdentity !== getChatIdentity()) {
            const aborted = new Error('채팅이 변경되어 정밀 분석 결과를 폐기했습니다.');
            aborted.name = 'AbortError';
            throw aborted;
        }
        const patterns = parseSmartResponse(response, messages);
        state.smart = {
            fingerprint: fingerprintMessages(messages),
            messageKeys: messages.map((message) => message.key),
            patterns,
            lastAssistantCount: messages.length,
            lastAssistantTotal: assistantTotal,
            lastRunAt: Date.now(),
            error: '',
            stale: false,
        };
        saveChatState();
        invalidateAnalysis();
        analyzeCurrentChat(true);
        if (manual) toastr.success(`정밀 분석 완료: ${patterns.length}개 패턴`, '🌀또또');
        return true;
    } catch (error) {
        if (error?.name === 'AbortError') return false;
        console.error(`${LOG_PREFIX} 정밀 분석 실패`, error);
        state.smart.error = String(error?.message ?? error);
        saveChatState();
        if (manual) toastr.error(`정밀 분석 실패: ${state.smart.error}`, '🌀또또');
        return false;
    } finally {
        smartRunning = false;
        smartAbortController = null;
        if (runtimeActive) updateUi();
    }
}

function scheduleSmartAnalysis({ force = false } = {}) {
    smartForcePending ||= force;
    clearTimeout(smartTimer);
    smartTimer = setTimeout(() => {
        const forceNow = smartForcePending;
        smartForcePending = false;
        const settings = getSettings();
        const state = getChatState(false);
        if (!runtimeActive || !settings.enabled || !settings.smartAnalysis || !state?.enabled) return;
        if (smartRunning) {
            scheduleSmartAnalysis({ force: forceNow });
            return;
        }
        const total = countAssistantMessages();
        const lastTotal = Number(state.smart?.lastAssistantTotal) || 0;
        if (shouldRunSmartAnalysis(total, lastTotal, settings.smartInterval, forceNow)) {
            void runSmartAnalysis({ manual: false });
        }
    }, 900);
}

function markSmartResultsStale() {
    const state = getChatState(false);
    if (!state?.smart) return;
    state.smart.stale = true;
    state.smart.error = '';
    saveChatState();
}

function scheduleAnalysis({ smart = false, forceSmart = false, delay = 250 } = {}) {
    forceSmartOnNextAnalysis ||= forceSmart;
    clearTimeout(analysisTimer);
    analysisTimer = setTimeout(() => {
        if (!runtimeActive) return;
        const forceSmartNow = forceSmartOnNextAnalysis;
        forceSmartOnNextAnalysis = false;
        const settings = getSettings();
        const state = settings.enabled ? getChatState() : getChatState(false);
        if (!settings.enabled || !state?.enabled) {
            invalidateAnalysis();
            updateUi(EMPTY_ANALYSIS);
            return;
        }
        invalidateAnalysis();
        const analysis = analyzeCurrentChat(true);
        updateUi(analysis);
        if (smart) scheduleSmartAnalysis({ force: forceSmartNow });
    }, delay);
}

function setTab(tabName) {
    if (!uiReady) return;
    document.querySelectorAll('#ttotto-settings [data-ttotto-tab]').forEach((button) => {
        const active = button.dataset.ttottoTab === tabName;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
    });
    document.getElementById('ttotto-panel-patterns').hidden = tabName !== 'patterns';
    document.getElementById('ttotto-panel-settings').hidden = tabName !== 'settings';
}

function makeBadge(text, className = '') {
    const badge = document.createElement('span');
    badge.className = `ttotto-scope-badge ${className}`.trim();
    badge.textContent = text;
    return badge;
}

function patternEvidence(pattern) {
    const messages = analysisCache?.messages ?? [];
    const examples = (pattern.examples ?? [pattern.example]).filter(Boolean).map(String);
    const results = [];
    for (const example of examples) {
        const message = messages.find((item) => item.characterUuid === pattern.characterUuid
            && (item.text.includes(example) || tokenSimilarity(item.text, example) >= 0.72));
        if (!message) continue;
        if (results.some((item) => item.key === message.key)) continue;
        results.push({
            key: message.key,
            chatIndex: Number.isInteger(message.chatIndex) ? message.chatIndex : null,
            fromMemory: Boolean(message.fromMemory),
            snippet: example.slice(0, 180),
        });
    }
    return results.slice(0, 3);
}

function jumpToMessage(chatIndex) {
    if (!Number.isInteger(chatIndex)) return;
    const target = document.querySelector(`.mes[mesid="${chatIndex}"]`);
    if (!target) {
        toastr.info('현재 화면에서 그 메시지를 찾지 못했어요.', '🌀또또');
        return;
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('ttotto-message-flash');
    void target.offsetWidth;
    target.classList.add('ttotto-message-flash');
    setTimeout(() => target.classList.remove('ttotto-message-flash'), 1600);
}

function renderPatterns(patterns) {
    const list = document.getElementById('ttotto-pattern-list');
    const empty = document.getElementById('ttotto-empty');
    if (!list || !empty) return;
    list.replaceChildren();

    for (const pattern of patterns) {
        const article = document.createElement('article');
        article.className = 'ttotto-pattern';

        const head = document.createElement('div');
        head.className = 'ttotto-pattern-head';
        const title = document.createElement('div');
        title.className = 'ttotto-pattern-title';
        const name = document.createElement('div');
        name.className = 'ttotto-pattern-name';
        name.textContent = pattern.label;
        const example = document.createElement('div');
        example.className = 'ttotto-pattern-example';
        example.textContent = pattern.example ? `“${pattern.example}”` : pattern.instruction;
        title.append(name, example);
        const badge = makeBadge(pattern.scope === 'dialogue' ? '대사' : '서술');
        head.append(title, badge);

        const meta = document.createElement('div');
        meta.className = 'ttotto-pattern-meta';
        const source = pattern.source === 'pinned' ? '영구 금지' : pattern.source === 'smart' ? 'AI 정밀' : '로컬';
        const speaker = pattern.scope === 'dialogue' && pattern.speaker ? ` · ${pattern.speaker}` : '';
        meta.textContent = pattern.source === 'pinned'
            ? `${source}${speaker} · 매 생성에 주입`
            : `${pattern.count}개 답변에서 감지 · ${source}${speaker}`;

        const evidenceItems = patternEvidence(pattern);
        let evidence = null;
        if (evidenceItems.length) {
            evidence = document.createElement('details');
            evidence.className = 'ttotto-evidence';
            const summary = document.createElement('summary');
            summary.textContent = `왜 잡혔지? 예시 ${evidenceItems.length}개`;
            evidence.append(summary);
            for (const item of evidenceItems) {
                const row = document.createElement('div');
                row.className = 'ttotto-evidence-row';
                if (item.chatIndex !== null) {
                    const jump = document.createElement('button');
                    jump.type = 'button';
                    jump.className = 'menu_button ttotto-evidence-jump';
                    jump.textContent = `#${item.chatIndex + 1}`;
                    jump.addEventListener('click', () => jumpToMessage(item.chatIndex));
                    row.append(jump);
                } else {
                    row.append(makeBadge('지난 채팅'));
                }
                const snippet = document.createElement('span');
                snippet.className = 'ttotto-evidence-snippet';
                snippet.textContent = `“${item.snippet}”`;
                row.append(snippet);
                evidence.append(row);
            }
        }

        const actions = document.createElement('div');
        actions.className = 'ttotto-pattern-actions';
        if (pattern.source === 'pinned') {
            const unpin = document.createElement('button');
            unpin.type = 'button';
            unpin.className = 'menu_button';
            unpin.textContent = '영구 금지 해제';
            unpin.addEventListener('click', () => {
                removePermanentBan(pattern.characterUuid, pattern.banId);
                invalidateAnalysis();
                updateUi();
            });
            actions.append(unpin);
        } else {
            const pin = document.createElement('button');
            pin.type = 'button';
            pin.className = 'menu_button';
            pin.textContent = '📌 계속 금지';
            pin.addEventListener('click', () => {
                if (!pinPattern(pattern)) {
                    toastr.error('이 패턴을 영구 금지로 저장하지 못했어요.', '🌀또또');
                    return;
                }
                invalidateAnalysis();
                updateUi();
                toastr.success('이 캐릭터에게 계속 금지했어요.', '🌀또또');
            });
            const allow = document.createElement('button');
            allow.type = 'button';
            allow.className = 'menu_button';
            allow.textContent = '이 패턴 허용';
            allow.addEventListener('click', () => ignorePattern(pattern));
            actions.append(pin, allow);
        }

        article.append(head, meta);
        if (evidence) article.append(evidence);
        article.append(actions);
        list.append(article);
    }

    empty.hidden = patterns.length !== 0;
    list.hidden = patterns.length === 0;
}

function ignorePattern(pattern) {
    const allowance = getCharacterAllowance(pattern.characterUuid);
    if (!allowance) {
        toastr.error('이 패턴의 캐릭터 UUID를 확인할 수 없어 허용하지 않았어요.', '🌀또또');
        return;
    }
    if (!allowance.ignoredKeys.includes(pattern.key)) allowance.ignoredKeys.push(pattern.key);
    allowance.ignoredKeys = allowance.ignoredKeys.slice(-200);
    if (!allowance.ignoredPatterns.some((ignored) => ignored?.key === pattern.key)) {
        allowance.ignoredPatterns.push(ignoredDescriptor(pattern));
    }
    allowance.ignoredPatterns = allowance.ignoredPatterns.slice(-200);
    saveSettings();
    invalidateAnalysis();
    updateUi(analyzeCurrentChat(true));
}

function updateSmartStatus(state) {
    const element = document.getElementById('ttotto-smart-status');
    if (!element) return;
    const settings = getSettings();
    if (smartRunning) {
        element.hidden = false;
        element.textContent = '정밀 분석 중이에요. 채팅 화면은 그대로 사용할 수 있어요.';
        return;
    }
    if (state?.smart?.error) {
        element.hidden = false;
        element.textContent = `마지막 정밀 분석 실패: ${state.smart.error}`;
        return;
    }
    if (settings.smartAnalysis && state?.smart?.lastRunAt) {
        const count = state.smart.patterns?.length ?? 0;
        element.hidden = false;
        element.textContent = `정밀 분석 결과 ${count}개가 현재 감지 목록에 반영돼요.`;
        return;
    }
    element.hidden = true;
}

function renderBanManager() {
    const select = document.getElementById('ttotto-ban-character');
    const list = document.getElementById('ttotto-ban-list');
    const add = document.getElementById('ttotto-add-ban');
    if (!select || !list || !add) return;
    const previous = select.value;
    const options = currentCharacterOptions();
    select.replaceChildren();
    for (const item of options) {
        const option = document.createElement('option');
        option.value = item.uuid;
        option.textContent = item.label;
        select.append(option);
    }
    if (previous && options.some((item) => item.uuid === previous)) select.value = previous;
    const uuid = select.value;
    add.disabled = !uuid;
    list.replaceChildren();
    if (!uuid) {
        const empty = document.createElement('small');
        empty.textContent = '채팅을 열면 캐릭터를 고를 수 있어요.';
        list.append(empty);
        return;
    }
    const bans = getCharacterBans(uuid, false);
    for (const ban of bans) {
        const row = document.createElement('div');
        row.className = 'ttotto-ban-item';
        const text = document.createElement('span');
        text.textContent = ban.type === 'term' ? `🚫 ${ban.term}` : `📌 ${ban.label}`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'menu_button';
        remove.textContent = '삭제';
        remove.addEventListener('click', () => {
            removePermanentBan(uuid, ban.id);
            invalidateAnalysis();
            updateUi();
        });
        row.append(text, remove);
        list.append(row);
    }
    if (!bans.length) {
        const empty = document.createElement('small');
        empty.textContent = '이 캐릭터의 영구 금지 항목은 아직 없어요.';
        list.append(empty);
    }
}

function updateBanWarning(state) {
    const warning = document.getElementById('ttotto-ban-warning');
    if (!warning) return;
    const hits = state?.lastBanHits ?? [];
    warning.hidden = !hits.length;
    warning.textContent = hits.length
        ? `⚠️ 방금 답변에 영구 금지어가 다시 나왔어요: ${hits.map((item) => item.term).join(', ')} · 필요하면 재생성해 주세요.`
        : '';
}

function updateUi(analysisOverride = null) {
    if (!uiReady) return;
    const settings = getSettings();
    const state = getChatState(false);
    const enabled = settings.enabled && (state?.enabled ?? false);
    const analysis = analysisOverride ?? (enabled ? analyzeCurrentChat(false) : analysisCache ?? EMPTY_ANALYSIS);

    document.getElementById('ttotto-enabled').checked = settings.enabled;
    document.getElementById('ttotto-chat-enabled').checked = state?.enabled ?? false;
    document.getElementById('ttotto-chat-enabled').disabled = !state;
    document.getElementById('ttotto-window-size').value = String(settings.windowSize);
    document.getElementById('ttotto-sensitivity').value = settings.sensitivity;
    document.getElementById('ttotto-narration-enabled').checked = settings.narrationEnabled;
    document.getElementById('ttotto-dialogue-enabled').checked = settings.dialogueEnabled;
    document.getElementById('ttotto-smart-enabled').checked = settings.smartAnalysis;
    document.getElementById('ttotto-smart-interval').value = String(settings.smartInterval);
    document.getElementById('ttotto-max-patterns').value = String(settings.maxInjectedPatterns);
    document.getElementById('ttotto-cross-memory-enabled').checked = Boolean(settings.crossChatMemoryEnabled);
    document.getElementById('ttotto-exclude-all-tags').checked = Boolean(settings.excludeAllTaggedBlocks);
    document.getElementById('ttotto-excluded-tags').value = settings.excludedTags;
    document.getElementById('ttotto-excluded-classes').value = settings.excludedClasses;
    document.getElementById('ttotto-custom-exclusions').hidden = Boolean(settings.excludeAllTaggedBlocks);
    document.getElementById('ttotto-pattern-count').textContent = String(enabled ? analysis.patterns.length : 0);
    document.getElementById('ttotto-scope-summary').textContent = `${settings.crossChatMemoryEnabled ? '현재+지난 채팅' : '현재 채팅'} 최근 AI 답변 ${settings.windowSize}개 기준 · 서술 ${settings.narrationEnabled ? '켬' : '끔'} · 대사 ${settings.dialogueEnabled ? '켬' : '끔'}`;

    const header = document.getElementById('ttotto-header-status');
    if (!settings.enabled) header.textContent = '현재 꺼져 있어요';
    else if (!state) header.textContent = '채팅을 열면 분석을 시작해요';
    else if (!state.enabled) header.textContent = '현재 채팅에서는 꺼져 있어요';
    else header.textContent = `반복 표현 ${analysis.patterns.length}개 방지 중`;

    renderPatterns(enabled ? analysis.patterns : []);
    document.getElementById('ttotto-prompt-text').textContent = enabled && analysis.prompt ? analysis.prompt : '현재 주입할 내용이 없어요.';
    document.getElementById('ttotto-prompt-size').textContent = `${enabled ? analysis.prompt.length : 0}자`;
    document.getElementById('ttotto-run-smart').disabled = smartRunning || !settings.smartAnalysis || !state;
    const skip = document.getElementById('ttotto-skip-once');
    skip.disabled = !state;
    skip.textContent = state?.skipNextGeneration ? '다음 생성 쉬는 중 · 취소' : '다음 생성만 쉬기';
    renderBanManager();
    updateBanWarning(state);
    updateSmartStatus(state);
}

function populateProfiles() {
    if (!uiReady) return;
    const select = document.getElementById('ttotto-profile');
    const settings = getSettings();
    const currentValue = String(settings.smartProfileId ?? '');
    select.replaceChildren();
    const current = document.createElement('option');
    current.value = '';
    current.textContent = '현재 연결 사용';
    select.append(current);

    try {
        const service = getContext().ConnectionManagerRequestService;
        const profiles = typeof service?.getSupportedProfiles === 'function' ? service.getSupportedProfiles() : [];
        for (const profile of profiles ?? []) {
            if (!profile?.id) continue;
            const option = document.createElement('option');
            option.value = String(profile.id);
            option.textContent = String(profile.name || profile.id);
            select.append(option);
        }
    } catch (error) {
        console.warn(`${LOG_PREFIX} 연결 프로필 목록을 불러오지 못했습니다.`, error);
    }

    if (currentValue && ![...select.options].some((option) => option.value === currentValue)) {
        const missing = document.createElement('option');
        missing.value = currentValue;
        missing.textContent = '저장된 연결 프로필을 찾을 수 없음';
        select.append(missing);
    }
    select.value = currentValue;
}

function bindSetting(id, key, parser = (value) => value) {
    const element = document.getElementById(id);
    element.addEventListener('change', () => {
        const value = element.type === 'checkbox' ? element.checked : element.value;
        const settings = getSettings();
        settings[key] = parser(value);
        saveSettings();
        if (['windowSize', 'excludeAllTaggedBlocks', 'excludedTags', 'excludedClasses', 'crossChatMemoryEnabled'].includes(key)) markSmartResultsStale();
        if (key === 'smartAnalysis') {
            if (settings.smartAnalysis) {
                scheduleSmartAnalysis({ force: true });
            } else {
                clearTimeout(smartTimer);
                smartForcePending = false;
                forceSmartOnNextAnalysis = false;
                smartAbortController?.abort();
            }
        } else if (['windowSize', 'excludeAllTaggedBlocks', 'excludedTags', 'excludedClasses', 'crossChatMemoryEnabled'].includes(key) && settings.smartAnalysis) {
            scheduleSmartAnalysis({ force: true });
        }
        invalidateAnalysis();
        if (!settings.enabled) clearInjectedPrompt();
        const state = settings.enabled ? getChatState() : getChatState(false);
        updateUi(settings.enabled && state?.enabled ? analyzeCurrentChat(true) : EMPTY_ANALYSIS);
    });
}

async function confirmAction(title, message) {
    const popup = getContext().Popup;
    if (popup?.show?.confirm) return popup.show.confirm(title, message);
    return window.confirm(message);
}

function bindUi() {
    document.querySelectorAll('#ttotto-settings [data-ttotto-tab]').forEach((button) => {
        button.addEventListener('click', () => setTab(button.dataset.ttottoTab));
    });

    bindSetting('ttotto-enabled', 'enabled', Boolean);
    bindSetting('ttotto-window-size', 'windowSize', Number);
    bindSetting('ttotto-sensitivity', 'sensitivity', String);
    bindSetting('ttotto-narration-enabled', 'narrationEnabled', Boolean);
    bindSetting('ttotto-dialogue-enabled', 'dialogueEnabled', Boolean);
    bindSetting('ttotto-smart-enabled', 'smartAnalysis', Boolean);
    bindSetting('ttotto-smart-interval', 'smartInterval', Number);
    bindSetting('ttotto-profile', 'smartProfileId', String);
    bindSetting('ttotto-max-patterns', 'maxInjectedPatterns', Number);
    bindSetting('ttotto-cross-memory-enabled', 'crossChatMemoryEnabled', Boolean);
    bindSetting('ttotto-exclude-all-tags', 'excludeAllTaggedBlocks', Boolean);
    bindSetting('ttotto-excluded-tags', 'excludedTags', String);
    bindSetting('ttotto-excluded-classes', 'excludedClasses', String);

    document.getElementById('ttotto-ban-character').addEventListener('change', renderBanManager);
    const submitBan = () => {
        const uuid = document.getElementById('ttotto-ban-character').value;
        const input = document.getElementById('ttotto-ban-term');
        if (!uuid) {
            toastr.info('금지어를 적용할 캐릭터를 먼저 골라주세요.', '🌀또또');
            return;
        }
        const result = addManualBan(uuid, input.value);
        if (!result.ok) {
            toastr.info(result.reason, '🌀또또');
            return;
        }
        input.value = '';
        invalidateAnalysis();
        updateUi();
        toastr.success('이 캐릭터의 영구 금지어로 저장했어요.', '🌀또또');
    };
    document.getElementById('ttotto-add-ban').addEventListener('click', submitBan);
    document.getElementById('ttotto-ban-term').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            submitBan();
        }
    });

    document.getElementById('ttotto-chat-enabled').addEventListener('change', (event) => {
        const state = getChatState();
        if (!state) return;
        state.enabled = event.target.checked;
        saveChatState();
        invalidateAnalysis();
        if (!state.enabled) clearInjectedPrompt();
        updateUi();
    });

    document.getElementById('ttotto-toggle-preview').addEventListener('click', (event) => {
        const preview = document.getElementById('ttotto-prompt-preview');
        preview.hidden = !preview.hidden;
        event.currentTarget.textContent = preview.hidden ? '주입문 보기' : '주입문 닫기';
    });

    document.getElementById('ttotto-refresh').addEventListener('click', () => {
        invalidateAnalysis();
        updateUi(analyzeCurrentChat(true));
        toastr.success('현재 채팅을 다시 분석했어요.', '🌀또또');
    });

    document.getElementById('ttotto-run-smart').addEventListener('click', () => {
        void runSmartAnalysis({ manual: true });
    });

    document.getElementById('ttotto-skip-once').addEventListener('click', () => {
        const state = getChatState();
        if (!state) return;
        state.skipNextGeneration = !state.skipNextGeneration;
        saveChatState();
        updateUi();
    });

    document.getElementById('ttotto-clear-ignored').addEventListener('click', async () => {
        const uuids = currentChatCharacterUuids();
        if (!uuids.length) {
            toastr.info('현재 채팅의 캐릭터를 확인할 수 없어요.', '🌀또또');
            return;
        }
        if (!await confirmAction('🌀또또', '현재 채팅에 등장한 캐릭터들의 허용 목록을 초기화할까요? 같은 카드의 다른 채팅에도 적용돼요.')) return;
        const settings = getSettings();
        uuids.forEach((uuid) => delete settings.characterAllowances[uuid]);
        saveSettings();
        invalidateAnalysis();
        updateUi();
        toastr.success('캐릭터별 허용 목록을 초기화했어요.', '🌀또또');
    });

    document.getElementById('ttotto-clear-smart').addEventListener('click', async () => {
        if (!await confirmAction('🌀또또', '현재 채팅의 AI 정밀 분석 기록을 초기화할까요?')) return;
        const state = getChatState();
        if (!state) return;
        state.smart = createDefaultChatState().smart;
        saveChatState();
        invalidateAnalysis();
        updateUi();
        toastr.success('정밀 분석 기록을 초기화했어요.', '🌀또또');
    });

    document.getElementById('ttotto-clear-memory').addEventListener('click', async () => {
        const uuids = currentChatCharacterUuids();
        if (!uuids.length) {
            toastr.info('현재 채팅의 캐릭터를 확인할 수 없어요.', '🌀또또');
            return;
        }
        if (!await confirmAction('🌀또또', '현재 채팅 캐릭터들의 지난 채팅 기억을 삭제할까요?')) return;
        const settings = getSettings();
        uuids.forEach((uuid) => delete settings.characterHistory[uuid]);
        saveSettings();
        markSmartResultsStale();
        invalidateAnalysis();
        updateUi();
        toastr.success('현재 캐릭터들의 지난 채팅 기억을 삭제했어요.', '🌀또또');
    });
}

// ───────────────────────── 팝업 (완드 메뉴 빠른 접근) ─────────────────────────
// 설정 패널 DOM을 통째로 팝업으로 옮겼다가 닫을 때 되돌린다 — 모든 기능·바인딩이 그대로 동작.
// 모바일 우선: 중앙 고정을 CSS에만 맡기지 않고, 열 때마다 JS 인라인 !important로 강제한다.
// (MovingUI가 body에 transform을 걸어 position:fixed가 깨지는 문제 + ST 전역 CSS 오버라이드 대응)

const TTOTTO_OVERLAY_BASE_CSS = [
    'position:fixed !important', 'top:0 !important', 'left:0 !important', 'right:0 !important',
    'bottom:0 !important', 'width:100vw !important', 'height:100vh !important', 'margin:0 !important',
    'padding:16px !important', 'box-sizing:border-box !important', 'z-index:99990 !important',
    'background-color:rgba(12,12,16,0.55) !important', 'align-items:center !important',
    'justify-content:center !important', 'transform:none !important', '-webkit-transform:none !important',
].join('; ');

const TTOTTO_POPUP_BOX_CSS = [
    'width:100% !important', 'max-width:480px !important', 'max-height:88vh !important',
    'display:flex !important', 'flex-direction:column !important', 'position:relative !important',
    'z-index:99991 !important', 'border-radius:14px !important', 'overflow:hidden !important',
    'margin:0 auto !important', 'transform:none !important',
    'background-color:var(--SmartThemeBlurTintColor, #1b1b22) !important',
    'color:var(--SmartThemeBodyColor, #ddd) !important',
    'border:1px solid rgba(128,128,128,0.35) !important',
    'box-shadow:0 16px 40px rgba(0,0,0,0.4) !important',
].join('; ');

function ttottoBuildPopupShell() {
    if (typeof document === 'undefined') return; // 테스트/헤드리스 환경 가드
    if (document.getElementById('ttotto-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'ttotto-overlay';
    overlay.className = 'ttotto-overlay';
    overlay.innerHTML = [
        '<div id="ttotto-popup-box" class="ttotto-popup">',
        '  <div class="ttotto-popup-header">',
        '    <strong>🌀 또또</strong>',
        '    <button id="ttotto-popup-close" class="menu_button" type="button" title="닫기">✕</button>',
        '  </div>',
        '  <div id="ttotto-popup-body" class="ttotto-popup-body"></div>',
        '</div>',
    ].join('\n');
    document.body.append(overlay);
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) ttottoClosePopup();
    });
    overlay.querySelector('#ttotto-popup-close').addEventListener('click', ttottoClosePopup);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && popupOpen) ttottoClosePopup();
    });
}

function ttottoOpenPopup() {
    if (typeof document === 'undefined') return; // 테스트/헤드리스 환경 가드
    if (!uiReady) {
        toastr.warning('설정 패널이 아직 준비되지 않았어요. 잠시 후 다시 열어주세요.', '🌀또또');
        return;
    }
    ttottoBuildPopupShell();
    const overlay = document.getElementById('ttotto-overlay');
    const box = document.getElementById('ttotto-popup-box');
    const panel = document.getElementById('ttotto-settings');
    if (!overlay || !box || !panel) return;
    if (!settingsHomeParent) settingsHomeParent = panel.parentElement;
    document.getElementById('ttotto-popup-body').append(panel);
    panel.classList.add('ttotto-in-popup');
    // JS 강제 중앙 고정 — 매번 열 때마다 다시 박아넣는다
    overlay.style.cssText = `display:flex !important; ${TTOTTO_OVERLAY_BASE_CSS}`;
    box.style.cssText = TTOTTO_POPUP_BOX_CSS;
    const header = box.querySelector('.ttotto-popup-header');
    if (header) header.style.cssText = 'display:flex !important; align-items:center !important; justify-content:space-between !important; gap:8px !important; padding:10px 14px !important; border-bottom:1px solid rgba(128,128,128,0.25) !important; flex-shrink:0 !important;';
    const body = document.getElementById('ttotto-popup-body');
    if (body) body.style.cssText = 'overflow-y:auto !important; padding:8px 14px 14px !important; -webkit-overflow-scrolling:touch;';
    popupOpen = true;
    updateUi();
}

function ttottoClosePopup() {
    if (typeof document === 'undefined') return; // 테스트/헤드리스 환경 가드
    const overlay = document.getElementById('ttotto-overlay');
    const panel = document.getElementById('ttotto-settings');
    if (overlay) overlay.style.cssText = `display:none !important; ${TTOTTO_OVERLAY_BASE_CSS}`;
    if (panel && settingsHomeParent) {
        panel.classList.remove('ttotto-in-popup');
        settingsHomeParent.append(panel);
    }
    popupOpen = false;
}

function ttottoAddWandButton() {
    if (typeof document === 'undefined') return; // 테스트/헤드리스 환경 가드
    if (document.getElementById('ttotto-wand-button')) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        console.warn(`${LOG_PREFIX} #extensionsMenu를 찾지 못했습니다 — ST 버전에 따라 셀렉터 조정이 필요할 수 있어요.`);
        return;
    }
    const item = document.createElement('div');
    item.id = 'ttotto-wand-button';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<span class="extensionsMenuExtensionButton" aria-hidden="true">🌀</span><span>또또</span>';
    item.addEventListener('click', () => {
        menu.style.display = 'none';
        ttottoOpenPopup();
    });
    menu.append(item);
}

function ttottoRemoveWandButton() {
    if (typeof document === 'undefined') return; // 테스트/헤드리스 환경 가드
    document.getElementById('ttotto-wand-button')?.remove();
}

async function initializeUi() {
    if (document.getElementById('ttotto-settings')) {
        uiReady = true;
        ttottoAddWandButton();
        return;
    }
    const context = getContext();
    const html = await context.renderExtensionTemplateAsync(EXTENSION_PATH, 'settings');
    const container = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!container) throw new Error('확장 설정 패널을 찾을 수 없습니다.');
    container.insertAdjacentHTML('beforeend', html);
    uiReady = true;
    bindUi();
    populateProfiles();
    ttottoAddWandButton();
    const settings = getSettings();
    const state = settings.enabled ? getChatState() : getChatState(false);
    updateUi(settings.enabled && state?.enabled ? analyzeCurrentChat(true) : EMPTY_ANALYSIS);
}

function registerEvents() {
    if (eventsRegistered) return;
    const context = getContext();
    const events = getEventTypes(context);
    const listen = (eventName, handler) => {
        const event = events[eventName];
        if (!event) return;
        context.eventSource.on(event, handler);
        registeredEventHandlers.push({ event, handler });
    };

    listen('MESSAGE_RECEIVED', (payload) => {
        clearTimeout(sourceMutationTimer);
        sourceMutationTimer = null;
        pendingSourceMutationPayload = null;
        const { message } = captureOriginalFromEvent(payload);
        updateBanHitsForMessage(message);
        scheduleAnalysis({ smart: true, delay: 350 });
    });
    const handleHistoryMutation = () => {
        markSmartResultsStale();
        scheduleAnalysis({ smart: true, forceSmart: true, delay: 250 });
    };
    const handleSourceMutation = (payload) => {
        const { changed } = captureOriginalFromEvent(payload);
        if (!changed) return;
        handleHistoryMutation();
    };
    const scheduleSourceMutation = (payload) => {
        pendingSourceMutationPayload = payload;
        clearTimeout(sourceMutationTimer);
        sourceMutationTimer = setTimeout(() => {
            const pending = pendingSourceMutationPayload;
            pendingSourceMutationPayload = null;
            sourceMutationTimer = null;
            if (runtimeActive) handleSourceMutation(pending);
        }, 450);
    };
    listen('MESSAGE_EDITED', handleSourceMutation);
    // MESSAGE_UPDATED can fire repeatedly while another extension is rendering
    // or while text is streaming. Collapse the burst and ignore display-only updates.
    listen('MESSAGE_UPDATED', scheduleSourceMutation);
    listen('MESSAGE_DELETED', handleHistoryMutation);
    listen('MESSAGE_SWIPED', handleSourceMutation);
    listen('GENERATION_ENDED', clearInjectedPrompt);
    listen('GENERATION_STOPPED', clearInjectedPrompt);
    listen('CHAT_CHANGED', () => {
        smartAbortController?.abort();
        clearTimeout(smartTimer);
        clearTimeout(sourceMutationTimer);
        sourceMutationTimer = null;
        pendingSourceMutationPayload = null;
        smartForcePending = false;
        forceSmartOnNextAnalysis = false;
        clearInjectedPrompt();
        invalidateAnalysis();
        populateProfiles();
        scheduleAnalysis({ smart: false, delay: 120 });
    });
    listen('CHAT_CREATED', () => scheduleAnalysis({ smart: false, delay: 120 }));
    listen('CONNECTION_PROFILE_LOADED', populateProfiles);
    eventsRegistered = true;
}

function unregisterEvents() {
    if (!eventsRegistered) return;
    const eventSource = getContext().eventSource;
    for (const { event, handler } of registeredEventHandlers.splice(0)) {
        if (typeof eventSource.removeListener === 'function') eventSource.removeListener(event, handler);
        else if (typeof eventSource.off === 'function') eventSource.off(event, handler);
    }
    eventsRegistered = false;
}

async function initialize() {
    runtimeActive = true;
    getSettings();
    migrateStoredMemoryOnce();
    registerEvents();
    await initializeUi();
    console.log(`${LOG_PREFIX} v${EXTENSION_VERSION} 로드 완료`);
}

export function onEnable() {
    runtimeActive = true;
    registerEvents();
    if (uiReady) ttottoAddWandButton();
    scheduleAnalysis({ smart: false, delay: 50 });
}

export function onDisable() {
    runtimeActive = false;
    clearTimeout(analysisTimer);
    clearTimeout(smartTimer);
    clearTimeout(sourceMutationTimer);
    sourceMutationTimer = null;
    pendingSourceMutationPayload = null;
    smartForcePending = false;
    forceSmartOnNextAnalysis = false;
    smartAbortController?.abort();
    ttottoClosePopup();
    ttottoRemoveWandButton();
    unregisterEvents();
    clearInjectedPrompt();
}

export function onClean() {
    ttottoClosePopup();
    ttottoRemoveWandButton();
    document.getElementById('ttotto-overlay')?.remove();
    const context = getContext();
    delete context.extensionSettings[MODULE_NAME];
    if (context.chatMetadata && typeof context.chatMetadata === 'object') {
        delete context.chatMetadata[CHAT_STATE_KEY];
        saveChatState();
    }
    context.saveSettingsDebounced();
    clearInjectedPrompt();
}

const context = getContext();
const events = getEventTypes(context);
if (events.APP_READY) {
    context.eventSource.on(events.APP_READY, () => {
        if (!runtimeActive) return;
        void initialize().catch((error) => {
            console.error(`${LOG_PREFIX} 초기화 실패`, error);
            toastr.error(`초기화 실패: ${error?.message ?? error}`, '🌀또또');
        });
    });
} else {
    void initialize().catch((error) => console.error(`${LOG_PREFIX} 초기화 실패`, error));
}
