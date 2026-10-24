import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeRepetitionExclusions, excludeRepetitionRegions, repetitionExclusionKey } from '../repetition-exclusions.js';
import { detectPatterns, splitDialogueAndNarration, buildInjection, extractEchoPhrases } from '../detector.js';
import { buildReviewBatches, locateRepairTargets } from '../response-guard.js';
import { createRepairDocument } from '../rewrite-targets.js';

const config = (...formats) => ({ formats, custom: [] });
const settings = { sensitivity: 'normal', narrationEnabled: true, dialogueEnabled: true };
const messages = ['as he looked away.', 'when the door shut.', 'at the sound of her voice.'].map((suffix, i) => ({
    id: `M${i}`, key: `M${i}`, characterUuid: 'uuid-peter', speaker: 'Peter', text: `*His jaw tightened ${suffix}*`,
}));

test('new defaults analyze code contents until the user explicitly selects code exclusion', () => {
    assert.deepEqual(normalizeRepetitionExclusions(), config());
    const text = '```\nHis jaw tightened.\n```';
    assert.match(splitDialogueAndNarration(text).narration.join(' '), /jaw tightened/);
    assert.deepEqual(splitDialogueAndNarration(text, { repetitionExclusions: config('codeBlock') }), { dialogue: [], narration: [] });
});

test('single, double and triple asterisks remain independent, with escapes and incomplete pairs preserved', () => {
    const text = '*italic* **bold** ***both*** \\*literal\\* *unclosed';
    const filtered = excludeRepetitionRegions(text, config('italic'));
    assert.doesNotMatch(filtered, /italic/);
    assert.match(filtered, /\*\*bold\*\* \*\*\*both\*\*\*/);
    assert.match(filtered, /literal/); assert.match(filtered, /unclosed/);
    assert.equal(filtered.length, text.length);
    assert.match(excludeRepetitionRegions(text, config('bold')), /italic/);
    assert.doesNotMatch(excludeRepetitionRegions(text, config('boldItalic')), /both/);
    assert.match(excludeRepetitionRegions('* first * and * second *', config('italic')), /first.*second/);
});

for (const [id, text] of [
    ['italic', '*HIDDEN*'], ['bold', '**HIDDEN**'], ['boldItalic', '***HIDDEN***'],
    ['underline', '__HIDDEN__'], ['strike', '~~HIDDEN~~'], ['inlineCode', '`HIDDEN`'],
    ['inlineCode', '``HIDDEN with ` inside``'], ['codeBlock', '```text\nHIDDEN\n```'],
    ['codeBlock', '```HIDDEN```'], ['codeBlock', '~~~~\nHIDDEN\n~~~~'],
    ['quote', '> HIDDEN'], ['heading', '### HIDDEN'],
    ['link', '[HIDDEN [nested]](https://example.test/(nested))'], ['image', '![HIDDEN](image.png)'],
]) {
    test(`format ${id}: exclude its content, keep following prose, restore when unchecked (${text.slice(0, 12)})`, () => {
        const input = `${text}\nVISIBLE prose here.`;
        const excluded = excludeRepetitionRegions(input, config(id));
        assert.doesNotMatch(excluded, /HIDDEN/);
        assert.match(excluded, /VISIBLE prose here/);
        assert.equal(excluded.length, input.length);
        const restored = splitDialogueAndNarration(input, { repetitionExclusions: config() });
        assert.match([...restored.dialogue, ...restored.narration].join(' '), /HIDDEN/);
    });
}

test('unselected inline/fenced code does not activate contained Markdown markers', () => {
    const input = '`*inline literal*`\n```\n**block literal**\n```\n*exclude this*';
    const result = excludeRepetitionRegions(input, config('italic', 'bold'));
    assert.match(result, /inline literal/); assert.match(result, /block literal/);
    assert.doesNotMatch(result, /exclude this/);
    assert.match(excludeRepetitionRegions('```\nunfinished code', config('codeBlock')), /unfinished code/);
});

test('custom delimiters are literal, balanced, toggleable, and do not delete unmatched tails', () => {
    const value = { formats: [], custom: [{ start: '【', end: '】' }, { start: '[a+b]', end: '[/a+b]' }] };
    const raw = 'keep 【outer 【nested】 end】 middle [a+b]secret[/a+b] after 【unfinished';
    const result = excludeRepetitionRegions(raw, value);
    assert.doesNotMatch(result, /outer|nested|secret/);
    assert.match(result, /keep/); assert.match(result, /middle/); assert.match(result, /after 【unfinished/);
    value.custom[0].enabled = false;
    assert.match(excludeRepetitionRegions(raw, value), /outer/);
    assert.doesNotMatch(excludeRepetitionRegions('`secret`', { formats: [], custom: [{ start: '`', end: '`' }] }), /secret/);
    assert.deepEqual(normalizeRepetitionExclusions({ formats: ['unknown', 'italic', 'italic'], custom: [
        { start: '', end: 'x' }, { start: 'x'.repeat(81), end: 'y' }, { start: '【', end: '】' }, { start: '【', end: '】' },
    ] }), { formats: ['italic'], custom: [{ start: '【', end: '】', enabled: true }] });
});

test('local repetition ignores selected content, keeps ordinary repetition, and preserves the source', () => {
    const snapshot = structuredClone(messages);
    assert.ok(detectPatterns(messages, settings, ['Peter']).length > 0);
    assert.deepEqual(detectPatterns(messages, { ...settings, repetitionExclusions: config('italic') }, ['Peter']), []);
    assert.ok(detectPatterns(messages.map(x => ({ ...x, text: x.text.slice(1, -1) })),
        { ...settings, repetitionExclusions: config('italic') }, ['Peter']).length > 0);
    assert.deepEqual(messages, snapshot);
    assert.ok(extractEchoPhrases('*"Bring the red umbrella tomorrow."*', { repetitionExclusions: config('italic') }).length > 0);
});

test('smart input and cached results use the same exclusions, including after a chat/settings switch', () => {
    const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const inputSource = source.slice(source.indexOf('function buildSmartInput('), source.indexOf('\nfunction smartPromptMessages('));
    const cacheSource = source.slice(source.indexOf('function smartPatternsForMessages('), source.indexOf('\nfunction analysisDependencyFingerprint('));
    const active = { ...settings, smartAnalysis: true, repetitionExclusions: config('italic') };
    const context = vm.createContext({ getSettings: () => active, splitDialogueAndNarration, repetitionExclusionKey,
        normalizeSmartPattern: x => x });
    vm.runInContext(inputSource + '\n' + cacheSource, context);
    assert.doesNotMatch(context.buildSmartInput(messages), /jaw tightened/);
    const state = { smart: { patterns: [{ scope: 'narration' }], messageKeys: messages.map(x => x.key),
        repetitionExclusionKey: repetitionExclusionKey(config()) } };
    assert.equal(context.smartPatternsForMessages(state, messages).length, 0);
    active.repetitionExclusions = config();
    assert.equal(context.smartPatternsForMessages(state, messages).length, 1);
    assert.match(context.buildSmartInput(messages), /jaw tightened/);
});

test('injection scopes only automatic repetition and retains permanent terms and structures', () => {
    const prompt = buildInjection([
        { source: 'pinned', kind: 'permanent-term', example: 'jaw', instruction: 'Never use jaw.' },
        { source: 'pinned', kind: 'permanent-structure', instruction: 'No door slamming.' },
        { source: 'local', scope: 'narration', instruction: 'Vary recent reactions.' },
    ], 6, { repetitionExclusions: config('italic') });
    assert.match(prompt, /BANNED: "jaw"/);
    assert.match(prompt, /No door slamming/);
    assert.match(prompt, /single-asterisk italics/);
    assert.match(prompt, /exception NEVER applies to permanent banned expressions/);
});

test('Jev receives separate full ban evidence and filtered repetition evidence', () => {
    const raw = '*INSIDE sentence.* OUTSIDE sentence.';
    const rules = [
        { label: 'permanent', instruction: 'No INSIDE.', scope: 'all' },
        { label: 'automatic', instruction: 'Vary INSIDE.', scope: 'all', repetition: true },
    ];
    const batches = buildReviewBatches({ rules, terms: [], echo: false, repetitionExclusions: config('italic') }, raw, x => x);
    assert.equal(batches.length, 2);
    assert.match(batches[0].state.candidate, /INSIDE/);
    assert.doesNotMatch(batches[1].state.candidate, /INSIDE/);
    assert.match(batches[1].state.candidate, /OUTSIDE/);
    assert.equal(buildReviewBatches({ rules: [rules[1]], terms: [], repetitionExclusions: config('italic') }, '*INSIDE*', x => x).length, 0);
});

test('repetition localization never sends excluded text or targets excluded-only units', async () => {
    const raw = '*INSIDE sentence.*\nOUTSIDE sentence.';
    const doc = createRepairDocument(raw);
    const issue = { label: 'automatic', instruction: 'Vary repeated sentences.', repetition: true, questionId: 'ban_0' };
    const targets = await locateRepairTargets(doc, [issue], { repetitionExclusions: config('italic'), minConfidence: 0.7 },
        x => x, () => false, async (state, questions) => {
            assert.doesNotMatch(JSON.stringify(state), /INSIDE/);
            return { answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'choice', choice: 'violation', confidence: 1 }])) };
        });
    assert.ok(targets.size > 0);
    for (const id of targets.keys()) assert.match(doc.units.find(x => x.id === id).text, /OUTSIDE/);
});

test('real runtime invalidates local analysis and preserves formatted cross-chat memory when toggling exclusions', async () => {
    const previous = globalThis.SillyTavern;
    const context = {
        eventTypes: { APP_READY: 'ready' }, eventSource: { on() {}, removeListener() {} },
        extensionSettings: { ttotto: { ...settings, responseGuardEnabled: true, globalBans: ['jaw'],
            crossChatMemoryEnabled: true, repetitionExclusions: config() } },
        chatMetadata: { ttotto: { enabled: true, smart: { patterns: [], messageKeys: [] } } },
        chatId: 'format-A', characterId: 0, characters: [{ avatar: 'peter.png', name: 'Peter' }], groups: [],
        name1: 'Dana', name2: 'Peter',
        chat: messages.map((x, i) => ({ is_user: false, name: 'Peter', mes: x.text, send_date: i + 1, extra: {} })),
        setExtensionPrompt() {}, saveSettingsDebounced() {}, saveMetadataDebounced() {},
    };
    globalThis.SillyTavern = { getContext: () => context };
    try {
        const module = await import(`../index.js?format-runtime=${Date.now()}`);
        const body = { messages: [], char_name: 'Peter' };
        assert.ok(module.createResponseGuardPlan(body).rules.some(x => x.repetition));
        context.extensionSettings.ttotto.repetitionExclusions = config('italic');
        const plan = module.createResponseGuardPlan(body);
        assert.ok(plan.rules.some(x => x.term === 'jaw'));
        assert.equal(plan.rules.some(x => x.repetition), false);
        // The shared setting survives save/reload serialization and a chat swap.
        context.extensionSettings = JSON.parse(JSON.stringify(context.extensionSettings));
        context.chatId = 'format-B'; context.chatMetadata = { ttotto: { enabled: true, smart: { patterns: [], messageKeys: [] } } }; context.chat = [];
        const memory = module.collectAssistantMessages();
        assert.ok(memory.some(x => x.fromMemory && x.text.startsWith('*His jaw')));
        assert.deepEqual(context.extensionSettings.ttotto.repetitionExclusions, config('italic'));
        assert.equal(module.createResponseGuardPlan(body).rules.some(x => x.repetition), false);
        context.extensionSettings.ttotto.repetitionExclusions = config();
        assert.ok(module.createResponseGuardPlan(body).rules.some(x => x.repetition));
        // Only the old untouched default is cleared once. A later explicit
        // code-block selection and customized old lists survive normalization.
        delete context.extensionSettings.ttotto.repetitionExclusionDefaultsVersion;
        context.extensionSettings.ttotto.repetitionExclusions = config('codeBlock');
        module.collectAssistantMessages();
        assert.deepEqual(context.extensionSettings.ttotto.repetitionExclusions, config());
        context.extensionSettings.ttotto.repetitionExclusions = config('codeBlock');
        module.collectAssistantMessages();
        assert.deepEqual(context.extensionSettings.ttotto.repetitionExclusions, config('codeBlock'));
        delete context.extensionSettings.ttotto.repetitionExclusionDefaultsVersion;
        context.extensionSettings.ttotto.repetitionExclusions = config('codeBlock', 'italic');
        module.collectAssistantMessages();
        assert.deepEqual(context.extensionSettings.ttotto.repetitionExclusions, config('codeBlock', 'italic'));
    } finally {
        if (previous === undefined) delete globalThis.SillyTavern; else globalThis.SillyTavern = previous;
    }
});
