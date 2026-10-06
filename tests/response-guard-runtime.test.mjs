import test from 'node:test';
import assert from 'node:assert/strict';
import { JEV_KEY_STORAGE } from '../jev-client.js';

function fromMainSender(action) {
    function sendOpenAIRequest() { return action(); }
    function sendGenerationRequest() { return sendOpenAIRequest(); }
    return sendGenerationRequest();
}
const endpoint = '/api/backends/chat-completions/generate';
const nativeReply = text => new Response(JSON.stringify({ choices: [{ index: 0, message: { content: text } }] }), { headers: { 'Content-Type': 'application/json' } });
const answer = (questions, choice = 'pass', confidence = 0.925, probabilities = { pass: 0.95, violation: 0.04, uncertain: 0.01 }) => new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(questions).map(id => [id,
    { type: 'choice', choice, confidence, probabilities }])) }));

test('failed main rewrite returns the retained reply through the installed fetch hook without a popup', async () => {
    let generations = 0;
    const env = await setup({}, body => {
        assert.notEqual(body.model, 'jev-latest');
        return ++generations === 1 ? nativeReply('His jaw tightened.') : new Response('provider failure', { status: 500 });
    });
    const notices = [];
    for (const kind of ['warning', 'error', 'info', 'success']) globalThis.toastr[kind] = (...args) => notices.push([kind, ...args]);
    const snapshot = structuredClone({ chat: env.context.chat, profile: env.context.oaiSettings, unrelated: env.context.extensionSettings.unrelated });
    try {
        assert.equal((await (await env.send()).json()).choices[0].message.content, 'His jaw tightened.');
        assert.equal(generations, 2);
        assert.equal(env.context.chatMetadata.ttotto.responseGuardReport.stage, '재작성 실패 · 마지막 답변 표시');
        assert.deepEqual(notices, []);
        assert.deepEqual({ chat: env.context.chat, profile: env.context.oaiSettings, unrelated: env.context.extensionSettings.unrelated }, snapshot);
    } finally { env.cleanup(); }
});

let serial = 0;

for (const [term, draft] of [
    ['사내', '사내놈이 문을 열었다.'],
    ['사내', '사내새끼들은 문을 열었다.'],
    ['굳은살', '굳은살로는 설명할 수 없었다.'],
]) {
    test(`Korean attached expression is located and rewritten without a Jev call: ${draft}`, async () => {
        let calls = 0;
        const env = await setup({ globalBans: [term], globalStructureBans: [] }, body => {
            assert.notEqual(body.model, 'jev-latest');
            if (++calls === 1) return nativeReply(`주변은 조용했다. ${draft}`);
            const targets = JSON.parse(body.messages.at(-1).content.split('\n').at(-1)).targets;
            assert.equal(targets.length, 1);
            assert.equal(targets[0].text, draft);
            return nativeReply('주변은 조용했다. 그는 잠시 멈췄다.');
        });
        try {
            const result = await (await env.send()).json();
            assert.equal(result.choices[0].message.content, '주변은 조용했다. 그는 잠시 멈췄다.');
            assert.equal(calls, 2);
            assert.equal(env.context.chatMetadata.ttotto.responseGuardReport.stage, '검수 통과');
            assert.equal(env.context.chatMetadata.ttotto.responseGuardReport.attempt, 1);
        } finally { env.cleanup(); }
    });
}

test('streaming main sender without a finishGenerating frame still reviews and repairs its reply', async () => {
    let calls = 0;
    const env = await setup({ globalStructureBans: [] }, () => {
        const text = ++calls === 1 ? 'His jaw tightened.' : 'He opened the door.';
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);
    });
    async function sendOpenAIRequest() {
        await Promise.resolve();
        return await globalThis.fetch(endpoint, { method: 'POST', body: JSON.stringify({ ...env.body, stream: true }) });
    }
    async function sendStreamingRequest() { return await sendOpenAIRequest(); }
    try {
        const raw = await (await sendStreamingRequest()).text();
        assert.match(raw, /He opened the door/);
        assert.doesNotMatch(raw, /jaw/);
        assert.equal(calls, 2);
        assert.equal(env.context.chatMetadata.ttotto.responseGuardReport.attempt, 1);
    } finally { env.cleanup(); }
});

test('deep fetch middleware does not truncate the main sender evidence', async () => {
    const env = await setup({ globalStructureBans: [] });
    const originalLimit = Error.stackTraceLimit;
    function middleware(depth, action) { return depth ? middleware(depth - 1, action) : action(); }
    function sendOpenAIRequest() {
        return middleware(24, () => globalThis.fetch(endpoint, { method: 'POST', body: JSON.stringify(env.body) }));
    }
    function sendGenerationRequest() { return sendOpenAIRequest(); }
    try {
        assert.equal((await (await sendGenerationRequest()).json()).choices[0].message.content, 'He opened the door.');
        assert.equal(env.sent.length, 2);
        assert.equal(Error.stackTraceLimit, originalLimit, 'stack setting must be restored immediately');
    } finally { env.cleanup(); }
});

for (const type of ['normal', 'swipe', 'regenerate', 'continue']) {
    test(`${type}: certified request survives later settings edits and an opaque async fetch wrapper`, async () => {
        const env = await setup({ globalStructureBans: [] });
        try {
            env.listeners.get('start')(type);
            const payload = { ...env.body, type, messages: structuredClone(env.body.messages) };
            fromMainSender(() => env.listeners.get('settings')(payload));
            // Another SETTINGS_READY listener may mutate the same outbound object
            // after ttotto's listener. Its final contents are what fetch serializes.
            payload.messages.push({ role: 'system', content: 'Additional scene instruction.' });
            payload.model = 'main-model-selected-by-later-listener';
            const response = await globalThis.fetch(endpoint, { method: 'POST', body: JSON.stringify(payload) });
            assert.equal((await response.json()).choices[0].message.content, 'He opened the door.');
            assert.equal(env.sent.length, 2);
            assert.equal(env.sent[1].body.model, payload.model);
            assert.ok(env.sent[1].body.messages.some(m => m.content === 'Additional scene instruction.'));
            assert.equal(env.context.chatMetadata.ttotto.responseGuardReport.attempt, 1);
        } finally { env.cleanup(); }
    });
}

test('later-mutated certified payload never authorizes a known auxiliary caller or a later generation', async () => {
    const env = await setup({ globalStructureBans: [] }, () => nativeReply('His jaw tightened.'));
    try {
        const payload = structuredClone(env.body);
        fromMainSender(() => env.listeners.get('settings')(payload));
        payload.messages.push({ role: 'system', content: 'Later setting.' });
        function sendOpenAIRequest() { return globalThis.fetch(endpoint, { method: 'POST', body: JSON.stringify(payload) }); }
        function generateRawData() { return sendOpenAIRequest(); }
        function sendStreamingRequest() { return generateRawData(); }
        await sendStreamingRequest();
        assert.equal(env.sent.length, 1, 'nested raw helper must not be rewritten');
        assert.equal(env.context.chatMetadata.ttotto.responseGuardReport, undefined);
        env.listeners.get('end')();
        env.listeners.get('start')('normal');
        await globalThis.fetch(endpoint, { method: 'POST', body: JSON.stringify(payload) });
        assert.equal(env.sent.length, 2, 'prior generation certification must not survive');
        assert.equal(env.context.chatMetadata.ttotto.responseGuardReport, undefined);
    } finally { env.cleanup(); }
});

for (const [label, status, raw, stream] of [
    ['ST 500 with upstream Vertex 503', 500, '{"error":{"code":503,"message":"Service unavailable","status":"UNAVAILABLE"}}', false],
    ['HTTP 401', 401, '{"error":{"code":401,"message":"API key not valid"}}', false],
    ['provider error in successful HTTP response', 200, '{"error":{"message":"provider failure"}}', false],
    ['provider SSE error', 200, 'data: {"error":{"message":"provider failure"}}\n\n', true],
]) {
    test(`${label} reaches ST unchanged without a ttotto error popup or Jev request`, async () => {
        const original = new Response(raw, { status, headers: { 'X-Provider': 'retain' } });
        const env = await setup({}, () => original);
        const notices = [];
        for (const kind of ['warning', 'error', 'info', 'success']) globalThis.toastr[kind] = (...args) => notices.push([kind, ...args]);
        const snapshot = structuredClone(env.context.oaiSettings);
        try {
            const response = await env.send({ ...env.body, stream });
            assert.equal(response.status, status);
            assert.equal(response.headers.get('X-Provider'), 'retain');
            assert.equal(await response.text(), raw);
            assert.equal(env.sent.length, 1);
            assert.equal(env.context.chatMetadata.ttotto.responseGuardReport.stage, '생성 API 오류 · ST에 전달');
            assert.deepEqual(notices, []);
            assert.deepEqual(env.context.oaiSettings, snapshot);
        } finally { env.cleanup(); }
    });
}

test('main transport failure is propagated without a ttotto error popup', async () => {
    const failure = new TypeError('Failed to fetch');
    const env = await setup({}, () => { throw failure; });
    const notices = [];
    for (const kind of ['warning', 'error', 'info', 'success']) globalThis.toastr[kind] = (...args) => notices.push([kind, ...args]);
    try {
        await assert.rejects(env.send(), error => error === failure);
        assert.deepEqual(notices, []);
        assert.equal(env.sent.length, 1);
    } finally { env.cleanup(); }
});

async function setup(overrides = {}, responder = null) {
    const previous = { fetch: globalThis.fetch, localStorage: globalThis.localStorage, SillyTavern: globalThis.SillyTavern, toastr: globalThis.toastr };
    const stored = new Map([[JEV_KEY_STORAGE, 'test-only-ttotto-key'], ['hundredlog.typesafeKey', 'untouched-100log-key']]);
    const listeners = new Map();
    const sent = [];
    const context = {
        eventTypes: { APP_READY: 'ready', GENERATION_STARTED: 'start', GENERATION_ENDED: 'end', GENERATION_STOPPED: 'stop', CHAT_CHANGED: 'chat', CHAT_COMPLETION_SETTINGS_READY: 'settings' },
        eventSource: { on(e, fn) { listeners.set(e, fn); }, removeListener(e) { listeners.delete(e); } },
        extensionSettings: { unrelated: { keep: true }, ttotto: { responseGuardEnabled: true, globalBans: ['jaw'], globalStructureBans: [{ label: 'cup throwing', instruction: 'Do not describe throwing a cup.' }], echoPreventionEnabled: false,
            metagamingPromptEnabled: true, characterAiPromptEnabled: true, responseGuardMaxRewrites: 1, ...overrides } },
        chatMetadata: { ttotto: { enabled: true, banOffenseVersion: 3, smart: { patterns: [], messageKeys: [] } } },
        chatId: 'guard-runtime', characterId: 0, characters: [{ avatar: 'peter.png', name: 'Peter' }], groups: [],
        name1: 'Dana', name2: 'Peter', chat: [{ is_user: true, mes: 'I am leaving.', extra: {} }],
        oaiSettings: { model_openai: 'original-main', prompts: [{ identifier: 'target', content: 'Target.' }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'target', enabled: true }] }] },
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'fixture-token' }),
        setExtensionPrompt() {}, saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    let generations = 0;
    globalThis.localStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.toastr = { info() {}, success() {}, error() {} };
    globalThis.fetch = async function (url, options) {
        const raw = options?.body ?? await url.clone().text();
        const body = JSON.parse(raw);
        sent.push({ body, options, url });
        if (responder) return responder(body, options, sent, context);
        if (body.model === 'jev-latest') return answer(JSON.parse(body.custom_include_body).questions);
        return nativeReply(++generations === 1 ? 'His jaw tightened.' : 'He opened the door.');
    };
    const module = await import(`../index.js?guard-runtime-${++serial}`);
    module.onEnable();
    listeners.get('start')('normal');
    module.installPresetPlacementFetchHook();
    const body = { messages: [{ role: 'system', content: 'Target.' }, { role: 'user', content: 'I am leaving.' }],
        model: 'original-main', chat_completion_source: 'custom', type: 'normal', char_name: 'Peter', stream: false, temperature: 0.83 };
    const send = (payload = body, options = {}) => fromMainSender(() => globalThis.fetch(endpoint, { method: 'POST', headers: { 'X-Original': 'preserved' }, body: JSON.stringify(payload), ...options }));
    const cleanup = () => {
        module.onDisable();
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
        }
    };
    return { context, listeners, module, send, sent, body, stored, cleanup };
}

test('actual main fetch returns only accepted reply, preserving profile, chat and preset', async () => {
    const env = await setup({ weavePromptPosition: 'preset_after_target' });
    const snapshot = structuredClone({ chat: env.context.chat, profile: env.context.oaiSettings, unrelated: env.context.extensionSettings.unrelated });
    try {
        const response = await env.send();
        assert.equal((await response.json()).choices[0].message.content, 'He opened the door.');
        const generations = env.sent.filter(x => x.body.model === 'original-main');
        const jev = env.sent.filter(x => x.body.model === 'jev-latest');
        assert.equal(generations.length, 2);
        assert.equal(jev.length, 1);
        assert.equal(jev[0].body.chat_completion_source, 'custom');
        const evaluated = JSON.parse(jev[0].body.custom_include_body);
        assert.doesNotMatch(JSON.stringify(evaluated), /<ANTI_METAGAMING>|<CHARACTER_KNOWLEDGE_AND_CONTEXT>/);
        assert.deepEqual(Object.keys(evaluated.questions), ['ban_1']);
        assert.match(JSON.stringify(generations[0].body), /<ANTI_METAGAMING>/);
        assert.match(JSON.stringify(generations[1].body), /<CHARACTER_KNOWLEDGE_AND_CONTEXT>/);
        assert.equal(generations[1].body.temperature, 0.83);
        assert.deepEqual(env.context.chat, snapshot.chat);
        assert.deepEqual(env.context.oaiSettings, snapshot.profile);
        assert.deepEqual(env.context.extensionSettings.unrelated, snapshot.unrelated);
        assert.equal(env.stored.get('hundredlog.typesafeKey'), 'untouched-100log-key');
        assert.equal(env.context.chatMetadata.ttotto.responseGuardReport.stage, '검수 통과');
    } finally { env.cleanup(); }
});

test('guard disabled leaves existing injection and response behavior unchanged', async () => {
    const env = await setup({ responseGuardEnabled: false });
    try {
        assert.equal((await (await env.send()).json()).choices[0].message.content, 'His jaw tightened.');
        assert.equal(env.sent.length, 1);
        assert.match(JSON.stringify(env.sent[0].body), /<ANTI_METAGAMING>/);
    } finally { env.cleanup(); }
});

test('main fetch with only literal bans completes the correction with zero Jev requests', async () => {
    const env = await setup({ globalStructureBans: [] });
    const snapshot = structuredClone(env.context.oaiSettings);
    try {
        assert.equal((await (await env.send()).json()).choices[0].message.content, 'He opened the door.');
        assert.equal(env.sent.filter(x => x.body.model === 'jev-latest').length, 0);
        assert.equal(env.sent.filter(x => x.body.model === 'original-main').length, 2);
        assert.deepEqual(env.context.oaiSettings, snapshot);
        assert.equal(env.context.chatMetadata.ttotto.responseGuardReport.stage, '검수 통과');
    } finally { env.cleanup(); }
});

test('main fetch publishes the latest violating revision with status only, no popup, and intact preset state', async () => {
    let generations = 0;
    const env = await setup({}, body => {
        assert.notEqual(body.model, 'jev-latest'); // exact violations need no semantic call
        return nativeReply(`His jaw tightened ${++generations}.`);
    });
    const notices = [];
    for (const kind of ['warning', 'error', 'info', 'success']) globalThis.toastr[kind] = (...args) => notices.push([kind, ...args]);
    const snapshot = structuredClone({ chat: env.context.chat, profile: env.context.oaiSettings, unrelated: env.context.extensionSettings.unrelated });
    try {
        assert.equal((await (await env.send()).json()).choices[0].message.content, 'His jaw tightened 2.');
        assert.equal(generations, 2);
        assert.equal(notices.length, 0);
        const report = env.context.chatMetadata.ttotto.responseGuardReport;
        assert.equal(report.stage, '위반 남음 · 마지막 답변 표시');
        assert.equal(report.attempt, 1);
        assert.ok(report.labels.length);
        assert.ok(!report.error);
        assert.deepEqual(env.context.chat, snapshot.chat);
        assert.deepEqual(env.context.oaiSettings, snapshot.profile);
        assert.deepEqual(env.context.extensionSettings.unrelated, snapshot.unrelated);
        assert.equal(env.stored.get('hundredlog.typesafeKey'), 'untouched-100log-key');
    } finally { env.cleanup(); }
});

test('WEAVE alone causes neither Jev evaluation nor hidden regeneration', async () => {
    const env = await setup({ globalBans: [], globalStructureBans: [], responseGuardBan: true, responseGuardEcho: false });
    try {
        assert.equal(env.module.createResponseGuardPlan(env.body), null);
        await env.send(); assert.equal(env.sent.length, 1);
    } finally { env.cleanup(); }
});

for (const [label, choice, confidence, probabilities] of [
    ['uncertain', 'uncertain', 0.95, { pass: 0.02, violation: 0.03, uncertain: 0.95 }],
    ['low-confidence violation', 'violation', 0.4, { pass: 0.35, violation: 0.4, uncertain: 0.25 }],
]) {
    test(`main fetch shows ${label} reply without error or popup and preserves saved settings`, async () => {
        const env = await setup({ responseGuardMinConfidence: 0.95 }, body => body.model === 'jev-latest'
            ? answer(JSON.parse(body.custom_include_body).questions, choice, confidence, probabilities)
            : nativeReply('He opened the door.'));
        const notices = [];
        for (const kind of ['warning', 'error', 'info', 'success']) globalThis.toastr[kind] = (...args) => notices.push([kind, ...args]);
        const snapshot = structuredClone({ chat: env.context.chat, profile: env.context.oaiSettings, unrelated: env.context.extensionSettings.unrelated });
        try {
            assert.equal((await (await env.send()).json()).choices[0].message.content, 'He opened the door.');
            assert.equal(env.sent.filter(x => x.body.model === 'original-main').length, 1);
            assert.equal(notices.length, 0);
            const report = env.context.chatMetadata.ttotto.responseGuardReport;
            assert.equal(report.stage, '판정 보류 · 답변 표시');
            assert.ok(!report.error);
            assert.equal(env.context.extensionSettings.ttotto.responseGuardMinConfidence, 0.95);
            assert.deepEqual(env.context.chat, snapshot.chat);
            assert.deepEqual(env.context.oaiSettings, snapshot.profile);
            assert.deepEqual(env.context.extensionSettings.unrelated, snapshot.unrelated);
            assert.equal(env.stored.get('hundredlog.typesafeKey'), 'untouched-100log-key');
            assert.equal(env.stored.get(JEV_KEY_STORAGE), 'test-only-ttotto-key');
        } finally { env.cleanup(); }
    });
}

test('main fetch shows an unlocated semantic violation without a revision request or popup', async () => {
    let checks = 0;
    const env = await setup({}, body => {
        if (body.model !== 'jev-latest') return nativeReply('He opened the door.');
        const questions = JSON.parse(body.custom_include_body).questions;
        return ++checks === 1
            ? answer(questions, 'violation', 0.95, { pass: 0.02, violation: 0.95, uncertain: 0.03 })
            : answer(questions, 'uncertain', 0.95, { pass: 0.02, violation: 0.03, uncertain: 0.95 });
    });
    const notices = [];
    for (const kind of ['warning', 'error', 'info', 'success']) globalThis.toastr[kind] = (...args) => notices.push([kind, ...args]);
    try {
        assert.equal((await (await env.send()).json()).choices[0].message.content, 'He opened the door.');
        assert.equal(checks, 2);
        assert.equal(env.sent.filter(x => x.body.model === 'original-main').length, 1);
        assert.equal(notices.length, 0);
        assert.equal(env.context.chatMetadata.ttotto.responseGuardReport.stage, '위반 위치 미확인 · 마지막 답변 표시');
        assert.ok(!env.context.chatMetadata.ttotto.responseGuardReport.error);
    } finally { env.cleanup(); }
});

test('saved low confidence cannot trigger a semantic rewrite below 0.95', async () => {
    const env = await setup({ responseGuardMinConfidence: 0.5 }, body => body.model === 'jev-latest'
        ? answer(JSON.parse(body.custom_include_body).questions, 'violation', 0.94, { pass: 0.03, violation: 0.94, uncertain: 0.03 })
        : nativeReply('He opened the door.'));
    try {
        assert.equal((await (await env.send()).json()).choices[0].message.content, 'He opened the door.');
        assert.equal(env.sent.filter(x => x.body.model === 'original-main').length, 1);
        assert.equal(env.context.chatMetadata.ttotto.responseGuardReport.stage, '판정 보류 · 답변 표시');
        assert.equal(env.context.extensionSettings.ttotto.responseGuardMinConfidence, 0.5);
    } finally { env.cleanup(); }
});

for (const failure of ['401', 'max_tokens_exceeded', 'missing verdict', 'malformed']) {
    test(`main fetch returns the latest reply on Jev ${failure} with no popup or profile changes`, async () => {
        const env = await setup({}, body => body.model === 'jev-latest'
            ? failure === '401' ? new Response('{}', { status: 401 })
                : failure === 'max_tokens_exceeded' ? new Response(JSON.stringify({ detail: { error_type: failure } }), { status: 400 })
                    : failure === 'missing verdict' ? new Response('{"answers":{}}') : new Response('{bad json')
            : nativeReply('He opened the door.'));
        const notices = [];
        for (const kind of ['warning', 'error', 'info', 'success']) globalThis.toastr[kind] = (...args) => notices.push([kind, ...args]);
        const snapshot = structuredClone({ chat: env.context.chat, profile: env.context.oaiSettings, unrelated: env.context.extensionSettings.unrelated });
        try {
            assert.equal((await (await env.send()).json()).choices[0].message.content, 'He opened the door.');
            assert.equal(env.sent.filter(x => x.body.model === 'original-main').length, 1);
            assert.equal(env.context.chatMetadata.ttotto.responseGuardReport.stage, '검수 건너뜀 · 마지막 답변 표시');
            assert.ok(!env.context.chatMetadata.ttotto.responseGuardReport.error);
            assert.equal(notices.length, 0);
            assert.deepEqual(env.context.chat, snapshot.chat);
            assert.deepEqual(env.context.oaiSettings, snapshot.profile);
            assert.deepEqual(env.context.extensionSettings.unrelated, snapshot.unrelated);
        } finally { env.cleanup(); }
    });
}

// Reproduce the checked inSTead call chain: generateRevision ->
// generateQuietPrompt -> Generate(quiet) -> ST chat sender. Both inSTead UI
// branches call this same quiet generator and then publish its returned text.
for (const mode of ['on', 'off', 'jev-error']) {
        test(`inSTead's shared quiet revision generator retains injection with guard ${mode}`, async () => {
            const enabled = mode !== 'off';
            const env = await setup({ responseGuardEnabled: enabled, weavePromptPosition: 'preset_after_target' }, mode === 'jev-error'
                ? body => body.model === 'jev-latest' ? new Response('{}', { status: 401 }) : nativeReply('He opened the door.')
                : null);
            const snapshot = structuredClone({ chat: env.context.chat, profile: env.context.oaiSettings, unrelated: env.context.extensionSettings.unrelated });
            async function sendOpenAIRequest(payload) {
                env.listeners.get('settings')(payload);
                return globalThis.fetch(endpoint, { method: 'POST', body: JSON.stringify(payload) });
            }
            async function sendGenerationRequest(payload) { return await sendOpenAIRequest(payload); }
            async function finishGenerating(payload) { return await sendGenerationRequest(payload); }
            async function Generate(type, payload) {
                env.listeners.get('start')(type, {}, false);
                await globalThis.ttottoGenerationInterceptor(env.context.chat, 0, () => {}, type);
                return await finishGenerating(payload);
            }
            async function generateQuietPrompt() {
                return await Generate('quiet', { ...structuredClone(env.body), type: 'quiet' });
            }
            async function generateRevision() { return await generateQuietPrompt(); }
            try {
                env.listeners.get('end')();
                const result = await generateRevision();
                assert.equal((await result.json()).choices[0].message.content, enabled ? 'He opened the door.' : 'His jaw tightened.');
                const main = env.sent.filter(x => x.body.model === 'original-main');
                assert.equal(main.length, mode === 'on' ? 2 : 1);
                assert.equal(env.sent.filter(x => x.body.model === 'jev-latest').length, enabled ? 1 : 0);
                for (const request of main) {
                    assert.equal(request.body.type, 'quiet');
                    assert.match(JSON.stringify(request.body.messages), /<ANTI_METAGAMING>/);
                    assert.match(JSON.stringify(request.body.messages), /<ttotto_anti_repetition>/);
                    assert.equal((JSON.stringify(request.body.messages).match(/<ANTI_METAGAMING>/g) ?? []).length, 1);
                }
                assert.deepEqual(env.context.chat, snapshot.chat);
                assert.deepEqual(env.context.oaiSettings, snapshot.profile);
                assert.deepEqual(env.context.extensionSettings.unrelated, snapshot.unrelated);
                if (mode === 'jev-error') assert.equal(env.context.chatMetadata.ttotto.responseGuardReport.stage, '검수 건너뜀 · 마지막 답변 표시');
            } finally { env.cleanup(); }
        });
}

test('hidden Jev echo review never runs for an existing enabled preference; normal echo injection stays enabled', async () => {
    const env = await setup({ globalBans: [], globalStructureBans: [], responseGuardEcho: true, echoPreventionEnabled: true });
    try {
        assert.equal(env.module.createResponseGuardPlan(env.body), null);
        await env.send();
        assert.equal(env.sent.length, 1);
        assert.equal(env.context.extensionSettings.ttotto.responseGuardEcho, true);
        assert.equal(env.context.extensionSettings.ttotto.echoPreventionEnabled, true);
        assert.match(JSON.stringify(env.sent[0].body), /<ttotto_anti_echo>/);
    } finally { env.cleanup(); }
});

test('ban guard runs without echo questions or user-turn data even when the hidden preference is true', async () => {
    const env = await setup({ responseGuardEcho: true, echoPreventionEnabled: true });
    try {
        const plan = env.module.createResponseGuardPlan(env.body);
        assert.equal(plan.echo, false);
        assert.equal(plan.userText, '');
        await env.send();
        const jev = env.sent.filter(x => x.body.model === 'jev-latest');
        assert.ok(jev.length > 0);
        for (const call of jev) {
            const input = JSON.parse(call.body.custom_include_body);
            assert.ok(!Object.hasOwn(input.questions, 'echo'));
            assert.equal(input.state.latest_user_turn, '');
        }
        assert.equal(env.context.extensionSettings.ttotto.responseGuardEcho, true);
    } finally { env.cleanup(); }
});

test('same-endpoint Jev and translator utility requests are forwarded unmodified', async () => {
    const env = await setup();
    try {
        const jev = { model: 'jev-latest', type: 'quiet', chat_completion_source: 'custom', custom_url: 'https://api.typesafe.ai/v1/systemone?via=',
            messages: [{ role: 'user', content: '.' }], custom_include_body: JSON.stringify({ state: {}, questions: {} }) };
        await env.send(jev);
        assert.deepEqual(env.sent[0].body, jev);
        const translation = { model: 'translator', type: 'quiet', messages: [{ role: 'user', content: 'Translate I am leaving.' }] };
        await globalThis.fetch(endpoint, { method: 'POST', body: JSON.stringify(translation) });
        assert.deepEqual(env.sent[1].body, translation);
        assert.equal(env.sent.length, 2);
    } finally { env.cleanup(); }
});

test('missing Jev key blocks before any paid main generation and does not change 100LOG key', async () => {
    const env = await setup(); env.stored.delete(JEV_KEY_STORAGE);
    try {
        await assert.rejects(env.send(), /API 키/);
        assert.equal(env.sent.length, 0);
        assert.equal(env.stored.get('hundredlog.typesafeKey'), 'untouched-100log-key');
    } finally { env.cleanup(); }
});

test('another wrapper can be reattached without double guarding or extra Jev calls', async () => {
    const env = await setup();
    const previousHook = globalThis.fetch;
    let foreignCalls = 0;
    globalThis.fetch = (url, options) => { foreignCalls++; return previousHook(url, { ...options }); };
    env.module.installPresetPlacementFetchHook();
    try {
        await env.send();
        assert.equal(env.sent.filter(x => x.body.model === 'original-main').length, 2);
        assert.equal(env.sent.filter(x => x.body.model === 'jev-latest').length, 1);
        assert.ok(foreignCalls >= 3);
    } finally { env.cleanup(); }
});

test('Request input inherits original headers and keeps original body readable', async () => {
    const env = await setup();
    try {
        const request = new Request(`https://st.example${endpoint}`, { method: 'POST', body: JSON.stringify(env.body), headers: { 'X-Original': 'request-value' } });
        const response = await fromMainSender(() => globalThis.fetch(request));
        assert.equal((await response.json()).choices[0].message.content, 'He opened the door.');
        assert.equal(request.headers.get('X-Original'), 'request-value');
        assert.deepEqual(JSON.parse(await request.text()), env.body);
    } finally { env.cleanup(); }
});

for (const mode of ['stop', 'chat', 'disable']) {
    test(`${mode} cancels the pending Jev call and prevents any candidate being returned`, async () => {
        let started;
        const ready = new Promise(resolve => { started = resolve; });
        const env = await setup({}, (body, options) => {
            if (body.model !== 'jev-latest') return nativeReply('He opened the door.');
            started();
            return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true }));
        });
        try {
            const pending = env.send();
            const rejected = assert.rejects(pending, { name: 'AbortError' });
            await ready;
            if (mode === 'disable') env.module.onDisable();
            else if (mode === 'chat') { env.context.chatId = 'different-chat'; env.context.chatMetadata = {}; env.listeners.get('chat')(); }
            else env.listeners.get('stop')();
            await rejected;
            assert.equal(env.sent.filter(x => x.body.model === 'original-main').length, 1);
        } finally { env.cleanup(); }
    });
}

test('ban plan applies current character rules only; continuing does not enable echo', async () => {
    const env = await setup({ echoPreventionEnabled: true, globalBans: ['globalword'],
        characterUuids: { 'peter.png': 'peter-id', 'other.png': 'other-id' },
        characterBans: {
            'peter-id': [{ id: 'own', type: 'term', term: 'ownword', characterUuid: 'peter-id' }],
            'other-id': [{ id: 'foreign', type: 'term', term: 'foreignword', characterUuid: 'other-id' }],
        } });
    try {
        env.context.groups = [{ id: 'g', members: ['peter.png', 'other.png'] }];
        env.context.groupId = 'g';
        env.context.characters.push({ avatar: 'other.png', name: 'Other' });
        const normal = env.module.createResponseGuardPlan(env.body, 'normal');
        assert.deepEqual(normal.terms.map(x => x.term).sort(), ['globalword', 'ownword']);
        assert.equal(normal.echo, false);
        assert.equal(normal.userText, '');
        assert.equal(env.module.createResponseGuardPlan(env.body, 'continue').echo, false);
    } finally { env.cleanup(); }
});

test('next-generation skip also skips the response guard', async () => {
    const env = await setup();
    try {
        env.context.chatMetadata.ttotto.skipNextGeneration = true;
        env.listeners.get('start')('normal');
        await env.send();
        assert.equal(env.sent.length, 1);
        assert.doesNotMatch(JSON.stringify(env.sent[0].body), /<ANTI_METAGAMING>/);
    } finally { env.cleanup(); }
});
