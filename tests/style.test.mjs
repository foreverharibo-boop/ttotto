import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('또또 체크박스는 실리 강조 색상과 흰 체크를 사용하고 다른 확장에는 번지지 않는다', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(css, /#ttotto-settings input\[type="checkbox"\]:checked/);
    assert.match(css, /background-color:\s*var\(--SmartThemeQuoteColor,\s*#666\)\s*!important/);
    assert.match(css, /stroke='%23fff'/);
    assert.match(css, /background-color:\s*#fff\s*!important/);
    assert.doesNotMatch(css, /(?:^|\n)\s*input\[type="checkbox"\](?![^\n]*#ttotto-settings)/);
});

test('주입문 보기 버튼은 한 줄이고 실제 주입문은 제목 바로 아래에 배치된다', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    const html = await readFile(new URL('../settings.html', import.meta.url), 'utf8');
    assert.match(css, /#ttotto-settings #ttotto-toggle-preview[\s\S]*?white-space:\s*nowrap/);
    assert.match(css, /#ttotto-settings #ttotto-toggle-preview[\s\S]*?font-size:\s*0\.78em/);
    const headerEnd = html.indexOf('</div>', html.indexOf('class="ttotto-section-head"'));
    const previewIndex = html.indexOf('id="ttotto-prompt-preview"');
    const warningIndex = html.indexOf('id="ttotto-ban-warning"');
    assert.ok(headerEnd >= 0 && previewIndex > headerEnd && previewIndex < warningIndex);
    assert.match(html, /id="ttotto-prompt-size"[^>]*>0자 · 0토큰</);
});

test('위반 기록과 긴 금지어 행은 모바일에서도 넘치지 않는다', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    const html = await readFile(new URL('../settings.html', import.meta.url), 'utf8');
    assert.match(html, /id="ttotto-clear-offenses"/);
    assert.match(html, /불꽃은 실제 위반 기록이에요/);
    assert.match(css, /#ttotto-settings \.ttotto-ban-item \{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    assert.match(css, /#ttotto-settings \.ttotto-ban-name \{[\s\S]*?overflow-wrap:\s*anywhere/);
    assert.match(css, /#ttotto-settings \.ttotto-ban-meta-row \{[\s\S]*?display:\s*flex[\s\S]*?justify-content:\s*space-between/);
    assert.match(css, /#ttotto-settings \.ttotto-ban-actions \{[\s\S]*?flex-wrap:\s*nowrap/);
});

test('선택한 탭 버튼 자체에만 활성 테두리가 생긴다', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    const js = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(css, /#ttotto-settings \.ttotto-tab\.is-active \{[\s\S]*?border-color:\s*rgba\(150,\s*150,\s*150,\s*0\.48\)/);
    assert.match(css, /#ttotto-settings \.ttotto-tab\.is-active \{[\s\S]*?background:\s*transparent\s*!important/);
    assert.match(css, /#ttotto-settings \.ttotto-tab:not\(\.is-active\) \{[\s\S]*?box-shadow:\s*none|#ttotto-settings \.ttotto-tab \{[\s\S]*?box-shadow:\s*none/);
    assert.match(js, /button\.classList\.toggle\('is-active', active\)/);
});

test('금지 추가 UI와 캐릭터별·전역 삭제 버튼을 명확히 구분한다', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    const js = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(css, /#ttotto-settings \.ttotto-ban-compose \{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(120px,\s*1fr\)\)/);
    assert.match(css, /#ttotto-settings \.ttotto-ban-compose-three \{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(120px,\s*1fr\)\)/);
    assert.match(await readFile(new URL('../settings.html', import.meta.url), 'utf8'), /class="ttotto-ban-compose ttotto-ban-compose-three"/);
    assert.match(css, /#ttotto-settings \.ttotto-pattern-side \{[\s\S]*?flex-direction:\s*column[\s\S]*?align-items:\s*flex-end/);
    assert.match(css, /#ttotto-settings \.ttotto-pattern-unpin \{[\s\S]*?min-height:\s*1\.7em[\s\S]*?font-size:\s*0\.82em/);
    assert.match(css, /#ttotto-settings \.ttotto-ban-compose \.text_pole,[\s\S]*?box-sizing:\s*border-box\s*!important[\s\S]*?width:\s*100%\s*!important/);
    assert.match(css, /#ttotto-settings \.ttotto-ban-compose > \.text_pole,[\s\S]*?height:\s*32px\s*!important/);
    assert.match(css, /#ttotto-settings \.ttotto-pattern-detail-row \{[\s\S]*?display:\s*flex[\s\S]*?align-items:\s*baseline/);
    assert.match(js, /pattern\.kind === 'permanent-term' \? '금지어' : '구조'/);
    assert.match(js, /side\.append\(unpin\)/);
    assert.match(js, /detailRow\.append\(example, meta\)/);
    assert.match(js, /unpin\.textContent = pattern\.characterUuid \? '영구 금지 해제' : '전역 금지 삭제'/);
    assert.match(js, /pattern\.kind === 'permanent-term'[\s\S]*?removeGlobalBan\(pattern\.example\)[\s\S]*?removeGlobalStructureBan\(pattern\.instruction\)/);
});

test('드래그 보조 AI 설명은 선택칸 아래 전체 너비의 한 줄이다', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    const html = await readFile(new URL('../settings.html', import.meta.url), 'utf8');
    assert.match(css, /#ttotto-settings \.ttotto-field > small \{[\s\S]*?grid-column:\s*1\s*\/\s*-1[\s\S]*?white-space:\s*nowrap/);
    assert.match(html, /구조 금지 AI 분석을 켰을 때만 선택한 연결로 API를 호출해요\./);
});

test('에코 방지 강화 모드는 기본 에코 설정 바로 아래에 제공된다', async () => {
    const html = await readFile(new URL('../settings.html', import.meta.url), 'utf8');
    const normalIndex = html.indexOf('id="ttotto-echo-prevention-enabled"');
    const strongIndex = html.indexOf('id="ttotto-echo-prevention-strong"');
    const profileIndex = html.indexOf('id="ttotto-drag-ai-profile"');
    assert.ok(normalIndex >= 0 && strongIndex > normalIndex && profileIndex > strongIndex);
    assert.match(html, /에코 방지 강화 모드/);
    assert.match(html, /최대 8개/);
});

test('드래그 표현·구조 메뉴는 설정에서 켜고 끌 수 있다', async () => {
    const html = await readFile(new URL('../settings.html', import.meta.url), 'utf8');
    const js = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const toggleIndex = html.indexOf('id="ttotto-drag-ban-menu-enabled"');
    const profileIndex = html.indexOf('id="ttotto-drag-ai-profile"');
    assert.ok(toggleIndex >= 0 && profileIndex > toggleIndex);
    assert.match(html, /드래그 금지 메뉴 표시/);
    assert.match(html, /끄면 드래그 선택 감시도 함께 중지/);
    assert.match(js, /dragBanMenuEnabled:\s*true/);
    assert.match(js, /bindSetting\('ttotto-drag-ban-menu-enabled',\s*'dragBanMenuEnabled',\s*Boolean\)/);
    assert.match(js, /if \(key === 'dragBanMenuEnabled'\) syncDragBanHandlers\(settings\)/);
    assert.match(js, /function syncDragBanHandlers\(settings = getSettings\(\)\)[\s\S]*?settings\.dragBanMenuEnabled[\s\S]*?attachDragBanHandlers\(\)[\s\S]*?detachDragBanHandlers\(\)/);
    assert.match(js, /function attachDragBanHandlers\(\)[\s\S]*?!getSettings\(\)\.dragBanMenuEnabled/);
});
