'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');

const preparedRoot = path.resolve(__dirname, '..', 'dist', 'payload');
const root = fs.existsSync(path.join(preparedRoot, 'app', 'app.js'))
  ? preparedRoot
  : path.resolve(__dirname, '..', 'payload_v046');
const port = 18765;
const base = `http://127.0.0.1:${port}`;
const nodeExecutable = process.env.ZIENTSOV_TEST_NODE || process.env.CODEX_PRIMARY_RUNTIME_NODE || process.execPath;
const child = spawn(nodeExecutable, [path.join(root, 'app', 'app.js')], {
  env: {...process.env, ZIENTSOV_PORT: String(port), ZIENTSOV_NO_WINDOW: '1'},
  stdio: ['ignore', 'pipe', 'pipe']
});

let diagnostics = '';
child.stdout.on('data', value => { diagnostics += value; });
child.stderr.on('data', value => { diagnostics += value; });
child.on('error', error => { diagnostics += String(error.stack || error); });

async function waitForServer() {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    try {
      const response = await fetch(`${base}/`);
      if (response.ok) return Date.now() - started;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Застосунок не запустився. ${diagnostics}`);
}

async function post(text, direction='latin') {
  const response = await fetch(`${base}/api/convert`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({text, direction})
  });
  assert.equal(response.status, 200);
  return response.json();
}

(async () => {
  try {
    const startup = await waitForServer();
    assert.ok(startup < 2500, `Повільний запуск локального сервера: ${startup} мс`);

    const home = await fetch(`${base}/`);
    assert.match(home.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    assert.equal(home.headers.get('x-frame-options'), 'DENY');

    const stats = await (await fetch(`${base}/api/stats`)).json();
    assert.equal(stats.version, '0.4.11');
    assert.equal(stats.unique_entries, '322682');

    const correct = await post('Привіт. Мене звати Дмитро');
    assert.equal(correct.ok, true);
    assert.equal(correct.result, 'Pryvit. Mene zvaty Dmytro');

    const roundTrip = await post('Щастя, Україна, Львів.');
    assert.equal(roundTrip.ok, true);
    assert.equal(roundTrip.result, 'Ščastja, Ukrajina, Ľviv.');
    const roundTripBack = await post(roundTrip.result, 'cyrillic');
    assert.equal(roundTripBack.ok, true);
    assert.equal(roundTripBack.result, 'Щастя, Україна, Львів.');

    const future = await post('Для будущих поколінь');
    assert.equal(future.ok, false);
    assert.ok(future.errors.some(error => error.word.toLowerCase() === 'будущих' && error.suggestions.includes('майбутніх')));

    const named = await post('Мене зовут Дмитро');
    assert.equal(named.ok, false);
    assert.ok(named.errors.some(error => error.suggestions.includes('Мене звати')));

    const building = await post('Здание');
    assert.equal(building.ok, false);
    assert.ok(building.errors.some(error => error.reason === 'surzhyk' && error.suggestions.includes('Будівля') && error.suggestions.includes('Будинок') && error.suggestions.includes('Споруда')));

    const capitalization = await post('привіт');
    assert.ok(capitalization.errors.some(error => error.reason === 'capitalization' && error.suggestions.includes('Привіт')));

    const wrongAlphabet = await post('Pryvit');
    assert.equal(wrongAlphabet.ok, false);
    assert.ok(wrongAlphabet.errors.some(error => error.reason === 'wrong_script'));

    const reverse = await post('Pryvit', 'cyrillic');
    assert.equal(reverse.ok, true);
    assert.equal(reverse.result, 'Привіт');

    const searchCyr = await (await fetch(`${base}/api/search?q=${encodeURIComponent('Україна')}`)).json();
    assert.ok(searchCyr.results.some(item => item.cyrillic.toLowerCase() === 'україна'));
    const searchLat = await (await fetch(`${base}/api/search?q=Ukrajina`)).json();
    assert.ok(searchLat.results.some(item => item.latin.toLowerCase() === 'ukrajina'));

    const translatedSearch = await (await fetch(`${base}/api/search?q=${encodeURIComponent('здание')}`)).json();
    assert.equal(translatedSearch.reason, 'translation');
    assert.deepEqual(translatedSearch.suggestions, ['будівля', 'будинок', 'споруда']);
    assert.equal(translatedSearch.options.length, 3);

    const notFound = await fetch(`${base}/api/невідомо`);
    assert.equal(notFound.status, 404);
    console.log(`QA API PASS: 17 перевірок; сервер готовий за ${startup} мс.`);
  } finally {
    child.kill();
  }
})().catch(error => {
  console.error(error.stack || error);
  child.kill();
  process.exitCode = 1;
});
