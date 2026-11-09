import { ArgumentsHost,Catch,ExceptionFilter,Logger } from '@nestjs/common';
import { Response } from 'express';
import { MongoServerError } from 'mongodb';
@Catch(MongoServerError)
export class DatabaseErrorsFilter implements ExceptionFilter {
 private readonly logger=new Logger(DatabaseErrorsFilter.name);
 catch(error:MongoServerError,host:ArgumentsHost){const response=host.switchToHttp().getResponse<Response>(),conflict=error.code===11000;this.logger.error(`MONGO_${error.code??'ERROR'}: ${error.message}`);response.status(conflict?409:500).json({statusCode:conflict?409:500,message:conflict?'A record with that value already exists.':'The database request could not be completed.'});}
}
