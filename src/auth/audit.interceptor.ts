import { CallHandler,ExecutionContext,Inject,Injectable,Logger,NestInterceptor } from '@nestjs/common';
import { mergeMap } from 'rxjs';
import { Database } from '../db/database';
import { AuthRequest } from './auth.service';
@Injectable()
export class AuditInterceptor implements NestInterceptor {
 constructor(@Inject(Database) readonly db:Database){}
 intercept(context:ExecutionContext,next:CallHandler){const req=context.switchToHttp().getRequest<AuthRequest>();if(!req.actor||['GET','HEAD','OPTIONS'].includes(req.method))return next.handle();return next.handle().pipe(mergeMap(async value=>{try{await this.db.query('INSERT INTO audit_log(actor_id,actor_name,action,resource) VALUES($1,$2,$3,$4)',[req.rootKey?null:req.actor!.id,req.actor!.email,req.method,req.path]);}catch{Logger.warn('An admin action completed but its audit entry could not be saved','Audit');}return value;}));}
}
