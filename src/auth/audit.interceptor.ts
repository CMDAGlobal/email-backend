import { CallHandler,ExecutionContext,Inject,Injectable,Logger,NestInterceptor } from '@nestjs/common';
import { mergeMap } from 'rxjs';
import { randomUUID } from 'node:crypto';
import { Database } from '../db/database';
import { AuthRequest } from './auth.service';
@Injectable()
export class AuditInterceptor implements NestInterceptor {
 constructor(@Inject(Database) readonly db:Database){}
 intercept(context:ExecutionContext,next:CallHandler){const req=context.switchToHttp().getRequest<AuthRequest>();if(!req.actor||['GET','HEAD','OPTIONS'].includes(req.method))return next.handle();return next.handle().pipe(mergeMap(async value=>{try{await this.db.collection('audit_log').insertOne({id:randomUUID(),actor_id:req.rootKey?null:req.actor!.id,actor_name:req.actor!.email,action:req.method,resource:req.path,details:{},created_at:new Date()});}catch{Logger.warn('An admin action completed but its audit entry could not be saved','Audit');}return value;}));}
}
