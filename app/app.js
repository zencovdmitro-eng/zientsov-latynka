'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const {once} = require('events');
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
const PROJECT_REPOSITORY = 'zencovdmitro-eng/zientsov-latynka';
const UPDATE_API = process.env.ZIENTSOV_TEST_MODE === '1' && process.env.ZIENTSOV_UPDATE_API
  ? process.env.ZIENTSOV_UPDATE_API
  : `https://api.github.com/repos/${PROJECT_REPOSITORY}/releases/latest`;
const UPDATE_DIRECTORY = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'ZIENTSOV_LATYNKA', 'updates');
const UPDATE_TIMEOUT_MS = 7000;
const MAX_UPDATE_SIZE = 250 * 1024 * 1024;
const SESSION_TOKEN = isMainThread ? crypto.randomBytes(32).toString('hex') : '';
const HTML = isMainThread ? fs.readFileSync(path.join(ROOT, 'web', 'index.html')) : null;
// nspell implements compound rules more permissively than the project checker.
// Disable those rules so accidental word concatenations cannot pass as valid words.
let SPELL = null;
const DB = isMainThread ? new DatabaseSync(path.join(ROOT, 'data', 'zientsov_latynka_slovnyk.sqlite3'), {readOnly: true}) : null;
const SURZHYK = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'surzhyk_replacements.json'), 'utf8'));
const CORRECTIONS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'correction_overrides.json'), 'utf8'));
const TRANSLATION_HINTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'translation_hints.json'), 'utf8'));
let UPDATE_STATE = {status:'idle',available:false};
let UPDATE_CANDIDATE = null;
let UPDATE_DOWNLOAD = null;
let LAST_UPDATE_CHECK = 0;

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
const SECURITY_HEADERS = {
  'Cache-Control':'no-store',
  'X-Content-Type-Options':'nosniff',
  'X-Frame-Options':'DENY',
  'Referrer-Policy':'no-referrer',
  'Cross-Origin-Opener-Policy':'same-origin',
  'Cross-Origin-Resource-Policy':'same-origin',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()'
};
function json(res,value,status=200) {const body=Buffer.from(JSON.stringify(value)); res.writeHead(status,{...SECURITY_HEADERS,'Content-Type':'application/json; charset=utf-8','Content-Length':body.length}); res.end(body);}

function currentVersion() {
  try { return String(DB.prepare("SELECT value FROM metadata WHERE key='version'").get().value); }
  catch { return '0.0.0'; }
}
function parseVersion(value) {
  const match=String(value||'').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
}
function compareVersions(left,right) {
  const a=parseVersion(left),b=parseVersion(right);
  if(!a||!b)throw new Error('invalid_version');
  for(let index=0;index<3;index++){if(a[index]!==b[index])return a[index]>b[index]?1:-1;}
  return 0;
}
function publicUpdateState() {
  const state={...UPDATE_STATE,currentVersion:currentVersion()};
  delete state.filePath;
  return state;
}
function isAllowedUpdateUrl(value) {
  try {
    const url=new URL(value);
    if(process.env.ZIENTSOV_TEST_MODE==='1')return ['127.0.0.1','localhost'].includes(url.hostname);
    const prefix=`/${PROJECT_REPOSITORY}/releases/download/`;
    return url.protocol==='https:'&&url.hostname==='github.com'&&url.pathname.startsWith(prefix);
  } catch { return false; }
}
async function fetchWithTimeout(url,options={}) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),UPDATE_TIMEOUT_MS);
  try {
    return await fetch(url,{...options,redirect:'follow',signal:controller.signal,headers:{'Accept':'application/vnd.github+json','User-Agent':'ZIENTSOV-LATYNKA-Updater',...(options.headers||{})}});
  } finally { clearTimeout(timer); }
}
async function readJsonResponse(response) {
  if(!response.ok)throw new Error(`http_${response.status}`);
  const text=await response.text();
  if(text.length>1024*1024)throw new Error('response_too_large');
  try{return JSON.parse(text);}catch{throw new Error('invalid_json');}
}
function validateUpdateManifest(manifest,release,version) {
  if(!manifest||manifest.schema!==1||manifest.product!=='ZIENTSOV LATYNKA'||manifest.channel!=='stable')throw new Error('invalid_manifest');
  if(compareVersions(manifest.version,version)!==0||compareVersions(version,currentVersion())<=0)throw new Error('invalid_manifest_version');
  const installer=manifest.installer||{};
  const expectedName=`ZIENTSOV_LATYNKA_Setup_v${version}.exe`;
  if(installer.name!==expectedName||!/^[a-f0-9]{64}$/i.test(installer.sha256||''))throw new Error('invalid_installer_metadata');
  if(!Number.isSafeInteger(installer.size)||installer.size<1024||installer.size>MAX_UPDATE_SIZE)throw new Error('invalid_installer_size');
  const asset=(release.assets||[]).find(item=>item.name===installer.name);
  if(!asset||asset.size!==installer.size||!isAllowedUpdateUrl(asset.browser_download_url))throw new Error('installer_asset_mismatch');
  return {
    version,
    filename:installer.name,
    sha256:installer.sha256.toLowerCase(),
    size:installer.size,
    downloadUrl:asset.browser_download_url,
    notes:Array.isArray(manifest.notes)?manifest.notes.slice(0,12).map(item=>String(item).slice(0,300)):[],
    publishedAt:String(manifest.published_at||release.published_at||''),
    mandatory:Boolean(manifest.mandatory)
  };
}
async function checkForUpdate(force=false) {
  if(UPDATE_DOWNLOAD)return publicUpdateState();
  if(!force&&LAST_UPDATE_CHECK&&Date.now()-LAST_UPDATE_CHECK<30000)return publicUpdateState();
  UPDATE_STATE={status:'checking',available:false};
  try {
    const release=await readJsonResponse(await fetchWithTimeout(UPDATE_API));
    LAST_UPDATE_CHECK=Date.now();
    const versionMatch=String(release.tag_name||'').match(/^v?(\d+\.\d+\.\d+)$/);
    if(!versionMatch||release.draft||release.prerelease)throw new Error('invalid_release');
    const version=versionMatch[1];
    if(compareVersions(version,currentVersion())<=0){UPDATE_CANDIDATE=null;UPDATE_STATE={status:'current',available:false,checkedAt:new Date().toISOString()};return publicUpdateState();}
    const manifestName=`ZIENTSOV_LATYNKA_Update_v${version}.json`;
    const manifestAsset=(release.assets||[]).find(item=>item.name===manifestName);
    if(!manifestAsset||!isAllowedUpdateUrl(manifestAsset.browser_download_url))throw new Error('manifest_missing');
    const manifest=await readJsonResponse(await fetchWithTimeout(manifestAsset.browser_download_url,{headers:{'Accept':'application/json'}}));
    UPDATE_CANDIDATE=validateUpdateManifest(manifest,release,version);
    UPDATE_STATE={status:'available',available:true,version,filename:UPDATE_CANDIDATE.filename,size:UPDATE_CANDIDATE.size,notes:UPDATE_CANDIDATE.notes,publishedAt:UPDATE_CANDIDATE.publishedAt,mandatory:UPDATE_CANDIDATE.mandatory,verification:'sha256'};
  } catch(error) {
    UPDATE_STATE={status:'error',available:false,error:String(error.message||error)};
  }
  return publicUpdateState();
}
async function sha256File(filePath) {
  const hash=crypto.createHash('sha256');
  const stream=fs.createReadStream(filePath);
  for await(const chunk of stream)hash.update(chunk);
  return hash.digest('hex');
}
async function downloadUpdate() {
  const candidate=UPDATE_CANDIDATE;
  if(!candidate)throw new Error('update_not_selected');
  fs.mkdirSync(UPDATE_DIRECTORY,{recursive:true});
  const finalPath=path.join(UPDATE_DIRECTORY,candidate.filename);
  const partialPath=finalPath+'.part';
  try {
    if(fs.existsSync(finalPath)){
      const stat=fs.statSync(finalPath);
      if(stat.size===candidate.size&&await sha256File(finalPath)===candidate.sha256){UPDATE_STATE={...UPDATE_STATE,status:'ready',available:true,downloaded:candidate.size,total:candidate.size,progress:100,filePath:finalPath};return;}
      fs.unlinkSync(finalPath);
    }
    try{fs.unlinkSync(partialPath);}catch{}
    UPDATE_STATE={...UPDATE_STATE,status:'downloading',available:true,downloaded:0,total:candidate.size,progress:0};
    const response=await fetchWithTimeout(candidate.downloadUrl,{headers:{'Accept':'application/octet-stream'}});
    if(!response.ok||!response.body)throw new Error(`download_http_${response.status}`);
    const announced=Number(response.headers.get('content-length')||0);
    if(announced>MAX_UPDATE_SIZE)throw new Error('download_too_large');
    const output=fs.createWriteStream(partialPath,{flags:'wx'});
    const hash=crypto.createHash('sha256');
    let downloaded=0;
    try {
      for await(const value of response.body){const chunk=Buffer.from(value);downloaded+=chunk.length;if(downloaded>candidate.size||downloaded>MAX_UPDATE_SIZE)throw new Error('download_size_mismatch');hash.update(chunk);if(!output.write(chunk))await once(output,'drain');UPDATE_STATE={...UPDATE_STATE,downloaded,total:candidate.size,progress:Math.min(99,Math.floor(downloaded*100/candidate.size))};}
      const finished=once(output,'finish');output.end();await finished;
    } catch(error) {output.destroy();throw error;}
    if(downloaded!==candidate.size||hash.digest('hex')!==candidate.sha256)throw new Error('checksum_mismatch');
    fs.renameSync(partialPath,finalPath);
    UPDATE_STATE={...UPDATE_STATE,status:'ready',available:true,downloaded,total:candidate.size,progress:100,filePath:finalPath};
  } catch(error) {
    try{fs.unlinkSync(partialPath);}catch{}
    UPDATE_STATE={status:'error',available:true,version:candidate.version,error:String(error.message||error)};
  } finally { UPDATE_DOWNLOAD=null; }
}
function startUpdateDownload() {
  if(!UPDATE_CANDIDATE)throw new Error('update_not_available');
  if(!UPDATE_DOWNLOAD)UPDATE_DOWNLOAD=downloadUpdate();
  return publicUpdateState();
}
function startUpdateInstall() {
  if(process.platform!=='win32')throw new Error('windows_only');
  const filePath=UPDATE_STATE.filePath;
  if(UPDATE_STATE.status!=='ready'||!filePath||!fs.existsSync(filePath))throw new Error('update_not_ready');
  UPDATE_STATE={...UPDATE_STATE,status:'installing'};
  setTimeout(()=>{
    try {
      const child=spawn(filePath,[],{detached:true,stdio:'ignore',windowsHide:false});
      child.once('spawn',()=>{child.unref();setTimeout(()=>process.exit(0),500);});
      child.once('error',error=>{UPDATE_STATE={status:'error',available:true,error:String(error.message||error)};});
    } catch(error) {UPDATE_STATE={status:'error',available:true,error:String(error.message||error)};}
  },250);
  return publicUpdateState();
}
function authorizedUpdateRequest(req) {
  const provided=String(req.headers['x-zientsov-token']||'');
  if(provided.length!==SESSION_TOKEN.length)return false;
  return crypto.timingSafeEqual(Buffer.from(provided),Buffer.from(SESSION_TOKEN));
}
function validLocalHost(req) {
  const host=String(req.headers.host||'').toLowerCase();
  return [HOST,`${HOST}:${PORT}`,'localhost',`localhost:${PORT}`].includes(host);
}
function cleanupOldUpdates() {
  try {
    fs.mkdirSync(UPDATE_DIRECTORY,{recursive:true});
    const limit=Date.now()-30*24*60*60*1000;
    for(const name of fs.readdirSync(UPDATE_DIRECTORY)){const filePath=path.join(UPDATE_DIRECTORY,name);const stat=fs.statSync(filePath);if(stat.isFile()&&(name.endsWith('.part')||stat.mtimeMs<limit))fs.unlinkSync(filePath);}
  } catch {}
}
const pendingSpell = new Map();
let spellSequence = 0;
let spellWorker = null;
function requestSpell(type,text,direction) {
  if (!spellWorker) return Promise.reject(new Error('spell_worker_unavailable'));
  return new Promise((resolve,reject)=>{const id=++spellSequence;pendingSpell.set(id,{resolve,reject});spellWorker.postMessage({id,type,text,direction});});
}
async function conversion(text,direction) {if (!['latin','cyrillic'].includes(direction)) return {ok:false,error:'invalid_direction',errors:[]}; const errors=await requestSpell('text',text,direction); return errors.length?{ok:false,result:'',errors}:{ok:true,result:direction==='latin'?cyrToLat(text):latToCyr(text),errors:[]};}
async function handler(req,res) {
  if(!validLocalHost(req))return json(res,{error:'invalid_host'},403);
  const url=new URL(req.url,'http://localhost');
  if (req.method==='GET' && url.pathname==='/') {res.writeHead(200,{...SECURITY_HEADERS,'Content-Type':'text/html; charset=utf-8','Content-Length':HTML.length,'Content-Security-Policy':"default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"}); return res.end(HTML);}
  if (req.method==='GET' && url.pathname==='/api/stats') return json(res,Object.fromEntries(DB.prepare('SELECT key,value FROM metadata').all().map(x=>[x.key,x.value])));
  if (req.method==='GET' && url.pathname==='/api/session') return json(res,{token:SESSION_TOKEN});
  if (url.pathname.startsWith('/api/update/')&&!authorizedUpdateRequest(req))return json(res,{error:'forbidden'},403);
  if (req.method==='GET' && url.pathname==='/api/update/check') return json(res,await checkForUpdate(url.searchParams.get('force')==='1'));
  if (req.method==='GET' && url.pathname==='/api/update/status') return json(res,publicUpdateState());
  if (req.method==='POST' && url.pathname==='/api/update/download') {try{return json(res,startUpdateDownload(),202);}catch(error){return json(res,{error:String(error.message||error)},409);}}
  if (req.method==='POST' && url.pathname==='/api/update/install') {try{return json(res,startUpdateInstall(),202);}catch(error){return json(res,{error:String(error.message||error)},409);}}
  if (req.method==='GET' && url.pathname==='/api/search') {const query=(url.searchParams.get('q')||'').slice(0,100),normalizedQuery=normalized(query).toLowerCase().trim(); const results=search(query); let suggestions=[],reason='',options=[]; const hint=TRANSLATION_HINTS[normalizedQuery]; if(query && !results.length && hint){options=hint.options||[];suggestions=options.map(item=>item.word);reason='translation';}else if(query && !results.length && [...query.matchAll(WORD_PATTERN)].length===1){const direction=scriptOf(normalized(query))==='cyrillic'?'latin':'cyrillic'; const check=await requestSpell('word',query,direction); if(['misspelled','surzhyk'].includes(check.reason)){suggestions=check.suggestions;reason=check.reason;}} return json(res,{query,results,suggestions,reason,options});}
  if (req.method==='GET' && url.pathname==='/api/convert') return json(res,await conversion((url.searchParams.get('text')||'').slice(0,MAX_TEXT_LENGTH),url.searchParams.get('direction')||'latin'));
  if (req.method==='GET' && url.pathname==='/api/spellcheck') {const direction=url.searchParams.get('direction')||'latin',errors=await requestSpell('text',(url.searchParams.get('text')||'').slice(0,MAX_TEXT_LENGTH),direction); return json(res,{ok:!errors.length,errors});}
  if (req.method==='POST' && ['/api/convert','/api/spellcheck'].includes(url.pathname)) {let raw=''; req.on('data',c=>{raw+=c;if(raw.length>100000)req.destroy();}); req.on('end',async()=>{try{const p=JSON.parse(raw),text=String(p.text||'').slice(0,MAX_TEXT_LENGTH),direction=String(p.direction||'latin'); if(url.pathname==='/api/convert')return json(res,await conversion(text,direction)); const errors=await requestSpell('text',text,direction); return json(res,{ok:!errors.length,errors});}catch{return json(res,{error:'invalid_request'},400);}}); return;}
  return json(res,{error:'not_found'},404);
}
function browserPath() {const env=process.env; const candidates=[[env['PROGRAMFILES(X86)'],'Microsoft','Edge','Application','msedge.exe'],[env.PROGRAMFILES,'Microsoft','Edge','Application','msedge.exe'],[env.LOCALAPPDATA,'Microsoft','Edge','Application','msedge.exe'],[env.PROGRAMFILES,'Google','Chrome','Application','chrome.exe']]; for(const parts of candidates){if(!parts[0])continue;const p=path.join(...parts);if(fs.existsSync(p))return p;} return null;}
function openWindow(){if(process.platform!=='win32'||process.env.ZIENTSOV_NO_WINDOW==='1')return; const exe=browserPath(); let child; if(exe){child=spawn(exe,[`--app=http://${HOST}:${PORT}/`,'--start-maximized'],{detached:true,stdio:'ignore'});}else{child=spawn('cmd.exe',['/c','start','',`http://${HOST}:${PORT}/`],{detached:true,stdio:'ignore'});} child.on('error',()=>{}); child.unref();}
if (!isMainThread && workerData && workerData.spellWorker) {
  const aff=Buffer.from(fs.readFileSync(path.join(ROOT,'source','index.aff'),'utf8').split(/\r?\n/).filter(line=>!/^COMPOUND/.test(line)).join('\n'),'utf8');
  const dic=fs.readFileSync(path.join(ROOT,'source','index.dic'));
  SPELL=nspell(aff,dic);
  parentPort.on('message',message=>{try{const value=message.type==='word'?spellWord(message.text,message.direction):spellText(message.text,message.direction);parentPort.postMessage({id:message.id,value});}catch(error){parentPort.postMessage({id:message.id,error:String(error.message||error)});}});
  parentPort.postMessage({ready:true});
} else {
  cleanupOldUpdates();
  spellWorker=new Worker(__filename,{workerData:{spellWorker:true}});
  spellWorker.on('message',message=>{if(message.ready)return;const pending=pendingSpell.get(message.id);if(!pending)return;pendingSpell.delete(message.id);message.error?pending.reject(new Error(message.error)):pending.resolve(message.value);});
  spellWorker.on('error',error=>{for(const pending of pendingSpell.values())pending.reject(error);pendingSpell.clear();});
  const server=http.createServer((req,res)=>{handler(req,res).catch(()=>json(res,{error:'internal_error'},500));});
  server.on('error',error=>{if(error.code==='EADDRINUSE'){openWindow();process.exit(0);}throw error;});
  server.listen(PORT,HOST,()=>{try{fs.writeFileSync(PID_FILE,String(process.pid),'utf8');}catch{} openWindow();});
  process.on('exit',()=>{try{if(fs.readFileSync(PID_FILE,'utf8').trim()===String(process.pid))fs.unlinkSync(PID_FILE);}catch{}});
}
