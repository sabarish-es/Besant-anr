import { useState } from 'react';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import type { HubData, Row } from '../lib/hub-types';

/** Shared by the Student course page and Admin's View Student dialog. */
export function subcourseStatus(data: HubData, studentId: string, module: Row): 'Completed'|'Ongoing'|'Pending' {
  const record = data.records.find(r => r.kind === 'module-progress' && r.data.studentId===studentId && r.data.subcourseId===module.id);
  if(record?.data.status==='Completed') return 'Completed';
  const batchIds = new Set(data.records.filter(r => r.kind==='batches' && r.data.subcourseId===module.id).map(r=>r.id));
  const sessionIds = new Set(data.records.filter(r=>r.kind==='schedules' && batchIds.has(r.data.batchId)).map(r=>r.id));
  if(record?.data.status==='Ongoing' || data.attendance.some(a=>a.memberId===studentId && ['Present','Late'].includes(a.status) && sessionIds.has(a.scheduleId))) return 'Ongoing';
  return 'Pending';
}

export function studentCourseIds(data:HubData,studentId:string):Set<string> {
  const ids=new Set<string>();
  const student=data.members.find(m=>m.id===studentId && m.role==='student');
  if(student?.data.courseId) ids.add(student.data.courseId);
  for(const enrollment of data.records.filter(r=>r.kind==='enrollments' && r.data.studentId===studentId && r.data.status==='Active')) ids.add(enrollment.data.courseId);
  return ids;
}

export function StudentProgressDetails({data,studentId,saving,onComplete}:{
  data:HubData;studentId:string;saving:boolean;
  onComplete:(subcourseId:string,note:string)=>Promise<boolean>;
}) {
  const [notes,setNotes]=useState<Record<string,string>>({});
  const enrolled=studentCourseIds(data,studentId);
  const courses=data.records.filter(r=>r.kind==='courses'&&enrolled.has(r.id));
  if(!courses.length)return <p>No enrolled courses found for this student.</p>;
  return <section className="student-progress-details" aria-label="Student course progress">
    <h3>Individual course progress</h3>
    {courses.map(course=>{
      const modules=data.records.filter(m=>m.kind==='subcourses'&&m.data.courseId===course.id);
      const completed=modules.filter(m=>subcourseStatus(data,studentId,m)==='Completed').length;
      return <div key={course.id} className="student-progress-course">
        <strong>{course.data.name} — {modules.length?Math.round(completed/modules.length*100):0}% completed</strong>
        {!modules.length?<p>No subcourses created yet.</p>:modules.map(module=>{
          const state=subcourseStatus(data,studentId,module);
          return <div key={module.id} className="student-progress-module">
            <div className="student-progress-module-heading"><span>{module.data.name}</span><span className={`student-progress-state ${state.toLowerCase()}`}>{state}</span></div>
            {state!=='Completed'&&<div className="student-progress-actions">
              <Textarea value={notes[module.id]||''} onChange={e=>setNotes(p=>({...p,[module.id]:e.target.value}))}
                placeholder="Assessment / learning evidence (minimum 12 characters)" aria-label={`Completion evidence for ${module.data.name}`} rows={2}/>
              <Button type="button" size="sm" disabled={saving||(notes[module.id]||'').trim().length<12}
                onClick={async()=>{if(await onComplete(module.id,notes[module.id]))setNotes(p=>({...p,[module.id]:''}));}}>Mark Completed</Button>
            </div>}
          </div>;
        })}
      </div>;
    })}
  </section>;
}
