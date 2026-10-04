import test from 'node:test';
import assert from 'node:assert/strict';
import { requestJev, JEV_URL } from '../jev-client.js';

const questions = { ban_0: { type: 'choice', instructions: 'Is this expression absent?', criteria: { pass: 'Absent', violation: 'Present', uncertain: 'Unclear' } } };
const good = () => new Response(JSON.stringify({ answers: { ban_0: { type: 'choice', choice: 'pass', confidence: 0.925,
    probabilities: { pass: 0.95, violation: 0.04, uncertain: 0.01 } } } }));
const options = { key: 'fake-key-for-test', headers: { 'X-CSRF-Token': 'fake-csrf' } };

test('uses 100LOG relay without altering an active connection profile or caller data', async () => {
    const state = { candidate: 'He left.' };
    const snapshot = structuredClone(state);
    const result = await requestJev(state, questions, { ...options, fetcher: async (url, init) => {
        assert.equal(url, '/api/backends/chat-completions/generate');
        const payload = JSON.parse(init.body);
        assert.equal(payload.type, 'quiet');
        assert.equal(payload.custom_url, `${JEV_URL}?via=`);
        assert.equal(payload.chat_completion_source, 'custom');
        assert.equal(payload.model, 'jev-latest');
        assert.deepEqual(JSON.parse(payload.custom_include_body), { state, questions });
        assert.deepEqual(JSON.parse(payload.custom_include_headers), { Authorization: 'Bearer fake-key-for-test' });
        assert.ok(JSON.parse(payload.custom_exclude_body).includes('messages'));
        assert.equal(payload.secret_id, undefined);
        assert.equal(init.headers['X-CSRF-Token'], 'fake-csrf');
        return good();
    } });
    assert.equal(result.answers.ban_0.choice, 'pass');
    assert.deepEqual(state, snapshot);
    assert.deepEqual(options.headers, { 'X-CSRF-Token': 'fake-csrf' });
});

test('fallback to direct request occurs only when relay is unavailable', async () => {
    const urls = [];
    await requestJev({}, questions, { ...options, fetcher: async (url, init) => {
        urls.push(url);
        if (urls.length === 1) return new Response('', { status: 404 });
        assert.equal(init.credentials, 'omit');
        assert.equal(init.referrerPolicy, 'no-referrer');
        return good();
    } });
    assert.deepEqual(urls, ['/api/backends/chat-completions/generate', JEV_URL]);
});

test('fallback to built-in proxy preserves CSRF and uses official target only', async () => {
    const urls = [];
    await requestJev({}, questions, { ...options, fetcher: async (url, init) => {
        urls.push(url);
        if (urls.length === 1) return new Response('', { status: 405 });
        if (urls.length === 2) throw new TypeError('CORS');
        assert.equal(init.headers['X-CSRF-Token'], 'fake-csrf');
        return good();
    } });
    assert.equal(urls[2], `/proxy/${encodeURIComponent(JEV_URL)}`);
});

test('401 is not retried through another transport and never leaks raw response', async () => {
    let calls = 0;
    await assert.rejects(requestJev({}, questions, { ...options, fetcher: async () => {
        calls++; return new Response('fake-key-for-test-private', { status: 401 });
    } }), error => { assert.match(error.message, /인증/); assert.doesNotMatch(error.message, /fake-key/); return true; });
    assert.equal(calls, 1);
});

test('ST-wrapped HTTP-200 authentication error is rejected', async () => {
    await assert.rejects(requestJev({}, questions, { ...options, fetcher: async () => new Response(JSON.stringify({ error: { message: 'invalid API key', code: 401 } })) }), /인증/);
});

test('missing answers and contradictory probability distribution are rejected', async () => {
    for (const result of [{ answers: {} }, { answers: { ban_0: { type: 'choice', choice: 'pass', confidence: 0.9,
        probabilities: { pass: 0.05, violation: 0.9, uncertain: 0.05 } } } }]) {
        await assert.rejects(requestJev({}, questions, { ...options, fetcher: async () => new Response(JSON.stringify(result)) }), /판정/);
    }
});

test('abort never falls back after cancelling the relay', async () => {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(requestJev({}, questions, { ...options, signal: controller.signal, fetcher: async () => {
        calls++; controller.abort(); throw new DOMException('stopped', 'AbortError');
    } }), { name: 'AbortError' });
    assert.equal(calls, 1);
});

test('long Retry-After stops instead of issuing more paid calls immediately', async () => {
    let calls = 0;
    await assert.rejects(requestJev({}, questions, { ...options, fetcher: async () => {
        calls++; return new Response('', { status: 429, headers: { 'Retry-After': '120' } });
    } }), /한도/);
    assert.equal(calls, 1);
});

test('missing key sends no request', async () => {
    await assert.rejects(requestJev({}, questions, { ...options, key: '', fetcher: () => assert.fail('must not call') }), /API 키/);
});
