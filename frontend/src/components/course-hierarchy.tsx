import { BookOpen, Plus, Pencil, Trash2, Layers } from 'lucide-react';
import { Button } from './ui/button';
import type { HubData, Row } from '../lib/hub-types';
import { subcourseStatus } from './student-progress';

/** Data comes exclusively from the role-filtered /api/hub response. */
export function CourseHierarchy({ data, admin, onAddSubcourse, onEdit, onDelete }: {
  data: HubData;
  admin: boolean;
  onAddSubcourse: (courseId: string) => void;
  onEdit: (row: Row) => void;
  onDelete: (row: Row) => void;
}) {
  const courses = data.records.filter(r => r.kind === 'courses');
  const modules = data.records.filter(r => r.kind === 'subcourses');
  const progress = data.records.filter(r => r.kind === 'module-progress');
  const batches = data.records.filter(r => r.kind === 'batches');
  const sessions = data.records.filter(r => r.kind === 'schedules');
  const statusOf = (m: Row) => subcourseStatus(data,data.me.id,m);
  return <section className="course-management" aria-label="Courses and subcourses">
    {!courses.length ? <div className="panel" style={{padding: 24}}>
      <h2>No enrolled courses</h2>
      <p>{admin ? 'Create a course, then add subcourses below it.' : 'Your assigned course information will appear here.'}</p>
    </div> : courses.map(course => {
      const children = modules.filter(m => m.data.courseId === course.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const completed = children.filter(m => statusOf(m)==='Completed').length;
      const completePercent = children.length ? Math.round(100 * completed / children.length) : 0;
      return <article className="panel" key={course.id} style={{padding: 20, marginBottom: 18}}>
        <div className="panel-heading" style={{alignItems: 'flex-start', gap: 12}}>
          <div>
            <h2><BookOpen size={19} style={{verticalAlign: 'middle', marginRight: 8}}/>{course.data.name}</h2>
            <p>{course.data.description || 'No course description yet.'}</p>
            <small>{course.data.duration} weeks · {course.data.status || 'Active'}</small>
          </div>
          {admin && <div style={{display:'flex', gap:8, flexWrap:'wrap'}}>
            <Button variant="outline" size="sm" onClick={() => onEdit(course)}><Pencil size={15}/>Edit course</Button>
            <Button variant="ghost" size="sm" onClick={() => onDelete(course)}><Trash2 size={15}/>Delete</Button>
          </div>}
        </div>
        {!admin && <div className="module-progress-summary"><strong>Learning progress: {completePercent}%</strong><span>{completed}/{children.length} modules completed{children.length && completed===children.length ? ' · Course completed' : ''}</span><div className="module-progress-track"><span style={{width:`${completePercent}%`}}/></div></div>}
        <div style={{display:'flex',justifyContent:'space-between', alignItems:'center',gap:12,marginBottom:12}}>
          <strong><Layers size={17} style={{verticalAlign:'middle', marginRight:6}}/>Subcourses ({children.length})</strong>
          {admin && <Button variant="outline" size="sm" onClick={() => onAddSubcourse(course.id)}><Plus size={15}/>Add subcourse</Button>}
        </div>
        {!children.length ? <p style={{opacity:.7}}>No subcourses added yet.</p> : <div className="course-module-list">
          {children.map(module => <div className="course-module" key={module.id}>
            <div>
              <strong>{module.data.name}</strong>{!admin && <span className="module-state">{statusOf(module)}</span>}
              <div style={{fontSize:13,opacity:.75}}>{module.data.duration} weeks · {module.data.status || 'Active'}</div>
              {module.data.description && <p style={{margin:'6px 0'}}>{module.data.description}</p>}
              {module.data.syllabus && <p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}><strong>Syllabus/materials:</strong> {module.data.syllabus}</p>}
            </div>
            {admin && <div style={{display:'flex',gap:6}}>
              <Button size="sm" variant="ghost" onClick={() => onEdit(module)} aria-label={`Edit ${module.data.name}`}><Pencil size={15}/></Button>
              <Button size="sm" variant="ghost" onClick={() => onDelete(module)} aria-label={`Delete ${module.data.name}`}><Trash2 size={15}/></Button>
            </div>}
          </div>)}
        </div>}
      </article>;
    })}
  </section>;
}
