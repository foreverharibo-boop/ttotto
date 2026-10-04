// Same transport as 100LOG: a per-request custom body through ST's existing
// Chat Completion endpoint. Never edit the active connection profile/settings.
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_KEY_STORAGE = 'ttotto.typesafeKey';
const STRIP = ['messages', 'prompt', 'stream', 'temperature', 'max_tokens',
    'max_completion_tokens', 'presence_penalty', 'frequency_penalty', 'top_p',
    'top_k', 'stop', 'logit_bias', 'seed', 'n', 'logprobs', 'top_logprobs',
    'tools', 'tool_choice', 'response_format', 'reasoning_effort', 'verbosity'];

export function checkAbort(signal) {
    if (signal?.aborted) throw new DOMException('또또 검수를 중단했어요.', 'AbortError');
}

function clientError(status, retryAfter = 0) {
    const label = status === 401 || status === 403 ? 'Jev API 키 인증에 실패했어요.'
        : status === 429 ? 'Jev 요청 한도를 초과했어요.'
            : `Jev 호출에 실패했어요 (${status || '연결 오류'}).`;
    return Object.assign(new Error(label), {
        retryable: [408, 429].includes(status) || status >= 500,
        retryAfter,
    });
}

async function readAnswer(response, questions, signal) {
    checkAbort(signal);
    const retryHeader = response.headers.get('Retry-After');
    const retrySeconds = retryHeader === null ? NaN : Number(retryHeader);
    const retryAfter = Number.isFinite(retrySeconds) ? retrySeconds * 1000
        : Math.max(0, Date.parse(retryHeader) - Date.now()) || 0;
    if (!response.ok) throw clientError(response.status, retryAfter);
    let result;
    try { result = await response.json(); }
    catch { checkAbort(signal); throw new Error('Jev 판정 응답을 읽지 못했어요.'); }
    checkAbort(signal);
    if (result?.error) {
        // ST can wrap an upstream error in HTTP 200. Do not expose raw bodies,
        // which might contain credentials or story text.
        const detail = String(result.error?.message ?? result.error);
        const rawCode = result.error?.status ?? result.error?.code ?? result.status;
        let code = Number(rawCode) || Number(detail.match(/\b(400|401|403|408|413|422|429|5\d\d)\b/)?.[1]) || 0;
        if (/unauthori|invalid.?api.?key|forbidden|unauthenticated/i.test(detail)) code = 401;
        if (/resource.exhausted|rate.limit|quota/i.test(detail)) code = 429;
        throw clientError(code, retryAfter);
    }
    for (const [id, question] of Object.entries(questions)) {
        const answer = result?.answers?.[id];
        if (question.type !== 'choice' || answer?.type !== 'choice'
            || !Object.hasOwn(question.criteria, answer.choice)
            || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1
            || !answer.probabilities || Array.isArray(answer.probabilities)
            || Object.keys(answer.probabilities).length !== Object.keys(question.criteria).length
            || Object.keys(question.criteria).some((option) => {
                const p = answer.probabilities[option];
                return !Number.isFinite(p) || p < 0 || p > 1;
            })
            || Math.abs(Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1) > 0.02
            || answer.probabilities[answer.choice] + 0.000001 < Math.max(...Object.values(answer.probabilities))) {
            throw new Error('Jev 판정이 누락되거나 형식이 잘못되어 답변을 표시하지 않았어요.');
        }
    }
    return result;
}

async function requestOnce(state, questions, { key, signal, fetcher, headers }) {
    checkAbort(signal);
    let response;
    if (headers) {
        try {
            response = await fetcher('/api/backends/chat-completions/generate', {
                method: 'POST', signal, credentials: 'same-origin',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'quiet', chat_completion_source: 'custom', custom_url: `${JEV_URL}?via=`,
                    model: 'jev-latest', messages: [{ role: 'user', content: '.' }], stream: false,
                    custom_include_body: JSON.stringify({ state, questions }),
                    custom_exclude_body: JSON.stringify(STRIP),
                    custom_include_headers: JSON.stringify({ Authorization: `Bearer ${key}` }),
                }),
            });
        } catch { checkAbort(signal); }
        if (response && ![404, 405].includes(response.status)) return readAnswer(response, questions, signal);
    }
    const body = JSON.stringify({ model: 'jev-latest', state, questions });
    try {
        response = await fetcher(JEV_URL, {
            method: 'POST', signal, credentials: 'omit', referrerPolicy: 'no-referrer',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body,
        });
    } catch {
        checkAbort(signal);
        if (!headers) throw clientError(0);
        response = await fetcher(`/proxy/${encodeURIComponent(JEV_URL)}`, {
            method: 'POST', signal, credentials: 'same-origin', body,
            headers: { ...headers, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        });
        if (response.status === 404) throw new Error('ST 중계·직접 연결이 실패했고 내장 프록시도 꺼져 있어요.');
    }
    return readAnswer(response, questions, signal);
}

function delay(ms, signal) {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
        const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
        const timer = setTimeout(finish, ms);
        const cancel = () => {
            clearTimeout(timer); signal.removeEventListener('abort', cancel);
            reject(new DOMException('또또 검수를 중단했어요.', 'AbortError'));
        };
        signal?.addEventListener('abort', cancel, { once: true });
    });
}

export async function requestJev(state, questions, options) {
    if (!String(options.key ?? '').trim()) throw new Error('또또 설정에 Jev API 키를 연결해 주세요.');
    for (let attempt = 0; ; attempt++) {
        checkAbort(options.signal);
        try { return await requestOnce(state, questions, options); }
        catch (error) {
            checkAbort(options.signal);
            if (!error.retryable || attempt >= 2) throw error;
            // Long rate-limit windows stop this attempt, rather than silently
            // hanging or sending before the provider's Retry-After.
            const wait = Math.max(error.retryAfter || 0, 1000 * (attempt + 1));
            if (wait > 10000) throw error;
            await delay(wait, options.signal);
        }
    }
}
