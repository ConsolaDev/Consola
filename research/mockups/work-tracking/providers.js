const $ = selector => document.querySelector(selector);
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const params = new URLSearchParams(location.search);
const svgPaths = {
 pr:'<circle cx="6" cy="3" r="2"/><path d="M6 5v12"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M18 17V8a5 5 0 0 0-5-5h-1m0 0 3-3m-3 3 3 3"/>',
 issue:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1"/>',
 check:'<path d="m5 12 4 4L19 6"/>', x:'<path d="m6 6 12 12M6 18 18 6"/>',
 down:'<path d="m6 9 6 6 6-6"/>', right:'<path d="m9 6 6 6-6 6"/>',
 comment:'<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
 refresh:'<path d="M20 7a9 9 0 1 0 1 9M20 3v5h-5"/>',
 settings:'<path d="m9 3 1-2h4l1 2 3 2 2 0 2 4-2 2v3l2 2-2 4h-2l-3 2-1 2h-4l-1-2-3-2H4l-2-4 2-2v-3L2 9l2-4h2z" transform="translate(1 0) scale(.9)"/><circle cx="12" cy="12" r="3"/>',
 home:'<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-8H9v8H4a1 1 0 0 1-1-1z"/>',
 inbox:'<path d="M4 3h16l2 12v6H2v-6zM2 15h6l2 3h4l2-3h6"/>',
 panel:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18m7-14-3 5 3 5"/>',
 plus:'<path d="M12 5v14M5 12h14"/>', branch:'<circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 6v12M18 8a10 10 0 0 1-10 10"/>',
 external:'<path d="M15 3h6v6m0-6-9 9M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
 sliders:'<path d="M4 6h5m4 0h7M4 12h9m4 0h3M4 18h2m4 0h10M9 3v6m4 0v6M6 15v6"/>',
 group:'<path d="m12 2 5 3v6l-5 3-5-3V5zm-5 9 5 3v6l-5 3-5-3v-6zm10 0 5 3v6l-5 3-5-3v-6z"/>'
};
const icon = (name,size=14,className='') => `<svg class="${className}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svgPaths[name]||svgPaths.issue}</svg>`;
const option = (value,label,selected) => `<option value="${esc(value)}" ${String(value)===String(selected)?'selected':''}>${esc(label)}</option>`;
const prs = [
 {id:'4146',title:'RES-2583: say that a combined-CSV 409 is not always runs-in-progress',repo:'flex-portal',author:'erkki-lindpere-sympower',age:'2h',days:0,section:'review',review:'Awaiting approval',checks:'2/2',diff:'+33 −4',comments:1,sessions:[]},
 {id:'4117',title:'Update material-ui monorepo to v7.3.11',repo:'flex-portal',author:'renovate',age:'14h',days:0,section:'review',review:'Awaiting approval',checks:'8/9',failed:true,diff:'+128 −96',sessions:['Review dependency update']},
 {id:'4128',title:'RES-2452: name the ports section after what it shows, and add a graph view',repo:'flex-portal',author:'steve-sympower',age:'2d',days:2,section:'review',review:'Awaiting approval',checks:'2/2',diff:'+218 −41',comments:1,sessions:['Review ports graph']},
 {id:'4140',title:'Improve schedule validation errors',repo:'flex-portal',author:'maya',age:'1d',days:1,section:'team',review:'Awaiting approval',checks:'3/3',diff:'+84 −19',sessions:[]},
 {id:'580',title:'Modify CODEOWNERS for tradescheduler ownership',repo:'planning-flexibility-tests',author:'SymJavi',age:'1w',days:7,section:'action',review:'Changes requested',checks:'1/1',diff:'+2 −2',sessions:[]},
 {id:'4100',title:'UI-25 Explain the one year cap on custom revenue date ranges',repo:'flex-portal',author:'SymJavi',age:'2w',days:14,section:'action',review:'Changes requested',checks:'2/2',diff:'+42 −11',comments:1,sessions:['Address date range review']},
 {id:'4131',title:'PAY-88 · Safe retry confirmation',repo:'web-app',author:'SymJavi',age:'8m',days:0,section:'action',review:'Changes requested',checks:'3/4',failed:true,diff:'+92 −24',comments:2,sessions:['Address rounding feedback'],track:'payments'},
 {id:'4150',title:'Reduce duplicate schedule requests',repo:'flex-portal',author:'SymJavi',age:'3h',days:0,section:'draft',review:'Draft',checks:'Pending',diff:'+64 −8',sessions:[]},
 {id:'4142',title:'Add retry diagnostics',repo:'web-app',author:'SymJavi',age:'1d',days:1,section:'waiting',review:'Awaiting approval',checks:'2/2',diff:'+37 −6',sessions:[]},
 {id:'4139',title:'Correct timezone label',repo:'flex-portal',author:'SymJavi',age:'2d',days:2,section:'ready',review:'Approved',checks:'2/2',diff:'+8 −3',sessions:[]},
 {id:'608',title:'Investigate missing schedule history',repo:'planning-flexibility-tests',author:'steve-sympower',age:'4d',days:4,section:'issues',review:'Open',assignee:true,sessions:[]}
];
const tickets = {
 Jira:[
  {id:'PAY-88',title:'Make payment retries safe',status:'In progress',priority:'High',project:'Payments',period:'Sprint 24',assignee:'Javier',track:'payments',sessions:['Plan retry behavior','Implement API','Address rounding feedback'],description:'Retry without double charging. Keep amounts consistent across the API and payment confirmation screen.',linked:'payments-api #4108 · Merged / web-app #4131 · Changes requested'},
  {id:'PAY-102',title:'Explain declined payments',status:'To do',priority:'Medium',project:'Payments',period:'Sprint 24',assignee:'Javier',sessions:[],description:'Show a clear reason and a useful next step when a payment is declined.'},
  {id:'PAY-97',title:'Reconcile duplicate webhook events',status:'To do',priority:'High',project:'Payments',period:'Backlog',assignee:'Javier',sessions:[],description:'Make webhook processing safe to repeat.'},
  {id:'OPS-61',title:'Restore missing audit events',status:'Done',priority:'High',project:'Platform',period:'Sprint 24',assignee:'Javier',track:'audit',sessions:['Investigate audit gap','Restore events'],description:'Restore the missing audit events and verify coverage.',linked:'audit-service #392 · Merged'},
  {id:'PAY-110',title:'Add payment-method fallback',status:'In progress',priority:'Medium',project:'Payments',period:'Sprint 24',assignee:'Maya',sessions:[],description:'Let customers retry with another saved payment method.'}
 ],
 Linear:[
  {id:'WEB-142',title:'Simplify workspace onboarding',status:'In review',priority:'High',project:'Onboarding',period:'Cycle 18',assignee:'Javier',track:'onboarding',sessions:['Revise onboarding flow'],description:'Help a new workspace reach its first useful session with fewer setup steps.',linked:'web-app #4190 · Awaiting Maya’s review'},
  {id:'WEB-156',title:'Remember the last active workspace',status:'Todo',priority:'Medium',project:'Navigation',period:'Cycle 18',assignee:'Javier',sessions:[],description:'Restore the workspace when the app is reopened.'},
  {id:'WEB-161',title:'Improve empty session states',status:'In progress',priority:'Medium',project:'Onboarding',period:'Cycle 18',assignee:'Javier',sessions:[],description:'Explain how to start a session from an empty workspace.'},
  {id:'WEB-170',title:'Keyboard navigation in the scope picker',status:'Todo',priority:'Low',project:'Navigation',period:'Backlog',assignee:'Javier',sessions:[],description:'Move through scope results with the keyboard.'},
  {id:'WEB-149',title:'Clarify the workspace invite email',status:'In review',priority:'Low',project:'Onboarding',period:'Cycle 18',assignee:'Maya',sessions:[],description:'Make the invitation and destination easier to understand.'}
 ]
};
// Keep the five visible rows and initial section counts from the supplied
// GitHub screenshot. Unseen rows are not invented; their sections explain this.
const capturedIds = ['4146','4117','4128','580','4100'];
const capturedPRs = prs.filter(p => capturedIds.includes(p.id));
const sections = [['review','Needs your review'],['team',"Needs your teams’ review"],['draft','Your drafts'],['waiting','Waiting for review or checks'],['action','Needs action'],['ready','Ready to merge'],['issues','Issues assigned to you']];
const views = [['inbox','Inbox'],['authored','Authored by me'],['assigned','Assigned to me'],['involved','Involves me'],['reviews','Review requests']];
const snapshotCounts = {inbox:52,authored:3,assigned:0,involved:54,reviews:50};
let provider = ['GitHub','Jira','Linear'].includes(params.get('provider')) ? params.get('provider') : 'GitHub';
let destination = 'inbox', showFrame = !params.has('embed'), sidebarTab = 'home', scope='console-1', workspace='Consola';
let selectedSession=null, stale=true, customAction='', foldedGroup=false;
const collapsed = new Set(['team','draft','ready']);
const state = Object.fromEntries(['GitHub','Jira','Linear'].map(p=>[p,{tab:p==='GitHub'?'inbox':'mine',filter:'all',query:'',days:30,selected:p==='GitHub'?'4146':p==='Jira'?'PAY-88':'WEB-142',layout:'list'}]));
const sidebarSessions = [
 {id:'research',title:'Do an in depth research ...',group:true,agent:'claude',scope:'console-1'},
 {id:'skills',title:'Skills shared across harn...',group:true,agent:'codex',scope:'console-1'},
 {id:'codebase',title:'looking at this codebase, h...',agent:'claude',scope:'console-1'},
 {id:'progress',title:'Where are we in terms of t...',agent:'claude',scope:'console-1'},
 {id:'checks',title:'check why sometime the s...',agent:'claude',scope:'console-1'},
 {id:'ideas',title:'lets figure out how can we ...',agent:'claude',scope:'console-1'},
 {id:'again',title:'try again',agent:'claude',scope:'console-1'},
 {id:'distribution',title:'Distributing Consola (Electr...',agent:'claude',scope:'console-1',active:true},
 {id:'docs',title:'Find me the documentation...',agent:'codex',scope:'console-1'},
 {id:'prototype',title:'Adapt prototype for GitHub view',agent:'codex',scope:'console-1'},
 {id:'website',title:'Update the site design to f...',agent:'codex',scope:'console-1',active:true}
];
function inView(p,view){return view==='authored'?p.author==='SymJavi':view==='assigned'?!!p.assignee:view==='reviews'?['review','team'].includes(p.section):true;}
function filtered(){const s=state[provider];return provider==='GitHub'?capturedPRs.filter(p=>(s.filter==='all'||p.repo===s.filter)&&p.days<=s.days&&inView(p,s.tab)):tickets[provider].filter(t=>(s.filter==='all'||t.project===s.filter)&&(s.tab==='mine'?t.assignee==='Javier':s.tab==='period'?t.period!=='Backlog':t.period==='Backlog')&&(t.title+' '+t.id).toLowerCase().includes(s.query.toLowerCase()));}
function chosen(){return (provider==='GitHub'?prs:tickets[provider]).find(p=>p.id===state[provider].selected);}
function defaultFilters(){return state.GitHub.filter==='all'&&state.GitHub.days===30;}
function sessionRow(s){return `<button class="session-nav-item ${selectedSession?.id===s.id?'active':''}" data-sidebar-session="${s.id}"><span class="sample-session-dot ${s.active?'working':''}"></span><span class="sample-harness ${s.agent==='claude'?'claude':''}">${s.agent==='claude'?'✳':'◎'}</span><span class="session-nav-item-text"><span class="session-nav-item-name">${esc(s.title)}</span>${sidebarTab==='all'?`<span class="session-nav-item-subtitle">${s.scope}</span>`:''}</span></button>`;}
function renderShell(){
 $('#app-header').hidden=!showFrame;$('#app-sidebar').hidden=!showFrame;
 $('#app-header').innerHTML=`<div class="app-header-sidebar"><span class="traffic-lights" aria-hidden="true"><i></i><i></i><i></i></span><button class="sidebar-toggle" data-toggle-frame aria-label="Hide sidebar">${icon('panel',16)}</button></div><div class="app-header-content"><div class="window-tools"><span>Prototype</span><button class="inbox-refresh" data-theme aria-label="Toggle light and dark theme">◐</button><button class="inbox-refresh" data-info aria-label="About this prototype">ⓘ</button></div></div>`;
 const shown=sidebarTab==='all'?sidebarSessions:sidebarSessions.filter(s=>s.scope===scope);
 $('#app-sidebar').innerHTML=`<nav class="workspace-rail" aria-label="Workspaces">${['Consola','Sympower','OpenAI','Tools','Frontend','Home'].map((w,i)=>`<button class="workspace-rail-item ${i===1?'sympower-icon':''}" data-workspace="${w}" aria-label="${w} workspace" aria-current="${workspace===w}">${i===0?'<img src="../../../src/renderer/public/icon.svg" width="34" height="34" alt="">':i===1?'S':i===2?'OP':w[0]}</button>`).join('')}<button class="workspace-rail-add" data-add-workspace aria-label="Add workspace">${icon('plus',24)}</button></nav><nav class="app-navigation" aria-label="Main navigation"><button class="app-navigation-item ${destination!=='inbox'?'active':''}" data-destination="home">${icon('home',18)}<span>Home</span></button><button class="app-navigation-item ${destination==='inbox'?'active':''}" data-destination="inbox">${icon('inbox',18)}<span>Inbox</span></button><button class="app-navigation-item app-navigation-settings" data-settings aria-label="Settings">${icon('settings',18)}</button></nav><aside class="sidebar" aria-label="Session sidebar"><div class="sidebar-workspace"><button class="workspace-menu-trigger" data-workspace-menu>${esc(workspace)} ${icon('down',14)}</button><button class="inbox-refresh" data-sidebar-settings aria-label="Navigation settings">${icon('sliders',16)}</button><button class="new-menu-trigger" data-new-session aria-label="New session">${icon('plus')}</button></div><div class="home-navigation"><div class="home-tabs"><button class="home-tab" data-sidebar-tab="home" aria-selected="${sidebarTab==='home'}">Home</button><button class="home-tab" data-sidebar-tab="all" aria-selected="${sidebarTab==='all'}">All your sessions</button></div>${sidebarTab==='home'?`<div class="sidebar-scope-picker"><div class="scope-selector">${icon('branch')}<select id="scope" aria-label="Session scope">${['console-1','flex-portal','web-app','payments-api'].map(s=>option(s,s,scope)).join('')}</select></div></div>`:''}<div class="home-session-panel">${sidebarTab==='all'?`<div class="sidebar-section"><div class="sidebar-section-header"><span class="sidebar-section-title">All scopes · ${shown.length}</span></div>${shown.map(sessionRow).join('')}</div>`:`<div class="sidebar-section"><div class="sidebar-section-header"><span class="sidebar-section-title">Your groups</span><button class="sidebar-section-button" data-new-session aria-label="New grouped session">${icon('plus')}</button></div><div class="group-nav-item"><div class="group-nav-header"><button class="group-nav-toggle" data-fold-group aria-expanded="${!foldedGroup}">${icon(foldedGroup?'right':'down')}${icon('group',15)}<span class="group-nav-name">investigations</span><span class="group-nav-count">${shown.filter(s=>s.group).length}</span></button></div>${foldedGroup?'':shown.filter(s=>s.group).map(sessionRow).join('')}</div></div><div class="sidebar-section sidebar-ungrouped"><div class="sidebar-section-header"><span class="sidebar-section-title">Ungrouped</span><button class="sidebar-section-button" data-new-session aria-label="New ungrouped session">${icon('plus')}</button></div>${shown.filter(s=>!s.group).map(sessionRow).join('')}${shown.length?'':'<p class="sidebar-empty">No sessions in this scope.</p>'}</div>`}</div></div></aside>`;
}
function render(){
 renderShell();
 decorateShell();
 if(destination==='home'){renderHome();return;}
 if(destination==='session'){renderSession();decorateSession();return;}
 if(renderInboxDestination())return;
 const s=state[provider],gh=provider==='GitHub',items=filtered();
 const tabs=gh?views:[['mine','Assigned to me'],['period',provider==='Jira'?'Current sprint':'Current cycle'],['backlog','Backlog']];
 $('#surface').innerHTML=`<div class="inbox-view"><header class="inbox-header"><h1 class="inbox-title">Inbox</h1><select id="provider" class="inbox-filter-trigger provider-picker" aria-label="Inbox source">${['GitHub','Jira','Linear'].map(p=>option(p,p,provider)).join('')}</select><div class="inbox-filters"><select id="filter" class="inbox-filter-trigger" aria-label="${gh?'Repository':'Project'}">${option('all',gh?'Select repositories':'All projects',s.filter)}${[...new Set((gh?capturedPRs:tickets[provider]).map(p=>gh?p.repo:p.project))].map(p=>option(p,p,s.filter)).join('')}</select>${gh?`<select id="updated" class="inbox-filter-trigger" aria-label="Updated since">${[[30,'Updated: Last month'],[7,'Updated: Last week'],[1,'Updated: Last day']].map(([v,l])=>option(v,l,s.days)).join('')}</select>`:`<input id="search" class="inbox-filter-trigger inbox-search" aria-label="Find ${provider} issues" placeholder="Find issues…" value="${esc(s.query)}">`}</div><div class="inbox-meta"><span class="inbox-meta-account">${gh?'SymJavi · sympower':'Javier · '+(provider==='Jira'?'Product':'Web')}</span><span class="${gh&&stale?'inbox-meta-error':''}">${gh?(stale?'GitHub unreachable · showing data from just now':'Sample refreshed just now'):'Sample '+provider+' issues'}</span><button class="inbox-refresh" data-refresh aria-label="Refresh inbox">${icon('refresh',13)}</button><button class="inbox-refresh" data-settings aria-label="Workspace settings">${icon('settings',13)}</button></div></header><nav class="inbox-view-tabs" aria-label="${provider} views">${tabs.map(([v,label])=>`<button class="inbox-view-tab ${s.tab===v?'active':''}" data-tab="${v}" aria-pressed="${s.tab===v}">${label}${gh?`<span class="inbox-view-tab-count">${defaultFilters()?snapshotCounts[v]:capturedPRs.filter(p=>(s.filter==='all'||p.repo===s.filter)&&p.days<=s.days&&inView(p,v)).length}</span>`:''}</button>`).join('')}<div class="inbox-prototype-tools">${gh?'':`<button class="inbox-filter-trigger" data-layout>${s.layout==='list'?'Board':'List'}</button>`}${!showFrame?`<button class="inbox-refresh" data-toggle-frame aria-label="Show app sidebar">${icon('panel',14)}</button>`:''}</div></nav><div class="inbox-body"><div class="inbox-main">${gh?githubList(items):ticketList(items)}</div>${chosen()?`<div class="inbox-pane-slot">${pane(chosen())}</div>`:''}</div></div>`;
}
function githubList(items){
 if(state.GitHub.tab!=='inbox')return (items.length?`<div class="inbox-list">${items.map(prRow).join('')}</div>`:'<p class="inbox-empty">Nothing here right now.</p>')+(defaultFilters()&&snapshotCounts[state.GitHub.tab]>items.length?'<p class="prototype-note">Only the PR details visible in the supplied screenshot are included in this prototype.</p>':'');
 return sections.map(([id,label])=>{const rows=items.filter(p=>p.section===id),count=id==='team'&&defaultFilters()?47:rows.length;return `<section class="inbox-section ${collapsed.has(id)?'collapsed':''}"><button class="inbox-section-toggle" data-section="${id}" aria-expanded="${!collapsed.has(id)}">${icon(collapsed.has(id)?'right':'down')}<span>${label}</span><span class="inbox-section-count">${count}</span></button>${collapsed.has(id)?'':rows.length?`<div class="inbox-list">${rows.map(prRow).join('')}</div>`:count?'<p class="prototype-note">47 team review requests in the captured view. Their individual details were outside the screenshot.</p>':''}</section>`}).join('');
}
function prRow(p){return `<div role="button" tabindex="0" class="inbox-row ${state.GitHub.selected===p.id?'selected':''} ${p.section==='review'?'inbox-row--accent':''}" data-item="${p.id}" aria-pressed="${state.GitHub.selected===p.id}">${icon('pr',14,'inbox-row-icon')}<div class="inbox-row-text"><span class="inbox-row-title">${esc(p.title)}</span><span class="inbox-row-meta"><span class="inbox-row-meta-facts">${p.repo}#${p.id} · ${p.author} · ${p.age}</span>${p.sessions.length?`<span class="inbox-row-sessions">· <span class="sample-session-dot"></span>${p.sessions.length} session${p.sessions.length===1?'':'s'}</span>`:''}</span></div><div class="inbox-row-status"><span class="inbox-row-review--${p.review==='Changes requested'?'changes-requested':p.review==='Approved'?'approved':'review-required'}">${p.review}</span><span class="inbox-row-checks inbox-row-checks--${p.failed?'bad':'ok'}">${icon(p.failed?'x':'check',11)}${p.checks}</span>${p.comments?`<span class="inbox-row-comments">${icon('comment',11)}${p.comments}</span>`:''}</div></div>`;}
function ticketList(items){
 const s=state[provider];
 if(!items.length)return '<p class="inbox-empty">No issues match this view.</p>';
 const statuses=provider==='Jira'?['To do','In progress','Done']:['Todo','In progress','In review'];
 return `<div class="${s.layout==='board'?'ticket-board':''}">${statuses.map(status=>{const group=items.filter(t=>t.status===status);return `<section class="inbox-section ticket-column"><div class="inbox-section-toggle">${icon('down')}<span>${status}</span><span class="inbox-section-count">${group.length}</span></div>${s.layout==='board'?group.map(t=>`<button class="ticket-card ${s.selected===t.id?'selected':''}" data-item="${t.id}"><span class="inbox-row-meta">${t.id}</span><span class="inbox-row-title">${t.title}</span><div class="ticket-card-footer"><span>${t.priority} · ${t.project}</span><span>${t.assignee}</span></div></button>`).join(''):group.length?`<div class="inbox-list">${group.map(t=>`<div class="inbox-row ${s.selected===t.id?'selected':''}" role="button" tabindex="0" data-item="${t.id}" aria-pressed="${s.selected===t.id}">${icon('issue',14,'inbox-row-icon inbox-row-icon--issue')}<div class="inbox-row-text"><span class="inbox-row-title">${t.id} · ${t.title}</span><span class="inbox-row-meta">${t.project} · ${t.period} · ${t.assignee}${t.sessions.length?' · '+t.sessions.length+' sessions':''}</span></div><div class="inbox-row-status"><span class="ticket-status">${status}</span><span class="ticket-priority">${t.priority}</span></div></div>`).join('')}</div>`:''}</section>`}).join('')}</div>`;
}
function pane(p){
 const gh=provider==='GitHub';
 const facts=gh?[['Review',p.review],['Checks',p.checks+' passing'+(p.failed?' · 1 failing':'')],['Diff',p.diff]]:[['Status',p.status],['Assignee',p.assignee],['Priority',p.priority],['Project',p.project],[provider==='Jira'?'Sprint':'Cycle',p.period]];
 const actions=gh?['Review','Address review','Fix CI']:['Plan','Implement','Investigate'];
 const preferred=gh?(p.section==='action'?'Address review':'Review'):'Plan';
 return `<aside class="inbox-pane" aria-label="Work item details"><div class="inbox-pane-header"><h2 class="inbox-pane-title">${esc(gh?p.title:p.id+' · '+p.title)}</h2><button class="inbox-pane-close" data-close aria-label="Close item details">${icon('x',13)}</button></div><div class="inbox-pane-meta">${gh?`sympower/${p.repo}#${p.id} · ${p.author} · <a class="inbox-pane-link" href="https://github.com/sympower/${p.repo}/pull/${p.id}" target="_blank" rel="noopener noreferrer">Open on GitHub ${icon('external',10)}</a>`:provider+' · '+p.project}</div><h3 class="inbox-pane-section-title">${provider}</h3>${facts.map(([k,v])=>`<div class="inbox-pane-kv"><span>${k}</span><span>${esc(v)}</span></div>`).join('')}${!gh?`<h3 class="inbox-pane-section-title">Description</h3><p class="inbox-pane-description">${p.description}</p>`:''}<h3 class="inbox-pane-section-title">Sessions · ${p.sessions.length}</h3>${p.sessions.length?p.sessions.map((name,i)=>`<div class="inbox-pane-session-row"><div class="inbox-pane-session-text"><span class="inbox-pane-session-label">${esc(name)}</span><span class="inbox-pane-session-sub">${gh?p.repo:'Linked to '+p.id}</span></div><button class="inbox-pane-open" data-session="${i}">Open</button></div>`).join(''):'<p class="inbox-pane-empty">No sessions on this item yet.</p>'}<button class="inbox-pane-secondary" data-link>Link existing session…</button><h3 class="inbox-pane-section-title">Start a session</h3><div class="inbox-pane-actions">${actions.map(a=>`<button class="inbox-pane-action ${a===preferred?'inbox-pane-action--default':''}" data-start="${a}">${a}</button>`).join('')}</div><button class="inbox-pane-secondary" data-start="Custom prompt">Custom prompt…</button>${!gh&&p.linked?`<h3 class="inbox-pane-section-title">Linked pull requests</h3><p class="inbox-pane-description">${p.linked}</p>${p.id==='PAY-88'?'<button class="inbox-pane-reference" data-related-pr="4131">'+icon('pr')+'web-app #4131 · Open PR details →</button>':''}<p class="inbox-pane-hint">Ticket status and PR review state are kept separately.</p>`:''}${gh&&p.track?`<h3 class="inbox-pane-section-title">Linked ticket</h3><button class="inbox-pane-reference" data-related-ticket="PAY-88">${icon('issue')}Jira · PAY-88 · In progress →</button>`:''}</aside>`;
}
function renderHome(){
 $('#surface').innerHTML=`<div class="home-composer"><h1>What should we build in ${esc(workspace)}?</h1><form id="compose" class="home-compose-box"><textarea id="home-prompt" aria-label="Message" placeholder="Describe a task, ask a question, or explore an idea…"></textarea><div class="home-compose-controls"><select aria-label="Agent"><option>Codex</option><option>Claude Code</option></select><select aria-label="Model"><option>Default model</option></select><select id="home-scope" aria-label="Working scope">${['console-1','flex-portal','web-app','payments-api'].map(s=>option(s,s,scope)).join('')}</select><button type="submit" aria-label="Send message">↑</button></div></form><p class="prototype-note">Prototype · Sending creates a local sample session.</p></div>`;
}
function renderSession(){
 $('#surface').innerHTML=`<div class="session-context-header"><span>${esc(workspace)}</span><span>/</span><span class="session-context-name">${esc(selectedSession.title)}</span><span class="session-context-scope">${esc(selectedSession.scope||scope)}</span><button class="inbox-pane-open" data-destination="inbox">Back to Inbox</button></div><div class="session-preview"><h1>${esc(selectedSession.title)}</h1><p class="prototype-note">${esc(selectedSession.item||'Local session')} · ${esc(selectedSession.scope||scope)}</p><pre>› ${esc(selectedSession.prompt||'Continue this session.')}</pre><p class="prototype-note">Session preview. No agent or terminal is connected.</p></div>`;
}
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>$('#toast').hidden=true,3600);}
function dialog(title,body,action='close',label='Done'){
 $('#dialog').innerHTML=`<form method="dialog"><h2>${esc(title)}</h2>${body}<footer><button class="inbox-pane-secondary" value="cancel">Cancel</button><button type="button" class="inbox-pane-action inbox-pane-action--default" data-confirm="${action}">${label}</button></footer></form>`;
 $('#dialog').showModal();
}
function openSampleSession(p,index){
 const title=p.sessions[index],existing=sidebarSessions.find(s=>s.title===title&&s.item===provider+' '+p.id);
 selectedSession=existing||{id:'linked-'+provider+'-'+p.id+'-'+index,title,scope:provider==='GitHub'?p.repo:provider==='Jira'?'payments-api':'web-app',item:provider+' '+p.id,agent:'codex'};
 if(!existing)sidebarSessions.push(selectedSession);
 scope=selectedSession.scope;destination='session';render();
}
function about(){dialog('Inbox prototype',`<p>This prototype keeps Consola’s workspace rail, Home / Inbox navigation and session sidebar. Its frame, theme, rows and detail pane load the application’s actual CSS.</p><p>Switch GitHub, Jira and Linear in the Inbox header. GitHub preserves the visible PRs and initial counts from your screenshot. Jira and Linear are sample ticket proposals with their own workflow states, sprint/cycle filters and Plan / Implement actions.</p><p>For a connected example, select Jira PAY-88 and open its linked PR. The GitHub review details appear here in the same Inbox, with a link back to the ticket.</p><p>Session actions change browser memory only. Reload resets the sample. No provider sync or agent execution takes place.</p>`);}
document.addEventListener('click',e=>{
 const b=e.target.closest('button,[data-item]');if(!b)return;
 const s=state[provider],p=chosen();
 if(b.dataset.tab){s.tab=b.dataset.tab;render();}
 else if(b.dataset.section){collapsed.has(b.dataset.section)?collapsed.delete(b.dataset.section):collapsed.add(b.dataset.section);render();}
 else if(b.dataset.item){s.selected=s.selected===b.dataset.item?null:b.dataset.item;render();}
 else if(b.hasAttribute('data-close')){s.selected=null;render();}
 else if(b.hasAttribute('data-layout')){s.layout=s.layout==='list'?'board':'list';render();}
 else if(b.hasAttribute('data-refresh')){stale=false;render();toast('Sample refreshed. No service request was made.');}
 else if(b.hasAttribute('data-toggle-frame')){showFrame=!showFrame;render();}
 else if(b.hasAttribute('data-theme')){document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';}
 else if(b.hasAttribute('data-info'))about();
 else if(b.dataset.destination){destination=b.dataset.destination;selectedSession=null;render();}
 else if(b.dataset.sidebarTab){sidebarTab=b.dataset.sidebarTab;renderShell();decorateShell();}
 else if(b.hasAttribute('data-fold-group')){foldedGroup=!foldedGroup;renderShell();decorateShell();}
 else if(b.dataset.sidebarSession){selectedSession=sidebarSessions.find(s=>s.id===b.dataset.sidebarSession);scope=selectedSession.scope;destination='session';render();}
 else if(b.dataset.workspace){workspace=b.dataset.workspace;render();}
 else if(b.hasAttribute('data-workspace-menu')){dialog('Workspace',`<p>Choose the sample workspace shown in the app frame.</p><label for="workspace-choice">Workspace</label><select id="workspace-choice">${['Consola','Sympower','OpenAI','Tools','Frontend','Home'].map(w=>option(w,w,workspace)).join('')}</select>`,'workspace','Switch workspace');}
 else if(b.hasAttribute('data-add-workspace')){dialog('Add workspace','<p>Workspace creation is outside this Inbox prototype. Use the existing workspace icons to compare the frame.</p>');}
 else if(b.hasAttribute('data-settings')){dialog('Workspace settings',`<p>${esc(workspace)} · Connections</p><p>GitHub — captured inbox sample<br>Jira — proposed issue browser<br>Linear — proposed issue browser</p><p>Session actions are configured per item type: Review / Address review / Fix CI for PRs; Plan / Implement / Investigate for tickets.</p>`);}
 else if(b.hasAttribute('data-sidebar-settings')){dialog('Navigation settings','<p>Home keeps scope groups and Ungrouped sessions. All your sessions spans the workspace.</p><p>Changing the Inbox provider keeps this sidebar in place.</p>');}
 else if(b.hasAttribute('data-new-session')){destination='home';selectedSession=null;render();$('#home-prompt').focus();}
 else if(b.dataset.relatedPr){provider='GitHub';state.GitHub.selected=b.dataset.relatedPr;render();}
 else if(b.dataset.relatedTicket){provider='Jira';state.Jira.selected=b.dataset.relatedTicket;state.Jira.tab='mine';state.Jira.filter='all';state.Jira.query='';render();}
 else if(b.dataset.start){
  customAction=b.dataset.start;
  dialog(`${customAction} · ${p.id}`,`<p>Start a sample session with this ${provider==='GitHub'?'pull request':'ticket'} as context.</p><label for="repo">Repository</label><select id="repo">${(provider==='GitHub'?[p.repo]:provider==='Jira'?['payments-api','web-app']:['web-app']).map(r=>option(r,r,'')).join('')}</select><label for="prompt">Prompt</label><textarea id="prompt" rows="4">${esc(customAction==='Custom prompt'?'':customAction+': '+p.title)}</textarea><p>No agent will run. The sample session appears in the existing session sidebar.</p>`,'start','Start sample session');
 }
 else if(b.hasAttribute('data-link')){dialog('Link existing session',`<p>Link a session to ${esc(p.id)}.</p><label for="existing">Session</label><select id="existing">${sidebarSessions.map(s=>option(s.id,s.title,'')).join('')}</select>`,'link','Link session');}
 else if(b.dataset.session!==undefined)openSampleSession(p,Number(b.dataset.session));
 else if(b.dataset.confirm){
  const action=b.dataset.confirm;
  if(action==='start'){
   const prompt=$('#prompt').value.trim();if(!prompt){$('#prompt').focus();return;}
   const session={id:'sample-'+Date.now(),title:customAction+' · '+p.id,scope:$('#repo').value,item:provider+' '+p.id,prompt,agent:'codex'};
   sidebarSessions.push(session);p.sessions.push(session.title);attachProviderSession(session,p);selectedSession=session;scope=session.scope;destination='session';
  }else if(action==='link'){
   const session=sidebarSessions.find(s=>s.id===$('#existing').value);if(!p.sessions.includes(session.title))p.sessions.push(session.title);session.item=provider+' '+p.id;attachProviderSession(session,p);
  }else if(action==='workspace')workspace=$('#workspace-choice').value;
  $('#dialog').close();render();if(action==='link')toast('Session linked in this prototype.');
 }
});
document.addEventListener('change',e=>{
 const s=state[provider];
 if(e.target.id==='provider'){provider=e.target.value;inboxPage='source';}
 else if(e.target.id==='filter')s.filter=e.target.value;
 else if(e.target.id==='updated')s.days=Number(e.target.value);
 else if(e.target.id==='scope'){scope=e.target.value;renderShell();decorateShell();return;}
 else return;
 render();
});
document.addEventListener('input',e=>{
 if(e.target.id==='search'){state[provider].query=e.target.value;const pos=e.target.selectionStart;render();$('#search').focus();$('#search').setSelectionRange(pos,pos);}
});
document.addEventListener('submit',e=>{
 if(e.target.id!=='compose')return;e.preventDefault();
 const prompt=$('#home-prompt').value.trim();if(!prompt)return;
 selectedSession={id:'sample-'+Date.now(),title:prompt.split('\n')[0],prompt,scope:$('#home-scope').value,agent:'codex'};
 sidebarSessions.push(selectedSession);scope=selectedSession.scope;destination='session';render();
});
document.addEventListener('keydown',e=>{
 if(e.target.matches('[data-item]')&&['Enter',' '].includes(e.key)){e.preventDefault();e.target.click();}
 if(e.key==='Escape'&&!$('#dialog').open){state[provider].selected=null;if(destination==='inbox')render();}
});
