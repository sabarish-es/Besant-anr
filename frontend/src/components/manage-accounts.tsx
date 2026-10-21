import { useState } from 'react';
import { LockKeyhole, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { apiPost } from '@/lib/api';
import type { HubData, Member } from '@/lib/hub-types';
import type { Credential } from './import-students';
export function ManageAccounts({data,onRefresh,onCredentials}: {data:HubData;onRefresh:()=>void;onCredentials:(entries:Credential[])=>void}) {
  const [search,setSearch]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const members=data.members.filter(m=>m.role!=='admin'&&m.status==='Active'&&`${m.name} ${m.email} ${m.data.studentId||m.data.trainerId||''}`.toLowerCase().includes(search.toLowerCase()));
  async function generate(member:Member) {
    if(member.userId&&!confirm(`Reset password for ${member.name}? Their current password will stop working.`))return;
    setBusy(true);setError('');
    try {
      const answer=await apiPost<{credential:Credential}>('/api/accounts',{memberId:member.id});
      onCredentials([answer.credential]);onRefresh();
    }catch(e){setError(e instanceof Error?e.message:'Unable to generate login.');}
    finally{setBusy(false);}
  }
  return <section className="panel accounts-panel">
    <div className="panel-heading"><div><h2>Student & trainer logins</h2><p>Passwords are generated automatically and shown once. No password typing required.</p></div><LockKeyhole size={22}/></div>
    <Input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search name, email or ID"/>
    {error&&<div className="error-box" role="alert">{error}</div>}
    {!members.length&&<p>No active students or trainers match.</p>}
    <div className="account-list">{members.map(member=><article className="account-row" key={member.id}>
      <div><strong>{member.name}</strong><span>{member.email}</span><small>{member.role==='student'?'Student':'Trainer'} ID: {member.data.studentId||member.data.trainerId||'Not set'} · {member.userId?'Login linked':'Login not created'}</small></div>
      <Button variant="outline" disabled={busy} onClick={()=>void generate(member)}>{busy&&<Loader2 className="animate-spin" size={16}/>} {member.userId?'Reset automatic password':'Generate login'}</Button>
    </article>)}</div>
    <p style={{fontSize:12,marginTop:12}}>Temporary passwords use the assigned ID only when it is at least 12 characters; shorter IDs receive a random password. All temporary passwords must be changed at first login. An Admin should distribute credentials privately, never post them in a class group.</p>
  </section>;
}
