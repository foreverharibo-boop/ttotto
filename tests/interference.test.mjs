import test from 'node:test';
import assert from 'node:assert/strict';

const context = {
    eventTypes: { APP_READY: 'ready' }, eventSource: { on() {}, removeListener() {} },
    extensionSettings: {}, chatMetadata: {}, chat: [], characters: [], groups: [],
    setExtensionPrompt() {}, saveSettingsDebounced() {}, saveMetadataDebounced() {},
};
globalThis.SillyTavern = { getContext: () => context };
const module = await import('../index.js?interference-regression');

test('사용자 인용문과 다른 프롬프트의 짧은 WEAVE 태그를 자기 전문으로 오인하지 않는다', () => {
    const content = '<ANTI_METAGAMING>Complete original rules.</ANTI_METAGAMING>';
    const quote = { role: 'user', content: `Quotation: ${content}` };
    const other = { role: 'system', content: '<ANTI_METAGAMING>OTHER RULES</ANTI_METAGAMING>' };
    const messages = [quote, other];
    assert.deepEqual(module.appendGenerationGroups(messages, [{ key: 'weave', content }]), ['weave']);
    assert.strictEqual(messages[0], quote);
    assert.equal(messages[0].content, `Quotation: ${content}`);
    assert.strictEqual(messages[1], other);
    assert.deepEqual(module.appendGenerationGroups(messages, [{ key: 'weave', content }]), []);
});

test('중복 대상과 비활성 프리셋은 다른 항목에 끼워 넣지 않고 명시적으로 실패한다', () => {
    const prompt = { identifier: 'target', content: 'Target.' };
    const groups = [{ key: 'weave', position: 'preset_after_target', content: 'OWN RULES' }];
    const messages = [{ role: 'system', content: 'Target. Target.' }, { role: 'system', content: 'Target.' }];
    const snapshot = structuredClone(messages);
    const duplicate = module.insertPresetRelativeGroups(messages, groups, [prompt]);
    assert.equal(duplicate.inserted.length, 0);
    assert.equal(duplicate.missing[0].reason, 'content_missing_or_ambiguous');
    assert.deepEqual(messages, snapshot);
    const disabled = [{ role: 'system', content: 'Target.' }];
    const result = module.insertPresetRelativeGroups(disabled, groups, [{ ...prompt, enabledInPreset: false }]);
    assert.equal(result.missing[0].reason, 'preset_disabled');
    assert.equal(disabled.length, 1);
});
