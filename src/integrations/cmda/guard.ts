import { CanActivate,ConflictException,ExecutionContext,Inject,Injectable,ServiceUnavailableException,UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import { Database } from '../../db/database';
import { config } from '../../config';
import { validSignature } from './protocol';
@Injectable()
export class CmdaSyncGuard implements CanActivate {
 constructor(@Inject(Database) readonly db:Database){}
 async canActivate(context:ExecutionContext){if(!config.CMDA_ENABLED||!config.CMDA_SYNC_SECRET)throw new ServiceUnavailableException('CMDA connector is disabled');const req=context.switchToHttp().getRequest();const nonce=req.headers['x-cmda-nonce'];if(!z.uuid().safeParse(nonce).success||!validSignature(config.CMDA_SYNC_SECRET,req.headers['x-cmda-timestamp'],nonce,req.headers['x-cmda-signature'],req.body))throw new UnauthorizedException('Invalid integration signature');const inserted=await this.db.query("INSERT INTO cmda_request_nonces(id,expires_at) VALUES($1,now()+interval '10 minutes') ON CONFLICT DO NOTHING RETURNING id",[nonce]);if(!inserted.rowCount)throw new ConflictException('Integration request was already received');return true;}
}
