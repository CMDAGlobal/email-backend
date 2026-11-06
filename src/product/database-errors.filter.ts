import { ArgumentsHost,Catch,ExceptionFilter } from '@nestjs/common';
import { Response } from 'express';
import { DatabaseError } from 'pg';
@Catch(DatabaseError)
export class DatabaseErrorsFilter implements ExceptionFilter {
 catch(error:DatabaseError,host:ArgumentsHost){const response=host.switchToHttp().getResponse<Response>();const conflict=['23505','23503'].includes(error.code??'');response.status(conflict?409:500).json({statusCode:conflict?409:500,message:error.code==='23505'?'A record with that value already exists.':error.code==='23503'?'This record is still referenced or a related record no longer exists.':'The database request could not be completed.'});}
}
