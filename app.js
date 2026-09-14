const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
// ---- Theme toggle (light / dark). Applied as a data-theme attribute on <html> so CSS can
// override colours per-theme; persisted so it sticks across visits and reloads.
(function initTheme(){
  const saved=localStorage.getItem('orbit-theme')||'light';
  document.documentElement.setAttribute('data-theme',saved);
  document.addEventListener('DOMContentLoaded',()=>{
    const btn=document.getElementById('themeToggle');
    if(!btn)return;
    const sync=()=>{const isDark=document.documentElement.getAttribute('data-theme')==='dark';btn.textContent=isDark?'☀️':'🌙'};
    sync();
    btn.onclick=()=>{const next=document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',next);localStorage.setItem('orbit-theme',next);sync()};
  });
})();
const login = $('#loginView'), setup = $('#setupView'), dash = $('#dashboardView');
function show(view){[login,setup,dash].forEach(v=>v.classList.add('hidden'));view.classList.remove('hidden');window.scrollTo(0,0)}
const setupLink=$('#setupLink');if(setupLink)setupLink.onclick=e=>{e.preventDefault();show(setup)};
$$('[data-back]').forEach(b=>b.onclick=()=>show(login));
const localPreview=location.protocol==='file:';const previewUser={name:'Aanya Sharma',email:'demo@orbit.local'};
// Deadlines are set relative to "now" (not fixed dates) so the countdown badges have something
// real to count down from no matter when this file:// preview is opened.
const previewUpdates=[{id:'u1',source:'teacher',sender:'Prof. Mehra',space:'Class CSE A',title:'Assignment 01 submission instructions',body:'Submit a single PDF with your code link before Sunday, 11:59 PM.',priority:100,deadline:new Date(Date.now()+14*3600*1000).toISOString()},{id:'u2',source:'whatsapp',sender:'E-Cell · Official',space:'E-Cell',title:'Hackathon ’26 registrations are live!',body:'Find your team of 2–4 and register via the shared form.',priority:70,deadline:new Date(Date.now()+4*86400*1000).toISOString()},{id:'u3',source:'portal',sender:'Academic Office',space:'College portal',title:'Merit scholarship applications open',body:'Eligible first-year students can apply through the portal by September 22.',priority:80,deadline:new Date(Date.now()+10*86400*1000).toISOString()}];
const publicDb=()=>window.orbitSupabase||null;
async function api(path, options={}){if(localPreview){if(path==='/api/dashboard')return {user:previewUser,updates:previewUpdates,reminders:[]};if(path.includes('auth'))return {user:previewUser};if(path.includes('ai/brief'))return {summary:'Preview: DSA Assignment is your next urgent deadline.'};if(path.includes('ai/ask'))return {answer:'AI answers need the real server — open http://localhost:3000 to ask questions about your synced updates.'};if(path.includes('reminders'))return {ok:true};throw new Error('This connector needs the server. Open http://localhost:3000 to connect it.')}const response=await fetch(path,{headers:{'Content-Type':'application/json'},...options});const result=await response.json();if(!response.ok)throw new Error(result.error||'Something went wrong');return result}
let allUpdates=[];let telegramChats=[];let classroomCourses=[];
let currentUserFirstName='';
function applyUser(user){currentUserFirstName=user.name.split(' ')[0];$('#profileName').textContent=user.name;$('#greetingName').textContent=currentUserFirstName;const gw=$('#greetingWord');if(gw)gw.textContent=getGreetingWord();document.querySelector('.profile small').textContent=[user.department,user.year,user.semester].filter(Boolean).join(' · ')||'Complete profile';$$('.avatar').forEach(x=>x.textContent=user.name.split(' ').map(n=>n[0]).join('').slice(0,2).toUpperCase());const greeting=$('#aiGreeting');if(greeting)greeting.textContent=`Hi ${currentUserFirstName}! Ask me to find a deadline, summarise a group, or plan your week.`;renderProfilePage(user);renderProfileChips(user);renderSpaceList(user)}
// Sidebar "YOUR SPACES" list — the student's actual joined communities, colour-dotted and
// cycling through the accent palette. Shows a friendly empty state instead of any placeholder
// community when none have been picked yet.
const spaceDotPalette=['accent','coral','violet','success','warning','amber'];
function renderSpaceList(user){const el=$('#spaceList');if(!el)return;const spaces=user.spaces||[];el.innerHTML=spaces.length?spaces.map((s,i)=>`<span><i style="background:var(--${spaceDotPalette[i%spaceDotPalette.length]})"></i>${escapeHtml(s)}</span>`).join(''):'<span class="space-empty">No communities joined yet</span>'}
// "Good morning/afternoon/evening/night" based on the time the dashboard is actually opened.
function getGreetingWord(){const h=new Date().getHours();if(h<12)return'Good morning';if(h<17)return'Good afternoon';if(h<21)return'Good evening';return'Good night'}
function renderProfileChips(user){const el=$('#profileChips');if(!el)return;const spacesCount=(user.spaces||[]).length;const yearValue=user.section?`${user.year||'—'} · Sec ${user.section}`:(user.year||'—');const chips=[
  {cls:'',icon:'⌘',label:'College',value:user.college||'—'},
  {cls:'chip-dept',icon:'◈',label:'Department',value:user.department||'—'},
  {cls:'chip-year',icon:'▲',label:'Year',value:yearValue},
  {cls:'chip-spaces',icon:'✦',label:'Communities',value:spacesCount?`${spacesCount} joined`:'None yet'}
];el.innerHTML=chips.map(c=>`<div class="profile-chip ${c.cls}"><i>${c.icon}</i><span><b>${escapeHtml(c.value)}</b><small>${c.label}</small></span></div>`).join('')}
function renderQuickStats(){const el=$('#quickStats');if(!el)return;const now=Date.now();const soonMs=7*86400*1000;const upcoming=allUpdates.filter(u=>u.deadline&&new Date(u.deadline).getTime()>now&&new Date(u.deadline).getTime()<now+soonMs).length;const remindersActive=(allReminders||[]).filter(r=>!r.notifiedAt).length+(customEvents||[]).filter(e=>!e.notifiedAt&&new Date(e.at).getTime()>now).length;el.innerHTML=`<div class="quick-stat"><i>✉</i><span class="quick-stat-text"><b>${allUpdates.length}</b><span>Synced updates</span></span></div><div class="quick-stat"><i>◷</i><span class="quick-stat-text"><b>${upcoming}</b><span>Deadlines this week</span></span></div><div class="quick-stat"><i>✦</i><span class="quick-stat-text"><b>${remindersActive}</b><span>Active reminders</span></span></div>`}
async function openDashboard(user){applyUser(user);if(user.profileVersion!==3)return beginProfile(user);show(dash);startReminderPolling();try{const data=await api('/api/dashboard');allUpdates=data.updates||[];telegramChats=data.telegramChats||[];classroomCourses=data.classroomCourses||[];allReminders=data.reminders||[];customEvents=data.customEvents||[];importantFolders=data.importantFolders||[];importantItems=data.importantItems||[];renderUpdates(allUpdates);renderSourceLists();renderCalendar();renderQuickStats();checkUrgentDeadlinePopup()}catch(error){console.warn(error)}}
// Shown once per tab session, right after the dashboard loads, if anything is due within the
// next 24 hours — so a deadline that's about to hit is impossible to miss even if the student
// doesn't scroll down to the priority cards or deadlines page.
function checkUrgentDeadlinePopup(){
  if(sessionStorage.getItem('cf-deadline-popup-shown'))return;
  const now=Date.now();const oneDay=24*3600*1000;
  const urgent=[
    ...allUpdates.filter(u=>u.deadline).map(u=>({title:u.title,at:u.deadline,from:u.sender})),
    ...(customEvents||[]).filter(e=>e.kind==='deadline').map(e=>({title:e.title,at:e.at,from:'Your calendar'}))
  ].filter(item=>{const diff=new Date(item.at).getTime()-now;return diff>=0&&diff<=oneDay}).sort((a,b)=>new Date(a.at)-new Date(b.at));
  if(!urgent.length)return;
  sessionStorage.setItem('cf-deadline-popup-shown','1');
  showDeadlinePopup(urgent);
}
function showDeadlinePopup(items){
  let modal=$('#deadlineAlertModal');
  if(!modal){modal=document.createElement('div');modal.id='deadlineAlertModal';modal.className='modal-backdrop';document.body.append(modal)}
  modal.innerHTML=`<section class="connections-modal deadline-alert"><button class="modal-close" id="closeDeadlineAlert">×</button><p class="eyebrow">⏰ ${items.length} DEADLINE${items.length>1?'S':''} DUE WITHIN A DAY</p><h2>Don't miss this.</h2><div class="deadline-alert-list">${items.map(item=>`<article class="deadline-large urgent-line"><div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.from||'')}</p></div><b>${timeLeftLabel(item.at)}</b></article>`).join('')}</div><button class="primary wide" id="viewDeadlinesBtn">View deadlines →</button></section>`;
  modal.classList.remove('hidden');
  $('#closeDeadlineAlert').onclick=()=>modal.classList.add('hidden');
  modal.onclick=e=>{if(e.target===modal)modal.classList.add('hidden')};
  $('#viewDeadlinesBtn').onclick=()=>{modal.classList.add('hidden');$$('[data-nav]').forEach(x=>x.classList.toggle('active',x.dataset.nav==='deadlines'));setPage('deadlines')};
}
function beginProfile(user){$('#studentName').value=user.name||'';$('#college').value=branchMap[user.college]?user.college:(user.college?'Other':'');$('#customCollege').value=branchMap[user.college]?'':(user.college||'');updateBranches();if(user.department&&[...$('#department').options].some(option=>option.value===user.department))$('#department').value=user.department;$('#year').value=user.year||'1st Year';updateSemesters();$('#semester').value=user.semester||$('#semester').value;const sectionField=$('#studentSection');if(sectionField)sectionField.value=user.section||'';show(setup);changeStep(1)}
function startGoogle(){location.href=localPreview?'http://localhost:3000/api/oauth/google/start':'/api/oauth/google/start'}
$('#googleBtn').onclick=startGoogle;
// Classroom email hint: lets a student point Google at the account their school actually uses
// for Classroom, since that's often different from whatever email they used to sign in to Orbit.
function startClassroom(){const hint=($('#classroomEmailHint')?.value||'').trim();const qs=hint?`?email=${encodeURIComponent(hint)}`:'';const path=`/api/oauth/classroom/start${qs}`;location.href=localPreview?`http://localhost:3000${path}`:path}
$('#demoLink').onclick=async e=>{e.preventDefault();try{const result=await api('/api/auth/demo',{method:'POST'});openDashboard(result.user)}catch(error){alert('Start the backend with npm start first.')}};
let step=1;const changeStep=n=>{step=n;$$('.step').forEach(x=>x.classList.add('hidden'));$(`.step-${['','one','two','three'][n]}`).classList.remove('hidden');$$('.progress i').forEach((x,i)=>x.classList.toggle('active',i===n-1))};
const branchMap={'Indira Gandhi Delhi Technical University for Women':['Computer Science & Engineering','Computer Science & Engineering (AI)','Information Technology','Artificial Intelligence & Machine Learning','Electronics & Communication Engineering','Mechanical & Automation Engineering','Mathematics & Computing','Architecture','Management'],'Delhi Technological University':['Computer Science & Engineering','Information Technology','Software Engineering','Electrical Engineering','Electronics & Communication Engineering','Mechanical Engineering','Civil Engineering','Mathematics & Computing'],'Netaji Subhas University of Technology':['Computer Science & Engineering','Information Technology','Artificial Intelligence & Data Science','Electronics & Communication Engineering','Mechanical Engineering','Mathematics & Computing']};
function updateSemesters(){const year=Number.parseInt($('#year').value)||1;const first=(year-1)*2+1;$('#semester').innerHTML=[first,first+1].map(number=>`<option value="Semester ${number}">Semester ${number}</option>`).join('')}
function updateBranches(){const college=$('#college').value;const select=$('#department');const custom=$('#customCollegeWrap');custom.classList.toggle('hidden',college!=='Other');const branches=branchMap[college]||[];select.disabled=!branches.length;select.innerHTML=branches.length?branches.map(x=>`<option>${x}</option>`).join(''):'<option>Choose your college first</option>'}
$('#college').onchange=updateBranches;$('#year').onchange=updateSemesters;updateSemesters();
$('#editProfileBtn').onclick=async()=>{try{const result=await api('/api/me');beginProfile(result.user);toast('Update your college profile, then save it again.')}catch(error){toast(error.message)}};
$$('.next-step').forEach(b=>b.onclick=()=>{if(step===1){const name=$('#studentName').value.trim(),college=$('#college').value,department=$('#department').value;if(!name||!college||!department||(college==='Other'&&!$('#customCollege').value.trim()))return toast('Please select your college, year and branch first.')}changeStep(Math.min(3,step+1))});$$('.prev-step').forEach(b=>b.onclick=()=>changeStep(1));
$$('.choice').forEach(b=>b.onclick=()=>b.classList.toggle('selected'));
function addCommunity(){const input=$('#communityInput');const name=input.value.trim();if(!name)return;
  // Don't add a suggestion that's already there (preset or previously added) — just select the
  // existing one instead of showing a duplicate.
  const existing=[...$$('#choices .choice')].find(x=>x.textContent.trim().replace(/^\S+\s/,'').toLowerCase()===name.toLowerCase());
  if(existing){existing.classList.add('selected');input.value='';input.focus();return}
  const button=document.createElement('button');button.type='button';button.className='choice selected custom-community';button.textContent=`✦ ${name}`;button.onclick=()=>button.classList.toggle('selected');$('#choices').append(button);input.value='';input.focus()}
$('#addCommunity').onclick=addCommunity;$('#communityInput').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();addCommunity()}};
$$('.connection').forEach(b=>b.onclick=async()=>{const type=b.dataset.connector;if(type==='email')return startGoogle();if(type==='telegram')return openTelegram();try{const result=await api(`/api/connectors/${type}`,{method:'POST'});b.classList.add('connected');b.querySelector('em').textContent='Setup pending';toast(result.message)}catch(error){alert('Create your account first, then connect a provider.')}});
$$('.finish-setup').forEach(b=>b.onclick=async()=>{try{const college=$('#college').value==='Other'?$('#customCollege').value.trim():$('#college').value;const spaces=[...$$('.choice.selected')].map(x=>x.textContent.trim().replace(/^\S+\s/,''));const result=await api('/api/me',{method:'PUT',body:JSON.stringify({name:$('#studentName').value.trim(),college,department:$('#department').value,year:$('#year').value,semester:$('#semester').value,section:$('#studentSection').value.trim(),profileCompleted:true,spaces})});await openDashboard(result.user);
  // Always land on the home/overview page right after finishing setup.
  $$('[data-nav]').forEach(x=>x.classList.toggle('active',x.dataset.nav==='overview'));setPage('overview');
  toast('Profile saved — your personalised dashboard is ready.')}catch(error){toast(error.message)}});
const toast=(message='Reminder saved — we’ll notify you before it’s due.')=>{const t=$('#toast');t.textContent=message;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),3200)};$$('.feed-meta button').forEach((b,index)=>b.onclick=async()=>{try{const result=await api('/api/reminders',{method:'POST',body:JSON.stringify({updateId:['u1','u2','u3'][index]})});allReminders=result.reminders||allReminders;renderCalendar();toast();setTimeout(pollRemindersNow,1500)}catch(error){toast('Start the backend to save reminders.')}});
if(new URLSearchParams(location.search).get('connection')==='google-setup-required'){history.replaceState({},'',location.pathname);setTimeout(()=>toast('Google sign-in will work after the app owner sets up Google once. Students never fill technical details.'),250)}
(async()=>{if(localPreview)return;try{const params=new URLSearchParams(location.search);const result=await api('/api/me');await openDashboard(result.user);if(params.get('auth')==='google'){history.replaceState({},'',location.pathname);if(result.user.profileVersion!==3){toast('Complete your college, branch, year and semester profile first.');return}try{const sync=await api('/api/sync/gmail',{method:'POST'});const dashboard=await api('/api/dashboard');allUpdates=dashboard.updates||[];telegramChats=dashboard.telegramChats||[];renderUpdates(allUpdates);renderSourceLists();toast(`Google connected — ${sync.added||0} recent emails imported.`)}catch(error){toast(`Google connected, but email import needs a retry: ${error.message}`)}}if(params.get('classroom')){history.replaceState({},'',location.pathname);const status=params.get('classroom');if(status==='connected'){toast('Classroom connected — choose which classes to follow.');openClassroomCourseChooser()}else if(status==='login-required'){toast('Sign in to Orbit first, then connect Classroom from Connections.')}else if(status==='setup-required'){toast('Google OAuth is not set up on this server yet.')}else if(status!=='cancelled'){toast('Could not connect Google Classroom — please try again.')}}}catch(error){console.warn('Session restore failed',error)}})();
$('#aiFab').onclick=()=>$('#aiPanel').classList.toggle('hidden');$('#closeAi').onclick=()=>$('#aiPanel').classList.add('hidden');
const connections=$('#connectionsModal');
function openConnections(){connections.classList.remove('hidden')}
function closeConnections(){connections.classList.add('hidden')}
$('#openConnections').onclick=openConnections;$('#closeConnections').onclick=closeConnections;
connections.onclick=e=>{if(e.target===connections)closeConnections()};
const telegramModal=$('#telegramModal');let telegramVerificationId='';
function openTelegram(){if(localPreview)return toast('Open http://localhost:3000 to connect Telegram.');telegramModal.classList.remove('hidden');$('#telegramPhoneStep').classList.remove('hidden');$('#telegramCodeStep').classList.add('hidden');$('#telegramChatStep').classList.add('hidden');}
function closeTelegram(){telegramModal.classList.add('hidden');telegramVerificationId='';}
$('#closeTelegram').onclick=closeTelegram;telegramModal.onclick=e=>{if(e.target===telegramModal)closeTelegram()};
$$('[data-telegram-connect]').forEach(button=>button.onclick=openTelegram);
$('#telegramRequestCode').onclick=async()=>{const button=$('#telegramRequestCode');try{button.disabled=true;button.textContent='Sending…';const result=await api('/api/telegram/request-code',{method:'POST',body:JSON.stringify({phone:$('#telegramPhone').value.replace(/[\s-]/g,'')})});telegramVerificationId=result.verificationId;$('#telegramPhoneStep').classList.add('hidden');$('#telegramCodeStep').classList.remove('hidden');toast(result.message)}catch(error){toast(error.message)}finally{button.disabled=false;button.textContent='Send Telegram code'}};
$('#telegramVerifyCode').onclick=async()=>{const button=$('#telegramVerifyCode');try{button.disabled=true;button.textContent='Verifying…';const result=await api('/api/telegram/verify-code',{method:'POST',body:JSON.stringify({verificationId:telegramVerificationId,code:$('#telegramCode').value.trim()})});telegramChats=result.chats||[];$('#telegramCodeStep').classList.add('hidden');$('#telegramChatStep').classList.remove('hidden');$('#telegramChatList').innerHTML=telegramChats.length?telegramChats.map(chat=>`<button class="choice" type="button" data-telegram-chat="${chat.id}">✈ ${chat.title}<small>${chat.type}</small></button>`).join(''):'<p class="sub">No chats were returned. Check that this Telegram account has joined channels.</p>';$$('[data-telegram-chat]').forEach(item=>item.onclick=()=>item.classList.toggle('selected'));}catch(error){toast(error.message)}finally{button.disabled=false;button.textContent='Verify and show my chats'}};
$('#telegramSaveChats').onclick=async()=>{const selected=[...$$('[data-telegram-chat].selected')].map(button=>telegramChats.find(chat=>chat.id===button.dataset.telegramChat));if(!selected.length)return toast('Choose at least one chat.');try{const result=await api('/api/telegram/select-chats',{method:'POST',body:JSON.stringify({chats:selected})});telegramChats=result.selected;closeTelegram();renderSourceLists();toast(`${result.selected.length} Telegram chats selected. Press Sync Telegram to import updates.`)}catch(error){toast(error.message)}};
// ---- Google Classroom: "choose which classes to follow" picker, same idea as Telegram's chat
// picker — connecting only grants access, it never auto-imports every class. The student picks
// from their real Classroom courses here, and can reopen this anytime (Settings or the Classroom
// page) to add more or remove ones they no longer want.
const classroomCoursesModal=$('#classroomCoursesModal');
async function openClassroomCourseChooser(){
  if(localPreview)return toast('Open http://localhost:3000 to manage Classroom.');
  const list=$('#classroomCourseList');if(list)list.innerHTML='<p class="sub">Loading your classes…</p>';
  classroomCoursesModal?.classList.remove('hidden');
  try{
    const result=await api('/api/classroom/available');
    const available=result.courses||[];
    const selectedIds=new Set(classroomCourses.map(c=>c.id));
    if(list)list.innerHTML=available.length?available.map(course=>`<button class="choice ${selectedIds.has(course.id)?'selected':''}" type="button" data-classroom-course="${course.id}" data-classroom-course-name="${escapeHtml(course.name)}">🎓 ${escapeHtml(course.name)}</button>`).join(''):'<p class="sub">No active Classroom courses were found on this Google account. Join a class on classroom.google.com, then try again.</p>';
    $$('[data-classroom-course]').forEach(item=>item.onclick=()=>item.classList.toggle('selected'));
  }catch(error){if(list)list.innerHTML=`<p class="sub">${escapeHtml(error.message||'Could not load your Classroom courses.')}</p>`}
}
function closeClassroomCourses(){classroomCoursesModal?.classList.add('hidden')}
$('#closeClassroomCourses')?.addEventListener('click',closeClassroomCourses);
classroomCoursesModal?.addEventListener('click',e=>{if(e.target===classroomCoursesModal)closeClassroomCourses()});
$$('#manageClassroomBtn,#manageClassroomBtnPage').forEach(button=>button?.addEventListener('click',openClassroomCourseChooser));
$('#saveClassroomCourses')?.addEventListener('click',async()=>{
  const picked=[...$$('[data-classroom-course].selected')].map(item=>({id:item.dataset.classroomCourse,name:item.dataset.classroomCourseName}));
  if(!picked.length)return toast('Select at least one class.');
  const button=$('#saveClassroomCourses');button.disabled=true;button.textContent='Saving…';
  try{
    const result=await api('/api/classroom/select',{method:'POST',body:JSON.stringify({courses:picked})});
    classroomCourses=result.selected||picked;
    closeClassroomCourses();
    toast('Saved. Syncing your selected classes…');
    const sync=await api('/api/sync/classroom',{method:'POST'});
    const dashboard=await api('/api/dashboard');allUpdates=dashboard.updates||[];classroomCourses=dashboard.classroomCourses||classroomCourses;renderUpdates(allUpdates);renderSourceLists();
    toast(`${sync.added||0} Classroom updates imported.`);
  }catch(error){toast(error.message)}finally{button.disabled=false;button.textContent='Save selected classes'}
});
function setPage(target){const overviewNodes=[$('.topbar'),$('.dashboard-home'),$('.briefing'),$('.dashboard-grid')];const pages=$$('[data-page]');overviewNodes.forEach(node=>node.classList.toggle('hidden',target!=='overview'));pages.forEach(page=>page.classList.toggle('hidden',page.dataset.page!==target));if(target==='messages')renderMessagePage();if(['emails','college','telegram','whatsapp','classroom'].includes(target))renderSourceLists();if(target==='calendar')renderCalendar();if(target==='important')renderImportantPage();if(target==='deadlines')renderDeadlinesPage();window.scrollTo({top:0,behavior:'smooth'})}
$$('[data-nav]').forEach(button=>button.onclick=()=>{const target=button.dataset.nav;$$('[data-nav]').forEach(x=>x.classList.toggle('active',x===button));setPage(target)});
function renderMessagePage(){const source=$('#feedList');const target=$('#messagesPageList');if(!target.children.length)target.innerHTML=source.innerHTML;bindFeedButtons()}
function category(u){if(u.source==='classroom')return u.space||'Google Classroom';const text=`${u.sender} ${u.title} ${u.body}`.toLowerCase();return /\bsih\b|smart india hackathon|hackathon|workshop|event|competition/.test(text)?'Hackathons & events':/\binternship\b|\bplacement\b|\bjob\b|\bcareer\b/.test(text)?'Internships & placements':/prof|assignment|exam|class|course|faculty/.test(text)?'From professors':/\bsociety\b|\bclub\b|\bcell\b|\bcommittee\b|\bchapter\b/.test(text)?'Society & club updates':/scholarship|fee|registration|academic|official|notice/.test(text)?'College & academic notices':'Other college updates'}
// Best-effort content-type guess for WhatsApp messages that predate the waType field (older
// imports saved before this change) — mirrors the server's classifyWhatsApp().
function waTypeOf(u){if(u.waType)return u.waType;const text=String(u.body||'');if(/<Media omitted>|image omitted/i.test(text))return'photo';if(/video omitted/i.test(text))return'video';if(/audio omitted|voice note omitted/i.test(text))return'music';if(/document omitted|contact card omitted/i.test(text))return'file';if(/https?:\/\/\S+/i.test(text))return'link';return'text'}
// "Important" = high priority score, "near deadline" = due within 48 hours — these are the two
// things that should always float to the top / show up in the Priority filter across Gmail,
// Telegram and WhatsApp.
function isUrgent(u){if((u.priority||0)>=90)return true;if(u.deadline){const diff=new Date(u.deadline)-Date.now();return diff>=0&&diff<=48*3600*1000}return false}
// Precise, always-live "how long left" label for a deadline — used on cards, the deadline
// pages and the calendar rail. Recomputed on demand rather than baked into markup, then kept
// fresh for elements already on screen by the ticker below (data-deadline + refreshCountdowns).
function timeLeftLabel(deadlineIso){
  if(!deadlineIso)return'';
  const diffMs=new Date(deadlineIso)-Date.now();
  if(Number.isNaN(diffMs))return'';
  if(diffMs<0)return'Deadline passed';
  const totalMinutes=Math.floor(diffMs/60000);
  if(totalMinutes<60)return`${totalMinutes}m left`;
  const totalHours=Math.floor(totalMinutes/60);
  if(totalHours<48){const mins=totalMinutes%60;return`${totalHours}h ${mins}m left`}
  const days=Math.floor(totalHours/24);
  return days<=7?`In ${days} day${days===1?'':'s'}`:`Due ${new Date(deadlineIso).toLocaleDateString('en-IN',{day:'2-digit',month:'short'})}`;
}
function deadlineBadge(u){if(!u.deadline)return'';const diff=new Date(u.deadline)-Date.now();const soon=diff>=0&&diff<=48*3600*1000;const label=diff<0?'Deadline passed':timeLeftLabel(u.deadline);return `<span class="tag ${soon?'urgent-tag':'due-tag'}" data-deadline="${u.deadline}">${soon?'⏰ ':''}${label}</span>`}
// Re-renders every on-screen countdown in place every 30s, without a full list re-render — so
// "how many hours left" for an urgent deadline stays accurate to the minute while the tab is open.
function refreshCountdowns(){$$('[data-deadline]').forEach(el=>{const iso=el.dataset.deadline;const diff=new Date(iso)-Date.now();const soon=diff>=0&&diff<=48*3600*1000;const label=diff<0?'Deadline passed':timeLeftLabel(iso);const isTag=el.classList.contains('tag');el.textContent=isTag?`${soon?'⏰ ':''}${label}`:label;if(isTag){el.classList.toggle('urgent-tag',soon);el.classList.toggle('due-tag',!soon)}})}
setInterval(refreshCountdowns,30000);
function messageCard(u){const channelTag=u.source==='telegram'&&u.telegramChatType==='Channel'?'<span class="tag chat-type-label channel">📡 Channel</span>':'';return `<article class="message-card ${isUrgent(u)?'urgent-card':''}"><button type="button" class="message-card-main" data-detail="${u.id}"><span class="message-category">${category(u)}</span>${channelTag}${deadlineBadge(u)}<b>${u.sender}</b><h3>${u.title}</h3><small>Click to read full update →</small></button><div class="message-card-actions"><button type="button" data-update="${u.id}">⏰ Save reminder</button><button type="button" data-save-msg="${u.id}">☆ Save</button></div></article>`}
// Per-page "Priority" / "All" toggle — Priority shows only important-or-near-deadline messages,
// nearest deadline first; All shows everything. State persists while switching source pages.
const sourceFilterMode={email:'all',college:'all',telegram:'all',whatsapp:'all',classroom:'all'};
function toggleBarHtml(prefix){const mode=sourceFilterMode[prefix];return `<div class="priority-toggle"><button type="button" class="ptoggle ${mode==='priority'?'active':''}" data-ptoggle="${prefix}" data-pmode="priority">⚡ Priority (near deadline / important)</button><button type="button" class="ptoggle ${mode==='all'?'active':''}" data-ptoggle="${prefix}" data-pmode="all">All</button></div>`}
function bindToggleBar(){$$('[data-ptoggle]').forEach(btn=>btn.onclick=()=>{sourceFilterMode[btn.dataset.ptoggle]=btn.dataset.pmode;renderSourceLists()})}
function applyPriorityFilter(items,prefix){if(sourceFilterMode[prefix]!=='priority')return items;return items.filter(isUrgent).sort((a,b)=>(a.deadline?new Date(a.deadline).getTime():Infinity)-(b.deadline?new Date(b.deadline).getTime():Infinity))}
function renderSourceLists(){
  const bindDetails=()=>$$('[data-detail]').forEach(button=>button.onclick=()=>showDetail(allUpdates.find(x=>x.id===button.dataset.detail)));
  const groups=['From professors','Internships & placements','Hackathons & events','Society & club updates','College & academic notices','Other college updates'];
  const renderGroups=(el,items,prefix,empty)=>{if(!el)return;items=applyPriorityFilter(items,prefix);if(!items.length){el.innerHTML=`${toggleBarHtml(prefix)}<div class="empty-source small"><h3>${empty}</h3></div>`;bindToggleBar();return}el.innerHTML=`${toggleBarHtml(prefix)}<div class="email-tabs">${groups.map((name,i)=>`<button class="email-tab ${i===0?'active':''}" data-${prefix}-group="${name}">${name}</button>`).join('')}</div><div id="${prefix}GroupResults"></div>`;const showGroup=name=>{let entries=items.filter(u=>category(u)===name);if(sourceFilterMode[prefix]!=='priority')entries=entries.slice().sort(recencyCompare);$(`#${prefix}GroupResults`).innerHTML=entries.length?entries.map(messageCard).join(''):`<div class="empty-source small"><h3>No ${name.toLowerCase()} updates yet</h3></div>`;bindDetails()};$$(`[data-${prefix}-group]`).forEach(tab=>tab.onclick=()=>{$$(`[data-${prefix}-group]`).forEach(x=>x.classList.toggle('active',x===tab));showGroup(tab.dataset[`${prefix}Group`])});showGroup(groups[0]);bindToggleBar()};
  // Classroom: one tab per class the student picked (not generic buckets like "Hackathons &
  // events") — each tab shows a × to stop following that class, same pattern as Telegram chats.
  const renderClassroomList=(el,items,empty)=>{if(!el)return;items=applyPriorityFilter(items,'classroom');if(!classroomCourses.length){el.innerHTML=`${toggleBarHtml('classroom')}<div class="empty-source small"><h3>${empty}</h3></div>`;bindToggleBar();return}el.innerHTML=`${toggleBarHtml('classroom')}<div class="email-tabs">${classroomCourses.map((course,i)=>`<span class="telegram-tab-wrap"><button class="email-tab ${i===0?'active':''}" data-classroom-tab="${course.id}">🎓 ${escapeHtml(course.name)}</button><button class="remove-chat" title="Stop following this class" data-remove-classroom="${course.id}">×</button></span>`).join('')}</div><div id="classroomGroupResults"></div>`;const showCourse=courseId=>{const course=classroomCourses.find(c=>c.id===courseId);let entries=items.filter(u=>u.space===course?.name);if(sourceFilterMode.classroom!=='priority')entries=entries.slice().sort(recencyCompare);$('#classroomGroupResults').innerHTML=entries.length?entries.map(messageCard).join(''):`<div class="empty-source small"><h3>No updates from ${escapeHtml(course?.name||'this class')} yet</h3><p>Press Sync Classroom to check for new announcements/assignments.</p></div>`;bindDetails()};$$('[data-classroom-tab]').forEach(tab=>tab.onclick=()=>{$$('[data-classroom-tab]').forEach(x=>x.classList.toggle('active',x===tab));showCourse(tab.dataset.classroomTab)});$$('[data-remove-classroom]').forEach(button=>button.onclick=async event=>{event.stopPropagation();if(!confirm('Stop Orbit from following this class?'))return;try{const result=await api('/api/classroom/remove',{method:'POST',body:JSON.stringify({courseId:button.dataset.removeClassroom})});classroomCourses=result.selected||[];const dashboard=await api('/api/dashboard');allUpdates=dashboard.updates||allUpdates;renderUpdates(allUpdates);renderSourceLists();toast('This class will no longer sync.')}catch(error){toast(error.message)}});showCourse(classroomCourses[0].id);bindToggleBar()};
  renderGroups($('#emailsList'),allUpdates.filter(u=>u.source==='email'),'email','No Gmail messages imported yet');
  renderGroups($('#collegeList'),allUpdates.filter(u=>u.source==='portal'&&(!u.receivedAt||Date.now()-new Date(u.receivedAt).getTime()<31*864e5)),'college','No college notices from the last 30 days');
  renderClassroomList($('#classroomList'),allUpdates.filter(u=>u.source==='classroom'),'No classes selected yet — press 🎓 Manage classes to choose which teachers\' Classroom to follow.');
  // Telegram: Channels / Groups / Private chats / With-attachments segregation, on top of the
  // existing per-chat tabs, plus the shared Priority/All toggle.
  const telegramEl=$('#telegramList');
  if(telegramEl){
    const telegramUpdates=applyPriorityFilter(allUpdates.filter(u=>u.source==='telegram'),'telegram');
    if(!telegramChats.length){telegramEl.innerHTML='<div class="empty-source small"><h3>No Telegram chats selected yet</h3><p>Choose the teacher channels or chats you want Orbit to import.</p></div>'}
    else{
      const types=[{key:'all',label:'All'},{key:'Channel',label:'Channels'},{key:'Group',label:'Groups'},{key:'Chat',label:'Private chats'},{key:'attachments',label:'📎 With attachments'}];
      telegramEl.innerHTML=`${toggleBarHtml('telegram')}<div class="email-tabs">${types.map((t,i)=>`<button class="email-tab ${i===0?'active':''}" data-telegram-type="${t.key}">${t.label}</button>`).join('')}</div><div id="telegramTypeChats"></div><div id="telegramChannelResults"></div>`;
      const renderChatTabs=typeKey=>{
        const chatsForType=(typeKey==='all'||typeKey==='attachments')?telegramChats:telegramChats.filter(c=>(c.type||'Chat')===typeKey);
        const wrap=$('#telegramTypeChats');
        if(!chatsForType.length){wrap.innerHTML='';$('#telegramChannelResults').innerHTML='<div class="empty-source small"><h3>No chats in this group</h3></div>';return}
        wrap.innerHTML=`<div class="email-tabs">${chatsForType.map((chat,i)=>`<span class="telegram-tab-wrap"><button class="email-tab ${i===0?'active':''}" data-telegram-tab="${chat.id}">${chat.title}<small class="chat-type-label ${chat.type==='Channel'?'channel':''}">${chat.type==='Channel'?'📡 Channel':(chat.type||'Chat')}</small></button><button class="remove-chat" title="Stop reading this chat" data-remove-chat="${chat.id}">×</button></span>`).join('')}</div>`;
        const showChat=id=>{const chat=chatsForType.find(item=>item.id===id);let items=telegramUpdates.filter(item=>item.telegramChatId===id||item.space===chat?.title);if(typeKey==='attachments')items=items.filter(item=>item.hasMedia);if(sourceFilterMode.telegram!=='priority')items=items.slice().sort(recencyCompare);$('#telegramChannelResults').innerHTML=items.length?items.map(messageCard).join(''):`<div class="empty-source small"><h3>No messages from ${chat?.title||'this chat'} yet</h3><p>Press Sync Telegram to import recent updates.</p></div>`;bindDetails()};
        $$('[data-telegram-tab]').forEach(tab=>tab.onclick=()=>{$$('[data-telegram-tab]').forEach(x=>x.classList.toggle('active',x===tab));showChat(tab.dataset.telegramTab)});
        $$('[data-remove-chat]').forEach(button=>button.onclick=async event=>{event.stopPropagation();if(!confirm('Stop Orbit from reading new messages from this chat?'))return;try{const result=await api('/api/telegram/remove-chat',{method:'POST',body:JSON.stringify({chatId:button.dataset.removeChat})});telegramChats=result.selected;renderSourceLists();toast('This chat will no longer sync.')}catch(error){toast(error.message)}});
        showChat(chatsForType[0].id);
      };
      $$('[data-telegram-type]').forEach(tab=>tab.onclick=()=>{$$('[data-telegram-type]').forEach(x=>x.classList.toggle('active',x===tab));renderChatTabs(tab.dataset.telegramType)});
      renderChatTabs('all');bindToggleBar();
    }
  }
  // WhatsApp: per-group tabs (with a remove-chat control, like Telegram) plus content-type
  // segregation — photos, videos, audio, PDFs, other files, links and plain chat.
  const whatsappEl=$('#whatsappList');
  if(whatsappEl){
    const whatsappUpdates=applyPriorityFilter(allUpdates.filter(u=>u.source==='whatsapp'),'whatsapp');
    const spaces=[...new Set(whatsappUpdates.map(u=>u.space))];
    if(!spaces.length){whatsappEl.innerHTML=`${toggleBarHtml('whatsapp')}<div class="empty-source small"><h3>No WhatsApp chats imported yet</h3><p>Export a chat from WhatsApp and import it above. Repeat with a different name to add another group — as many as you like.</p></div>`;bindToggleBar();}
    else{
      whatsappEl.innerHTML=`${toggleBarHtml('whatsapp')}<div class="email-tabs">${spaces.map((name,i)=>`<span class="telegram-tab-wrap"><button class="email-tab ${i===0?'active':''}" data-whatsapp-tab="${name}">${name}</button><button class="remove-chat" title="Stop tracking this chat" data-remove-wa="${name}">×</button></span>`).join('')}</div><div id="whatsappTypeTabs"></div><div id="whatsappGroupResults"></div>`;
      const waTypes=[{key:'all',label:'All'},{key:'photo',label:'📷 Photos'},{key:'video',label:'🎞 Videos'},{key:'music',label:'🎵 Audio'},{key:'pdf',label:'📄 PDFs'},{key:'file',label:'📎 Other files'},{key:'link',label:'🔗 Links'},{key:'text',label:'💬 Chat'}];
      const showWaGroup=name=>{
        let entries=whatsappUpdates.filter(u=>u.space===name);
        if(sourceFilterMode.whatsapp!=='priority')entries=entries.slice().sort(recencyCompare);
        $('#whatsappTypeTabs').innerHTML=`<div class="email-tabs">${waTypes.map((t,i)=>`<button class="email-tab ${i===0?'active':''}" data-wa-type="${t.key}">${t.label}</button>`).join('')}</div>`;
        const showType=typeKey=>{const filtered=typeKey==='all'?entries:entries.filter(u=>waTypeOf(u)===typeKey);$('#whatsappGroupResults').innerHTML=filtered.length?filtered.map(messageCard).join(''):`<div class="empty-source small"><h3>Nothing in this category yet</h3></div>`;bindDetails()};
        $$('[data-wa-type]').forEach(tab=>tab.onclick=()=>{$$('[data-wa-type]').forEach(x=>x.classList.toggle('active',x===tab));showType(tab.dataset.waType)});
        showType('all');
      };
      $$('[data-whatsapp-tab]').forEach(tab=>tab.onclick=()=>{$$('[data-whatsapp-tab]').forEach(x=>x.classList.toggle('active',x===tab));showWaGroup(tab.dataset.whatsappTab)});
      $$('[data-remove-wa]').forEach(button=>button.onclick=async event=>{event.stopPropagation();if(!confirm(`Stop tracking "${button.dataset.removeWa}" and delete its imported messages?`))return;try{await api('/api/sync/whatsapp-remove',{method:'POST',body:JSON.stringify({space:button.dataset.removeWa})});const dashboard=await api('/api/dashboard');allUpdates=dashboard.updates||[];allReminders=dashboard.reminders||allReminders;renderUpdates(allUpdates);renderSourceLists();renderCalendar();toast('This chat has been removed.')}catch(error){toast(error.message)}});
      showWaGroup(spaces[0]);bindToggleBar();
    }
  }
  bindDetails();bindFeedButtons();
}
// Renders an attachment preview inline (image/PDF/text/Word/Excel/PowerPoint) instead of just a
// link, so files open and can be read inside Orbit rather than forcing a download. Browsers
// have no native viewer for Office formats — even with an inline Content-Disposition header they'll
// still force-download .docx/.xlsx/.pptx — so those are fetched as bytes and rendered client-side
// with mammoth (Word), SheetJS (Excel) and JSZip (PowerPoint slide text). `renderAttachment` returns
// the HTML; the lazy-loaded preview types are filled in right after the modal is inserted into the page.
function escapeHtml(text){return String(text||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
// Turns plain-text URLs inside a message body into real clickable <a> links. Escapes everything
// else first so this never introduces an XSS hole via a synced message's text.
function linkify(text){const escaped=escapeHtml(text);return escaped.replace(/(https?:\/\/[^\s<]+[^\s<.,:;!?'")\]])/g,url=>`<a href="${url}" target="_blank" rel="noopener">${url}</a>`)}
// The AI (Gemini) is asked for plain prose but occasionally answers with markdown anyway
// (**bold**, "* " bullets, "# " headers). Previously those symbols leaked into the chat bubble
// as literal asterisks/hashes instead of being rendered or removed. This renders the handful of
// markdown bits Gemini actually tends to use, on top of the existing escaping/linkify.
function formatAiAnswer(text){
  const lines=String(text||'').replace(/\r\n/g,'\n').split('\n');
  let html='';let inList=false;
  const closeList=()=>{if(inList){html+='</ul>';inList=false}};
  for(const raw of lines){
    const line=raw.trim();
    if(!line){closeList();continue}
    const headerMatch=line.match(/^#{1,6}\s+(.*)$/);
    const bulletMatch=line.match(/^[*\-]\s+(.*)$/);
    let content=headerMatch?headerMatch[1]:bulletMatch?bulletMatch[1]:line;
    content=linkify(content)
      .replace(/\*\*(.+?)\*\*/g,'<b>$1</b>')
      .replace(/(^|[^*])\*([^*]+)\*/g,'$1<i>$2</i>');
    if(bulletMatch){
      if(!inList){html+='<ul>';inList=true}
      html+=`<li>${content}</li>`;
    }else{
      closeList();
      html+=`<p>${headerMatch?`<b>${content}</b>`:content}</p>`;
    }
  }
  closeList();
  return html||linkify(text);
}
// Short plain-text preview for the dashboard feed — the full message only appears once the
// student actually clicks in (via showDetail), instead of dumping the whole body inline.
function truncate(text,max){text=String(text||'').replace(/\s+/g,' ').trim();return text.length>max?text.slice(0,max).trimEnd()+'…':text}
// Newest-first ordering used for every plain message list (feed, email/college/telegram tabs,
// messages page) — falls back to the deadline when a synced item has no receivedAt timestamp.
function recencyCompare(a,b){return new Date(b.receivedAt||b.deadline||0)-new Date(a.receivedAt||a.deadline||0)}
function renderAttachment(url,name,mimeType,saveMeta={}){const mime=String(mimeType||'').toLowerCase();const ext=String(name||'').toLowerCase().match(/\.[a-z0-9]+$/)?.[0]||'';const isLegacyOffice=['application/msword','application/vnd.ms-excel','application/vnd.ms-powerpoint'].includes(mime)||['.doc','.xls','.ppt'].includes(ext);const isImage=mime.startsWith('image/')||['.jpg','.jpeg','.png','.gif','.webp','.heic'].includes(ext);const isPdf=mime==='application/pdf';const isVideo=mime.startsWith('video/')||['.mp4','.mov','.3gp','.mkv','.avi','.webm'].includes(ext);const isAudio=mime.startsWith('audio/')||['.mp3','.ogg','.opus','.m4a','.wav','.aac'].includes(ext);const isWord=!isLegacyOffice&&(mime.includes('wordprocessingml')||ext==='.docx');const isSheet=!isLegacyOffice&&(mime.includes('spreadsheetml')||ext==='.xlsx');const isSlides=!isLegacyOffice&&(mime.includes('presentationml')||ext==='.pptx');const isText=mime.startsWith('text/')||mime==='application/json';const icon=isImage?'🖼':isVideo?'🎞':isAudio?'🎵':isPdf?'📄':isWord?'📃':isSheet?'📊':isSlides?'📽':isLegacyOffice?(mime.includes('word')||ext==='.doc'?'📃':mime.includes('excel')||ext==='.xls'?'📊':'📽'):isText?'📝':'📎';let preview='';if(isImage)preview=`<img src="${url}" alt="${name}" loading="lazy">`;else if(isVideo)preview=`<video class="attachment-media" src="${url}" controls preload="metadata"></video>`;else if(isAudio)preview=`<audio class="attachment-media" src="${url}" controls preload="metadata"></audio>`;else if(isPdf)preview=`<iframe class="attachment-frame" src="${url}" title="${name}"></iframe>`;else if(isWord)preview=`<div class="attachment-doc" data-load-doc="${url}">Loading preview…</div>`;else if(isSheet)preview=`<div class="attachment-sheet" data-load-sheet="${url}">Loading preview…</div>`;else if(isSlides)preview=`<div class="attachment-slides" data-load-slides="${url}">Loading preview…</div>`;else if(isText)preview=`<pre class="attachment-text" data-load="${url}">Loading preview…</pre>`;else if(isLegacyOffice)preview=`<p class="sub">Older Office format — a live preview isn’t supported here.</p>`;const isOfficeDoc=isWord||isSheet||isSlides||isLegacyOffice;const linkLabel=isOfficeDoc?'Download original file':'Open in new tab';const saveData=encodeURIComponent(JSON.stringify({title:name,sourceLabel:saveMeta.sourceLabel||'',updateId:saveMeta.updateId||null,attachment:{url,name,mimeType:mimeType||''}}));return `<section class="attachment"><b>${icon} ${name}</b>${preview}<div class="attachment-actions"><a class="secondary" href="${url}" ${isOfficeDoc?'download':'target="_blank" rel="noopener"'}>${linkLabel}</a><button type="button" class="secondary save-attachment-btn" data-save-attachment="${saveData}">☆ Save to Important</button></div></section>`}
function loadTextPreviews(scope){scope.querySelectorAll('.attachment-text[data-load]').forEach(async pre=>{try{const response=await fetch(pre.dataset.load);const text=await response.text();pre.textContent=text.length>20000?`${text.slice(0,20000)}\n…(truncated, open in new tab for the full file)`:text||'This file is empty.'}catch(error){pre.textContent='Preview unavailable — try opening in a new tab.'}})}
// Word: convert the fetched bytes to HTML with mammoth, straight into the container.
// Excel: read the workbook with SheetJS and render each sheet (up to 5) as an HTML table.
// PowerPoint: pptx is a zip of slideN.xml files — pull the <a:t> text runs out of each slide
// with JSZip so the wording is readable, since there's no lightweight way to rasterize slides here.
function loadOfficePreviews(scope){scope.querySelectorAll('.attachment-doc[data-load-doc]').forEach(async el=>{try{if(!window.mammoth)throw Error('unavailable');const buffer=await(await fetch(el.dataset.loadDoc)).arrayBuffer();const result=await window.mammoth.convertToHtml({arrayBuffer:buffer});el.innerHTML=result.value||'<p class="sub">This document has no readable text.</p>'}catch(error){el.innerHTML='<p class="sub">Preview unavailable — try opening in a new tab.</p>'}});scope.querySelectorAll('.attachment-sheet[data-load-sheet]').forEach(async el=>{try{if(!window.XLSX)throw Error('unavailable');const buffer=await(await fetch(el.dataset.loadSheet)).arrayBuffer();const workbook=window.XLSX.read(buffer,{type:'array'});const sheets=workbook.SheetNames.slice(0,5).map(name=>`<h4>${name}</h4>${window.XLSX.utils.sheet_to_html(workbook.Sheets[name])}`);el.innerHTML=sheets.join('')||'<p class="sub">This spreadsheet is empty.</p>'}catch(error){el.innerHTML='<p class="sub">Preview unavailable — try opening in a new tab.</p>'}});scope.querySelectorAll('.attachment-slides[data-load-slides]').forEach(async el=>{try{if(!window.JSZip)throw Error('unavailable');const buffer=await(await fetch(el.dataset.loadSlides)).arrayBuffer();const zip=await window.JSZip.loadAsync(buffer);const slideFiles=Object.keys(zip.files).filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a,b)=>Number(a.match(/slide(\d+)/)[1])-Number(b.match(/slide(\d+)/)[1]));if(!slideFiles.length)throw Error('no slides');const slides=await Promise.all(slideFiles.map(async(name,i)=>{const xml=await zip.files[name].async('text');const texts=[...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m=>m[1]).filter(Boolean);return `<div class="slide-preview"><b>Slide ${i+1}</b><p>${texts.length?texts.join(' · '):'(no text on this slide)'}</p></div>`}));el.innerHTML=slides.join('')}catch(error){el.innerHTML='<p class="sub">Preview unavailable — try opening in a new tab.</p>'}})}
function showDetail(u){if(!u)return;let modal=$('#messageDetail');if(!modal){modal=document.createElement('div');modal.id='messageDetail';modal.className='detail-overlay';document.body.append(modal)}const telegramReady=Boolean(u.telegramChatId&&u.telegramMessageId);const telegramAttachment=u.hasMedia&&u.source==='telegram'?(telegramReady?renderAttachment(`/api/telegram/media/${u.id}`,u.mediaName||'Telegram file',u.mediaMime,{sourceLabel:'Telegram',updateId:u.id}):`<section class="attachment"><b>Attachment was found</b><span>Press Sync Telegram again to refresh this earlier import.</span></section>`):'';const whatsappAttachment=u.hasMedia&&u.source==='whatsapp'?renderAttachment(`/api/whatsapp/media/${u.id}`,u.mediaName||'WhatsApp file',u.mediaMime,{sourceLabel:'WhatsApp',updateId:u.id}):'';const gmailAttachments=(u.attachments||[]).map(file=>renderAttachment(`/api/gmail/attachment/${u.id}/${file.id}`,file.name,file.mimeType,{sourceLabel:'Gmail',updateId:u.id})).join('');const original=u.publicLink?`<a class="text-btn" href="${u.publicLink}" target="_blank">Open original source →</a>`:'';modal.innerHTML=`<article class="detail-card"><button id="closeDetail" class="modal-close">×</button><span class="tag official-tag">${u.source==='telegram'?'Telegram':category(u)}</span><p class="eyebrow">${u.sender}</p><h2>${u.title}</h2><div class="detail-scroll"><p>${u.body?linkify(u.body):'No message text was included.'}</p>${telegramAttachment}${whatsappAttachment}${gmailAttachments}${original}</div><div class="detail-actions"><button id="detailReminder" class="primary">Save reminder</button><button id="detailSaveImportant" class="secondary">☆ Save to Important</button></div></article>`;modal.classList.add('show');loadTextPreviews(modal);loadOfficePreviews(modal);$('#closeDetail').onclick=()=>modal.classList.remove('show');$('#detailReminder').onclick=async()=>{try{const result=await api('/api/reminders',{method:'POST',body:JSON.stringify({updateId:u.id})});allReminders=result.reminders||allReminders;renderCalendar();toast('Reminder is active for this update.');setTimeout(pollRemindersNow,1500)}catch(error){toast(error.message)}};$('#detailSaveImportant').onclick=()=>openSaveModal({title:u.title,sourceLabel:u.source,updateId:u.id});modal.querySelectorAll('[data-save-attachment]').forEach(button=>button.onclick=()=>{try{openSaveModal(JSON.parse(decodeURIComponent(button.dataset.saveAttachment)))}catch(error){toast('Could not open save options for this file.')}})}

// ---- Important: save any message or attachment (photo/video/document/link) into a folder you
// name yourself, or straight into "Direct saves" with no folder. openSaveModal is triggered from
// the ☆ button on a feed item, a detail-view message, or any individual attachment inside it.
function withExtension(base,originalName){const ext=(String(originalName||'').match(/\.[a-z0-9]{1,6}$/i)||[''])[0];const clean=base.replace(/[\\/:*?"<>|]/g,'').trim()||'file';return ext&&!clean.toLowerCase().endsWith(ext.toLowerCase())?`${clean}${ext}`:clean}
function openSaveModal(payload){let modal=$('#saveImportantModal');if(!modal){modal=document.createElement('div');modal.id='saveImportantModal';modal.className='detail-overlay';document.body.append(modal)}const folderOptions=importantFolders.map(f=>`<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('');modal.innerHTML=`<article class="detail-card"><button id="closeSaveModal" class="modal-close">×</button><p class="eyebrow">SAVE TO IMPORTANT</p><h2>Where should this go?</h2><div class="detail-scroll"><label>Name<input id="saveItemName" type="text" maxlength="140" value="${escapeHtml(payload.title||'')}" placeholder="Give this a name"></label><label>Save into<select id="saveFolderChoice"><option value="">Direct — no folder</option>${folderOptions}<option value="__new">+ Create a new folder…</option></select></label><label id="saveNewFolderWrap" class="hidden">New folder name<input id="saveNewFolderName" type="text" maxlength="80" placeholder="e.g. Maths, Hostel forms"></label></div><button id="confirmSaveImportant" class="primary">Save</button></article>`;modal.classList.add('show');$('#saveItemName').focus();$('#saveItemName').select();$('#closeSaveModal').onclick=()=>modal.classList.remove('show');$('#saveFolderChoice').onchange=()=>{$('#saveNewFolderWrap').classList.toggle('hidden',$('#saveFolderChoice').value!=='__new');if($('#saveFolderChoice').value==='__new')$('#saveNewFolderName').focus()};$('#confirmSaveImportant').onclick=async()=>{const finalTitle=$('#saveItemName').value.trim()||payload.title||'Saved item';const choice=$('#saveFolderChoice').value;const folderId=choice&&choice!=='__new'?choice:null;const folderName=choice==='__new'?$('#saveNewFolderName').value.trim():'';if(choice==='__new'&&!folderName)return toast('Give the new folder a name.');const attachment=payload.attachment?{...payload.attachment,name:withExtension(finalTitle,payload.attachment.name)}:null;try{const result=await api('/api/important/save',{method:'POST',body:JSON.stringify({title:finalTitle,sourceLabel:payload.sourceLabel||'',updateId:payload.updateId||null,attachment,folderId,folderName})});importantItems=result.importantItems||importantItems;importantFolders=result.importantFolders||importantFolders;modal.classList.remove('show');toast('Saved to Important.');renderImportantPage()}catch(error){toast(error.message)}}}
function renderImportantPage(){const folderList=$('#importantFolderList');const itemsList=$('#importantItemsList');if(!folderList||!itemsList)return;const directCount=importantItems.filter(i=>!i.folderId).length;const folderCount=id=>importantItems.filter(i=>i.folderId===id).length;folderList.innerHTML=`<button type="button" class="important-folder ${importantActiveFolder===null?'active':''}" data-folder="root">📌 Direct saves<span>${directCount}</span></button>`+importantFolders.map(f=>`<button type="button" class="important-folder ${importantActiveFolder===f.id?'active':''}" data-folder="${f.id}">📁 ${escapeHtml(f.name)}<span>${folderCount(f.id)}</span><i class="remove-folder" data-remove-folder="${f.id}" title="Delete folder">×</i></button>`).join('');const activeItems=importantItems.filter(i=>importantActiveFolder===null?!i.folderId:i.folderId===importantActiveFolder);const iconFor=label=>label==='WhatsApp'?'◔':label==='Telegram'?'✈':label==='Gmail'||label==='email'?'✉':label==='portal'?'⌘':'★';itemsList.innerHTML=activeItems.length?activeItems.map(item=>`<article class="feed-item important-item"><span class="source-icon portal">${iconFor(item.sourceLabel)}</span><div><div class="feed-heading"><b>${escapeHtml(item.title)}</b>${item.sourceLabel?`<span class="tag official-tag">${escapeHtml(item.sourceLabel)}</span>`:''}</div><p>Saved ${new Date(item.savedAt).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}${item.attachment?` · ${escapeHtml(item.attachment.name||'file')}`:''}</p><div class="feed-meta">${item.attachment?`<a href="${item.attachment.url}" target="_blank" rel="noopener">Open file →</a>`:item.updateId?`<button type="button" data-open-important="${item.updateId}">Open message →</button>`:''}</div></div><button class="dots" data-remove-important="${item.id}" title="Remove from Important">×</button></article>`).join(''):'<div class="empty-source small"><h3>Nothing saved here yet</h3><p>Use the ☆ Save to Important button on any message, photo, video or file to add it here.</p></div>';$$('[data-folder]').forEach(button=>button.onclick=()=>{importantActiveFolder=button.dataset.folder==='root'?null:button.dataset.folder;renderImportantPage()});$$('[data-remove-folder]').forEach(button=>button.onclick=async event=>{event.stopPropagation();if(!confirm('Delete this folder? Its saved items move back to Direct saves.'))return;try{const result=await api('/api/important/folders/remove',{method:'POST',body:JSON.stringify({id:button.dataset.removeFolder})});importantFolders=result.importantFolders||[];importantItems=result.importantItems||importantItems;importantActiveFolder=null;renderImportantPage();toast('Folder deleted.')}catch(error){toast(error.message)}});$$('[data-remove-important]').forEach(button=>button.onclick=async()=>{try{const result=await api('/api/important/remove',{method:'POST',body:JSON.stringify({id:button.dataset.removeImportant})});importantItems=result.importantItems||importantItems;renderImportantPage()}catch(error){toast(error.message)}});$$('[data-open-important]').forEach(button=>button.onclick=()=>{const update=allUpdates.find(x=>x.id===button.dataset.openImportant);if(update)showDetail(update);else toast('Open the source page and press Sync to refresh this message.')})}
const newFolderBtn=$('#newFolderBtn');if(newFolderBtn)newFolderBtn.onclick=async()=>{const name=prompt('Name this folder (e.g. Maths, Hostel forms):');if(!name||!name.trim())return;try{const result=await api('/api/important/folders',{method:'POST',body:JSON.stringify({name:name.trim()})});importantFolders=result.importantFolders||importantFolders;renderImportantPage();toast('Folder created.')}catch(error){toast(error.message)}};
// Add-your-own-file into Important: a camera photo of copy/handwritten notes, or any file
// picked from a laptop. Both read the file as base64, upload it, then reuse the same
// save-into-folder modal that "☆ Save to Important" already uses elsewhere in the app.
function fileToBase64(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');reader.onerror=()=>reject(reader.error||Error('Could not read that file.'));reader.readAsDataURL(file)})}
async function uploadImportantFile(file){
  if(!file)return;
  if(file.size>20*1024*1024)return toast('That file is larger than 20 MB — choose a smaller photo or file.');
  try{
    const base64=await fileToBase64(file);
    const result=await api('/api/important/upload',{method:'POST',body:JSON.stringify({data:base64,name:file.name,mimeType:file.type})});
    openSaveModal({title:file.name,sourceLabel:'Upload',attachment:{url:result.url,name:result.name||file.name,mimeType:result.mimeType||file.type}});
  }catch(error){toast(error.message||'Could not upload that file.')}
}
const importantCameraInput=$('#importantCameraInput');if(importantCameraInput)importantCameraInput.onchange=()=>{const file=importantCameraInput.files[0];uploadImportantFile(file);importantCameraInput.value=''};
const importantFileInput=$('#importantFileInput');if(importantFileInput)importantFileInput.onchange=()=>{const file=importantFileInput.files[0];uploadImportantFile(file);importantFileInput.value=''};
const importantAddFileBtn=$('#importantAddFileBtn');if(importantAddFileBtn)importantAddFileBtn.onclick=()=>{if(localPreview)return toast('Open http://localhost:3000 to add a file.');importantFileInput?.click()};
// ---- Live camera capture (works with a laptop's webcam, not just a phone's camera app).
// Opens a real video preview via getUserMedia, lets the student capture + retake, then uploads
// the captured frame the same way as any other Important upload. If the browser/device has no
// camera, or the student denies permission, it falls back to the hidden file input above —
// which on a phone still opens the native camera app via its capture="environment" attribute.
let cameraStream=null;let cameraFacingMode='environment';
const cameraModal=$('#cameraModal');
function stopCameraStream(){if(cameraStream){cameraStream.getTracks().forEach(track=>track.stop());cameraStream=null}}
function closeCameraModal(){stopCameraStream();cameraModal?.classList.add('hidden')}
function resetCameraModalButtons(){$('#cameraCaptureBtn')?.classList.remove('hidden');$('#cameraFlipBtn')?.classList.remove('hidden');$('#cameraRetakeBtn')?.classList.add('hidden');$('#cameraUseBtn')?.classList.add('hidden');$('#cameraVideoPreview')?.classList.remove('hidden');$('#cameraPreviewImg')?.classList.add('hidden')}
async function openCameraCapture(){
  if(localPreview)return toast('Open http://localhost:3000 to use the camera.');
  if(!navigator.mediaDevices?.getUserMedia)return importantCameraInput?.click();
  const errorEl=$('#cameraErrorMsg');errorEl?.classList.add('hidden');
  resetCameraModalButtons();
  cameraFacingMode='environment';
  try{
    cameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:cameraFacingMode},audio:false});
  }catch(error){
    toast('Could not access a camera on this device — pick a photo instead.');
    return importantCameraInput?.click();
  }
  const video=$('#cameraVideoPreview');if(video)video.srcObject=cameraStream;
  cameraModal?.classList.remove('hidden');
}
$('#closeCameraModal')?.addEventListener('click',closeCameraModal);
cameraModal?.addEventListener('click',e=>{if(e.target===cameraModal)closeCameraModal()});
// Flip between front/back camera — mainly useful on phones (laptops usually only have one
// camera, in which case this just toasts an error and leaves the current stream running).
$('#cameraFlipBtn')?.addEventListener('click',async()=>{
  const nextMode=cameraFacingMode==='environment'?'user':'environment';
  try{
    const newStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:nextMode},audio:false});
    stopCameraStream();
    cameraStream=newStream;cameraFacingMode=nextMode;
    const video=$('#cameraVideoPreview');if(video)video.srcObject=cameraStream;
  }catch(error){toast('Could not find another camera on this device.')}
});
$('#cameraCaptureBtn')?.addEventListener('click',()=>{
  const video=$('#cameraVideoPreview');const canvas=$('#cameraCanvas');const img=$('#cameraPreviewImg');
  if(!video||!canvas||!img)return;
  canvas.width=video.videoWidth||1280;canvas.height=video.videoHeight||720;
  canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
  img.src=canvas.toDataURL('image/jpeg',0.9);
  video.classList.add('hidden');img.classList.remove('hidden');
  $('#cameraCaptureBtn').classList.add('hidden');$('#cameraFlipBtn').classList.add('hidden');$('#cameraRetakeBtn').classList.remove('hidden');$('#cameraUseBtn').classList.remove('hidden');
});
$('#cameraRetakeBtn')?.addEventListener('click',resetCameraModalButtons);
$('#cameraUseBtn')?.addEventListener('click',async()=>{
  const canvas=$('#cameraCanvas');if(!canvas)return;
  const base64=canvas.toDataURL('image/jpeg',0.9).split(',')[1]||'';
  closeCameraModal();
  if(!base64)return toast('Could not capture that photo — try again.');
  const fileName=`photo-${Date.now()}.jpg`;
  try{
    const result=await api('/api/important/upload',{method:'POST',body:JSON.stringify({data:base64,name:fileName,mimeType:'image/jpeg'})});
    openSaveModal({title:fileName,sourceLabel:'Camera',attachment:{url:result.url,name:result.name||fileName,mimeType:result.mimeType||'image/jpeg'}});
  }catch(error){toast(error.message||'Could not upload that photo.')}
});
const importantTakePhotoBtn=$('#importantTakePhotoBtn');if(importantTakePhotoBtn)importantTakePhotoBtn.onclick=openCameraCapture;
function bindFeedButtons(){$$('[data-update]').forEach(b=>b.onclick=async()=>{try{const result=await api('/api/reminders',{method:'POST',body:JSON.stringify({updateId:b.dataset.update})});allReminders=result.reminders||allReminders;renderCalendar();toast('Reminder saved — we’ll notify you before it’s due.');setTimeout(pollRemindersNow,1500)}catch(error){toast(error.message)}});$$('[data-save-msg]').forEach(b=>b.onclick=()=>{const u=allUpdates.find(x=>x.id===b.dataset.saveMsg);if(u)openSaveModal({title:u.title,sourceLabel:u.source,updateId:u.id})});$$('[data-detail]').forEach(b=>b.onclick=()=>showDetail(allUpdates.find(x=>x.id===b.dataset.detail)))}
// ---- Calendar: real month grid (was a hardcoded static date list before), with month
// navigation, a "Today" jump, per-day deadline/reminder dots, and a busiest-day stat.
let allReminders=[];let customEvents=[];let calendarCursor=new Date();calendarCursor.setDate(1);
let importantFolders=[];let importantItems=[];let importantActiveFolder=null;
function calendarEvents(){const map={};const add=(dateStr,item)=>{if(!dateStr)return;const d=new Date(dateStr);if(Number.isNaN(d.getTime()))return;const key=`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;(map[key]=map[key]||[]).push(item)};allUpdates.forEach(u=>{if(u.deadline)add(u.deadline,{title:u.title,time:new Date(u.deadline).toLocaleTimeString('en-IN',{hour:'numeric',minute:'2-digit'}),kind:'deadline',sender:u.sender})});allReminders.forEach(r=>{const u=allUpdates.find(x=>x.id===r.updateId);const date=r.remindAt||u?.deadline;if(!date)return;add(date,{title:u?.title||'Reminder',time:new Date(date).toLocaleTimeString('en-IN',{hour:'numeric',minute:'2-digit'}),kind:'reminder',sender:u?.sender||''})});customEvents.forEach(e=>{add(e.at,{title:e.title,time:new Date(e.at).toLocaleTimeString('en-IN',{hour:'numeric',minute:'2-digit'}),kind:e.kind==='deadline'?'deadline':'custom',sender:'',customId:e.id})});return map}
function showCalendarDay(year,month,day){const events=(calendarEvents()[`${year}-${month}-${day}`]||[]).sort((a,b)=>a.time.localeCompare(b.time));const label=$('#calendarDayLabel');if(label)label.textContent=new Date(year,month,day).toLocaleDateString('en-IN',{weekday:'long',day:'2-digit',month:'short'}).toUpperCase();const agenda=$('#calendarAgenda');const dateForInput=`${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;if(agenda)agenda.innerHTML=(events.length?events.map(e=>`<article><i class="${e.kind==='deadline'?'event-red':'event-blue'}"></i><div><b>${e.title}</b><small>${e.time}${e.sender?' · '+e.sender:''}</small></div>${e.customId?`<button type="button" class="remove-chat" title="Delete this event" data-remove-event="${e.customId}">×</button>`:''}</article>`).join(''):'<p class="sub">No deadlines or reminders on this day yet.</p>')+`<button type="button" class="secondary add-day-btn" id="addForDay">+ Add for this day</button>`;$$('[data-remove-event]').forEach(button=>button.onclick=async()=>{try{const result=await api('/api/calendar/events/remove',{method:'POST',body:JSON.stringify({id:button.dataset.removeEvent})});customEvents=result.customEvents||customEvents;renderCalendar();toast('Event removed.')}catch(error){toast(error.message)}});const addForDay=$('#addForDay');if(addForDay)addForDay.onclick=()=>openEventModal('event',dateForInput);$$('[data-cal-day]').forEach(button=>button.classList.toggle('active-day',button.dataset.calDay===`${year}-${month}-${day}`))}
function renderCalendar(){const grid=$('#calendarDays');if(!grid)return;const year=calendarCursor.getFullYear(),month=calendarCursor.getMonth();const label=$('#calendarMonthLabel');if(label)label.textContent=calendarCursor.toLocaleDateString('en-IN',{month:'long',year:'numeric'});const first=new Date(year,month,1);const startOffset=(first.getDay()+6)%7;const daysInMonth=new Date(year,month+1,0).getDate();const daysInPrevMonth=new Date(year,month,0).getDate();const events=calendarEvents();const today=new Date();const cells=[];for(let i=0;i<startOffset;i++)cells.push({day:daysInPrevMonth-startOffset+i+1,muted:true});for(let d=1;d<=daysInMonth;d++)cells.push({day:d,muted:false});while(cells.length%7!==0)cells.push({day:cells.length-(startOffset+daysInMonth)+1,muted:true});grid.innerHTML=cells.map(cell=>{if(cell.muted)return `<button type="button" class="muted-date" disabled>${cell.day}</button>`;const key=`${year}-${month}-${cell.day}`;const dayEvents=events[key]||[];const isToday=today.getFullYear()===year&&today.getMonth()===month&&today.getDate()===cell.day;const hasDeadline=dayEvents.some(e=>e.kind==='deadline');const dots=dayEvents.length?`<span class="day-dots">${'●'.repeat(Math.min(dayEvents.length,3))}</span>`:'';return `<button type="button" class="${isToday?'today-date':''} ${hasDeadline?'deadline-date':''}" data-cal-day="${key}">${cell.day}${dots}</button>`}).join('');$$('[data-cal-day]').forEach(button=>button.onclick=()=>{const [y,m,d]=button.dataset.calDay.split('-').map(Number);showCalendarDay(y,m,d)});let total=0,busiestDay=null,busiestCount=0;Object.entries(events).forEach(([key,list])=>{const [y,m,d]=key.split('-').map(Number);if(y===year&&m===month){total+=list.length;if(list.length>busiestCount){busiestCount=list.length;busiestDay=d}}});const stats=$('#calendarStats');if(stats)stats.innerHTML=total?`<span>📌 ${total} item${total===1?'':'s'} this month</span>${busiestDay?`<span>🔥 Busiest day: ${busiestDay} ${calendarCursor.toLocaleDateString('en-IN',{month:'short'})} (${busiestCount})</span>`:''}`:'<span>No deadlines or reminders tracked yet this month.</span>';if(today.getFullYear()===year&&today.getMonth()===month)showCalendarDay(year,month,today.getDate());else{const firstReal=cells.find(c=>!c.muted);if(firstReal)showCalendarDay(year,month,firstReal.day)}renderRightRail()}
// Dashboard right rail: "Coming up" (today's non-deadline calendar items) and "Next deadlines"
// (soonest deadlines from synced updates + the calendar) — built only from real data, with a
// plain-language empty state instead of any placeholder content. Called from renderCalendar()
// so it always stays in sync with reminders/events without needing its own call sites.
function renderRightRail(){
  const upcomingEl=$('#railUpcomingBody');const deadlinesEl=$('#railDeadlinesBody');
  if(!upcomingEl||!deadlinesEl)return;
  const now=new Date();
  const todayKey=`${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const todays=(calendarEvents()[todayKey]||[]).slice().sort((a,b)=>a.time.localeCompare(b.time));
  upcomingEl.innerHTML=`<div class="date-line"><strong>${now.getDate()}</strong><span>${now.toLocaleDateString('en-IN',{month:'short'}).toUpperCase()}<br><b>Today</b></span></div>`+(todays.length?`<div class="agenda">${todays.map(e=>`<div><i></i><span><b>${escapeHtml(e.title)}</b><small>${e.time}${e.sender?' · '+escapeHtml(e.sender):''}</small></span></div>`).join('')}</div>`:'<p class="rail-empty">Nothing on today’s calendar yet.</p>');
  const upcomingDeadlines=[...allUpdates.filter(u=>u.deadline&&new Date(u.deadline)>now).map(u=>({title:u.title,at:u.deadline})),...customEvents.filter(e=>e.kind==='deadline'&&new Date(e.at)>now).map(e=>({title:e.title,at:e.at}))].sort((a,b)=>new Date(a.at)-new Date(b.at)).slice(0,3);
  deadlinesEl.innerHTML=upcomingDeadlines.length?upcomingDeadlines.map(d=>{const date=new Date(d.at);const diffDays=Math.ceil((date-now)/86400000);const dateClass=diffDays<=1?'red':diffDays<=5?'yellow':'blue';return `<div class="deadline"><span class="date ${dateClass}"><b>${date.getDate()}</b> ${date.toLocaleDateString('en-IN',{month:'short'}).toUpperCase()}</span><span><b>${escapeHtml(d.title)}</b><small>${timeLeftLabel(d.at)}</small></span></div>`}).join(''):'<p class="rail-empty">No upcoming deadlines yet.</p>';
}
// Deadlines page ("data-page=deadlines") — same real-data sources as the right rail, but the
// full sorted list. Populated on demand from setPage() rather than baked into the HTML.
function renderDeadlinesPage(){
  const el=$('#deadlinePageList');if(!el)return;
  const now=new Date();
  const items=[...allUpdates.filter(u=>u.deadline).map(u=>({title:u.title,at:u.deadline,tagLabel:category(u),sender:u.sender})),...customEvents.filter(e=>e.kind==='deadline').map(e=>({title:e.title,at:e.at,tagLabel:'Your calendar',sender:''}))].sort((a,b)=>new Date(a.at)-new Date(b.at));
  el.innerHTML=items.length?items.map(d=>{const date=new Date(d.at);const diffDays=Math.ceil((date-now)/86400000);const dateClass=diffDays<=1?'red':diffDays<=5?'yellow':'blue';return `<article class="deadline-large ${diffDays<=2?'urgent-line':''}"><span class="date ${dateClass}"><b>${date.getDate()}</b> ${date.toLocaleDateString('en-IN',{month:'short'}).toUpperCase()}</span><div><span class="tag official-tag">${escapeHtml(d.tagLabel)}</span><h3>${escapeHtml(d.title)}</h3>${d.sender?`<p>From ${escapeHtml(d.sender)}</p>`:''}</div><b>${timeLeftLabel(d.at)}</b></article>`}).join(''):'<div class="empty-source small"><h3>No deadlines yet</h3><p>Deadlines from synced updates or your calendar will show up here.</p></div>';
}
const calPrev=$('#calPrev'),calNext=$('#calNext'),calToday=$('#calToday');if(calPrev)calPrev.onclick=()=>{calendarCursor.setMonth(calendarCursor.getMonth()-1);renderCalendar()};if(calNext)calNext.onclick=()=>{calendarCursor.setMonth(calendarCursor.getMonth()+1);renderCalendar()};if(calToday)calToday.onclick=()=>{calendarCursor=new Date();calendarCursor.setDate(1);renderCalendar()};
renderCalendar();
// "+ Add reminder" (calendar page) and "+ Add deadline" (deadlines page) both open the same small
// form and save a real calendar entry through /api/calendar/events, so they actually show up on the
// month grid and day agenda instead of just toasting a placeholder message.
function openEventModal(kind,defaultDate){let modal=$('#eventModal');if(!modal){modal=document.createElement('div');modal.id='eventModal';modal.className='detail-overlay';document.body.append(modal)}const isDeadline=kind==='deadline';const todayStr=new Date().toISOString().slice(0,10);const dateValue=defaultDate||todayStr;modal.innerHTML=`<article class="detail-card"><button id="closeEventModal" class="modal-close">×</button><p class="eyebrow">CALENDAR</p><h2>Add to your calendar</h2><div class="detail-scroll"><label>Type<select id="eventKind"><option value="event" ${!isDeadline?'selected':''}>Reminder / important note</option><option value="deadline" ${isDeadline?'selected':''}>Deadline</option></select></label><label>Title<input id="eventTitle" type="text" maxlength="140" placeholder="e.g. Submit lab report, or Mom's birthday"></label><label>Date<input id="eventDate" type="date" value="${dateValue}"></label><label>Time<input id="eventTime" type="time" value="09:00"></label></div><button id="saveEventModal" class="primary">Save</button></article>`;modal.classList.add('show');$('#eventTitle').focus();$('#closeEventModal').onclick=()=>modal.classList.remove('show');$('#saveEventModal').onclick=async()=>{const title=$('#eventTitle').value.trim();const date=$('#eventDate').value;const time=$('#eventTime').value||'09:00';const chosenKind=$('#eventKind').value;if(!title)return toast('Give this event a title.');if(!date)return toast('Choose a date.');try{const result=await api('/api/calendar/events',{method:'POST',body:JSON.stringify({title,date,time,kind:chosenKind})});customEvents=result.customEvents||customEvents;renderCalendar();modal.classList.remove('show');toast(chosenKind==='deadline'?'Deadline added to your calendar.':'Added to your calendar.');setTimeout(pollRemindersNow,1500)}catch(error){toast(error.message)}}}
$('#addEvent').onclick=()=>openEventModal('event');$('#addDeadline').onclick=()=>openEventModal('deadline');$('#markRead').onclick=()=>toast('All displayed messages marked as read.');
$('#saveCollegeLink').onclick=async()=>{const value=$('#studentCollegeUrl').value.trim();if(!value)return toast('Paste your college website link first — the normal homepage or notices page is fine.');const button=$('#saveCollegeLink');try{const url=new URL(value);if(url.protocol!=='https:')return toast('Use an HTTPS college website link.');button.disabled=true;button.textContent='Saving…';await api('/api/integrations/config',{method:'POST',body:JSON.stringify({collegeFeedUrl:url.href})});localStorage.setItem('orbit-college-link',url.href);
    // A student just pasted a link — don't make them separately find and press "Sync notices"
    // too. Try the import right away so it either just works, or tells them clearly why not.
    button.textContent='Finding notices…';
    try{const result=await api('/api/sync/college-feed',{method:'POST'});const dashboard=await api('/api/dashboard');allUpdates=dashboard.updates||[];allReminders=dashboard.reminders||allReminders;renderUpdates(allUpdates);renderSourceLists();renderCalendar();toast(`College link saved — ${result.added||0} notices imported from ${result.source||'your college site'}.`)}
    catch(syncError){toast(`Link saved, but importing failed: ${syncError.message}`)}
  }catch(error){toast(error.message||'Enter a valid college website link.')}
  finally{button.disabled=false;button.textContent='Save link'}};
$('#studentCollegeUrl').value=localStorage.getItem('orbit-college-link')||'';
$$('[data-connect]').forEach(button=>button.onclick=async()=>{const source=button.dataset.connect;if(source==='google')return startGoogle();if(source==='classroom')return startClassroom();if(source==='telegram')return openTelegram();if(source==='whatsapp'){const navBtn=$$('[data-nav]').find(n=>n.dataset.nav==='whatsapp');return navBtn?navBtn.click():toast('Open the WhatsApp page to import an exported chat.')}const endpoint='/api/sync/college-feed';button.disabled=true;button.textContent='Syncing…';try{const result=await api(endpoint,{method:'POST'});toast(`College notices synced: ${result.added||0} new updates.`)}catch(error){toast(error.message)}finally{button.disabled=false;button.textContent='Sync notices'}});
$$('.source-sync').forEach(button=>button.onclick=async()=>{const type=button.dataset.source;const endpoint=type==='email'?'/api/sync/gmail':type==='telegram'?'/api/sync/telegram':type==='classroom'?'/api/sync/classroom':'/api/sync/college-feed';button.disabled=true;button.textContent='Syncing…';try{const result=await api(endpoint,{method:'POST'});const data=await api('/api/dashboard');allUpdates=data.updates||[];telegramChats=data.telegramChats||telegramChats;allReminders=data.reminders||allReminders;renderUpdates(allUpdates);renderSourceLists();renderCalendar();toast(`${result.added||0} new ${type==='email'?'Gmail':type==='classroom'?'Classroom':'updates'} imported.`)}catch(error){toast(error.message)}finally{button.disabled=false;button.textContent=type==='email'?'Sync Gmail':type==='telegram'?'Sync Telegram':type==='classroom'?'Sync Classroom':'Sync notices'}});
$('#globalSearch').oninput=e=>{const q=e.target.value.toLowerCase().trim();const results=allUpdates.filter(u=>`${u.sender} ${u.title} ${u.body}`.toLowerCase().includes(q));if(q){setPage('messages');$('#messagesPageList').innerHTML=results.length?results.map(u=>`<article class="source-message"><div><b>${u.sender}</b><h3>${u.title}</h3><p>${u.body}</p></div></article>`).join(''):'<div class="empty-source small"><h3>No matching updates</h3></div>'}else $('#messagesPageList').innerHTML=''};
$('#logoutBtn').onclick=async()=>{if(!localPreview)await api('/api/auth/logout',{method:'POST'});allUpdates=[];show(login);toast('You have been logged out.')};
async function ask(q){const chat=$('#aiChat');chat.insertAdjacentHTML('beforeend',`<div class="user-msg">${escapeHtml(q)}</div>`);const thinkingId=`t${Date.now()}`;chat.insertAdjacentHTML('beforeend',`<div class="bot-msg" id="${thinkingId}">Thinking…</div>`);chat.scrollTop=chat.scrollHeight;try{const result=await api('/api/ai/ask',{method:'POST',body:JSON.stringify({question:q})});$(`#${thinkingId}`).innerHTML=formatAiAnswer(result.answer)}catch(error){$(`#${thinkingId}`).textContent=error.message||'The AI could not answer that right now.'}chat.scrollTop=chat.scrollHeight}
$('#aiForm').onsubmit=e=>{e.preventDefault();const input=$('#aiInput');if(input.value.trim()){ask(input.value.trim());input.value=''}};
// Once a suggestion chip has been asked, remove it — the same suggestion shouldn't be offered
// again in this chat session. When none are left, hide the empty suggestions row.
$$('.suggestions button').forEach(b=>b.onclick=()=>{const text=b.textContent;ask(text);b.remove();const row=$('.suggestions');if(row&&!row.children.length)row.classList.add('hidden')});

function urlBase64ToUint8Array(base64String){const padding='='.repeat((4-base64String.length%4)%4);const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');const rawData=atob(base64);return Uint8Array.from([...rawData].map(c=>c.charCodeAt(0)))}
async function enablePushNotifications(){
  if(localPreview)return toast('Open http://localhost:3000 to enable real notifications.');
  if(!('serviceWorker' in navigator)||!('PushManager' in window))return toast('This browser does not support push notifications.');
  try{
    const {key}=await api('/api/push/vapid-public-key');
    if(!key)return toast('Notifications are not set up on the server yet (missing VAPID keys).');
    const permission=await Notification.requestPermission();
    if(permission!=='granted')return toast('Notifications were not allowed.');
    const registration=await navigator.serviceWorker.register('/service-worker.js');
    const existing=await registration.pushManager.getSubscription();
    const subscription=existing||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(key)});
    await api('/api/push/subscribe',{method:'POST',body:JSON.stringify(subscription)});
    toast('Notifications are on — you’ll get an alert when a deadline is close.')
  }catch(error){toast(error.message||'Could not enable notifications.')}
}
const enablePushBtn=$('#enablePushBtn');if(enablePushBtn)enablePushBtn.onclick=enablePushNotifications;
if(!localPreview&&'serviceWorker' in navigator&&Notification?.permission==='granted')navigator.serviceWorker.register('/service-worker.js').catch(()=>{});
// Manual WhatsApp chat import — reads the exported .txt (or .zip export, unzipped client-side with
// the same JSZip already loaded for PowerPoint previews), then sends the text to the server to parse.
const waMediaMimeByExt={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',mp4:'video/mp4',mov:'video/quicktime','3gp':'video/3gpp',mp3:'audio/mpeg',ogg:'audio/ogg',opus:'audio/ogg',m4a:'audio/mp4',wav:'audio/wav',pdf:'application/pdf'};
async function bufferToBase64(buffer){let binary='';const bytes=new Uint8Array(buffer);const chunk=0x8000;for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,i+chunk));return btoa(binary)}
const whatsappImportBtn=$('#whatsappImportBtn');if(whatsappImportBtn)whatsappImportBtn.onclick=async()=>{const fileInput=$('#whatsappFile');const file=fileInput.files[0];const chatName=$('#whatsappChatName').value.trim();if(!file)return toast('Choose the exported chat .txt or .zip file first.');if(!chatName)return toast('Give this chat/group a name.');whatsappImportBtn.disabled=true;whatsappImportBtn.textContent='Importing…';try{let text;let media={};if(file.name.toLowerCase().endsWith('.zip')){if(!window.JSZip)throw Error('Zip import needs an internet connection — try the .txt export instead.');const buffer=await file.arrayBuffer();const zip=await window.JSZip.loadAsync(buffer);const txtEntry=Object.values(zip.files).find(f=>!f.dir&&f.name.toLowerCase().endsWith('.txt'));if(!txtEntry)throw Error('No .txt chat file was found inside that zip.');text=await txtEntry.async('text');
  // Real photos/videos/audio only exist in a zip exported WITH media (not the plain-text-only
  // export). Pull each recognised media file out and send it along so it can be previewed inline
  // instead of showing as "<Media omitted>" with nothing to look at.
  const mediaEntries=Object.values(zip.files).filter(f=>!f.dir&&/\.[A-Za-z0-9]{2,5}$/.test(f.name)&&waMediaMimeByExt[f.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]]);
  for(const entry of mediaEntries.slice(0,500)){try{const fileBuffer=await entry.async('arraybuffer');if(fileBuffer.byteLength>25*1024*1024)continue;const ext=entry.name.toLowerCase().match(/\.([a-z0-9]+)$/)[1];media[entry.name.split('/').pop()]={mimeType:waMediaMimeByExt[ext],data:await bufferToBase64(fileBuffer)}}catch{/* skip a file that failed to read */}}
}else{text=await file.text()}const result=await api('/api/sync/whatsapp-import',{method:'POST',body:JSON.stringify({text,chatName,media})});const data=await api('/api/dashboard');allUpdates=data.updates||[];allReminders=data.reminders||allReminders;renderUpdates(allUpdates);renderSourceLists();renderCalendar();toast(`${result.added||0} new WhatsApp messages imported.`);fileInput.value=''}catch(error){toast(error.message||'Could not import that chat export.')}finally{whatsappImportBtn.disabled=false;whatsappImportBtn.textContent='Import chat'}};
function renderUpdates(updates){const top=updates.slice(0,3);const recent=[...updates].sort(recencyCompare).slice(0,3);const list=$('#feedList');const grid=$('.priority-grid');if(grid)grid.innerHTML=top.length?top.map(u=>`<article class="priority-card ${isUrgent(u)?'urgent':'event'}"><div class="card-top"><span class="priority-label">${u.source.toUpperCase()}</span>${deadlineBadge(u)}</div><div class="card-icon">${u.source==='email'?'✉':u.source==='telegram'?'✈':'⌘'}</div><h3>${u.title}</h3><p>From ${u.sender}</p><div class="card-foot"><span>${u.space}</span><b class="due"${u.deadline?` data-deadline="${u.deadline}"`:''}>${u.deadline?timeLeftLabel(u.deadline):`Priority ${u.priority||50}`}</b></div></article>`).join(''):`<article class="priority-card info"><h3>No updates yet</h3><p>Connect Gmail, Telegram or your college notices to see your priorities here.</p></article>`;list.innerHTML=recent.length?recent.map(u=>`<article class="feed-item ${isUrgent(u)?'urgent-card':''}"><span class="source-icon ${u.source==='teacher'?'teacher':u.source==='whatsapp'?'whatsapp':u.source==='email'?'mail':'portal'}">${u.source==='teacher'?'♙':u.source==='whatsapp'?'◔':u.source==='email'?'✉':'⌘'}</span><div><div class="feed-heading"><b>${u.sender}</b><span class="tag official-tag">${u.source}</span>${deadlineBadge(u)}</div><h3>${u.title}</h3><button type="button" class="feed-snippet" data-detail="${u.id}">${escapeHtml(truncate(u.body,130))}${String(u.body||'').replace(/\s+/g,' ').trim().length>130?' <span class="feed-more">Read more →</span>':''}</button><div class="feed-meta"><span>${u.space}</span><button data-update="${u.id}">Save reminder</button><button data-save-msg="${u.id}" title="Save to Important">☆ Save</button></div></div></article>`).join(''):'<div class="empty-source small"><h3>No real updates imported yet</h3><p>Use a source page to sync your selected messages.</p></div>';bindFeedButtons()}
$('#refreshBrief').onclick=async()=>{const b=$('#refreshBrief');try{const result=await api('/api/ai/brief',{method:'POST'});b.textContent='✓ Briefing refreshed';toast(result.summary);setTimeout(()=>b.textContent='↻ Refresh briefing',1500)}catch(error){toast('Start the backend to refresh the AI briefing.')}};

// ---- Live clock (HH:MM:SS) shown in the topbar — visible on every dashboard page since the
// topbar stays on screen across all of them.
function tickClock(){const el=$('#liveClock');if(el)el.textContent=new Date().toLocaleTimeString('en-IN',{hour12:false})}
tickClock();setInterval(tickClock,1000);
setInterval(()=>{const gw=$('#greetingWord');if(gw)gw.textContent=getGreetingWord()},60000);

// ---- Reminder/notification fallback that works even when the server can't run a background
// job (e.g. deployed on Vercel/serverless — see the comment on dueSoonForAccount in server.js).
// While the dashboard tab is open, poll the server every couple of minutes for anything within
// the alert window; show it as a toast and, if the browser has already granted permission, a
// real OS notification too — independent of whether push-subscribe was ever set up.
// Subtle two-tone chime played whenever a reminder/deadline notification lands, so an alert is
// never silent even if OS notification permission was never granted (Web Audio needs no asset file).
function playReminderChime(){
  try{
    const Ctx=window.AudioContext||window.webkitAudioContext;if(!Ctx)return;
    const ctx=new Ctx();
    const now=ctx.currentTime;
    [[880,now,0.16],[659,now+0.16,0.22]].forEach(([freq,start,dur])=>{
      const osc=ctx.createOscillator();const gain=ctx.createGain();
      osc.type='sine';osc.frequency.value=freq;
      gain.gain.setValueAtTime(0.0001,start);
      gain.gain.exponentialRampToValueAtTime(0.11,start+0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001,start+dur);
      osc.connect(gain);gain.connect(ctx.destination);
      osc.start(start);osc.stop(start+dur+0.02);
    });
    setTimeout(()=>ctx.close().catch(()=>{}),700);
  }catch{/* ignore — audio isn't essential */}
}
// A real on-screen popup (not just the small toast bar) for a reminder/deadline that has just
// come due while the student is on the site — paired with the chime above so it's impossible to
// miss even with the tab in the background. Queues so a second alert doesn't stomp on the first.
let reminderPopupQueue=[];
function showReminderPopup(item){
  reminderPopupQueue.push(item);
  if(reminderPopupQueue.length>1)return; // one already showing — it'll show this one when closed
  renderReminderPopup();
}
function renderReminderPopup(){
  const item=reminderPopupQueue[0];if(!item)return;
  let modal=$('#reminderPopup');if(!modal){modal=document.createElement('div');modal.id='reminderPopup';modal.className='detail-overlay';document.body.append(modal)}
  modal.innerHTML=`<article class="detail-card"><button id="closeReminderPopup" class="modal-close">×</button><p class="eyebrow">⏰ DUE NOW</p><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.body)}</p><button id="viewReminderBtn" class="primary wide">View calendar →</button></article>`;
  modal.classList.add('show');
  const advance=()=>{reminderPopupQueue.shift();modal.classList.remove('show');if(reminderPopupQueue.length)setTimeout(renderReminderPopup,300)};
  $('#closeReminderPopup').onclick=advance;
  $('#viewReminderBtn').onclick=()=>{advance();$$('[data-nav]').forEach(x=>x.classList.toggle('active',x.dataset.nav==='calendar'));setPage('calendar')};
}
let reminderPollTimer=null;
async function pollRemindersNow(){
  if(localPreview)return;
  try{
    const result=await api('/api/reminders/check-now');
    (result.dueSoon||[]).forEach(item=>{
      toast(`⏰ ${item.title} — ${item.body}`);
      playReminderChime();
      showReminderPopup(item);
      if(typeof Notification!=='undefined'&&Notification.permission==='granted'){try{new Notification(`⏰ ${item.title}`,{body:item.body})}catch{}}
    });
  }catch{/* offline or session expired — silently retry next tick */}
}
function startReminderPolling(){
  if(localPreview||reminderPollTimer)return;
  pollRemindersNow();
  // Poll every 20s while the tab is open — quick enough that a reminder set "1 min from now"
  // still gets caught well before it's due, instead of waiting on a multi-minute cycle.
  reminderPollTimer=setInterval(pollRemindersNow,20*1000);
}

// ---- Profile page: a plain read-only summary of the account (name, college, year, branch,
// communities, connected sources) that lives in the sidebar nav, separate from the "Edit
// profile" flow which reopens the onboarding form.
function renderProfilePage(user){
  const page=$('[data-page="profile"]');if(!page)return;
  const set=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=value||'—'};
  set('profilePageName',user.name);
  set('profilePageEmail',user.email);
  set('profilePageCollege',user.college);
  set('profilePageCollegeUrl',localStorage.getItem('orbit-college-link')||'');
  set('profilePageDept',user.department);
  set('profilePageYear',[user.year,user.semester].filter(Boolean).join(' · '));
  set('profilePageSection',user.section);
  const spacesEl=$('#profilePageSpaces');if(spacesEl)spacesEl.innerHTML=(user.spaces||[]).length?user.spaces.map(s=>`<span class="tag official-tag">${escapeHtml(s)}</span>`).join(''):'<span class="sub">No communities added yet.</span>';
  const connectorsEl=$('#profilePageConnectors');if(connectorsEl){const c=user.connectors||{};const rows=[['Google email','email'],['WhatsApp','whatsapp'],['Telegram','telegram'],['College portal','portal'],['Google Classroom','classroom']];connectorsEl.innerHTML=rows.map(([label,key])=>`<div class="deadline"><span>${label}</span><b>${c[key]||'not connected'}</b></div>`).join('')}
}
const profilePageEditBtn=$('#profilePageEditBtn');if(profilePageEditBtn)profilePageEditBtn.onclick=$('#editProfileBtn').onclick;