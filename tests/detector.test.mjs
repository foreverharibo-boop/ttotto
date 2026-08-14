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

test('원본 Info_panel 블록 전체를 분석에서 제외한다', () => {
    const text = `Before the panel.\n<Info_panel>\n[Date: 2026.11.23. (Mon) | 10:35 AM]\n[Weather: Partly Cloudy | 2°C]\n[Location: Master Bedroom]\n</Info_panel>\n"Stay here," Peter said.`;
    const parts = splitDialogueAndNarration(text);
    const combined = [...parts.narration, ...parts.dialogue].join(' ');
    assert.doesNotMatch(combined, /Date|Weather|Location|Master Bedroom/);
    assert.match(combined, /Before the panel/);
    assert.match(combined, /Stay here/);
});

test('정규식으로 렌더링된 style 및 중첩 info-card 블록을 분석에서 제외한다', () => {
    const text = `<style>\n.info-card{background:#fff}.body{line-height:1.3}\n</style>\n<div class="info-card extra">\n<div class="info-row"><div class="icon">📅</div><div class="body">2026.11.23. (Mon) | 10:35 AM</div></div>\n<div class="info-row"><div class="icon">📍</div><div class="body">Master Bedroom, Queens</div></div>\n</div>\nHe closed the door.`;
    const parts = splitDialogueAndNarration(text);
    const combined = [...parts.narration, ...parts.dialogue].join(' ');
    assert.doesNotMatch(combined, /info-card|line-height|2026\.11\.23|Master Bedroom|Queens/);
    assert.match(combined, /He closed the door/);
});

test('반복되는 인포블럭만으로 반복 패턴을 만들지 않는다', () => {
    const messages = [1, 2, 3, 4].map((number) => ({
        id: String(number),
        speaker: 'Peter',
        text: `<Info_panel>[Date: 2026.11.${20 + number}. | 10:35 AM]\n[Weather: Cloudy | 2°C]\n[Location: Master Bedroom]</Info_panel>`,
    }));
    assert.deepEqual(detectPatterns(messages, settings, ['Peter']), []);
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
