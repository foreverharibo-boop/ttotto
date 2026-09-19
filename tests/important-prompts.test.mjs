import test from 'node:test';
import assert from 'node:assert/strict';

import {
    IMPORTANT_PROMPTS,
    buildCharacterAiPromptInjection,
    buildImportantPromptInjection,
    buildMetagamingPromptInjection,
    normalizeImportantPromptSettings,
} from '../important-prompts.js';

test('중요 프롬프트는 JSON의 다섯 자연어 본문만 버전별로 보관한다', () => {
    assert.deepEqual(Object.keys(IMPORTANT_PROMPTS.metagaming), ['full', 'mini']);
    assert.deepEqual(Object.keys(IMPORTANT_PROMPTS.characterAi), ['full', 'compact', 'mini']);
    assert.equal(IMPORTANT_PROMPTS.metagaming.full.length, 2638);
    assert.equal(IMPORTANT_PROMPTS.metagaming.mini.length, 2193);
    assert.equal(IMPORTANT_PROMPTS.characterAi.full.length, 5297);
    assert.equal(IMPORTANT_PROMPTS.characterAi.compact.length, 4617);
    assert.equal(IMPORTANT_PROMPTS.characterAi.mini.length, 3301);
    assert.match(IMPORTANT_PROMPTS.metagaming.full, /<ANTI_METAGAMING>/);
    assert.match(IMPORTANT_PROMPTS.characterAi.full, /<CHARACTER_KNOWLEDGE_AND_CONTEXT>/);
});

test('다섯 프롬프트는 모두 여는 태그와 닫는 태그를 정확히 한 쌍 보존한다', () => {
    const families = [
        [IMPORTANT_PROMPTS.metagaming, 'ANTI_METAGAMING'],
        [IMPORTANT_PROMPTS.characterAi, 'CHARACTER_KNOWLEDGE_AND_CONTEXT'],
    ];
    for (const [versions, tag] of families) {
        const opening = `<${tag}>`;
        const closing = `</${tag}>`;
        for (const [version, content] of Object.entries(versions)) {
            assert.equal(content.startsWith(opening), true, `${tag} ${version}: 여는 태그`);
            assert.equal(content.trimEnd().endsWith(closing), true, `${tag} ${version}: 닫는 태그`);
            assert.equal(content.split(opening).length - 1, 1, `${tag} ${version}: 여는 태그 개수`);
            assert.equal(content.split(closing).length - 1, 1, `${tag} ${version}: 닫는 태그 개수`);
            assert.doesNotMatch(content, new RegExp(`^<${tag}>\\n\\n`), `${tag} ${version}: 여는 태그 아래 빈 줄 없음`);
            assert.doesNotMatch(content, new RegExp(`\\n\\n</${tag}>$`), `${tag} ${version}: 닫는 태그 위 빈 줄 없음`);
            assert.match(content, new RegExp(`^<${tag}>\\n[^\\n]`), `${tag} ${version}: 여는 태그 바로 다음 자연어`);
            assert.match(content, new RegExp(`[^\\n]\\n</${tag}>$`), `${tag} ${version}: 마지막 자연어 바로 다음 닫는 태그`);
        }
    }
});

test('체크된 계열에서 선택한 버전 하나만 주입한다', () => {
    assert.equal(buildImportantPromptInjection({}), '');

    const meta = buildImportantPromptInjection({
        metagamingPromptEnabled: true,
        metagamingPromptVersion: 'mini',
    });
    assert.equal(meta, IMPORTANT_PROMPTS.metagaming.mini);
    assert.doesNotMatch(meta, new RegExp(IMPORTANT_PROMPTS.metagaming.full.slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const character = buildImportantPromptInjection({
        characterAiPromptEnabled: true,
        characterAiPromptVersion: 'compact',
    });
    assert.equal(character, IMPORTANT_PROMPTS.characterAi.compact);

    const both = buildImportantPromptInjection({
        metagamingPromptEnabled: true,
        metagamingPromptVersion: 'full',
        characterAiPromptEnabled: true,
        characterAiPromptVersion: 'mini',
    });
    assert.equal(both, `${IMPORTANT_PROMPTS.metagaming.full}\n\n${IMPORTANT_PROMPTS.characterAi.mini}`);
    assert.equal(buildMetagamingPromptInjection({
        metagamingPromptEnabled: true,
        metagamingPromptVersion: 'mini',
    }), IMPORTANT_PROMPTS.metagaming.mini);
    assert.equal(buildCharacterAiPromptInjection({
        characterAiPromptEnabled: true,
        characterAiPromptVersion: 'compact',
    }), IMPORTANT_PROMPTS.characterAi.compact);
});

test('손상되거나 구버전인 선택값은 안전한 기본값으로 보정한다', () => {
    const settings = normalizeImportantPromptSettings({
        metagamingPromptEnabled: 1,
        metagamingPromptVersion: 'unknown',
        characterAiPromptEnabled: 0,
        characterAiPromptVersion: 'unknown',
    });
    assert.equal(settings.metagamingPromptEnabled, true);
    assert.equal(settings.metagamingPromptVersion, 'full');
    assert.equal(settings.characterAiPromptEnabled, false);
    assert.equal(settings.characterAiPromptVersion, 'full');
});
