'use strict';
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const root=path.resolve(process.argv[2]||path.join(__dirname,'..'));
const manifest=path.join(root,'MANIFEST.sha256');
if(!fs.existsSync(manifest)){console.error('ПОМИЛКА: файл MANIFEST.sha256 відсутній');process.exit(1);}
let checked=0,errors=[];
for(const line of fs.readFileSync(manifest,'utf8').split(/\r?\n/)){
  if(!line)continue;
  const match=line.match(/^([0-9a-f]{64})  (.+)$/);
  if(!match){errors.push('Некоректний рядок маніфесту');continue;}
  const file=path.join(root,...match[2].split('/'));
  if(!fs.existsSync(file)){errors.push(`Файл відсутній: ${match[2]}`);continue;}
  const actual=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if(actual!==match[1])errors.push(`Файл змінено: ${match[2]}`);
  checked++;
}
if(errors.length){console.error('ПЕРЕВІРКУ НЕ ПРОЙДЕНО');errors.forEach(x=>console.error(x));process.exit(1);}
console.log(`ПЕРЕВІРКУ ПРОЙДЕНО: ${checked} файлів відповідають випуску ZL-UA-2026-0003`);

