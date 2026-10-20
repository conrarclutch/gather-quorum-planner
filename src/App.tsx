import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, CalendarDays, CalendarRange, ChevronDown, ChevronRight, CircleHelp, FileText, LayoutDashboard, List, Menu, Plus, Search, Share2, UserRound, X,
} from 'lucide-react';
import {
  addTask, ApiError, claimTask, clearSession, getSession, getState, joinGroup, saveRsvp, updateEvent,
} from './api';
import type { EventPatch, GroupSession, PlannerEvent, PlannerState, PlannerTask, Rsvp, RsvpInput } from './types';
import { GatherMark } from './components/GatherMark';
import { JoinGate } from './components/AccessGate';
import { ActivityRow } from './components/ActivityRow';
import { PlanPanel, type DetailTab } from './components/ActivityDetail';
import { SourcesView } from './components/SourcesView';
import { EditDialog } from './components/EditDialog';
import { CalendarGrid } from './components/CalendarGrid';
import { downloadCalendar } from './calendar';
import './styles.css';
import { previewEvents } from './previewData';

type Screen = 'Overview' | 'Calendar' | 'My signups' | 'Sources';
const previewModeKey = 'gather-preview-mode';
const previewChangesKey = 'gather-preview-changes';
type PreviewChanges = { rsvps: Record<string,RsvpInput>; claims: Record<string,boolean>; extraTasks: Record<string,Array<{id:string;title:string}>> };
const loadPreviewChanges = ():PreviewChanges => { try { const raw=sessionStorage.getItem(previewChangesKey); return raw?JSON.parse(raw) as PreviewChanges:{rsvps:{},claims:{},extraTasks:{}}; } catch { return {rsvps:{},claims:{},extraTasks:{}}; } };
const dateFmt = new Intl.DateTimeFormat('en-US', { weekday:'long', month:'long', day:'numeric', timeZone:'UTC' });
const shortDate = new Intl.DateTimeFormat('en-US', { month:'short', day:'numeric', timeZone:'UTC' });
const monthDate = new Intl.DateTimeFormat('en-US', { month:'long', year:'numeric', timeZone:'UTC' });
const monthKey = (date: string) => date.slice(0,7);
const toUtcDate = (date: string) => new Date(`${date}T12:00:00Z`);
const dateLabel = (date: string) => date ? dateFmt.format(toUtcDate(date)) : 'Date to confirm';
const timeLabel = (time: string | null) => {
  if (!time) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return time;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return time;
  return new Date(Date.UTC(2000, 0, 1, hour, minute)).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', timeZone:'UTC' });
};
const taskListFor = (state: PlannerState | null, event: PlannerEvent) => (state?.tasks ?? []).filter(task => task.eventId === event.id);
const needsPlanning = (event: PlannerEvent) => !event.confirmed || !event.startTime || !event.location || !event.leader;
const initialInvite = () => new URLSearchParams(location.hash.replace(/^#/, '')).get('invite') ?? '';

function App() {
  const configured = Boolean(import.meta.env.VITE_API_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
  const [preview, setPreview] = useState(() => new URLSearchParams(location.search).get('preview') === '1' || sessionStorage.getItem(previewModeKey) === 'yes');
  const [session, setSession] = useState<GroupSession | null>(() => getSession());
  const [state, setState] = useState<PlannerState | null>(null);
  const [events, setEvents] = useState<PlannerEvent[]>([]);
  const [screen, setScreen] = useState<Screen>('Overview');
  const [tab, setTab] = useState<DetailTab>('Details');
  const [selectedId, setSelectedId] = useState<string>('preview-1');
  const [filter, setFilter] = useState('all');
  const [month, setMonth] = useState('all');
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [inviteCode, setInviteCode] = useState(initialInvite());
  const [displayName, setDisplayName] = useState('');
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [ownerCode, setOwnerCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mobileDetail, setMobileDetail] = useState(false);
  const [rsvp, setRsvp] = useState<RsvpInput>({ status:'going',count:1,rideNeeded:0,seatsOffered:0,notes:'' });
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<EventPatch>({});
  const [newTask, setNewTask] = useState('');
  const [previewChanges, setPreviewChanges] = useState<PreviewChanges>(loadPreviewChanges);
  const [calendarMonth, setCalendarMonth] = useState(() => { const d=new Date(); return new Date(Date.UTC(d.getFullYear(),d.getMonth(),1)); });
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(() => new Date().toISOString().slice(0,10));
  const [listMode, setListMode] = useState<'list'|'calendar'>('list');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDialogElement>(null);
  const mobileMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileMenuFirstItemRef = useRef<HTMLButtonElement>(null);
  const mobileDetailBackRef = useRef<HTMLButtonElement>(null);
  const mobileDetailReturnFocusRef = useRef<HTMLElement | null>(null);

  const refresh = async (current = session) => {
    if (!current) return;
    setBusy(true); setError('');
    try {
      const result = await getState();
      setState(result); setEvents(result.events); setSession(current);
      setSelectedId(id => result.events.some(event => event.id === id) ? id : result.events[0]?.id ?? '');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { clearSession(); setSession(null); setState(null); setEvents([]); }
      setError(e instanceof Error ? e.message : 'Could not load activities.');
    }
    finally { setBusy(false); }
  };
  useEffect(() => { if (session && !preview) void refresh(session); }, []);
  useEffect(() => {
    if (!session || preview) return;
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') void refresh(session); };
    const interval = window.setInterval(refreshWhenVisible, 30_000);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', refreshWhenVisible); document.removeEventListener('visibilitychange', refreshWhenVisible); };
  }, [session, preview]);
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const dialog = mobileMenuRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    mobileMenuFirstItemRef.current?.focus();
    return () => { if (dialog.open) dialog.close(); };
  }, [mobileMenuOpen]);
  useEffect(() => {
    const viewport = window.matchMedia('(max-width: 650px)');
    const closeMobileOverlays = (event: MediaQueryListEvent) => {
      if (!event.matches) {
        setMobileDetail(false);
        setMobileMenuOpen(false);
      }
    };
    viewport.addEventListener('change', closeMobileOverlays);
    return () => viewport.removeEventListener('change', closeMobileOverlays);
  }, []);
  useEffect(() => {
    if (!mobileDetail || !window.matchMedia('(max-width: 650px)').matches) return;
    mobileDetailReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    mobileDetailBackRef.current?.focus();
    const containFocus = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMobileDetail(false); return; }
      if (event.key !== 'Tab') return;
      const panel = document.querySelector<HTMLElement>('.plan-panel.mobile-open');
      const focusable = panel ? [...panel.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')].filter(item => item.offsetParent !== null) : [];
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', containFocus);
    return () => {
      document.removeEventListener('keydown', containFocus);
      mobileDetailReturnFocusRef.current?.focus();
    };
  }, [mobileDetail]);

  const previewMember = {id:'preview-organizer',displayName:'Preview organizer',role:'owner' as const};
  const previewState:PlannerState = {member:previewMember,events:previewEvents,tasks:previewEvents.flatMap(event=>[...event.previewTasks.map((title,index)=>({id:`${event.id}-task-${index}`,groupId:'preview',eventId:event.id,title,quantity:1,category:'help',suggested:true,claimedBy:previewChanges.claims[`${event.id}-task-${index}`]?'preview-organizer':null,createdAt:'',updatedAt:''})),...(previewChanges.extraTasks[event.id]??[]).map(task=>({id:task.id,groupId:'preview',eventId:event.id,title:task.title,quantity:1,category:'help',suggested:false,claimedBy:null,createdAt:'',updatedAt:''}))]),rsvps:Object.entries(previewChanges.rsvps).map(([eventId,value])=>({id:`preview-${eventId}`,eventId,memberId:'preview-organizer',...value,updatedAt:''})),members:[previewMember]};
  const plannerState = preview ? previewState : state;
  const activeEvents = (preview ? previewEvents : events).slice().sort((a,b)=>a.eventDate.localeCompare(b.eventDate));
  const selected = activeEvents.find(event => event.id === selectedId) ?? activeEvents[0] ?? null;
  const months = useMemo(() => [...new Set(activeEvents.map(event => monthKey(event.eventDate)))].sort(), [activeEvents]);
  const filtered = useMemo(() => activeEvents.filter(event => {
    const mine = plannerState?.rsvps.some(rsvp => rsvp.eventId === event.id && rsvp.memberId === plannerState.member.id && rsvp.status !== 'declined') ?? false;
    const filterOk = filter === 'all' || (filter === 'planning' ? needsPlanning(event) : mine);
    const monthOk = month === 'all' || monthKey(event.eventDate) === month;
    const queryOk = !query || `${event.originalTitle} ${event.scope} ${event.details} ${event.location ?? ''}`.toLowerCase().includes(query.toLowerCase());
    return filterOk && monthOk && queryOk;
  }), [activeEvents,filter,month,query,plannerState]);
  const grouped = useMemo(() => {
    const result: Array<{ key:string; events:PlannerEvent[] }> = [];
    for (const event of filtered) {
      const key = monthKey(event.eventDate);
      const last = result[result.length - 1];
      if (last?.key === key) last.events.push(event); else result.push({ key, events:[event] });
    }
    return result;
  }, [filtered]);
  const tasks = selected ? taskListFor(plannerState, selected) : [];
  
  const currentRsvp: Rsvp | undefined = selected && plannerState ? plannerState.rsvps.find(value => value.eventId === selected.id && value.memberId === plannerState.member.id) : undefined;
  useEffect(() => {
    setRsvp(currentRsvp ? {status:currentRsvp.status,count:currentRsvp.count,rideNeeded:currentRsvp.rideNeeded,seatsOffered:currentRsvp.seatsOffered,notes:currentRsvp.notes} : {status:'going',count:1,rideNeeded:0,seatsOffered:0,notes:''});
  }, [selectedId, currentRsvp?.status, currentRsvp?.count, currentRsvp?.rideNeeded, currentRsvp?.seatsOffered, currentRsvp?.notes]);

  const join = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try { const next = await joinGroup({ inviteCode: inviteCode.trim(), displayName: displayName.trim(), ...(ownerCode.trim() ? { ownerCode:ownerCode.trim() } : {}) }); setSession(next); setPreview(false); sessionStorage.removeItem(previewModeKey); await refresh(next); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not join this group.'); }
    finally { setBusy(false); }
  };
  const enablePreview = () => { sessionStorage.setItem(previewModeKey,'yes'); setPreview(true); setState(null); setEvents([]); setSelectedId('preview-1'); setError(''); };
  const updatePreview = (next:PreviewChanges) => { setPreviewChanges(next); sessionStorage.setItem(previewChangesKey,JSON.stringify(next)); };
  const exitPreview = () => { sessionStorage.removeItem(previewModeKey); setPreview(false); if (session) void refresh(session); };
  const runAction = async (fn: () => Promise<unknown>, success?: string) => { setBusy(true); setError(''); setNotice(''); try { await fn(); await refresh(); if (success) setNotice(success); return true; } catch(e) { if(e instanceof ApiError&&e.status===401){clearSession();setSession(null);setState(null);setEvents([]);} if(e instanceof ApiError&&e.status===409) await refresh(); setError(e instanceof Error ? e.message : 'That change could not be saved.'); return false; } finally { setBusy(false); } };
  const doRsvp = (status: RsvpInput['status']) => {
    if (!selected) return;
    if (preview) { updatePreview({...previewChanges,rsvps:{...previewChanges.rsvps,[selected.id]:{...rsvp,status}}}); setNotice('Saved in this browser preview. Other group members cannot see it.'); return; }
    const input = { ...rsvp, status, count:Math.max(1,Number(rsvp.count)||1), rideNeeded:Math.max(0,Number(rsvp.rideNeeded)||0), seatsOffered:Math.max(0,Number(rsvp.seatsOffered)||0) };
    void runAction(() => saveRsvp(selected.id,input), 'Your response has been saved.');
  };
  const saveLogistics = async (e: React.FormEvent) => { e.preventDefault(); if (!selected || !state || preview) return; const saved = await runAction(() => updateEvent(selected.id,selected.updatedAt,editForm),'Plan details saved.'); if (saved) setEditOpen(false); };
  const doClaim = (task: PlannerTask, claim: boolean) => { if (preview) { updatePreview({...previewChanges,claims:{...previewChanges.claims,[task.id]:claim}}); setNotice(claim?'Saved in this browser preview.':'You released this preview task.'); return; } void runAction(() => claimTask(task.id,claim),claim ? 'You’re on it.' : 'You released this task.'); };
  const createTask = (e: React.FormEvent) => { e.preventDefault(); if (!selected || !newTask.trim()) return; if (preview) { updatePreview({...previewChanges,extraTasks:{...previewChanges.extraTasks,[selected.id]:[...(previewChanges.extraTasks[selected.id]??[]),{id:`preview-extra-${Date.now()}`,title:newTask.trim()}]}}); setNotice('Added in this browser preview.'); setNewTask(''); return; } void runAction(() => addTask({eventId:selected.id,title:newTask.trim()}),'Task added.').then(saved => { if (saved) setNewTask(''); }); };
  const signOut = () => { clearSession(); setSession(null); setState(null); setEvents([]); setScreen('Overview'); setError(''); };
  const copyShare = async () => { const url = `${location.origin}${location.pathname}${preview ? '?preview=1' : ''}`; const message = preview ? 'Preview link copied. Preview changes are not shared.' : 'Group link copied. Share the invite code separately.'; try { await navigator.clipboard.writeText(url); setNotice(message); } catch { window.prompt(preview ? 'Copy this preview link. Changes are not shared.' : 'Copy this group link. Share the invite code separately.',url); } };

  if (!preview && !session) return <JoinGate configured={configured} inviteCode={inviteCode} setInviteCode={setInviteCode} displayName={displayName} setDisplayName={setDisplayName} ownerOpen={ownerOpen} setOwnerOpen={setOwnerOpen} ownerCode={ownerCode} setOwnerCode={setOwnerCode} busy={busy} error={error} join={join} preview={enablePreview} />;
  if (!preview && session && !state && busy) return <div className="page-loader"><GatherMark/><p>Opening your shared plans…</p></div>;
  if (!preview && session && !state && error && !configured) return <JoinGate configured={false} inviteCode={inviteCode} setInviteCode={setInviteCode} displayName={displayName} setDisplayName={setDisplayName} ownerOpen={ownerOpen} setOwnerOpen={setOwnerOpen} ownerCode={ownerCode} setOwnerCode={setOwnerCode} busy={busy} error={error} join={join} preview={enablePreview}/>;

  const featured = activeEvents.find(event => /overnight|weekend|peppersauce/i.test(event.originalTitle))
    ?? activeEvents.find(event => /camp|outdoor/i.test(event.originalTitle))
    ?? activeEvents[0]
    ?? null;
  const selectedOnCalendar = activeEvents.find(event => event.eventDate === selectedCalendarDate);
  const handleCalendarDate = (date:string) => { setSelectedCalendarDate(date); const event=activeEvents.find(item=>item.eventDate===date); if(event){setSelectedId(event.id);setTab('Details');openMobileDetail();} };
  const goTo = (item:Screen) => { setScreen(item); if(item==='My signups')setFilter('mine'); else if(item==='Overview'&&filter==='mine')setFilter('all'); setMobileDetail(false); };
  const openMobileDetail = () => { mobileDetailReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setMobileDetail(window.matchMedia('(max-width: 650px)').matches); };
  const chooseMobileScreen = (item:Screen) => { goTo(item); mobileMenuRef.current?.close(); setMobileMenuOpen(false); };
  const monthCounts = months.map(key=>({key,count:activeEvents.filter(event=>monthKey(event.eventDate)===key).length}));
  const startCalendar = () => setCalendarMonth(new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7))-1,1)));
  const setMonthFilter = (value:string) => { setMonth(value); if(value!=='all')setCalendarMonth(new Date(Date.UTC(Number(value.slice(0,4)),Number(value.slice(5,7))-1,1))); };
  const featuredImage = (event:PlannerEvent) => `${import.meta.env.BASE_URL}assets/${/basket|cocoa|kindness/i.test(event.originalTitle)?'baskets.webp':/festival|market|autumn/i.test(event.originalTitle)?'festival.webp':/service|combined/i.test(event.originalTitle)?'community.webp':/halloween|lantern|treat/i.test(event.originalTitle)?'halloween.webp':'outdoors.webp'}`;

  return <div className="app-shell">
    {preview && <div className="preview-banner"><span><CircleHelp size={15}/> Design preview - synthetic sample activities</span><span>Changes stay in this browser only</span><button onClick={exitPreview}>Exit preview <X size={14}/></button></div>}
    <aside className="sidebar">
      <a className="side-brand" href="#" aria-label="Gather home"><GatherMark/><span>Gather</span></a><div className="side-group-name">Priests quorum</div>
      <button className="side-share" onClick={copyShare}><Plus size={18}/>Share planner</button>
      <nav className="side-nav" aria-label="Main navigation">
        <button className={screen==='Overview'?'active':''} onClick={()=>goTo('Overview')}><LayoutDashboard/>Overview</button>
        <button className={screen==='Calendar'?'active':''} onClick={()=>goTo('Calendar')}><CalendarDays/>Calendar</button>
        <button className={screen==='My signups'?'active':''} onClick={()=>goTo('My signups')}><UserRound/>My signups</button>
        <button className={screen==='Sources'?'active':''} onClick={()=>goTo('Sources')}><FileText/>Source schedules</button>
      </nav>
      <div className="month-shortcuts"><h2>Upcoming months</h2>{monthCounts.map(item=><button key={item.key} onClick={()=>{setMonthFilter(item.key);goTo('Overview')}}><CalendarDays/><span>{monthDate.format(toUtcDate(`${item.key}-01`)).split(' ')[0]}</span><b>{item.count}</b></button>)}</div>
      <div className="side-profile"><span className="profile-mark">{preview?'P':(state?.member.displayName.slice(0,1).toUpperCase()??'-')}</span><span><strong>{preview?'Preview organizer':state?.member.displayName??'Your group'}</strong><small>{preview?'Preview mode':state?.member.role==='owner'?'Group organizer':'Group member'}</small></span>{!preview&&session&&<button aria-label="Leave group" onClick={signOut}><ChevronDown size={16}/></button>}</div>
    </aside>
    <div className="app-main">
      <header className="topbar"><div className="mobile-brand"><GatherMark/><span>Gather</span><button ref={mobileMenuTriggerRef} className="mobile-menu-trigger" aria-label="Open navigation menu" aria-haspopup="dialog" aria-controls="mobile-navigation" aria-expanded={mobileMenuOpen} onClick={()=>setMobileMenuOpen(true)}><Menu size={20}/></button></div><div className="page-heading"><h1>{screen==='Overview'?'Activity planner':screen==='Calendar'?'Calendar':screen==='My signups'?'My signups':'Source schedules'}</h1><p>{screen==='Overview'?'Upcoming activities and the people making them happen.':screen==='Calendar'?'See what is happening across the group.':screen==='My signups'?'The activities and tasks you signed up for.':'The shared schedules behind these plans.'}</p></div><div className="header-actions"><label className={`top-search ${searchOpen?'open':''}`}><Search size={18}/><input placeholder="Find an activity" value={query} onChange={e=>setQuery(e.target.value)} aria-label="Find an activity"/>{query&&<button aria-label="Clear search" onClick={()=>setQuery('')}><X size={15}/></button>}</label><button className="search-trigger" aria-label="Search activities" onClick={()=>setSearchOpen(!searchOpen)}><Search size={17}/></button><button className="top-share" onClick={copyShare}><Share2 size={17}/>Share</button><span className="top-avatar" aria-label={preview?'Preview organizer':state?.member.displayName}>{preview?'P':state?.member.displayName.slice(0,1).toUpperCase()??'-'}</span></div></header>
      <dialog ref={mobileMenuRef} id="mobile-navigation" className="mobile-navigation" aria-label="Activity planner navigation" onCancel={event=>{event.preventDefault();mobileMenuRef.current?.close();setMobileMenuOpen(false);}} onClose={()=>setMobileMenuOpen(false)}><div className="mobile-navigation-head"><div><strong>Gather</strong><span>Priests quorum</span></div><button aria-label="Close navigation menu" onClick={()=>{mobileMenuRef.current?.close();setMobileMenuOpen(false);}}><X size={20}/></button></div><nav aria-label="Mobile navigation">{([['Overview',LayoutDashboard],['Calendar',CalendarDays],['My signups',UserRound],['Sources',FileText]] as const).map(([item,Icon],index)=><button key={item} ref={index===0?mobileMenuFirstItemRef:undefined} className={screen===item?'active':''} aria-current={screen===item?'page':undefined} onClick={()=>chooseMobileScreen(item)}><Icon size={19}/>{item==='Sources'?'Source schedules':item}</button>)}</nav>{!preview&&session&&<button className="mobile-signout" onClick={()=>{signOut();mobileMenuRef.current?.close();setMobileMenuOpen(false);}}><ArrowLeft size={18}/>Leave group</button>}{preview&&<button className="mobile-signout" onClick={()=>{exitPreview();mobileMenuRef.current?.close();setMobileMenuOpen(false);}}>Exit preview</button>}</dialog>
      <main className="main-content">
        {(error || notice) && <div className={`message ${error?'error':'success'}`} role={error?'alert':'status'}>{error&&<span>{error}</span>}{notice&&<span>{notice}</span>}{error&&<button onClick={()=>void refresh()} disabled={busy}>Refresh</button>}<button className="message-close" aria-label="Dismiss message" onClick={()=>{setError('');setNotice('')}}><X size={16}/></button></div>}
        {mobileDetail&&<button className="mobile-sheet-scrim" aria-label="Close activity details" onClick={()=>setMobileDetail(false)}/>}
        {screen==='Sources' ? <SourcesView events={activeEvents} preview={preview}/> : screen==='Calendar' ? <div className="full-calendar-layout"><CalendarGrid events={activeEvents} month={calendarMonth} selectedDate={selectedCalendarDate} onDateChange={handleCalendarDate} onMonthChange={setCalendarMonth}/><section className="calendar-agenda"><div className="section-title"><div><h2>{selectedOnCalendar?dateLabel(selectedCalendarDate):monthDate.format(toUtcDate(`${calendarMonth.getUTCFullYear()}-${String(calendarMonth.getUTCMonth()+1).padStart(2,'0')}-01`))}</h2><p>Activities from the shared schedules</p></div><button className="quiet-button" onClick={()=>window.print()}><FileText size={16}/>Print</button></div>{activeEvents.filter(event=>monthKey(event.eventDate)===`${calendarMonth.getUTCFullYear()}-${String(calendarMonth.getUTCMonth()+1).padStart(2,'0')}`).map((event,index)=><ActivityRow key={event.id} event={event} taskCount={taskListFor(plannerState,event).length} active={event.id===selected?.id} index={index} onClick={()=>{setSelectedId(event.id);setSelectedCalendarDate(event.eventDate);setTab('Details');openMobileDetail()}}/>)}{!activeEvents.some(event=>monthKey(event.eventDate)===`${calendarMonth.getUTCFullYear()}-${String(calendarMonth.getUTCMonth()+1).padStart(2,'0')}`)&&<p className="empty-calendar">No activities are listed for this month.</p>}</section>{selected&&<aside className={`plan-panel ${mobileDetail?'mobile-open':''}`} role={mobileDetail?'dialog':undefined} aria-modal={mobileDetail||undefined} aria-label="Selected activity plan"><button ref={mobileDetailBackRef} className="mobile-back" onClick={()=>setMobileDetail(false)}><ArrowLeft size={17}/> Back to calendar</button><PlanPanel event={selected} tasks={tasks} state={plannerState} currentRsvp={currentRsvp} preview={preview} tab={tab} setTab={setTab} setRsvp={setRsvp} rsvp={rsvp} doRsvp={doRsvp} doClaim={doClaim} newTask={newTask} setNewTask={setNewTask} createTask={createTask} openEdit={()=>{setEditForm(eventToPatch(selected));setEditOpen(true)}} busy={busy}/></aside>}</div> : <div className="dashboard-grid">
          <div className="left-stack">
            {featured&&<section className="feature-card" style={{backgroundImage:`url("${featuredImage(featured)}")`}}><span className="photo-label">Photo illustration</span><div className="feature-copy"><span className="feature-type">Outdoor activity</span><h2>{featured.originalTitle}</h2><p><CalendarDays size={17}/>{shortDate.format(toUtcDate(featured.eventDate))}<i/>{featured.dateCaveat ? 'Date to confirm' : featured.status || 'Date to confirm'}</p><button onClick={()=>{setSelectedId(featured.id);setTab('Details');openMobileDetail()}}>View plan <ChevronRight size={17}/></button></div></section>}
            <section className="activity-column"><div className="list-heading"><h2>Upcoming activities <span>({screen==='My signups'?filtered.length:activeEvents.length})</span></h2><div className="view-toggle"><button className={listMode==='list'?'active':''} aria-label="List view" aria-pressed={listMode==='list'} onClick={()=>setListMode('list')}><List size={17}/></button><button className={listMode==='calendar'?'active':''} aria-label="Calendar view" aria-pressed={listMode==='calendar'} onClick={()=>setListMode('calendar')}><CalendarRange size={17}/></button></div></div>
              <div className="list-controls"><div className="filter-tabs"><button className={filter==='all'?'active':''} onClick={()=>{setFilter('all');goTo('Overview')}}>All</button><button className={filter==='planning'?'active':''} onClick={()=>{setFilter('planning');goTo('Overview')}}>Needs planning</button><button className={filter==='mine'?'active':''} onClick={()=>goTo('My signups')}>My signups</button></div><label className="select-wrap"><span className="sr-only">Choose month</span><select aria-label="Choose month" value={month} onChange={e=>setMonthFilter(e.target.value)}><option value="all">All months</option>{months.map(key=><option key={key} value={key}>{monthDate.format(toUtcDate(`${key}-01`))}</option>)}</select><ChevronDown size={17}/></label></div>
              {busy&&state===null&&<div className="inline-loading" role="status">Loading activities...</div>}{!filtered.length&&<div className="empty-state"><h3>{activeEvents.length?'No activities match these filters':'No activities yet'}</h3><p>{activeEvents.length?'Try another month or search.':'Join with your group invite to see plans as they are shared.'}</p></div>}
              {listMode==='calendar'?<CalendarGrid events={filtered} month={calendarMonth} selectedDate={selectedCalendarDate} onDateChange={handleCalendarDate} onMonthChange={setCalendarMonth} compact/>:<div className="activity-groups">{grouped.map(group=><section className="month-group" key={group.key} aria-label={monthDate.format(toUtcDate(`${group.key}-01`))}>{grouped.length>1&&<h3 className="month-label">{monthDate.format(toUtcDate(`${group.key}-01`))}</h3>}{group.events.map((event,index)=><div className="activity-line" key={event.id}><img className="activity-thumb" src={featuredImage(event)} alt=""/><ActivityRow event={event} taskCount={preview?previewEvents.find(p=>p.id===event.id)?.previewTasks.length??2:taskListFor(plannerState,event).length} active={event.id===selected?.id} onClick={()=>{setSelectedId(event.id);setSelectedCalendarDate(event.eventDate);setTab('Details');openMobileDetail()}} index={index}/></div>)}</section>)}</div>}
              <div className="list-footer"><button className="quiet-button" onClick={()=>downloadCalendar(filtered)}><CalendarDays size={16}/>Export calendar</button><button className="quiet-button" onClick={()=>window.print()}><FileText size={16}/>Print</button><button className="quiet-button" onClick={()=>void refresh()} disabled={busy}>Refresh plans</button></div>
            </section>
          </div>
          <div className="right-stack"><CalendarGrid events={activeEvents} month={calendarMonth} selectedDate={selectedCalendarDate} onDateChange={handleCalendarDate} onMonthChange={setCalendarMonth} compact/><aside className={`plan-panel ${mobileDetail?'mobile-open':''}`} role={mobileDetail?'dialog':undefined} aria-modal={mobileDetail||undefined} aria-label="Selected activity plan">{selected&&<><button ref={mobileDetailBackRef} className="mobile-back" onClick={()=>setMobileDetail(false)}><ArrowLeft size={17}/> Back to activities</button><PlanPanel event={selected} tasks={tasks} state={plannerState} currentRsvp={currentRsvp} preview={preview} tab={tab} setTab={setTab} setRsvp={setRsvp} rsvp={rsvp} doRsvp={doRsvp} doClaim={doClaim} newTask={newTask} setNewTask={setNewTask} createTask={createTask} openEdit={()=>{setEditForm(eventToPatch(selected));setEditOpen(true)}} busy={busy}/></>}</aside></div>
        </div>}
      </main>
      {editOpen&&selected&&<EditDialog event={selected} value={editForm} onChange={setEditForm} onClose={()=>setEditOpen(false)} onSubmit={saveLogistics} busy={busy}/>}
      <footer className="site-footer">Gather · Priests quorum</footer>
    </div>
  </div>;

}

const eventToPatch=(event:PlannerEvent):EventPatch=>({eventDate:event.eventDate,departureTime:event.departureTime,startTime:event.startTime,endTime:event.endTime,returnTime:event.returnTime,meetingPoint:event.meetingPoint,location:event.location,leader:event.leader,notes:event.notes,confirmed:event.confirmed});

export default App;




