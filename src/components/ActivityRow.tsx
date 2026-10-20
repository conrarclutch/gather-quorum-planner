import React from 'react';
import { ChevronRight, Menu } from 'lucide-react';
import type { PlannerEvent } from '../types';

const toUtcDate=(date:string)=>new Date(`${date}T12:00:00Z`);
const timeLabel=(time:string|null)=>{
 if(!time)return null;
 const match=/^(\d{1,2}):(\d{2})$/.exec(time); if(!match)return time;
 const hour=Number(match[1]),minute=Number(match[2]); if(hour>23||minute>59)return time;
 return new Date(Date.UTC(2000,0,1,hour,minute)).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'UTC'});
};

export function ActivityRow({event,taskCount,active,onClick,index}:{event:PlannerEvent;taskCount:number;active:boolean;onClick:()=>void;index:number}){
  const date=toUtcDate(event.eventDate); const [monthShort,day]=new Intl.DateTimeFormat('en-US',{month:'short',day:'2-digit',timeZone:'UTC'}).format(date).split(' ');
  const info=event.status || (event.startTime ? `${timeLabel(event.startTime)}${event.endTime?`–${timeLabel(event.endTime)}`:''}` : 'Details to confirm');
  return <button className={`activity-row ${active?'selected':''}`} onClick={onClick} aria-pressed={active} style={{'--row-index':index} as React.CSSProperties}><span className="row-date"><span>{monthShort.toUpperCase()}</span><b>{Number(day)}</b></span><span className="row-copy"><strong>{event.originalTitle}</strong><span>{event.scope||info}</span>{active&&<span className="selected-meta"><span><Menu size={16}/>{event.scope||'Priests'}</span><i/><span><Menu size={16}/>{taskCount} ways to help</span></span>}</span><span className="row-action">{active?'Open plan':`${taskCount} ${taskCount===1?'way':'ways'} to help`}<ChevronRight size={19}/></span></button>
}

