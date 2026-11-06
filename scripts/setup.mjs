import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const template=await readFile(new URL('../.env.example',import.meta.url),'utf8');
const result=template.replace('replace-with-at-least-32-random-characters',randomBytes(32).toString('hex')).replace('replace-with-a-different-32-character-secret',randomBytes(32).toString('hex'));
try { await writeFile(new URL('../.env',import.meta.url),result,{flag:'wx'});console.log('Created .env with random secrets. Existing .env files are never overwritten.'); }
catch(error){if(error.code==='EEXIST')console.log('.env already exists; left unchanged.');else throw error;}
