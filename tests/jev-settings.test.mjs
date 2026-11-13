import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { jevKeyStorage, JEV_KEY_STORAGE, NANOGPT_JEV_KEY_STORAGE } from '../jev-client.js';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function ui() {
    const config = { jevProvider: 'typesafe', responseGuardEnabled: true, enabled: false };
    const keys = new Map([[JEV_KEY_STORAGE, 'typesafe-key']]);
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, { value: '', dataset: {}, addEventListener(event, handler) { this[event] = handler; } });
        return elements.get(id);
    };
    const calls = [], box = {
        document: { getElementById: element }, getSettings: () => config, getContext: () => ({}),
        jevKeyStorage, AbortSignal, fetch() {},
        localStorage: { getItem: key => keys.get(key), setItem: (key, value) => keys.set(key, value), removeItem: key => keys.delete(key) },
        requestJev: async (_state, _questions, options) => { calls.push(options); },
        abortResponseGuards() {}, saveSettings() {}, updateUi() {}, invalidateAnalysis() {}, clearInjectedPrompt() {}, getChatState: () => null, EMPTY_ANALYSIS: {},
    };
    vm.createContext(box);
    vm.runInContext(source.slice(source.indexOf('function readJevKey('), source.indexOf('function abortResponseGuards(')), box);
    vm.runInContext(source.slice(source.indexOf('function bindSetting('), source.indexOf('async function confirmAction(')), box);
    vm.runInContext(source.slice(source.indexOf("    bindSetting('ttotto-jev-provider'"), source.indexOf("    bindSetting('ttotto-metagaming-prompt-enabled'")), box);
    const choose = provider => { element('ttotto-jev-provider').value = provider; element('ttotto-jev-provider').change(); };
    return { config, keys, element, box, calls, choose };
}

test('service picker loads, tests, saves and deletes only its selected service key', async () => {
    const h = ui();
    h.choose('nanogpt');
    assert.equal(h.element('ttotto-jev-key').value, '');
    h.element('ttotto-jev-key').value = 'nano-key';
    await h.element('ttotto-jev-connect').click();
    assert.equal(h.calls[0].provider, 'nanogpt'); assert.equal(h.calls[0].key, 'nano-key');
    assert.equal(h.keys.get(NANOGPT_JEV_KEY_STORAGE), 'nano-key'); assert.equal(h.keys.get(JEV_KEY_STORAGE), 'typesafe-key');
    h.choose('typesafe'); assert.equal(h.element('ttotto-jev-key').value, 'typesafe-key');
    h.choose('nanogpt'); assert.equal(h.element('ttotto-jev-key').value, 'nano-key');
    h.element('ttotto-jev-delete').click();
    assert.equal(h.keys.has(NANOGPT_JEV_KEY_STORAGE), false); assert.equal(h.keys.get(JEV_KEY_STORAGE), 'typesafe-key');
});

test('late connection-test success after switching service cannot overwrite keys or status', async () => {
    const h = ui(); let finish;
    h.box.requestJev = () => new Promise(resolve => { finish = resolve; });
    h.choose('nanogpt'); h.element('ttotto-jev-key').value = 'nano-draft';
    const pending = h.element('ttotto-jev-connect').click();
    h.choose('typesafe'); h.element('ttotto-jev-key-status').textContent = 'typesafe-selected';
    finish(); await pending;
    assert.equal(h.keys.has(NANOGPT_JEV_KEY_STORAGE), false);
    assert.equal(h.keys.get(JEV_KEY_STORAGE), 'typesafe-key');
    assert.equal(h.element('ttotto-jev-key-status').textContent, 'typesafe-selected');
});
