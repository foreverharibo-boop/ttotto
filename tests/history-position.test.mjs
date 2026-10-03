import test from 'node:test';
import assert from 'node:assert/strict';

const context = { eventTypes: { APP_READY: 'ready' }, eventSource: { on() {}, removeListener() {} }, extensionSettings: {}, chatMetadata: {}, chat: [], characters: [], groups: [], setExtensionPrompt() {}, saveSettingsDebounced() {}, saveMetadataDebounced() {} };
globalThis.SillyTavern = { getContext: () => context };
const module = await import('../index.js?history-position-regression');
const groups = [{ key: 'weave', position: 'depth_0', content: 'TT_RULES' }];

test('depth 0 누락 보충은 실제 히스토리 끝과 후속 프리셋 사이에 삽입한다', () => {
    const chat = [{ is_user: true, mes: 'Scene' }];
    const messages = [{ role: 'user', content: 'Scene' }, { role: 'system', content: 'POST_HISTORY_PRESET' }, { role: 'system', content: 'CI_FINAL' }];
    module.appendGenerationGroups(messages, groups, { chat });
    assert.deepEqual(messages.map(item => item.content), ['Scene', 'TT_RULES', 'POST_HISTORY_PRESET', 'CI_FINAL']);
    assert.deepEqual(module.appendGenerationGroups(messages, groups, { chat }), []);
});

test('새 assistant 프리필을 실제 이전 채팅으로 오인하지 않는다', () => {
    const messages = [{ role: 'user', content: 'Scene' }, { role: 'assistant', content: 'NEW_PREFILL' }, { role: 'system', content: 'CI_FINAL' }];
    module.appendGenerationGroups(messages, groups, { chat: [{ is_user: true, mes: 'Scene' }] });
    assert.deepEqual(messages.map(item => item.content), ['Scene', 'TT_RULES', 'NEW_PREFILL', 'CI_FINAL']);
});

test('continue에서는 실제 마지막 assistant 기록 뒤에 넣고 재생성에서는 보낸 user 뒤에 넣는다', () => {
    const chat = [{ is_user: true, mes: 'Scene' }, { is_user: false, mes: 'Previous reply' }];
    for (const includeReply of [true, false]) {
        const messages = [{ role: 'user', content: 'Scene' }, ...(includeReply ? [{ role: 'assistant', content: 'Previous reply' }] : []), { role: 'system', content: 'TAIL' }];
        module.appendGenerationGroups(messages, groups, { chat });
        assert.equal(messages.at(-2).content, 'TT_RULES');
        assert.equal(messages.at(-3).content, includeReply ? 'Previous reply' : 'Scene');
        assert.equal(messages.at(-1).content, 'TAIL');
    }
});

test('이름 접두사·번역 원문·멀티모달과 숨긴 기록을 처리하며 채팅을 보존한다', () => {
    const chat = [{ is_user: true, mes: '장면', extra: { original_text: 'Scene' } }, { is_user: false, is_hidden: true, mes: 'HIDDEN' }];
    const snapshot = structuredClone(chat);
    const attachment = { type: 'image_url', image_url: { url: 'fixture' } };
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'Dana: Scene' }, attachment] }, { role: 'system', content: 'TAIL' }];
    module.appendGenerationGroups(messages, groups, { chat, names: { userName: 'Dana' } });
    assert.equal(messages[1].content, 'TT_RULES');
    assert.strictEqual(messages[0].content[1], attachment);
    assert.deepEqual(chat, snapshot);
});

test('이미 등록된 depth 0 본문과 다른 확장 내용은 이동하거나 삭제하지 않는다', () => {
    const existing = { role: 'system', content: 'TT_RULES' };
    const messages = [existing, { role: 'user', content: 'Scene' }, { role: 'system', content: 'TAIL' }];
    const snapshot = structuredClone(messages);
    assert.deepEqual(module.appendGenerationGroups(messages, groups, { chat: [{ is_user: true, mes: 'Scene' }] }), []);
    assert.deepEqual(messages, snapshot);
    assert.strictEqual(messages[0], existing);
});

test('생성 시작 시 저장한 실제 턴을 사용할 수 있고 모호한 동문 반복은 경계를 추측하지 않는다', async () => {
    const { findHistoryEnd } = await import('../history-position.js');
    assert.equal(findHistoryEnd([{ role: 'user', content: 'Scene' }, { role: 'system', content: 'TAIL' }], [], {}, [{ role: 'user', text: 'Scene' }]), 1);
    assert.equal(findHistoryEnd([{ role: 'user', content: 'Scene' }, { role: 'user', content: 'Scene' }], [{ is_user: true, mes: 'Scene' }]), null);
    assert.equal(findHistoryEnd([{ role: 'assistant', content: 'NEW_PREFILL' }], [{ is_user: true, mes: 'Missing turn' }]), null);
});

test('UI는 depth 0을 히스토리 끝으로 설명하고 저장값·WEAVE 원문·별 문구는 유지한다', async () => {
    const { readFile } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(source, /채팅 히스토리 끝 \(기존 depth 0\)/);
    assert.match(source, /const PROMPT_POSITION_DEPTH_ZERO = 'depth_0'/);
    assert.doesNotMatch(source, /🌀또또\s+v\d/);
    const prompt = await readFile(new URL('../important-prompts.js', import.meta.url));
    assert.equal(createHash('sha256').update(prompt).digest('hex'), '7a17f6054796107cb3875eef79a159ceb2b5bd6b50df551ac0dabd79ca6a8025');
    const html = await readFile(new URL('../settings.html', import.meta.url), 'utf8');
    assert.match(html, /⭐ weave의 프롬은 탈옥과 가까운 자리에 넣어주세요\. ⭐/);
});
