'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const {Worker, isMainThread, parentPort, workerData} = require('worker_threads');
const {DatabaseSync} = require('node:sqlite');
const nspell = require('nspell');

const ROOT = __dirname;
const PID_FILE = path.join(ROOT, '..', 'runtime.pid');
const HOST = '127.0.0.1';
const PORT = Number(process.env.ZIENTSOV_PORT || 8765);
const MAX_RESULTS = 60;
const MAX_TEXT_LENGTH = 20000;
const MAX_SUGGESTIONS = 6;
const HTML = isMainThread ? fs.readFileSync(path.join(ROOT, 'web', 'index.html')) : null;
// nspell implements compound rules more permissively than the project checker.
// Disable those rules so accidental word concatenations cannot pass as valid words.
let SPELL = null;
const DB = isMainThread ? new DatabaseSync(path.join(ROOT, 'data', 'zientsov_latynka_slovnyk.sqlite3'), {readOnly: true}) : null;
const SURZHYK = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'surzhyk_replacements.json'), 'utf8'));
const CORRECTIONS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'correction_overrides.json'), 'utf8'));

const CYR = new Set([...('АБВГҐДЕЄЖЗИІЇЙКЛМНОПРСТУФХЦЧШЩЬЮЯ' + 'абвгґдеєжзиіїйклмнопрстуфхцчшщьюя')]);
const LAT = new Set([...('ABCDEFGHIJKLMNOPRSTUVYZabcdefghijklmnoprstuvyzĆćČčĎďĽľŇňŔŕŚśŠšŤťŹźŽžʹ')]);
const CONNECTORS = new Set(["'", '’', 'ʼ', '‘', '`', '-', '‐', '‑', '·', '∙', '⋅']);
const WORD_PATTERN = /\p{L}+(?:['’ʼ‘`\-‐‑·∙⋅]\p{L}+)*/gu;
const PROJECT_WORDS = new Set(['зєнцов','зєнцова','зєнцову','зєнцовим','зєнцові','зєнцове','латиниця','латинка','транслітератор']);

const CYR_TO_LAT = {а:'a',б:'b',в:'v',г:'h',ґ:'g',д:'d',е:'e',є:'je',ж:'ž',з:'z',и:'y',і:'i',ї:'ji',й:'j',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'ch',ц:'c',ч:'č',ш:'š',щ:'šč',ь:'ʹ',ю:'ju',я:'ja'};
const SOFT_CYR = {'ць':'ć','дь':'ď','ль':'ľ','нь':'ň','рь':'ŕ','сь':'ś','ть':'ť','зь':'ź'};
const AMBIGUOUS = new Set(['йа','йе','йі','йу','цг','шч']);
const LAT_MULTI = {'šč':'щ','ch':'х','ja':'я','je':'є','ji':'ї','ju':'ю'};
const SOFT_LAT = Object.fromEntries(Object.entries(SOFT_CYR).map(([a,b]) => [b,a]));
const LAT_SINGLE = {a:'а',b:'б',c:'ц',č:'ч',d:'д',e:'е',f:'ф',g:'ґ',h:'г',i:'і',j:'й',k:'к',l:'л',m:'м',n:'н',o:'о',p:'п',r:'р',s:'с',š:'ш',t:'т',u:'у',v:'в',y:'и',z:'з',ž:'ж','ʹ':'ь'};

function normalized(value) { return value.normalize('NFC').replace(/[’ʼ‘`]/g, "'"); }
function matchCase(value,source) {const letters=[...source].filter(ch=>/\p{L}/u.test(ch));if(letters.length&&letters.every(isUpper))return value.toUpperCase();if(isUpper(source[0]||''))return value[0].toUpperCase()+value.slice(1);return value;}
function isSentenceStart(text,position){const prefix=text.slice(0,position).trimEnd();return !prefix||/[.!?…]$/.test(prefix);}
function isUpper(ch) { return ch.toUpperCase() === ch && ch.toLowerCase() !== ch; }
function caseValue(value, source, allCaps=false) {
  if (!isUpper(source)) return value;
  return allCaps ? value.toUpperCase() : value[0].toUpperCase() + value.slice(1);
}
function allCapsAt(text, index) {
  let left=index, right=index+1;
  const allowed = ch => /\p{L}/u.test(ch) || CONNECTORS.has(ch);
  while (left>0 && allowed(text[left-1])) left--;
  while (right<text.length && allowed(text[right])) right++;
  const letters=[...text.slice(left,right)].filter(ch => /\p{L}/u.test(ch));
  return letters.length>=2 && letters.every(isUpper);
}
function cyrToLat(input) {
  const text=input.normalize('NFC'); let out='';
  for (let i=0;i<text.length;) {
    const ch=text[i], low=ch.toLowerCase();
    if (/[’ʼ‘`']/.test(ch)) {out+="'"; i++; continue;}
    const pair=i+1<text.length ? low+text[i+1].toLowerCase() : '';
    if (SOFT_CYR[pair]) {out+=caseValue(SOFT_CYR[pair],ch,allCapsAt(text,i)); i+=2; continue;}
    if (AMBIGUOUS.has(pair)) {out+=caseValue(CYR_TO_LAT[low],ch)+'·'+caseValue(CYR_TO_LAT[text[i+1].toLowerCase()],text[i+1]); i+=2; continue;}
    out+=CYR_TO_LAT[low] ? caseValue(CYR_TO_LAT[low],ch,allCapsAt(text,i)) : ch; i++;
  }
  return out;
}
function latToCyr(input) {
  const text=input.normalize('NFC'); let out='';
  for (let i=0;i<text.length;) {
    const ch=text[i];
    if (/[·∙⋅]/.test(ch)) {i++; continue;}
    if (/[’ʼ‘`']/.test(ch)) {out+="'"; i++; continue;}
    let matched=false;
    for (const size of [3,2]) {
      const candidate=text.slice(i,i+size), low=candidate.toLowerCase();
      if (candidate.length===size && !/[·∙⋅]/.test(candidate) && LAT_MULTI[low]) {out+=caseValue(LAT_MULTI[low],candidate[0],allCapsAt(text,i)); i+=size; matched=true; break;}
    }
    if (matched) continue;
    const low=ch.toLowerCase(), value=SOFT_LAT[low] || LAT_SINGLE[low];
    out+=value ? caseValue(value,ch,allCapsAt(text,i)) : ch; i++;
  }
  return out;
}
function scriptOf(word) {
  const letters=[...word].filter(ch => !CONNECTORS.has(ch));
  if (letters.length && letters.every(ch => CYR.has(ch))) return 'cyrillic';
  if (letters.length && letters.every(ch => LAT.has(ch))) return 'latin';
  return 'invalid';
}
function spellWord(word,direction) {
  word=normalized(word); const expected=direction==='latin'?'cyrillic':'latin'; const actual=scriptOf(word);
  const cyrCandidate=direction==='latin'?word:latToCyr(word),normative=SURZHYK[cyrCandidate.toLowerCase()];
  if(normative){let suggestions=normative.map(value=>matchCase(value,cyrCandidate));if(direction==='cyrillic')suggestions=suggestions.map(cyrToLat);return {valid:false,reason:'surzhyk',suggestions:suggestions.slice(0,MAX_SUGGESTIONS)};}
  const corrections=CORRECTIONS[cyrCandidate.toLowerCase()];
  if(corrections){let suggestions=corrections.map(value=>matchCase(value,cyrCandidate));if(direction==='cyrillic')suggestions=suggestions.map(cyrToLat);return {valid:false,reason:'misspelled',suggestions:suggestions.slice(0,MAX_SUGGESTIONS)};}
  if (actual!==expected) return {valid:false,reason:actual==='invalid'?'invalid_letters':'wrong_script',suggestions:[]};
  const cyr=direction==='latin'?word:latToCyr(word);
  if (PROJECT_WORDS.has(cyr.toLowerCase()) || SPELL.correct(cyr)) return {valid:true,reason:'',suggestions:[]};
  let suggestions=SPELL.suggest(cyr).filter(x => scriptOf(x)==='cyrillic' && !x.includes(' ')).slice(0,MAX_SUGGESTIONS);
  if (direction==='cyrillic') suggestions=suggestions.map(cyrToLat);
  return {valid:false,reason:'misspelled',suggestions};
}
function spellText(text,direction) {
  text=normalized(text); const errors=[],occupied=[];
  if(direction==='latin')for(const [mapping,reason] of [[SURZHYK,'surzhyk'],[CORRECTIONS,'misspelled']])for(const [source,replacements] of Object.entries(mapping)){if(!source.includes(' '))continue;const escaped=source.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const pattern=new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,'giu');for(const match of text.matchAll(pattern)){const end=match.index+match[0].length;if(occupied.some(([start,stop])=>start<end&&match.index<stop))continue;let suggestions=replacements.map(x=>matchCase(x,match[0]));if(isSentenceStart(text,match.index))suggestions=suggestions.map(x=>x[0].toUpperCase()+x.slice(1));errors.push({word:match[0],start:match.index,end,reason,suggestions:suggestions.slice(0,MAX_SUGGESTIONS)});occupied.push([match.index,end]);}}
  for (const match of text.matchAll(WORD_PATTERN)) {
    if(occupied.some(([start,end])=>start<=match.index&&match.index+match[0].length<=end))continue;
    const result=spellWord(match[0],direction);
    if (!result.valid) errors.push({word:match[0],start:match.index,end:match.index+match[0].length,reason:result.reason,suggestions:result.suggestions});
    else if(isSentenceStart(text,match.index)&&/^\p{Ll}/u.test(match[0]))errors.push({word:match[0],start:match.index,end:match.index+match[0].length,reason:'capitalization',suggestions:[match[0][0].toUpperCase()+match[0].slice(1)]});
  } return errors.sort((a,b)=>a.start-b.start);
}
function search(query) {
  const q=normalized(query).toLowerCase().trim(); if (!q) return [];
  const escaped=q.replace(/[\\%_]/g,'\\$&');
  return DB.prepare(`SELECT latin,cyrillic,CASE WHEN latin_fold=? OR cyrillic_fold=? THEN 0 WHEN latin_fold LIKE ? ESCAPE '\\' OR cyrillic_fold LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END rank FROM words WHERE latin_fold=? OR cyrillic_fold=? OR latin_fold LIKE ? ESCAPE '\\' OR cyrillic_fold LIKE ? ESCAPE '\\' OR latin_fold LIKE ? ESCAPE '\\' OR cyrillic_fold LIKE ? ESCAPE '\\' ORDER BY rank,length(latin),latin_fold LIMIT ?`).all(q,q,escaped+'%',escaped+'%',q,q,escaped+'%',escaped+'%','%'+escaped+'%','%'+escaped+'%',MAX_RESULTS).map(({latin,cyrillic})=>({latin,cyrillic}));
}
function json(res,value,status=200) {const body=Buffer.from(JSON.stringify(value)); res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(body);}
const pendingSpell = new Map();
let spellSequence = 0;
let spellWorker = null;
function requestSpell(type,text,direction) {
  if (!spellWorker) return Promise.reject(new Error('spell_worker_unavailable'));
  return new Promise((resolve,reject)=>{const id=++spellSequence;pendingSpell.set(id,{resolve,reject});spellWorker.postMessage({id,type,text,direction});});
}
async function conversion(text,direction) {if (!['latin','cyrillic'].includes(direction)) return {ok:false,error:'invalid_direction',errors:[]}; const errors=await requestSpell('text',text,direction); return errors.length?{ok:false,result:'',errors}:{ok:true,result:direction==='latin'?cyrToLat(text):latToCyr(text),errors:[]};}
async function handler(req,res) {
  const url=new URL(req.url,'http://localhost');
  if (req.method==='GET' && url.pathname==='/') {res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Length':HTML.length,'Cache-Control':'no-store'}); return res.end(HTML);}
  if (req.method==='GET' && url.pathname==='/api/stats') return json(res,Object.fromEntries(DB.prepare('SELECT key,value FROM metadata').all().map(x=>[x.key,x.value])));
  if (req.method==='GET' && url.pathname==='/api/search') {const query=(url.searchParams.get('q')||'').slice(0,100); const results=search(query); let suggestions=[]; if(query && !results.length && [...query.matchAll(WORD_PATTERN)].length===1){const direction=scriptOf(normalized(query))==='cyrillic'?'latin':'cyrillic'; const check=await requestSpell('word',query,direction); if(check.reason==='misspelled') suggestions=check.suggestions;} return json(res,{query,results,suggestions});}
  if (req.method==='GET' && url.pathname==='/api/convert') return json(res,await conversion((url.searchParams.get('text')||'').slice(0,MAX_TEXT_LENGTH),url.searchParams.get('direction')||'latin'));
  if (req.method==='GET' && url.pathname==='/api/spellcheck') {const direction=url.searchParams.get('direction')||'latin',errors=await requestSpell('text',(url.searchParams.get('text')||'').slice(0,MAX_TEXT_LENGTH),direction); return json(res,{ok:!errors.length,errors});}
  if (req.method==='POST' && ['/api/convert','/api/spellcheck'].includes(url.pathname)) {let raw=''; req.on('data',c=>{raw+=c;if(raw.length>100000)req.destroy();}); req.on('end',async()=>{try{const p=JSON.parse(raw),text=String(p.text||'').slice(0,MAX_TEXT_LENGTH),direction=String(p.direction||'latin'); if(url.pathname==='/api/convert')return json(res,await conversion(text,direction)); const errors=await requestSpell('text',text,direction); return json(res,{ok:!errors.length,errors});}catch{return json(res,{error:'invalid_request'},400);}}); return;}
  return json(res,{error:'not_found'},404);
}
function browserPath() {const env=process.env; const candidates=[[env['PROGRAMFILES(X86)'],'Microsoft','Edge','Application','msedge.exe'],[env.PROGRAMFILES,'Microsoft','Edge','Application','msedge.exe'],[env.LOCALAPPDATA,'Microsoft','Edge','Application','msedge.exe'],[env.PROGRAMFILES,'Google','Chrome','Application','chrome.exe']]; for(const parts of candidates){if(!parts[0])continue;const p=path.join(...parts);if(fs.existsSync(p))return p;} return null;}
function openWindow(){if(process.platform!=='win32')return; const exe=browserPath(); let child; if(exe){child=spawn(exe,[`--app=http://${HOST}:${PORT}/`,'--start-maximized'],{detached:true,stdio:'ignore'});}else{child=spawn('cmd.exe',['/c','start','',`http://${HOST}:${PORT}/`],{detached:true,stdio:'ignore'});} child.on('error',()=>{}); child.unref();}
if (!isMainThread && workerData && workerData.spellWorker) {
  const aff=Buffer.from(fs.readFileSync(path.join(ROOT,'source','index.aff'),'utf8').split(/\r?\n/).filter(line=>!/^COMPOUND/.test(line)).join('\n'),'utf8');
  const dic=fs.readFileSync(path.join(ROOT,'source','index.dic'));
  SPELL=nspell(aff,dic);
  parentPort.on('message',message=>{try{const value=message.type==='word'?spellWord(message.text,message.direction):spellText(message.text,message.direction);parentPort.postMessage({id:message.id,value});}catch(error){parentPort.postMessage({id:message.id,error:String(error.message||error)});}});
  parentPort.postMessage({ready:true});
} else {
  spellWorker=new Worker(__filename,{workerData:{spellWorker:true}});
  spellWorker.on('message',message=>{if(message.ready)return;const pending=pendingSpell.get(message.id);if(!pending)return;pendingSpell.delete(message.id);message.error?pending.reject(new Error(message.error)):pending.resolve(message.value);});
  spellWorker.on('error',error=>{for(const pending of pendingSpell.values())pending.reject(error);pendingSpell.clear();});
  const server=http.createServer((req,res)=>{handler(req,res).catch(()=>json(res,{error:'internal_error'},500));});
  server.on('error',error=>{if(error.code==='EADDRINUSE'){openWindow();process.exit(0);}throw error;});
  server.listen(PORT,HOST,()=>{try{fs.writeFileSync(PID_FILE,String(process.pid),'utf8');}catch{} openWindow();});
  process.on('exit',()=>{try{if(fs.readFileSync(PID_FILE,'utf8').trim()===String(process.pid))fs.unlinkSync(PID_FILE);}catch{}});
}
