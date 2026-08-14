import test from 'node:test';
import assert from 'node:assert/strict';

test('장기 채팅 갱신과 확장 수명주기를 안전하게 처리한다', async () => {
    const listeners = new Map();
    const promptCalls = [];
    const eventTypes = {
        APP_READY: 'app_ready',
        MESSAGE_RECEIVED: 'message_received',
        CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
        MESSAGE_EDITED: 'message_edited',
        MESSAGE_DELETED: 'message_deleted',
        MESSAGE_SWIPED: 'message_swiped',
        GENERATION_ENDED: 'generation_ended',
        GENERATION_STOPPED: 'generation_stopped',
        CHAT_CHANGED: 'chat_changed',
        CHAT_CREATED: 'chat_created',
        CONNECTION_PROFILE_LOADED: 'connection_profile_loaded',
    };
    const eventSource = {
        on(event, handler) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event).add(handler);
        },
        removeListener(event, handler) {
            listeners.get(event)?.delete(handler);
        },
    };
    let resolveSmartRequest;
    const context = {
        eventTypes,
        eventSource,
        extensionSettings: {},
        chatMetadata: {
            ttotto: {
                enabled: true,
                ignoredKeys: [],
                ignoredPatterns: [],
                smart: { messageKeys: [], patterns: [], lastAssistantTotal: 0, stale: false },
            },
        },
        chatId: 'runtime-test',
        groupId: null,
        characterId: 0,
        name1: 'Dana',
        name2: 'Peter',
        groups: [],
        characters: [{ name: 'Peter', avatar: 'peter.png' }],
        chat: [
            { mes: 'His jaw tightened as he looked away from her.', name: 'Peter', send_date: 1 },
            { mes: 'His jaw tightened when the door clicked shut.', name: 'Peter', send_date: 2 },
            { mes: 'His jaw tightened at the sound of her voice.', name: 'Peter', send_date: 3 },
        ],
        setExtensionPrompt(...args) {
            promptCalls.push(args);
        },
        saveSettingsDebounced() {},
        saveMetadataDebounced() {},
        generateRaw() {
            return new Promise((resolve) => {
                resolveSmartRequest = resolve;
            });
        },
    };

    globalThis.SillyTavern = { getContext: () => context };
    globalThis.toastr = { info() {}, success() {}, error() {} };

    const module = await import(`../index.js?runtime=${Date.now()}`);
    assert.equal(module.shouldRunSmartAnalysis(23, 20, 3), true);
    assert.equal(module.shouldRunSmartAnalysis(21, 20, 3), false);
    assert.equal(module.shouldRunSmartAnalysis(19, 20, 3), true);
    assert.equal(module.shouldRunSmartAnalysis(20, 20, 3, true), true);

    module.onEnable();
    assert.ok(listeners.get(eventTypes.GENERATION_ENDED)?.size);
    assert.ok(listeners.get(eventTypes.GENERATION_STOPPED)?.size);

    context.extensionSettings.ttotto = {
        enabled: true,
        windowSize: 20,
        sensitivity: 'normal',
        narrationEnabled: true,
        dialogueEnabled: true,
        smartAnalysis: true,
        smartInterval: 3,
        smartProfileId: '',
        smartMaxTokens: 900,
        maxInjectedPatterns: 6,
        sourceMode: 'auto',
    };
    context.chatMetadata.ttotto.smart.lastAssistantTotal = 20;
    context.chat = Array.from({ length: 23 }, (_, index) => ({
        mes: `His jaw tightened as he looked away from her response ${index}.`,
        name: 'Peter',
        send_date: index + 1,
    }));
    for (const handler of listeners.get(eventTypes.MESSAGE_RECEIVED) ?? []) handler();
    await new Promise((resolve) => setTimeout(resolve, 1350));
    assert.equal(typeof resolveSmartRequest, 'function');

    await globalThis.ttottoGenerationInterceptor([], 0, () => {}, 'normal');
    assert.ok(promptCalls.some((call) => typeof call[1] === 'string' && call[1].includes('<ttotto_anti_repetition>')));
    resolveSmartRequest('{"patterns":[]}');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(context.chatMetadata.ttotto.smart.lastAssistantTotal, 23);

    for (const handler of listeners.get(eventTypes.GENERATION_ENDED) ?? []) handler();
    assert.equal(promptCalls.at(-1)[1], '');

    module.onDisable();
    assert.equal(listeners.get(eventTypes.GENERATION_ENDED)?.size ?? 0, 0);
    const beforeDisabledCall = promptCalls.length;
    await globalThis.ttottoGenerationInterceptor([], 0, () => {}, 'normal');
    assert.equal(promptCalls.length, beforeDisabledCall + 1);
    assert.equal(promptCalls.at(-1)[1], '');
});
