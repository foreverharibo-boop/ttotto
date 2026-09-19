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

test('WEAVE·금지어·에코는 한 depth 0 주입문 안에서 설정한 모든 순서를 따른다', async () => {
    const promptCalls = [];
    const context = {
        eventTypes: { APP_READY: 'app_ready' },
        eventSource: { on() {}, removeListener() {} },
        extensionSettings: {
            ttotto: {
                enabled: true,
                echoPreventionEnabled: true,
                metagamingPromptEnabled: true,
                metagamingPromptVersion: 'mini',
                characterAiPromptEnabled: true,
                characterAiPromptVersion: 'compact',
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
    assert.match(injected, /A genius is not omniscient/);

    const permutations = [
        ['weave', 'ban', 'echo'],
        ['weave', 'echo', 'ban'],
        ['ban', 'weave', 'echo'],
        ['ban', 'echo', 'weave'],
        ['echo', 'weave', 'ban'],
        ['echo', 'ban', 'weave'],
    ];
    for (const promptOrder of permutations) {
        const assembled = module.buildCompleteGenerationInjection(
            '<BAN_MARKER>forbidden</BAN_MARKER>',
            {
                echoPreventionEnabled: true,
                metagamingPromptEnabled: true,
                metagamingPromptVersion: 'mini',
                characterAiPromptEnabled: true,
                characterAiPromptVersion: 'compact',
                promptOrder,
            },
            'normal',
            context.chat,
            context.chat,
        );
        const positions = {
            weave: assembled.indexOf('<ANTI_METAGAMING>'),
            ban: assembled.indexOf('<BAN_MARKER>'),
            echo: assembled.indexOf('<ttotto_anti_echo>'),
        };
        assert.ok(Object.values(positions).every((position) => position >= 0));
        assert.deepEqual(
            [...promptOrder].sort((left, right) => positions[left] - positions[right]),
            promptOrder,
            `주입 순서: ${promptOrder.join(' → ')}`,
        );
    }
    assert.deepEqual(module.normalizePromptOrder(['echo', 'echo', 'unknown']), ['echo', 'ban', 'weave']);

    promptCalls.length = 0;
    context.extensionSettings.ttotto.metagamingPromptEnabled = false;
    context.extensionSettings.ttotto.characterAiPromptEnabled = false;
    context.extensionSettings.ttotto.echoPreventionEnabled = false;
    context.extensionSettings.ttotto.globalBans = [];
    await globalThis.ttottoGenerationInterceptor([], 0, () => {}, 'normal');
    assert.equal(promptCalls.filter((call) => call[1]).length, 0);
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
