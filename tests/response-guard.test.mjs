import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCandidate, runResponseGuard, buildGuardQuestions } from '../response-guard.js';
import { createRepairDocument, buildWholeRewriteBody } from '../rewrite-targets.js';
import { stripNonProse } from '../detector.js';

const body = { messages: [{ role: 'system', content: 'Original rules' }, { role: 'user', content: 'I am leaving.' }],
    model: 'original-model', type: 'normal', chat_completion_source: 'custom', stream: false, temperature: 0.9 };
const rule = { term: 'jaw', label: 'jaw ban', instruction: 'Do not use jaw.', scope: 'all' };
const plan = { rules: [rule], terms: [rule], echo: false, userText: '', maxRewrites: 2, minConfidence: 0.7 };
const jsonReply = text => new Response(JSON.stringify({ choices: [{ index: 0, message: { content: text } }], usage: { total_tokens: 8 } }), { headers: { 'Content-Type': 'application/json' } });
const correctedReply = text => jsonReply(text);
const verdict = (questions, choice = 'pass', confidence = 0.95) => ({ answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'choice', choice, confidence }])) });
const base = { body, plan, clean: text => stripNonProse(text, { excludeAllTaggedBlocks: true }, { clip: false }),
    exactMatch: (text, term) => text.includes(term), judge: async (_state, questions) => verdict(questions) };

test('rejected draft stays hidden until a rewritten draft has passed a fresh check', async () => {
    const requests = [];
    let checks = 0;
    let resolveVerdict;
    const checked = new Promise(resolve => { resolveVerdict = resolve; });
    let published = false;
    const task = runResponseGuard({ ...base,
        send: async next => { requests.push(structuredClone(next)); return requests.length === 1 ? jsonReply('His jaw tightened.') : correctedReply('He shut the door.'); },
        judge: async (_state, questions) => { checks++; await checked; return verdict(questions); },
    }).then(response => { published = true; return response; });
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(published, false);
    assert.equal(requests.length, 2);
    assert.equal(checks, 1); // exact ban triggers repair before a paid semantic check
    resolveVerdict();
    assert.equal((await (await task).json()).choices[0].message.content, 'He shut the door.');
    assert.equal(requests[1].model, body.model);
    assert.equal(requests[1].temperature, body.temperature);
    assert.equal(requests[1].messages.at(-2).content, 'His jaw tightened.');
    assert.deepEqual(body.messages, [{ role: 'system', content: 'Original rules' }, { role: 'user', content: 'I am leaving.' }]);
});

test('rewrites do not accumulate old rejected drafts or repair instructions', async () => {
    const requests = [];
    const response = await runResponseGuard({ ...base, send: async next => {
        requests.push(next); return requests.length === 1 ? jsonReply('jaw 1') : correctedReply(requests.length < 3 ? `jaw ${requests.length}` : 'He left.');
    } });
    assert.equal((await response.json()).choices[0].message.content, 'He left.');
    assert.equal(requests[2].messages.length, body.messages.length + 2);
    assert.equal(requests[2].messages.at(-2).content, 'jaw 2');
});

for (const limit of [0, 1, 2, 3]) {
    test(`rewrite limit ${limit} returns the latest violating reply with a warning and no extra generation`, async () => {
        let sends = 0;
        const statuses = [];
        const response = await runResponseGuard({ ...base, plan: { ...plan, maxRewrites: limit },
            send: async () => jsonReply(`jaw draft ${++sends}`), onStatus: status => statuses.push(status) });
        assert.equal(sends, limit + 1);
        assert.equal((await response.json()).choices[0].message.content, `jaw draft ${limit + 1}`);
        assert.equal(statuses.at(-1).stage, '위반 남음 · 마지막 답변 표시');
        assert.equal(statuses.at(-1).attempt, limit);
        assert.deepEqual(statuses.at(-1).labels, [rule.label]);
        assert.equal(statuses.filter(x => x.warning).length, 1);
        assert.ok(!statuses.some(x => x.stage === '검수 통과'));
    });
}

test('semantic violation still remaining at the limit returns the latest revision without locating it again', async () => {
    let sends = 0;
    let locations = 0;
    const response = await runResponseGuard({ ...base, plan: { ...plan, terms: [], maxRewrites: 1 },
        send: async () => jsonReply(`Violating structure ${++sends}.`),
        judge: async (state, questions) => {
            if (state.units) locations++;
            return verdict(questions, 'violation');
        },
    });
    assert.equal(sends, 2);
    assert.equal(locations, 1);
    assert.equal((await response.json()).choices[0].message.content, 'Violating structure 2.');
});

test('stop on final warning prevents even an exhausted candidate being published', async () => {
    const controller = new AbortController();
    await assert.rejects(runResponseGuard({ ...base, signal: controller.signal,
        plan: { ...plan, maxRewrites: 0 }, send: async () => jsonReply('jaw'),
        onStatus: status => { if (status.warning) controller.abort(); },
    }), { name: 'AbortError' });
});

test('a forbidden expression beyond the old 8000-character analysis window is checked', async () => {
    let sends = 0;
    const prefix = 'Ordinary prose. '.repeat(600);
    const response = await runResponseGuard({ ...base, send: async () => ++sends === 1 ? jsonReply(`${prefix}jaw`) : correctedReply(`${prefix}He left.`) });
    assert.equal(sends, 2);
    assert.equal((await response.json()).choices[0].message.content, `${prefix}He left.`);
});

test('a hidden thought and an info panel do not create ban violations', async () => {
    const text = '<thinking>jaw</thinking><info_panel>jaw</info_panel>He left.';
    const response = await runResponseGuard({ ...base, send: async () => jsonReply(text), judge: async (state, questions) => {
        assert.doesNotMatch(state.candidate, /jaw/); return verdict(questions);
    } });
    assert.equal((await response.json()).choices[0].message.content, text);
});

test('echo rejection repairs and rechecks against the same AI-visible user turn', async () => {
    let sends = 0;
    let checks = 0;
    const response = await runResponseGuard({ ...base, plan: { ...plan, terms: [], rules: [], echo: true, userText: 'I am leaving.' },
        send: async () => ++sends === 1 ? jsonReply('Leaving? He looked up.') : correctedReply('He opened the door. He looked up.'),
        judge: async (state, questions) => {
            assert.equal(state.latest_user_turn, 'I am leaving.');
            checks++;
            if (Object.keys(questions).some(id => id.startsWith('loc_'))) {
                const result = verdict(questions);
                result.answers.loc_0_S1.choice = 'violation'; return result;
            }
            return verdict(questions, checks === 1 ? 'violation' : 'pass');
        },
    });
    assert.equal(checks, 3);
    assert.equal((await response.json()).choices[0].message.content, 'He opened the door. He looked up.');
});

for (const [label, answer] of [['uncertain', { choice: 'uncertain', confidence: 0.99 }],
    ['low-confidence pass', { choice: 'pass', confidence: 0.3 }],
    ['low-confidence violation', { choice: 'violation', confidence: 0.69 }],
    ['structure confidence 0.94', { choice: 'violation', confidence: 0.94 }]]) {
    test(`${label} returns the intact draft without rewriting or claiming a review pass`, async () => {
        let sends = 0;
        const statuses = [];
        const response = await runResponseGuard({ ...base, send: async () => { sends++; return jsonReply('He left.'); },
            judge: async (_s, qs) => ({ answers: Object.fromEntries(Object.keys(qs).map(id => [id, { type: 'choice', ...answer }])) }),
            onStatus: status => statuses.push(status),
        });
        assert.equal((await response.json()).choices[0].message.content, 'He left.');
        assert.equal(sends, 1);
        assert.equal(statuses.at(-1).stage, '판정 보류 · 답변 표시');
        assert.deepEqual(statuses.at(-1).labels, [rule.label]);
        assert.ok(!statuses.some(x => x.stage === '검수 통과' || x.warning));
    });
}

for (const [label, answer] of [['missing', null], ['wrong type', { type: 'noul', noul: 0 }],
    ['invalid confidence', { choice: 'pass', confidence: 1.1 }]]) {
    test(`${label} Jev verdict shows the complete reply without blind rewriting`, async () => {
        let sends = 0;
        const statuses = [];
        const response = await runResponseGuard({ ...base, send: async () => { sends++; return jsonReply('He left.'); },
            judge: async (_s, qs) => ({ answers: Object.fromEntries(Object.keys(qs).map(id => [id, answer ? { type: 'choice', ...answer } : null])) }),
            onStatus: status => statuses.push(status),
        });
        assert.equal((await response.json()).choices[0].message.content, 'He left.');
        assert.equal(statuses.at(-1).stage, '검수 건너뜀 · 마지막 답변 표시');
        assert.equal(sends, 1);
    });
}

test('an uncertain rule does not prevent repairing a different confirmed violation', async () => {
    const uncertainRule = { label: 'ambiguous', instruction: 'Avoid something unclear.', scope: 'all' };
    let sends = 0;
    const statuses = [];
    const response = await runResponseGuard({ ...base, plan: { ...plan, terms: [], rules: [rule, uncertainRule] },
        send: async next => {
            sends++;
            if (sends === 2) {
                const targets = JSON.parse(next.messages.at(-1).content.split('\n').at(-1)).targets;
                assert.deepEqual(targets.map(x => x.id), ['S1']);
                assert.ok(!JSON.stringify(targets).includes('something unclear'));
            }
            return jsonReply(sends === 1 ? 'Actual violation. Safe.' : 'Fixed. Safe.');
        },
        judge: async (state, qs) => {
            const result = verdict(qs);
            if (state.units) {
                result.answers.loc_0_S1.choice = 'violation';
                result.answers.loc_0_S2.choice = 'uncertain';
            } else {
                result.answers.ban_0.choice = sends === 1 ? 'violation' : 'pass';
                result.answers.ban_1.choice = 'uncertain';
            }
            return result;
        }, onStatus: status => statuses.push(status),
    });
    assert.equal(sends, 2);
    assert.equal((await response.json()).choices[0].message.content, 'Fixed. Safe.');
    assert.equal(statuses.at(-1).stage, '판정 보류 · 답변 표시');
    assert.deepEqual(statuses.at(-1).labels, ['ambiguous']);
});

test('stop on a deferred-verdict status still prevents publishing the draft', async () => {
    const controller = new AbortController();
    await assert.rejects(runResponseGuard({ ...base, signal: controller.signal,
        send: async () => jsonReply('He left.'), judge: async (_s, qs) => verdict(qs, 'uncertain'),
        onStatus: status => { if (status.stage === '판정 보류 · 답변 표시') controller.abort(); },
    }), { name: 'AbortError' });
});

for (const reason of ['401', '429', 'network', 'malformed response']) {
    test(`Jev ${reason} error returns the complete latest reply with a skipped-review state`, async () => {
        const statuses = [];
        const original = jsonReply('He left.');
        const raw = await original.clone().text();
        const response = await runResponseGuard({ ...base, send: async () => original,
            judge: async () => { throw new Error(reason); }, onStatus: status => statuses.push(status) });
        assert.equal(await response.text(), raw);
        assert.equal(statuses.at(-1).stage, '검수 건너뜀 · 마지막 답변 표시');
        assert.ok(!statuses.some(x => x.stage === '검수 통과' || x.warning));
    });
}

test('Jev failure after an exact-term correction returns the latest corrected reply', async () => {
    let sends = 0;
    const response = await runResponseGuard({ ...base,
        send: async () => jsonReply(++sends === 1 ? 'His jaw tightened.' : 'He left.'),
        judge: async () => { throw new Error('Jev unavailable'); },
    });
    assert.equal(sends, 2);
    assert.equal((await response.json()).choices[0].message.content, 'He left.');
});

test('Jev localization error displays the intact draft without blind rewriting', async () => {
    let sends = 0;
    const response = await runResponseGuard({ ...base, plan: { ...plan, terms: [] },
        send: async () => { sends++; return jsonReply('He left.'); },
        judge: async (state, qs) => { if (state.units) throw new Error('location failed'); return verdict(qs, 'violation'); },
    });
    assert.equal(sends, 1);
    assert.equal((await response.json()).choices[0].message.content, 'He left.');
});

test('stop on a skipped-review fallback still prevents publication', async () => {
    const controller = new AbortController();
    await assert.rejects(runResponseGuard({ ...base, signal: controller.signal,
        send: async () => jsonReply('He left.'), judge: async () => { throw new Error('network'); },
        onStatus: status => { if (status.stage === '검수 건너뜀 · 마지막 답변 표시') controller.abort(); },
    }), { name: 'AbortError' });
});

test('a provider error stops before any semantic check or rewrite', async () => {
    await assert.rejects(runResponseGuard({ ...base, send: async () => new Response('bad', { status: 500 }), judge: () => assert.fail('must not judge') }), /500/);
});

test('abort during judgment prevents publication and any following rewrite', async () => {
    const controller = new AbortController();
    await assert.rejects(runResponseGuard({ ...base, signal: controller.signal, send: async () => jsonReply('He left.'),
        judge: async (_s, qs) => { controller.abort(); return verdict(qs, 'violation'); },
    }), { name: 'AbortError' });
});

test('abort while buffering cancels a stalled stream, with no draft returned', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"secret draft"}}]}\n\n')); }, cancel() { cancelled = true; } }));
    const task = runResponseGuard({ ...base, body: { ...body, stream: true }, signal: controller.signal, send: async () => response });
    await new Promise(resolve => setTimeout(resolve, 10)); controller.abort();
    await assert.rejects(task, { name: 'AbortError' }); assert.equal(cancelled, true);
});

const fixtures = [
    ['custom', [{ choices: [{ index: 0, delta: { reasoning_content: 'hidden jaw' } }] }, { choices: [{ index: 0, delta: { content: 'He ' } }] }, { choices: [{ index: 0, delta: { content: 'left.' }, finish_reason: 'stop' }] }]],
    ['vertexai', [{ candidates: [{ content: { parts: [{ text: 'hidden jaw', thought: true }] } }] }, { candidates: [{ content: { parts: [{ text: 'He left.' }] }, finishReason: 'STOP' }] }]],
    ['claude', [{ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hidden jaw' } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'He left.' } }, { type: 'message_stop' }]],
    ['cohere', [{ type: 'content-delta', delta: { message: { content: { text: 'He left.' } } } }, { type: 'message-end' }]],
];
for (const [source, events] of fixtures) {
    test(`${source} uncertain SSE verdict replays the complete native response without rewriting`, async () => {
        const raw = events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
        let sends = 0;
        const statuses = [];
        const response = await runResponseGuard({ ...base, body: { ...body, stream: true, chat_completion_source: source },
            send: async () => { sends++; return new Response(raw, { headers: { 'Content-Type': 'text/event-stream' } }); },
            judge: async (_state, qs) => verdict(qs, 'uncertain'), onStatus: status => statuses.push(status),
        });
        assert.equal(await response.text(), raw);
        assert.equal(response.headers.get('content-type'), 'text/event-stream');
        assert.equal(sends, 1);
        assert.equal(statuses.at(-1).stage, '판정 보류 · 답변 표시');
    });
    test(`${source} Jev failure replays the complete native SSE response`, async () => {
        const raw = events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
        const response = await runResponseGuard({ ...base, body: { ...body, stream: true, chat_completion_source: source },
            send: async () => new Response(raw, { headers: { 'Content-Type': 'text/event-stream' } }),
            judge: async () => { throw new Error('Jev unavailable'); },
        });
        assert.equal(await response.text(), raw);
        assert.equal(response.headers.get('content-type'), 'text/event-stream');
    });
    test(`${source} accepted SSE is buffered and replayed without altering bytes or reasoning`, async () => {
        const raw = events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
        assert.equal(extractCandidate(raw, true, source), 'He left.');
        const response = await runResponseGuard({ ...base, body: { ...body, stream: true, chat_completion_source: source },
            send: async () => new Response(raw, { headers: { 'Content-Type': 'text/event-stream', 'content-length': '999' } }),
            judge: async (state, qs) => { assert.equal(state.candidate, 'He left.'); return verdict(qs); },
        });
        assert.equal(await response.text(), raw);
        assert.equal(response.headers.get('content-type'), 'text/event-stream');
        assert.equal(response.headers.has('content-length'), false);
    });
    test(`${source} violating SSE at the limit is replayed byte for byte with native metadata`, async () => {
        const raw = events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
        const response = await runResponseGuard({ ...base, plan: { ...plan, terms: [], maxRewrites: 0 },
            body: { ...body, stream: true, chat_completion_source: source },
            send: async () => new Response(raw, { status: 201, headers: { 'Content-Type': 'text/event-stream',
                'X-Generation': 'last', 'content-length': '999', 'content-encoding': 'gzip', 'transfer-encoding': 'chunked' } }),
            judge: async (_state, questions) => verdict(questions, 'violation'),
        });
        assert.equal(await response.text(), raw);
        assert.equal(response.status, 201);
        assert.equal(response.headers.get('X-Generation'), 'last');
        assert.equal(response.headers.get('content-type'), 'text/event-stream');
        for (const header of ['content-length', 'content-encoding', 'transfer-encoding']) assert.equal(response.headers.has(header), false);
    });
}

test('rejected streaming chunks never appear in the accepted stream', async () => {
    let sends = 0;
    const response = await runResponseGuard({ ...base, body: { ...body, stream: true }, send: async () => {
        const text = ++sends === 1 ? 'jaw' : 'He left.';
        return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);
    } });
    assert.doesNotMatch(await response.text(), /jaw/); assert.equal(sends, 2);
});

test('incomplete SSE and malformed frames block instead of passing a partial reply', () => {
    assert.throws(() => extractCandidate('data: {"choices":[{"delta":{"content":"He left."}}]}\n\n', true, 'custom'), /완전히/);
    assert.throws(() => extractCandidate('data: invalid\n\ndata: [DONE]\n\n', true, 'custom'), /형식/);
});

test('tool calls and multiple candidates are not silently published', async () => {
    for (const data of [{ choices: [{ index: 0, message: { content: 'He left.', tool_calls: [{}] } }] },
        { choices: [{ index: 0, message: { content: 'He left.' } }, { index: 1, message: { content: 'jaw' } }] }]) {
        await assert.rejects(runResponseGuard({ ...base, send: async () => new Response(JSON.stringify(data)) }), /도구|복수/);
    }
});

test('oversized state is blocked rather than clipped into an apparent pass', () => {
    assert.throws(() => buildGuardQuestions(plan, 'x'.repeat(60000)), /너무 커요/);
});

test('rewrite preserves other instructions and does not judge WEAVE', () => {
    const { state, questions } = buildGuardQuestions(plan, 'He left.');
    assert.equal('system' in state, false);
    assert.equal('history' in state, false);
    assert.deepEqual(Object.keys(questions), ['ban_0']);
    const original = { ...body, type: 'continue', messages: [...body.messages, { role: 'system', content: '<ANTI_METAGAMING>Original.</ANTI_METAGAMING>' }] };
    const rewritten = buildWholeRewriteBody(original, createRepairDocument('bad draft'), new Map([['S1', [rule]]]));
    assert.equal(rewritten.messages[2].content, original.messages[2].content);
    assert.match(rewritten.messages.at(-1).content, /newly generated continuation/);
    assert.equal(original.messages.length, 3);
});
