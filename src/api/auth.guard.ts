import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { AuthRequest,AuthService } from '../auth/auth.service';
@Injectable()
export class ApiKeyGuard implements CanActivate {
 constructor(@Inject(AuthService) readonly auth:AuthService){}
 async canActivate(context: ExecutionContext) {
  const req=context.switchToHttp().getRequest<AuthRequest>();const key=req.headers['x-api-key'];
  if(typeof key==='string'&&timingSafeEqual(createHash('sha256').update(key).digest(),createHash('sha256').update(config.API_KEY).digest())){req.rootKey=true;req.actor={id:'workspace-key',name:'Workspace key',email:'workspace-key',role:'owner',mustChangePassword:false};return true;}
  const session=await this.auth.current(req);let path:string;try{path=decodeURIComponent(req.path).replace(/\/+/g,'/').toLowerCase();}catch{throw new ForbiddenException('Invalid request path');}const accountRoute=/^\/api\/v1\/manage\/account(\/|$)/.test(path);
  if(session.user.mustChangePassword&&!accountRoute)throw new ForbiddenException('Change your temporary password before continuing');
  if(!['GET','HEAD','OPTIONS'].includes(req.method))this.auth.csrf(req,session.csrfToken);
  const ownerOnly=/^\/api\/v1\/manage\/(users|keys|audit)(\/|$)/.test(path)||(!['GET','HEAD'].includes(req.method)&&/^\/api\/v1\/manage\/(settings|domains|integrations)(\/|$)/.test(path));
  if(ownerOnly&&session.user.role!=='owner')throw new ForbiddenException('This action requires a workspace owner');
  if(session.user.role==='analyst'&&!['GET','HEAD','OPTIONS'].includes(req.method)&&!accountRoute)throw new ForbiddenException('Your account has read-only access');
  return true;
 }
}
