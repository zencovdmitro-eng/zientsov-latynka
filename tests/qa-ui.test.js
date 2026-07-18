'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {JSDOM} = require('jsdom');

const repositoryHtml = path.resolve(__dirname, '..', 'app', 'web', 'index.html');
const htmlPath = fs.existsSync(repositoryHtml)
  ? repositoryHtml
  : path.resolve(__dirname, '..', 'payload_v046', 'app', 'web', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const forbiddenRussianUi = [
  'Совпадений нет',
  'Слово не найдено',
  'Двустороннее преобразование',
  'Скопировать результат',
  'Кириллица',
  'Пишите слово'
];
for (const phrase of forbiddenRussianUi) assert.ok(!html.includes(phrase), `У UI залишився російський текст: ${phrase}`);

const errors = [
  {word:'привіт', start:0, end:6, reason:'capitalization', suggestions:['Привіт']},
  {word:'мене зовут', start:8, end:18, reason:'surzhyk', suggestions:['Мене звати']},
  {word:'Дмиро', start:19, end:24, reason:'misspelled', suggestions:['Дмитро']}
];
let copied = '';

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'http://127.0.0.1:8765/',
  beforeParse(window) {
    window.scrollTo = () => {};
    window.fetch = async (url, options={}) => {
      const target = String(url);
      if (target.includes('/api/stats')) return response({project:'ZIENTSOV LATYNKA', version:'0.4.11', unique_entries:'322682'});
      if (target.includes('/api/search')) {
        const query = new URL(target, 'http://127.0.0.1:8765/').searchParams.get('q');
        if (query === 'здание') return response({
          results:[],
          suggestions:['будівля','будинок','споруда'],
          reason:'translation',
          options:[
            {word:'будівля', note:'Загальна назва наземної архітектурної споруди.'},
            {word:'будинок', note:'Переважно житлова будівля.'},
            {word:'споруда', note:'Будь-який штучно зведений об’єкт.'}
          ]
        });
        if (query === 'будівля') return response({results:[{latin:'budivlja', cyrillic:'будівля'}], suggestions:[]});
        return response({results:[{latin:'Ukrajina', cyrillic:'Україна'}], suggestions:[]});
      }
      const payload = JSON.parse(options.body || '{}');
      if (payload.text === 'Привіт. Мене звати Дмитро') return response({ok:true, result:'Pryvit. Mene zvaty Dmytro', errors:[]});
      if (payload.text === 'Pryvit' && payload.direction === 'cyrillic') return response({ok:true, result:'Привіт', errors:[]});
      return response({ok:false, result:'', errors});
    };
    window.navigator.clipboard = {writeText: async value => { copied = value; }};
  }
});

function response(value) {
  return {ok:true, status:200, json:async () => value};
}
function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

(async () => {
  const {document, Event} = dom.window;
  await wait(30);
  assert.equal(document.querySelector('#version-badge').textContent, 'Версія 0.4.11');
  assert.match(document.querySelector('#stats').textContent, /322[\s\u00a0]?682/);

  const input = document.querySelector('#source-text');
  input.value = 'привіт. мене зовут Дмиро';
  input.dispatchEvent(new Event('input', {bubbles:true}));
  await wait(420);
  const fixAll = [...document.querySelectorAll('button')].find(node => node.textContent === 'Виправити все');
  assert.ok(fixAll, 'Кнопку «Виправити все» не створено');
  fixAll.click();
  await wait(80);
  assert.equal(input.value, 'Привіт. Мене звати Дмитро');
  assert.equal(document.querySelector('#converted-text').value, 'Pryvit. Mene zvaty Dmytro');

  document.querySelector('#copy').click();
  await wait(5);
  assert.equal(copied, 'Pryvit. Mene zvaty Dmytro');

  document.querySelector('#to-cyrillic').click();
  input.value = 'Pryvit';
  input.dispatchEvent(new Event('input', {bubbles:true}));
  await wait(420);
  assert.equal(document.querySelector('#converted-text').value, 'Привіт');

  const search = document.querySelector('#search');
  search.value = 'здание';
  document.querySelector('#search-form').dispatchEvent(new Event('submit', {bubbles:true, cancelable:true}));
  await wait(20);
  assert.match(document.querySelector('.search-error strong').textContent, /російське або суржикове/);
  assert.equal(document.querySelectorAll('.translation-option').length, 3);
  assert.match(document.querySelector('.translation-option span').textContent, /архітектурної споруди/);
  document.querySelector('.translation-option').click();
  await wait(20);
  assert.equal(document.querySelector('.result-cyrillic').textContent, 'будівля');

  search.value = 'Україна';
  document.querySelector('#search-form').dispatchEvent(new Event('submit', {bubbles:true, cancelable:true}));
  await wait(20);
  assert.equal(document.querySelector('.result-latin').textContent, 'Ukrajina');
  assert.equal(document.querySelector('.result-cyrillic').textContent, 'Україна');

  console.log('QA UI PASS: мова, версія, «Виправити все», копіювання, обидва напрями, переклад-підказка та пошук.');
  dom.window.close();
})().catch(error => {
  console.error(error.stack || error);
  dom.window.close();
  process.exitCode = 1;
});
