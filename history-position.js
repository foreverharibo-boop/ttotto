// Locate transmitted chat history using exact known text, not the final system
// message or a new assistant prefill. Never mutate saved chat/preset records.
const normalize = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const textOf = message => typeof message?.content === 'string' ? message.content
    : Array.isArray(message?.content) ? message.content.filter(part => typeof part?.text === 'string').map(part => part.text).join('\n')
        : String(message?.mes ?? '');

function knownTexts(message) {
    const extra = message?.extra ?? {};
    return [textOf(message), extra.display_text, extra.ttotto_source_text, extra.original_text,
        extra.original_mes, extra.source_text, extra.translation?.original,
        extra.translator?.original, extra.feather_active?.source]
        .filter(value => typeof value === 'string' && value.trim()).map(normalize);
}

export function findHistoryEnd(messages, chat = [], names = {}, snapshot = []) {
    if (!Array.isArray(messages)) return null;
    const match = (role, texts) => {
        const candidates = new Set(texts);
        const name = role === 'user' ? names.userName : names.charName;
        if (name) for (const text of texts) candidates.add(normalize(`${name}: ${text}`));
        const found = [];
        messages.forEach((message, index) => {
            if (message?.role === role && candidates.has(normalize(textOf(message)))) found.push(index);
        });
        return found;
    };
    for (let i = (Array.isArray(chat) ? chat.length : 0) - 1; i >= 0; i--) {
        const item = chat[i];
        if (!item || item.is_system || item.is_hidden || ['system', 'developer'].includes(item.role)) continue;
        const role = item.is_user || item.role === 'user' ? 'user' : 'assistant';
        const found = match(role, knownTexts(item));
        if (found.length > 1) return null;
        if (found.length === 1) return found[0] + 1;
    }
    for (const item of snapshot) {
        const found = match(item.role, [normalize(item.text)]);
        if (found.length > 1) return null;
        if (found.length === 1) return found[0] + 1;
    }
    return null;
}
