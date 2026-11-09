import { Database } from './database';
export async function migrate(){const db=new Database();try{await db.ready();console.log('MongoDB collections and indexes are ready');}finally{await db.onModuleDestroy();}}
if(process.argv[1]?.includes('migrate'))migrate().catch(error=>{console.error(error);process.exitCode=1;});
