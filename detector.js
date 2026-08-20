const MAX_MESSAGE_CHARS = 8000;
const MAX_SENTENCE_CHARS = 700;
const MAX_LOCAL_PATTERNS = 24;
const VOID_HTML_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
    'param', 'source', 'track', 'wbr',
]);

const STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from', 'had', 'has', 'have',
    'he', 'her', 'hers', 'him', 'his', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'of', 'on',
    'or', 'our', 'she', 'so', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'they', 'this', 'to',
    'up', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'you', 'your',
    '그', '그가', '그녀', '그녀가', '그것', '그리고', '그러나', '하지만', '나는', '내가', '너는', '네가',
    '다시', '더', '또', '및', '아주', '약간', '이', '저', '그런', '것', '수', '듯', '때', '게', '를', '을',
]);

const SUBJECT_WORDS = new Set([
    'he', 'she', 'they', 'i', 'we', 'you', 'it', 'him', 'her', 'them',
    '그', '그가', '그는', '그녀', '그녀가', '그녀는', '나는', '내가', '너는', '네가', '우리는',
]);

const POSSESSIVE_WORDS = new Set([
    'his', 'her', 'hers', 'their', 'theirs', 'my', 'mine', 'your', 'yours', 'our', 'ours', 'its',
]);

const BODY_ROOTS = [
    'jaw', 'lip', 'mouth', 'eye', 'gaze', 'brow', 'shoulder', 'breath', 'throat', 'hand', 'finger', 'chest',
    '턱', '입술', '입꼬리', '입', '눈', '시선', '눈썹', '어깨', '숨', '호흡', '목', '손', '손가락', '가슴',
];

const TENSION_ROOTS = [
    'tighten', 'clench', 'press', 'twitch', 'narrow', 'flicker', 'harden', 'darken', 'stiffen', 'tense', 'curl',
    '굳', '악물', '다물', '움찔', '좁혀', '흔들', '떨', '경직', '긴장', '비틀', '일그러',
];

const BREATH_ROOTS = [
    'sigh', 'exhale', 'inhale', 'breath', 'breathe', 'huff', '숨', '한숨', '호흡', '내쉬', '들이쉬',
];

const GAZE_ROOTS = [
    'look', 'glance', 'gaze', 'stare', 'watch', 'eye', '시선', '바라', '쳐다', '응시', '흘겨', '눈길',
];

const SPEECH_ROOTS = [
    'say', 'said', 'ask', 'asked', 'mutter', 'whisper', 'reply', 'respond', 'voice', '말', '묻', '대답', '중얼', '속삭', '목소리',
];

const MOTION_ROOTS = [
    'lean', 'step', 'move', 'turn', 'shift', 'reach', 'pull', 'push', 'tilt', 'nod', 'shake',
    '기울', '다가', '움직', '돌', '뻗', '당기', '밀', '끄덕', '젓',
];

const DIALOGUE_FILLERS = new Set([
    'fine', 'whatever', 'seriously', 'right', 'sure', 'okay', 'ok', 'well', 'please',
    '됐어', '그래', '진짜', '정말', '알았어', '뭐', '제발', '그러니까', '아니',
]);

const SENSITIVITY = {
    loose: { narration: 4, dialogue: 5, phraseTokens: 5 },
    normal: { narration: 3, dialogue: 4, phraseTokens: 4 },
    strict: { narration: 2, dialogue: 3, phraseTokens: 4 },
};

function clipMessage(text) {
    const value = String(text ?? '');
    if (value.length <= MAX_MESSAGE_CHARS) return value;
    const half = Math.floor(MAX_MESSAGE_CHARS / 2);
    return `${value.slice(0, half)}\n…\n${value.slice(-half)}`;
}

function hasHtmlClass(tag, className) {
    const match = String(tag).match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const classes = String(match?.[1] ?? match?.[2] ?? match?.[3] ?? '')
        .split(/\s+/)
        .filter(Boolean);
    return classes.some((value) => value.toLocaleLowerCase() === className.toLocaleLowerCase());
}

function stripBalancedHtmlBlocksByClass(text, tagName, className) {
    let output = String(text ?? '');
    const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');

    while (true) {
        tagPattern.lastIndex = 0;
        let opening = null;
        let match;

        while ((match = tagPattern.exec(output)) !== null) {
            const tag = match[0];
            if (!/^<\//.test(tag) && hasHtmlClass(tag, className)) {
                opening = { index: match.index, end: tagPattern.lastIndex };
                break;
            }
        }

        if (!opening) break;

        let depth = 1;
        let closingEnd = output.length;
        tagPattern.lastIndex = opening.end;

        while ((match = tagPattern.exec(output)) !== null) {
            const tag = match[0];
            if (/^<\//.test(tag)) {
                depth -= 1;
            } else if (!/\/\s*>$/.test(tag)) {
                depth += 1;
            }
            if (depth === 0) {
                closingEnd = tagPattern.lastIndex;
                break;
            }
        }

        output = `${output.slice(0, opening.index)} ${output.slice(closingEnd)}`;
    }

    return output;
}

export function stripAllPairedTagBlocks(text) {
    const input = String(text ?? '');
    const tagPattern = /<(\/?)\s*([A-Za-z][A-Za-z0-9_:-]*)(?:\s[^<>]*?)?\s*(\/?)>/g;
    const stack = [];
    const ranges = [];
    let match;

    while ((match = tagPattern.exec(input)) !== null) {
        const closing = match[1] === '/';
        const name = match[2].toLocaleLowerCase();
        const selfClosing = match[3] === '/' || VOID_HTML_TAGS.has(name);
        if (!closing) {
            if (!selfClosing) stack.push({ name, start: match.index });
            continue;
        }

        let openingIndex = -1;
        for (let index = stack.length - 1; index >= 0; index -= 1) {
            if (stack[index].name === name) {
                openingIndex = index;
                break;
            }
        }
        if (openingIndex < 0) continue;
        ranges.push([stack[openingIndex].start, tagPattern.lastIndex]);
        // Any still-open tags above this match were nested inside the removed
        // range, so discard them too. This also handles mildly malformed HTML.
        stack.splice(openingIndex);
    }

    if (!ranges.length) return input;
    ranges.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
    const merged = [];
    for (const range of ranges) {
        const previous = merged.at(-1);
        if (!previous || range[0] > previous[1]) merged.push([...range]);
        else previous[1] = Math.max(previous[1], range[1]);
    }

    let cursor = 0;
    let output = '';
    for (const [start, end] of merged) {
        output += `${input.slice(cursor, start)} `;
        cursor = end;
    }
    return `${output}${input.slice(cursor)}`;
}

function parseExclusionList(value, kind) {
    const source = Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/);
    const pattern = kind === 'tag'
        ? /^[A-Za-z][A-Za-z0-9_-]{0,39}$/
        : /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
    return [...new Set(source
        .map((item) => String(item).trim().replace(kind === 'class' ? /^\./ : /^$/, ''))
        .filter((item) => pattern.test(item))
        .map((item) => item.toLocaleLowerCase()))].slice(0, 30);
}

export function stripNonProse(text, exclusions = {}, { clip = true } = {}) {
    let clean = String(text ?? '')
        // User info panels can exist either before regex rendering or as a rendered HTML card.
        .replace(/<info[_-]?panel\b[^>]*>[\s\S]*?<\/info[_-]?panel\s*>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
    clean = stripBalancedHtmlBlocksByClass(clean, 'div', 'info-card');
    for (const tagName of parseExclusionList(exclusions.excludedTags, 'tag')) {
        const block = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}\\s*>`, 'gi');
        clean = clean.replace(block, ' ');
    }
    for (const className of parseExclusionList(exclusions.excludedClasses, 'class')) {
        for (const tagName of ['div', 'section', 'aside', 'article', 'table', 'span']) {
            clean = stripBalancedHtmlBlocksByClass(clean, tagName, className);
        }
    }
    if (exclusions.excludeAllTaggedBlocks !== false) {
        clean = stripAllPairedTagBlocks(clean);
    }
    // Analysis clips long texts for local n-gram performance; storage callers
    // can opt out to keep the full stripped prose.
    if (clip) clean = clipMessage(clean);

    return clean
        .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
        .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\[(?:img|image|video|audio|file):[^\]]*]/gi, ' ')
        .replace(/\r/g, '')
        .trim();
}

export function splitDialogueAndNarration(text, exclusions = {}) {
    const clean = stripNonProse(text, exclusions);
    const dialogue = [];
    const narration = [];
    const regex = /"([^"\n]{2,})"|“([^”\n]{2,})”|‘([^’\n]{2,})’|「([^」\n]{2,})」|『([^』\n]{2,})』/g;
    let cursor = 0;
    let match;

    while ((match = regex.exec(clean)) !== null) {
        const before = clean.slice(cursor, match.index).trim();
        if (before) narration.push(before);
        const spoken = match.slice(1).find(Boolean)?.trim();
        if (spoken) dialogue.push(spoken);
        cursor = regex.lastIndex;
    }

    const after = clean.slice(cursor).trim();
    if (after) narration.push(after);
    if (!dialogue.length && !narration.length && clean) narration.push(clean);

    return { dialogue, narration };
}

export function splitSentences(text) {
    const chunks = String(text ?? '')
        .split(/\n{1,}/)
        .map((part) => part.trim())
        .filter(Boolean);
    const result = [];

    for (const chunk of chunks) {
        let sentences = [];
        try {
            if (typeof Intl?.Segmenter === 'function') {
                const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
                sentences = [...segmenter.segment(chunk)].map((entry) => entry.segment);
            }
        } catch {
            sentences = [];
        }

        if (!sentences.length) {
            sentences = chunk.split(/(?<=[.!?。！？])\s+(?=[\p{L}\p{N}"“‘「『*])/u);
        }

        for (const sentence of sentences) {
            const clean = sentence
                .replace(/^[*_~\s]+|[*_~\s]+$/g, '')
                .replace(/\s+/g, ' ')
                .trim();
            if (clean.length >= 8) result.push(clean.slice(0, MAX_SENTENCE_CHARS));
        }
    }

    return result;
}

function tokenize(text) {
    return String(text ?? '')
        .normalize('NFKC')
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu) ?? [];
}

function includesRoot(token, roots) {
    return roots.some((root) => token.includes(root));
}

function makeNameSet(names = []) {
    const set = new Set();
    for (const name of names) {
        for (const token of tokenize(name)) {
            if (token.length >= 2) set.add(token);
        }
    }
    return set;
}

function normalizeToken(token, names, structural = false) {
    if (names.has(token)) return '<name>';
    if (SUBJECT_WORDS.has(token)) return structural ? '<subject>' : token;
    if (POSSESSIVE_WORDS.has(token)) return structural ? '<poss>' : token;
    if (!structural) return token;
    if (/^\d+$/.test(token)) return '<number>';
    if (includesRoot(token, BODY_ROOTS)) return '<body>';
    if (includesRoot(token, BREATH_ROOTS)) return '<breath>';
    if (includesRoot(token, TENSION_ROOTS)) return '<reaction>';
    if (includesRoot(token, GAZE_ROOTS)) return '<gaze>';
    if (includesRoot(token, SPEECH_ROOTS)) return '<speech>';
    if (includesRoot(token, MOTION_ROOTS)) return '<motion>';
    if (/^[a-z]+ing$/.test(token)) return '<ing>';
    if (/^[a-z]+ed$/.test(token)) return '<past>';
    if (/^[a-z]+ly$/.test(token)) return '<adverb>';
    if (/(하면서|하며|하고|한 채|듯이)$/.test(token)) return '<linked-action>';
    return token;
}

function contentTokenCount(tokens) {
    return tokens.filter((token) => !STOPWORDS.has(token) && !token.startsWith('<')).length;
}

function punctuationShape(sentence) {
    const marks = String(sentence).match(/[,;:—–!?]+/g) ?? [];
    return marks.slice(0, 4).join('');
}

function structureFingerprint(sentence, names) {
    const tokens = tokenize(sentence)
        .slice(0, 14)
        .map((token) => normalizeToken(token, names, true));
    const categories = tokens.filter((token) => token.startsWith('<')).length;
    if (tokens.length < 5 || categories < 2) return '';
    return `${tokens.slice(0, 10).join(' ')}|${punctuationShape(sentence)}`;
}

function addOccurrence(map, key, data) {
    if (!key) return;
    if (!map.has(key)) {
        map.set(key, {
            ...data,
            count: 0,
            messageIds: new Set(),
            examples: [],
        });
    }
    const entry = map.get(key);
    entry.count += 1;
    entry.messageIds.add(data.messageId);
    if (entry.examples.length < 3 && !entry.examples.includes(data.example)) {
        entry.examples.push(data.example);
    }
}

function stableHash(value) {
    let hash = 0x811c9dc5;
    const text = String(value);
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

function scopeKey(scope, speaker, characterUuid) {
    return `${scope}:${characterUuid || 'unknown'}:${scope === 'dialogue' ? speaker || 'character' : 'narration'}`;
}

function makePattern(kind, scope, speaker, key, entry, label, instruction, extraScore = 0) {
    const messageCount = entry.messageIds.size;
    return {
        id: `local-${stableHash(`${kind}|${scope}|${entry.characterUuid}|${speaker}|${key}`)}`,
        key: `${kind}|${scope}|${entry.characterUuid}|${speaker}|${key}`,
        source: 'local',
        kind,
        scope,
        characterUuid: String(entry.characterUuid ?? ''),
        speaker: scope === 'dialogue' ? speaker : '',
        label,
        example: entry.examples[0] ?? '',
        examples: entry.examples,
        count: messageCount,
        occurrences: entry.count,
        confidence: Math.min(0.98, 0.56 + messageCount * 0.08),
        score: messageCount * 12 + entry.count * 2 + extraScore,
        instruction,
    };
}

function thresholdsFor(settings, scope) {
    const config = SENSITIVITY[settings.sensitivity] ?? SENSITIVITY.normal;
    return scope === 'dialogue' ? config.dialogue : config.narration;
}

function collectEntries(messages, settings, names) {
    const phrases = new Map();
    const openings = new Map();
    const endings = new Map();
    const structures = new Map();
    const habits = new Map();
    const config = SENSITIVITY[settings.sensitivity] ?? SENSITIVITY.normal;

    for (const message of messages) {
        const { dialogue, narration } = splitDialogueAndNarration(message.text, settings);
        const groups = [];
        const characterUuid = String(message.characterUuid ?? '');
        if (!characterUuid) continue;
        if (settings.narrationEnabled) groups.push({ scope: 'narration', parts: narration, speaker: '', characterUuid });
        if (settings.dialogueEnabled) groups.push({ scope: 'dialogue', parts: dialogue, speaker: message.speaker || 'Character', characterUuid });

        for (const group of groups) {
            const seenPhrases = new Set();
            const seenOpenings = new Set();
            const seenEndings = new Set();
            const seenStructures = new Set();
            const seenHabits = new Set();
            const scoped = scopeKey(group.scope, group.speaker, group.characterUuid);

            for (const part of group.parts) {
                for (const sentence of splitSentences(part)) {
                    const rawTokens = tokenize(sentence);
                    const tokens = rawTokens.map((token) => normalizeToken(token, names, false));
                    if (tokens.length < 2) continue;

                    const minSize = Math.min(config.phraseTokens, tokens.length);
                    const maxSize = Math.min(8, tokens.length);
                    for (let size = minSize; size <= maxSize; size += 1) {
                        for (let start = 0; start <= tokens.length - size; start += 1) {
                            const slice = tokens.slice(start, start + size);
                            if (contentTokenCount(slice) < 2) continue;
                            const gram = slice.join(' ');
                            if (gram.length < 14) continue;
                            const key = `${scoped}|${gram}`;
                            if (seenPhrases.has(key)) continue;
                            seenPhrases.add(key);
                            addOccurrence(phrases, key, {
                                scope: group.scope,
                                speaker: group.speaker,
                                characterUuid: group.characterUuid,
                                gram,
                                size,
                                messageId: message.id,
                                example: sentence,
                            });
                        }
                    }

                    const structuralTokens = rawTokens.map((token) => normalizeToken(token, names, true));
                    const openingSize = group.scope === 'dialogue' ? Math.min(3, structuralTokens.length) : Math.min(4, structuralTokens.length);
                    const opening = structuralTokens.slice(0, openingSize).join(' ');
                    if (openingSize >= 2 && contentTokenCount(structuralTokens.slice(0, openingSize)) >= 1) {
                        const key = `${scoped}|${opening}`;
                        if (!seenOpenings.has(key)) {
                            seenOpenings.add(key);
                            addOccurrence(openings, key, {
                                scope: group.scope,
                                speaker: group.speaker,
                                characterUuid: group.characterUuid,
                                opening,
                                messageId: message.id,
                                example: sentence,
                            });
                        }
                    }

                    if (group.scope === 'dialogue' && structuralTokens.length >= 3) {
                        const ending = structuralTokens.slice(-3).join(' ');
                        const endingKey = `${scoped}|${ending}|${sentence.trim().endsWith('?') ? '?' : '.'}`;
                        if (contentTokenCount(structuralTokens.slice(-3)) >= 1 && !seenEndings.has(endingKey)) {
                            seenEndings.add(endingKey);
                            addOccurrence(endings, endingKey, {
                                scope: group.scope,
                                speaker: group.speaker,
                                characterUuid: group.characterUuid,
                                ending,
                                messageId: message.id,
                                example: sentence,
                            });
                        }
                    }

                    const fingerprint = structureFingerprint(sentence, names);
                    if (fingerprint) {
                        const key = `${scoped}|${fingerprint}`;
                        if (!seenStructures.has(key)) {
                            seenStructures.add(key);
                            addOccurrence(structures, key, {
                                scope: group.scope,
                                speaker: group.speaker,
                                characterUuid: group.characterUuid,
                                fingerprint,
                                messageId: message.id,
                                example: sentence,
                            });
                        }
                    }

                    const lower = sentence.toLocaleLowerCase();
                    const habitsFound = [];
                    if (BODY_ROOTS.some((root) => lower.includes(root)) && TENSION_ROOTS.some((root) => lower.includes(root))) {
                        habitsFound.push(['body-tension', '신체 반응으로 긴장 표현']);
                    }
                    if (BREATH_ROOTS.some((root) => lower.includes(root))) {
                        habitsFound.push(['breath-reaction', group.scope === 'dialogue' ? '대사 주변의 한숨·호흡 반응' : '한숨·호흡으로 반응 마무리']);
                    }
                    if (GAZE_ROOTS.some((root) => lower.includes(root)) && group.scope === 'narration') {
                        habitsFound.push(['gaze-reaction', '시선 변화로 감정 반복 표현']);
                    }
                    if (group.scope === 'dialogue') {
                        const content = rawTokens.filter((token) => !STOPWORDS.has(token));
                        if (content.length <= 6 && content.some((token) => DIALOGUE_FILLERS.has(token))) {
                            habitsFound.push(['dialogue-filler', '짧은 반응 대사 반복']);
                        }
                        if (sentence.trim().endsWith('?') && /^(why|what|how|do|does|did|are|is|can|could|would|왜|뭐|어떻게|설마|정말)/i.test(sentence.trim())) {
                            habitsFound.push(['dialogue-question', '비슷한 질문형 대사 반복']);
                        }
                    }

                    for (const [habitKey, habitLabel] of habitsFound) {
                        const key = `${scoped}|${habitKey}`;
                        if (seenHabits.has(key)) continue;
                        seenHabits.add(key);
                        addOccurrence(habits, key, {
                            scope: group.scope,
                            speaker: group.speaker,
                            characterUuid: group.characterUuid,
                            habitKey,
                            habitLabel,
                            messageId: message.id,
                            example: sentence,
                        });
                    }
                }
            }
        }
    }

    return { phrases, openings, endings, structures, habits };
}

function phrasePatterns(entries, settings) {
    const candidates = [];
    for (const [key, entry] of entries) {
        if (entry.messageIds.size < thresholdsFor(settings, entry.scope)) continue;
        const scopeLabel = entry.scope === 'dialogue' ? `${entry.speaker}의 대사` : '서술';
        const quoted = entry.gram.replaceAll('<name>', '인물 이름');
        const instruction = entry.scope === 'dialogue'
            ? `In ${entry.speaker}'s dialogue, do not reuse the phrase pattern "${quoted}" or a lightly paraphrased equivalent.`
            : `Do not reuse the narration phrase pattern "${quoted}" or a lightly paraphrased equivalent.`;
        candidates.push(makePattern('phrase', entry.scope, entry.speaker, key, entry, `${scopeLabel}의 반복 구절`, instruction, entry.size));
    }

    candidates.sort((a, b) => (b.score + b.key.length / 20) - (a.score + a.key.length / 20));
    const selected = [];
    for (const candidate of candidates) {
        const duplicate = selected.some((chosen) => {
            if (chosen.characterUuid !== candidate.characterUuid
                || chosen.scope !== candidate.scope
                || chosen.speaker !== candidate.speaker) return false;
            const a = chosen.key.split('|').at(-1);
            const b = candidate.key.split('|').at(-1);
            return a.includes(b) || b.includes(a);
        });
        if (!duplicate) selected.push(candidate);
        if (selected.length >= 8) break;
    }
    return selected;
}

function openingPatterns(entries, settings) {
    const patterns = [];
    for (const [key, entry] of entries) {
        if (entry.messageIds.size < thresholdsFor(settings, entry.scope)) continue;
        const shown = entry.opening.replaceAll('<name>', '이름').replaceAll('<subject>', '대명사');
        const label = entry.scope === 'dialogue' ? `${entry.speaker} 대사의 같은 시작 방식` : '같은 방식으로 문장 시작';
        const instruction = entry.scope === 'dialogue'
            ? `Vary how ${entry.speaker}'s dialogue begins; avoid repeatedly opening lines with the pattern "${shown}".`
            : `Vary narration sentence openings; avoid repeatedly beginning with the pattern "${shown}".`;
        patterns.push(makePattern('opening', entry.scope, entry.speaker, key, entry, label, instruction, 2));
    }
    return patterns.sort((a, b) => b.score - a.score).slice(0, 4);
}

function endingPatterns(entries, settings) {
    const patterns = [];
    for (const [key, entry] of entries) {
        if (entry.messageIds.size < thresholdsFor(settings, 'dialogue')) continue;
        const shown = entry.ending.replaceAll('<name>', '이름').replaceAll('<subject>', '대명사');
        const instruction = `Vary the endings of ${entry.speaker}'s spoken lines; avoid repeatedly closing with the pattern "${shown}".`;
        patterns.push(makePattern('ending', 'dialogue', entry.speaker, key, entry, `${entry.speaker} 대사의 같은 말끝`, instruction, 3));
    }
    return patterns.sort((a, b) => b.score - a.score).slice(0, 3);
}

function structurePatterns(entries, settings) {
    const patterns = [];
    for (const [key, entry] of entries) {
        if (entry.messageIds.size < thresholdsFor(settings, entry.scope)) continue;
        const fingerprint = entry.fingerprint.split('|')[0];
        const scopeLabel = entry.scope === 'dialogue' ? `${entry.speaker}의 대사` : '서술';
        const instruction = entry.scope === 'dialogue'
            ? `Vary ${entry.speaker}'s dialogue syntax; do not repeat the recent sentence skeleton represented by "${fingerprint}".`
            : `Vary narration syntax; do not repeat the recent sentence skeleton represented by "${fingerprint}".`;
        patterns.push(makePattern('structure', entry.scope, entry.speaker, key, entry, `${scopeLabel} 문장 구조 반복`, instruction, 5));
    }
    return patterns.sort((a, b) => b.score - a.score).slice(0, 5);
}

function habitPatterns(entries, settings) {
    const patterns = [];
    for (const [key, entry] of entries) {
        if (entry.messageIds.size < thresholdsFor(settings, entry.scope)) continue;
        const speakerText = entry.scope === 'dialogue' ? ` in ${entry.speaker}'s dialogue` : '';
        const instructions = {
            'body-tension': `Do not default to jaw, lip, mouth, or other small body-tension reactions${speakerText}; choose a genuinely different response or omit the filler beat.`,
            'breath-reaction': `Avoid repeatedly using sighs, exhales, inhales, or breath changes${speakerText} as the reaction beat.`,
            'gaze-reaction': 'Avoid repeatedly using gaze or eye movement as the default emotional reaction.',
            'dialogue-filler': `Avoid repeating short filler reactions in ${entry.speaker}'s dialogue; preserve the character's voice while making the actual response more specific.`,
            'dialogue-question': `Avoid repeatedly framing ${entry.speaker}'s dialogue as the same rhetorical or confirmation question.`,
        };
        patterns.push(makePattern('habit', entry.scope, entry.speaker, key, entry, entry.habitLabel, instructions[entry.habitKey], 8));
    }
    return patterns.sort((a, b) => b.score - a.score).slice(0, 6);
}

function deduplicatePatterns(patterns) {
    const selected = [];
    for (const pattern of patterns.sort((a, b) => b.score - a.score)) {
        const duplicate = selected.some((chosen) => {
            if (chosen.characterUuid !== pattern.characterUuid
                || chosen.scope !== pattern.scope
                || chosen.speaker !== pattern.speaker) return false;
            if (chosen.kind === pattern.kind && chosen.label === pattern.label) return true;
            const examplesA = new Set(tokenize(chosen.example));
            const examplesB = new Set(tokenize(pattern.example));
            if (!examplesA.size || !examplesB.size) return false;
            const overlap = [...examplesA].filter((token) => examplesB.has(token)).length;
            return overlap / Math.min(examplesA.size, examplesB.size) >= 0.82;
        });
        if (!duplicate) selected.push(pattern);
        if (selected.length >= MAX_LOCAL_PATTERNS) break;
    }
    return selected;
}

export function detectPatterns(messages, settings, contextNames = []) {
    const names = makeNameSet(contextNames.concat(messages.map((message) => message.speaker).filter(Boolean)));
    const entries = collectEntries(messages, settings, names);
    return deduplicatePatterns([
        ...habitPatterns(entries.habits, settings),
        ...structurePatterns(entries.structures, settings),
        ...phrasePatterns(entries.phrases, settings),
        ...openingPatterns(entries.openings, settings),
        ...endingPatterns(entries.endings, settings),
    ]);
}

export function normalizeSmartPattern(raw, index = 0) {
    if (!raw || typeof raw !== 'object') return null;
    const scope = raw.scope === 'dialogue' ? 'dialogue' : 'narration';
    const cleanSmartText = (value, limit) => String(value ?? '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\b(?:system|assistant|user)\s*:/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, limit);
    const label = cleanSmartText(raw.label, 100);
    const instruction = cleanSmartText(raw.instruction ?? raw.abstract_pattern, 500);
    if (/\b(?:ignore|override|disregard)\b.{0,40}\b(?:instruction|prompt|rule)s?\b/i.test(instruction)
        || /\b(?:reveal|print|repeat)\b.{0,40}\b(?:system prompt|hidden instruction)s?\b/i.test(instruction)) return null;
    const examples = Array.isArray(raw.examples)
        ? raw.examples.map((value) => cleanSmartText(value, 220)).filter(Boolean).slice(0, 3)
        : [];
    if (!label || !instruction) return null;
    const speaker = scope === 'dialogue' ? String(raw.speaker ?? 'Character').trim().slice(0, 80) : '';
    const characterUuid = String(raw.characterUuid ?? raw.character_uuid ?? '').trim().slice(0, 100);
    if (!characterUuid) return null;
    const count = Math.max(2, Math.min(99, Number(raw.count) || examples.length || 2));
    const confidence = Math.max(0, Math.min(1, Number(raw.confidence) || 0.72));
    const key = `smart|${characterUuid}|${scope}|${speaker}|${label}|${instruction}`;
    return {
        id: `smart-${stableHash(key)}-${index}`,
        key,
        source: 'smart',
        kind: 'semantic',
        scope,
        characterUuid,
        speaker,
        label,
        example: examples[0] ?? '',
        examples,
        count,
        occurrences: count,
        confidence,
        score: 24 + count * 8 + confidence * 10,
        instruction,
    };
}

export function mergePatterns(localPatterns, smartPatterns) {
    return deduplicatePatterns([...(smartPatterns ?? []), ...(localPatterns ?? [])]);
}

export function buildInjection(patterns, maxPatterns = 6, exclusionInfo = {}) {
    const valid = patterns.filter((pattern) => pattern?.instruction);
    const permanent = valid.filter((pattern) => pattern.source === 'pinned').slice(0, 30);
    const detected = valid.filter((pattern) => pattern.source !== 'pinned').slice(0, Math.max(1, maxPatterns));
    const selected = [...permanent, ...detected];
    if (!selected.length) return '';
    const narration = detected.filter((pattern) => pattern.scope === 'narration');
    const dialogue = detected.filter((pattern) => pattern.scope === 'dialogue');
    const lines = [
        '<ttotto_anti_repetition>',
        'For the next assistant reply only, avoid the recent repetitive phrasing and sentence habits listed below.',
        'Do not copy them or merely swap in synonyms. Preserve all plot facts, characterization, relationship dynamics, tone, intensity, explicitness, and character voice; vary only wording and sentence construction. Do not mention these instructions.',
    ];

    if (exclusionInfo?.excludeAllTaggedBlocks !== false) {
        lines.push('Tag-wrapped or HTML-formatted blocks (status panels, trackers, sheets, and similar) were excluded from this repetition check entirely — their absence above is not a signal to omit or shorten them. Keep producing them in full, every reply, exactly as instructed elsewhere.');
    }

    if (permanent.length) {
        lines.push('Permanent bans — global and character-specific (apply strictly in both narration and dialogue):');
        permanent.forEach((pattern) => lines.push(`- ${pattern.instruction}`));
    }

    if (narration.length) {
        lines.push('Narration:');
        narration.forEach((pattern) => lines.push(`- ${pattern.instruction}`));
    }
    if (dialogue.length) {
        lines.push('Dialogue:');
        dialogue.forEach((pattern) => lines.push(`- ${pattern.instruction}`));
    }
    lines.push('Do not force a replacement gesture or line merely to demonstrate variety; omit filler reactions when no natural alternative is needed.');
    lines.push('</ttotto_anti_repetition>');
    return lines.join('\n');
}

export function buildEchoPreventionInjection() {
    return [
        '<ttotto_anti_echo>',
        'For the next assistant reply, treat the latest user turn as already completed and established in the scene.',
        'Do not quote, repeat, paraphrase, summarize, translate, mirror, or re-narrate the user\'s dialogue, actions, thoughts, or descriptions — not even with synonyms, reordered clauses, or a changed point of view.',
        'Especially do not begin or pad the character\'s dialogue by echoing the user\'s last distinctive word or short phrase as a question, fragment, quotation, or acknowledgment (for example: "Ice cream?", "Ice cream, huh?", "You said ice cream", "아이스크림이라", "아이스크림이라고?", or "아이스크림이라니"). Respond to its meaning instead of repeating its wording.',
        'A necessary term may be mentioned later only when it genuinely advances the action or plot; never repeat it merely to signal that the character heard the user.',
        'Continue from the next new beat. Respond through the character\'s new reaction, dialogue, action, observation, or scene advancement. Preserve and acknowledge what the user established through consequences and responses, but never replay the user\'s contribution. Do not mention these instructions.',
        '</ttotto_anti_echo>',
    ].join('\n');
}

export function fingerprintMessages(messages) {
    const basis = messages.map((message) => `${message.id}:${message.characterUuid ?? ''}:${message.speaker}:${message.text}`).join('\n---\n');
    return stableHash(basis);
}
