import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { GuardError } from '../response-guard.js';

test('a fired deadline exhausts the budget even if the clock reports a fractional remainder', async () => {
    const source = fs.readFileSync(new URL('../response-guard.js', import.meta.url), 'utf8');
    const code = source.slice(source.indexOf('function boundedReviewJudge('), source.indexOf('\nexport async function runResponseGuard('));
    let clock = 0, fire, calls = 0;
    const scope = { MAX_REVIEW_WAIT_MS: 1000, GuardError, AbortController, DOMException,
        performance: { now: () => clock }, checkAbort(signal) { if (signal?.aborted) throw new DOMException('cancelled', 'AbortError'); },
        setTimeout(callback) { fire = callback; return 1; }, clearTimeout() {} };
    vm.createContext(scope); vm.runInContext(code, scope);
    const judge = scope.boundedReviewJudge(() => { calls++; return new Promise(() => {}); }, null, 2);
    const pending = judge({}, {}); await Promise.resolve();
    clock = 1.5; fire();
    await assert.rejects(pending, error => error.reviewTimeout === true);
    await assert.rejects(judge({}, {}), error => error.reviewTimeout === true);
    assert.equal(calls, 1);
});
