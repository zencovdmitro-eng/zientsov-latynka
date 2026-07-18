'use strict';

const fs = require('fs');
const path = require('path');
const {DatabaseSync} = require('node:sqlite');

const root = __dirname;
const sourceDir = path.join(root, 'node_modules', 'dictionary-uk');
const appSource = path.join(root, 'dist', 'payload', 'app', 'source');
const appData = path.join(root, 'dist', 'payload', 'app', 'data');
fs.mkdirSync(appSource, {recursive: true});
fs.mkdirSync(appData, {recursive: true});
fs.copyFileSync(path.join(sourceDir, 'index.aff'), path.join(appSource, 'index.aff'));
fs.copyFileSync(path.join(sourceDir, 'index.dic'), path.join(appSource, 'index.dic'));

const map={а:'a',б:'b',в:'v',г:'h',ґ:'g',д:'d',е:'e',є:'je',ж:'ž',з:'z',и:'y',і:'i',ї:'ji',й:'j',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'ch',ц:'c',ч:'č',ш:'š',щ:'šč',ь:'ʹ',ю:'ju',я:'ja'};
const soft={'ць':'ć','дь':'ď','ль':'ľ','нь':'ň','рь':'ŕ','сь':'ś','ть':'ť','зь':'ź'};
const ambiguous=new Set(['йа','йе','йі','йу','цг','шч']);
function convert(text){let out='';for(let i=0;i<text.length;){const ch=text[i],low=ch.toLowerCase(),pair=i+1<text.length?low+text[i+1].toLowerCase():'';let value;if(soft[pair]){value=soft[pair];i+=2;}else if(ambiguous.has(pair)){value=map[low]+'·'+map[text[i+1].toLowerCase()];i+=2;}else{value=map[low]||ch;i++;}out+=ch!==ch.toLowerCase()?value[0].toUpperCase()+value.slice(1):value;}return out;}
function entry(line){let value=line.split('\t',1)[0],slash=-1,escaped=false;for(let i=0;i<value.length;i++){if(value[i]==='\\'){escaped=!escaped;continue;}if(value[i]==='/'&&!escaped){slash=i;break;}escaped=false;}if(slash>=0)value=value.slice(0,slash);return value.replace(/\\\//g,'/');}
const lines=fs.readFileSync(path.join(sourceDir,'index.dic'),'utf8').split(/\r?\n/);lines.shift();
const words=[...new Set(lines.filter(Boolean).map(entry))].sort((a,b)=>a.localeCompare(b,'uk'));
const dbPath=path.join(appData,'zientsov_latynka_slovnyk.sqlite3');if(fs.existsSync(dbPath))fs.unlinkSync(dbPath);
const db=new DatabaseSync(dbPath);db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; CREATE TABLE words(id INTEGER PRIMARY KEY,latin TEXT NOT NULL,cyrillic TEXT NOT NULL,latin_fold TEXT NOT NULL,cyrillic_fold TEXT NOT NULL); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
const insert=db.prepare('INSERT INTO words(latin,cyrillic,latin_fold,cyrillic_fold) VALUES(?,?,?,?)');db.exec('BEGIN');for(const cyrillic of words){const latin=convert(cyrillic);insert.run(latin,cyrillic,latin.toLowerCase(),cyrillic.toLowerCase());}db.exec('COMMIT; CREATE INDEX words_latin_fold ON words(latin_fold); CREATE INDEX words_cyrillic_fold ON words(cyrillic_fold);');
const meta=db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)');for(const [key,value] of Object.entries({project:'ZIENTSOV LATYNKA',version:'0.4.12',release_id:'ZL-UA-2026-0004',unique_entries:String(words.length),author_legal:'Зєнцов Дмитро Володимирович',author_email:'zencovdmitro@gmail.com',license:'GPL-3.0'}))meta.run(key,value);db.close();console.log(`Створено ${words.length} словникових записів.`);
