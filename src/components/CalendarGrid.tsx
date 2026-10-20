import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { PlannerEvent } from '../types';

const monthTitle = new Intl.DateTimeFormat('en-US', { month:'long', year:'numeric', timeZone:'UTC' });
const dateId = (date:Date) => date.toISOString().slice(0,10);

export function CalendarGrid({events,month,selectedDate,onDateChange,onMonthChange,compact=false}:{events:PlannerEvent[];month:Date;selectedDate:string;onDateChange:(date:string)=>void;onMonthChange:(date:Date)=>void;compact?:boolean}) {
  const first = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const monthLength = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth()+1, 0)).getUTCDate();
  const cellCount = Math.ceil((first.getUTCDay()+monthLength)/7)*7;
  const days = Array.from({length:cellCount}, (_,i) => i < first.getUTCDay() || i >= first.getUTCDay()+monthLength
    ? null
    : new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), i-first.getUTCDay()+1)));
  const eventDays = new Set(events.map(event => event.eventDate));
  const shift = (amount:number) => onMonthChange(new Date(Date.UTC(month.getUTCFullYear(),month.getUTCMonth()+amount,1)));
  const dayName = (day:Date) => day.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric',timeZone:'UTC'});

  return <section className={`calendar-widget ${compact?'compact':''}`} aria-label="Activity calendar">
    <div className="calendar-head"><h2>{monthTitle.format(first)}</h2><div className="calendar-arrows"><button onClick={()=>shift(-1)} aria-label="Previous month"><ChevronLeft size={17}/></button><button onClick={()=>shift(1)} aria-label="Next month"><ChevronRight size={17}/></button></div></div>
    <div className="calendar-weekdays">{['Su','Mo','Tu','We','Th','Fr','Sa'].map(day=><span key={day}>{day}</span>)}</div>
    <div className="calendar-days">{days.map((day,index)=>{
      if (!day) return <span className="calendar-blank" key={`blank-${index}`}/>;
      const id = dateId(day);
      const has = eventDays.has(id);
      const accessibleDate = dayName(day);
      const accessibleLabel = has ? `${accessibleDate}, has activities` : accessibleDate;
      return <button key={id} className={`${selectedDate===id?'chosen':''} ${has?'has-event':''}`} aria-label={accessibleLabel} aria-pressed={selectedDate===id} onClick={()=>onDateChange(id)}><span>{day.getUTCDate()}</span>{has&&<i/>}</button>;
    })}</div>
    {compact&&<div className="calendar-selected">{events.filter(event=>event.eventDate===selectedDate).length ? events.filter(event=>event.eventDate===selectedDate).map(event=><button key={event.id} onClick={()=>onDateChange(event.eventDate)}><small>{new Date(`${event.eventDate}T12:00:00Z`).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'})}</small><strong>{event.originalTitle}</strong><ChevronRight size={18}/></button>) : <p>No activity on this day</p>}</div>}
  </section>;
}
