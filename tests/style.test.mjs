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
});
