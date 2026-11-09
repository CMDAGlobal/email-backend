const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {createHmac}=require('node:crypto');
const key='http-test-admin-key-'.padEnd(64,'x');
const secret='http-test-signing-key-'.padEnd(64,'y');
const base='http://127.0.0.1:3099';
let server;

function startFixtureServer(){
 const {Database}=require('./dist/db/database');
 Database.prototype.ready=async function(){};
 Database.prototype.onModuleInit=async function(){};
 Database.prototype.onModuleDestroy=async function(){};
 Database.prototype.workspaceSettings=async function(){return {};};
 Database.prototype.collection=function(name){return {
  findOne:async filter=>name==='contacts'&&filter.id?{id:filter.id,email:'recipient@example.test'}:null,
  find:()=>({sort:()=>({toArray:async()=>[]}),toArray:async()=>[]})
 };};
 Database.prototype.transaction=async function(){
  throw new Error('Unexpected fixture database transaction');
 };
 require('./dist/main');
}

before(async()=>{
 server=spawn(process.execPath,['-e',`(${startFixtureServer.toString()})()`],{cwd:require('node:path').resolve(__dirname,'..'),env:{...process.env,NODE_ENV:'test',PORT:'3099',MONGODB_URI:'mongodb://127.0.0.1:1/dispatch?serverSelectionTimeoutMS=50',MONGODB_DATABASE:'dispatch_http_fixture',FRONTEND_ORIGIN:'http://localhost:5173',PUBLIC_API_URL:base,API_KEY:key,UNSUBSCRIBE_SECRET:secret,SEND_MODE:'dry-run',SES_FROM_EMAIL:'test@example.com',WORKER_ENABLED:'false',RUN_MIGRATIONS_ON_BOOT:'false',CMDA_ENABLED:'false'},stdio:'ignore'});
 for(let i=0;i<100;i++){
  try{if((await fetch(base+'/health')).ok)return;}catch{}
  await new Promise(r=>setTimeout(r,100));
 }
 throw Error('HTTP test server failed to start');
});
after(()=>server?.kill());
test('liveness is public and admin endpoints reject missing or invalid keys',async()=>{
 assert.equal((await fetch(base+'/health')).status,200);
 assert.equal((await fetch(base+'/api/v1/contacts')).status,401);
 assert.equal((await fetch(base+'/api/v1/contacts',{headers:{'X-API-Key':'wrong'}})).status,401);
});
test('malformed send IDs and invalid bodies are rejected before database access',async()=>{
 const headers={'X-API-Key':key,'Content-Type':'application/json'};
 assert.equal((await fetch(base+'/api/v1/campaigns/not-a-uuid/send',{method:'POST',headers,body:'{}'})).status,400);
 assert.equal((await fetch(base+'/api/v1/contacts',{method:'POST',headers,body:JSON.stringify({email:'invalid',consentSource:'signup'})})).status,400);
 assert.equal((await fetch(base+'/api/v1/contacts?limit=100000',{headers})).status,400);
 assert.equal((await fetch(base+'/api/v1/templates',{method:'POST',headers,body:JSON.stringify({name:'bad',subject:'Hello\r\nBcc: bad@example.com',html:'<p>Hi</p>'})})).status,400);
});
test('unsubscribe GET validates signed links and renders a confirmation without database writes',async()=>{
 const id='c2337c12-45e4-4273-90ca-43562b63d7c9';
 assert.equal((await fetch(`${base}/unsubscribe/${id}?token=bad`)).status,400);
 const token=createHmac('sha256',secret).update(id).digest('hex');
 const response=await fetch(`${base}/unsubscribe/${id}?token=${token}`);
 assert.equal(response.status,200);
 const html=await response.text();
 assert.match(html,/Update your email preferences/);
 assert.match(html,/recipient@example\.test/);
 assert.match(html,/Unsubscribe from everything/);
 assert.equal(response.headers.get('cache-control'),'no-store');
});
