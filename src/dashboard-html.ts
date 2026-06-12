// Self-contained dashboard page: inline CSS + inline JS, zero external assets
// (no CDN, no fonts, no build-time file read — safe inside the SEA binary).
// The embedded <script> deliberately avoids template literals and ${} so this
// outer template literal needs no escaping.

const SCRIPT = String.raw`
const TOK = { input:'#4493f8', output:'#3fb950', cacheCreation:'#d29922', cacheRead:'#8957e5' };
const PALETTE = ['#4493f8','#3fb950','#d29922','#8957e5','#f04438','#2dd4bf','#e879a6','#a3a3a3'];
function colorFor(name, i){ return PALETTE[i % PALETTE.length]; }
function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function fmtN(n){ if(n==null) return '0'; if(n>=1e9) return (n/1e9).toFixed(1)+'B'; if(n>=1e6) return (n/1e6).toFixed(1)+'M'; if(n>=1e3) return (n/1e3).toFixed(1)+'K'; return ''+Math.round(n); }
function fmtUsd(n){ return '$'+(n||0).toFixed(2); }
function fmtTime(ms){ if(ms==null) return '?'; var d=new Date(ms); return d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}); }
function fmtHM(ms){ var d=new Date(ms); return d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}); }
function el(id){ return document.getElementById(id); }
function empty(msg){ return '<div class="empty">'+msg+'</div>'; }
function gband(p){ return p>=85?'#f04438':p>=60?'#d29922':'#3fb950'; }

function gauge(w){
  var cx=80, cy=84, r=64, C=80;
  var pct = w.pct==null?0:w.pct;
  var pred = w.forecast? Math.min(100, w.forecast.predictedPctAtReset) : pct;
  var arc = 'M '+(cx-r)+' '+cy+' A '+r+' '+r+' 0 0 1 '+(cx+r)+' '+cy;
  var s = '<svg viewBox="0 0 160 100" class="gauge">';
  s += '<path d="'+arc+'" pathLength="100" class="g-track"/>';
  s += '<path d="'+arc+'" pathLength="100" stroke="'+gband(pct)+'" class="g-pred" stroke-dasharray="'+pred+' 100"/>';
  s += '<path d="'+arc+'" pathLength="100" stroke="'+gband(pct)+'" class="g-val" stroke-dasharray="'+pct+' 100"/>';
  s += '<text x="80" y="74" class="g-pct">'+(w.pct==null?'?':pct+'%')+'</text>';
  s += '</svg>';
  var sub;
  if(w.exhaustionEpochMs!=null) sub='<span class="warn">100% by '+fmtHM(w.exhaustionEpochMs)+'</span> · resets '+fmtTime(w.resetEpochMs);
  else sub='resets '+fmtTime(w.resetEpochMs);
  return '<div class="gcard"><div class="glabel">'+w.label+'</div>'+s+'<div class="gsub">'+sub+'</div></div>';
}

function renderOverview(ov){
  el('updated').textContent = ov.ageMin==null? 'no data' : ('updated '+ov.ageMin+'m ago');
  el('scope').textContent = ov.scopeNote || '';
  el('gauges').innerHTML = (ov.windows&&ov.windows.length)? ov.windows.map(gauge).join('') : empty('윈도우 데이터 없음 — poller를 먼저 실행하세요');
  el('kpi').innerHTML =
    kpi('7일 토큰 (전체)', fmtN(ov.kpi.tokens7d)) +
    kpi('7일 active 토큰', fmtN(ov.kpi.activeTokens7d)) +
    kpi('7일 오케스트레이터 비용', fmtUsd(ov.kpi.cost7d)) +
    kpi('7일 태스크 실행', ''+ov.kpi.runs7d);
  el('ingestfresh').textContent = ov.kpi.ingestMaxTsMs
    ? '사용량 데이터 기준 ' + fmtTime(ov.kpi.ingestMaxTsMs)
    : '';
}
function kpi(label,val){ return '<div class="kcard"><div class="klabel">'+label+'</div><div class="kval">'+val+'</div></div>'; }

function renderModels(md){
  var totals = md.totals||[];
  if(!totals.length){ el('models').innerHTML = empty('아직 사용량 데이터가 없습니다 (quota ingest 또는 poll 후 채워집니다)'); el('tokcat').innerHTML=''; return; }
  // Bar length by ACTIVE tokens (input+output+cache-create); cache_read is huge
  // and would otherwise flatten every bar to the same length.
  var maxActive = Math.max.apply(null, totals.map(function(t){return t.activeTokens;}).concat([1]));
  var rows = totals.map(function(t,i){
    var w = Math.max(2, (t.activeTokens/maxActive)*100);
    var m = esc(t.model);
    return '<div class="mrow"><div class="mlabel" title="'+m+'">'+m+'</div>'+
      '<div class="mbarwrap"><div class="mbar" style="width:'+w+'%;background:'+colorFor(t.model,i)+'"></div></div>'+
      '<div class="mval">'+fmtN(t.activeTokens)+' active · '+fmtN(t.totalTokens)+' total · '+t.events+' msg</div></div>';
  }).join('');
  el('models').innerHTML = rows;

  var c = md.categories, tot = c.input+c.output+c.cacheCreation+c.cacheRead;
  if(tot<=0){ el('tokcat').innerHTML = empty('토큰 데이터 없음'); return; }
  var segs = [['input',c.input],['output',c.output],['cacheCreation',c.cacheCreation],['cacheRead',c.cacheRead]];
  var bar = '<div class="stack">'+segs.map(function(s){
    var pc=(s[1]/tot)*100; if(pc<=0) return '';
    return '<div class="seg" style="width:'+pc+'%;background:'+TOK[s[0]]+'" title="'+s[0]+': '+fmtN(s[1])+'"></div>';
  }).join('')+'</div>';
  var leg = '<div class="legend">'+segs.map(function(s){
    return '<span class="lg"><i style="background:'+TOK[s[0]]+'"></i>'+s[0]+' '+fmtN(s[1])+'</span>';
  }).join('')+'</div>';
  el('tokcat').innerHTML = bar+leg;
}

function renderContrib(ct){
  var days = ct.days||[];
  if(!days.length){ el('contrib').innerHTML = empty('활동 없음'); return; }
  var vals = days.map(function(d){return d.value;}).filter(function(v){return v>0;}).sort(function(a,b){return a-b;});
  var shades=['#21262d','#0e4429','#006d32','#26a641','#39d353'];
  function bucket(v){ if(v<=0) return 0; if(!vals.length) return 1; var q=[0.2,0.4,0.6,0.8].map(function(p){return vals[Math.floor(p*vals.length)];}); var b=1; for(var i=0;i<q.length;i++) if(v>q[i]) b=i+2; return Math.min(shades.length-1, b); }
  // align grid to week columns: pad leading days of the first week
  var first=new Date(days[0].day); var pad=first.getDay();
  var cells=''; var cell=13, gap=3;
  for(var p=0;p<pad;p++){} // leading offset handled by column math below
  var cols=Math.ceil((days.length+pad)/7);
  var svgW=cols*(cell+gap), svgH=7*(cell+gap)+16;
  var s='<svg viewBox="0 0 '+svgW+' '+svgH+'" class="heat">';
  for(var i=0;i<days.length;i++){
    var idx=i+pad, col=Math.floor(idx/7), row=idx%7;
    var d=days[i], b=bucket(d.value);
    var x=col*(cell+gap), y=row*(cell+gap)+14;
    var dd=new Date(d.day);
    s+='<rect x="'+x+'" y="'+y+'" width="'+cell+'" height="'+cell+'" rx="2" fill="'+shades[b]+'"><title>'+dd.toLocaleDateString()+' · '+fmtN(d.value)+' '+ct.metric+' · '+d.runs+' run</title></rect>';
  }
  s+='</svg>';
  el('contrib').innerHTML = s;
}

function renderTimeseries(ts){
  var keys=[['session_5h','Session 5h'],['weekly_all','Week all'],['weekly_sonnet','Week Sonnet']];
  var out=keys.map(function(k){
    var pts=ts[k[0]]||[];
    if(pts.length<2) return '<div class="tslane"><div class="tslabel">'+k[1]+'</div>'+empty('표본 부족')+'</div>';
    var t0=pts[0].ts, t1=pts[pts.length-1].ts, span=Math.max(1,t1-t0);
    var W=300,H=60;
    var poly=pts.map(function(p){ var x=((p.ts-t0)/span)*W; var y=H-(Math.min(100,p.pct)/100)*H; return x.toFixed(1)+','+y.toFixed(1); }).join(' ');
    var s='<svg viewBox="0 0 '+W+' '+H+'" class="tsvg" preserveAspectRatio="none">';
    s+='<line x1="0" y1="'+H+'" x2="'+W+'" y2="'+H+'" class="axis"/>';
    s+='<polyline points="'+poly+'" class="tline"/></svg>';
    return '<div class="tslane"><div class="tslabel">'+k[1]+' <span class="muted">'+pts[pts.length-1].pct+'%</span></div>'+s+'</div>';
  }).join('');
  el('timeseries').innerHTML = out;
}

function renderEstimates(es){
  var sum=es.summary||[];
  if(!sum.length){ el('estimates').innerHTML = empty('추정 정확도 데이터 없음 (태스크 실행 누적 후 표시)'); return; }
  var rows=sum.map(function(s){
    var ratio=s.medianRatio; var over=ratio>1;
    var w=Math.min(100, Math.abs(Math.log10(ratio||1))*60+4);
    return '<div class="erow"><div class="elabel">'+s.size+'</div>'+
      '<div class="ebarwrap"><div class="ebar" style="width:'+w+'%;background:'+(over?'#f04438':'#3fb950')+'"></div></div>'+
      '<div class="eval">'+ratio.toFixed(2)+'x '+(over?'과소추정':'과대추정')+' (n='+s.n+')</div></div>';
  }).join('');
  el('estimates').innerHTML = '<div class="ehint">실측/추정 비율 (1.0 = 정확)</div>'+rows;
}

function renderQueue(q){
  var order=[['queued','대기'],['running','실행중'],['done','완료'],['carried_over','이월'],['failed','실패']];
  el('queue').innerHTML = order.map(function(o){
    return '<div class="qchip"><span class="qn">'+(q[o[0]]||0)+'</span><span class="ql">'+o[1]+'</span></div>';
  }).join('');
}

function load(){
  Promise.all([
    fetch('/api/overview').then(function(r){return r.json();}),
    fetch('/api/models').then(function(r){return r.json();}),
    fetch('/api/contrib').then(function(r){return r.json();}),
    fetch('/api/timeseries').then(function(r){return r.json();}),
    fetch('/api/estimates').then(function(r){return r.json();}),
    fetch('/api/queue').then(function(r){return r.json();})
  ]).then(function(a){
    try{ renderOverview(a[0]); }catch(e){ el('gauges').innerHTML=empty('overview 오류: '+e); }
    try{ renderModels(a[1]); }catch(e){ el('models').innerHTML=empty('models 오류: '+e); }
    try{ renderContrib(a[2]); }catch(e){ el('contrib').innerHTML=empty('contrib 오류: '+e); }
    try{ renderTimeseries(a[3]); }catch(e){ el('timeseries').innerHTML=empty('timeseries 오류: '+e); }
    try{ renderEstimates(a[4]); }catch(e){ el('estimates').innerHTML=empty('estimates 오류: '+e); }
    try{ renderQueue(a[5]); }catch(e){ el('queue').innerHTML=empty('queue 오류'); }
  }).catch(function(e){ el('gauges').innerHTML=empty('로드 실패: '+e); });
}
load();
setInterval(load, 60000);
el('refresh').addEventListener('click', load);
`;

const STYLE = String.raw`
:root{--bg:#0f1115;--card:#171a21;--line:#262b34;--fg:#e6e8eb;--muted:#8a909a;}
*{box-sizing:border-box;}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
header{display:flex;align-items:baseline;gap:14px;padding:18px 24px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:2;}
header h1{font-size:17px;margin:0;font-weight:600;}
header .muted,#scope{color:var(--muted);font-size:12px;}
#refresh{margin-left:auto;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:5px 12px;cursor:pointer;font-size:12px;}
#refresh:hover{border-color:#3a4250;}
main{max-width:1180px;margin:0 auto;padding:22px 24px;display:flex;flex-direction:column;gap:22px;}
.row{display:grid;gap:18px;}
.row.two{grid-template-columns:1fr 1fr;}
@media(max-width:820px){.row.two{grid-template-columns:1fr;}}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;}
.card h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 14px;font-weight:600;}
.empty{color:var(--muted);font-size:13px;padding:18px 4px;text-align:center;}
#gauges{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;}
.gcard{text-align:center;}
.glabel{font-size:12px;color:var(--muted);margin-bottom:2px;}
.gauge{width:100%;max-width:170px;}
.g-track{fill:none;stroke:#262b34;stroke-width:11;stroke-linecap:round;}
.g-pred{fill:none;stroke-width:11;stroke-linecap:round;opacity:.28;}
.g-val{fill:none;stroke-width:11;stroke-linecap:round;}
.g-pct{fill:var(--fg);font-size:26px;font-weight:600;text-anchor:middle;}
.gsub{font-size:11px;color:var(--muted);margin-top:-6px;}
.warn{color:#f5a524;}
#kpi{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:6px;}
@media(max-width:720px){#kpi{grid-template-columns:repeat(2,1fr);}}
.kcard{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;}
.klabel{font-size:11px;color:var(--muted);}
.kval{font-size:20px;font-weight:600;}
.mrow,.erow{display:grid;grid-template-columns:120px 1fr auto;gap:10px;align-items:center;margin-bottom:8px;}
.mlabel,.elabel{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,monospace;}
.mbarwrap,.ebarwrap{background:var(--bg);border-radius:5px;height:18px;overflow:hidden;}
.mbar,.ebar{height:100%;border-radius:5px;}
.mval,.eval{font-size:11px;color:var(--muted);font-family:ui-monospace,Menlo,monospace;white-space:nowrap;}
.stack{display:flex;height:26px;border-radius:6px;overflow:hidden;background:var(--bg);}
.seg{height:100%;}
.legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:10px;}
.lg{font-size:11px;color:var(--muted);display:flex;align-items:center;gap:5px;}
.lg i{width:10px;height:10px;border-radius:2px;display:inline-block;}
.heat{width:100%;}
.tslane{margin-bottom:12px;}
.tslabel{font-size:12px;color:var(--muted);margin-bottom:3px;}
.tsvg{width:100%;height:54px;}
.tline{fill:none;stroke:#4493f8;stroke-width:1.5;}
.axis{stroke:var(--line);stroke-width:1;}
.muted{color:var(--muted);}
.ehint{font-size:11px;color:var(--muted);margin-bottom:10px;}
#queue{display:flex;gap:10px;flex-wrap:wrap;}
.qchip{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 14px;text-align:center;}
.qn{display:block;font-size:20px;font-weight:600;}
.ql{font-size:11px;color:var(--muted);}
`;

export const DASHBOARD_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Claude Quota</title>
<style>${STYLE}</style></head>
<body>
<header>
  <h1>Claude Quota</h1>
  <span id="updated" class="muted">loading…</span>
  <span id="scope"></span>
  <button id="refresh">새로고침</button>
</header>
<main>
  <section class="card"><div id="gauges"></div><div id="kpi"></div><div id="ingestfresh" class="muted" style="font-size:11px;margin-top:8px"></div></section>
  <div class="row two">
    <section class="card"><h2>모델별 사용량 (전체 Claude Code)</h2><div id="models"></div><div id="tokcat" style="margin-top:14px"></div></section>
    <section class="card"><h2>활동 (일별 전체 토큰)</h2><div id="contrib"></div></section>
  </div>
  <div class="row two">
    <section class="card"><h2>윈도우 사용률 추이</h2><div id="timeseries"></div></section>
    <section class="card"><h2>추정 정확도</h2><div id="estimates"></div></section>
  </div>
  <section class="card"><h2>태스크 큐</h2><div id="queue"></div></section>
</main>
<script>${SCRIPT}</script>
</body></html>`;
