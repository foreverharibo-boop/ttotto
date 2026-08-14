import {
    buildInjection,
    detectPatterns,
    fingerprintMessages,
    mergePatterns,
    normalizeSmartPattern,
    splitDialogueAndNarration,
} from './detector.js';

const MODULE_NAME = 'ttotto';
const EXTENSION_PATH = 'third-party/ttotto';
const PROMPT_KEY = 'ttotto_anti_repetition';
const CHAT_STATE_KEY = 'ttotto';
const LOG_PREFIX = '[🌀또또]';
const EXTENSION_VERSION = '1.0.2';
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
    sourceMode: 'auto',
});

let analysisCache = null;
let uiReady = false;
let analysisTimer = null;
let smartTimer = null;
let smartRunning = false;
let smartAbortController = null;
let smartForcePending = false;
let forceSmartOnNextAnalysis = false;
let runtimeActive = true;
let eventsRegistered = false;
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
    return context.extensionSettings[MODULE_NAME];
}

function saveSettings() {
    getContext().saveSettingsDebounced();
}

function createDefaultChatState() {
    return {
        version: 2,
        enabled: true,
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
    state.version = 2;
    state.enabled ??= true;
    state.ignoredKeys = Array.isArray(state.ignoredKeys) ? state.ignoredKeys : [];
    state.ignoredPatterns = Array.isArray(state.ignoredPatterns) ? state.ignoredPatterns : [];
    state.smart = {
        ...createDefaultChatState().smart,
        ...(state.smart && typeof state.smart === 'object' ? state.smart : {}),
    };
    state.smart.patterns = Array.isArray(state.smart.patterns) ? state.smart.patterns : [];
    state.smart.messageKeys = Array.isArray(state.smart.messageKeys) ? state.smart.messageKeys : [];
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

function findStoredOriginal(message) {
    const sources = [activeSwipeMetadata(message), message];
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
            const candidate = readNestedString(source, path);
            if (candidate.length >= 8) return candidate;
        }
    }
    return '';
}

function messageText(message, settings) {
    if (settings.sourceMode === 'auto') {
        const original = findStoredOriginal(message);
        if (original) return original;
    }
    return typeof message?.mes === 'string' ? message.mes : '';
}

function messageKey(message, index, text) {
    const stableId = message?.extra?.message_id
        ?? message?.extra?.id
        ?? message?.send_date
        ?? `${index}`;
    return `${stableId}:${Number(message?.swipe_id) || 0}:${fingerprintMessages([{ id: stableId, speaker: message?.name ?? '', text }])}`;
}

function collectAssistantMessages({ applyWindow = true } = {}) {
    const context = getContext();
    const settings = getSettings();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const candidates = [];

    chat.forEach((message, index) => {
        if (!message || message.is_user || message.is_system || typeof message.mes !== 'string') return;
        if (message.extra?.type === 'narrator' || message.extra?.type === 'system') return;
        const text = messageText(message, settings).trim();
        if (text.length < 8) return;
        const speaker = String(message.name || context.name2 || 'Character');
        const key = messageKey(message, index, text);
        candidates.push({ id: key, key, speaker, text, chatIndex: index });
    });

    if (!applyWindow) return candidates;
    return candidates.slice(-Math.max(5, Number(settings.windowSize) || DEFAULT_SETTINGS.windowSize));
}

function countAssistantMessages() {
    const context = getContext();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    let count = 0;
    for (const message of chat) {
        if (!message || message.is_user || message.is_system || typeof message.mes !== 'string') continue;
        if (message.extra?.type === 'narrator' || message.extra?.type === 'system') continue;
        if (message.mes.trim().length >= 8) count += 1;
    }
    return count;
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
        source: String(pattern.source ?? ''),
        kind: String(pattern.kind ?? ''),
        scope: String(pattern.scope ?? ''),
        speaker: String(pattern.speaker ?? ''),
        label: String(pattern.label ?? ''),
        instruction: String(pattern.instruction ?? ''),
        examples: Array.isArray(pattern.examples) ? pattern.examples.slice(0, 3).map(String) : [String(pattern.example ?? '')].filter(Boolean),
    };
}

function isPatternIgnored(pattern, state) {
    if (state?.ignoredKeys?.includes(pattern.key)) return true;
    for (const ignored of state?.ignoredPatterns ?? []) {
        if (ignored?.key === pattern.key) return true;
        if (ignored?.scope !== pattern.scope || String(ignored?.speaker ?? '') !== String(pattern.speaker ?? '')) continue;
        if (pattern.source !== 'smart' && ignored?.source !== 'smart') continue;
        const labelSimilarity = tokenSimilarity(ignored?.label, pattern.label);
        if (labelSimilarity >= 0.72) return true;
        if (labelSimilarity >= 0.4 && tokenSimilarity(ignored?.instruction, pattern.instruction) >= 0.82) return true;
        const previousExamples = Array.isArray(ignored?.examples) ? ignored.examples : [];
        const currentExamples = Array.isArray(pattern.examples) ? pattern.examples : [pattern.example].filter(Boolean);
        if (previousExamples.some((a) => currentExamples.some((b) => tokenSimilarity(a, b) >= 0.72))) return true;
    }
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

function analyzeCurrentChat(force = false) {
    const settings = getSettings();
    const state = getChatState();
    const messages = collectAssistantMessages();
    const settingsKey = [
        settings.windowSize,
        settings.sensitivity,
        settings.narrationEnabled,
        settings.dialogueEnabled,
        settings.sourceMode,
    ].join('|');
    const ignoredFingerprint = fingerprintMessages((state?.ignoredPatterns ?? []).map((pattern, index) => ({
        id: index,
        speaker: pattern.speaker ?? '',
        text: `${pattern.key ?? ''}|${pattern.label ?? ''}|${pattern.instruction ?? ''}`,
    })));
    const fingerprint = `${fingerprintMessages(messages)}|${settingsKey}|${state?.ignoredKeys?.join(',') ?? ''}|${ignoredFingerprint}|${state?.smart?.lastRunAt ?? 0}|${state?.smart?.stale ? 1 : 0}`;
    if (!force && analysisCache?.fingerprint === fingerprint) return analysisCache;

    const localPatterns = detectPatterns(messages, settings, getContextNames());
    const smartPatterns = smartPatternsForMessages(state, messages);
    const patterns = mergePatterns(localPatterns, smartPatterns).filter((pattern) => !isPatternIgnored(pattern, state));
    const prompt = buildInjection(patterns, Number(settings.maxInjectedPatterns) || DEFAULT_SETTINGS.maxInjectedPatterns);

    analysisCache = {
        fingerprint,
        messages,
        localPatterns,
        smartPatterns,
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
        const analysis = analyzeCurrentChat(true);
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
    const selected = messages.slice(-Math.min(12, messages.length));
    return selected.map((message, index) => {
        const { narration, dialogue } = splitDialogueAndNarration(message.text);
        const narrationText = narration.join(' ').slice(0, 1100);
        const dialogueText = dialogue.join(' / ').slice(0, 900);
        return [
            `[M${index + 1} | speaker=${message.speaker}]`,
            narrationText ? `NARRATION: ${narrationText}` : '',
            dialogueText ? `DIALOGUE: ${dialogueText}` : '',
        ].filter(Boolean).join('\n');
    }).join('\n\n');
}

function smartPromptMessages(messages) {
    const system = `You analyze repetitive prose habits in roleplay assistant outputs. Return JSON only, with no markdown.\n\nSchema:\n{"patterns":[{"scope":"narration|dialogue","speaker":"speaker name or empty","label":"short Korean UI label","instruction":"concise English instruction for the next creative-writing response","examples":["short exact excerpts"],"count":3,"confidence":0.0}]}\n\nRules:\n- Find expressions, semantic reaction beats, dialogue responses, dialogue endings, question forms, or sentence structures repeated in at least 3 different message IDs.\n- Analyze dialogue separately for each speaker.\n- Do not flag names, plot facts, necessary terminology, pronouns, ordinary function words, or intentional character voice by itself.\n- Do flag a character's catchphrase only when it is functioning as repetitive filler rather than meaningful characterization.\n- Instructions must demand genuinely different construction, not synonym substitution.\n- Preserve characterization, relationship dynamics, plot, tone, intensity, and explicitness. Only vary wording and sentence construction.\n- Return at most 6 high-confidence patterns. If none qualify, return {"patterns":[]}.`;
    const user = `Inspect only the assistant outputs below. Message IDs are M1, M2, etc.\n\n${buildSmartInput(messages)}`;
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}

function parseSmartResponse(text) {
    const clean = String(text ?? '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('정밀 분석 응답에 JSON 객체가 없습니다.');
    const parsed = JSON.parse(clean.slice(start, end + 1));
    const patterns = Array.isArray(parsed?.patterns) ? parsed.patterns : [];
    return patterns.map((pattern, index) => normalizeSmartPattern(pattern, index)).filter(Boolean).slice(0, 6);
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
        const patterns = parseSmartResponse(response);
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
        invalidateAnalysis();
        analyzeCurrentChat(true);
        updateUi();
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
        const source = pattern.source === 'smart' ? 'AI 정밀' : '로컬';
        const speaker = pattern.scope === 'dialogue' && pattern.speaker ? ` · ${pattern.speaker}` : '';
        meta.textContent = `${pattern.count}개 답변에서 감지 · ${source}${speaker}`;

        const actions = document.createElement('div');
        actions.className = 'ttotto-pattern-actions';
        const allow = document.createElement('button');
        allow.type = 'button';
        allow.className = 'menu_button';
        allow.textContent = '이 패턴 허용';
        allow.addEventListener('click', () => ignorePattern(pattern));
        actions.append(allow);

        article.append(head, meta, actions);
        list.append(article);
    }

    empty.hidden = patterns.length !== 0;
    list.hidden = patterns.length === 0;
}

function ignorePattern(pattern) {
    const state = getChatState();
    if (!state) return;
    if (!state.ignoredKeys.includes(pattern.key)) state.ignoredKeys.push(pattern.key);
    state.ignoredKeys = state.ignoredKeys.slice(-200);
    if (!state.ignoredPatterns.some((ignored) => ignored?.key === pattern.key)) {
        state.ignoredPatterns.push(ignoredDescriptor(pattern));
    }
    state.ignoredPatterns = state.ignoredPatterns.slice(-200);
    saveChatState();
    invalidateAnalysis();
    analyzeCurrentChat(true);
    updateUi();
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

function updateUi() {
    if (!uiReady) return;
    const settings = getSettings();
    const state = getChatState(false);
    const analysis = analyzeCurrentChat(false);
    const enabled = settings.enabled && (state?.enabled ?? false);

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
    document.getElementById('ttotto-source-mode').value = settings.sourceMode;
    document.getElementById('ttotto-pattern-count').textContent = String(enabled ? analysis.patterns.length : 0);
    document.getElementById('ttotto-scope-summary').textContent = `최근 AI 답변 ${settings.windowSize}개 기준 · 서술 ${settings.narrationEnabled ? '켬' : '끔'} · 대사 ${settings.dialogueEnabled ? '켬' : '끔'}`;

    const header = document.getElementById('ttotto-header-status');
    if (!settings.enabled) header.textContent = '현재 꺼져 있어요';
    else if (!state) header.textContent = '채팅을 열면 분석을 시작해요';
    else if (!state.enabled) header.textContent = '현재 채팅에서는 꺼져 있어요';
    else header.textContent = `반복 표현 ${analysis.patterns.length}개 방지 중`;

    renderPatterns(enabled ? analysis.patterns : []);
    document.getElementById('ttotto-prompt-text').textContent = enabled && analysis.prompt ? analysis.prompt : '현재 주입할 내용이 없어요.';
    document.getElementById('ttotto-prompt-size').textContent = `${enabled ? analysis.prompt.length : 0}자`;
    document.getElementById('ttotto-run-smart').disabled = smartRunning || !settings.smartAnalysis || !state;
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
        if (key === 'windowSize' || key === 'sourceMode') markSmartResultsStale();
        if (key === 'smartAnalysis') {
            if (settings.smartAnalysis) {
                scheduleSmartAnalysis({ force: true });
            } else {
                clearTimeout(smartTimer);
                smartForcePending = false;
                forceSmartOnNextAnalysis = false;
                smartAbortController?.abort();
            }
        } else if ((key === 'windowSize' || key === 'sourceMode') && settings.smartAnalysis) {
            scheduleSmartAnalysis({ force: true });
        }
        invalidateAnalysis();
        if (!settings.enabled) clearInjectedPrompt();
        analyzeCurrentChat(true);
        updateUi();
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
    bindSetting('ttotto-source-mode', 'sourceMode', String);

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
        analyzeCurrentChat(true);
        updateUi();
        toastr.success('현재 채팅을 다시 분석했어요.', '🌀또또');
    });

    document.getElementById('ttotto-run-smart').addEventListener('click', () => {
        void runSmartAnalysis({ manual: true });
    });

    document.getElementById('ttotto-clear-ignored').addEventListener('click', async () => {
        if (!await confirmAction('🌀또또', '현재 채팅에서 허용한 반복 패턴 목록을 초기화할까요?')) return;
        const state = getChatState();
        if (!state) return;
        state.ignoredKeys = [];
        state.ignoredPatterns = [];
        saveChatState();
        invalidateAnalysis();
        updateUi();
        toastr.success('허용 목록을 초기화했어요.', '🌀또또');
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
}

async function initializeUi() {
    if (document.getElementById('ttotto-settings')) {
        uiReady = true;
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
    analyzeCurrentChat(true);
    updateUi();
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

    listen('MESSAGE_RECEIVED', () => scheduleAnalysis({ smart: true, delay: 350 }));
    listen('CHARACTER_MESSAGE_RENDERED', () => scheduleAnalysis({ smart: true, delay: 650 }));
    const handleHistoryMutation = () => {
        markSmartResultsStale();
        scheduleAnalysis({ smart: true, forceSmart: true, delay: 250 });
    };
    listen('MESSAGE_EDITED', handleHistoryMutation);
    listen('MESSAGE_DELETED', handleHistoryMutation);
    listen('MESSAGE_SWIPED', handleHistoryMutation);
    listen('GENERATION_ENDED', clearInjectedPrompt);
    listen('GENERATION_STOPPED', clearInjectedPrompt);
    listen('CHAT_CHANGED', () => {
        smartAbortController?.abort();
        clearTimeout(smartTimer);
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
    registerEvents();
    await initializeUi();
    console.log(`${LOG_PREFIX} v${EXTENSION_VERSION} 로드 완료`);
}

export function onEnable() {
    runtimeActive = true;
    registerEvents();
    scheduleAnalysis({ smart: false, delay: 50 });
}

export function onDisable() {
    runtimeActive = false;
    clearTimeout(analysisTimer);
    clearTimeout(smartTimer);
    smartForcePending = false;
    forceSmartOnNextAnalysis = false;
    smartAbortController?.abort();
    unregisterEvents();
    clearInjectedPrompt();
}

export function onClean() {
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
