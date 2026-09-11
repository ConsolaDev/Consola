// Alternative Inbox navigation within the existing Consola frame. All changes
// are local sample data; connectors and agent execution are not connected.
let navModel = ['workflow','integrations','trackers'].includes(params.get('nav')) ? params.get('nav') : 'workflow';
let inboxPage = params.has('provider') ? 'source' : 'attention';
let activeContext = 'payments', contextTab = 'overview', contextFilter = 'active', workSearch = '', attentionTab = 'open';
let activeIntegration = null, pendingSourceItem = null;
const expandedContexts = new Set(['payments']);
const connections = [
 {id:'github',name:'GitHub',category:'code',detail:'sympower · Pull requests & issues',health:'Cached',native:true},
 {id:'jira',name:'Jira',category:'tickets',detail:'Product · Projects & issues',health:'Sample',native:true},
 {id:'linear',name:'Linear',category:'tickets',detail:'Web · Teams & cycles',health:'Sample',native:true}
];
const catalog = [
 {id:'gitlab',name:'GitLab',category:'code',detail:'Merge requests & pipelines'},
 {id:'bitbucket',name:'Bitbucket',category:'code',detail:'Pull requests & builds'},
 {id:'azure',name:'Azure DevOps',category:'code',detail:'Pull requests & work items'},
 {id:'asana',name:'Asana',category:'tickets',detail:'Projects & tasks'},
 {id:'slack',name:'Slack',category:'context',detail:'Discussions & saved references'},
 {id:'notion',name:'Notion',category:'context',detail:'Documents & decisions'},
 {id:'custom',name:'Custom integration',category:'context',detail:'Bring another source into the workspace'}
];
const contexts = [
 {id:'payments',key:'PAY-88',title:'Make payment retries safe',status:'Needs you',bucket:'active',outcome:'Retry failed payments without charging a customer twice. Keep API and displayed amounts consistent.',next:'Address rounding feedback in the web PR.',decision:'Keep the original idempotency key. Round only at the display boundary.',refs:[
  {id:'jira:PAY-88',provider:'Jira',sourceId:'PAY-88',kind:'ticket',role:'Defines',title:'Make payment retries safe',status:'In progress'},
  {id:'github:4108',provider:'GitHub',sourceId:'4108',kind:'code',role:'Implements',title:'payments-api #4108 · Preserve retry keys',status:'Merged'},
  {id:'github:4131',provider:'GitHub',sourceId:'4131',kind:'code',role:'Implements',title:'web-app #4131 · Safe retry confirmation',status:'Changes requested'},
  {id:'reference:policy',provider:'Saved link',kind:'context',role:'Discusses',title:'Retry-policy discussion',status:'Saved reference',url:'https://example.com/retry-policy'}
 ],sessionIds:['ctx-plan','ctx-api','ctx-review'],notes:[],events:['Jira PAY-88 linked as the work definition.','API PR #4108 merged. Web PR #4131 remains open.','Review session requested a decision on rounding.'],suggestion:'pending'},
 {id:'onboarding',key:'WEB-142',title:'Simplify workspace onboarding',status:'Waiting on Maya',bucket:'waiting',outcome:'Help a new workspace reach its first useful session with fewer setup steps.',next:'Wait for Maya to review the revised onboarding flow.',decision:'Keep repository setup optional until the first coding task.',refs:[
  {id:'linear:WEB-142',provider:'Linear',sourceId:'WEB-142',kind:'ticket',role:'Defines',title:'Simplify workspace onboarding',status:'In review'},
  {id:'github:4190',provider:'GitHub',sourceId:'4190',kind:'code',role:'Implements',title:'web-app #4190 · Revised onboarding flow',status:'Awaiting approval'}
 ],sessionIds:['ctx-onboarding'],notes:[],events:['Linear issue and GitHub PR linked to one tracker.'],suggestion:'none'},
 {id:'cache',key:'LOCAL',title:'Investigate the cache memory spike',status:'Ready to continue',bucket:'active',outcome:'Find the cause of the overnight memory growth before selecting a fix.',next:'Compare retained objects in the latest heap profiles.',decision:'Capture evidence before choosing a cache limit.',refs:[{id:'reference:heap',provider:'Local',kind:'context',role:'Evidence',title:'Overnight heap comparison',status:'Saved note'}],sessionIds:['ctx-cache'],notes:[],events:['Tracker created from a local investigation. No ticket required.'],suggestion:'none'}
];
sidebarSessions.push(
 {id:'ctx-plan',title:'Plan retry behavior',scope:'payments-api',agent:'codex',track:'payments',item:'Jira PAY-88',prompt:'Plan safe retries with a stable idempotency key.'},
 {id:'ctx-api',title:'Implement API',scope:'payments-api',agent:'claude',track:'payments',item:'GitHub 4108',prompt:'Preserve the original retry key in the API.'},
 {id:'ctx-review',title:'Address rounding feedback',scope:'web-app',agent:'codex',track:'payments',item:'GitHub 4131',prompt:'Address the rounding feedback in PR #4131. Use the same display boundary across clients.'},
 {id:'ctx-onboarding',title:'Revise onboarding flow',scope:'web-app',agent:'codex',track:'onboarding',item:'Linear WEB-142'},
 {id:'ctx-cache',title:'Compare heap profiles',scope:'console-1',agent:'claude',track:'cache'}
);
const attention = [
 {id:'rounding',track:'payments',title:'Make payment retries safe',reason:'Changes requested on #4131 · Review session needs a decision',source:'GitHub + session',state:'open',age:'8m'},
 {id:'review',sourceId:'4146',provider:'GitHub',title:capturedPRs[0].title,reason:'Your review was requested',source:'GitHub · flex-portal #4146',state:'open',age:'2h'},
 {id:'mention',track:'onboarding',title:'Simplify workspace onboarding',reason:'Maya mentioned you in the design discussion',source:'Linear · WEB-142',state:'open',age:'2h'}
];
const modelLabels = {workflow:'A · Workflow first',integrations:'B · Integrations first',trackers:'C · Tracker first'};
const modelDescriptions = {
 workflow:'Attention and tracked work lead the sidebar. Integrations remain direct entry points below. Best starting point for work that crosses services.',
 integrations:'Each connection exposes its own views. Shared trackers sit below the integrations. Familiar when you start by choosing a service; the sidebar grows with connections.',
 trackers:'Outcomes lead the sidebar, with their tickets, code and sessions nested underneath. Strong continuity while working; a long tracker list needs filtering and folding.'
};
const contextById = id => contexts.find(t=>t.id===id);
const refContext = (source,id) => contexts.find(t=>t.refs.some(r=>r.provider===source&&r.sourceId===id));
const connectionIcon = c => c.category==='code'?'pr':c.category==='tickets'?'issue':'comment';
function sidebarButton(label,attr,active=false,glyph='inbox',count=''){
 return `<button class="inbox-nav-row ${active?'active':''}" ${attr}>${icon(glyph,15)}<span>${esc(label)}</span>${count!==''?`<small>${count}</small>`:''}</button>`;
}
function navSection(title,body,action=''){
 return `<section class="inbox-nav-section"><div class="inbox-nav-heading"><span>${title}</span>${action}</div>${body}</section>`;
}
function connectionRows(nested=false){
 return connections.map(c=>{
  const selected=inboxPage===(c.native?'source':'integration')&&(c.native?provider===c.name:activeIntegration===c.id);
  return sidebarButton(c.name,`data-open-integration="${c.id}"`,selected,connectionIcon(c))+ (nested?`<div class="inbox-nav-children">${(c.category==='code'?['Review requests','Authored by me']:c.category==='tickets'?['Assigned to me',c.id==='linear'?'Current cycle':'Current sprint']:['Saved references']).map((v,i)=>`<button data-open-integration="${c.id}" data-connection-view="${i}">${v}</button>`).join('')}</div>`:'');
 }).join('');
}
function trackerTree(){
 return contexts.filter(t=>t.bucket!=='finished').map(t=>`<div class="tracker-tree"><div class="tracker-tree-heading"><button class="inbox-refresh" data-fold-context="${t.id}" aria-label="Toggle ${esc(t.title)}" aria-expanded="${expandedContexts.has(t.id)}">${icon(expandedContexts.has(t.id)?'down':'right',12)}</button><button class="inbox-nav-row ${inboxPage==='context'&&activeContext===t.id?'active':''}" data-open-context="${t.id}"><span>${esc(t.title)}</span></button></div>${expandedContexts.has(t.id)?`<div class="inbox-nav-children">${t.refs.slice(0,3).map(r=>`<button data-open-ref="${esc(r.id)}" data-context-id="${t.id}">${icon(r.kind==='code'?'pr':r.kind==='ticket'?'issue':'comment',12)}<span>${esc(r.sourceId?r.provider+' · '+r.sourceId:r.title)}</span></button>`).join('')}${t.sessionIds.map(id=>sidebarSessions.find(s=>s.id===id)).filter(Boolean).map(s=>`<button data-context-session="${s.id}">${icon('panel',12)}<span>${esc(s.title)}</span></button>`).join('')}</div>`:''}</div>`).join('');
}
function decorateShell(){
 $('.window-tools').innerHTML=`<label for="nav-model">Compare Inbox</label><select id="nav-model" aria-label="Inbox navigation alternative">${Object.entries(modelLabels).map(([v,l])=>option(v,l,navModel)).join('')}</select><button class="inbox-refresh" data-compare-info aria-label="Compare navigation alternatives">ⓘ</button><button class="inbox-refresh" data-theme aria-label="Toggle theme">◐</button>`;
 $('.app-header-content').insertAdjacentHTML('afterbegin','<button class="inbox-refresh mobile-inbox-nav" data-mobile-nav aria-label="Toggle Inbox navigation">'+icon('panel',16)+'</button>');
 if(destination!=='inbox')return;
 const sidebar=$('#app-sidebar .sidebar');sidebar.setAttribute('aria-label','Inbox navigation');
 const n=attention.filter(a=>a.state==='open').length;
 const attentionNav=sidebarButton('Needs attention','data-inbox-page="attention"',inboxPage==='attention','inbox',n);
 const tracksNav=sidebarButton('Tracked work','data-inbox-page="trackers"',inboxPage==='trackers','group',contexts.filter(t=>t.bucket!=='finished').length);
 let body='';
 if(navModel==='workflow')body=navSection('Inbox',attentionNav+tracksNav+sidebarButton('Unlinked items','data-inbox-page="unlinked"',inboxPage==='unlinked','branch'))+navSection('Integrations',connectionRows())+navSection('Pinned trackers',contexts.slice(0,2).map(t=>sidebarButton(t.title,`data-open-context="${t.id}"`,inboxPage==='context'&&activeContext===t.id,'group')).join(''));
 else if(navModel==='integrations')body=navSection('Across integrations',attentionNav)+navSection('Integrations',connectionRows(true))+navSection('Shared context',tracksNav+sidebarButton('Unlinked items','data-inbox-page="unlinked"',inboxPage==='unlinked','branch'));
 else body=navSection('Inbox',attentionNav)+navSection('Active trackers',trackerTree(),`<button class="inbox-refresh" data-create-context aria-label="New tracker">${icon('plus')}</button>`)+sidebarButton('All tracked work','data-inbox-page="trackers"',inboxPage==='trackers','group')+navSection('Sources',connectionRows()+sidebarButton('Unlinked items','data-inbox-page="unlinked"',inboxPage==='unlinked','branch'));
 sidebar.innerHTML=`<div class="sidebar-workspace"><button class="workspace-menu-trigger" data-workspace-menu>${esc(workspace)} ${icon('down',14)}</button><button class="inbox-refresh" data-create-context aria-label="New tracker">${icon('plus',16)}</button></div><div class="inbox-sidebar-title">Inbox <span>Work & context</span></div><div class="inbox-nav-scroll">${body}</div><div class="inbox-nav-footer">${sidebarButton('Add integration','data-add-integration',false,'plus')}${sidebarButton('Manage integrations','data-inbox-page="connections"',inboxPage==='connections','settings')}</div>`;
}
function heading(title,subtitle,action=''){
 return `<header class="work-heading"><div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${action}</header>`;
}
function renderInboxDestination(){
 if(inboxPage==='source')return false;
 if(inboxPage==='attention')renderAttention();
 else if(inboxPage==='trackers')renderTrackers();
 else if(inboxPage==='context')renderContext();
 else if(inboxPage==='connections')renderConnections();
 else if(inboxPage==='integration')renderIntegration();
 else if(inboxPage==='unlinked')renderUnlinked();
 return true;
}
function renderAttention(){
 const signals=attention.filter(a=>a.state===attentionTab);
 $('#surface').innerHTML=`<div class="work-page">${heading('Needs attention','Requests and updates across your work.')}<nav class="inbox-view-tabs work-tabs"><button class="inbox-view-tab ${attentionTab==='open'?'active':''}" data-attention-tab="open">Needs attention <span class="inbox-view-tab-count">${attention.filter(a=>a.state==='open').length}</span></button><button class="inbox-view-tab ${attentionTab==='handled'?'active':''}" data-attention-tab="handled">Handled</button></nav><div class="work-page-scroll">${signals.map(a=>`<article class="attention-row"><button class="attention-content" ${a.track?`data-open-context="${a.track}"`:`data-open-native="${a.provider}" data-native-id="${a.sourceId}"`}>${icon(a.track?'group':'pr',16)}<span><strong>${esc(a.title)}</strong><span>${esc(a.reason)}</span><small>${esc(a.source)} · ${a.age} ago${a.track?' · Tracked':' · Not tracked'}</small></span></button><button class="inbox-pane-secondary" data-handle="${a.id}">${attentionTab==='open'?'Handled':'Return to attention'}</button></article>`).join('')||'<p class="prototype-note">Nothing here right now. Your tracked work remains in the sidebar.</p>'}<p class="work-footnote">Handling an update clears the interruption. It keeps the tracker, source items, and session history.</p></div></div>`;
}
function renderTrackers(){
 const shown=contexts.filter(t=>(contextFilter==='active'?t.bucket!=='finished':t.bucket===contextFilter)&&(t.title+' '+t.key).toLowerCase().includes(workSearch.toLowerCase()));
 $('#surface').innerHTML=`<div class="work-page">${heading('Tracked work','One outcome, with its tickets, code, discussions and sessions.',`<button class="inbox-pane-action inbox-pane-action--default" data-create-context>New tracker</button>`)}<nav class="inbox-view-tabs work-tabs">${['active','waiting','finished'].map(t=>`<button class="inbox-view-tab ${contextFilter===t?'active':''}" data-context-filter="${t}">${t[0].toUpperCase()+t.slice(1)}</button>`).join('')}</nav><div class="work-page-scroll"><input class="inbox-filter-trigger work-search" id="work-search" aria-label="Find tracked work" placeholder="Find tracked work…" value="${esc(workSearch)}"><div class="inbox-list">${shown.map(t=>`<div role="button" tabindex="0" class="inbox-row context-list-row" data-open-context="${t.id}">${icon('group',15,'inbox-row-icon')}<div class="inbox-row-text"><span class="inbox-row-title">${esc(t.title)}</span><span class="context-next">${esc(t.next)}</span><span class="inbox-row-meta">${esc(t.key)} · ${t.refs.filter(r=>r.kind==='ticket').length} tickets · ${t.refs.filter(r=>r.kind==='code').length} code changes · ${t.sessionIds.length} sessions</span></div><span class="context-state">${esc(t.status)}</span></div>`).join('')}</div>${shown.length?'':'<p class="prototype-note">No trackers match this view.</p>'}<p class="work-footnote">A tracker can start with a ticket, a PR, a session, or just an outcome. Related items keep their own status.</p></div></div>`;
}
function refRow(t,r,removable=false){
 return `<div class="context-ref-row"><button data-open-ref="${esc(r.id)}" data-context-id="${t.id}">${icon(r.kind==='code'?'pr':r.kind==='ticket'?'issue':'comment',15)}<span><strong>${esc(r.title)}</strong><small>${esc(r.provider)}${r.sourceId?' · '+esc(r.sourceId):''} · ${esc(r.role)}</small></span><span class="ref-status">${esc(r.status)}</span></button>${removable?`<button class="inbox-refresh" data-unlink-ref="${esc(r.id)}" aria-label="Unlink ${esc(r.title)}">${icon('x',12)}</button>`:''}</div>`;
}
function renderContext(){
 const t=contextById(activeContext);if(!t){inboxPage='trackers';renderTrackers();return;}
 const sessions=t.sessionIds.map(id=>sidebarSessions.find(s=>s.id===id)).filter(Boolean);
 const tabs=`<nav class="inbox-view-tabs work-tabs">${['overview','links','activity'].map(v=>`<button class="inbox-view-tab ${contextTab===v?'active':''}" data-context-tab="${v}">${v[0].toUpperCase()+v.slice(1)}</button>`).join('')}</nav>`;
 let body='';
 if(contextTab==='overview')body=`<div class="context-columns"><section><div class="context-block next-step"><div class="context-label">Next step · ${esc(t.status)}</div><h2>${esc(t.next)}</h2><div class="context-buttons">${sessions.length?`<button class="inbox-pane-action inbox-pane-action--default" data-context-session="${sessions.find(s=>s.id==='ctx-review')?.id||sessions[0].id}">Resume session</button>`:''}<button class="inbox-pane-action" data-start-context>Start session…</button></div></div><div class="context-block"><div class="context-label">Outcome</div><p>${esc(t.outcome)}</p></div><div class="context-block"><div class="context-label">Latest decision</div><p>${esc(t.notes.at(-1)||t.decision)}</p><button class="inbox-pane-secondary" data-context-note>Add handoff note</button></div><div class="context-block"><div class="context-block-heading"><h2>Sessions</h2><span>${sessions.length}</span></div>${sessions.map(s=>`<div class="context-session-row"><span>${icon('panel',15)}</span><div><strong>${esc(s.title)}</strong><small>${esc(s.agent==='claude'?'Claude Code':'Codex')} · ${esc(s.scope)}</small></div><button class="inbox-pane-open" data-context-session="${s.id}">Open</button></div>`).join('')||'<p class="prototype-note">No sessions yet.</p>'}<button class="inbox-pane-secondary" data-attach-session>Link existing session…</button></div></section><aside><div class="context-block"><div class="context-block-heading"><h2>Connected context</h2><button class="inbox-refresh" data-link-reference aria-label="Link artifact">${icon('plus')}</button></div>${t.refs.map(r=>refRow(t,r)).join('')}<button class="inbox-pane-secondary" data-context-tab="links">Manage links</button></div><div class="context-block"><div class="context-label">Tracker status</div><p>${esc(t.status)}</p><button class="inbox-pane-secondary" data-finish-context>${t.bucket==='finished'?'Reopen tracker':'Mark tracker finished'}</button><p class="prototype-note">Local tracking state. Source tickets and code reviews keep their own lifecycle.</p></div></aside></div>`;
 else if(contextTab==='links')body=`<div class="context-block"><div class="context-block-heading"><h2>Artifacts and their roles</h2><button class="inbox-pane-action" data-link-reference>Link artifact…</button></div>${t.refs.map(r=>refRow(t,r,true)).join('')}<p class="prototype-note">A ticket defines the work; a PR or merge request implements it; a discussion supplies context. Linking them does not merge their identities.</p></div>${t.suggestion==='pending'?`<div class="context-block next-step"><div class="context-label">Suggested reference · Needs confirmation</div><h2>September release coordination</h2><p>This discussion mentions PAY-88 and OPS-61. A mention alone does not establish that it belongs to this tracker.</p><div class="context-buttons"><button class="inbox-pane-action" data-suggestion="accept">Attach as reference</button><button class="inbox-pane-action" data-suggestion="reject">Not related</button></div></div>`:t.suggestion==='rejected'?'<p class="prototype-note">Suggestion rejected. It stays suppressed until the sample is reset.</p>':''}`;
 else body=`<div class="context-block"><h2>Decisions and handoffs</h2><div class="context-timeline">${[...t.events].reverse().map((event,i)=>`<div><small>${i===0?'Latest':'Earlier'}</small><p>${esc(event)}</p></div>`).join('')}</div></div>`;
 $('#surface').innerHTML=`<div class="work-page">${heading(t.title,'Tracker · '+t.key+' · '+t.refs.length+' artifacts · '+t.sessionIds.length+' sessions',`<button class="inbox-pane-action" data-inbox-page="trackers">All tracked work</button>`)}${tabs}<div class="work-page-scroll">${body}</div></div>`;
}
function renderConnections(){
 $('#surface').innerHTML=`<div class="work-page">${heading('Integrations','Connected sources contribute items, actions and context to this workspace.',`<button class="inbox-pane-action inbox-pane-action--default" data-add-integration>Add integration</button>`)}<div class="work-page-scroll"><div class="connection-list">${connections.map(c=>`<div class="connection-row">${icon(connectionIcon(c),20)}<div><h2>${esc(c.name)}</h2><p>${esc(c.detail)}</p><small>${c.category==='code'?'Code reviews & checks':c.category==='tickets'?'Work planning':'Knowledge & conversations'} · ${c.health}</small></div><button class="inbox-pane-action" data-open-integration="${c.id}">Browse</button><button class="inbox-refresh" data-configure-connection="${c.id}" aria-label="Configure ${esc(c.name)}">${icon('settings')}</button></div>`).join('')}</div><p class="work-footnote">Integrations add source views to the sidebar. Trackers provide shared context across any combination of services.</p></div></div>`;
}
function genericItems(c){
 if(c.items)return c.items;
 c.items=[{id:c.id+'-sample',provider:c.name,sourceId:c.category==='code'?'!87':c.category==='tickets'?'TASK-24':'REF-12',kind:c.category==='code'?'code':c.category==='tickets'?'ticket':'context',role:c.category==='code'?'Implements':c.category==='tickets'?'Defines':'Reference',title:c.category==='code'?'Limit cache growth during batch processing':c.category==='tickets'?'Investigate cache memory growth':'Cache investigation notes',status:c.category==='code'?'Review required':c.category==='tickets'?'In progress':'Saved reference'}];
 return c.items;
}
function renderIntegration(){
 const c=connections.find(c=>c.id===activeIntegration);if(!c)return;
 const items=genericItems(c),r=items[0],t=contexts.find(t=>t.refs.some(ref=>ref.id===r.id));
 $('#surface').innerHTML=`<div class="work-page">${heading(c.name,c.detail,`<button class="inbox-pane-action" data-add-integration>Add integration</button>`)}<div class="inbox-view-tabs"><span class="inbox-view-tab active">${c.category==='code'?'Review requests':c.category==='tickets'?'Assigned to me':'Saved references'}</span></div><div class="inbox-body"><div class="inbox-main"><div class="inbox-list"><div class="inbox-row selected">${icon(connectionIcon(c),14,'inbox-row-icon')}<div class="inbox-row-text"><span class="inbox-row-title">${esc(r.sourceId)} · ${esc(r.title)}</span><span class="inbox-row-meta">${esc(c.name)} · Sample item</span></div><span class="context-state">${r.status}</span></div></div><p class="prototype-note">Illustrative ${esc(c.name)} data. This connection has not contacted an external service.</p></div><div class="inbox-pane-slot"><aside class="inbox-pane"><h2 class="inbox-pane-title">${esc(r.title)}</h2><p class="inbox-pane-meta">${esc(c.name)} · ${r.sourceId}</p><h3 class="inbox-pane-section-title">${c.category==='code'?'Review':c.category==='tickets'?'Workflow':'Reference'}</h3><div class="inbox-pane-kv"><span>Status</span><span>${r.status}</span></div><h3 class="inbox-pane-section-title">Tracker / context</h3>${t?`<button class="inbox-pane-reference" data-open-context="${t.id}">${icon('group')} ${esc(t.title)} →</button>`:'<p class="inbox-pane-empty">Not linked to a tracker.</p><button class="inbox-pane-action" data-track-generic>Link to tracker…</button>'}<h3 class="inbox-pane-section-title">Session</h3><button class="inbox-pane-action inbox-pane-action--default" data-generic-session>${c.category==='code'?'Review':c.category==='tickets'?'Plan':'Explore context'}…</button></aside></div></div></div>`;
}
function renderUnlinked(){
 const refs=capturedPRs.filter(p=>!refContext('GitHub',p.id));
 $('#surface').innerHTML=`<div class="work-page">${heading('Unlinked items','Review independently, or attach an item to a tracker when it belongs to ongoing work.')}<div class="work-page-scroll"><div class="inbox-list">${refs.map(p=>`<div role="button" tabindex="0" class="inbox-row" data-open-native="GitHub" data-native-id="${p.id}">${icon('pr',14,'inbox-row-icon')}<div class="inbox-row-text"><span class="inbox-row-title">${esc(p.title)}</span><span class="inbox-row-meta">GitHub · ${p.repo}#${p.id} · ${p.sessions.length} sessions</span></div><span class="context-state">Not tracked</span></div>`).join('')}</div><p class="work-footnote">Importing an item or receiving a review request does not automatically create a tracker.</p></div></div>`;
}
const nativePane = pane;
pane = function(p){
 const t=refContext(provider,p.id);
 return nativePane(p).replace('</aside>',`<h3 class="inbox-pane-section-title">Tracker / context</h3>${t?`<button class="inbox-pane-reference" data-open-context="${t.id}">${icon('group',14)} ${esc(t.title)} →</button>`:'<p class="inbox-pane-empty">This item can stay independent.</p><button class="inbox-pane-secondary" data-track-native>Link to tracker…</button>'}</aside>`);
};
function attachProviderSession(session,p){const t=refContext(provider,p.id);if(t){session.track=t.id;if(!t.sessionIds.includes(session.id))t.sessionIds.push(session.id);}}
function decorateSession(){
 const t=contextById(selectedSession.track)||contexts.find(t=>t.sessionIds.includes(selectedSession.id))||refContext(...(selectedSession.item||'').split(' '));
 if(!t)return;
 selectedSession.track=t.id;if(!t.sessionIds.includes(selectedSession.id))t.sessionIds.push(selectedSession.id);
 const preview=$('.session-preview');
 const wrapper=document.createElement('div');wrapper.className='session-with-context';preview.replaceWith(wrapper);wrapper.append(preview);
 wrapper.insertAdjacentHTML('beforeend',`<aside class="session-track-context"><div class="context-label">Tracker context</div><h2>${esc(t.title)}</h2><p>${esc(t.outcome)}</p><div class="context-label">Next step</div><p>${esc(t.next)}</p><div class="context-label">Latest decision</div><p>${esc(t.notes.at(-1)||t.decision)}</p><div class="context-label">Connected items</div>${t.refs.slice(0,3).map(r=>`<div class="session-context-ref"><strong>${esc(r.provider)} · ${esc(r.sourceId||r.title)}</strong><small>${esc(r.role)} · ${esc(r.status)}</small></div>`).join('')}<button class="inbox-pane-action" data-open-context="${t.id}">Open tracker →</button></aside>`);
}
function openContext(id){activeContext=id;contextTab='overview';inboxPage='context';destination='inbox';render();}
function openNative(source,id){provider=source;state[source].selected=id;inboxPage='source';destination='inbox';render();}
function openRef(t,id){
 const r=t.refs.find(r=>r.id===id);if(!r)return;
 if(state[r.provider]&&(r.provider==='GitHub'?prs:tickets[r.provider]).some(p=>p.id===r.sourceId)){openNative(r.provider,r.sourceId);return;}
 const c=connections.find(c=>!c.native&&c.name===r.provider);
 if(c){activeIntegration=c.id;inboxPage='integration';destination='inbox';render();return;}
 dialog(r.title,`<p>${esc(r.provider)} · ${esc(r.role)} · ${esc(r.status)}</p><p>Part of ${esc(t.title)}.</p>${r.url?`<p><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">Open saved reference ↗</a></p>`:'<p>Saved item context. Provider details are abbreviated in this sample.</p>'}`);
}
function nativeReference(p){return {id:provider.toLowerCase()+':'+p.id,provider,sourceId:p.id,kind:provider==='GitHub'?'code':'ticket',role:provider==='GitHub'?'Implements':'Defines',title:p.title,status:provider==='GitHub'?p.review:p.status};}
function linkToTracker(r){pendingSourceItem=r;dialog('Link to tracker',`<p>${esc(r.provider)} · ${esc(r.title)}</p><label for="tracker-target">Tracker</label><select id="tracker-target">${contexts.map(t=>option(t.id,t.title,t.id===activeContext?t.id:'')).join('')}<option value="new">Create a new tracker…</option></select><p>The item keeps its original status. This link adds shared context.</p>`,'unused','Link item');$('#dialog [data-confirm]').removeAttribute('data-confirm');$('#dialog footer button:last-child').setAttribute('data-save-tracker-link','');}
function explorationDialog(title,body,attr,label){dialog(title,body,'unused',label);const button=$('#dialog [data-confirm]');button.removeAttribute('data-confirm');button.setAttribute(attr,'');}
function integrationDialog(){
 const available=catalog.filter(c=>c.id==='custom'||!connections.some(x=>x.id===c.id));
 explorationDialog('Add integration',`<p>Add a source to ${esc(workspace)}. These sample connections let you explore how another service fits.</p><label for="integration-type">Integration</label><select id="integration-type">${available.map(c=>option(c.id,c.name+' · '+c.detail,'')).join('')}</select><label for="integration-category">For a custom integration, what does it provide?</label><select id="integration-category"><option value="context">Documents & discussions</option><option value="code">Code reviews & checks</option><option value="tickets">Tickets & tasks</option></select><label for="integration-name">Connection name (optional)</label><input class="dialog-input" id="integration-name" placeholder="e.g. Platform GitLab"><p>A new integration gets a source view and can contribute items to existing trackers. No credentials or live connection are used.</p><div class="form-error" id="integration-error" role="alert"></div>`,'data-connect-sample','Add sample integration');
}
function newContextDialog(){
 explorationDialog('New tracker',`<p>Start with an outcome. Tickets and code changes can be linked later.</p><label for="context-title">What are you trying to finish?</label><input class="dialog-input" id="context-title" placeholder="e.g. Understand checkout failures"><label for="context-next">Next step</label><input class="dialog-input" id="context-next" placeholder="e.g. Inspect the failed checkout logs"><div class="form-error" id="context-error" role="alert"></div>`,'data-save-context','Create tracker');
}
function newContext(title,next){const id='context-'+Date.now();const t={id,key:'LOCAL',title,status:'Ready to continue',bucket:'active',outcome:title,next:next||'Add context and choose a next step.',decision:'No decision recorded yet.',refs:[],sessionIds:[],notes:[],events:['Tracker created locally.'],suggestion:'none'};contexts.push(t);return t;}
function contextSession(id){const s=sidebarSessions.find(s=>s.id===id);if(!s)return;selectedSession=s;scope=s.scope;destination='session';render();}
function openIntegration(id,viewIndex){
 const c=connections.find(c=>c.id===id);if(!c)return;
 destination='inbox';
 if(c.native){provider=c.name;inboxPage='source';if(viewIndex!==undefined)state[provider].tab=c.category==='code'?(viewIndex==='0'?'reviews':'authored'):(viewIndex==='0'?'mine':'period');}
 else{inboxPage='integration';activeIntegration=c.id;}
 render();
}
document.addEventListener('click',e=>{
 const b=e.target.closest('button,[data-open-context],[data-open-native]');if(!b)return;
 const t=contextById(activeContext);
 if(b.dataset.inboxPage){inboxPage=b.dataset.inboxPage;destination='inbox';render();}
 else if(b.dataset.openIntegration)openIntegration(b.dataset.openIntegration,b.dataset.connectionView);
 else if(b.dataset.openContext)openContext(b.dataset.openContext);
 else if(b.dataset.openNative)openNative(b.dataset.openNative,b.dataset.nativeId);
 else if(b.dataset.openRef)openRef(contextById(b.dataset.contextId),b.dataset.openRef);
 else if(b.dataset.foldContext){expandedContexts.has(b.dataset.foldContext)?expandedContexts.delete(b.dataset.foldContext):expandedContexts.add(b.dataset.foldContext);render();}
 else if(b.dataset.contextSession)contextSession(b.dataset.contextSession);
 else if(b.dataset.contextTab){contextTab=b.dataset.contextTab;render();}
 else if(b.dataset.contextFilter){contextFilter=b.dataset.contextFilter;render();}
 else if(b.dataset.attentionTab){attentionTab=b.dataset.attentionTab;render();}
 else if(b.dataset.handle){const a=attention.find(a=>a.id===b.dataset.handle);a.state=a.state==='open'?'handled':'open';if(a.track)contextById(a.track).events.push(a.state==='handled'?'Attention update handled locally; work remains tracked.':'Attention update reopened.');render();}
 else if(b.hasAttribute('data-create-context'))newContextDialog();
 else if(b.hasAttribute('data-save-context')){const title=$('#context-title').value.trim();if(!title){$('#context-error').textContent='Enter an outcome for this tracker.';return;}const created=newContext(title,$('#context-next').value.trim());$('#dialog').close();openContext(created.id);}
 else if(b.hasAttribute('data-add-integration'))integrationDialog();
 else if(b.hasAttribute('data-connect-sample')){
  const c=catalog.find(c=>c.id===$('#integration-type').value);if(!c){$('#integration-error').textContent='All sample integration types have been added.';return;}
  const name=$('#integration-name').value.trim()||c.name;const added={...c,id:c.id==='custom'?'custom-'+Date.now():c.id,name,category:c.id==='custom'?$('#integration-category').value:c.category,health:'Sample',native:false};connections.push(added);$('#dialog').close();openIntegration(added.id);toast(name+' added to this prototype.');
 }
 else if(b.dataset.configureConnection){const c=connections.find(c=>c.id===b.dataset.configureConnection);dialog(c.name,`<p>${esc(c.detail)}</p><p>${c.native?'Existing sample integration.':'Added locally in this prototype.'} Its source items can be linked to shared trackers.</p><p>Credentials, sync and removal are outside this design sample.</p>`);}
 else if(b.hasAttribute('data-track-native'))linkToTracker(nativeReference(chosen()));
 else if(b.hasAttribute('data-track-generic'))linkToTracker(genericItems(connections.find(c=>c.id===activeIntegration))[0]);
 else if(b.hasAttribute('data-save-tracker-link')){
  const id=$('#tracker-target').value;const target=id==='new'?newContext(pendingSourceItem.title,'Read the linked item and choose a next step.'):contextById(id);
  if(!target.refs.some(r=>r.id===pendingSourceItem.id)){target.refs.push({...pendingSourceItem});target.events.push(pendingSourceItem.provider+' item linked as '+pendingSourceItem.role.toLowerCase()+'.');}
  const native=state[pendingSourceItem.provider]&&(pendingSourceItem.provider==='GitHub'?prs:tickets[pendingSourceItem.provider]).find(p=>p.id===pendingSourceItem.sourceId);
  for(const title of native?.sessions||[]){let session=sidebarSessions.find(s=>s.title===title&&s.item===pendingSourceItem.provider+' '+pendingSourceItem.sourceId);if(!session){session={id:'attached-'+Date.now()+'-'+target.sessionIds.length,title,scope:native.repo||'web-app',item:pendingSourceItem.provider+' '+pendingSourceItem.sourceId,agent:'codex'};sidebarSessions.push(session);}if(!session.track)session.track=target.id;if(!target.sessionIds.includes(session.id))target.sessionIds.push(session.id);}
  for(const session of sidebarSessions.filter(s=>s.item===pendingSourceItem.provider+' '+pendingSourceItem.sourceId)){if(!session.track)session.track=target.id;if(!target.sessionIds.includes(session.id))target.sessionIds.push(session.id);}
  $('#dialog').close();openContext(target.id);
 }
 else if(b.hasAttribute('data-link-reference'))explorationDialog('Link artifact',`<p>Add a ticket, code review, document or discussion to ${esc(t.title)}.</p><label for="reference-label">Label</label><input class="dialog-input" id="reference-label" placeholder="e.g. Retry policy decision"><label for="reference-url">URL</label><input class="dialog-input" id="reference-url" type="url" placeholder="https://…"><label for="reference-role">Relationship</label><select id="reference-role">${['Reference','Defines','Implements','Discusses','Evidence'].map(r=>option(r,r,'Reference')).join('')}</select><div class="form-error" id="reference-error" role="alert"></div>`,'data-save-reference','Attach reference');
 else if(b.hasAttribute('data-save-reference')){
  let url;try{url=new URL($('#reference-url').value);if(!['http:','https:'].includes(url.protocol))throw Error();}catch{$('#reference-error').textContent='Enter an http or https URL.';return;}
  t.refs.push({id:'reference:'+Date.now(),provider:'Saved link',kind:'context',role:$('#reference-role').value,title:$('#reference-label').value.trim()||url.hostname,status:'Saved reference',url:url.href});t.events.push('Reference attached: '+t.refs.at(-1).title);$('#dialog').close();render();
 }
 else if(b.dataset.unlinkRef){t.refs=t.refs.filter(r=>r.id!==b.dataset.unlinkRef);t.events.push('Artifact unlinked locally. The source item was not changed.');render();}
 else if(b.dataset.suggestion){t.suggestion=b.dataset.suggestion==='accept'?'accepted':'rejected';if(t.suggestion==='accepted')t.refs.push({id:'reference:release',provider:'Saved link',kind:'context',role:'Reference',title:'September release coordination',status:'Saved reference'});t.events.push('Release discussion suggestion '+t.suggestion+'.');render();}
 else if(b.hasAttribute('data-context-note'))explorationDialog('Add handoff note',`<p>Leave the decision or next step for the next session.</p><label for="context-note">Note</label><textarea id="context-note" rows="4"></textarea>`,'data-save-note','Save note');
 else if(b.hasAttribute('data-save-note')){const note=$('#context-note').value.trim();if(!note)return;t.notes.push(note);t.events.push('Handoff: '+note);$('#dialog').close();render();}
 else if(b.hasAttribute('data-finish-context')){t.bucket=t.bucket==='finished'?'active':'finished';t.status=t.bucket==='finished'?'Finished locally':'Ready to continue';t.events.push(t.bucket==='finished'?'Tracker marked finished locally; provider states unchanged.':'Tracker reopened locally.');render();}
 else if(b.hasAttribute('data-attach-session'))explorationDialog('Link existing session',`<p>Add a session to ${esc(t.title)}.</p><label for="context-existing-session">Session</label><select id="context-existing-session">${sidebarSessions.map(s=>option(s.id,s.title,'')).join('')}</select>`,'data-save-session-link','Link session');
 else if(b.hasAttribute('data-save-session-link')){const s=sidebarSessions.find(s=>s.id===$('#context-existing-session').value);if(!t.sessionIds.includes(s.id))t.sessionIds.push(s.id);if(!s.track)s.track=t.id;t.events.push('Session linked: '+s.title);$('#dialog').close();render();}
 else if(b.hasAttribute('data-start-context'))explorationDialog('Start a session',`<p>Context: ${esc(t.title)} · ${t.refs.length} linked artifacts · Latest decision and next step.</p><label for="tracker-session-repo">Repository</label><select id="tracker-session-repo"><option>web-app</option><option>payments-api</option><option>console-1</option></select><label for="tracker-session-prompt">Prompt</label><textarea id="tracker-session-prompt" rows="4">${esc(t.next)}</textarea><p>This creates a sample session only.</p>`,'data-save-tracker-session','Start sample session');
 else if(b.hasAttribute('data-save-tracker-session')){const prompt=$('#tracker-session-prompt').value.trim();if(!prompt)return;const s={id:'tracker-session-'+Date.now(),title:'Continue · '+t.key,scope:$('#tracker-session-repo').value,prompt,track:t.id,agent:'codex'};sidebarSessions.push(s);t.sessionIds.push(s.id);t.events.push('Session started with tracker context.');$('#dialog').close();contextSession(s.id);}
 else if(b.hasAttribute('data-generic-session')){const c=connections.find(c=>c.id===activeIntegration),r=genericItems(c)[0],linked=contexts.find(t=>t.refs.some(ref=>ref.id===r.id));const s={id:'integration-session-'+Date.now(),title:(c.category==='code'?'Review':'Explore')+' · '+r.sourceId,scope:'console-1',agent:'codex',track:linked?.id,item:c.name+' '+r.sourceId,prompt:'Use '+r.title+' as the source context.'};sidebarSessions.push(s);if(linked)linked.sessionIds.push(s.id);contextSession(s.id);}
 else if(b.hasAttribute('data-compare-info'))dialog('Compare Inbox navigation',Object.entries(modelLabels).map(([id,label])=>`<h3 class="comparison-modal-title">${label}${id==='workflow'?' · Suggested starting point':''}</h3><p>${modelDescriptions[id]}</p>`).join('')+'<p>All alternatives share the same tracker records, provider states, sessions and integration list. Home returns to the current session sidebar.</p>');
 else if(b.hasAttribute('data-mobile-nav'))document.body.classList.toggle('inbox-nav-open');
 if(b.dataset.inboxPage||b.dataset.openContext||b.dataset.openIntegration||b.dataset.openNative)document.body.classList.remove('inbox-nav-open');
});
document.addEventListener('change',e=>{if(e.target.id==='nav-model'){navModel=e.target.value;render();}});
document.addEventListener('input',e=>{if(e.target.id==='work-search'){workSearch=e.target.value;const pos=e.target.selectionStart;renderTrackers();$('#work-search').focus();$('#work-search').setSelectionRange(pos,pos);}});
document.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)&&e.target.matches('[role="button"][data-open-context],[role="button"][data-open-native]')){e.preventDefault();e.target.click();}});
// Keep the screenshot's GitHub view directly addressable; the default Inbox
// route explores the new navigation and cohesive context layer.
render();
