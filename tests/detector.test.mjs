import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildInjection,
    detectPatterns,
    splitDialogueAndNarration,
} from '../detector.js';

const settings = {
    sensitivity: 'normal',
    narrationEnabled: true,
    dialogueEnabled: true,
};

test('대사와 서술을 분리한다', () => {
    const parts = splitDialogueAndNarration('*He looked away.* "I know. I know." She sighed.');
    assert.deepEqual(parts.dialogue, ['I know. I know.']);
    assert.equal(parts.narration.length, 2);
});

test('서로 다른 답변의 반복 서술 습관을 감지한다', () => {
    const messages = [
        { id: '1', speaker: 'Peter', text: 'His jaw tightened as he looked away from her.' },
        { id: '2', speaker: 'Peter', text: 'His jaw tightened when the door clicked shut.' },
        { id: '3', speaker: 'Peter', text: 'His jaw tightened at the sound of her voice.' },
        { id: '4', speaker: 'Peter', text: 'He crossed the room without looking back.' },
    ];
    const patterns = detectPatterns(messages, settings, ['Peter']);
    assert.ok(patterns.some((pattern) => pattern.scope === 'narration' && /신체|반복 구절|구조/.test(pattern.label)));
});

test('캐릭터 대사 반복을 서술과 별도로 감지한다', () => {
    const messages = [
        { id: '1', speaker: 'Peter', text: '"Are you serious right now?" He stared at her.' },
        { id: '2', speaker: 'Peter', text: '"Are you serious right now?" He stepped back.' },
        { id: '3', speaker: 'Peter', text: '"Are you serious right now?" His voice dropped.' },
        { id: '4', speaker: 'Peter', text: '"Are you serious right now?" He shook his head.' },
    ];
    const patterns = detectPatterns(messages, settings, ['Peter']);
    assert.ok(patterns.some((pattern) => pattern.scope === 'dialogue' && pattern.speaker === 'Peter'));
});

test('그룹챗에서 서로 다른 화자의 대사를 하나의 반복으로 섞지 않는다', () => {
    const messages = [
        { id: '1', speaker: 'Peter', text: '"You cannot be serious."' },
        { id: '2', speaker: 'Dana', text: '"You cannot be serious."' },
        { id: '3', speaker: 'Peter', text: '"You cannot be serious."' },
        { id: '4', speaker: 'Dana', text: '"You cannot be serious."' },
    ];
    const patterns = detectPatterns(messages, settings, ['Peter', 'Dana']);
    assert.equal(patterns.filter((pattern) => pattern.scope === 'dialogue').length, 0);
});

test('사용자 설정 수만큼 주입하고 내용 보존 지침을 포함한다', () => {
    const patterns = [
        { scope: 'narration', instruction: 'Avoid A.' },
        { scope: 'dialogue', instruction: 'Avoid B.' },
        { scope: 'dialogue', instruction: 'Avoid C.' },
    ];
    const prompt = buildInjection(patterns, 2);
    assert.match(prompt, /Preserve all plot facts/);
    assert.match(prompt, /Avoid A/);
    assert.match(prompt, /Avoid B/);
    assert.doesNotMatch(prompt, /Avoid C/);
});
