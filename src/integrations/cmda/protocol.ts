import { createHash,createHmac,randomUUID,timingSafeEqual } from 'node:crypto';
export function canonical(value:unknown):string {
 if(value===null||typeof value!=='object')return JSON.stringify(value)??'null';
 if(Array.isArray(value))return '['+value.map(v=>canonical(v===undefined?null:v)).join(',')+']';
 const object=value as Record<string,unknown>;
 return '{'+Object.keys(object).filter(k=>object[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(object[k])).join(',')+'}';
}
export const bodyHash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
export function signature(secret:string,timestamp:string,nonce:string,body:unknown){return createHmac('sha256',secret).update(`${timestamp}.${nonce}.${canonical(body)}`).digest('hex');}
export function signedHeaders(secret:string,body:unknown){const timestamp=String(Math.floor(Date.now()/1000));const nonce=randomUUID();return {'Content-Type':'application/json','X-CMDA-Timestamp':timestamp,'X-CMDA-Nonce':nonce,'X-CMDA-Signature':signature(secret,timestamp,nonce,body)};}
export function validSignature(secret:string,timestamp:unknown,nonce:unknown,mac:unknown,body:unknown){if(typeof timestamp!=='string'||!/^\d{10}$/.test(timestamp)||Math.abs(Date.now()/1000-Number(timestamp))>300||typeof nonce!=='string'||!/^[a-f0-9-]{36}$/.test(nonce)||typeof mac!=='string'||!/^[a-f0-9]{64}$/.test(mac))return false;return timingSafeEqual(Buffer.from(mac,'hex'),Buffer.from(signature(secret,timestamp,nonce,body),'hex'));}
