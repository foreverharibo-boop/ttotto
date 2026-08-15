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
