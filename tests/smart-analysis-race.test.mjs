import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fingerprintMessages } from '../detector.js';

// Execute the production async function and reset handler with a deferred
// provider, including providers that ignore AbortSignal.
const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const run = source.slice(source.indexOf('async function runSmartAnalysis('), source.indexOf('\nfunction scheduleSmartAnalysis('));
const stale = source.slice(source.indexOf('function markSmartResultsStale('), source.indexOf('\nfunction scheduleAnalysis('));
const resetStart = source.indexOf("document.getElementById('ttotto-clear-smart').addEventListener");
const reset = source.slice(resetStart, source.indexOf("\n    document.getElementById('ttotto-clear-memory')", resetStart));
function fixture() {
    const messages = Array.from({ length: 4 }, (_, i) => ({ id: `id-${i}`, key: `key-${i}`, text: `original body ${i}`, speaker: 'Character' }));
    const state = { enabled: true, smart: { patterns: [], messageKeys: [], stale: false, error: '' } };
    const ctx = { chatMetadata: { ttotto: state } };
    const settings = { enabled: true, smartAnalysis: true };
    let resolve, reject, resetHandler, saves = 0;
    const scope = { runtimeActive: true, smartRunning: false, smartAbortController: null, smartRevision: 0,
        AbortController, console: { error() {} }, LOG_PREFIX: 'test',
        getSettings: () => settings, getContext: () => ctx, getChatState: () => ctx.chatMetadata.ttotto,
        collectAssistantMessages: () => structuredClone(messages), countAssistantMessages: () => messages.length,
        getChatIdentity: () => 'chat-A', updateUi() {}, fingerprintMessages,
        requestSmartAnalysis: () => new Promise((a, b) => { resolve = a; reject = b; }),
        parseSmartResponse: () => [{ label: 'accepted analysis' }], saveChatState: () => { saves++; },
        invalidateAnalysis() {}, analyzeCurrentChat() {}, confirmAction: async () => true,
        createDefaultChatState: () => ({ smart: { patterns: [], messageKeys: [], stale: false, error: '' } }),
        toastr: { success() {}, info() {} }, document: { getElementById: () => ({ addEventListener: (_, fn) => { resetHandler = fn; } }) },
    };
    vm.createContext(scope); vm.runInContext(`${run}\n${stale}\n${reset}`, scope);
    return { scope, state, ctx, settings, messages, run: () => scope.runSmartAnalysis(),
        finish: () => resolve('old result'), fail: () => reject(Error('late provider error')),
        reset: () => resetHandler(), saves: () => saves };
}
for (const change of ['reset', 'body', 'cancel', 'metadata', 'disabled', 'stale']) {
    test(`late smart analysis is discarded after ${change}`, async () => {
        const f = fixture(), pending = f.run();
        if (change === 'reset') await f.reset();
        if (change === 'body') f.messages[3].text = 'a different selected answer';
        if (change === 'cancel') f.scope.smartAbortController.abort();
        if (change === 'metadata') f.ctx.chatMetadata = { ttotto: { ...f.state } };
        if (change === 'disabled') f.settings.smartAnalysis = false;
        if (change === 'stale') f.scope.markSmartResultsStale();
        const before = f.saves(); f.finish();
        assert.equal(await pending, false);
        assert.equal(f.state.smart.patterns.length, 0);
        assert.equal(f.saves(), before, 'no late save');
        assert.equal(f.scope.smartRunning, false);
    });
}
test('late provider errors cannot repopulate cleared analysis', async () => {
    const f = fixture(), pending = f.run(); await f.reset();
    const before = f.saves(); f.fail();
    assert.equal(await pending, false); assert.equal(f.state.smart.error, ''); assert.equal(f.saves(), before);
});
test('unchanged analysis and a fresh request after reset still save normally', async () => {
    const f = fixture(); let pending = f.run(); f.finish();
    assert.equal(await pending, true); assert.equal(f.state.smart.patterns.length, 1);
    pending = f.run(); await f.reset(); f.finish(); assert.equal(await pending, false);
    pending = f.run(); f.finish(); assert.equal(await pending, true);
    assert.equal(f.state.smart.patterns.length, 1);
});
