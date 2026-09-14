import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import webpush from 'web-push';
import nodemailer from 'nodemailer';

const root = fileURLToPath(new URL('.', import.meta.url));
async function loadLocalEnv(){
  try{const text=await readFile(join(root,'.env'),'utf8');for(const line of text.split(/\r?\n/)){const match=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);if(match&&!process.env[match[1]])process.env[match[1]]=match[2].replace(/^['"]|['"]$/g,'')}}catch{}
}
await loadLocalEnv();
const dataDir = join(root, 'data');
const dbFile = join(dataDir, 'orbit.json');
const whatsappMediaDir = join(dataDir, 'whatsapp-media');
const importantMediaDir = join(dataDir, 'important-media');
// Web push: only actually send once the app owner has generated VAPID keys
// (npx web-push generate-vapid-keys) and put them in .env. Without them the
// reminder scheduler below simply skips sending — it never crashes the app.
function pushReady(){return Boolean(process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY)}
if(pushReady())webpush.setVapidDetails(process.env.VAPID_SUBJECT||'mailto:admin@orbit.local',process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);
// Email reminders: only actually send once the app owner has put SMTP credentials in .env
// (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS — an app password works for Gmail). Without them the
// reminder scheduler below simply skips emailing — it never crashes the app, same pattern as push.
function mailReady(){return Boolean(process.env.SMTP_HOST&&process.env.SMTP_USER&&process.env.SMTP_PASS)}
let mailTransport=null;
function getMailTransport(){
  if(!mailReady())return null;
  if(!mailTransport)mailTransport=nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:process.env.SMTP_SECURE==='true',auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}});
  return mailTransport;
}
// Sends the "due tomorrow" reminder email for one update to one student. Called from the
// background sweep below once a saved reminder's deadline is ~24 hours away.
async function sendReminderEmail(account,update){
  const transport=getMailTransport();if(!transport||!account.email)return;
  const deadlineStr=update.deadline?new Date(update.deadline).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}):'soon';
  const appUrl=process.env.APP_BASE_URL||'http://localhost:3000';
  try{
    await transport.sendMail({
      from:process.env.SMTP_FROM||process.env.SMTP_USER,
      to:account.email,
      subject:`⏰ Due tomorrow: ${update.title}`,
      text:`Hi ${(account.name||'').split(' ')[0]},\n\n"${update.title}" from ${update.sender} is due ${deadlineStr} — about a day from now.\n\nOpen Orbit to review it: ${appUrl}\n`,
      html:`<p>Hi ${(account.name||'').split(' ')[0]},</p><p><b>${update.title}</b> from ${update.sender} is due <b>${deadlineStr}</b> — about a day from now.</p><p><a href="${appUrl}">Open Orbit</a> to review it.</p>`
    });
  }catch(error){console.error('Reminder email failed:',error.message)}
}
// Same "day before" email, but for something the student added directly on the calendar (a
// deadline or a plain reminder/event) rather than a reminder saved from a synced update.
async function sendCalendarEventEmail(account,event){
  const transport=getMailTransport();if(!transport||!account.email)return;
  const whenStr=new Date(event.at).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'});
  const appUrl=process.env.APP_BASE_URL||'http://localhost:3000';
  const isDeadline=event.kind==='deadline';
  try{
    await transport.sendMail({
      from:process.env.SMTP_FROM||process.env.SMTP_USER,
      to:account.email,
      subject:`⏰ ${isDeadline?'Due tomorrow':'Coming up tomorrow'}: ${event.title}`,
      text:`Hi ${(account.name||'').split(' ')[0]},\n\n"${event.title}" (from your calendar) is ${isDeadline?'due':'set for'} ${whenStr} — about a day from now.\n\nOpen Orbit to review it: ${appUrl}\n`,
      html:`<p>Hi ${(account.name||'').split(' ')[0]},</p><p><b>${event.title}</b> (from your calendar) is ${isDeadline?'due':'set for'} <b>${whenStr}</b> — about a day from now.</p><p><a href="${appUrl}">Open Orbit</a> to review it.</p>`
    });
  }catch(error){console.error('Calendar event email failed:',error.message)}
}
function geminiReady(){return Boolean(process.env.GEMINI_API_KEY)}
// Small wrapper around Google's Gemini API (free tier available at https://aistudio.google.com/apikey)
// so the AI panel gives a real, on-topic answer instead of a canned string. Keeps the student's
// updates as context so answers ("what's due this week?") are grounded in their real data.
async function askGemini(systemPrompt,userMessage){
  if(!geminiReady())throw Error('AI is not configured yet. The app owner must add GEMINI_API_KEY in .env.');
  // 'gemini-flash-latest' is a Google-maintained alias that always points at their current
  // stable Flash model, so this keeps working as Gemini versions change — pin GEMINI_MODEL in
  // .env only if you specifically want a fixed version. If that primary model is overloaded we
  // fall back to 'gemini-flash-lite-latest', a separate (usually less congested) capacity pool,
  // instead of giving up on the first model alone.
  const models=[process.env.GEMINI_MODEL||'gemini-flash-latest','gemini-flash-lite-latest'];
  const call=async(model)=>{
    // 12s hard timeout per attempt — without this, a hung/slow Gemini response leaves the
    // student staring at "Thinking…" indefinitely with no way out.
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),12_000);
    try{
      const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({system_instruction:{parts:[{text:systemPrompt}]},contents:[{role:'user',parts:[{text:userMessage}]}],generationConfig:{maxOutputTokens:400}})});
      const payload=await response.json();
      return {ok:response.ok,status:response.status,payload};
    }catch(error){
      return {ok:false,status:error.name==='AbortError'?408:0,payload:{error:{message:error.name==='AbortError'?'Gemini took too long to respond.':error.message}}};
    }finally{clearTimeout(timeout)}
  };
  // Google's free tier occasionally returns a transient 429/503 "overloaded" error even when the
  // key and quota are fine. Retry briefly before moving to the next model, instead of surfacing
  // "high demand" to the student on the very first hiccup — but kept short (2 tries, small
  // backoff) so a bad day costs seconds, not tens of seconds, before falling back gracefully.
  let last;
  for(const model of models){
    for(let attempt=0;attempt<2;attempt++){
      last=await call(model);
      if(last.ok)return finish(last);
      if(![429,503,408,0].includes(last.status))return finish(last);
      await new Promise(r=>setTimeout(r,400*(attempt+1)));
    }
  }
  return finish(last);
  function finish(result){
    if(!result.ok)throw Error(result.payload.error?.message||'AI request failed — please try again in a moment.');
    const text=(result.payload.candidates?.[0]?.content?.parts||[]).map(part=>part.text||'').join('\n').trim();
    return text||'I could not find an answer for that.';
  }
}
function updatesContext(updates){return priority(updates).slice(0,25).map(u=>`- [${u.source}] ${u.sender} — "${u.title}"${u.deadline?` (deadline: ${new Date(u.deadline).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'})})`:''}: ${String(u.body||'').slice(0,220)}`).join('\n')||'No updates have been synced yet.'}
// "Classify"/"how many" — a pure count-by-source breakdown of TODAY's updates. Deliberately does
// NOT call Gemini: the numbers are already in data.updates, so computing them locally is instant
// and never fails/queues behind an AI call, unlike a free-text question would.
const SOURCE_LABELS={email:'email',whatsapp:'WhatsApp message',telegram:'Telegram message',classroom:'Google Classroom update',portal:'college notice'};
function classifyBreakdown(updates){
  const todayKey=new Date().toDateString();
  const todays=updates.filter(u=>u.receivedAt&&new Date(u.receivedAt).toDateString()===todayKey);
  if(!todays.length)return "No updates have come in today yet across any of your connected sources.";
  const parts=Object.entries(SOURCE_LABELS).map(([source,label])=>{const count=todays.filter(u=>u.source===source).length;return count?`${count} ${label}${count===1?'':'s'}`:null}).filter(Boolean);
  return `Today you've got ${todays.length} update${todays.length===1?'':'s'} in total — ${parts.join(', ')}.`;
}
// "Prioritize" — the same priority ordering the dashboard already uses (urgency + deadline),
// just returned as a short numbered list. Also no AI call: it's a straight read of existing data.
function prioritizeList(updates){
  const top=priority(updates).slice(0,6);
  if(!top.length)return "There's nothing to prioritize yet — sync a source first.";
  return top.map((u,i)=>`${i+1}. [${u.source}] ${u.title}${u.deadline?` — due ${new Date(u.deadline).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'})}`:''}`).join('\n');
}
// Looks for the exact message(s) a question is pointing at — e.g. "what did Prakshi send in the
// class group" or "find the audio note in CSAI chat" — by matching sender/space/chat names
// mentioned in the question, rather than relying on the top-25-by-priority summary above (which
// truncates each body to 220 chars and can leave out an older, lower-priority message entirely).
// When a match is found its FULL body is included so the AI can quote/describe it precisely.
function matchedUpdatesContext(updates,question){
  const stop=new Set(['the','a','an','of','in','on','for','to','me','my','is','are','was','were','what','which','who','send','sent','message','msg','chat','group','from','and','that','this','with','please','give','show','find','recent','latest']);
  const tokens=[...new Set(String(question||'').toLowerCase().match(/[a-z0-9\u0900-\u097F]+/g)||[])].filter(t=>t.length>2&&!stop.has(t));
  if(!tokens.length)return '';
  const nameField=u=>`${u.sender||''} ${u.space||''}`.toLowerCase();
  const matches=updates.filter(u=>{const field=nameField(u);return tokens.some(t=>field.includes(t))});
  if(!matches.length)return '';
  const sorted=matches.sort((a,b)=>new Date(b.receivedAt||b.deadline||0)-new Date(a.receivedAt||a.deadline||0)).slice(0,20);
  return sorted.map(u=>`- [${u.source}] ${u.sender} (in "${u.space}") — "${u.title}"${u.receivedAt?` (received: ${new Date(u.receivedAt).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'})})`:''}: ${String(u.body||'').slice(0,1000)}`).join('\n');
}
const sessions = new Map();
const oauthStates = new Map();
const classroomOauthStates = new Map();
const telegramVerifications = new Map();
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml' };
const seed = { users: [], appConfig: {}, updates: [
  { id:'u1', source:'teacher', sender:'Prof. Mehra', space:'Class CSE A', title:'Assignment 01 submission instructions', body:'Submit a single PDF with your code link before Sunday, 11:59 PM.', priority:100, deadline:'2026-09-13T23:59:00+05:30' },
  { id:'u2', source:'whatsapp', sender:'E-Cell · Official', space:'E-Cell', title:'Hackathon ’26 registrations are live!', body:'Find your team of 2–4 and register via the shared form.', priority:70, deadline:'2026-09-16T23:59:00+05:30' },
  { id:'u3', source:'portal', sender:'Academic Office', space:'College portal', title:'Merit scholarship applications open', body:'Eligible first-year students can apply through the portal by September 22.', priority:80, deadline:'2026-09-22T23:59:00+05:30' }
] };
const hash = value => createHash('sha256').update(value).digest('hex');
function migrateData(data){let changed=false;const seedIds=new Set(['u1','u2','u3']);if(Array.isArray(data.updates)){const before=data.updates.length;data.updates=data.updates.filter(update=>!seedIds.has(update.id));changed||=before!==data.updates.length;for(const update of data.updates.filter(item=>item.source==='telegram'&&!item.telegramChatId)){const match=String(update.externalId||'').match(/^telegram:(-?\d+):(\d+)$/);if(match){update.telegramChatId=match[1];update.telegramMessageId=Number(match[2]);update.mediaName=update.mediaName||'Telegram attachment';changed=true;}}}return changed;}
async function db(){ try { const data=JSON.parse(await readFile(dbFile, 'utf8'));if(migrateData(data))await save(data);return data; } catch { await mkdir(dataDir,{recursive:true});await writeFile(dbFile, JSON.stringify({users:[],appConfig:{},updates:[]},null,2));return {users:[],appConfig:{},updates:[]}; } }
async function save(data){ await mkdir(dataDir,{recursive:true}); await writeFile(dbFile, JSON.stringify(data,null,2)); }
function send(res,status,body,headers={}){ res.writeHead(status,{ 'Content-Type':'application/json; charset=utf-8', ...headers });res.end(JSON.stringify(body)); }
const attachmentMimeByExt={'.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8','.csv':'text/csv; charset=utf-8','.json':'application/json; charset=utf-8','.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xls':'application/vnd.ms-excel','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.ppt':'application/vnd.ms-powerpoint','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.mp4':'video/mp4','.mov':'video/quicktime','.mp3':'audio/mpeg','.ogg':'audio/ogg','.zip':'application/zip'};
// Attachments used to fall back to application/octet-stream whenever the source (Gmail/Telegram)
// didn't report a mime type. Browsers always force-download octet-stream, even with an inline
// Content-Disposition. Guessing from the file extension fixes previews for images/PDFs/text/etc.
function resolveMime(fileName,mimeType){const clean=String(mimeType||'').trim();if(clean&&clean!=='application/octet-stream')return clean;const ext=String(fileName||'').toLowerCase().match(/\.[a-z0-9]+$/)?.[0];return (ext&&attachmentMimeByExt[ext])||clean||'application/octet-stream';}
function sendFile(res,bytes,mimeType,fileName){const safeName=String(fileName||'attachment').replace(/[^a-zA-Z0-9._ -]/g,'_');const resolvedType=resolveMime(fileName,mimeType);res.writeHead(200,{'Content-Type':resolvedType,'Content-Length':bytes.length,'Content-Disposition':`inline; filename="${safeName}"`,'Cache-Control':'private, no-store'});res.end(bytes);}
function cookies(req){ return Object.fromEntries((req.headers.cookie||'').split(';').filter(Boolean).map(x=>x.trim().split('='))); }
function user(req){ return sessions.get(cookies(req).orbit_session); }
async function body(req){ let raw='';for await(const c of req) raw+=c;if(raw.length>60_000_000) throw Error('That import is too large — split it into smaller chats or fewer media files.');return raw?JSON.parse(raw):{}; }
// Parses a WhatsApp "Export chat" (.txt) file. This only reads a file the student explicitly
// exported and uploaded themselves — it is not an automated/live read of anyone's chats, which
// WhatsApp's API does not allow. Handles both Android ("12/09/26, 10:15 - Name: text") and
// iOS ("[12/09/26, 10:15:00] Name: text") export formats, and folds multi-line messages together.
const whatsappLineRe=/^\u200e?\[?(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?\s?(?:[APap][Mm])?)\]?\s*-?\s*([^:]{1,60}):\s(.*)$/;
// If the message references an attached file ("IMG-xxx.jpg (file attached)" on Android, or
// "<attached: IMG-xxx.jpg>" on iOS), remember that exact filename so it can be matched against
// the real media bytes uploaded from a "with media" .zip export (see /api/sync/whatsapp-import).
function attachedFileName(body){const match=String(body||'').match(/([\w\-. ]+\.[A-Za-z0-9]{2,5})\s*\(file attached\)/i)||String(body||'').match(/<attached:\s*([\w\-. ]+\.[A-Za-z0-9]{2,5})>/i);return match?match[1].trim():null}
function parseWhatsAppExport(text){const lines=String(text||'').split(/\r?\n/);const messages=[];for(const raw of lines){const line=raw.replace(/\u200e/g,'').trim();if(!line)continue;const match=line.match(whatsappLineRe);if(match){const [,dateStr,timeStr,sender,msgBody]=match;if(/added|removed|changed the subject|created group|security code|joined using this group|left$/i.test(msgBody)&&!msgBody.includes(' '))continue;messages.push({dateStr,timeStr,sender:sender.trim(),body:msgBody.trim(),fileName:attachedFileName(msgBody)})}else if(messages.length){messages[messages.length-1].body+=`\n${line}`}}return messages}
function whatsappIso(dateStr,timeStr){const [d,m,yRaw]=dateStr.split('/').map(Number);const y=yRaw<100?2000+yRaw:yRaw;const ampm=timeStr.match(/[APap][Mm]/);let [hh,mm]=timeStr.replace(/[^\d:]/g,'').split(':').map(Number);if(ampm){const isPM=/pm/i.test(ampm[0]);if(isPM&&hh<12)hh+=12;if(!isPM&&hh===12)hh=0}const dt=new Date(y,(m||1)-1,d,hh||0,mm||0);return Number.isNaN(dt.getTime())?null:dt.toISOString()}
function safeUser(u){ const { passwordHash, oauth, ...publicUser }=u;return publicUser; }
function priority(u){ return [...u].sort((a,b)=>b.priority-a.priority || new Date(a.deadline)-new Date(b.deadline)); }
function redirect(res, location){res.writeHead(302,{Location:location});res.end()}
function appBase(req){return process.env.APP_BASE_URL || `http://${req.headers.host}`}
function googleConfig(data){return {clientId:process.env.GOOGLE_CLIENT_ID||data.appConfig?.googleClientId,clientSecret:process.env.GOOGLE_CLIENT_SECRET||data.appConfig?.googleClientSecret}}
function googleReady(data){const config=googleConfig(data);return Boolean(config.clientId&&config.clientSecret)}
function telegramReady(){return Boolean(process.env.TELEGRAM_API_ID&&process.env.TELEGRAM_API_HASH)}
function telegramClient(session=''){if(!telegramReady())throw Error('Telegram connection is not configured yet. The app owner must add TELEGRAM_API_ID and TELEGRAM_API_HASH on the server.');return new TelegramClient(new StringSession(session),Number(process.env.TELEGRAM_API_ID),process.env.TELEGRAM_API_HASH,{connectionRetries:3});}
async function googleAccessToken(account,data){
  const config=googleConfig(data);
  const grant=account.oauth?.google;if(!grant)throw Error('Connect Google first.');
  if(grant.accessToken&&Date.now()<grant.expiresAt-60_000)return grant.accessToken;
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.clientId,client_secret:config.clientSecret,refresh_token:grant.refreshToken,grant_type:'refresh_token'})});
  const tokens=await response.json();if(!response.ok)throw Error(tokens.error_description||'Google token refresh failed.');grant.accessToken=tokens.access_token;grant.expiresAt=Date.now()+tokens.expires_in*1000;return grant.accessToken;
}
// Classroom uses the SAME Google OAuth client as Gmail (just a separate consent/token grant with
// Classroom scopes) — no extra client id/secret needed, only the Classroom API enabled on the
// same Google Cloud project. Kept as its own oauth grant (account.oauth.classroom) so a student
// can connect Classroom under a different Google account than the one used for college email.
async function classroomAccessToken(account,data){
  const config=googleConfig(data);
  const grant=account.oauth?.classroom;if(!grant)throw Error('Connect Google Classroom first.');
  if(grant.accessToken&&Date.now()<grant.expiresAt-60_000)return grant.accessToken;
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.clientId,client_secret:config.clientSecret,refresh_token:grant.refreshToken,grant_type:'refresh_token'})});
  const tokens=await response.json();if(!response.ok)throw Error(tokens.error_description||'Classroom token refresh failed.');grant.accessToken=tokens.access_token;grant.expiresAt=Date.now()+tokens.expires_in*1000;return grant.accessToken;
}
function header(headers,name){return headers?.find(x=>x.name.toLowerCase()===name.toLowerCase())?.value||''}
function base64UrlText(value){try{return Buffer.from(String(value||'').replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8')}catch{return ''}}
function gmailContent(payload){let text='';const attachments=[];const visit=part=>{if(!part)return;const type=part.mimeType||'';if(type==='text/plain'&&part.body?.data&&!text)text=base64UrlText(part.body.data);if(type==='text/html'&&part.body?.data&&!text)text=base64UrlText(part.body.data).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();if(part.filename&&part.body?.attachmentId)attachments.push({id:part.body.attachmentId,name:part.filename,mimeType:type||'application/octet-stream',size:part.body.size||0});for(const child of part.parts||[])visit(child)};visit(payload);return {text:text.slice(0,12000),attachments};}
function updatePriority(message){const text=`${message.sender} ${message.title} ${message.body}`.toLowerCase();let score=50;if(/prof|teacher|faculty|assignment|exam|deadline/.test(text))score+=45;if(/official|academic|scholarship|notice/.test(text))score+=30;if(/urgent|tomorrow|today/.test(text))score+=20;if(/hackathon|internship|placement|scholarship/.test(text))score+=15;if(message.deadline){const days=(new Date(message.deadline)-Date.now())/86400000;if(days<=1)score+=45;else if(days<=3)score+=28;else if(days<=7)score+=12}return Math.min(score,150)}
// Lightweight heuristic deadline extractor: looks for "Month Day[, Year]" or "dd/mm/yyyy" style
// dates inside a message's title/body so real synced Gmail/Telegram/WhatsApp updates get a usable
// deadline (previously only the seed data had one). Not a full NLP parser — best-effort only.
const monthIdx={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
function extractDeadline(text){
  const t=String(text||'');
  let match=t.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-zA-Z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i);
  if(match){
    const month=monthIdx[match[1].toLowerCase().slice(0,3)];const day=Number(match[2]);let year=match[3]?Number(match[3]):new Date().getFullYear();
    let date=new Date(year,month,day,23,59,0);
    if(!match[3]&&date.getTime()<Date.now()-45*86400000)date=new Date(year+1,month,day,23,59,0);
    if(!Number.isNaN(date.getTime()))return date.toISOString();
  }
  match=t.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
  if(match){
    const day=Number(match[1]),month=Number(match[2])-1,yearRaw=Number(match[3]);const year=yearRaw<100?2000+yearRaw:yearRaw;
    const date=new Date(year,month,day,23,59,0);
    if(!Number.isNaN(date.getTime())&&month>=0&&month<=11)return date.toISOString();
  }
  return null;
}
// Classifies a WhatsApp message body into a content type — photo/video/music/pdf/file/link/text —
// so the WhatsApp page can segregate messages the way a student expects (photos, videos, audio,
// PDFs, other files, links, and plain chat), even for the plain-text ("Without media") export.
const waMediaExt={jpg:'photo',jpeg:'photo',png:'photo',gif:'photo',webp:'photo',heic:'photo',mp4:'video',mov:'video','3gp':'video',mkv:'video',avi:'video',mp3:'music',ogg:'music',opus:'music',m4a:'music',wav:'music',aac:'music',pdf:'pdf'};
function classifyWhatsApp(body){
  const text=String(body||'');
  const attached=text.match(/([\w\-. ]+)\.([A-Za-z0-9]{2,5})\s*\(file attached\)/i)||text.match(/<attached:\s*([\w\-. ]+)\.([A-Za-z0-9]{2,5})>/i);
  if(attached)return waMediaExt[attached[2].toLowerCase()]||'file';
  if(/<Media omitted>|image omitted/i.test(text))return 'photo';
  if(/video omitted/i.test(text))return 'video';
  if(/audio omitted|voice note omitted/i.test(text))return 'music';
  if(/gif omitted|sticker omitted/i.test(text))return 'photo';
  if(/document omitted|contact card omitted/i.test(text))return 'file';
  if(/https?:\/\/\S+/i.test(text))return 'link';
  return 'text';
}
function telegramMediaInfo(message){const document=message.media?.document;const attribute=document?.attributes?.find(item=>item.fileName);const fileName=attribute?.fileName||'';const mimeType=document?.mimeType||(message.media?'image/jpeg':'');return message.media?{hasMedia:true,mediaName:fileName||'Telegram attachment',mediaMime:mimeType}:{};}
async function syncGmail(data,account){
  const token=await googleAccessToken(account,data);const headers={Authorization:`Bearer ${token}`};
  const listing=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20&q='+encodeURIComponent('newer_than:30d'),{headers});const list=await listing.json();if(!listing.ok)throw Error(list.error?.message||'Unable to read Gmail.');let added=0;
  for(const row of list.messages||[]){const response=await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${row.id}?format=full`,{headers});const message=await response.json();if(!response.ok)continue;const sender=header(message.payload.headers,'From'),title=header(message.payload.headers,'Subject')||'(No subject)',content=gmailContent(message.payload);const existing=data.updates.find(x=>x.externalId===row.id);if(existing){Object.assign(existing,{body:content.text||existing.body,attachments:content.attachments,deadline:existing.deadline||extractDeadline(`${title} ${content.text}`)});existing.priority=updatePriority(existing);continue}const entry={id:randomUUID(),externalId:row.id,source:'email',sender,space:'College email',title,body:content.text||message.snippet||'',attachments:content.attachments,deadline:extractDeadline(`${title} ${content.text}`),priority:0,receivedAt:new Date(Number(message.internalDate||Date.now())).toISOString()};entry.priority=updatePriority(entry);data.updates.push(entry);added++;
  }await save(data);return {added};
}
// Pulls announcements and coursework (assignments) from the courses the student explicitly
// selected (account.oauth.classroom.courses — set via /api/classroom/select) and turns them into
// normal updates (source:'classroom') alongside email/telegram/portal — same priority scoring,
// same reminder/Important flow. Coursework due dates come back as separate {year,month,day} +
// {hours,minutes} objects, so they're combined into a real ISO deadline the rest of the app
// already knows how to badge/sort/remind on. Courses the student hasn't picked are never synced.
// Lists every ACTIVE course the connected Classroom account can see, for the "choose which
// classes to follow" picker — this alone does NOT import anything; only /api/classroom/select
// (and then a sync) does.
async function listClassroomCourses(account,data){
  const token=await classroomAccessToken(account,data);
  const res=await fetch('https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE&pageSize=100',{headers:{Authorization:`Bearer ${token}`}});
  const payload=await res.json();if(!res.ok)throw Error(payload.error?.message||'Unable to read Google Classroom. Reconnect Classroom and try again.');
  return (payload.courses||[]).map(c=>({id:c.id,name:(c.name||'Untitled class').slice(0,140)}));
}
async function syncClassroom(data,account){
  const selectedCourses=account.oauth?.classroom?.courses||[];
  if(!selectedCourses.length)return {added:0};
  const token=await classroomAccessToken(account,data);const headers={Authorization:`Bearer ${token}`};
  let added=0;
  for(const course of selectedCourses){
    const annRes=await fetch(`https://classroom.googleapis.com/v1/courses/${course.id}/announcements?pageSize=30&orderBy=updateTime%20desc`,{headers});
    const annPayload=annRes.ok?await annRes.json():{announcements:[]};
    for(const item of annPayload.announcements||[]){
      const externalId=`classroom-ann:${item.id}`;if(data.updates.some(u=>u.externalId===externalId))continue;
      const text=item.text||'Classroom announcement';
      const entry={id:randomUUID(),externalId,source:'classroom',sender:course.name,space:course.name,title:text.split('\n')[0].slice(0,120)||'Classroom announcement',body:text,publicLink:item.alternateLink||'',deadline:extractDeadline(text),priority:0,receivedAt:item.creationTime||new Date().toISOString()};
      entry.priority=updatePriority(entry);data.updates.push(entry);added++;
    }
    const workRes=await fetch(`https://classroom.googleapis.com/v1/courses/${course.id}/courseWork?pageSize=30&orderBy=updateTime%20desc`,{headers});
    const workPayload=workRes.ok?await workRes.json():{courseWork:[]};
    for(const item of workPayload.courseWork||[]){
      const externalId=`classroom-work:${item.id}`;
      let deadline=null;
      if(item.dueDate){const {year,month,day}=item.dueDate;const time=item.dueTime||{};const dt=new Date(year,(month||1)-1,day,time.hours??23,time.minutes??59);if(!Number.isNaN(dt.getTime()))deadline=dt.toISOString()}
      const existing=data.updates.find(u=>u.externalId===externalId);
      if(existing){existing.deadline=deadline||existing.deadline;existing.priority=updatePriority(existing);continue}
      const entry={id:randomUUID(),externalId,source:'classroom',sender:course.name,space:course.name,title:(item.title||'Assignment').slice(0,140),body:item.description||'',publicLink:item.alternateLink||'',deadline,priority:0,receivedAt:item.creationTime||new Date().toISOString()};
      entry.priority=updatePriority(entry);data.updates.push(entry);added++;
    }
  }
  await save(data);return {added};
}
// Note on "the channel was made private": Orbit reads Telegram through the student's own
// logged-in account (via their phone number), not a bot, so a channel being public or private
// makes no difference by itself — the only thing that matters is whether the student's account is
// still a member. If it stopped syncing after going private, check that the account used to sign
// in here is still in the channel, and increase this limit if the account is in 300+ chats.
function telegramDialogs(client){return client.getDialogs({limit:300});}
async function syncTelegram(data,account){
  const grant=account.oauth?.telegram;if(!grant?.session)throw Error('Connect Telegram and choose the chats you want Orbit to read first.');if(!grant.chats?.length)throw Error('Choose at least one Telegram chat first.');
  const client=telegramClient(grant.session);let added=0;try{await client.connect();const dialogs=await telegramDialogs(client);const chosen=new Set(grant.chats.map(chat=>String(chat.id)));for(const dialog of dialogs.filter(item=>chosen.has(String(item.id)))){let count=0;for await(const message of client.iterMessages(dialog,{limit:30})){if(!message||count++>=30)break;const text=(message.message||message.text||'').trim();const mediaLabel=message.media?'Shared photo, file or note':'';if(!text&&!mediaLabel)continue;const externalId=`telegram:${dialog.id}:${message.id}`;const publicLink=dialog.entity?.username?`https://t.me/${dialog.entity.username}/${message.id}`:'';const existing=data.updates.find(item=>item.externalId===externalId);if(existing){Object.assign(existing,{telegramChatId:String(dialog.id),telegramMessageId:message.id,publicLink:existing.publicLink||publicLink,deadline:existing.deadline||extractDeadline(text),...telegramMediaInfo(message)});existing.priority=updatePriority(existing);continue}const entry={id:randomUUID(),externalId,source:'telegram',sender:dialog.title||'Telegram chat',space:dialog.title||'Telegram',title:(text.split('\n')[0]||mediaLabel).slice(0,100),body:text||mediaLabel,telegramChatId:String(dialog.id),telegramMessageId:message.id,telegramChatType:dialog.isChannel?'Channel':dialog.isGroup?'Group':'Chat',publicLink,...telegramMediaInfo(message),deadline:extractDeadline(text),priority:0,receivedAt:message.date?new Date(message.date*1000).toISOString():new Date().toISOString()};entry.priority=updatePriority(entry);data.updates.push(entry);added++;}}await save(data);return {added};}finally{await client.disconnect().catch(()=>{});}
}
// A student usually just has their college's normal homepage/notices-page link, not an RSS URL —
// they shouldn't need to know what RSS even is. So before falling back to loose HTML scraping
// (which can pick up navigation menus and other junk on an arbitrary page), we first try to
// discover the college's *real* RSS/Atom feed automatically: look for a <link rel="alternate">
// tag in the page the student gave us, and if that's not there, try the handful of URLs almost
// every RSS-enabled site uses (WordPress, most CMSs, etc).
async function fetchText(url){const response=await fetch(url,{headers:{'User-Agent':'Orbit notices reader/1.0'}});return response.ok?await response.text():null}
function hasFeedItems(rawPage){return /<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/.test(rawPage)}
async function discoverFeed(startUrl,startPage){
  const linkTag=startPage.match(/<link[^>]+rel=["']alternate["'][^>]*type=["']application\/(?:rss|atom)\+xml["'][^>]*>/i)||startPage.match(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*rel=["']alternate["'][^>]*>/i);
  const declaredHref=linkTag?.[0]?.match(/href=["']([^"']+)["']/i)?.[1];
  const candidates=[];
  if(declaredHref)candidates.push(new URL(declaredHref,startUrl).href);
  const origin=new URL(startUrl).origin;
  for(const path of['/feed','/feed/','/rss','/rss.xml','/feed.xml','/atom.xml','/notices/feed','/notices/rss'])candidates.push(origin+path);
  for(const candidate of candidates){
    try{const page=await fetchText(candidate);if(page&&hasFeedItems(page))return {url:candidate,page}}catch{ /* try the next candidate */ }
  }
  return null;
}
async function syncCollegeFeed(data,account){
  const feed=account.integrationConfig?.collegeFeedUrl||process.env.COLLEGE_PORTAL_FEED_URL;if(!feed)throw Error('Paste your college website or notices page link first.');if(!feed.startsWith('https://'))throw Error('College website must use HTTPS.');
  let rawPage=await fetchText(feed);if(rawPage===null)throw Error('College website could not be downloaded.');
  let usedSource='official notice page';
  if(!hasFeedItems(rawPage)){
    const discovered=await discoverFeed(feed,rawPage);
    if(discovered){rawPage=discovered.page;usedSource='official RSS/Atom feed'}
  }
  let items=[...rawPage.matchAll(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/g)].slice(0,60);const clean=s=>(s||'').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]*>/g,' ').replace(/<!\[CDATA\[|\]\]>/g,'').replace(/\s+/g,' ').trim();if(!items.length){usedSource='page scan (no RSS feed found)';items=[...rawPage.matchAll(/<(article|li)[^>]*>([\s\S]*?)<\/\1>/gi)].map(match=>[match[0]]).slice(0,60)}let added=0;
  for(const [raw] of items){const title=clean(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||raw.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i)?.[1]||raw.match(/<a[^>]*>([\s\S]*?)<\/a>/i)?.[1]);const link=clean(raw.match(/<link[^>]*>([\s\S]*?)<\/link>|<link[^>]*href=["']([^"']+)/i)?.[1]||raw.match(/<a[^>]*href=["']([^"']+)/i)?.[1]);const externalId=`college:${link||title}`;if(!title||title.length<5||data.updates.some(x=>x.externalId===externalId))continue;const entry={id:randomUUID(),externalId,source:'portal',sender:'College notice board',space:'College portal',title:title.slice(0,180),body:clean(raw.match(/<description[^>]*>([\s\S]*?)<\/description>|<summary[^>]*>([\s\S]*?)<\/summary>/i)?.[1]||raw).slice(0,1200),publicLink:link?.startsWith('http')?link:'',deadline:null,priority:0,receivedAt:new Date().toISOString()};entry.deadline=extractDeadline(`${entry.title} ${entry.body}`);entry.priority=updatePriority(entry);data.updates.push(entry);added++;
  }await save(data);return {added,source:items.length?usedSource:'no notices found'};
}
async function api(req,res,url){
  const method=req.method; const current=user(req);
  if(method==='GET'&&url.pathname==='/api/oauth/google/start'){
    const data=await db();const config=googleConfig(data);if(!googleReady(data))return redirect(res,'/?connection=google-setup-required');
    // access_type=offline is enough to receive a refresh_token the FIRST time a student
    // authorizes this app. We used to also force prompt=consent on every single login, which
    // makes Google show the full "Continue as ..." permissions screen again each time — instead
    // of remembering a student already approved it. Dropping prompt=consent here means Google
    // only shows that screen once per student; after that it signs them in silently (or with a
    // quick account-picker if they have multiple Google accounts signed into the browser).
    const state=randomUUID();oauthStates.set(state,{createdAt:Date.now()});const callback=`${appBase(req)}/api/oauth/google/callback`;const params=new URLSearchParams({client_id:config.clientId,redirect_uri:callback,response_type:'code',scope:'openid email profile https://www.googleapis.com/auth/gmail.readonly',access_type:'offline',state});return redirect(res,`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  }
  if(method==='GET'&&url.pathname==='/api/oauth/google/callback'){
    const state=oauthStates.get(url.searchParams.get('state'));oauthStates.delete(url.searchParams.get('state'));if(!state||Date.now()-state.createdAt>600_000)return redirect(res,'/?auth=failed');if(url.searchParams.get('error'))return redirect(res,'/?auth=cancelled');
    const data=await db();const config=googleConfig(data);const callback=`${appBase(req)}/api/oauth/google/callback`;const exchange=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code:url.searchParams.get('code'),client_id:config.clientId,client_secret:config.clientSecret,redirect_uri:callback,grant_type:'authorization_code'})});const tokens=await exchange.json();if(!exchange.ok)return redirect(res,'/?auth=failed');const profileResponse=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${tokens.access_token}`}});const profile=await profileResponse.json();if(!profile.email)return redirect(res,'/?auth=failed');
    let account=data.users.find(x=>x.email===profile.email.toLowerCase());if(!account){account={id:randomUUID(),name:profile.name||profile.email.split('@')[0],passwordHash:hash(randomUUID()),email:profile.email.toLowerCase(),college:'',department:'',year:'',semester:'',profileCompleted:false,profileVersion:0,spaces:[],connectors:{whatsapp:'not connected',email:'connected',telegram:'not connected',portal:'not connected',classroom:'not connected'},reminders:[],createdAt:new Date().toISOString()};data.users.push(account)}account.oauth={...(account.oauth||{}),google:{accessToken:tokens.access_token,refreshToken:tokens.refresh_token||account.oauth?.google?.refreshToken,expiresAt:Date.now()+tokens.expires_in*1000}};account.connectors.email='connected';await save(data);const token=randomUUID();sessions.set(token,account.id);res.writeHead(302,{'Set-Cookie':`orbit_session=${token}; HttpOnly; SameSite=Lax; Path=/`,Location:`/?auth=google&profile=${account.profileVersion===3?'complete':'required'}`});return res.end();
  }
  // Google Classroom connect — a separate grant from the Gmail login above, on purpose: a
  // student may be signed into Orbit with one email but use a different Google account for
  // school Classroom. This requires an existing Orbit session (unlike /oauth/google/start,
  // which doubles as sign-in) and accepts an optional ?email= login_hint so Google's account
  // picker opens pre-filled with the Classroom account the student names — the student can
  // still switch accounts on Google's screen, this only sets the default.
  if(method==='GET'&&url.pathname==='/api/oauth/classroom/start'){
    if(!current)return redirect(res,'/?classroom=login-required');
    const data=await db();const config=googleConfig(data);if(!googleReady(data))return redirect(res,'/?classroom=setup-required');
    const state=randomUUID();classroomOauthStates.set(state,{createdAt:Date.now(),accountId:current});
    const callback=`${appBase(req)}/api/oauth/classroom/callback`;
    const scope='openid email https://www.googleapis.com/auth/classroom.courses.readonly https://www.googleapis.com/auth/classroom.announcements.readonly https://www.googleapis.com/auth/classroom.coursework.me.readonly https://www.googleapis.com/auth/classroom.coursework.students.readonly';
    const params=new URLSearchParams({client_id:config.clientId,redirect_uri:callback,response_type:'code',scope,access_type:'offline',prompt:'consent',state});
    const hint=String(url.searchParams.get('email')||'').trim();if(hint)params.set('login_hint',hint);
    return redirect(res,`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  }
  if(method==='GET'&&url.pathname==='/api/oauth/classroom/callback'){
    const stateKey=url.searchParams.get('state');const state=classroomOauthStates.get(stateKey);classroomOauthStates.delete(stateKey);
    if(!state||Date.now()-state.createdAt>600_000)return redirect(res,'/?classroom=failed');
    if(url.searchParams.get('error'))return redirect(res,'/?classroom=cancelled');
    const data=await db();const account=data.users.find(x=>x.id===state.accountId);if(!account)return redirect(res,'/?classroom=failed');
    const config=googleConfig(data);const callback=`${appBase(req)}/api/oauth/classroom/callback`;
    const exchange=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code:url.searchParams.get('code'),client_id:config.clientId,client_secret:config.clientSecret,redirect_uri:callback,grant_type:'authorization_code'})});
    const tokens=await exchange.json();if(!exchange.ok)return redirect(res,'/?classroom=failed');
    const profileResponse=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${tokens.access_token}`}});
    const profile=await profileResponse.json().catch(()=>({}));
    account.oauth={...(account.oauth||{}),classroom:{email:profile.email||'',accessToken:tokens.access_token,refreshToken:tokens.refresh_token||account.oauth?.classroom?.refreshToken,expiresAt:Date.now()+tokens.expires_in*1000,courses:account.oauth?.classroom?.courses||[]}};
    account.connectors=account.connectors||{};account.connectors.classroom='connected — choose classes';
    await save(data);
    return redirect(res,'/?classroom=connected');
  }
  if(method==='POST'&&url.pathname==='/api/auth/register'){
    const {name,email,password,college='',department='',year='',spaces=[]}=await body(req); if(!name||!email||!password)return send(res,400,{error:'Name, email and password are required.'});
    const data=await db(); if(data.users.some(x=>x.email===email.toLowerCase()))return send(res,409,{error:'An account already exists for this email.'});
    const newUser={id:randomUUID(),name,email:email.toLowerCase(),passwordHash:hash(password),college,department,year,spaces,connectors:{whatsapp:'not connected',email:'not connected',portal:'not connected',classroom:'not connected'},reminders:[],createdAt:new Date().toISOString()};data.users.push(newUser);await save(data);
    const token=randomUUID();sessions.set(token,newUser.id);return send(res,201,{user:safeUser(newUser)},{'Set-Cookie':`orbit_session=${token}; HttpOnly; SameSite=Lax; Path=/`});
  }
  if(method==='POST'&&url.pathname==='/api/auth/login'){
    const {email,password}=await body(req);const data=await db();const account=data.users.find(x=>x.email===String(email).toLowerCase()&&x.passwordHash===hash(password));if(!account)return send(res,401,{error:'Incorrect email or password.'});const token=randomUUID();sessions.set(token,account.id);return send(res,200,{user:safeUser(account)},{'Set-Cookie':`orbit_session=${token}; HttpOnly; SameSite=Lax; Path=/`});
  }
  if(method==='POST'&&url.pathname==='/api/auth/demo'){
    const data=await db();let account=data.users.find(x=>x.email==='demo@orbit.local');if(!account){account={id:randomUUID(),name:'Aanya Sharma',email:'demo@orbit.local',passwordHash:hash('demo'),college:'Delhi Technological University',department:'Computer Science & Engineering',year:'1st Year · CSE A',spaces:['Class CSE A','CSE Department','E-Cell','Coding Club'],connectors:{whatsapp:'not connected',email:'not connected',portal:'not connected',classroom:'not connected'},reminders:[],createdAt:new Date().toISOString()};data.users.push(account);await save(data)}const token=randomUUID();sessions.set(token,account.id);return send(res,200,{user:safeUser(account)},{'Set-Cookie':`orbit_session=${token}; HttpOnly; SameSite=Lax; Path=/`});
  }
  if(method==='POST'&&url.pathname==='/api/auth/logout'){ sessions.delete(cookies(req).orbit_session);return send(res,200,{ok:true},{'Set-Cookie':'orbit_session=; Max-Age=0; Path=/'}); }
  if(!current)return send(res,401,{error:'Please sign in first.'});
  const data=await db();const account=data.users.find(x=>x.id===current);if(!account)return send(res,401,{error:'Session expired.'});
  if(method==='GET'&&url.pathname==='/api/me')return send(res,200,{user:safeUser(account)});
  if(method==='PUT'&&url.pathname==='/api/me'){ const incoming=await body(req);Object.assign(account,{name:incoming.name??account.name,college:incoming.college??account.college,department:incoming.department??account.department,year:incoming.year??account.year,semester:incoming.semester??account.semester,section:incoming.section??account.section,profileCompleted:Boolean(incoming.profileCompleted??true),profileVersion:incoming.profileCompleted?3:(account.profileVersion||0),spaces:Array.isArray(incoming.spaces)?incoming.spaces:account.spaces});await save(data);return send(res,200,{user:safeUser(account)}); }
  if(method==='GET'&&url.pathname==='/api/dashboard')return send(res,200,{user:safeUser(account),updates:priority(data.updates),reminders:account.reminders,customEvents:account.customEvents||[],telegramChats:account.oauth?.telegram?.chats||[],classroomCourses:account.oauth?.classroom?.courses||[],importantFolders:account.importantFolders||[],importantItems:account.importantItems||[]});
  if(method==='GET'&&url.pathname.startsWith('/api/gmail/attachment/')){try{const [updateId,attachmentId]=url.pathname.replace('/api/gmail/attachment/','').split('/');const update=data.updates.find(item=>item.id===updateId&&item.source==='email');const attachment=update?.attachments?.find(item=>item.id===attachmentId);if(!update||!attachment)return send(res,404,{error:'This Gmail attachment is not available. Press Sync Gmail to refresh this email.'});const token=await googleAccessToken(account,data);const response=await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${update.externalId}/attachments/${attachmentId}`,{headers:{Authorization:`Bearer ${token}`}});const payload=await response.json();if(!response.ok||!payload.data)return send(res,404,{error:'Gmail could not load this attachment.'});return sendFile(res,Buffer.from(payload.data.replace(/-/g,'+').replace(/_/g,'/'),'base64'),attachment.mimeType,attachment.name);}catch(error){return send(res,400,{error:error.message||'Could not open Gmail attachment.'})}}
  if(method==='GET'&&url.pathname.startsWith('/api/telegram/media/')){try{const update=data.updates.find(item=>item.id===url.pathname.split('/').pop()&&item.source==='telegram');if(!update?.telegramChatId||!update.telegramMessageId)return send(res,404,{error:'This attachment is not available.'});const grant=account.oauth?.telegram;if(!grant?.session)return send(res,401,{error:'Reconnect Telegram to view attachments.'});const client=telegramClient(grant.session);try{await client.connect();const dialogs=await telegramDialogs(client);const dialog=dialogs.find(item=>String(item.id)===String(update.telegramChatId));if(!dialog)return send(res,404,{error:'That Telegram chat is no longer available.'});const messages=await client.getMessages(dialog,{ids:[update.telegramMessageId]});const message=messages[0];if(!message?.media)return send(res,404,{error:'The attachment is unavailable.'});const size=Number(message.file?.size||0);if(size>10*1024*1024)return send(res,413,{error:'This attachment is over the 10 MB preview limit. Open it in Telegram instead.'});const bytes=await client.downloadMedia(message,{});if(!bytes)return send(res,404,{error:'The attachment could not be downloaded.'});return sendFile(res,bytes,update.mediaMime,update.mediaName);}finally{await client.disconnect().catch(()=>{});}}catch(error){return send(res,400,{error:error.errorMessage||error.message||'Could not load Telegram attachment.'})}}
  if(method==='POST'&&url.pathname==='/api/reminders'){const {updateId,remindAt}=await body(req);const update=data.updates.find(x=>x.id===updateId);if(!update)return send(res,404,{error:'Update not found.'});if(!account.reminders.some(x=>x.updateId===updateId))account.reminders.push({id:randomUUID(),updateId,remindAt:remindAt||update.deadline,createdAt:new Date().toISOString()});await save(data);return send(res,201,{reminders:account.reminders});}
  // Manual calendar entries (class/society events or personal deadlines) that aren't tied to a
  // synced update — the "+ Add reminder" / "+ Add deadline" buttons on the calendar page.
  if(method==='POST'&&url.pathname==='/api/calendar/events'){const {title,date,time,kind}=await body(req);const cleanTitle=String(title||'').trim().slice(0,140);if(!cleanTitle)return send(res,400,{error:'Give this event a title.'});if(!/^\d{4}-\d{2}-\d{2}$/.test(String(date||'')))return send(res,400,{error:'Choose a valid date.'});const cleanTime=/^\d{2}:\d{2}$/.test(String(time||''))?time:'09:00';const at=new Date(`${date}T${cleanTime}:00`);if(Number.isNaN(at.getTime()))return send(res,400,{error:'Choose a valid date and time.'});account.customEvents=account.customEvents||[];account.customEvents.push({id:randomUUID(),title:cleanTitle,at:at.toISOString(),kind:kind==='deadline'?'deadline':'event',createdAt:new Date().toISOString()});await save(data);return send(res,201,{customEvents:account.customEvents});}
  if(method==='POST'&&url.pathname==='/api/calendar/events/remove'){const {id}=await body(req);account.customEvents=(account.customEvents||[]).filter(item=>item.id!==id);await save(data);return send(res,200,{customEvents:account.customEvents});}
  // Important: save a whole message or a single attachment (photo/video/document/link) into a
  // folder the student names themselves, or straight into "Direct saves" with no folder. A folder
  // is created inline the first time a student types a new name, then reused after that.
  if(method==='POST'&&url.pathname==='/api/important/folders'){const {name}=await body(req);const cleanName=String(name||'').trim().slice(0,80);if(!cleanName)return send(res,400,{error:'Give this folder a name.'});account.importantFolders=account.importantFolders||[];const folder={id:randomUUID(),name:cleanName,createdAt:new Date().toISOString()};account.importantFolders.push(folder);await save(data);return send(res,201,{importantFolders:account.importantFolders,folder});}
  if(method==='POST'&&url.pathname==='/api/important/save'){const {updateId,attachment,folderId,folderName,title,sourceLabel}=await body(req);const cleanTitle=String(title||'').trim().slice(0,160);if(!cleanTitle)return send(res,400,{error:'This item needs a title.'});account.importantFolders=account.importantFolders||[];account.importantItems=account.importantItems||[];let finalFolderId=folderId&&account.importantFolders.some(f=>f.id===folderId)?folderId:null;if(!finalFolderId&&folderName){const cleanFolder=String(folderName).trim().slice(0,80);if(cleanFolder){let folder=account.importantFolders.find(f=>f.name.toLowerCase()===cleanFolder.toLowerCase());if(!folder){folder={id:randomUUID(),name:cleanFolder,createdAt:new Date().toISOString()};account.importantFolders.push(folder)}finalFolderId=folder.id}}const cleanAttachment=attachment&&attachment.url?{url:String(attachment.url),name:String(attachment.name||'file').slice(0,160),mimeType:String(attachment.mimeType||'')}:null;const item={id:randomUUID(),title:cleanTitle,updateId:updateId||null,attachment:cleanAttachment,sourceLabel:String(sourceLabel||'').slice(0,40),folderId:finalFolderId,savedAt:new Date().toISOString()};account.importantItems.push(item);await save(data);return send(res,201,{importantItems:account.importantItems,importantFolders:account.importantFolders,item});}
  if(method==='POST'&&url.pathname==='/api/important/remove'){const {id}=await body(req);account.importantItems=(account.importantItems||[]).filter(item=>item.id!==id);await save(data);return send(res,200,{importantItems:account.importantItems});}
  if(method==='POST'&&url.pathname==='/api/important/folders/remove'){const {id}=await body(req);account.importantFolders=(account.importantFolders||[]).filter(f=>f.id!==id);account.importantItems=(account.importantItems||[]).map(item=>item.folderId===id?{...item,folderId:null}:item);await save(data);return send(res,200,{importantFolders:account.importantFolders,importantItems:account.importantItems});}
  // Lets a student add their OWN file straight into Important — a photo of handwritten/copy
  // notes taken with the camera (phone browser's file input opens the camera directly via the
  // `capture` attribute), or any file picked from a laptop. The client sends the raw bytes as
  // base64 (same pattern as the WhatsApp-with-media import above); this just stores them and
  // hands back a URL, then the normal /api/important/save call (with a folder or none) files it.
  if(method==='POST'&&url.pathname==='/api/important/upload'){try{
    const {data:fileData,name,mimeType}=await body(req);
    if(!fileData)return send(res,400,{error:'No file was received. Try again.'});
    const bytes=Buffer.from(String(fileData),'base64');
    if(!bytes.length)return send(res,400,{error:'That file looks empty. Try again.'});
    if(bytes.length>20*1024*1024)return send(res,400,{error:'That file is larger than 20 MB — choose a smaller photo or file.'});
    const safeName=String(name||'file').replace(/[^a-zA-Z0-9._ -]/g,'_').trim().slice(0,120)||'file';
    const fileId=`${randomUUID()}__${safeName}`;
    await mkdir(importantMediaDir,{recursive:true});
    await writeFile(join(importantMediaDir,fileId),bytes);
    return send(res,201,{url:`/api/important/media/${encodeURIComponent(fileId)}`,name:safeName,mimeType:String(mimeType||'')});
  }catch(error){return send(res,400,{error:error.message||'Could not upload that file.'})}}
  if(method==='GET'&&url.pathname.startsWith('/api/important/media/')){try{
    const fileId=decodeURIComponent(url.pathname.replace('/api/important/media/',''));
    if(!fileId||fileId.includes('..')||fileId.includes('/')||fileId.includes('\\'))return send(res,400,{error:'Invalid file.'});
    const bytes=await readFile(join(importantMediaDir,fileId));
    const name=fileId.split('__').slice(1).join('__')||'file';
    return sendFile(res,bytes,resolveMime(name),name);
  }catch(error){return send(res,404,{error:'This file is not available.'})}}
  if(method==='POST'&&url.pathname==='/api/telegram/request-code'){try{const {phone}=await body(req);if(!/^\+\d{8,15}$/.test(String(phone||'')))return send(res,400,{error:'Enter your phone number with country code, for example +919876543210.'});const client=telegramClient();await client.connect();const sent=await client.sendCode({apiId:Number(process.env.TELEGRAM_API_ID),apiHash:process.env.TELEGRAM_API_HASH},phone);const verificationId=randomUUID();telegramVerifications.set(verificationId,{client,phone,phoneCodeHash:sent.phoneCodeHash,userId:account.id,createdAt:Date.now()});account.connectors.telegram='verification pending';await save(data);return send(res,200,{verificationId,viaApp:Boolean(sent.isCodeViaApp),message:'Telegram sent a sign-in code. Enter it here; never share it with anyone else.'});}catch(error){return send(res,400,{error:error.errorMessage||error.message||'Telegram could not send a code.'})}}
  if(method==='POST'&&url.pathname==='/api/telegram/verify-code'){try{const {verificationId,code}=await body(req);const pending=telegramVerifications.get(verificationId);if(!pending||pending.userId!==account.id||Date.now()-pending.createdAt>600_000)return send(res,400,{error:'That verification expired. Request a new code.'});if(!/^\d{4,8}$/.test(String(code||'')))return send(res,400,{error:'Enter the code Telegram sent you.'});let signedIn;try{signedIn=await pending.client.invoke(new Api.auth.SignIn({phoneNumber:pending.phone,phoneCodeHash:pending.phoneCodeHash,phoneCode:String(code)}));}catch(error){if(error.errorMessage==='SESSION_PASSWORD_NEEDED')return send(res,409,{requiresPassword:true,error:'Your Telegram account has two-step verification. Enter that password to continue.'});throw error}const session=pending.client.session.save();telegramVerifications.delete(verificationId);account.oauth={...(account.oauth||{}),telegram:{session,chats:[]}};account.connectors.telegram='connected — choose chats';await save(data);const dialogs=await telegramDialogs(pending.client);await pending.client.disconnect().catch(()=>{});return send(res,200,{chats:dialogs.filter(item=>item.title).map(item=>({id:String(item.id),title:item.title,username:item.entity?.username||'',type:item.isChannel?'Channel':item.isGroup?'Group':'Chat'})).slice(0,100)});}catch(error){return send(res,400,{error:error.errorMessage||error.message||'Telegram verification failed.'})}}
  if(method==='POST'&&url.pathname==='/api/telegram/verify-password'){return send(res,501,{error:'Two-step verification is not available in this local build yet. Use a Telegram account without a cloud password, or complete this connection after deployment with encrypted session storage.'})}
  if(method==='POST'&&url.pathname==='/api/telegram/select-chats'){try{const {chats}=await body(req);if(!Array.isArray(chats)||!chats.length)return send(res,400,{error:'Choose at least one chat.'});if(!account.oauth?.telegram?.session)return send(res,400,{error:'Connect Telegram first.'});account.oauth.telegram.chats=chats.slice(0,30).map(chat=>({id:String(chat.id),title:String(chat.title||'Telegram chat').slice(0,120),username:String(chat.username||''),type:['Channel','Group','Chat'].includes(chat.type)?chat.type:'Chat'}));account.connectors.telegram=`${account.oauth.telegram.chats.length} selected chats`;await save(data);return send(res,200,{ok:true,selected:account.oauth.telegram.chats});}catch(error){return send(res,400,{error:error.message||'Could not save selected chats.'})}}
  if(method==='POST'&&url.pathname==='/api/telegram/remove-chat'){try{const {chatId}=await body(req);if(!chatId)return send(res,400,{error:'Chat not specified.'});if(!account.oauth?.telegram?.session)return send(res,400,{error:'Telegram is not connected.'});account.oauth.telegram.chats=(account.oauth.telegram.chats||[]).filter(chat=>chat.id!==String(chatId));const removedIds=new Set(data.updates.filter(update=>update.source==='telegram'&&String(update.telegramChatId)===String(chatId)).map(update=>update.id));data.updates=data.updates.filter(update=>!removedIds.has(update.id));account.reminders=(account.reminders||[]).filter(reminder=>!removedIds.has(reminder.updateId));account.connectors.telegram=account.oauth.telegram.chats.length?`${account.oauth.telegram.chats.length} selected chats`:'connected — no chats selected';await save(data);return send(res,200,{selected:account.oauth.telegram.chats,removed:removedIds.size});}catch(error){return send(res,400,{error:error.message||'Could not remove that chat.'})}}
  if(method==='POST'&&url.pathname==='/api/integrations/config'){const config=await body(req);account.integrationConfig={...(account.integrationConfig||{}),collegeFeedUrl:config.collegeFeedUrl?.trim()||account.integrationConfig?.collegeFeedUrl};data.appConfig={...(data.appConfig||{}),googleClientId:config.googleClientId?.trim()||data.appConfig?.googleClientId,googleClientSecret:config.googleClientSecret?.trim()||data.appConfig?.googleClientSecret};await save(data);return send(res,200,{ok:true,message:'College connection saved.'})}
  if(method==='GET'&&url.pathname==='/api/connectors')return send(res,200,{connectors:account.connectors,providers:{whatsapp:{status:'requires Meta WhatsApp Business approval; group-message reading is not generally available through the consumer app API'},email:{status:googleReady(data)?'Ready for OAuth':'Google OAuth credentials required'},telegram:{status:telegramReady()?'Ready for phone verification':'Telegram API ID and hash required on the server'},portal:{status:account.integrationConfig?.collegeFeedUrl||process.env.COLLEGE_PORTAL_FEED_URL?'Feed ready':'Official feed URL required'},classroom:{status:googleReady(data)?'Ready for OAuth (same Google client, Classroom API must be enabled)':'Google OAuth credentials required'}}});
  if(method==='POST'&&url.pathname.startsWith('/api/connectors/')){const type=url.pathname.split('/').pop();if(!['whatsapp','email','telegram','portal'].includes(type))return send(res,404,{error:'Unknown connector.'});account.connectors[type]=type==='whatsapp'?'admin forwarding required':'pending setup';await save(data);return send(res,202,{connector:type,status:account.connectors[type],message:`${type} connection is ready for provider setup.`});}
  if(method==='POST'&&url.pathname==='/api/sync/gmail'){try{return send(res,200,await syncGmail(data,account))}catch(error){return send(res,400,{error:error.message})}}
  if(method==='POST'&&url.pathname==='/api/sync/classroom'){try{const result=await syncClassroom(data,account);await save(data);return send(res,200,result)}catch(error){return send(res,400,{error:error.message})}}
  if(method==='GET'&&url.pathname==='/api/classroom/available'){try{const courses=await listClassroomCourses(account,data);return send(res,200,{courses})}catch(error){return send(res,400,{error:error.message})}}
  if(method==='POST'&&url.pathname==='/api/classroom/select'){try{
    const {courses}=await body(req);
    if(!Array.isArray(courses)||!courses.length)return send(res,400,{error:'Choose at least one class.'});
    if(!account.oauth?.classroom)return send(res,400,{error:'Connect Google Classroom first.'});
    account.oauth.classroom.courses=courses.slice(0,50).map(c=>({id:String(c.id),name:String(c.name||'Classroom course').slice(0,140)}));
    account.connectors.classroom=`${account.oauth.classroom.courses.length} class${account.oauth.classroom.courses.length===1?'':'es'} selected`;
    await save(data);
    return send(res,200,{selected:account.oauth.classroom.courses});
  }catch(error){return send(res,400,{error:error.message||'Could not save your selected classes.'})}}
  if(method==='POST'&&url.pathname==='/api/classroom/remove'){try{
    const {courseId}=await body(req);
    if(!courseId)return send(res,400,{error:'Class not specified.'});
    if(!account.oauth?.classroom)return send(res,400,{error:'Classroom is not connected.'});
    const removedCourse=(account.oauth.classroom.courses||[]).find(c=>c.id===String(courseId));
    account.oauth.classroom.courses=(account.oauth.classroom.courses||[]).filter(c=>c.id!==String(courseId));
    const removedIds=new Set(data.updates.filter(u=>u.source==='classroom'&&removedCourse&&u.space===removedCourse.name).map(u=>u.id));
    data.updates=data.updates.filter(u=>!removedIds.has(u.id));
    account.reminders=(account.reminders||[]).filter(r=>!removedIds.has(r.updateId));
    account.connectors.classroom=account.oauth.classroom.courses.length?`${account.oauth.classroom.courses.length} class${account.oauth.classroom.courses.length===1?'':'es'} selected`:'connected — no classes selected';
    await save(data);
    return send(res,200,{selected:account.oauth.classroom.courses,removed:removedIds.size});
  }catch(error){return send(res,400,{error:error.message||'Could not remove that class.'})}}
  if(method==='POST'&&url.pathname==='/api/sync/telegram'){try{const result=await syncTelegram(data,account);account.connectors.telegram='connected';await save(data);return send(res,200,result)}catch(error){return send(res,400,{error:error.message})}}
  if(method==='POST'&&url.pathname==='/api/sync/college-feed'){try{const result=await syncCollegeFeed(data,account);account.connectors.portal='connected';await save(data);return send(res,200,result)}catch(error){return send(res,400,{error:error.message})}}
  // Manual WhatsApp import: the student exports a chat/group with WhatsApp's own "Export chat"
  // feature and uploads the resulting text here, since there is no automated way to read WhatsApp
  // messages. Parsed lines are stored as regular updates so they show up alongside other sources.
  if(method==='POST'&&url.pathname==='/api/sync/whatsapp-import'){try{
    const {text,chatName,media}=await body(req);
    if(!text||typeof text!=='string'||!text.trim())return send(res,400,{error:'Paste or upload your exported WhatsApp chat text first.'});
    const parsed=parseWhatsAppExport(text).slice(0,3000);
    if(!parsed.length)return send(res,400,{error:'No messages were recognised in that file. Make sure it is the plain-text WhatsApp chat export (Chat → More → Export chat).'});
    const space=String(chatName||'WhatsApp group').trim().slice(0,80)||'WhatsApp group';
    let added=0;
    // media: { "IMG-20260101-WA0001.jpg": { mimeType, data: base64 } } — sent by app.js when the
    // student uploads the .zip from "Export chat" WITH media, so real files (not just "omitted"
    // labels) are available to preview.
    const mediaMap=media&&typeof media==='object'?media:{};
    if(Object.keys(mediaMap).length)await mkdir(whatsappMediaDir,{recursive:true});
    for(const msg of parsed){
      const iso=whatsappIso(msg.dateStr,msg.timeStr);if(!iso||!msg.body)continue;
      const externalId=`whatsapp:${space}:${hash(`${iso}|${msg.sender}|${msg.body}`).slice(0,24)}`;
      if(data.updates.some(u=>u.externalId===externalId))continue;
      const entry={id:randomUUID(),source:'whatsapp',sender:msg.sender||'WhatsApp',space,title:msg.body.split('\n')[0].slice(0,90)||'WhatsApp message',body:msg.body,waType:classifyWhatsApp(msg.body),deadline:extractDeadline(msg.body),priority:0,receivedAt:iso,externalId};
      const mediaFile=msg.fileName&&mediaMap[msg.fileName];
      if(mediaFile?.data){
        try{
          const bytes=Buffer.from(String(mediaFile.data),'base64');
          if(bytes.length<=25*1024*1024){
            await writeFile(join(whatsappMediaDir,entry.id),bytes);
            entry.hasMedia=true;entry.mediaName=msg.fileName;entry.mediaMime=mediaFile.mimeType||'';
          }
        }catch{/* skip an unreadable attachment, keep the text message */}
      }
      entry.priority=updatePriority(entry);data.updates.push(entry);added++;
    }
    await save(data);
    account.connectors.whatsapp=`${data.updates.filter(u=>u.source==='whatsapp').length} messages imported`;
    await save(data);
    return send(res,200,{added});
  }catch(error){return send(res,400,{error:error.message||'Could not import that chat export.'})}}
  if(method==='GET'&&url.pathname.startsWith('/api/whatsapp/media/')){
    try{
      const update=data.updates.find(item=>item.id===url.pathname.split('/').pop()&&item.source==='whatsapp');
      if(!update?.hasMedia)return send(res,404,{error:'This attachment is not available. Re-import this chat as a .zip exported WITH media.'});
      const bytes=await readFile(join(whatsappMediaDir,update.id));
      return sendFile(res,bytes,update.mediaMime,update.mediaName);
    }catch(error){return send(res,404,{error:'This attachment is not available. Re-import this chat as a .zip exported WITH media.'})}
  }
  // Lets a student stop tracking a WhatsApp group they imported earlier (mirrors the Telegram
  // "stop reading this chat" control) — removes its messages and any reminders pointing at them.
  if(method==='POST'&&url.pathname==='/api/sync/whatsapp-remove'){try{const {space}=await body(req);if(!space)return send(res,400,{error:'Chat not specified.'});const removedIds=new Set(data.updates.filter(update=>update.source==='whatsapp'&&update.space===space).map(update=>update.id));data.updates=data.updates.filter(update=>!removedIds.has(update.id));account.reminders=(account.reminders||[]).filter(reminder=>!removedIds.has(reminder.updateId));const remaining=data.updates.filter(u=>u.source==='whatsapp').length;account.connectors.whatsapp=remaining?`${remaining} messages imported`:'not connected';await save(data);return send(res,200,{removed:removedIds.size})}catch(error){return send(res,400,{error:error.message||'Could not remove that chat.'})}}
  if(method==='POST'&&url.pathname==='/api/ai/brief'){
    const updates=priority(data.updates);
    if(!updates.length)return send(res,200,{summary:'No updates have been synced yet — connect a source or import a chat first.',priorities:[]});
    try{
      const summary=await askGemini(`You are Orbit AI, a concise campus-updates assistant for an Indian college student named ${account.name.split(' ')[0]}. Write a short (2-4 sentence) spoken-style daily briefing from the update list given. You may address them by name once. Mention the single most urgent item by name and its deadline first, then anything else genuinely time-sensitive. No headers, no bullet points, plain prose only — do not use markdown formatting or asterisks of any kind (no **bold**, no * bullets, no # headers), plain sentences only.`,`Here are the student's current updates, most important first:\n${updatesContext(data.updates)}`);
      return send(res,200,{summary,priorities:updates.slice(0,3)});
    }catch(error){
      return send(res,200,{summary:`Your most urgent update is ${updates[0].title}${updates[0].deadline?`, due ${new Date(updates[0].deadline).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'})}`:''}. (AI briefing is unavailable: ${error.message})`,priorities:updates.slice(0,3)});
    }
  }
  if(method==='POST'&&url.pathname==='/api/ai/ask'){
    const {question}=await body(req);const cleanQuestion=String(question||'').trim().slice(0,600);
    if(!cleanQuestion)return send(res,400,{error:'Ask a question first.'});
    const intent=cleanQuestion.toLowerCase();
    // These two are answered directly from the student's own data — fast, free, never queues
    // behind Gemini or fails on a busy day, unlike a normal free-text question would.
    if(/\bclassify\b|\bcategori[sz]e\b/.test(intent))return send(res,200,{answer:classifyBreakdown(data.updates)});
    if(/\bprioriti[sz]e\b|\bpriority\b|\bprioriti[sz]ation\b/.test(intent))return send(res,200,{answer:prioritizeList(data.updates)});
    try{
      if(/\bsummar/.test(intent)){
        const summary=await askGemini(`You are Orbit AI, a concise campus-updates assistant for an Indian college student named ${account.name.split(' ')[0]}. Write a short (2-4 sentence) summary of their current updates from the list given — group naturally by what matters (deadlines first), plain prose, no headers or bullet points — do not use markdown formatting or asterisks of any kind (no **bold**, no * bullets, no # headers), plain sentences only.`,`Here are the student's current updates, most important first:\n${updatesContext(data.updates)}`);
        return send(res,200,{answer:summary});
      }
      const matched=matchedUpdatesContext(data.updates,cleanQuestion);
      const matchedBlock=matched?`\n\nThese are the FULL messages that specifically match names/chats mentioned in the question — prefer these, and quote/describe them directly, when the question is asking for a particular message from a particular person or chat:\n${matched}`:'';
      const answer=await askGemini(`You are Orbit AI, a helpful assistant for an Indian college student named ${account.name.split(' ')[0]} inside the Orbit app. If you address them by name, use their real name given here — never invent or assume a different name. Answer the student's question directly and specifically using ONLY the update list given as context — cite real titles/senders/deadlines from it. If the student is asking for a specific message from a specific person or chat, look in the "FULL messages" block first and return that message's actual content. If the answer truly is not in the updates, say so plainly and suggest which source to sync, instead of inventing details. Keep answers short and conversational — do not use markdown formatting or asterisks of any kind (no **bold**, no * bullets, no # headers), plain sentences only.`,`Student's synced updates (priority order, summarised):\n${updatesContext(data.updates)}${matchedBlock}\n\nStudent's question: ${cleanQuestion}`);
      return send(res,200,{answer});
    }catch(error){return send(res,400,{error:error.message||'The AI could not answer that right now.'})}
  }
  if(method==='GET'&&url.pathname==='/api/push/vapid-public-key')return send(res,200,{key:pushReady()?process.env.VAPID_PUBLIC_KEY:null});
  if(method==='POST'&&url.pathname==='/api/push/subscribe'){if(!pushReady())return send(res,400,{error:'Push notifications are not configured on the server yet.'});const subscription=await body(req);if(!subscription?.endpoint)return send(res,400,{error:'Invalid subscription.'});account.pushSubscriptions=(account.pushSubscriptions||[]).filter(s=>s.endpoint!==subscription.endpoint);account.pushSubscriptions.push(subscription);await save(data);return send(res,200,{ok:true});}
  if(method==='POST'&&url.pathname==='/api/push/unsubscribe'){const {endpoint}=await body(req);account.pushSubscriptions=(account.pushSubscriptions||[]).filter(s=>s.endpoint!==endpoint);await save(data);return send(res,200,{ok:true});}
  // Called from the client every couple of minutes while the app is open (see app.js). Works
  // even when the server can't run background timers (e.g. Vercel/serverless) because it's a
  // normal request. Returns anything within the alert window so the client can show an in-app
  // toast and/or a local Notification, in addition to any real push sent via web-push.
  if(method==='GET'&&url.pathname==='/api/reminders/check-now'){
    const dueSoon=dueSoonForAccount(data,account);
    if(dueSoon.length)await save(data);
    return send(res,200,{dueSoon});
  }
  return send(res,404,{error:'API route not found.'});
}
// Runs every few minutes and pushes a real OS/browser notification (via the Push API) for any
// reminder or deadline that is now within the alert window and hasn't been notified yet — this is
// what makes "deadline paas hai" alerts show up even if the Orbit tab isn't open.
const REMINDER_ALERT_WINDOW_MS=60*60*1000; // notify once an item is within 1 hour of its time
async function sendPushToAccount(account,payload){
  if(!pushReady()||!account.pushSubscriptions?.length)return;
  const body=JSON.stringify(payload);
  const results=await Promise.allSettled(account.pushSubscriptions.map(sub=>webpush.sendNotification(sub,body)));
  const stillValid=account.pushSubscriptions.filter((sub,i)=>!(results[i].status==='rejected'&&[404,410].includes(results[i].reason?.statusCode)));
  if(stillValid.length!==account.pushSubscriptions.length)account.pushSubscriptions=stillValid;
}
// Shared by the background sweep below AND by /api/reminders/check-now. The background
// setInterval sweep only works on a host that keeps one Node process running (your own server,
// a VM, Railway, Render, etc). Vercel (and other serverless hosts) spin your server up per
// request and never let a timer run in the background, so setInterval below silently never
// fires there — this is the #1 reason reminders "don't work" after deploying to Vercel. The
// check-now endpoint is the fix: the app calls it every couple of minutes while a tab is open,
// which works everywhere (serverless included) because it rides on a real request.
function dueSoonForAccount(data,account){
  const dueSoon=[];
  for(const reminder of account.reminders||[]){
    if(reminder.notifiedAt)continue;
    const update=data.updates.find(u=>u.id===reminder.updateId);const when=new Date(reminder.remindAt||update?.deadline||0).getTime();
    if(!when||Number.isNaN(when)||when>Date.now()+REMINDER_ALERT_WINDOW_MS||when<Date.now()-REMINDER_ALERT_WINDOW_MS)continue;
    dueSoon.push({title:update?.title||'Reminder',body:`Due ${new Date(when).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'})} — ${update?.sender||''}`});
    reminder.notifiedAt=new Date().toISOString();
  }
  for(const event of account.customEvents||[]){
    if(event.notifiedAt)continue;const when=new Date(event.at).getTime();
    if(!when||Number.isNaN(when)||when>Date.now()+REMINDER_ALERT_WINDOW_MS||when<Date.now()-REMINDER_ALERT_WINDOW_MS)continue;
    dueSoon.push({title:event.title,body:event.kind==='deadline'?'Deadline is coming up':'Coming up soon'});
    event.notifiedAt=new Date().toISOString();
  }
  return dueSoon;
}
// Emails a student once, roughly 24 hours before a reminder's deadline. Runs on the same 5-minute
// sweep as the push check above, and separately marks `emailedAt` on the reminder so it's only
// ever sent once, independent of whether push notifications are configured on this server.
const EMAIL_LEAD_MS=24*60*60*1000; // send ~1 day before the deadline
const EMAIL_SWEEP_TOLERANCE_MS=6*60*1000; // half the 5-minute sweep interval, plus a little slack
function emailDueForAccount(data,account){
  const due=[];
  for(const reminder of account.reminders||[]){
    if(reminder.emailedAt)continue;
    const update=data.updates.find(u=>u.id===reminder.updateId);
    if(!update?.deadline)continue;
    const emailAt=new Date(update.deadline).getTime()-EMAIL_LEAD_MS;
    if(!emailAt||Number.isNaN(emailAt))continue;
    if(Date.now()>=emailAt-EMAIL_SWEEP_TOLERANCE_MS&&Date.now()<=emailAt+EMAIL_SWEEP_TOLERANCE_MS){
      due.push({type:'reminder',reminder,update});
      reminder.emailedAt=new Date().toISOString();
    }
  }
  // Anything the student added straight to the calendar — a deadline or a plain reminder — gets
  // the same day-before email, independent of whether it's linked to a synced update.
  for(const event of account.customEvents||[]){
    if(event.emailedAt)continue;
    const emailAt=new Date(event.at).getTime()-EMAIL_LEAD_MS;
    if(!emailAt||Number.isNaN(emailAt))continue;
    if(Date.now()>=emailAt-EMAIL_SWEEP_TOLERANCE_MS&&Date.now()<=emailAt+EMAIL_SWEEP_TOLERANCE_MS){
      due.push({type:'event',event});
      event.emailedAt=new Date().toISOString();
    }
  }
  return due;
}
async function checkReminders(){
  try{
    const data=await db();let changed=false;
    for(const account of data.users){
      if(pushReady()){
        const dueSoon=dueSoonForAccount(data,account);
        if(dueSoon.length)changed=true;
        for(const item of dueSoon)await sendPushToAccount(account,{title:`⏰ ${item.title}`,body:item.body,url:'/'});
      }
      if(mailReady()){
        const emailDue=emailDueForAccount(data,account);
        if(emailDue.length)changed=true;
        for(const item of emailDue){
          if(item.type==='event')await sendCalendarEventEmail(account,item.event);
          else await sendReminderEmail(account,item.update);
        }
      }
    }
    if(changed)await save(data);
  }catch(error){console.error('Reminder check failed:',error.message)}
}
setInterval(checkReminders,5*60*1000);
checkReminders();
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,`http://${req.headers.host}`);if(url.pathname.startsWith('/api/'))return api(req,res,url);let target=url.pathname==='/'?'index.html':normalize(url.pathname).replace(/^([\\/])+/, '');if(target.includes('..')){res.writeHead(403);return res.end('Forbidden');}const file=join(root,target);const content=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(content);}catch(error){if(error.code==='ENOENT'){res.writeHead(404);res.end('Not found')}else{console.error(error);send(res,500,{error:'Server error'})}}});
server.listen(process.env.PORT||3000,()=>console.log('Orbit running at http://localhost:'+(process.env.PORT||3000)));