import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepairDocument, exactRepairTargets, buildWholeRewriteBody } from '../rewrite-targets.js';
import { runResponseGuard, extractCandidate, locateRepairTargets } from '../response-guard.js';
import { stripNonProse } from '../detector.js';

const clean = text => stripNonProse(text, { excludeAllTaggedBlocks: true }, { clip: false }).normalize('NFKC');
const exactMatch = (text, term) => text.includes(term);
const rule = { term: 'jaw', label: 'jaw', instruction: 'Do not use jaw.', scope: 'all' };
const plan = { terms: [rule], rules: [rule], echo: false, userText: '', maxRewrites: 2, minConfidence: 0.7 };
const body = { messages: [{ role: 'system', content: '<ANTI_METAGAMING>Original weave</ANTI_METAGAMING>' }, { role: 'user', content: 'Open the door.' }], model: 'unchanged', temperature: 0.9, stream: false, chat_completion_source: 'custom', type: 'normal' };
const reply = text => new Response(JSON.stringify({ choices: [{ index: 0, message: { content: text } }] }));
const verdict = (questions, fn = () => 'pass', confidence = 0.95) => ({ answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'choice', choice: fn(id), confidence }])) });
const defaults = { body, plan, clean, exactMatch, judge: async (_state, questions) => verdict(questions) };

test('whole corrected reply is returned exactly as the model wrote it, with no sentence splice', async () => {
    const original = 'Original start. His jaw tightened. Original end.';
    const corrected = 'Model start. He paused.\r\n\r\nModel end. 🐈';
    const raw = JSON.stringify({ choices: [{ message: { content: corrected, reasoning_content: 'new reasoning' }, logprobs: { new: true } }], usage: { total_tokens: 42 } });
    let calls = 0;
    const response = await runResponseGuard({ ...defaults, send: async request => {
        if (++calls === 1) return reply(original);
        assert.equal(request.messages.at(-2).content, original);
        assert.match(request.messages.at(-1).content, /complete corrected assistant reply/);
        assert.match(request.messages.at(-1).content, /"id":"S2"/);
        assert.match(request.messages.at(-1).content, /Keep every unaffected sentence/);
        return new Response(raw, { status: 201, headers: { 'Content-Type': 'application/json', 'X-Revision': 'second', 'Content-Length': '999' } });
    } });
    assert.equal(await response.text(), raw);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('X-Revision'), 'second');
    assert.equal(response.headers.has('Content-Length'), false);
    assert.equal(calls, 2);
});

test('rewrite request keeps model, preset messages and user settings untouched and contains only identified targets', () => {
    const snapshot = structuredClone(body);
    const doc = createRepairDocument('Safe. jaw. Last.', clean);
    const request = buildWholeRewriteBody(body, doc, new Map([['S2', [rule]]]), 'continue');
    assert.equal(request.model, body.model);
    assert.equal(request.temperature, body.temperature);
    assert.deepEqual(request.messages.slice(0, body.messages.length), body.messages);
    assert.equal(request.messages.at(-2).content, doc.original);
    assert.deepEqual(JSON.parse(request.messages.at(-1).content.split('\n').at(-1)).targets.map(x => x.id), ['S2']);
    assert.match(request.messages.at(-1).content, /do not repeat the existing assistant prefix/);
    assert.deepEqual(body, snapshot);
});

test('each revision relocates violations using the latest full draft and does not accumulate earlier drafts', async () => {
    const requests = [];
    const response = await runResponseGuard({ ...defaults, send: async request => {
        requests.push(structuredClone(request));
        if (requests.length === 1) return reply('First. jaw. Last.');
        if (requests.length === 2) return reply('New opening. Extra sentence. jaw. New ending.');
        return reply('New opening. Extra sentence. Fixed. New ending.');
    } });
    assert.equal(requests[2].messages.at(-2).content, 'New opening. Extra sentence. jaw. New ending.');
    assert.equal(requests[2].messages.length, body.messages.length + 2);
    assert.deepEqual(JSON.parse(requests[1].messages.at(-1).content.split('\n').at(-1)).targets.map(x => x.id), ['S2']);
    assert.deepEqual(JSON.parse(requests[2].messages.at(-1).content.split('\n').at(-1)).targets.map(x => x.id), ['S3']);
    assert.equal((await response.json()).choices[0].message.content, 'New opening. Extra sentence. Fixed. New ending.');
});

test('multiple exact violations are included in one complete-reply revision request', async () => {
    let calls = 0;
    const response = await runResponseGuard({ ...defaults, send: async request => {
        if (++calls === 1) return reply('jaw. Safe middle. jaw.');
        const targets = JSON.parse(request.messages.at(-1).content.split('\n').at(-1)).targets;
        assert.deepEqual(targets.map(x => x.id), ['S1', 'S3']);
        return reply('He paused. Safe middle. She nodded.');
    } });
    assert.equal(calls, 2);
    assert.equal((await response.json()).choices[0].message.content, 'He paused. Safe middle. She nodded.');
});

test('entire model revision is checked for new forbidden terms before any response is returned', async () => {
    let calls = 0;
    const response = await runResponseGuard({ ...defaults, send: async request => {
        calls++;
        if (calls === 1) return reply('jaw. Safe.');
        if (calls === 2) return reply('Fixed. New jaw.');
        assert.equal(request.messages.at(-2).content, 'Fixed. New jaw.');
        return reply('Fixed. New pause.');
    } });
    assert.equal(calls, 3);
    assert.equal((await response.json()).choices[0].message.content, 'Fixed. New pause.');
});

test('semantic violation location is supplied to the model before rechecking its whole revision', async () => {
    const semanticRule = { ...rule, term: '', instruction: 'Avoid repeated quote-and-react construction.' };
    let calls = 0;
    let checks = 0;
    const response = await runResponseGuard({ ...defaults, plan: { ...plan, terms: [], rules: [semanticRule] },
        send: async request => {
            if (++calls === 1) return reply('Safe start. Repeated form. Safe end.');
            assert.deepEqual(JSON.parse(request.messages.at(-1).content.split('\n').at(-1)).targets.map(x => x.id), ['S2']);
            return reply('Safe start. Fresh reaction. Safe end.');
        },
        judge: async (state, questions) => {
            checks++;
            if (state.units) return verdict(questions, id => id.endsWith('_S2') ? 'violation' : 'pass');
            return verdict(questions, () => state.candidate.includes('Repeated form.') ? 'violation' : 'pass');
        },
    });
    assert.equal(checks, 3);
    assert.equal((await response.json()).choices[0].message.content, 'Safe start. Fresh reaction. Safe end.');
});

for (const bad of ['{"patches":[{"id":"S1","text":"fixed"}]}', '```json\n{"patches":[]}\n```']) {
    test(`obsolete patch response is rejected instead of shown: ${bad.slice(0, 20)}`, async () => {
        let calls = 0;
        await assert.rejects(runResponseGuard({ ...defaults, send: async () => ++calls === 1 ? reply('jaw.') : reply(bad) }), /전체 수정 답변/);
        assert.equal(calls, 2);
    });
}

test('empty complete revision fails rather than falling back to the original draft', async () => {
    let calls = 0;
    await assert.rejects(runResponseGuard({ ...defaults, send: async () => ++calls === 1 ? reply('jaw.') : reply('  ') }), /비어/);
});

test('stop before a revision request prevents both revision and publication', async () => {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(runResponseGuard({ ...defaults, signal: controller.signal,
        send: async () => { calls++; return reply('jaw.'); },
        onStatus: status => { if (status.stage === '최소 수정 준비') controller.abort(); },
    }), { name: 'AbortError' });
    assert.equal(calls, 1);
});

const nativeStreams = [
    ['custom', [{ choices: [{ delta: { reasoning_content: 'revision reasoning' }, logprobs: {} }] }, { choices: [{ delta: { content: 'Corrected.\n\nWhole reply.' }, finish_reason: 'stop' }] }]],
    ['vertexai', [{ candidates: [{ content: { parts: [{ thought: true, text: 'revision reasoning' }] } }] }, { candidates: [{ content: { parts: [{ text: 'Corrected.\n\nWhole reply.', thoughtSignature: 'new-signature' }] }, finishReason: 'STOP' }] }]],
    ['claude', [{ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'revision reasoning' } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Corrected.\n\nWhole reply.' } }, { type: 'message_stop' }]],
    ['cohere', [{ type: 'content-delta', delta: { message: { content: { text: 'Corrected.\n\nWhole reply.' } } } }, { type: 'message-end' }]],
];
for (const [source, events] of nativeStreams) {
    test(`${source} accepted complete revision stream and its metadata are replayed byte for byte`, async () => {
        const raw = events.map(x => `event: message\r\ndata: ${JSON.stringify(x)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
        let calls = 0;
        const originalEvents = source === 'claude' ? [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'jaw.' } }, { type: 'message_stop' }]
            : source === 'vertexai' ? [{ candidates: [{ content: { parts: [{ text: 'jaw.' }] }, finishReason: 'STOP' }] }]
                : source === 'cohere' ? [{ type: 'content-delta', delta: { message: { content: { text: 'jaw.' } } } }, { type: 'message-end' }]
                    : [{ choices: [{ delta: { content: 'jaw.' }, finish_reason: 'stop' }] }];
        const original = originalEvents.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n';
        const response = await runResponseGuard({ ...defaults, body: { ...body, stream: true, chat_completion_source: source },
            send: async () => new Response(++calls === 1 ? original : raw, { headers: { 'Content-Type': 'text/event-stream' } }),
        });
        const actual = await response.text();
        assert.equal(actual, raw);
        assert.equal(extractCandidate(actual, true, source), 'Corrected.\n\nWhole reply.');
    });
}

test('markup panels, code, comments and thought blocks cannot become editable targets', () => {
    const protectedText = '<thinking>jaw. hidden.</thinking>\n<info_panel>jaw. x.</info_panel>\n<!-- jaw. -->\n```text\njaw.\n```\n';
    const doc = createRepairDocument(`${protectedText}Safe. His jaw tightened.`, clean);
    assert.deepEqual(doc.units.map(x => x.text), ['Safe.', 'His jaw tightened.']);
    assert.equal(doc.original, `${protectedText}Safe. His jaw tightened.`);
});

test('unclosed hidden thought stays locked and no hidden word is repaired', () => {
    const doc = createRepairDocument('Safe. <thinking>jaw. still hidden.', clean);
    assert.deepEqual(doc.units.map(x => x.text), ['Safe.']);
    assert.deepEqual([...exactRepairTargets(doc, rule, clean, exactMatch)], []);
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

test('whole-rule violation without any confidently located unit shows the latest reply without rewriting', async () => {
    let calls = 0;
    const statuses = [];
    const response = await runResponseGuard({ ...defaults, plan: { ...plan, terms: [] },
        send: async () => { calls++; return reply('Safe. Another sentence.'); },
        judge: async (state, questions) => verdict(questions, () => state.units ? 'pass' : 'violation'),
        onStatus: status => statuses.push(status),
    });
    assert.equal((await response.json()).choices[0].message.content, 'Safe. Another sentence.');
    assert.equal(statuses.at(-1).stage, '위반 위치 미확인 · 마지막 답변 표시');
    assert.ok(!statuses.some(x => x.stage === '검수 통과'));
    assert.equal(calls, 1);
});

test('uncertain localization leaves no targets and reports the unresolved rule', async () => {
    const doc = createRepairDocument('Safe. Another sentence.', clean);
    const deferred = [];
    const issue = { ...rule, term: '', questionId: 'ban_0' };
    const targets = await locateRepairTargets(doc, [issue], plan, clean, exactMatch,
        async (_state, questions) => verdict(questions, () => 'uncertain'), null, deferred);
    assert.equal(targets.size, 0);
    assert.deepEqual(deferred, [issue]);
});

test('low-confidence localization is skipped while another clear target is retained', async () => {
    const doc = createRepairDocument('First. Second.', clean);
    const targets = await locateRepairTargets(doc, [{ ...rule, term: '', questionId: 'ban_0' }], plan, clean, exactMatch,
        async (_state, questions) => {
            const result = verdict(questions, () => 'violation');
            result.answers.loc_0_S1.confidence = 0.94;
            return result;
        }, null);
    assert.deepEqual([...targets.keys()], ['S2']);
});

test('a malformed localization response remains an error rather than an uncertain verdict', async () => {
    const doc = createRepairDocument('Safe.', clean);
    await assert.rejects(locateRepairTargets(doc, [{ ...rule, term: '', questionId: 'ban_0' }], plan, clean, exactMatch,
        async () => ({ answers: {} }), null), /판정이 누락|형식/);
});

test('stop on the unlocated-violation status prevents publishing the last reply', async () => {
    const controller = new AbortController();
    await assert.rejects(runResponseGuard({ ...defaults, plan: { ...plan, terms: [] }, signal: controller.signal,
        send: async () => reply('Safe.'),
        judge: async (state, qs) => verdict(qs, () => state.units ? 'uncertain' : 'violation'),
        onStatus: status => { if (status.stage === '위반 위치 미확인 · 마지막 답변 표시') controller.abort(); },
    }), { name: 'AbortError' });
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
            assert.ok(JSON.stringify({ state: _state, questions }).length <= 60000);
            assert.ok(Object.values(_state.restrictions).some(text => text.includes(rules[0].instruction)));
            assert.ok(Object.values(questions).every(q => q.instructions.includes('state.restrictions.R')));
            for (const id of Object.keys(questions)) { assert.ok(!seen.has(id)); seen.add(id); }
            return verdict(questions, id => ['loc_0_S2', 'loc_1_S35'].includes(id) ? 'violation' : 'pass');
        }, null);
    assert.equal(seen.size, 80);
    assert.ok(sizes.length < 4 && sizes.every(size => size <= 96));
    assert.deepEqual([...targets.keys()], ['S2', 'S35']);
});

test('abort during localization stops before the next batch', async () => {
    const doc = createRepairDocument(Array.from({ length: 30 }, (_, i) => `Sentence ${i}.`).join(' '), clean);
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(locateRepairTargets(doc, [{ ...rule, term: '', questionId: 'ban_0' }], plan,
        clean, exactMatch, async (_state, questions) => { calls++; controller.abort(); return verdict(questions); }, controller.signal), { name: 'AbortError' });
    assert.equal(calls, 1);
});
