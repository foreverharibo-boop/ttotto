import test from 'node:test';
import assert from 'node:assert/strict';

test('금지어는 독립된 실제 표현일 때만 일치한다', async () => {
    const context = {
        eventTypes: { APP_READY: 'app_ready' },
        eventSource: { on() {}, removeListener() {} },
        extensionSettings: {}, chatMetadata: {},
        chatId: 'exact-ban-test', groupId: null, characterId: 0,
        characters: [], groups: [], chat: [],
        setExtensionPrompt() {}, saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    globalThis.SillyTavern = { getContext: () => context };
    const module = await import(`../index.js?exact-ban=${Date.now()}`);
    assert.equal(module.containsExactBanTerm('The anchor dropped.', 'anchor'), true);
    assert.equal(module.containsExactBanTerm('He was anchored in place.', 'anchor'), false);
    assert.equal(module.containsExactBanTerm('His jawline tightened.', 'jaw'), false);
    assert.equal(module.containsExactBanTerm('His jaw tightened.', 'jaw'), true);
    assert.equal(module.containsExactBanTerm('A SHIVERS   DOWN HER SPINE reaction.', 'shivers down her spine'), true);
    assert.equal(module.containsExactBanTerm('포식자가 다가왔다.', '포식자'), true);
    assert.equal(module.containsExactBanTerm('포식자처럼 다가왔다.', '포식자'), true);
    assert.equal(
        module.stripBanCounterText('<thinking>청년을 피해야 한다.</thinking><status>청년</status>그는 문을 닫았다.'),
        '그는 문을 닫았다.',
    );
    assert.equal(module.stripBanCounterText('<thinking>청년을 피해야 한다.'), '');
});

test('전역 금지어는 캐릭터별 중복을 자동 정리하고 전역 삭제로만 완전히 제거된다', async () => {
    let settingsSaveCount = 0;
    const context = {
        eventTypes: { APP_READY: 'app_ready' },
        eventSource: { on() {}, removeListener() {} },
        extensionSettings: {
            ttotto: {
                globalBans: [' VISE ', 'anchor'],
                globalBanIds: { vise: 'global-vise-id', anchor: 'global-anchor-id' },
                characterUuids: { 'peter.png': 'uuid-peter' },
                characterBans: {
                    'uuid-peter': [
                        { id: 'character-vise-id', type: 'term', term: 'vise', characterUuid: 'uuid-peter' },
                        { id: 'character-jaw-id', type: 'term', term: 'jaw', characterUuid: 'uuid-peter' },
                    ],
                },
            },
        },
        chatMetadata: {
            ttotto: {
                enabled: true,
                banOffenseVersion: 3,
                banOffenses: {
                    'global|global-vise-id': { evidence: [{ key: 'old-vise-hit' }] },
                },
                lastBanHits: [{ term: 'VISE', characterUuid: '', banId: 'global-vise-id' }],
                smart: { patterns: [], messageKeys: [] },
            },
        },
        chatId: 'global-delete-test', groupId: null, characterId: 0,
        characters: [{ name: 'Peter', avatar: 'peter.png' }], groups: [], chat: [],
        setExtensionPrompt() {},
        saveSettingsDebounced() { settingsSaveCount += 1; },
        saveMetadataDebounced() {},
    };
    globalThis.SillyTavern = { getContext: () => context };
    const module = await import(`../index.js?global-delete=${Date.now()}`);

    const duplicate = module.addManualBan('uuid-peter', 'VISE');
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.reason, /이미 전역 금지어/);
    assert.deepEqual(context.extensionSettings.ttotto.characterBans['uuid-peter'].map((ban) => ban.term), ['jaw']);

    const promoted = module.addGlobalBan('jaw');
    assert.equal(promoted.ok, true);
    assert.equal(promoted.removedCharacterDuplicates, 1);
    assert.deepEqual(context.extensionSettings.ttotto.characterBans['uuid-peter'], []);
    assert.deepEqual(context.extensionSettings.ttotto.globalBans, [' VISE ', 'anchor', 'jaw']);

    assert.equal(module.removeGlobalBan('vise'), true);
    assert.deepEqual(context.extensionSettings.ttotto.globalBans, ['anchor', 'jaw']);
    assert.equal(context.extensionSettings.ttotto.globalBanIds.vise, undefined);
    assert.equal(context.chatMetadata.ttotto.banOffenses['global|global-vise-id'], undefined);
    assert.deepEqual(context.chatMetadata.ttotto.lastBanHits, []);
    assert.ok(settingsSaveCount >= 1);
    assert.equal(module.removeGlobalBan('does-not-exist'), false);
});

test('불꽃은 숨김·태그·번역 표시문을 빼고 실제 본문을 메시지당 한 번만 센다', async () => {
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
    };
    const context = {
        eventTypes,
        eventSource: {
            on(event, handler) {
                if (!listeners.has(event)) listeners.set(event, new Set());
                listeners.get(event).add(handler);
            },
            removeListener(event, handler) { listeners.get(event)?.delete(handler); },
        },
        extensionSettings: {
            ttotto: {
                enabled: true,
                globalBans: ['anchor', 'jaw'],
                globalBanIds: { anchor: 'global-anchor-id', jaw: 'global-jaw-id' },
                characterUuids: { 'peter.png': 'uuid-peter' },
                characterAllowances: {}, characterBans: {}, characterHistory: {},
                excludeAllTaggedBlocks: false,
            },
        },
        chatMetadata: {
            ttotto: {
                enabled: true,
                banOffenseVersion: 1,
                banOffenses: { 'global|anchor': { count: 74 } },
                banOffenseLastKey: 'old-broken-key',
                lastBanHits: [{ term: 'anchor', characterUuid: '' }],
                smart: { patterns: [], messageKeys: [] },
            },
        },
        chatId: 'ban-counter-test', groupId: null, characterId: 0,
        name1: 'User', name2: 'Peter', groups: [],
        characters: [{ name: 'Peter', avatar: 'peter.png' }],
        chat: [],
        setExtensionPrompt(...args) { promptCalls.push(args); },
        saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.toastr = { info() {}, success() {}, error() {} };
    const module = await import(`../index.js?ban-counter=${Date.now()}`);
    module.onEnable();
    const receive = (payload) => {
        for (const handler of listeners.get(eventTypes.MESSAGE_RECEIVED) ?? []) handler(payload);
    };
    const render = (payload) => {
        for (const handler of listeners.get(eventTypes.CHARACTER_MESSAGE_RENDERED) ?? []) handler(payload);
    };
    const emit = (event, payload) => {
        for (const handler of listeners.get(event) ?? []) handler(payload);
    };

    context.chat.push({
        mes: '<thinking>anchor jaw</thinking><Info_panel>anchor</Info_panel><div>jaw</div>He remained anchored in place.',
        extra: { display_text: '화면 번역문에는 anchor와 jaw가 있음' },
        name: 'Peter', original_avatar: 'peter.png', send_date: 1,
    });
    receive(0);
    render(0);
    assert.equal(context.chatMetadata.ttotto.banOffenseVersion, 3);
    assert.deepEqual(context.chatMetadata.ttotto.banOffenses, {});
    assert.deepEqual(context.chatMetadata.ttotto.lastBanHits, []);

    context.chat.push({
        mes: 'He dropped the anchor and rubbed his jaw.',
        extra: { display_text: '그는 무언가를 내리고 턱을 문질렀다.' },
        name: 'Peter', original_avatar: 'peter.png', send_date: 2,
    });
    receive(1);
    assert.deepEqual(context.chatMetadata.ttotto.banOffenses, {}, '렌더링 전에는 세지 않음');
    context.chat[1].mes = '화면 번역문에는 금지된 영어 표현이 없음';
    render(1);
    render(1);
    assert.equal(context.chatMetadata.ttotto.banOffenses['global|global-anchor-id'].count, 1);
    assert.equal(context.chatMetadata.ttotto.banOffenses['global|global-jaw-id'].count, 1);
    assert.equal(context.chatMetadata.ttotto.banOffenses['global|global-anchor-id'].evidence.length, 1);
    assert.match(context.chatMetadata.ttotto.banOffenses['global|global-anchor-id'].evidence[0].snippet, /anchor/i);

    context.chat.push({
        mes: 'The anchor scraped across the floor.',
        name: 'Peter', original_avatar: 'peter.png', send_date: 3,
    });
    receive(2);
    render(2);
    assert.equal(context.chatMetadata.ttotto.banOffenses['global|global-anchor-id'].count, 2);
    assert.equal(context.chatMetadata.ttotto.banOffenses['global|global-jaw-id'].count, 1);

    await globalThis.ttottoGenerationInterceptor([], 0, () => {}, 'normal');
    assert.match(promptCalls.at(-1)[1], /violated 2 time\(s\)/);

    context.extensionSettings.ttotto.globalBanIds.anchor = 'global-anchor-new-registration';
    await globalThis.ttottoGenerationInterceptor([], 0, () => {}, 'normal');
    assert.equal(context.chatMetadata.ttotto.banOffenses['global|global-anchor-new-registration'], undefined);
    assert.doesNotMatch(promptCalls.at(-1)[1], /violated 2 time\(s\)/);

    context.chat[1].mes = 'He quietly closed the door.';
    emit(eventTypes.MESSAGE_EDITED, 1);
    assert.equal(context.chatMetadata.ttotto.banOffenses['global|global-anchor-id'].count, 1);
    assert.equal(context.chatMetadata.ttotto.banOffenses['global|global-jaw-id'], undefined);

    context.chat.splice(2, 1);
    emit(eventTypes.MESSAGE_DELETED, 2);
    assert.equal(context.chatMetadata.ttotto.banOffenses['global|global-anchor-id'], undefined);

    context.extensionSettings.ttotto.globalBanIds.anchor = 'global-anchor-id';
    context.chat.push({
        mes: 'He waited without speaking.', swipe_id: 0,
        swipes: ['He waited without speaking.', 'He dropped the anchor.'],
        swipe_info: [{ extra: {} }, { extra: {} }],
        name: 'Peter', original_avatar: 'peter.png', send_date: 4,
    });
    receive(2);
    render(2);
    assert.equal(context.chatMetadata.ttotto.banOffenses['global|global-anchor-id'], undefined);
    context.chat[2].swipe_id = 1;
    context.chat[2].mes = 'He dropped the anchor.';
    emit(eventTypes.MESSAGE_SWIPED, 2);
    assert.equal(context.chatMetadata.ttotto.banOffenses['global|global-anchor-id'].count, 1);
    context.chat[2].swipe_id = 0;
    context.chat[2].mes = 'He waited without speaking.';
    emit(eventTypes.MESSAGE_SWIPED, 2);
    assert.equal(context.chatMetadata.ttotto.banOffenses['global|global-anchor-id'], undefined);

    context.chat.push({
        mes: 'An old history message mentions the anchor.',
        name: 'Peter', original_avatar: 'peter.png', send_date: 5,
    });
    render(3);
    assert.equal(
        context.chatMetadata.ttotto.banOffenses['global|global-anchor-id'],
        undefined,
        '채팅을 다시 열며 과거 메시지가 렌더링돼도 새 위반으로 세지 않음',
    );
    module.onDisable();
});

test('장기 채팅 갱신과 확장 수명주기를 안전하게 처리한다', async () => {
    const listeners = new Map();
    const promptCalls = [];
    const eventTypes = {
        APP_READY: 'app_ready',
        MESSAGE_RECEIVED: 'message_received',
        CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
        MESSAGE_EDITED: 'message_edited',
        MESSAGE_UPDATED: 'message_updated',
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
            { mes: '번역문 1', extra: { ttotto_source_text: 'His jaw tightened as he looked away from her.' }, name: 'Peter', send_date: 1 },
            { mes: '번역문 2', extra: { ttotto_source_text: 'His jaw tightened when the door clicked shut.' }, name: 'Peter', send_date: 2 },
            { mes: '번역문 3', extra: { ttotto_source_text: 'His jaw tightened at the sound of her voice.' }, name: 'Peter', send_date: 3 },
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
    assert.ok(listeners.get(eventTypes.MESSAGE_UPDATED)?.size);
    assert.ok(listeners.get(eventTypes.CHARACTER_MESSAGE_RENDERED)?.size);

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
        sourceMode: 'original',
    };
    context.chatMetadata.ttotto.smart.lastAssistantTotal = 20;
    context.chat = Array.from({ length: 23 }, (_, index) => ({
        mes: `번역문 ${index}`,
        extra: { ttotto_source_text: `His jaw tightened as he looked away from her response ${index}.` },
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
    const characterUuids = context.extensionSettings.ttotto.characterUuids;
    assert.equal(Object.keys(characterUuids).length, 1);
    assert.ok(characterUuids['peter.png']);

    for (const handler of listeners.get(eventTypes.GENERATION_ENDED) ?? []) handler();
    assert.equal(promptCalls.at(-1)[1], '');

    module.onDisable();
    assert.equal(listeners.get(eventTypes.GENERATION_ENDED)?.size ?? 0, 0);
    assert.equal(listeners.get(eventTypes.MESSAGE_UPDATED)?.size ?? 0, 0);
    const beforeDisabledCall = promptCalls.length;
    await globalThis.ttottoGenerationInterceptor([], 0, () => {}, 'normal');
    assert.equal(promptCalls.length, beforeDisabledCall + 4);
    assert.deepEqual(promptCalls.slice(-4).map((call) => call[0]), [
        'ttotto_anti_repetition',
        'ttotto_weave_metagaming',
        'ttotto_weave_character_ai',
        'ttotto_important_prompts',
    ]);
    assert.equal(promptCalls.at(-1)[1], '');
});

test('금지어·에코·WEAVE는 depth 0에서 설정한 묶음 순서를 따르고 WEAVE 내부는 붙어 있다', async () => {
    const promptCalls = [];
    const context = {
        eventTypes: { APP_READY: 'app_ready' },
        eventSource: { on() {}, removeListener() {} },
        extensionSettings: {
            ttotto: {
                enabled: true,
                echoPreventionEnabled: true,
                metagamingPromptEnabled: true,
                characterAiPromptEnabled: true,
                globalBans: ['forbidden phrase'],
                globalBanIds: { 'forbidden phrase': 'global-forbidden-id' },
            },
        },
        chatMetadata: { ttotto: { enabled: true, smart: { patterns: [], messageKeys: [] } } },
        chatId: 'important-prompt-test', groupId: null, characterId: 0,
        characters: [], groups: [],
        chat: [{ is_user: true, mes: '“Do not repeat this line.”' }],
        setExtensionPrompt(...args) { promptCalls.push(args); },
        saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.toastr = { info() {}, success() {}, error() {} };
    const module = await import(`../index.js?important-prompt=${Date.now()}`);

    await globalThis.ttottoGenerationInterceptor(context.chat, 0, () => {}, 'normal');
    const active = promptCalls.filter((call) => call[1]);
    assert.equal(active.length, 1);
    assert.equal(active[0][0], 'ttotto_anti_repetition');
    assert.equal(active[0][2], 1);
    assert.equal(active[0][3], 0);
    assert.equal(active[0][5], 0);
    const injected = active[0][1];
    const metaIndex = injected.indexOf('<ANTI_METAGAMING>');
    const characterIndex = injected.indexOf('<CHARACTER_KNOWLEDGE_AND_CONTEXT>');
    const banIndex = injected.indexOf('<ttotto_anti_repetition>');
    const echoIndex = injected.indexOf('<ttotto_anti_echo>');
    assert.ok(banIndex >= 0);
    assert.ok(echoIndex > banIndex);
    assert.ok(metaIndex > echoIndex);
    assert.ok(characterIndex > metaIndex);
    assert.match(injected, /## CHARACTER_KNOWLEDGE_BOUNDARY/);

    const permute = (items) => items.length <= 1
        ? [items]
        : items.flatMap((item, index) => permute(items.filter((_, candidate) => candidate !== index))
            .map((rest) => [item, ...rest]));
    const permutations = permute(['ban', 'echo', 'weave']);
    assert.equal(permutations.length, 6);
    for (const promptOrder of permutations) {
        const assembled = module.buildCompleteGenerationInjection(
            '<BAN_MARKER>forbidden</BAN_MARKER>',
            {
                echoPreventionEnabled: true,
                metagamingPromptEnabled: true,
                characterAiPromptEnabled: true,
                promptOrder,
            },
            'normal',
            context.chat,
            context.chat,
        );
        const positions = {
            ban: assembled.indexOf('<BAN_MARKER>'),
            echo: assembled.indexOf('<ttotto_anti_echo>'),
            weave: assembled.indexOf('<ANTI_METAGAMING>'),
        };
        assert.ok(Object.values(positions).every((position) => position >= 0));
        assert.ok(assembled.indexOf('<CHARACTER_KNOWLEDGE_AND_CONTEXT>') > positions.weave);
        assert.deepEqual(
            [...promptOrder].sort((left, right) => positions[left] - positions[right]),
            promptOrder,
            `주입 순서: ${promptOrder.join(' → ')}`,
        );
    }
    assert.deepEqual(
        module.normalizePromptOrder(['echo', 'metagaming', 'characterAi', 'ban']),
        ['echo', 'weave', 'ban'],
        '구버전의 두 WEAVE 항목을 먼저 등장한 한 자리로 합침',
    );
    assert.deepEqual(
        module.normalizePromptOrder(['echo', 'echo', 'unknown']),
        ['echo', 'ban', 'weave'],
    );

    promptCalls.length = 0;
    context.extensionSettings.ttotto.metagamingPromptEnabled = false;
    context.extensionSettings.ttotto.characterAiPromptEnabled = false;
    context.extensionSettings.ttotto.echoPreventionEnabled = false;
    context.extensionSettings.ttotto.globalBans = [];
    await globalThis.ttottoGenerationInterceptor([], 0, () => {}, 'normal');
    assert.equal(promptCalls.filter((call) => call[1]).length, 0);
});

test('금지어·에코는 서로 다른 프리셋 위치에, WEAVE 두 원본은 한 위치에 함께 삽입된다', async () => {
    const context = {
        eventTypes: { APP_READY: 'app_ready' },
        eventSource: { on() {}, removeListener() {} },
        extensionSettings: {}, chatMetadata: {}, chat: [], characters: [], groups: [],
        setExtensionPrompt() {}, saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    globalThis.SillyTavern = { getContext: () => context };
    const module = await import(`../index.js?preset-placement=${Date.now()}`);
    const messages = [
        { role: 'system', content: 'System Alpha content.' },
        { role: 'system', content: 'System Beta content.' },
        { role: 'user', content: 'Hello' },
    ];
    const result = module.insertPresetRelativeGroups(messages, [
        { key: 'ban', position: 'preset_after_alpha', content: '<BAN />' },
        { key: 'echo', position: 'preset_before_beta', content: '<ECHO />' },
        { key: 'weave', position: 'preset_after_beta', content: '<ANTI_METAGAMING>meta</ANTI_METAGAMING>\n\n<CHARACTER_KNOWLEDGE_AND_CONTEXT>character</CHARACTER_KNOWLEDGE_AND_CONTEXT>' },
    ], [
        { identifier: 'alpha', name: 'Alpha', content: 'System Alpha content.' },
        { identifier: 'beta', name: 'Beta', content: 'System Beta content.' },
    ]);
    assert.equal(result.inserted.length, 3);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(messages.map((message) => message.content), [
        'System Alpha content.',
        '<BAN />',
        '<ECHO />',
        'System Beta content.',
        '<ANTI_METAGAMING>meta</ANTI_METAGAMING>\n\n<CHARACTER_KNOWLEDGE_AND_CONTEXT>character</CHARACTER_KNOWLEDGE_AND_CONTEXT>',
        'Hello',
    ]);
});

test('최종 요청에 없는 depth 0·위치 실패 묶음만 답변 직전에 보충하고 중복은 만들지 않는다', async () => {
    const context = {
        eventTypes: { APP_READY: 'app_ready' },
        eventSource: { on() {}, removeListener() {} },
        extensionSettings: {}, chatMetadata: {}, chat: [], characters: [], groups: [],
        setExtensionPrompt() {}, saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    globalThis.SillyTavern = { getContext: () => context };
    const module = await import(`../index.js?final-request-fallback=${Date.now()}`);
    const messages = [
        { role: 'system', content: '<ttotto_anti_repetition>already present</ttotto_anti_repetition>' },
        { role: 'user', content: 'Hello' },
    ];
    const appended = module.appendGenerationGroups(messages, [
        { key: 'ban', content: '<ttotto_anti_repetition>new form</ttotto_anti_repetition>' },
        { key: 'echo', content: '<ttotto_anti_echo>echo rules</ttotto_anti_echo>' },
        { key: 'weave', content: '<ANTI_METAGAMING>meta</ANTI_METAGAMING>\n\n<CHARACTER_KNOWLEDGE_AND_CONTEXT>character</CHARACTER_KNOWLEDGE_AND_CONTEXT>' },
    ]);
    assert.deepEqual(appended, ['echo', 'weave']);
    assert.equal(messages.length, 3);
    assert.doesNotMatch(messages.at(-1).content, /ttotto_anti_repetition/);
    assert.match(messages.at(-1).content, /ttotto_anti_echo/);
    assert.match(messages.at(-1).content, /ANTI_METAGAMING/);
    assert.match(messages.at(-1).content, /CHARACTER_KNOWLEDGE_AND_CONTEXT/);
});

test('일반 생성 type이 비어 있어도 최종 Chat Completion messages에 WEAVE를 보충한다', async () => {
    const listeners = new Map();
    const eventTypes = {
        APP_READY: 'app_ready',
        GENERATION_STARTED: 'generation_started',
        CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
        CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
    };
    const context = {
        eventTypes,
        eventSource: {
            on(event, handler) {
                if (!listeners.has(event)) listeners.set(event, new Set());
                listeners.get(event).add(handler);
            },
            removeListener(event, handler) { listeners.get(event)?.delete(handler); },
        },
        extensionSettings: {
            ttotto: {
                enabled: true,
                echoPreventionEnabled: false,
                metagamingPromptEnabled: true,
                characterAiPromptEnabled: true,
                weavePromptPosition: 'depth_0',
            },
        },
        chatMetadata: { ttotto: { enabled: true, smart: { patterns: [], messageKeys: [] } } },
        chatId: 'empty-generation-type', groupId: null, characterId: 0,
        name1: 'User', name2: 'Character', groups: [], characters: [],
        chat: [{ is_user: true, mes: 'Continue the scene.' }],
        setExtensionPrompt() {}, saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.toastr = { info() {}, success() {}, error() {} };
    const module = await import(`../index.js?empty-type-final-prompt=${Date.now()}`);
    module.onEnable();

    // generate_interceptor가 호출되지 않는 환경에서도 생성 시작 → 실제 요청 데이터 경로로 들어간다.
    for (const handler of listeners.get(eventTypes.GENERATION_STARTED) ?? []) handler(undefined);
    const settingsOnlyMessages = [{ role: 'user', content: 'Continue the scene.' }];
    const settingsOnlyPayload = { messages: settingsOnlyMessages };
    for (const handler of listeners.get(eventTypes.CHAT_COMPLETION_SETTINGS_READY) ?? []) {
        handler(settingsOnlyPayload);
    }
    assert.equal(settingsOnlyMessages.length, 1, '공유 메시지 배열은 수정하지 않는다');
    const settingsOnlyPrompt = settingsOnlyPayload.messages.map((message) => message.content).join('\n');
    assert.match(settingsOnlyPrompt, /<ANTI_METAGAMING>/);
    assert.match(settingsOnlyPrompt, /<CHARACTER_KNOWLEDGE_AND_CONTEXT>/);

    // Interceptor must not insert synthetic assistant messages into the chat array.
    const interceptorChat = [{ is_user: true, mes: 'Continue the scene.' }];
    await globalThis.ttottoGenerationInterceptor(interceptorChat, 0, () => {}, undefined);
    const interceptorPrompt = interceptorChat.map((message) => message.mes ?? '').join('\n');
    assert.doesNotMatch(interceptorPrompt, /<ANTI_METAGAMING>/);
    assert.doesNotMatch(interceptorPrompt, /<CHARACTER_KNOWLEDGE_AND_CONTEXT>/);
    const finalMessages = [{ role: 'user', content: 'Continue the scene.' }];
    const finalPayload = { messages: finalMessages };
    for (const handler of listeners.get(eventTypes.CHAT_COMPLETION_PROMPT_READY) ?? []) {
        handler({ chat: finalMessages, dryRun: false });
    }
    for (const handler of listeners.get(eventTypes.CHAT_COMPLETION_SETTINGS_READY) ?? []) {
        handler(finalPayload);
    }

    const sentPrompt = finalPayload.messages.map((message) => message.content).join('\n');
    assert.match(sentPrompt, /<ANTI_METAGAMING>/);
    assert.match(sentPrompt, /<CHARACTER_KNOWLEDGE_AND_CONTEXT>/);
    assert.equal((sentPrompt.match(/<ANTI_METAGAMING>/g) ?? []).length, 1);
    assert.equal((sentPrompt.match(/<CHARACTER_KNOWLEDGE_AND_CONTEXT>/g) ?? []).length, 1);
    assert.ok(sentPrompt.indexOf('<ANTI_METAGAMING>') < sentPrompt.indexOf('<CHARACTER_KNOWLEDGE_AND_CONTEXT>'));
    module.onDisable();
});

test('보조 quiet 생성은 본 생성의 WEAVE를 소비하지 않고 실제 normal 전송에만 태그가 남는다', async () => {
    const listeners = new Map();
    const events = {
        APP_READY: 'app_ready', GENERATION_STARTED: 'generation_started',
        CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
        CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
    };
    const promptCalls = [];
    const requests = [];
    const context = {
        eventTypes: events,
        eventSource: {
            on(event, handler) { listeners.set(event, handler); },
            removeListener(event) { listeners.delete(event); },
        },
        extensionSettings: { ttotto: {
            enabled: true, echoPreventionEnabled: false,
            metagamingPromptEnabled: true, characterAiPromptEnabled: true,
            weavePromptPosition: 'preset_after_target',
        } },
        chatMetadata: { ttotto: { enabled: true, smart: { patterns: [], messageKeys: [] } } },
        chatId: 'nested-auxiliary', characterId: 0, characters: [], groups: [],
        chat: [{ is_user: true, mes: 'Main scene turn.' }],
        oaiSettings: {
            prompts: [{ identifier: 'target', content: 'Preset target instruction.' }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'target', enabled: true }] }],
        },
        setExtensionPrompt(...args) { promptCalls.push(args); },
        saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        requests.push(JSON.parse(options.body));
        return { ok: true };
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.toastr = { info() {}, success() {}, error() {} };
    const module = await import(`../index.js?nested-auxiliary=${Date.now()}`);
    module.onEnable();
    try {
        await globalThis.ttottoGenerationInterceptor([...context.chat], 0, () => {}, 'normal');
        // generateRaw emits PROMPT_READY without GENERATION_STARTED or an interceptor.
        const auxiliary = { type: 'quiet', messages: [{ role: 'user', content: 'Analyze state only.' }] };
        listeners.get(events.CHAT_COMPLETION_PROMPT_READY)?.({ chat: auxiliary.messages, dryRun: false });
        assert.equal(auxiliary.messages.length, 1, '보조 raw 프롬프트에는 본채팅 지시문을 넣으면 안 됨');
        listeners.get(events.CHAT_COMPLETION_SETTINGS_READY)(auxiliary);
        await globalThis.fetch('/api/backends/chat-completions/generate', {
            method: 'POST', body: JSON.stringify(auxiliary),
        });
        assert.doesNotMatch(JSON.stringify(requests.at(-1)), /ANTI_METAGAMING/);
        // quiet Generate invokes the interceptor too: it must not erase the main plan.
        const beforeQuiet = promptCalls.length;
        await globalThis.ttottoGenerationInterceptor([], 0, () => {}, 'quiet');
        assert.equal(promptCalls.length, beforeQuiet);
        listeners.get(events.GENERATION_STARTED)('quiet', {}, false);
        listeners.get(events.GENERATION_STARTED)('normal', {}, true); // dry-run must not erase it either
        const main = { type: 'normal', messages: [
            { role: 'system', content: 'Preset target instruction.' },
            { role: 'user', content: 'Main scene turn.' },
        ] };
        listeners.get(events.CHAT_COMPLETION_SETTINGS_READY)(main);
        assert.match(main.messages[1].content, /<ANTI_METAGAMING>/);
        // A later extension may replace the serialized messages: the fetch guard restores them.
        main.messages = main.messages.filter((message) => !message.content.includes('<ANTI_METAGAMING>'));
        await globalThis.fetch('/api/backends/chat-completions/generate', {
            method: 'POST', body: JSON.stringify(main),
        });
        const sent = JSON.stringify(requests.at(-1));
        assert.equal((sent.match(/<ANTI_METAGAMING>/g) ?? []).length, 1);
        assert.equal((sent.match(/<CHARACTER_KNOWLEDGE_AND_CONTEXT>/g) ?? []).length, 1);
        assert.match(requests.at(-1).messages[1].content, /<ANTI_METAGAMING>/);
        assert.equal(requests.at(-1).messages[2].role, 'user');

        // Skip-once must not be undone by the independent final-payload fallback.
        context.chatMetadata.ttotto.skipNextGeneration = true;
        await globalThis.ttottoGenerationInterceptor([...context.chat], 0, () => {}, 'normal');
        const skipped = { type: 'normal', messages: [{ role: 'user', content: 'Skipped turn.' }] };
        listeners.get(events.CHAT_COMPLETION_SETTINGS_READY)(skipped);
        await globalThis.fetch('/api/backends/chat-completions/generate', {
            method: 'POST', body: JSON.stringify(skipped),
        });
        assert.doesNotMatch(JSON.stringify(requests.at(-1)), /ANTI_METAGAMING/);
    } finally {
        module.onDisable();
        globalThis.fetch = originalFetch;
    }
});

test('합쳐진 프리셋의 항목 경계에 삽입하고 공백 차이와 developer 역할을 보존한다', async () => {
    const context = { eventTypes: { APP_READY: 'app_ready' }, eventSource: { on() {}, removeListener() {} }, extensionSettings: {}, chatMetadata: {}, chat: [] };
    globalThis.SillyTavern = { getContext: () => context };
    const module = await import(`../index.js?merged-boundaries=${Date.now()}`);
    const messages = [{ role: 'developer', name: 'rules', content: 'FIRST\n\nTarget   line one.\r\nTarget line two.\n\nLAST' }];
    const target = [{ identifier: 'target', content: 'Target line one.\nTarget line two.' }];
    const result = module.insertPresetRelativeGroups(messages, [
        { key: 'weave', position: 'preset_after_target', content: '<WEAVE />' },
        { key: 'ban', position: 'preset_before_target', content: '<BAN />' },
    ], target);
    assert.equal(result.inserted.length, 2);
    assert.deepEqual(result.missing, []);
    assert.equal(messages.map((item) => item.content).join(''), 'FIRST\n\n<BAN />Target   line one.\r\nTarget line two.<WEAVE />\n\nLAST');
    assert.equal(messages[0].role, 'developer');
    assert.equal(messages.at(-1).name, 'rules');
});

test('동일한 위치의 묶음 순서와 멀티모달 첨부를 유지하고 모호한 앵커는 추측하지 않는다', async () => {
    globalThis.SillyTavern = { getContext: () => ({ eventTypes: { APP_READY: 'app_ready' }, eventSource: { on() {}, removeListener() {} }, extensionSettings: {}, chatMetadata: {} }) };
    const module = await import(`../index.js?multimodal-boundaries=${Date.now()}`);
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } };
    const messages = [{ role: 'system', content: [{ type: 'text', text: 'FIRST\nTarget.\nLAST' }, image] }];
    const result = module.insertPresetRelativeGroups(messages, [
        { key: 'weave', position: 'preset_after_target', content: '<META />\n\n<AI />' },
        { key: 'ban', position: 'preset_after_target', content: '<BAN />' },
    ], [{ identifier: 'target', content: 'Target.' }]);
    assert.equal(result.inserted.length, 1);
    assert.equal(messages[1].content, '<META />\n\n<AI />\n\n<BAN />');
    assert.deepEqual(messages.at(-1).content.at(-1), image);
    const ambiguous = [{ role: 'system', content: 'Target.\nTarget.' }];
    const missed = module.insertPresetRelativeGroups(ambiguous, [{ key: 'weave', position: 'preset_after_target', content: 'DO NOT INSERT' }], [{ identifier: 'target', content: 'Target.' }]);
    assert.equal(missed.inserted.length, 0);
    assert.equal(missed.missing[0].reason, 'content_missing_or_ambiguous');
    assert.equal(ambiguous.length, 1);
});

test('ST가 실제로 확장한 매크로 본문을 관찰해 프리셋 경계를 찾되 설정은 바꾸지 않는다', async () => {
    const context = {
        eventTypes: { APP_READY: 'app_ready' }, eventSource: { on() {}, removeListener() {} }, extensionSettings: { ttotto: { metagamingPromptEnabled: true, characterAiPromptEnabled: true } },
        chatMetadata: { ttotto: { enabled: true, smart: { patterns: [], messageKeys: [] } } },
        chatId: 'prepared-macros', characterId: 0, characters: [], chat: [{ is_user: true, mes: 'Main user turn.' }],
        setExtensionPrompt() {}, saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    globalThis.SillyTavern = { getContext: () => context };
    const module = await import(`../index.js?prepared-macros=${Date.now()}`);
    const raw = { identifier: 'target', content: '{{getvar::actual_rules}}' };
    const originalJson = JSON.stringify(raw);
    const manager = { prefix: 'Expanded', preparePrompt(prompt) { return { ...prompt, content: `${this.prefix} real rules.` }; } };
    module.installPresetPromptCapture(manager);
    try {
        await globalThis.ttottoGenerationInterceptor(context.chat, 0, () => {}, 'normal');
        assert.equal(manager.preparePrompt(raw).content, 'Expanded real rules.');
        const messages = [{ role: 'system', content: 'BEFORE\nExpanded real rules.\nAFTER' }];
        const result = module.insertPresetRelativeGroups(messages, [{ key: 'weave', position: 'preset_after_target', content: '<WEAVE />' }], [raw]);
        assert.equal(result.inserted.length, 1);
        assert.equal(messages[0].content, 'BEFORE\nExpanded real rules.');
        assert.equal(messages[1].content, '<WEAVE />');
        assert.equal(messages[2].content, '\nAFTER');
        assert.equal(JSON.stringify(raw), originalJson);
    } finally { module.onDisable(); }
});

test('type 없는 월드/번역 보조 요청과 normal 보조 요청을 제외하고 Request·URL 본생성만 주입한다', async () => {
    const listeners = new Map(), requests = [];
    const events = { APP_READY: 'app_ready', GENERATION_STARTED: 'start', CHAT_COMPLETION_SETTINGS_READY: 'settings' };
    const context = {
        eventTypes: events, eventSource: { on(event, handler) { listeners.set(event, handler); }, removeListener(event) { listeners.delete(event); } },
        extensionSettings: { ttotto: { metagamingPromptEnabled: true, characterAiPromptEnabled: true, echoPreventionEnabled: false, weavePromptPosition: 'preset_after_target' } },
        chatMetadata: { ttotto: { enabled: true, smart: { patterns: [], messageKeys: [] } } },
        chatId: 'strict-fetch', characterId: 0, characters: [], groups: [], name1: 'Dana',
        chat: [{ is_user: true, mes: '오늘은 집에서 쉴래.', extra: { original_text: 'I will stay home today.' } }],
        oaiSettings: { prompts: [{ identifier: 'target', content: 'Target rules.' }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'target', enabled: true }] }] },
        setExtensionPrompt() {}, saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        const input = url instanceof Request;
        const body = options?.body ?? (input ? await url.clone().text() : null);
        requests.push({ body: JSON.parse(body), headers: options?.headers ?? (input ? url.headers : null), signal: options?.signal ?? (input ? url.signal : null) });
        return { ok: true };
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.toastr = { info() {}, success() {}, error() {} };
    const module = await import(`../index.js?strict-fetch=${Date.now()}`);
    module.onEnable();
    const endpoint = '/api/backends/chat-completions/generate';
    const send = async (body) => globalThis.fetch(endpoint, { method: 'POST', body: JSON.stringify(body) });
    try {
        await globalThis.ttottoGenerationInterceptor(context.chat, 0, () => {}, 'normal');
        for (const type of [undefined, 'normal', 'quiet']) {
            const auxiliary = { ...(type ? { type } : {}), messages: [{ role: 'user', content: 'Build a world injection. I will stay home today.' }] };
            listeners.get(events.CHAT_COMPLETION_SETTINGS_READY)(auxiliary);
            await send(auxiliary);
            assert.equal(auxiliary.messages.length, 1);
            assert.doesNotMatch(JSON.stringify(requests.at(-1).body), /ANTI_METAGAMING/);
        }
        const main = { messages: [
            { role: 'system', content: 'FIRST\nTarget rules.\nLAST' },
            { role: 'user', content: [{ type: 'text', text: 'Dana: I will stay home today.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }] },
        ] };
        const sharedMessages = main.messages;
        listeners.get(events.CHAT_COMPLETION_SETTINGS_READY)(main);
        assert.equal(sharedMessages.length, 2, '전송 준비는 공유 원본 배열을 변경하지 않음');
        // A later extension deletes our event-time injection. Final fetch restores it.
        main.messages = main.messages.filter((message) => typeof message.content !== 'string' || !message.content.includes('<ANTI_METAGAMING>'));
        const abort = new AbortController();
        const originalSerialized = JSON.stringify(main);
        const request = new Request(`https://st.example${endpoint}`, { method: 'POST', body: originalSerialized, headers: { 'X-Test': 'preserved' }, signal: abort.signal });
        await globalThis.fetch(request);
        const sent = requests.at(-1);
        assert.match(sent.body.messages[1].content, /<ANTI_METAGAMING>/);
        assert.equal(sent.body.messages[2].content, '\nLAST');
        assert.equal(sent.headers.get('X-Test'), 'preserved');
        assert.equal(sent.signal.aborted, false);
        assert.equal(await request.text(), originalSerialized, '원본 Request 본문도 소모하지 않음');
        assert.equal((JSON.stringify(sent.body).match(/<ANTI_METAGAMING>/g) ?? []).length, 1);
        // URL input and explicit normal work too; request state is not one-shot.
        await globalThis.fetch(new URL(`https://st.example${endpoint}`), { method: 'POST', body: JSON.stringify({ ...main, type: 'normal' }) });
        assert.match(JSON.stringify(requests.at(-1).body), /<CHARACTER_KNOWLEDGE_AND_CONTEXT>/);
        // A newly installed wrapper calls the old captured hook after deleting
        // the injection. Reattaching at SETTINGS_READY keeps that chain covered.
        const previousHook = globalThis.fetch;
        globalThis.fetch = async (url, options) => {
            const body = JSON.parse(options.body);
            body.messages = body.messages.filter((message) => typeof message.content !== 'string' || !message.content.includes('<ANTI_METAGAMING>'));
            return previousHook(url, { ...options, body: JSON.stringify(body) });
        };
        const rewritten = { ...main, type: 'normal' };
        listeners.get(events.CHAT_COMPLETION_SETTINGS_READY)(rewritten);
        await send(rewritten);
        assert.equal((JSON.stringify(requests.at(-1).body).match(/<ANTI_METAGAMING>/g) ?? []).length, 1);
        assert.match(requests.at(-1).body.messages[1].content, /<CHARACTER_KNOWLEDGE_AND_CONTEXT>/);
        module.onDisable();
        await send({ type: 'normal', messages: [{ role: 'user', content: 'I will stay home today.' }] });
        assert.doesNotMatch(JSON.stringify(requests.at(-1).body), /ANTI_METAGAMING/);
    } finally { module.onDisable(); globalThis.fetch = oldFetch; }
});

test('실제 ST 본생성 경로의 quiet는 주입하고 번역·raw quiet는 같은 내용이어도 제외한다', async () => {
    const listeners = new Map(), requests = [];
    const events = { APP_READY: 'ready', GENERATION_STARTED: 'start', GENERATION_ENDED: 'end', CHAT_COMPLETION_SETTINGS_READY: 'settings' };
    const context = {
        eventTypes: events, eventSource: { on(event, handler) { listeners.set(event, handler); }, removeListener(event) { listeners.delete(event); } },
        extensionSettings: { ttotto: { metagamingPromptEnabled: true, characterAiPromptEnabled: true, echoPreventionEnabled: false, weavePromptPosition: 'preset_after_target' } },
        chatMetadata: { ttotto: { enabled: true, smart: { patterns: [], messageKeys: [] } } },
        chatId: 'real-main-quiet', characterId: 0, characters: [], groups: [],
        chat: [{ is_user: true, mes: 'Main scene turn.' }],
        oaiSettings: { prompts: [{ identifier: 'target', content: 'Target rules.' }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'target', enabled: true }] }] },
        setExtensionPrompt() {}, saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => { requests.push(JSON.parse(options.body)); return { ok: true }; };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.toastr = { info() {}, success() {}, error() {} };
    const module = await import(`../index.js?real-main-quiet=${Date.now()}`);
    module.onEnable();
    const makePayload = () => ({ type: 'quiet', model: 'main-model', messages: [
        { role: 'system', content: 'Target rules.' }, { role: 'user', content: 'Main scene turn.' },
    ] });
    async function sendOpenAIRequest(payload) {
        listeners.get(events.CHAT_COMPLETION_SETTINGS_READY)(payload);
        return globalThis.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(payload) });
    }
    async function sendGenerationRequest(payload) { return await sendOpenAIRequest(payload); }
    async function generateRawData(payload) { return await sendOpenAIRequest(payload); }
    async function translateInputBeforeGeneration(payload) { return await generateRawData(payload); }
    try {
        await globalThis.ttottoGenerationInterceptor(context.chat, 0, () => {}, 'normal');
        await translateInputBeforeGeneration(makePayload());
        assert.doesNotMatch(JSON.stringify(requests.at(-1)), /ANTI_METAGAMING/);
        // Even a helper running inside the main async tree is not the main request.
        async function mainWithNestedHelper(payload) {
            async function sendGenerationRequest() { return await generateRawData(payload); }
            return await sendGenerationRequest();
        }
        await mainWithNestedHelper(makePayload());
        assert.doesNotMatch(JSON.stringify(requests.at(-1)), /ANTI_METAGAMING/);
        await sendGenerationRequest(makePayload());
        assert.match(requests.at(-1).messages[1].content, /<ANTI_METAGAMING>/);
        assert.equal(requests.at(-1).type, 'quiet', '전송 종류 자체를 normal로 바꾸면 안 됨');
        assert.equal((JSON.stringify(requests.at(-1)).match(/<ANTI_METAGAMING>/g) ?? []).length, 1);
        // If asynchronous middleware loses the original call stack, the exact
        // outbound payload certified at SETTINGS_READY is still recognized.
        const certified = JSON.stringify(requests.at(-1));
        await globalThis.fetch(new Request('https://st.example/api/backends/chat-completions/generate', { method: 'POST', body: certified }));
        assert.equal((JSON.stringify(requests.at(-1)).match(/<ANTI_METAGAMING>/g) ?? []).length, 1);
        // A previously certified body cannot override a positively known raw helper.
        await translateInputBeforeGeneration(makePayload());
        assert.doesNotMatch(JSON.stringify(requests.at(-1)), /ANTI_METAGAMING/);
        await generateRawData({ ...makePayload(), type: 'normal' });
        assert.doesNotMatch(JSON.stringify(requests.at(-1)), /ANTI_METAGAMING/);
        listeners.get(events.GENERATION_ENDED)?.();
        // Some reply-gating extensions start the main Generate as quiet from the outset.
        listeners.get(events.GENERATION_STARTED)('quiet', {}, false);
        await globalThis.ttottoGenerationInterceptor(context.chat, 0, () => {}, 'quiet');
        await sendGenerationRequest(makePayload());
        assert.match(requests.at(-1).messages[1].content, /<CHARACTER_KNOWLEDGE_AND_CONTEXT>/);
        listeners.get(events.GENERATION_ENDED)?.();
        context.chatMetadata.ttotto.skipNextGeneration = true;
        await sendGenerationRequest(makePayload());
        assert.doesNotMatch(JSON.stringify(requests.at(-1)), /ANTI_METAGAMING/);
        assert.equal(context.chatMetadata.ttotto.skipNextGeneration, false, 'quiet 본생성도 1회 쉬기를 한 번 소비함');
        listeners.get(events.GENERATION_ENDED)?.();
        await sendGenerationRequest(makePayload());
        assert.match(JSON.stringify(requests.at(-1)), /ANTI_METAGAMING/);
    } finally { module.onDisable(); globalThis.fetch = oldFetch; }
});

test('ST 본생성 판별은 가장 가까운 sender 기준이며 바깥 번역기 이름만으로 제외하지 않는다', async () => {
    const context = { eventTypes: { APP_READY: 'ready' }, eventSource: { on() {}, removeListener() {} }, extensionSettings: {}, chatMetadata: {} };
    globalThis.SillyTavern = { getContext: () => context };
    const module = await import(`../index.js?sender-stack=${Date.now()}`);
    assert.equal(module.isStMainGenerationCall('Error\n at window.fetch (index.js:1517)\n at ttottoPresetPlacementFetch (index.js:2028)\n at sendOpenAIRequest (openai.js:3151)\n at async sendGenerationRequest (script.js:6118)\n at async finishGenerating (script.js:5449)'), true);
    assert.equal(module.isStMainGenerationCall('Error\n at wrapper (translator.js:100)\n at sendOpenAIRequest (openai.js:3151)\n at async sendGenerationRequest (script.js:6118)'), true);
    assert.equal(module.isStMainGenerationCall('Error\n at sendOpenAIRequest (openai.js:3151)\n at generateRawData (script.js:4000)\n at async sendGenerationRequest (script.js:6118)'), false);
    assert.equal(module.isStMainGenerationCall('Error\n at sendRequest (custom-request.js:463)\n at translateInputBeforeGeneration (index.js:7859)\n at Generate (script.js:4299)'), false);
    assert.equal(module.isStMainGenerationCall('Error\n at sendOpenAIRequest (openai.js:3151)'), false);
    module.onDisable();
});

test('에코 방지는 반복 패턴이 없어도 생성 직전에 주입되고 끄기와 이어쓰기를 존중한다', async () => {
    const promptCalls = [];
    const context = {
        eventTypes: { APP_READY: 'app_ready' },
        eventSource: { on() {}, removeListener() {} },
        extensionSettings: { ttotto: { enabled: true, echoPreventionEnabled: true } },
        chatMetadata: { ttotto: { enabled: true, smart: { patterns: [], messageKeys: [] } } },
        chatId: 'echo-test',
        groupId: null,
        characterId: 0,
        name1: 'Dana',
        name2: 'Peter',
        groups: [],
        characters: [{ name: 'Peter', avatar: 'peter.png' }],
        chat: [{
            is_user: true,
            mes: '*Dana slammed the door.* "Do not follow me."',
            extra: { display_text: '*다나가 문을 닫았다.* “따라오지 마.”' },
        }],
        setExtensionPrompt(...args) { promptCalls.push(args); },
        saveSettingsDebounced() {},
        saveMetadataDebounced() {},
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.toastr = { info() {}, success() {}, error() {} };
    const module = await import(`../index.js?echo=${Date.now()}`);

    await globalThis.ttottoGenerationInterceptor(context.chat, 0, () => {}, 'normal');
    assert.match(promptCalls.at(-1)[1], /<ttotto_anti_echo>/);
    assert.match(promptCalls.at(-1)[1], /TURN-LOCAL QUOTED-DIALOGUE NO-ECHO LIST/);
    assert.match(promptCalls.at(-1)[1], /follow me/);
    assert.doesNotMatch(promptCalls.at(-1)[1], /Dana slammed the door/);
    assert.doesNotMatch(promptCalls.at(-1)[1], /따라오지 마/);
    assert.doesNotMatch(promptCalls.at(-1)[1], /<ttotto_anti_repetition>/);

    context.chat.push({ is_user: true, mes: '*Dana pointed outside.* “Bring the red umbrella tomorrow.”' });
    await globalThis.ttottoGenerationInterceptor(context.chat, 0, () => {}, 'normal');
    assert.match(promptCalls.at(-1)[1], /Bring the red umbrella tomorrow/);
    assert.doesNotMatch(promptCalls.at(-1)[1], /follow me/);

    context.chat.push({ is_user: true, mes: '*Dana silently crossed the room without speaking.*' });
    await globalThis.ttottoGenerationInterceptor(context.chat, 0, () => {}, 'normal');
    assert.match(promptCalls.at(-1)[1], /<ttotto_anti_echo>/);
    assert.doesNotMatch(promptCalls.at(-1)[1], /TURN-LOCAL QUOTED-DIALOGUE NO-ECHO LIST/);

    await globalThis.ttottoGenerationInterceptor(context.chat, 0, () => {}, 'continue');
    assert.equal(promptCalls.at(-1)[1], '');

    context.extensionSettings.ttotto.echoPreventionEnabled = false;
    await globalThis.ttottoGenerationInterceptor(context.chat, 0, () => {}, 'normal');
    assert.equal(promptCalls.at(-1)[1], '');

    assert.match(module.buildGenerationInjection('', { echoPreventionEnabled: true }, 'swipe', context.chat, []), /<ttotto_anti_echo>/);
    const strongPrompt = module.buildGenerationInjection('', {
        echoPreventionEnabled: true,
        echoPreventionStrong: true,
    }, 'swipe', context.chat, []);
    assert.match(strongPrompt, /STRICT MODE — HARD OUTPUT CONSTRAINT/);
    assert.match(strongPrompt, /MANDATORY TWO-PASS VALIDATION/);
    assert.deepEqual(await module.measurePromptTokens('short prompt', { getTokenCountAsync: async () => 7 }), { count: 7, estimated: false });
    assert.deepEqual(await module.measurePromptTokens('12345678', {}), { count: 2, estimated: true });
});

test('원문 보존과 같은 이름 카드의 UUID 분리를 엄격하게 처리한다', async () => {
    const context = {
        eventTypes: { APP_READY: 'app_ready' },
        eventSource: { on() {} },
        extensionSettings: {},
        chatMetadata: {},
        chatId: 'identity-test',
        groupId: 'group-1',
        characterId: undefined,
        characters: [
            { name: '김홍진', avatar: 'hongjin-a.png' },
            { name: '김홍진', avatar: 'hongjin-b.png' },
        ],
        groups: [{ id: 'group-1', members: ['hongjin-a.png', 'hongjin-b.png'] }],
        chat: [],
        saveSettingsDebounced() {},
        setExtensionPrompt() {},
    };
    globalThis.SillyTavern = { getContext: () => context };
    const module = await import(`../index.js?identity=${Date.now()}`);
    const settings = { characterUuids: {} };
    assert.equal(module.ensureCharacterUuid(settings, 'hongjin-a.png', () => 'uuid-a'), 'uuid-a');
    assert.equal(module.ensureCharacterUuid(settings, 'hongjin-b.png', () => 'uuid-b'), 'uuid-b');
    assert.notEqual(settings.characterUuids['hongjin-a.png'], settings.characterUuids['hongjin-b.png']);
    assert.equal(module.resolveCharacterAvatarKey({ name: '김홍진' }, context), '');
    assert.equal(module.resolveCharacterAvatarKey({ name: '김홍진', original_avatar: 'hongjin-b.png' }, context), 'hongjin-b.png');

    const hashNameContext = {
        ...context,
        groupId: null,
        characterId: 0,
        characters: [{ name: '#김챗시 #박챗시', avatar: '#김챗시 #박챗시.png' }],
        groups: [],
    };
    assert.equal(
        module.resolveCharacterAvatarKey({ name: '#김챗시 #박챗시', original_avatar: '#김챗시 #박챗시.png' }, hashNameContext),
        '#김챗시 #박챗시.png',
    );
    assert.equal(
        module.ensureCharacterUuid({ characterUuids: {} }, '#김챗시 #박챗시.png', () => 'uuid-hash-name'),
        'uuid-hash-name',
    );

    context.extensionSettings.ttotto = {
        characterUuids: { 'hongjin-a.png': 'uuid-a', 'hongjin-b.png': 'uuid-b' },
        characterAllowances: {
            'uuid-a': { ignoredKeys: ['same-looking-pattern'], ignoredPatterns: [] },
        },
    };
    assert.equal(module.isPatternIgnored({ key: 'same-looking-pattern', characterUuid: 'uuid-a' }, null), true);
    assert.equal(module.isPatternIgnored({ key: 'same-looking-pattern', characterUuid: 'uuid-b' }, null), false);
    assert.deepEqual(new Set(module.currentChatCharacterUuids()), new Set(['uuid-a', 'uuid-b']));

    const translated = { mes: 'His jaw tightened as he looked away.' };
    assert.equal(module.preserveOriginalMessageText(translated), true);
    translated.extra.display_text = '그의 턱이 굳으며 시선을 돌렸다.';
    assert.equal(module.findStoredOriginal(translated), 'His jaw tightened as he looked away.');
    translated.extra.display_text = '사용자가 수정한 한국어 번역문';
    assert.equal(module.findStoredOriginal(translated), 'His jaw tightened as he looked away.');

    translated.mes = 'He folded his arms after the native edit.';
    assert.equal(module.findStoredOriginal(translated), 'His jaw tightened as he looked away.');
    assert.equal(module.preserveOriginalMessageText(translated, { overwrite: true }), true);
    assert.equal(translated.extra.ttotto_source_text, 'He folded his arms after the native edit.');

    const overwrittenByTranslator = {
        mes: '그 청년은 문을 닫았다.',
        extra: { original_mes: 'The man closed the door.' },
    };
    assert.equal(module.findStoredOriginal(overwrittenByTranslator), 'The man closed the door.');
    assert.equal(module.preserveOriginalMessageText(overwrittenByTranslator), true);
    assert.equal(overwrittenByTranslator.extra.ttotto_source_text, 'The man closed the door.');

    const swiped = {
        mes: 'First original sentence.',
        swipe_id: 0,
        swipes: ['First original sentence.', 'Second original sentence.'],
        swipe_info: [{ extra: {} }, { extra: {} }],
    };
    assert.equal(module.preserveOriginalMessageText(swiped), true);
    swiped.swipe_id = 1;
    swiped.mes = 'Second original sentence.';
    assert.equal(module.preserveOriginalMessageText(swiped), true);
    swiped.extra.display_text = '두 번째 번역문';
    assert.equal(module.findStoredOriginal(swiped), 'Second original sentence.');
});

test('원문이 늦게 생겨도 구버전 허용값 이전을 다시 시도한다', async () => {
    const listeners = new Map();
    const eventTypes = { APP_READY: 'app_ready' };
    const context = {
        eventTypes,
        eventSource: {
            on(event, handler) {
                if (!listeners.has(event)) listeners.set(event, new Set());
                listeners.get(event).add(handler);
            },
            removeListener(event, handler) { listeners.get(event)?.delete(handler); },
        },
        extensionSettings: {},
        chatMetadata: {
            ttotto: {
                enabled: true,
                ignoredKeys: ['legacy-key'],
                ignoredPatterns: [{
                    key: 'legacy-key', source: 'local', scope: 'narration', speaker: '',
                    label: '같은 방식으로 문장 시작', instruction: 'Vary narration openings.', examples: ['His jaw tightened.'],
                }],
                smart: { patterns: [], messageKeys: [] },
            },
        },
        chatId: 'legacy-retry', groupId: null, characterId: 0,
        name1: 'User', name2: '김홍진', groups: [],
        characters: [{ name: '김홍진', avatar: 'hongjin.png' }],
        chat: [],
        setExtensionPrompt() {}, saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.toastr = { info() {}, success() {}, error() {} };
    const module = await import(`../index.js?migration=${Date.now()}`);
    module.onEnable();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.notEqual(context.chatMetadata.ttotto.legacyAllowancesMigrated, true);

    context.chat = [{
        mes: 'His jaw tightened as he looked away from her.', name: '김홍진', send_date: 1,
    }];
    await globalThis.ttottoGenerationInterceptor([], 0, () => {}, 'normal');
    const uuid = context.extensionSettings.ttotto.characterUuids['hongjin.png'];
    assert.ok(uuid);
    assert.equal(context.chatMetadata.ttotto.legacyAllowancesMigrated, true);
    assert.ok(context.extensionSettings.ttotto.characterAllowances[uuid].ignoredKeys.includes('legacy-key'));
    module.onDisable();
});

test('기존 Feather 번역 채팅에서도 display_text가 아닌 Silly 원문만 분석한다', async () => {
    const promptCalls = [];
    const context = {
        eventTypes: { APP_READY: 'app_ready' },
        eventSource: { on() {} },
        extensionSettings: {},
        chatMetadata: { ttotto: { enabled: true, smart: { patterns: [], messageKeys: [] } } },
        chatId: 'feather-existing', groupId: null, characterId: 0,
        name1: 'User', name2: 'Peter', groups: [],
        characters: [{ name: 'Peter', avatar: 'peter.png' }],
        chat: [1, 2, 3].map((id) => ({
            mes: `His jaw tightened as he looked away from her response ${id}.`,
            name: 'Peter', send_date: id, swipe_id: 0,
            swipes: [`His jaw tightened as he looked away from her response ${id}.`],
            extra: {
                display_text: `화면에만 보이는 서로 다른 한국어 번역문 ${id}`,
                feather_active: {
                    key: '0',
                    source: `His jaw tightened as he looked away from her response ${id}.`,
                    translated: `화면에만 보이는 서로 다른 한국어 번역문 ${id}`,
                },
                feather_translations: {
                    0: {
                        source: `His jaw tightened as he looked away from her response ${id}.`,
                        translated: `화면에만 보이는 서로 다른 한국어 번역문 ${id}`,
                    },
                },
            },
        })),
        setExtensionPrompt(...args) { promptCalls.push(args); },
        saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.toastr = { info() {}, success() {}, error() {} };
    const module = await import(`../index.js?feather=${Date.now()}`);
    await globalThis.ttottoGenerationInterceptor([], 0, () => {}, 'normal');
    const injected = promptCalls.map((call) => call[1]).find((value) => String(value).includes('<ttotto_anti_repetition>'));
    assert.ok(injected);
    assert.doesNotMatch(injected, /화면에만 보이는/);
    module.onDisable();
});

test('영구 금지어와 1회 쉬기, UUID별 지난 채팅 기억이 함께 동작한다', async () => {
    const promptCalls = [];
    const context = {
        eventTypes: { APP_READY: 'app_ready' },
        eventSource: { on() {}, removeListener() {} },
        extensionSettings: {
            ttotto: {
                enabled: true,
                windowSize: 20,
                sensitivity: 'normal',
                narrationEnabled: true,
                dialogueEnabled: true,
                banPreventionStrong: true,
                smartAnalysis: false,
                maxInjectedPatterns: 6,
                characterUuids: { 'same-card.png': 'uuid-same', 'other-card.png': 'uuid-other' },
                characterAllowances: {},
                characterBans: {
                    'uuid-same': [
                        { id: 'term-jaw', type: 'term', term: 'jaw muscles', characterUuid: 'uuid-same' },
                        {
                            id: 'structure-stare', type: 'pattern', characterUuid: 'uuid-same',
                            label: '시선 문장 시작', scope: 'narration',
                            instruction: 'Do not begin a sentence with "He stared at her".',
                            examples: ['He stared at her.'],
                        },
                    ],
                },
                characterHistory: {},
                crossChatMemoryEnabled: true,
            },
        },
        chatMetadata: {
            ttotto: { enabled: true, skipNextGeneration: true, smart: { patterns: [], messageKeys: [] } },
        },
        chatId: 'chat-a', groupId: null, characterId: 0,
        name1: 'User', name2: 'Same Name', groups: [],
        characters: [
            { name: 'Same Name', avatar: 'same-card.png' },
            { name: 'Same Name', avatar: 'other-card.png' },
        ],
        chat: [{ mes: 'He crossed the old room without another word.', name: 'Same Name', send_date: '2026-01-01', original_avatar: 'same-card.png' }],
        setExtensionPrompt(...args) { promptCalls.push(args); },
        saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.toastr = { info() {}, success() {}, error() {} };
    const module = await import(`../index.js?features=${Date.now()}`);
    module.onEnable();

    const firstChat = module.collectAssistantMessages({ applyWindow: false });
    assert.equal(firstChat.length, 1);
    await globalThis.ttottoGenerationInterceptor([], 0, () => {}, 'normal');
    assert.equal(context.chatMetadata.ttotto.skipNextGeneration, false);
    assert.equal(promptCalls.at(-1)[1], '');

    await globalThis.ttottoGenerationInterceptor([], 0, () => {}, 'normal');
    assert.match(promptCalls.at(-1)[1], /jaw muscles/);
    assert.match(promptCalls.at(-1)[1], /Do not begin a sentence with "He stared at her"/);
    assert.match(promptCalls.at(-1)[1], /STRICT PERMANENT-BAN MODE/);

    context.chatId = 'chat-b';
    context.chatMetadata = { ttotto: { enabled: true, smart: { patterns: [], messageKeys: [] } } };
    context.chat = [{ mes: 'He entered a newly opened room in silence.', name: 'Same Name', send_date: '2026-01-02', original_avatar: 'same-card.png' }];
    const sameCard = module.collectAssistantMessages({ applyWindow: false });
    assert.equal(sameCard.length, 2);
    assert.ok(sameCard.some((message) => message.fromMemory));

    context.characterId = 1;
    context.chatId = 'chat-c';
    context.chat = [{ mes: 'He entered a different room and sat down.', name: 'Same Name', send_date: '2026-01-03', original_avatar: 'other-card.png' }];
    const otherCard = module.collectAssistantMessages({ applyWindow: false });
    assert.equal(otherCard.length, 1);
    assert.equal(otherCard[0].characterUuid, 'uuid-other');
    await globalThis.ttottoGenerationInterceptor([], 0, () => {}, 'normal');
    assert.doesNotMatch(promptCalls.at(-1)[1], /jaw muscles|He stared at her|STRICT PERMANENT-BAN MODE/);
    module.onDisable();
});

test('수천 개짜리 긴 채팅에서도 최근 분석 범위만 원문으로 읽는다', async () => {
    let textReads = 0;
    const chat = Array.from({ length: 6000 }, (_, index) => {
        if (index % 2 === 0) return { is_user: true, mes: `user ${index}` };
        const message = { name: 'Peter', send_date: index };
        Object.defineProperty(message, 'mes', {
            configurable: true,
            enumerable: true,
            get() {
                textReads += 1;
                return `Assistant reply ${index} with enough original text to analyze safely.`;
            },
        });
        return message;
    });
    const context = {
        eventTypes: { APP_READY: 'app_ready' },
        eventSource: { on() {}, removeListener() {} },
        extensionSettings: {
            ttotto: {
                enabled: true,
                windowSize: 20,
                sensitivity: 'normal',
                narrationEnabled: true,
                dialogueEnabled: true,
                smartAnalysis: false,
                characterUuids: { 'peter.png': 'uuid-peter' },
                characterAllowances: {}, characterBans: {}, characterHistory: {},
                crossChatMemoryEnabled: false,
            },
        },
        chatMetadata: { ttotto: { enabled: true, smart: { patterns: [], messageKeys: [] } } },
        chatId: 'long-chat', groupId: null, characterId: 0,
        name1: 'User', name2: 'Peter', groups: [],
        characters: [{ name: 'Peter', avatar: 'peter.png' }],
        chat,
        setExtensionPrompt() {}, saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.toastr = { info() {}, success() {}, error() {} };
    const module = await import(`../index.js?long=${Date.now()}`);
    const messages = module.collectAssistantMessages();
    assert.equal(messages.length, 20);
    assert.ok(textReads < 150, `최근 20개 대신 너무 많은 원문을 읽음: ${textReads}`);
    module.onDisable();
});

test('지난 채팅 기억은 제외 블록을 걷어낸 본문만 저장하고 구버전 기억도 정리한다', async () => {
    const context = {
        eventTypes: { APP_READY: 'app_ready' },
        eventSource: { on() {}, removeListener() {} },
        extensionSettings: {
            ttotto: {
                enabled: true, windowSize: 20, sensitivity: 'normal',
                narrationEnabled: true, dialogueEnabled: true, smartAnalysis: false,
                characterUuids: { 'peter.png': 'uuid-peter' },
                characterAllowances: {}, characterBans: {},
                characterHistory: {
                    'uuid-peter': [
                        {
                            key: 'legacy-1', memorySlot: 'legacy-slot-1', speaker: 'Peter', characterUuid: 'uuid-peter',
                            text: '<Info_panel>[Date: 2026.07.01]</Info_panel>\nHe waited by the harbor until sunset.',
                            chatIdentity: 'old-chat', capturedAt: 100,
                        },
                        {
                            key: 'legacy-2', memorySlot: 'legacy-slot-2', speaker: 'Peter', characterUuid: 'uuid-peter',
                            text: '<Status_box>[HP: 100]</Status_box>',
                            chatIdentity: 'old-chat', capturedAt: 200,
                        },
                    ],
                },
                crossChatMemoryEnabled: true,
                excludeAllTaggedBlocks: true,
            },
        },
        chatMetadata: { ttotto: { enabled: true, smart: { patterns: [], messageKeys: [] } } },
        chatId: 'memory-strip', groupId: null, characterId: 0,
        name1: 'User', name2: 'Peter', groups: [],
        characters: [{ name: 'Peter', avatar: 'peter.png' }],
        chat: [
            {
                mes: '<Info_panel>[Date: 2026.08.16]\n[Location: Seoul]</Info_panel>\n<div class="status-card"><span>HP 80</span></div>\nHe closed the door quietly behind him.',
                name: 'Peter', send_date: 1,
            },
            {
                mes: `Long reply. ${'He walked through the endless corridor without a word. '.repeat(200)}`,
                name: 'Peter', send_date: 2,
            },
        ],
        setExtensionPrompt() {}, saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.toastr = { info() {}, success() {}, error() {} };
    const module = await import(`../index.js?memstrip=${Date.now()}`);

    module.migrateStoredMemoryOnce();
    const migrated = context.extensionSettings.ttotto.characterHistory['uuid-peter'];
    assert.equal(migrated.length, 1);
    assert.doesNotMatch(migrated[0].text, /Info_panel|2026\.07\.01/);
    assert.match(migrated[0].text, /waited by the harbor/);
    assert.equal(context.extensionSettings.ttotto.memoryStripVersion, 1);

    module.collectAssistantMessages();
    const stored = context.extensionSettings.ttotto.characterHistory['uuid-peter'];
    assert.equal(stored.length, 3);
    const panelMessage = stored.find((item) => /closed the door quietly/.test(item.text));
    assert.ok(panelMessage);
    assert.doesNotMatch(panelMessage.text, /Info_panel|Seoul|status-card|HP 80/);
    const longMessage = stored.find((item) => /Long reply/.test(item.text));
    assert.ok(longMessage.text.length > 9000, '저장 시 글자수를 자르면 안 됨');
    assert.doesNotMatch(longMessage.text, /…/);
    module.onDisable();
});
