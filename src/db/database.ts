import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ClientSession, Collection, Document, MongoClient } from 'mongodb';
import { config } from '../config';

export type MongoContext = {collection<T extends Document = any>(name:string):Collection<T>};

@Injectable()
export class Database implements OnModuleInit,OnModuleDestroy,MongoContext {
 readonly client=new MongoClient(config.MONGODB_URI,{serverSelectionTimeoutMS:10000,retryWrites:true});
 readonly mongo=this.client.db(config.MONGODB_DATABASE,{readPreference:'primary',writeConcern:{w:'majority'}});
 private readyPromise?:Promise<void>;
 collection<T extends Document = any>(name:string){return this.mongo.collection<T>(name);}
 private sessionCollection<T extends Document=Document>(name:string,session:ClientSession):Collection<T>{
  const collection=this.collection<T>(name);const positions:Record<string,number>={find:1,findOne:1,insertOne:1,insertMany:1,updateOne:2,updateMany:2,replaceOne:2,deleteOne:1,deleteMany:1,findOneAndUpdate:2,findOneAndDelete:1,bulkWrite:1,countDocuments:1,distinct:2,aggregate:1};
  return new Proxy(collection as any,{get:(target,property)=>{const value=target[property];if(typeof property!=='string'||typeof value!=='function'||positions[property]===undefined)return typeof value==='function'?value.bind(target):value;return (...args:any[])=>{const position=positions[property];args[position]={...(args[position]??{}),session};return value.apply(target,args);};}}) as Collection<T>;
 }
 ready(){return this.readyPromise??=this.initialize();}
 private async initialize(){
  await this.client.connect();
  const indexes:Array<[string,Record<string,1|-1>,Record<string,unknown>?]>=[
   ['contacts',{email:1},{unique:true}],['contacts',{created_at:-1}],['lists',{name:1},{unique:true}],['lists',{integration:1},{name:'lists_integration_unique',unique:true,partialFilterExpression:{integration:{$type:'string'}}}],
   ['list_members',{list_id:1,contact_id:1},{unique:true}],['list_members',{contact_id:1}],['suppressions',{email:1},{unique:true}],['templates',{created_at:-1}],
   ['campaigns',{created_at:-1}],['messages',{status:1,created_at:1}],['messages',{campaign_id:1,contact_id:1},{unique:true,partialFilterExpression:{campaign_id:{$type:'string'}}}],
   ['messages',{source_key:1},{unique:true,sparse:true}],['messages',{provider_id:1},{sparse:true}],['ses_events',{id:1},{unique:true}],['email_events',{event_key:1},{unique:true}],['email_events',{message_id:1,type:1}],
   ['tracking_links',{message_id:1,url:1},{unique:true}],['api_keys',{key_hash:1},{unique:true}],['tags',{name:1},{unique:true}],['contact_tags',{contact_id:1,tag_id:1},{unique:true}],
   ['custom_fields',{key:1},{unique:true}],['automation_enrollments',{automation_id:1,contact_id:1},{unique:true}],['automation_enrollments',{status:1,due_at:1}],
   ['public_forms',{slug:1},{unique:true}],['form_submissions',{token_hash:1},{unique:true}],['workspace_users',{email:1},{unique:true}],['user_sessions',{token_hash:1},{unique:true}],
   ['user_sessions',{expires_at:1},{expireAfterSeconds:0}],['public_rate_limits',{expires_at:1},{expireAfterSeconds:0}],['public_rate_limits',{key:1},{unique:true}],['audit_log',{created_at:-1}],['cmda_members',{member_id:1},{unique:true}],['cmda_members',{contact_id:1},{unique:true}],
   ['cmda_contact_history',{contact_id:1},{unique:true}],['cmda_sync_receipts',{event_id:1},{unique:true}],['cmda_feedback_outbox',{event_key:1},{unique:true}],
   ['cmda_feedback_outbox',{sequence:1},{unique:true}],['cmda_request_nonces',{expires_at:1},{expireAfterSeconds:0}],['cmda_pending_triggers',{contact_id:1,trigger_type:1,trigger_id:1},{unique:true}],
  ];
  try{const legacy=(await this.collection('lists').listIndexes().toArray()).find(index=>index.name==='integration_1'&&index.sparse);if(legacy)await this.collection('lists').dropIndex('integration_1');}catch(error:any){if(error?.codeName!=='NamespaceNotFound')throw error;}
  for(const [name,key,options] of indexes)await this.collection(name).createIndex(key,options);
  await this.collection('workspace_settings').updateOne({id:true},{$setOnInsert:{id:true,data:{name:'My workspace',company:'',postalAddress:'',timezone:'Africa/Lagos',replyTo:'',trackingEnabled:false}}},{upsert:true});
  await this.collection('cmda_connector_state').updateOne({id:true},{$setOnInsert:{id:true,last_member_sync_at:null,last_feedback_delivery_at:null,last_feedback_error:null}},{upsert:true});
  await this.collection('counters').updateOne({id:'cmda_feedback_sequence'},{$setOnInsert:{id:'cmda_feedback_sequence',value:0}},{upsert:true});
 }
 async transaction<T>(fn:(context:MongoContext)=>Promise<T>):Promise<T>{
  await this.ready();const session=this.client.startSession();
  try{return await session.withTransaction(()=>fn({collection:<D extends Document>(name:string)=>this.sessionCollection<D>(name,session)}),{readPreference:'primary',readConcern:{level:'snapshot'},writeConcern:{w:'majority'}}) as T;}
  finally{await session.endSession();}
 }
 async workspaceSettings(){await this.ready();return (await this.collection('workspace_settings').findOne({id:true}))?.data??{};}
 async saveWorkspaceSettings(data:Record<string,unknown>){await this.ready();await this.collection('workspace_settings').updateOne({id:true},{$set:{data}},{upsert:true});}
 async onModuleInit(){await this.ready();}
 async onModuleDestroy(){await this.client.close();}
}
