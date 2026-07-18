'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const {spawn} = require('child_process');

const preparedRoot = path.resolve(__dirname, '..', 'dist', 'payload');
const root = fs.existsSync(path.join(preparedRoot, 'app', 'app.js'))
  ? preparedRoot
  : path.resolve(__dirname, '..', 'payload_v046');
const port = 18765;
const base = `http://127.0.0.1:${port}`;
const updatePort = 18766;
const updateBase = `http://127.0.0.1:${updatePort}`;
const updateVersion = '0.4.13';
const installerName = `ZIENTSOV_LATYNKA_Setup_v${updateVersion}.exe`;
const installerBytes = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4094, 0x5a)]);
const installerHash = crypto.createHash('sha256').update(installerBytes).digest('hex');
const updateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zientsov-update-qa-'));
const updateManifest = {
  schema: 1,
  product: 'ZIENTSOV LATYNKA',
  channel: 'stable',
  version: updateVersion,
  published_at: '2026-07-18T12:00:00Z',
  mandatory: false,
  notes: ['Тестове оновлення словникових правил.'],
  installer: {name: installerName, sha256: installerHash, size: installerBytes.length}
};
const updateServer = http.createServer((request, response) => {
  const sendJson = value => {const body=Buffer.from(JSON.stringify(value));response.writeHead(200,{'content-type':'application/json','content-length':body.length});response.end(body);};
  if(request.url==='/releases/latest')return sendJson({tag_name:`v${updateVersion}`,draft:false,prerelease:false,published_at:updateManifest.published_at,assets:[
    {name:`ZIENTSOV_LATYNKA_Update_v${updateVersion}.json`,size:JSON.stringify(updateManifest).length,browser_download_url:`${updateBase}/release/manifest`},
    {name:installerName,size:installerBytes.length,browser_download_url:`${updateBase}/release/installer`}
  ]});
  if(request.url==='/release/manifest')return sendJson(updateManifest);
  if(request.url==='/release/installer'){response.writeHead(200,{'content-type':'application/octet-stream','content-length':installerBytes.length});return response.end(installerBytes);}
  response.writeHead(404);response.end();
});
updateServer.listen(updatePort,'127.0.0.1');
const nodeExecutable = process.env.ZIENTSOV_TEST_NODE || process.env.CODEX_PRIMARY_RUNTIME_NODE || process.execPath;
const child = spawn(nodeExecutable, [path.join(root, 'app', 'app.js')], {
  env: {...process.env, LOCALAPPDATA:updateDirectory, ZIENTSOV_PORT: String(port), ZIENTSOV_NO_WINDOW: '1', ZIENTSOV_TEST_MODE:'1', ZIENTSOV_UPDATE_API:`${updateBase}/releases/latest`},
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

async function updateRequest(route, token, options={}) {
  const response=await fetch(`${base}${route}`,{...options,headers:{...(options.headers||{}),'X-ZIENTSOV-Token':token}});
  return {response,data:await response.json()};
}

(async () => {
  try {
    const startup = await waitForServer();
    assert.ok(startup < 2500, `Повільний запуск локального сервера: ${startup} мс`);

    const home = await fetch(`${base}/`);
    assert.match(home.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    assert.equal(home.headers.get('x-frame-options'), 'DENY');
    const invalidHostStatus = await new Promise((resolve,reject) => {
      const request=http.get({hostname:'127.0.0.1',port,path:'/api/stats',headers:{Host:'example.invalid'}},response=>{response.resume();resolve(response.statusCode);});
      request.on('error',reject);
    });
    assert.equal(invalidHostStatus, 403);

    const stats = await (await fetch(`${base}/api/stats`)).json();
    assert.equal(stats.version, '0.4.12');
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

    const forbiddenUpdate = await fetch(`${base}/api/update/check`);
    assert.equal(forbiddenUpdate.status, 403);
    const session = await (await fetch(`${base}/api/session`)).json();
    assert.match(session.token, /^[a-f0-9]{64}$/);
    const checked = await updateRequest('/api/update/check?force=1', session.token);
    assert.equal(checked.response.status, 200);
    assert.equal(checked.data.status, 'available');
    assert.equal(checked.data.version, updateVersion);
    assert.equal(checked.data.size, installerBytes.length);
    const started = await updateRequest('/api/update/download', session.token, {method:'POST'});
    assert.equal(started.response.status, 202);
    let downloadState=started.data;
    for(let attempt=0;attempt<200&&!['ready','error'].includes(downloadState.status);attempt++){
      await new Promise(resolve=>setTimeout(resolve,25));
      downloadState=(await updateRequest('/api/update/status',session.token)).data;
    }
    assert.equal(downloadState.status,'ready',`Оновлення не завантажено: ${JSON.stringify(downloadState)}`);
    assert.equal(downloadState.progress,100);
    const downloadedPath=path.join(updateDirectory,'ZIENTSOV_LATYNKA','updates',installerName);
    assert.equal(fs.readFileSync(downloadedPath).equals(installerBytes),true);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(downloadedPath)).digest('hex'),installerHash);
    if(process.platform!=='win32'){
      const installAttempt=await updateRequest('/api/update/install',session.token,{method:'POST'});
      assert.equal(installAttempt.response.status,409);
      assert.equal(installAttempt.data.error,'windows_only');
    }

    const notFound = await fetch(`${base}/api/невідомо`);
    assert.equal(notFound.status, 404);
    console.log(`QA API PASS: словник, захист локального API та перевірене фонове оновлення; сервер готовий за ${startup} мс.`);
  } finally {
    child.kill();
    updateServer.close();
    fs.rmSync(updateDirectory,{recursive:true,force:true});
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
