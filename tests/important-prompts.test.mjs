import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
    IMPORTANT_PROMPTS,
    buildCharacterAiPromptInjection,
    buildImportantPromptInjection,
    buildMetagamingPromptInjection,
    normalizeImportantPromptSettings,
} from '../important-prompts.js';

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

test('WEAVE는 사용자가 제공한 원본 두 개만 정확히 보관한다', () => {
    assert.deepEqual(Object.keys(IMPORTANT_PROMPTS.metagaming), ['full']);
    assert.deepEqual(Object.keys(IMPORTANT_PROMPTS.characterAi), ['full']);
    assert.equal(IMPORTANT_PROMPTS.metagaming.full.length, 2195);
    assert.equal(IMPORTANT_PROMPTS.characterAi.full.length, 2901);
    assert.equal(sha256(IMPORTANT_PROMPTS.metagaming.full), '96c56f35793fbc39055102c5af2fbf4f78c176a9ba6528f052d049c574400841');
    assert.equal(sha256(IMPORTANT_PROMPTS.characterAi.full), '710234e34b2c631482173b657d53488fd2d0b4c15a53372426af901b52a51ec8');
});

test('원본 태그와 태그 안쪽 줄바꿈을 그대로 보존한다', () => {
    const pairs = [
        [IMPORTANT_PROMPTS.metagaming.full, 'ANTI_METAGAMING'],
        [IMPORTANT_PROMPTS.characterAi.full, 'CHARACTER_KNOWLEDGE_AND_CONTEXT'],
    ];
    for (const [content, tag] of pairs) {
        const opening = `<${tag}>`;
        const closing = `</${tag}>`;
        assert.equal(content.startsWith(`${opening}\n\n`), true);
        assert.equal(content.endsWith(`\n\n${closing}`), true);
        assert.equal(content.split(opening).length - 1, 1);
        assert.equal(content.split(closing).length - 1, 1);
    }
});

test('각 체크박스는 버전 선택 없이 해당 원본만 주입한다', () => {
    assert.equal(buildImportantPromptInjection({}), '');
    assert.equal(buildMetagamingPromptInjection({ metagamingPromptEnabled: true }), IMPORTANT_PROMPTS.metagaming.full);
    assert.equal(buildCharacterAiPromptInjection({ characterAiPromptEnabled: true }), IMPORTANT_PROMPTS.characterAi.full);
    assert.equal(buildImportantPromptInjection({
        metagamingPromptEnabled: true,
        characterAiPromptEnabled: true,
    }), `${IMPORTANT_PROMPTS.metagaming.full}\n\n${IMPORTANT_PROMPTS.characterAi.full}`);
});

test('구버전 선택값은 삭제되어 축약본이 다시 사용되지 않는다', () => {
    const settings = normalizeImportantPromptSettings({
        metagamingPromptEnabled: 1,
        metagamingPromptVersion: 'mini',
        characterAiPromptEnabled: 0,
        characterAiPromptVersion: 'compact',
    });
    assert.equal(settings.metagamingPromptEnabled, true);
    assert.equal(settings.characterAiPromptEnabled, false);
    assert.equal('metagamingPromptVersion' in settings, false);
    assert.equal('characterAiPromptVersion' in settings, false);
});
