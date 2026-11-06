import { randomBytes,scrypt,timingSafeEqual } from 'node:crypto';
const derive=(password:string,salt:string)=>new Promise<Buffer>((resolve,reject)=>scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024},(error,key)=>error?reject(error):resolve(key)));
export async function hashPassword(password:string){const salt=randomBytes(16).toString('hex');return `scrypt$${salt}$${(await derive(password,salt)).toString('hex')}`;}
export async function verifyPassword(password:string,encoded:string){
 const [algorithm,salt,hex]=encoded.split('$');if(algorithm!=='scrypt'||!/^[a-f0-9]{32}$/.test(salt??'')||!/^[a-f0-9]{128}$/.test(hex??''))return false;
 return timingSafeEqual(await derive(password,salt),Buffer.from(hex,'hex'));
}
