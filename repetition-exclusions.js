// Literal formatting exclusions for automatic repetition analysis only.
// Never pass this filtered text to permanent-ban or echo checks.
export const REPETITION_FORMATS = Object.freeze([
    { id: 'italic', label: '기울임 · *내용*', description: 'single-asterisk italics (*...*)' },
    { id: 'bold', label: '굵게 · **내용**', description: 'double-asterisk bold (**...**)' },
    { id: 'boldItalic', label: '굵은 기울임 · ***내용***', description: 'triple-asterisk bold italics (***...***)' },
    { id: 'underline', label: '밑줄 · __내용__', description: 'double-underscore text (__...__)' },
    { id: 'strike', label: '취소선 · ~~내용~~', description: 'strikethrough (~~...~~)' },
    { id: 'inlineCode', label: '인라인 코드 · `내용`', description: 'inline backtick code' },
    { id: 'codeBlock', label: '코드블록 · ```…```', description: 'fenced code blocks' },
    { id: 'quote', label: '인용 줄 · > 내용', description: 'lines prefixed with > and a space' },
    { id: 'heading', label: '제목 줄 · # 내용', description: 'heading lines prefixed with # through ###### and a space' },
    { id: 'link', label: '링크 · [내용](주소)', description: 'Markdown links' },
    { id: 'image', label: '이미지 · ![설명](주소)', description: 'Markdown images' },
]);
const FORMAT_IDS = new Set(REPETITION_FORMATS.map(x => x.id));
export const MAX_CUSTOM_EXCLUSIONS = 30;
export const MAX_DELIMITER_LENGTH = 80;

export function normalizeRepetitionExclusions(value) {
    // Code fences were already excluded before this setting existed.
    const formats = Array.isArray(value?.formats) ? value.formats : ['codeBlock'];
    const custom = [];
    for (const item of Array.isArray(value?.custom) ? value.custom : []) {
        if (typeof item?.start !== 'string' || typeof item?.end !== 'string'
            || !item.start.trim() || !item.end.trim()
            || item.start.length > MAX_DELIMITER_LENGTH || item.end.length > MAX_DELIMITER_LENGTH
            || /[\r\n]/.test(item.start + item.end)) continue;
        if (custom.some(x => x.start === item.start && x.end === item.end)) continue;
        custom.push({ start: item.start, end: item.end, enabled: item.enabled !== false });
        if (custom.length >= MAX_CUSTOM_EXCLUSIONS) break;
    }
    return { formats: [...new Set(formats.filter(id => FORMAT_IDS.has(id)))].sort(), custom };
}

export function repetitionExclusionKey(value) {
    return JSON.stringify(normalizeRepetitionExclusions(value));
}

function escaped(text, index) {
    let count = 0;
    while (index > 0 && text[--index] === '\\') count++;
    return count % 2 === 1;
}

function inside(ranges, index) {
    return ranges.some(x => index >= x.start && index < x.end);
}

// Recognize code before emphasis, so literal * characters in code cannot
// accidentally open an italic region outside it. Incomplete pairs stay visible.
export function codeRanges(text) {
    const ranges = [];
    let opening = null;
    for (const match of text.matchAll(/^ {0,3}(`{3,}|~{3,})([^\n\r]*)(?:\r?\n|$)/gm)) {
        const marker = match[1];
        if (opening) {
            if (marker[0] === opening.marker[0] && marker.length >= opening.marker.length && !match[2].trim()) {
                ranges.push({ start: opening.start, end: match.index + match[0].length, kind: 'codeBlock' });
                opening = null;
            }
        } else if (marker[0] !== '`' || !match[2].includes('`')) opening = { marker, start: match.index };
    }
    const protectedCode = [...ranges];
    if (opening) protectedCode.push({ start: opening.start, end: text.length });
    const ticks = [...text.matchAll(/`+/g)].filter(m => !escaped(text, m.index) && !inside(protectedCode, m.index));
    for (let i = 0; i < ticks.length; i++) {
        const open = ticks[i];
        const j = ticks.findIndex((close, k) => k > i && close[0].length === open[0].length
            && !protectedCode.some(x => x.start > open.index && x.start < close.index));
        if (j < 0) continue;
        ranges.push({ start: open.index, end: ticks[j].index + ticks[j][0].length, kind: open[0].length >= 3 ? 'codeBlock' : 'inlineCode' });
        i = j;
    }
    return ranges.sort((a, b) => a.start - b.start);
}

function pairedRanges(text, start, end, protectedCode, markdown = false) {
    const ranges = [];
    let cursor = 0, opening = -1, depth = 0;
    const isToken = (index, token) => text.startsWith(token, index) && !escaped(text, index)
        && !inside(protectedCode, index)
        && (!/^([*`_~])\1*$/.test(token)
            || (text[index - 1] !== token[0] && text[index + token.length] !== token[0]));
    while (cursor < text.length) {
        if (opening >= 0 && markdown && text[cursor] === '\n' && /^\n[ \t]*\n/.test(text.slice(cursor))) {
            opening = -1; depth = 0;
        }
        if (opening >= 0 && isToken(cursor, end)
            && (!markdown || /\S/.test(text[cursor - 1] ?? ''))) {
            depth--;
            if (!depth) { ranges.push({ start: opening, end: cursor + end.length }); opening = -1; }
            cursor += end.length;
        } else if (isToken(cursor, start) && (!markdown || /\S/.test(text[cursor + start.length] ?? ''))) {
            if (opening < 0) { opening = cursor; depth = 1; }
            else if (start !== end) depth++;
            cursor += start.length;
        } else cursor++;
    }
    return ranges;
}

function balancedEnd(text, start, open, close) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (escaped(text, i)) continue;
        if (text[i] === open) depth++;
        if (text[i] === close && --depth === 0) return i + 1;
    }
    return -1;
}

export function repetitionExcludedRanges(text, value) {
    text = String(text ?? '');
    const config = normalizeRepetitionExclusions(value);
    const selected = new Set(config.formats);
    const code = codeRanges(text);
    const ranges = code.filter(x => selected.has(x.kind));
    for (const [id, token] of [['italic', '*'], ['bold', '**'], ['boldItalic', '***'], ['underline', '__'], ['strike', '~~']]) {
        if (selected.has(id)) ranges.push(...pairedRanges(text, token, token, code, true));
    }
    if (selected.has('quote') || selected.has('heading')) {
        for (const match of text.matchAll(/^ {0,3}(?:>+[ \t]+[^\r\n]*|#{1,6}[ \t]+[^\r\n]*)/gm)) {
            if (!inside(code, match.index) && selected.has(match[0].trimStart()[0] === '>' ? 'quote' : 'heading')) {
                ranges.push({ start: match.index, end: match.index + match[0].length });
            }
        }
    }
    if (selected.has('link') || selected.has('image')) {
        for (let i = 0; i < text.length; i++) {
            if (text[i] !== '[' || escaped(text, i) || inside(code, i)) continue;
            const isImage = text[i - 1] === '!' && !escaped(text, i - 1);
            const labelEnd = balancedEnd(text, i, '[', ']');
            if (labelEnd < 0 || text[labelEnd] !== '(') continue;
            const end = balancedEnd(text, labelEnd, '(', ')');
            if (end < 0) continue;
            if (selected.has(isImage ? 'image' : 'link')) ranges.push({ start: isImage ? i - 1 : i, end });
            i = end - 1;
        }
    }
    for (const item of config.custom.filter(x => x.enabled)) {
        ranges.push(...pairedRanges(text, item.start, item.end, []));
    }
    const merged = [];
    for (const range of ranges.sort((a, b) => a.start - b.start || b.end - a.end)) {
        const previous = merged.at(-1);
        if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
        else merged.push({ start: range.start, end: range.end });
    }
    return merged;
}

export function excludeRepetitionRegions(text, value) {
    text = String(text ?? '');
    // Keep offsets for review evidence; line breaks prevent inventing a phrase
    // by joining words that originally had an excluded passage between them.
    for (const { start, end } of repetitionExcludedRanges(text, value).reverse()) {
        const blank = text.slice(start, end).replace(/[^\r\n]/g, ' ');
        text = text.slice(0, start) + '\n' + blank.slice(1, -1) + (blank.length > 1 ? '\n' : '') + text.slice(end);
    }
    return text;
}

export function repetitionScopeInstruction(value) {
    const config = normalizeRepetitionExclusions(value);
    const names = REPETITION_FORMATS.filter(x => config.formats.includes(x.id)).map(x => x.description);
    names.push(...config.custom.filter(x => x.enabled).map(x => `text between literal delimiters ${JSON.stringify(x.start)} and ${JSON.stringify(x.end)}`));
    return names.length ? `Automatic repetition restrictions apply only OUTSIDE these regions: ${names.join('; ')}. Repetition inside those regions is allowed. This exception NEVER applies to permanent banned expressions, permanent structure bans, or anti-echo rules; those remain in force inside the regions too. Do not move otherwise prohibited content into an excluded region.` : '';
}
