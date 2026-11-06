import { BadRequestException,ConflictException,ForbiddenException,HttpException,Inject,Injectable,UnauthorizedException } from '@nestjs/common';
import { createHash,randomBytes,timingSafeEqual } from 'node:crypto';
import type { Request,Response } from 'express';
import { Database } from '../db/database';
import { config } from '../config';
import { hashPassword,verifyPassword } from './password';
export type Actor={id:string;name:string;email:string;role:'owner'|'editor'|'analyst';mustChangePassword:boolean;sessionId?:string};
export type AuthRequest=Request&{actor?:Actor;rootKey?:boolean};
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const dummy=`scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`;
@Injectable()
export class AuthService {
 constructor(@Inject(Database) readonly db:Database){}
 private cookieOptions(){return {httpOnly:true,sameSite:'strict' as const,secure:new URL(config.PUBLIC_API_URL).protocol==='https:',path:'/api',maxAge:7*24*60*60*1000};}
 token(req:Request){const cookie=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('dispatch_session='))?.slice(17);return cookie&&/^[a-f0-9]{64}$/.test(cookie)?cookie:null;}
 async current(req:AuthRequest){
  const token=this.token(req);if(!token)throw new UnauthorizedException('Sign in to continue');
  const row=(await this.db.query(`SELECT u.id,u.email,u.name,u.role,u.must_change_password,s.id session_id,s.csrf_token,s.created_at session_created_at
   FROM user_sessions s JOIN workspace_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.disabled_at IS NULL`,[digest(token)])).rows[0];
  if(!row)throw new UnauthorizedException('Your session has expired. Sign in again.');
  const actor:Actor={id:row.id,email:row.email,name:row.name,role:row.role,mustChangePassword:row.must_change_password,sessionId:row.session_id};req.actor=actor;
  void this.db.query("UPDATE user_sessions SET last_seen_at=now() WHERE id=$1 AND last_seen_at<now()-interval '1 minute'",[row.session_id]).catch(()=>{});
  return {user:actor,csrfToken:row.csrf_token};
 }
 csrf(req:Request,expected:string){const value=req.headers['x-dispatch-csrf'];if(typeof value!=='string'||!timingSafeEqual(Buffer.from(digest(value),'hex'),Buffer.from(digest(expected),'hex')))throw new ForbiddenException('Refresh the page and try again');}
 private async loginLimit(key:string){const result=await this.db.query(`INSERT INTO public_rate_limits(key,expires_at) VALUES($1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN public_rate_limits.expires_at<now() THEN 1 ELSE public_rate_limits.count+1 END,expires_at=CASE WHEN public_rate_limits.expires_at<now() THEN now()+interval '15 minutes' ELSE public_rate_limits.expires_at END WHERE public_rate_limits.expires_at<now() OR public_rate_limits.count<10 RETURNING key`,[digest(key)]);if(!result.rowCount)throw new HttpException('Too many sign-in attempts. Try again in 15 minutes.',429);}
 async login(email:string,password:string,req:Request,res:Response){
  const origin=req.headers.origin;if(origin){const allowed=[config.FRONTEND_ORIGIN,config.PUBLIC_API_URL].map(u=>new URL(u).origin);const loopback=(h:string)=>['localhost','127.0.0.1','::1','[::1]'].includes(h);let ok=allowed.includes(origin);if(!ok)try{const o=new URL(origin);ok=allowed.some(a=>{const u=new URL(a);return u.protocol===o.protocol&&u.port===o.port&&loopback(u.hostname)&&loopback(o.hostname);});}catch{}if(!ok)throw new ForbiddenException();}
  await this.loginLimit(`login-ip:${req.ip}`);await this.loginLimit(`login-email:${email}`);
  const user=(await this.db.query('SELECT * FROM workspace_users WHERE email=$1 AND disabled_at IS NULL',[email])).rows[0];
  if(!await verifyPassword(password,user?.password_hash??dummy)||!user)throw new UnauthorizedException('Email or password is incorrect');
  const token=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
  await this.db.transaction(async c=>{
   await c.query("DELETE FROM user_sessions WHERE expires_at<now() OR user_id=$1 AND id NOT IN(SELECT id FROM user_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 9)",[user.id]);
   await c.query("INSERT INTO user_sessions(user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '7 days')",[user.id,digest(token),csrf]);
   await c.query('UPDATE workspace_users SET last_login_at=now() WHERE id=$1',[user.id]);
   await c.query("INSERT INTO audit_log(actor_id,actor_name,action,resource) VALUES($1,$2,'sign_in','account')",[user.id,user.email]);
  });
  res.cookie('dispatch_session',token,this.cookieOptions());
  return {user:{id:user.id,email:user.email,name:user.name,role:user.role,mustChangePassword:user.must_change_password} as Actor,csrfToken:csrf};
 }
 async logout(req:AuthRequest,res:Response){const token=this.token(req);if(token){const session=await this.current(req).catch(()=>null);if(session)this.csrf(req,session.csrfToken);await this.db.query('DELETE FROM user_sessions WHERE token_hash=$1',[digest(token)]);}const {maxAge,...options}=this.cookieOptions();res.clearCookie('dispatch_session',options);return {ok:true};}
 async changePassword(req:AuthRequest,current:string,next:string){
  if(!req.actor||req.rootKey)throw new BadRequestException('Sign in with an account to change its password');
  const user=(await this.db.query('SELECT password_hash FROM workspace_users WHERE id=$1',[req.actor.id])).rows[0];
  if(!user||!await verifyPassword(current,user.password_hash))throw new ForbiddenException('Current password is incorrect');
  const passwordHash=await hashPassword(next);
  await this.db.transaction(async c=>{await c.query('UPDATE workspace_users SET password_hash=$2,must_change_password=false WHERE id=$1',[req.actor!.id,passwordHash]);await c.query('DELETE FROM user_sessions WHERE user_id=$1 AND id<>$2',[req.actor!.id,req.actor!.sessionId]);});
  return {...req.actor,mustChangePassword:false};
 }
 async users(){return (await this.db.query('SELECT id,email,name,role,must_change_password,disabled_at,created_at,last_login_at FROM workspace_users ORDER BY created_at')).rows;}
 async createUser(email:string,name:string,role:string){const password=randomBytes(18).toString('base64url');const hash=await hashPassword(password);const row=(await this.db.query('INSERT INTO workspace_users(email,name,role,password_hash,must_change_password) VALUES($1,$2,$3,$4,true) RETURNING id,email,name,role',[email,name,role,hash])).rows[0];return {...row,temporaryPassword:password};}
 async changeUser(id:string,role:string,disabled:boolean,actor?:Actor){return this.db.transaction(async c=>{
  const owners=(await c.query("SELECT id FROM workspace_users WHERE role='owner' AND disabled_at IS NULL FOR UPDATE")).rows;
  const user=(await c.query('SELECT * FROM workspace_users WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!user)throw new BadRequestException('Account not found');
  if(user.role==='owner'&&!user.disabled_at&&(role!=='owner'||disabled)&&owners.length<=1)throw new ConflictException('Keep at least one active workspace owner');
  if(actor?.id===id&&disabled)throw new ConflictException('You cannot disable your own account');
  await c.query('UPDATE workspace_users SET role=$2,disabled_at=CASE WHEN $3::boolean THEN COALESCE(disabled_at,now()) ELSE NULL END WHERE id=$1',[id,role,disabled]);if(disabled)await c.query('DELETE FROM user_sessions WHERE user_id=$1',[id]);return {ok:true};
 });}
 async resetPassword(id:string){const password=randomBytes(18).toString('base64url');const hash=await hashPassword(password);return this.db.transaction(async c=>{if(!(await c.query('UPDATE workspace_users SET password_hash=$2,must_change_password=true WHERE id=$1 RETURNING id',[id,hash])).rowCount)throw new BadRequestException('Account not found');await c.query('DELETE FROM user_sessions WHERE user_id=$1',[id]);return {temporaryPassword:password};});}
}
