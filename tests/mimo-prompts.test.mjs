import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildInjection, buildEchoPreventionInjection } from '../detector.js';

const banMarker = 'For the next assistant reply, do not use';
const echoMarker = 'Treat the latest user input as an established scene contribution.';
const checks = /MANDATORY|TWO-PASS|FINAL CHECK|entire response invalid|Silently (?:delete|rewrite)|before sending|not valid until/;
const patterns = [
    ...Array.from({ length: 35 }, (_, i) => ({ source: 'pinned', kind: 'permanent-term',
        example: `BAN_${i}`, instruction: `Never use BAN_${i}.`, escalated: i === 2 ? 4 : 0 })),
    { source: 'pinned', kind: 'permanent-pattern', instruction: 'Avoid STRUCTURE_ONE.' },
    { source: 'local', scope: 'narration', instruction: 'Avoid REPEAT_ONE.' },
    { source: 'local', scope: 'dialogue', instruction: 'Avoid REPEAT_TWO.' },
];

test('MiMo ban variant keeps all registered bans, selected repetition rules, and exclusion scope without legacy validation', () => {
    for (const strong of [false, true]) for (const length of [false, true]) {
        const options = { banPreventionStrong: strong, banPreserveLength: length, repetitionExclusions: { formats: ['italic'] } };
        const baseline = buildInjection(patterns, 1, options);
        const prompt = buildInjection(patterns, 1, { ...options, banPromptMimo: true });
        assert.ok(prompt.includes(banMarker));
        assert.doesNotMatch(prompt, checks);
        assert.doesNotMatch(prompt, /previously violated|omit filler reactions/);
        for (let i = 0; i < 35; i++) assert.ok(prompt.includes(`"BAN_${i}"`));
        assert.match(prompt, /STRUCTURE_ONE|REPEAT_ONE/);
        assert.ok(prompt.includes('STRUCTURE_ONE') && prompt.includes('REPEAT_ONE'));
        assert.doesNotMatch(prompt, /REPEAT_TWO/);
        assert.match(prompt, /Maintain the requested response length and level of detail/);
        assert.equal(buildInjection(patterns, 1, { ...options, banPromptMimo: false }), baseline);
        assert.equal((prompt.match(/<ttotto_anti_repetition>/g) ?? []).length, 1);
    }
    assert.equal(buildInjection([], 6, { banPromptMimo: true }), '');
    assert.ok(buildInjection([patterns[35]], 6, { banPromptMimo: true }).includes('STRUCTURE_ONE'));
});

test('MiMo echo replaces the full basic/strong policy and does not duplicate a temporary quoted-word list', () => {
    for (const strong of [false, true]) {
        const prompt = buildEchoPreventionInjection(['UNIQUE_USER_QUOTE'], strong, true);
        assert.ok(prompt.includes(echoMarker));
        assert.doesNotMatch(prompt, checks);
        assert.doesNotMatch(prompt, /UNIQUE_USER_QUOTE|TURN-LOCAL QUOTED/);
        assert.match(prompt, /synonyms, translation, summary/);
        assert.match(prompt, /Answer the user's question without repeating it/);
        assert.equal(buildEchoPreventionInjection([], strong, false), buildEchoPreventionInjection([], strong));
    }
});

test('MiMo toggles replace only their own prompt, refresh unchanged-chat caches, preserve placement/preview and restore previous settings', async () => {
    const calls = [];
    const context = {
        eventTypes: { APP_READY: 'app_ready' }, eventSource: { on() {}, removeListener() {} },
        extensionSettings: { ttotto: {
            globalBans: ['GLOBAL_BAN'], globalStructureBans: [{ instruction: 'Avoid GLOBAL_STRUCTURE.' }],
            characterUuids: { 'a.png': 'uuid-a', 'b.png': 'uuid-b' },
            characterBans: {
                'uuid-a': [{ id: 'a-ban', type: 'term', term: 'CHAR_A_BAN' }],
                'uuid-b': [{ id: 'b-ban', type: 'term', term: 'CHAR_B_BAN' }],
            },
            echoPreventionEnabled: false, echoPreventionStrong: true,
            banPreventionStrong: true, banPreserveLength: true,
        } },
        chatMetadata: {}, chatId: 'mimo-a', groupId: null, characterId: 0,
        name1: 'User', name2: 'Same', groups: [],
        characters: [{ name: 'Same', avatar: 'a.png' }, { name: 'Same', avatar: 'b.png' }],
        chat: [{ is_user: true, mes: '"UNIQUE_USER_QUOTE"' }],
        setExtensionPrompt(...args) { calls.push(args); }, saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.toastr = { info() {}, success() {}, error() {} };
    const module = await import(`../index.js?mimo-test=${Date.now()}`);
    module.onEnable();
    let settings;
    const inject = async (type = 'normal') => {
        await globalThis.ttottoGenerationInterceptor(context.chat, 0, () => {}, type);
        settings = context.extensionSettings.ttotto;
        return calls.at(-1)[1];
    };
    try {
        const original = await inject();
        assert.equal(settings.banPromptMimo, false); assert.equal(settings.echoPromptMimo, false);
        for (const ban of [false, true]) for (const echo of [false, true]) {
            Object.assign(settings, { banPromptMimo: ban, echoPromptMimo: echo });
            for (const type of ['normal', '', 'regenerate', 'swipe']) {
                const prompt = await inject(type);
                assert.equal(prompt.includes(banMarker), ban);
                assert.equal(prompt.includes(echoMarker), echo);
                assert.equal(prompt.includes('MANDATORY TWO-PASS PERMANENT-BAN VALIDATION'), !ban);
                assert.equal(prompt.includes('MANDATORY TWO-PASS VALIDATION'), !echo);
                for (const text of ['GLOBAL_BAN', 'GLOBAL_STRUCTURE', 'CHAR_A_BAN']) assert.ok(prompt.includes(text));
                assert.doesNotMatch(prompt, /CHAR_B_BAN/);
                assert.equal((prompt.match(/<ttotto_anti_echo>/g) ?? []).length, 1);
                assert.equal((prompt.match(/<ttotto_anti_repetition>/g) ?? []).length, 1);
                const banText = prompt.match(/<ttotto_anti_repetition>[\s\S]*?<\/ttotto_anti_repetition>/)[0];
                // The settings preview uses this same complete composer.
                assert.equal(module.buildCompleteGenerationInjection(banText, settings, 'normal', null, context.chat), prompt);
                const groups = module.buildPositionedGenerationInjections(banText, { ...settings,
                    banPromptPosition: 'preset_before_main', echoPromptPosition: 'depth_0' }, 'normal', context.chat);
                assert.deepEqual(groups.map(g => [g.key, g.position]), [['ban', 'preset_before_main'], ['echo', 'depth_0']]);
                assert.equal(groups[0].content, banText);
                assert.equal(groups[1].content.includes(echoMarker), echo);
            }
        }
        settings.echoPreventionStrong = false;
        settings.echoPromptMimo = true;
        assert.ok((await inject()).includes(echoMarker), 'MiMo echo alone enables injection');
        assert.doesNotMatch(await inject('continue'), /<ttotto_anti_echo>/);
        settings.allChatsEnabled = false;
        assert.equal(await inject(), '');
        settings.allChatsEnabled = true;
        Object.assign(settings, { banPromptMimo: false, echoPromptMimo: false, echoPreventionStrong: true });
        assert.equal(await inject(), original);
        Object.assign(settings, { banPromptMimo: true, echoPromptMimo: true });
        context.characterId = 1; context.chatId = 'mimo-b'; context.chatMetadata = {};
        context.chat = [{ is_user: true, mes: '"Different question"' }];
        const other = await inject();
        assert.match(other, /CHAR_B_BAN/); assert.doesNotMatch(other, /CHAR_A_BAN/);
        assert.ok(other.includes(banMarker) && other.includes(echoMarker));
    } finally { module.onDisable(); }
});

test('MiMo controls have a separate bordered group immediately after echo with the existing horizontal checkbox layout', async () => {
    const html = await readFile(new URL('../settings.html', import.meta.url), 'utf8');
    const echo = html.match(/<details id="ttotto-group-echo"[\s\S]*?<\/details>/)[0];
    const group = html.match(/<details id="ttotto-group-mimo" class="ttotto-settings-group">[\s\S]*?<\/details>/)[0];
    assert.doesNotMatch(echo, /ttotto-(?:ban|echo)-prompt-mimo/);
    assert.ok(html.slice(html.indexOf(echo) + echo.length).trimStart().startsWith(group));
    assert.ok(group.indexOf('id="ttotto-ban-prompt-mimo"') < group.indexOf('id="ttotto-echo-prompt-mimo"'));
    for (const key of ['ban', 'echo']) {
        assert.match(group, new RegExp(`<label class="ttotto-setting-row" for="ttotto-${key}-prompt-mimo">`));
        assert.match(group, new RegExp(`<input id="ttotto-${key}-prompt-mimo" type="checkbox">`));
    }
});
