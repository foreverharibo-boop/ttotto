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
const answer = questions => new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(questions).map(id => [id,
    { type: 'choice', choice: 'pass', confidence: 0.925, probabilities: { pass: 0.95, violation: 0.04, uncertain: 0.01 } }])) }));

let serial = 0;
async function setup(overrides = {}, responder = null) {
    const previous = { fetch: globalThis.fetch, localStorage: globalThis.localStorage, SillyTavern: globalThis.SillyTavern, toastr: globalThis.toastr };
    const stored = new Map([[JEV_KEY_STORAGE, 'test-only-ttotto-key'], ['hundredlog.typesafeKey', 'untouched-100log-key']]);
    const listeners = new Map();
    const sent = [];
    const context = {
        eventTypes: { APP_READY: 'ready', GENERATION_STARTED: 'start', GENERATION_ENDED: 'end', GENERATION_STOPPED: 'stop', CHAT_CHANGED: 'chat' },
        eventSource: { on(e, fn) { listeners.set(e, fn); }, removeListener(e) { listeners.delete(e); } },
        extensionSettings: { unrelated: { keep: true }, ttotto: { responseGuardEnabled: true, globalBans: ['jaw'], echoPreventionEnabled: false,
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
        return nativeReply(++generations === 1 ? 'His jaw tightened.' : JSON.stringify({ patches: [{ id: 'S1', text: 'He opened the door.' }] }));
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
        assert.deepEqual(Object.keys(evaluated.questions), ['ban_0']);
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

test('WEAVE alone causes neither Jev evaluation nor hidden regeneration', async () => {
    const env = await setup({ globalBans: [], responseGuardBan: true, responseGuardEcho: false });
    try {
        assert.equal(env.module.createResponseGuardPlan(env.body), null);
        await env.send(); assert.equal(env.sent.length, 1);
    } finally { env.cleanup(); }
});

test('hidden Jev echo review never runs for an existing enabled preference; normal echo injection stays enabled', async () => {
    const env = await setup({ globalBans: [], responseGuardEcho: true, echoPreventionEnabled: true });
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
