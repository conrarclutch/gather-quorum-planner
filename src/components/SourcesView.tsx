import React, { useMemo } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { PlannerEvent } from '../types';
const dateFmt = new Intl.DateTimeFormat('en-US', { weekday:'long', month:'long', day:'numeric', timeZone:'UTC' });
const dateLabel = (date:string) => date ? dateFmt.format(new Date(`${date}T12:00:00Z`)) : 'Date to confirm';
export function SourcesView({events,preview}:{events:PlannerEvent[];preview:boolean}){
 const sources=useMemo(()=>{const map=new Map<string,{url:string;tab:string;events:PlannerEvent[]}>();events.forEach(event=>{const key=`${event.sourceUrl}::${event.sourceTab}`;const item=map.get(key)??{url:event.sourceUrl,tab:event.sourceTab,events:[]};item.events.push(event);map.set(key,item)});return [...map.values()]},[events]);
 return <section className="sources-view"><div className="sources-header"><div><h2>Source schedules</h2><p>These activities were brought together from two shared schedules.</p></div><span>Source snapshots · not live syncs</span></div>{preview&&<p className="sources-preview">Sample source records shown for design preview only.</p>}<div className="source-list">{sources.map((source,i)=><article className="source-entry" key={source.url+source.tab}><div className="source-number">0{i+1}</div><div className="source-summary"><h3>{source.tab}</h3><p>{source.events.length} activities in this planner</p>{source.url!=='#'&&<a href={source.url} target="_blank" rel="noreferrer">Open original schedule <ArrowUpRight size={14}/></a>}</div><div className="source-records">{source.events.map(event=><div className="source-record" key={event.id}><span>Source date: {event.sourceDate||'Not listed'}</span><strong>{event.originalTitle}</strong><small>Planning date: {dateLabel(event.eventDate)} · Source row {event.sourceRow}{event.dateCaveat?` · ${event.dateCaveat}`:''}{/(inferred|no year)/i.test(event.yearConfidence)?' · Year needs confirmation':''}</small></div>)}</div></article>)}</div></section>
}

