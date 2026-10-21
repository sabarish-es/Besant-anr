import { useState } from 'react';
import { Download, FileSpreadsheet, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { readSpreadsheet } from '@/lib/excel-reader';
import type { HubData } from '@/lib/hub-types';
import { apiPost } from '@/lib/api';
import { parseImportGrid, detailsHeader, type StudentDetailsRow } from '@/lib/subcourse-progress-import';

export type Credential = {name:string;loginId:string;email:string;role:string;temporaryPassword:string};
export function downloadCsv(filename:string, rows:string[][]) {
  const csv=rows.map(row=>row.map(value=>{
    const safe=/^\s*[=+@-]/.test(String(value))?`'${value}`:String(value??'');
    return `"${safe.replaceAll('"','""')}"`;
  }).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);
}
const columns=['Name','Email','Phone','Student ID','Course','Status'];
function canonical(value:string) {return value.toLowerCase().trim().replace(/[^a-z0-9]/g,'');}
function findId(data:HubData,kind:string,value:string) {
  const matching=data.records.filter(r=>r.kind===kind&&(r.id.toLowerCase()===value.toLowerCase()||String(r.data.name).toLowerCase()===value.toLowerCase()));
  if (matching.length!==1) throw new Error(`Cannot find unique ${kind.slice(0,-1)}: ${value}`);
  return matching[0].id;
}
export function ImportStudents({data,onImported,onCredentials}: {data:HubData;onImported:()=>Promise<void>|void;onCredentials:(entries:Credential[])=>void}) {
  const [rows,setRows]=useState<Record<string,string>[]>([]);
  const [combinedRows,setCombinedRows]=useState<StudentDetailsRow[]>([]);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[progress,setProgress]=useState('');
  const prepare=async(file?:File)=>{
    if(!file)return;setRows([]);setCombinedRows([]);setError('');setProgress('');
    try{
      const grid=await readSpreadsheet(file);
      if(grid.length<2)throw new Error('The file needs a header row and at least one student.');
      const header=grid[0].map(v=>canonical(v||''));
      // Seven-column Student Details workbook combines account import and
      // per-module progress in a single Admin upload.
      if(header.includes('studentname') && header.includes('subcourse')) {
        const parsed=parseImportGrid(grid);
        if(parsed.mode!=='student-details') throw new Error('Expected the Student Details workbook.');
        const converted=parsed.rows as StudentDetailsRow[];
        for(const [index,r] of converted.entries()) {
          if(!r.name || !r.email || !r.studentId) throw new Error(`Row ${index+2}: Name, Email and Student ID are required.`);
        }
        setCombinedRows(converted);
        return;
      }
      for(const name of ['name','email','phone','studentid','course','status'])if(!header.includes(name))throw new Error(`Missing column: ${name}`);
      if(grid.length>1001)throw new Error('Import at most 1,000 students per file.');
      const mapped=grid.slice(1).filter(row=>row.some(v=>String(v||'').trim())).map((values,i)=>{
        const get=(key:string)=>String(values[header.indexOf(key)]||'').trim();
        try{
          const courseId=findId(data,'courses',get('course'));
          // Student imports no longer require a batch. Admin can assign one later.
          return {name:get('name'),email:get('email'),phone:get('phone'),studentId:get('studentid'),courseId,status:get('status')||'Active'};
        }catch(e){throw new Error(`Row ${i+2}: ${e instanceof Error?e.message:'Invalid data'}`);}
      });
      setRows(mapped);
    }catch(e){setError(e instanceof Error?e.message:'Could not read spreadsheet.');}
  };
  const upload=async()=>{
    if((!rows.length&&!combinedRows.length)||busy)return;setBusy(true);setError('');
    const credentials:Credential[]=[];let created=0;
    try{
      if(combinedRows.length){
        let matched=0, completed=0, ongoing=0, pending=0, reset=0;
        const warnings:string[]=[];
        for(let i=0;i<combinedRows.length;i+=10){
          setProgress(`Importing students and subcourse progress ${i+1}–${Math.min(i+10,combinedRows.length)} of ${combinedRows.length}…`);
          const result=await apiPost<{imported:number; created:{id:string;name:string;studentId:string;email:string}[]; existing:number; matchedByEmail:number; completed:number; ongoing:number; pending:number; resetCompletions:number}>(
            '/api/hub',{op:'importStudentsAndProgress',rows:combinedRows.slice(i,i+10)});
          created+=result.created.length;
          matched+=result.existing;
          completed+=result.completed; ongoing+=result.ongoing; pending+=result.pending; reset+=result.resetCompletions;
          for(const m of result.created){
            try{
              const account=await apiPost<{credential:Credential}>('/api/accounts',{memberId:m.id});
              credentials.push(account.credential);
            }catch(e){warnings.push(`${m.name}: ${e instanceof Error?e.message:'Login creation failed'}`);}
          }
        }
        setRows([]);setCombinedRows([]);
        setProgress(`Processed ${combinedRows.length} students: ${created} created, ${matched} existing. Modules: ${completed} Completed, ${ongoing} Ongoing, ${pending} Pending.${reset?` ${reset} previous completions replaced.`:''} Login credentials generated: ${credentials.length}.${warnings.length?` ${warnings.length} login(s) need retry in Account Logins.`:''}`);
        if(warnings.length) setError(`Student details and progress were saved, but login creation needs retry for: ${warnings.slice(0,4).join('; ')}${warnings.length>4?'…':''}`);
        return;
      }
      for(let i=0;i<rows.length;i+=50){
        setProgress(`Importing students ${i+1}–${Math.min(i+50,rows.length)} of ${rows.length}…`);
        const result=await apiPost<{imported:{id:string;name:string;studentId:string;email:string}[]}>('/api/hub',{op:'importStudents',rows:rows.slice(i,i+50)});
        created+=result.imported.length;
        for(const m of result.imported){
          if(rows.find(r=>r.studentId===m.studentId)?.status==='Inactive')continue;
          setProgress(`Generating account ${credentials.length+1} of ${created}…`);
          try{
            const account=await apiPost<{credential:Credential}>('/api/accounts',{memberId:m.id});
            credentials.push(account.credential);
          }catch(e){
            // Leave the profile, allow retry from Account Logins without duplicating the student.
            throw new Error(`Imported ${created} students but could not generate login for ${m.name}: ${e instanceof Error?e.message:'Auth unavailable'}. Retry from Account Logins.`);
          }
        }
      }
      setProgress(`Imported ${created} students and generated ${credentials.length} login credentials.`);setRows([]);
    }catch(e){setError(e instanceof Error?e.message:'Import failed.');}
    finally{if(credentials.length)onCredentials(credentials);await onImported();setBusy(false);}
  };
  return <section className="panel" style={{padding:20,marginBottom:16}}>
    <div className="panel-heading"><div><h2>Import students and completed subcourses</h2><p>One Excel upload can create students and update their module progress. Use the 7-column Student Details sheet, or the legacy six-column student list. Courses and subcourses must already exist in Admin.</p></div><FileSpreadsheet size={22}/></div>
    <div className="row-actions" style={{marginTop:12,flexWrap:'wrap'}}>
      <Button variant="outline" onClick={()=>downloadCsv('student-import-template.csv',[
        ['Name','Email','Phone','Student ID','Course','Status'],['Example Student','student@example.com','9000000000','STU001','Full Stack','Active']])}><Download size={16}/>Download template</Button>
      <Button variant="outline" onClick={()=>downloadCsv('student-details-combined-template.csv',[
        detailsHeader,
        ['Example Student','STUDENT-ID-001','FULL STACK PYTHON','Python, MySQL','student-demo@example.com','9000000000','Ongoing']
      ])}><Download size={16}/>Download combined template</Button>
      <Input type="file" accept=".xlsx,.csv" disabled={busy} aria-label="Upload student Excel file" onChange={e=>{void prepare(e.target.files?.[0]);e.target.value='';}} style={{maxWidth:300}}/>
      {(rows.length>0||combinedRows.length>0)&&<Button onClick={()=>void upload()} disabled={busy}>{busy&&<Loader2 className="animate-spin"/>}{combinedRows.length?`Import ${combinedRows.length} students + progress`:`Import ${rows.length} students & create logins`}</Button>}
    </div>
    {rows.length>0&&<p style={{marginTop:12}}><strong>Preview:</strong> {rows.length} student records ready. First: {rows[0].name} ({rows[0].studentId}). Check names, courses and emails before importing. Assign batches later under Students → Edit.</p>}
    {combinedRows.length>0&&<p style={{marginTop:12}}><strong>Combined preview:</strong> {combinedRows.length} students, {combinedRows.reduce((sum,r)=>sum+r.completedSubcourses.length,0)} listed subcourse completions. Unlisted modules start Pending (or Ongoing if attendance exists). Existing students will not be duplicated. Check all course/subcourse names before importing.</p>}
    {progress&&<p role="status" style={{marginTop:10}}>{progress}</p>}
    {error&&<div className="error-box" role="alert">{error}</div>}
    <small>The Student Details sheet's STATUS is an overall academic status; it does not complete any extra module. Existing students are matched by Student ID or by matching email and name. Unlisted modules follow attendance, replacing prior progress snapshots. Newly created accounts may need Supabase login generation; failed login creation can be retried in Account Logins. Students must change temporary passwords on first login. Imports can be partial between chunks.</small>
  </section>;
}
