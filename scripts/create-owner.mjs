import 'dotenv/config';
import { Pool } from 'pg';
import { randomBytes,scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
const prompt=createInterface({input:process.stdin,output:process.stdout});
const pool=new Pool({connectionString:process.env.DATABASE_URL});
try{
 const email=(await prompt.question('Owner email: ')).trim().toLowerCase();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Enter a valid email');
 const name=(await prompt.question('Owner name: ')).trim()||'Workspace owner';
 const password=randomBytes(18).toString('base64url');const salt=randomBytes(16).toString('hex');
 const encoded=`scrypt$${salt}$${scryptSync(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024}).toString('hex')}`;
 const client=await pool.connect();
 try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(4182602)');
  const existing=(await client.query('SELECT id FROM workspace_users WHERE email=$1',[email])).rows[0];
  if(existing){
   if(!process.argv.includes('--reset'))throw new Error('Account exists. Use owner:reset for deliberate recovery.');
   await client.query("UPDATE workspace_users SET name=$2,role='owner',password_hash=$3,must_change_password=true,disabled_at=NULL WHERE id=$1",[existing.id,name,encoded]);await client.query('DELETE FROM user_sessions WHERE user_id=$1',[existing.id]);
  }else{
   if((await client.query("SELECT 1 FROM workspace_users WHERE role='owner' AND disabled_at IS NULL")).rowCount&&!process.argv.includes('--reset'))throw new Error('An owner exists. Add teammates through the application.');
   await client.query("INSERT INTO workspace_users(email,name,role,password_hash,must_change_password) VALUES($1,$2,'owner',$3,true)",[email,name,encoded]);
  }
  await client.query("INSERT INTO audit_log(actor_name,action,resource) VALUES($1,'owner_cli_setup','account')",[email]);await client.query('COMMIT');
  console.log(`Owner account ready: ${email}\nTemporary password (shown once): ${password}\nSign in and choose a new password. Store this securely.`);
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}catch(error){console.error(error instanceof Error?error.message:'Owner setup failed');process.exitCode=1;}
finally{prompt.close();await pool.end();}
