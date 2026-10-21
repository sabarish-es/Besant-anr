import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHub, HubError } from '../lib/hub-service';

const sqlite=new DatabaseSync(':memory:');
for(const name of readdirSync('drizzle').filter(n=>n.endsWith('.sql')).sort())
  sqlite.exec(readFileSync(`drizzle/${name}`,'utf8').replaceAll('--> statement-breakpoint',''));
class Prepared {
  constructor(public sql:string,public args:any[]=[]){ }
  bind(...a:any[]){return new Prepared(this.sql,a)}
  async first(){return sqlite.prepare(this.sql).get(...this.args)||null}
  async all(){return {results:sqlite.prepare(this.sql).all(...this.args)}}
  async run(){return {meta:{changes:Number(sqlite.prepare(this.sql).run(...this.args).changes)}}}
}
const db={prepare:(sql:string)=>new Prepared(sql), async batch(q:Prepared[]){sqlite.exec('BEGIN');try{for(const item of q)await item.run();sqlite.exec('COMMIT')}catch(e){sqlite.exec('ROLLBACK');throw e}}} as unknown as D1Database;
let time=Date.parse('2026-10-12T08:25:00Z'); // 13:55 IST, Monday
const hub=createHub(db,{now:()=>time});
const admin={userId:'owner',email:'owner@test.example',displayName:'Owner'};
const trainer={userId:'teacher',email:'trainer@test.example',displayName:'Trainer'};
const other={userId:'other',email:'other@test.example',displayName:'Other'};
const create=async(kind:string,data:any)=>(await hub.act(admin,{op:'create',kind,data})).id as string;
const rejects=async (f:()=>Promise<any>,status:number)=>assert.rejects(f,(e:any)=>e instanceof HubError && e.status===status);
await hub.act(admin,{op:'setup',name:'Session Demo'});
const branch=await create('branches',{name:'Chennai',address:'Test'});
const course=await create('courses',{name:'Python',duration:5});
const t=await create('trainers',{name:'Trainer',email:trainer.email,trainerId:'TRN-1',specialty:'Python',status:'Active'});
const t2=await create('trainers',{name:'Other',email:other.email,trainerId:'TRN-2',specialty:'Web',status:'Active'});
const batch=await create('batches',{name:'PY-01',courseId:course,trainerId:t,branchId:branch,startDate:'2026-10-12',endDate:'2026-10-14',dailyStartTime:'14:00',dailyEndTime:'16:00',status:'Active'});
const student=await create('students',{name:'Student',email:'s@test.example',studentId:'STUDENT-12345',batchId:batch,courseId:course,status:'Active'});
const schedules=(await hub.bootstrap(trainer)).data!.records.filter(r=>r.kind==='schedules');
assert.equal(schedules.length,3);
const session=schedules.find(r=>r.data.batchDay==='2026-10-12')!;
assert.ok(session);
assert.equal(session.data.startAt,'2026-10-12T08:30:00.000Z');
assert.equal(session.data.endAt,'2026-10-12T10:30:00.000Z');
assert.ok(session.data.roster.includes(student));
await rejects(()=>hub.act(other,{op:'openSession',id:session.id}),403);
const started=await hub.act(trainer,{op:'openSession',id:session.id});
assert.equal(started.schedule.data.sessionStatus,'In Progress');
assert.equal(started.schedule.data.actualStartAt,new Date(time).toISOString());
await rejects(()=>hub.act(trainer,{op:'openSession',id:session.id}),409);
const extensions=await Promise.all([hub.act(trainer,{op:'extendSession',id:session.id,minutes:15,requestId:crypto.randomUUID()}),hub.act(trainer,{op:'extendSession',id:session.id,minutes:30,requestId:crypto.randomUUID()})]);
assert.equal(extensions.length,2);
let stored=JSON.parse((sqlite.prepare('SELECT data FROM records WHERE id=?').get(session.id) as any).data);
assert.equal(stored.extensionMinutes,45);
assert.equal(stored.extensions.length,2);
const repeatedId=crypto.randomUUID();
const firstCall=hub.act(trainer,{op:'extendSession',id:session.id,minutes:15,requestId:repeatedId});
const secondCall=hub.act(trainer,{op:'extendSession',id:session.id,minutes:15,requestId:repeatedId});
const outcomes=await Promise.allSettled([firstCall,secondCall]);
assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
assert.equal(outcomes.filter(o=>o.status==='rejected').length,1);
assert.equal(JSON.parse((sqlite.prepare('SELECT data FROM records WHERE id=?').get(session.id) as any).data).effectiveDeadline,'2026-10-12T11:30:00.000Z');
time=Date.parse('2026-10-12T11:29:00Z');
assert.equal(await hub.closeExpiredSessions(),0);
time=Date.parse('2026-10-12T11:31:00Z');
assert.equal(await hub.closeExpiredSessions(),1);
assert.equal(await hub.closeExpiredSessions(),0);
stored=JSON.parse((sqlite.prepare('SELECT data FROM records WHERE id=?').get(session.id) as any).data);
assert.equal(stored.sessionStatus,'Auto-Closed');
assert.equal(stored.actualEndAt,'2026-10-12T11:30:00.000Z');
await rejects(()=>hub.act(trainer,{op:'extendSession',id:session.id,minutes:15,requestId:crypto.randomUUID()}),409);
await rejects(()=>hub.act(trainer,{op:'closeSession',id:session.id}),409);
await rejects(()=>hub.act(trainer,{op:'forceDelete',kind:'courses',id:course,confirmation:'DELETE ALL RELATED DATA'}),403);
await rejects(()=>hub.act(admin,{op:'forceDelete',kind:'courses',id:course,confirmation:'DELETE'}),400);
const deletion=await hub.act(admin,{op:'forceDelete',kind:'courses',id:course,confirmation:'DELETE ALL RELATED DATA'});
assert.ok(deletion.deletedRecords>=5);
assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM attendance').get()!.n,0);
assert.equal((sqlite.prepare('SELECT status FROM members WHERE id=?').get(student) as any).status,'Inactive');
console.log('PASS admin-only confirmed cascading delete removes dependencies and deactivates affected students');
console.log('PASS session generation, trainer isolation, duplicate starts, concurrent extensions, cron auto-closure and terminal guards');
