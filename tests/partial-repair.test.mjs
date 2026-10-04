import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepairDocument, assembleRepairDocument, currentRepairUnits, applyRepairPatches,
    exactRepairTargets, buildPartialRewriteBody, patchNativeResponse } from '../partial-repair.js';
import { runResponseGuard, extractCandidate, locateRepairTargets } from '../response-guard.js';
import { stripNonProse } from '../detector.js';

const clean = text => stripNonProse(text, { excludeAllTaggedBlocks: true }, { clip: false }).normalize('NFKC');
const exactMatch = (text, term) => text.includes(term);
const rule = { term: 'jaw', label: 'jaw', instruction: 'Do not use jaw.', scope: 'all' };
const plan = { terms: [rule], rules: [rule], echo: false, userText: '', maxRewrites: 2, minConfidence: 0.7 };
const body = { messages: [{ role: 'system', content: '<ANTI_METAGAMING>Original weave</ANTI_METAGAMING>' }, { role: 'user', content: 'Open the door.' }], model: 'unchanged', temperature: 0.9, stream: false, chat_completion_source: 'custom', type: 'normal' };
const reply = text => new Response(JSON.stringify({ choices: [{ index: 0, message: { content: text }, logprobs: { stale: true } }], usage: { total_tokens: 10 } }));
const patched = patches => reply(JSON.stringify({ patches }));
const verdict = (questions, fn = () => 'pass', confidence = 0.95) => ({ answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'choice', choice: fn(id), confidence }])) });
const defaults = { body, plan, clean, exactMatch, judge: async (_state, questions) => verdict(questions) };

test('only the offending middle sentence changes; normal prose, emoji and CRLF stay verbatim', async () => {
    const original = '*He entered. His jaw tightened. He left.*\r\n\r\n“Keep this—exactly.”  🐈\r\n';
    const snapshot = structuredClone(body);
    let calls = 0;
    const response = await runResponseGuard({ ...defaults, send: async request => {
        if (++calls === 1) return reply(original);
        assert.match(request.messages.at(-1).content, /"id":"S2"/);
        assert.doesNotMatch(request.messages.at(-1).content, /Return its complete replacement/);
        return patched([{ id: 'S2', text: 'He glanced aside.' }]);
    } });
    assert.equal((await response.json()).choices[0].message.content, original.replace('His jaw tightened.', 'He glanced aside.'));
    assert.deepEqual(body, snapshot);
});

test('locked text retains combining Unicode, NBSP, tabs and exact punctuation', () => {
    const text = 'Cafe\u0301\u00a0unchanged.\tHis jaw tightened.\n\n끝—그대로!';
    const doc = createRepairDocument(text, clean);
    const merged = applyRepairPatches(doc, JSON.stringify({ patches: [{ id: 'S2', text: 'He paused.' }] }), ['S2']);
    assert.equal(merged, 'Cafe\u0301\u00a0unchanged.\tHe paused.\n\n끝—그대로!');
});

test('markup panels, code, comments and thought blocks cannot become editable targets', () => {
    const protectedText = '<thinking>jaw. hidden.</thinking>\n<info_panel>jaw. x.</info_panel>\n<!-- jaw. -->\n```text\njaw.\n```\n';
    const doc = createRepairDocument(`${protectedText}Safe. His jaw tightened.`, clean);
    assert.deepEqual(doc.units.map(x => x.text), ['Safe.', 'His jaw tightened.']);
    applyRepairPatches(doc, JSON.stringify({ patches: [{ id: 'S2', text: 'He paused.' }] }), ['S2']);
    assert.equal(assembleRepairDocument(doc), `${protectedText}Safe. He paused.`);
});

test('unclosed hidden thought stays locked and no hidden word is repaired', () => {
    const doc = createRepairDocument('Safe. <thinking>jaw. still hidden.', clean);
    assert.deepEqual(doc.units.map(x => x.text), ['Safe.']);
    assert.deepEqual([...exactRepairTargets(doc, rule, clean, exactMatch)], []);
});

test('independent sentence replacements preserve the locked sentence between them', () => {
    const text = 'His jaw tightened. Exactly keep this. Her jaw relaxed.';
    const doc = createRepairDocument(text, clean);
    assert.deepEqual([...exactRepairTargets(doc, rule, clean, exactMatch)], ['S1', 'S3']);
    applyRepairPatches(doc, JSON.stringify({ patches: [{ id: 'S3', text: 'She nodded.' }, { id: 'S1', text: 'He paused.' }] }), ['S1', 'S3']);
    assert.equal(assembleRepairDocument(doc), 'He paused. Exactly keep this. She nodded.');
});

test('cross-sentence banned phrase identifies only minimal adjacent units', () => {
    const doc = createRepairDocument('Keep first. Stop. Now. Keep last.', clean);
    assert.deepEqual([...exactRepairTargets(doc, { term: 'Stop. Now.' }, clean, exactMatch)], ['S2', 'S3']);
});

test('honorific abbreviation does not split a normal sentence', () => {
    const doc = createRepairDocument('Dr. Smith arrived. His jaw tightened.', clean);
    assert.equal(doc.units[0].text, 'Dr. Smith arrived.');
    assert.equal(doc.units[1].text, 'His jaw tightened.');
});

for (const [name, patches] of [
    ['unapproved normal sentence', [{ id: 'S1', text: 'changed' }]],
    ['extra normal sentence', [{ id: 'S2', text: 'fixed' }, { id: 'S1', text: 'changed' }]],
    ['duplicate target', [{ id: 'S2', text: 'fixed' }, { id: 'S2', text: 'again' }]],
    ['missing target', []],
    ['new panel', [{ id: 'S2', text: '<info_panel>changed</info_panel>' }]],
    ['new line break', [{ id: 'S2', text: 'fixed\nnew paragraph' }]],
    ['extra field', [{ id: 'S2', text: 'fixed', other: 'extra' }]],
]) {
    test(`${name} patch is rejected atomically`, () => {
        const original = 'Locked. His jaw tightened. Still locked.';
        const doc = createRepairDocument(original, clean);
        assert.throws(() => applyRepairPatches(doc, JSON.stringify({ patches }), ['S2']), /부분/);
        assert.equal(assembleRepairDocument(doc), original);
        assert.equal(doc.replacements.size, 0);
    });
}

test('a free-form whole rewritten reply cannot be used as a patch', () => {
    const doc = createRepairDocument('Locked. His jaw tightened.', clean);
    assert.throws(() => applyRepairPatches(doc, 'The model rewrote the complete reply.', ['S2']), /JSON/);
    assert.equal(assembleRepairDocument(doc), doc.original);
});

test('second correction edits the same original unit ID without changing locked offsets', async () => {
    const original = 'Locked start. His jaw tightened. Locked end.';
    let calls = 0;
    const response = await runResponseGuard({ ...defaults, send: async () => {
        calls++;
        if (calls === 1) return reply(original);
        return patched([{ id: 'S2', text: calls === 2 ? 'His jaw relaxed.' : 'He paused.' }]);
    } });
    assert.equal(calls, 3);
    assert.equal((await response.json()).choices[0].message.content, 'Locked start. He paused. Locked end.');
});

test('Jev echo localization changes only the identified echo sentence', async () => {
    const echoPlan = { ...plan, terms: [], rules: [], echo: true, userText: 'I am leaving.' };
    let calls = 0;
    const response = await runResponseGuard({ ...defaults, plan: echoPlan,
        send: async () => ++calls === 1 ? reply('He set down the glass. Leaving? He opened the door.') : patched([{ id: 'S2', text: 'Wait.' }]),
        judge: async (state, questions) => {
            if (state.units) {
                assert.deepEqual(Object.keys(state.units), ['S1', 'S2', 'S3']);
                return verdict(questions, id => id.endsWith('_S2') ? 'violation' : 'pass');
            }
            return verdict(questions, () => state.candidate.includes('Leaving?') ? 'violation' : 'pass');
        },
    });
    assert.equal((await response.json()).choices[0].message.content, 'He set down the glass. Wait. He opened the door.');
});

test('whole-rule violation without any confidently located unit halts before rewriting', async () => {
    let calls = 0;
    await assert.rejects(runResponseGuard({ ...defaults, plan: { ...plan, terms: [] },
        send: async () => { calls++; return reply('Safe. Another sentence.'); },
        judge: async (state, questions) => verdict(questions, () => state.units ? 'pass' : 'violation'),
    }), /위치/);
    assert.equal(calls, 1);
});

test('uncertain localization halts without modifying any sentence', async () => {
    const doc = createRepairDocument('Safe. Another sentence.', clean);
    await assert.rejects(locateRepairTargets(doc, [{ ...rule, term: '', questionId: 'ban_0' }], plan, clean, exactMatch,
        async (_state, questions) => verdict(questions, () => 'uncertain'), null), /위반 위치가 불명확/);
    assert.equal(assembleRepairDocument(doc), doc.original);
});

test('a malformed second patch cannot partially overwrite the previous accepted patch set', () => {
    const doc = createRepairDocument('Locked. jaw. Locked too.', clean);
    applyRepairPatches(doc, JSON.stringify({ patches: [{ id: 'S2', text: 'jaw again.' }] }), ['S2']);
    const before = assembleRepairDocument(doc);
    assert.throws(() => applyRepairPatches(doc, JSON.stringify({ patches: [{ id: 'S2', text: 'fixed' }, { id: 'S3', text: 3 }] }), ['S2', 'S3']));
    assert.equal(assembleRepairDocument(doc), before);
});

test('removing an echo preserves original separators and surrounding quotes', () => {
    const doc = createRepairDocument('First. "Leaving?" Last.', clean);
    applyRepairPatches(doc, JSON.stringify({ patches: [{ id: 'S2', text: '' }] }), ['S2']);
    assert.equal(assembleRepairDocument(doc), 'First. "" Last.');
});

test('request retains original preset/profile, sends only approved IDs and requires JSON patches', () => {
    const doc = createRepairDocument('Safe. jaw. Safe again.', clean);
    const request = buildPartialRewriteBody(body, doc, new Map([['S2', [rule]]]), 'continue');
    assert.equal(request.model, body.model);
    assert.equal(request.temperature, body.temperature);
    assert.deepEqual(request.messages.slice(0, 2), body.messages);
    const finalLine = request.messages.at(-1).content.split('\n').at(-1);
    assert.deepEqual(JSON.parse(finalLine).targets.map(x => x.id), ['S2']);
    assert.match(request.messages.at(-1).content, /Return JSON only/);
    assert.match(request.messages.at(-1).content, /newly generated continuation/);
});

const streamFixtures = [
    ['custom', [{ choices: [{ delta: { reasoning_content: 'hidden thought' }, logprobs: {} }] }, { choices: [{ delta: { content: 'Locked. ' } }] }, { choices: [{ delta: { content: 'jaw. End.' }, finish_reason: 'stop' }] }]],
    ['vertexai', [{ candidates: [{ content: { parts: [{ thought: true, text: 'hidden thought' }] } }] }, { candidates: [{ content: { parts: [{ text: 'Locked. jaw.', thoughtSignature: 'stale-signature' }] } }] }, { candidates: [{ content: { parts: [{ text: ' End.' }] }, finishReason: 'STOP' }] }]],
    ['claude', [{ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hidden thought' } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Locked. jaw. End.' } }, { type: 'message_stop' }]],
    ['cohere', [{ type: 'content-delta', delta: { message: { content: { text: 'Locked. jaw.' } } } }, { type: 'content-delta', delta: { message: { content: { text: ' End.' } } } }, { type: 'message-end' }]],
];
for (const [source, events] of streamFixtures) {
    test(`${source} patched stream contains exactly the assembled text and preserves non-text events`, () => {
        const raw = events.map(x => `event: message\r\ndata: ${JSON.stringify(x)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
        const output = patchNativeResponse(raw, true, source, 'Locked. Fixed. End.');
        assert.equal(extractCandidate(output, true, source), 'Locked. Fixed. End.');
        assert.doesNotMatch(output, /jaw|stale-signature|logprobs/);
        if (source !== 'cohere') assert.match(output, /hidden thought/);
    });
}

test('Claude multi-text non-stream reply keeps ST visible paragraph separators', () => {
    const raw = JSON.stringify({ content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'First.' }, { type: 'text', text: 'jaw.' }] });
    assert.equal(extractCandidate(raw, false, 'claude'), 'First.\n\njaw.');
    const output = patchNativeResponse(raw, false, 'claude', 'First.\n\nFixed.');
    assert.equal(extractCandidate(output, false, 'claude'), 'First.\n\nFixed.');
    assert.equal(JSON.parse(output).content[0].thinking, 'hidden');
});

test('streaming end-to-end patch response JSON never leaks to the final displayed prose', async () => {
    const packet = text => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    let calls = 0;
    const response = await runResponseGuard({ ...defaults, body: { ...body, stream: true }, send: async () => ++calls === 1
        ? packet('Locked. His jaw tightened. Still locked.')
        : packet(JSON.stringify({ patches: [{ id: 'S2', text: 'He paused.' }] })),
    });
    const raw = await response.text();
    assert.equal(extractCandidate(raw, true, 'custom'), 'Locked. He paused. Still locked.');
    assert.doesNotMatch(raw, /jaw|patches|S2/);
});

test('abort between localization and patch request never publishes the candidate', async () => {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(runResponseGuard({ ...defaults, signal: controller.signal,
        send: async () => { calls++; return reply('Locked. jaw. End.'); },
        onStatus: patch => { if (patch.stage === '부분 수정 준비') controller.abort(); },
    }), { name: 'AbortError' });
    assert.equal(calls, 1);
});

test('semantic localization batches all units across rules without confusing target IDs', async () => {
    const doc = createRepairDocument(Array.from({ length: 40 }, (_, i) => `Sentence ${i + 1}.`).join(' '), clean);
    const rules = [{ ...rule, term: '', instruction: 'Do not use a particular structure.' },
        { ...rule, term: '', instruction: 'Do not repeat a particular action.' }];
    const seen = new Set();
    const sizes = [];
    const targets = await locateRepairTargets(doc, rules.map((r, i) => ({ ...r, questionId: `ban_${i}` })),
        { ...plan, rules }, clean, exactMatch, async (_state, questions) => {
            sizes.push(Object.keys(questions).length);
            for (const id of Object.keys(questions)) { assert.ok(!seen.has(id)); seen.add(id); }
            return verdict(questions, id => ['loc_0_S2', 'loc_1_S35'].includes(id) ? 'violation' : 'pass');
        }, null);
    assert.equal(seen.size, 80);
    assert.ok(sizes.length > 1 && sizes.every(size => size <= 24));
    assert.deepEqual([...targets.keys()], ['S2', 'S35']);
    assert.equal(assembleRepairDocument(doc), doc.original);
});

test('abort during localization stops before the next batch', async () => {
    const doc = createRepairDocument(Array.from({ length: 30 }, (_, i) => `Sentence ${i}.`).join(' '), clean);
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(locateRepairTargets(doc, [{ ...rule, term: '', questionId: 'ban_0' }], plan,
        clean, exactMatch, async (_state, questions) => { calls++; controller.abort(); return verdict(questions); }, controller.signal), { name: 'AbortError' });
    assert.equal(calls, 1);
});

test('end-to-end whole rewritten reply is blocked rather than replacing the draft', async () => {
    let calls = 0;
    await assert.rejects(runResponseGuard({ ...defaults, send: async () => ++calls === 1
        ? reply('Locked. jaw. Locked too.') : reply('The model changed everything.') }), /JSON/);
    assert.equal(calls, 2);
});

test('the locally assembled whole reply is rechecked after every patch', async () => {
    const echoPlan = { ...plan, echo: true, userText: 'Leaving?' };
    let calls = 0;
    let wholeChecks = 0;
    const response = await runResponseGuard({ ...defaults, plan: echoPlan,
        send: async () => {
            calls++;
            if (calls === 1) return reply('Locked start. His jaw tightened. Locked end.');
            return patched([{ id: 'S2', text: calls === 2 ? 'Leaving?' : 'Wait.' }]);
        },
        judge: async (state, questions) => {
            if (state.units) return verdict(questions, id => id.endsWith('_S2') ? 'violation' : 'pass');
            wholeChecks++;
            assert.ok(state.candidate.startsWith('Locked start.') && state.candidate.endsWith('Locked end.'));
            return verdict(questions, id => id === 'echo' && state.candidate.includes('Leaving?') ? 'violation' : 'pass');
        },
    });
    assert.equal(calls, 3);
    assert.equal(wholeChecks, 2);
    assert.equal((await response.json()).choices[0].message.content, 'Locked start. Wait. Locked end.');
});
