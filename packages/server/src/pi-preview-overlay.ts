/**
 * Preview Overlay — static assets injected into proxied HTML pages.
 *
 * Served at:
 *   /__preview/overlay.js  — Element picker, console capture, postMessage bridge
 *   /__preview/overlay.css — Visuals for the overlay
 */

const OVERLAY_CSS = `
/* ── Highlight ── */
.pi-preview-highlight{
  position:fixed;
  pointer-events:none;
  z-index:2147483645;
  border:2px solid rgba(59,130,246,.85);
  background:rgba(59,130,246,.12);
  border-radius:6px;
  box-shadow:0 0 0 4px rgba(59,130,246,.15),0 4px 20px rgba(59,130,246,.25);
  transition:all .15s cubic-bezier(.4,0,.2,1);
  animation:pi-highlight-pulse 2s ease-in-out infinite;
}
@keyframes pi-highlight-pulse{
  0%,100%{box-shadow:0 0 0 4px rgba(59,130,246,.15),0 4px 20px rgba(59,130,246,.25);}
  50%{box-shadow:0 0 0 8px rgba(59,130,246,.08),0 4px 24px rgba(59,130,246,.35);}
}

/* ── Label ── */
.pi-preview-label{
  position:fixed;
  pointer-events:none;
  z-index:2147483646;
  background:rgba(15,23,42,.92);
  backdrop-filter:blur(8px);
  color:#bfdbfe;
  padding:4px 10px;
  border-radius:6px;
  font-size:12px;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  white-space:nowrap;
  transform:translateY(-120%);
  margin-top:-6px;
  border:1px solid rgba(59,130,246,.35);
  box-shadow:0 2px 12px rgba(0,0,0,.3);
  transition:all .15s cubic-bezier(.4,0,.2,1);
}
.pi-preview-label-tag{color:#60a5fa;font-weight:600;}
.pi-preview-label-id{color:#a5b4fc;font-weight:500;}
.pi-preview-label-cls{color:#c4b5fd;}

/* ── Toast ── */
.pi-preview-toast{
  position:fixed;
  bottom:50px;
  right:12px;
  z-index:2147483646;
  background:rgba(239,68,68,.92);
  backdrop-filter:blur(8px);
  color:#fff;
  padding:8px 14px;
  border-radius:10px;
  font-size:12px;
  font-family:system-ui,sans-serif;
  box-shadow:0 2px 12px rgba(0,0,0,.3);
  pointer-events:auto;
  cursor:pointer;
  max-width:320px;
  animation:pi-toast-in .25s cubic-bezier(.4,0,.2,1);
  border:1px solid rgba(255,255,255,.1);
}
@keyframes pi-toast-in{
  from{opacity:0;transform:translateY(8px) scale(.96);}
  to{opacity:1;transform:translateY(0) scale(1);}
}

/* ── Picker active cursor ── */
.pi-preview-cursor-crosshair{
  cursor:crosshair !important;
}
`;

const CSS_JSON = JSON.stringify(OVERLAY_CSS);

export function getOverlayCSS(): string {
  return OVERLAY_CSS;
}

/**
 * Returns the overlay JS with CSS embedded (no separate CSS request needed).
 */
export function getOverlayJS(): string {
  return `(function(){
"use strict";
if(window.__piPreviewOverlay)return;
window.__piPreviewOverlay=true;

// PARENT origin is determined from the first message received.
// In dev mode the iframe is cross-origin (port 3069 vs 3070), so we
// cannot use window.location.origin as the target.
var PARENT_ORIGIN = '*';

// ── Proxy routing metadata (injected by pi-preview-proxy.ts) ──
var PROXY_PREFIX = window.__PI_PREVIEW_PREFIX || '';
var PROXY_ORIGIN = window.__PI_PREVIEW_ORIGIN || window.location.origin;

// ── Resolve URL against current document URL (NOT <base>) ──
function resolveAgainstDocument(url){
  try{
    return new URL(url,window.location.href).href;
  }catch(_){}
  return url;
}

var origPushState=history.pushState;
var origReplaceState=history.replaceState;
history.pushState=function(state,title,url){
  if(typeof url==='string'){
    url=resolveAgainstDocument(url);
  }
  return origPushState.call(history,state,title,url);
};
history.replaceState=function(state,title,url){
  if(typeof url==='string'){
    url=resolveAgainstDocument(url);
  }
  return origReplaceState.call(history,state,title,url);
};

// ── Fetch / XHR interception ──
function toProxyUrl(url){
  try{
    var u=new URL(url,document.baseURI);
    var baseEl=document.querySelector('base[data-pi-preview]');
    var devOrigin=baseEl?new URL(baseEl.href).origin:null;
    if(devOrigin&&u.origin===devOrigin){
      return PROXY_ORIGIN+PROXY_PREFIX+u.pathname.slice(1)+u.search+u.hash;
    }
    if(u.origin===window.location.origin&&!u.pathname.startsWith(PROXY_PREFIX)){
      return PROXY_ORIGIN+PROXY_PREFIX+u.pathname.slice(1)+u.search+u.hash;
    }
  }catch(_){}
  return url;
}

var origFetch=window.fetch;
window.fetch=function(input,init){
  if(typeof input==='string'){
    var proxyInput=toProxyUrl(input);
    if(proxyInput!==input){input=proxyInput;}
  }else if(input&&typeof input.url==='string'){
    var proxyInput=toProxyUrl(input.url);
    if(proxyInput!==input.url){
      try{input=new Request(proxyInput,input);}catch(_){}
    }
  }
  return origFetch.call(window,input,init);
};
var origXHROpen=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(method,url,async,user,password){
  var proxyUrl=toProxyUrl(url);
  if(proxyUrl!==url){url=proxyUrl;}
  return origXHROpen.call(this,method,url,async,user,password);
};

// ── Shadow DOM container ──
var root=document.createElement("div");
root.id="__pi-preview-root";
root.style.cssText="position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;pointer-events:none;";
document.documentElement.appendChild(root);
var shadow=root.attachShadow({mode:"open"});

// Inject styles into shadow root (shadow DOM elements are isolated from document styles)
var styleEl=document.createElement("style");
styleEl.textContent=${CSS_JSON};
styleEl.setAttribute("data-pi-preview","");
shadow.appendChild(styleEl);
// ── Overlay elements in shadow ──
var overlay=document.createElement("div");
overlay.className="pi-preview-overlay";
shadow.appendChild(overlay);

var highlight=document.createElement("div");
highlight.className="pi-preview-highlight";
highlight.style.display="none";
shadow.appendChild(highlight);

var label=document.createElement("div");
label.className="pi-preview-label";
label.style.display="none";
shadow.appendChild(label);

// ── State ──
var pickerActive=false;
var currentElement=null;

// ── Overlay detection ──
function isInOverlay(el){
  if(!el)return true;
  if(el===root)return true;
  while(el){
    if(el===root)return true;
    var rn=el.getRootNode();
    if(rn&&rn.nodeType===11){ // shadow root
      if(rn===shadow)return true;
      el=rn.host;
      continue;
    }
    el=el.parentElement;
  }
  return false;
}

// ── CSS selector builder ──
function getSelector(el){
  if(!el||el===document.documentElement)return"html";
  if(el===document.body)return"html>body";
  if(el.id)return"#"+CSS.escape(el.id);
  var parts=[];
  while(el&&el!==document.documentElement){
    var tag=el.tagName.toLowerCase();
    if(el.id){parts.unshift("#"+CSS.escape(el.id));break;}
    var parent=el.parentElement;
    if(parent){
      var siblings=Array.from(parent.children).filter(function(s){return s.tagName===el.tagName;});
      if(siblings.length>1){
        tag+=":nth-child("+(Array.from(parent.children).indexOf(el)+1)+")";
      }
    }
    parts.unshift(tag);
    el=parent;
  }
  return parts.join(">");
}

// ── Reconstruct real dev-server URL (not proxied URL) ──
function getRealUrl(){
  var baseEl=document.querySelector('base[data-pi-preview]');
  var realOrigin=baseEl ? new URL(baseEl.href).origin : window.location.origin;
  var pathname=window.location.pathname;
  if(PROXY_PREFIX && pathname.indexOf(PROXY_PREFIX)===0){
    pathname=pathname.slice(PROXY_PREFIX.length);
  }
  return realOrigin+'/'+pathname.replace(/^\\//,'')+window.location.search+window.location.hash;
}


// ── React component source detection ──
function getReactSource(el){
  try{
    // Find React fiber key on the DOM element (e.g. __reactFiber$abc123)
    var fiberKey=Object.keys(el).find(function(k){return k.indexOf('__reactFiber$')===0;});
    if(!fiberKey)return null;
    var fiber=el[fiberKey];
    if(!fiber)return null;
    var componentName=null;
    var sourceFile=null;
    var sourceLine=null;
    var stack=[];
    // Walk up the fiber tree, collecting component names
    var node=fiber;
    while(node&&stack.length<10){
      if(node.tag===1||node.tag===2||node.tag===0){ // Class, Function, or FunctionComponent
        var name=null;
        if(node.type){
          name=node.type.displayName||node.type.name||null;
        }
        if(name&&stack.indexOf(name)===-1)stack.push(name);
        if(!componentName)componentName=name;
        // Get debug source info from the first component that has it
        if(!sourceFile&&node._debugSource){
          sourceFile=node._debugSource.fileName||null;
          sourceLine=node._debugSource.lineNumber||null;
        }
      }
      node=node.return||node._debugOwner;
    }
    if(!componentName&&!sourceFile&&stack.length===0)return null;
    return {
      componentName:componentName||undefined,
      file:sourceFile||undefined,
      line:sourceLine||undefined,
      componentStack:stack.length>0?stack:undefined
    };
  }catch(_){}
  return null;
}
// ── Element serializer ──
function serializeElement(el){
  var importantProps=["display","position","width","height","margin","padding",
    "border","background","background-color","color","font-size",
    "font-family","text-align","flex-direction","align-items",
    "justify-content","gap","border-radius","box-shadow","opacity",
    "transform","transition","overflow","z-index"];
  var styles={};
  var computed=window.getComputedStyle(el);
  for(var i=0;i<importantProps.length;i++){
    var p=importantProps[i];
    var v=computed.getPropertyValue(p);
    if(v&&v!=="none"&&v!=="normal"&&v!=="auto"&&v!=="0px")styles[p]=v;
  }
  var rect=el.getBoundingClientRect();
  var html=el.outerHTML;
  if(html.length>5000)html=html.slice(0,5000)+"...";
  var text=(el.textContent||"").trim();
  if(text.length>200)text=text.slice(0,200)+"...";
  var selector=getSelector(el);
  var token="element:"+el.tagName.toLowerCase()+"."+selector.replace(/[^a-zA-Z0-9_\\-]/g,"-");
  return {
    selector:selector,
    tagName:el.tagName.toLowerCase(),
    outerHTML:html,
    boundingBox:{x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height)},
    computedStyles:styles,
    textContent:text,
    source:getReactSource(el),
    token:token,
    pageUrl:getRealUrl(),
    pageTitle:document.title||""
  };
}

// ── Build rich label HTML ──
function buildLabelHTML(el){
  var tag=el.tagName.toLowerCase();
  var id=el.id?'#<span class="pi-preview-label-id">'+CSS.escape(el.id)+'</span>':'';
  var cls='';
  if(typeof el.className==="string"){
    var classes=el.className.trim().split(/\\s+/).slice(0,2).join('.');
    if(classes) cls='.<span class="pi-preview-label-cls">'+classes+'</span>';
  }
  var dims=function(){
    var r=el.getBoundingClientRect();
    return Math.round(r.width)+'×'+Math.round(r.height);
  }();
  return '<span class="pi-preview-label-tag">&lt;'+tag+'&gt;</span>'+id+cls+' <span style="opacity:.6">'+dims+'</span>';
}

// ── Highlight ──
function showHighlight(el){
  var rect=el.getBoundingClientRect();
  var pad=4;
  highlight.style.display="block";
  highlight.style.left=(rect.x-pad)+"px";
  highlight.style.top=(rect.y-pad)+"px";
  highlight.style.width=(rect.width+pad*2)+"px";
  highlight.style.height=(rect.height+pad*2)+"px";
  label.style.display="block";
  label.style.left=rect.x+"px";
  label.style.top=rect.y+"px";
  label.innerHTML=buildLabelHTML(el);
}
function hideHighlight(){
  highlight.style.display="none";
  label.style.display="none";
}

// ── Build user message from picked element ──
// (buildElementMessage inlined into onClick)
// ── Mouse handlers ──
// ── Mouse handlers ──
function onMouseMove(e){
  if(!pickerActive)return;
  var el=document.elementFromPoint(e.clientX,e.clientY);
  if(!el||isInOverlay(el))return;
  if(el!==currentElement){currentElement=el;showHighlight(el);}
}
function onClick(e){
  if(!pickerActive)return;
  e.preventDefault();
  e.stopPropagation();
  pickerActive=false;
  document.body.style.cursor="";
  document.body.classList.remove("pi-preview-cursor-crosshair");
  document.removeEventListener("mousemove",onMouseMove,{capture:true});
  document.removeEventListener("click",onClick,{capture:true});
  hideHighlight();
  var el=document.elementFromPoint(e.clientX,e.clientY);
  if(!el||isInOverlay(el))return;
  var data=serializeElement(el);
  window.parent.postMessage({
    type:"element:selected",
    payload:data,
  },PARENT_ORIGIN);
}

// ── Console capture ──
var origError=console.error;
var origWarn=console.warn;
var origLog=console.log;

function sendConsole(level,args){
  try{
    var msg=Array.from(args).map(function(a){
      if(a instanceof Error)return a.stack||a.message;
      if(typeof a==="object"){try{return JSON.stringify(a);}catch(_){return String(a);}}
      return String(a);
    }).join(" ");
    if(msg.length>2000)msg=msg.slice(0,2000)+"...";
    window.parent.postMessage({type:"console:"+level,payload:{message:msg,timestamp:Date.now()}},PARENT_ORIGIN);
  }catch(_){}
}

console.error=function(){origError.apply(console,arguments);sendConsole("error",arguments);};
console.warn=function(){origWarn.apply(console,arguments);sendConsole("warn",arguments);};

// ── Show error toast ──
var lastErrorTime=0;

window.addEventListener("error",function(e){
  var now=Date.now();
  if(now-lastErrorTime<2000)return;
  lastErrorTime=now;
  var msg=(e.message||"Unknown error")+(e.filename?"\\n"+e.filename+":"+e.lineno:"");
  var toast=document.createElement("div");
  toast.className="pi-preview-toast";
  toast.textContent=msg.slice(0,200);
  toast.title=msg;
  toast.addEventListener("click",function(){
    window.parent.postMessage({
      type:"console:error",
      payload:{message:msg,timestamp:now}
    },PARENT_ORIGIN);
    toast.remove();
  });
  shadow.appendChild(toast);
  setTimeout(function(){if(toast.parentNode)toast.remove();},8000);
});

// ── Listen for parent messages ──
window.addEventListener("message",function(event){
  if(PARENT_ORIGIN==='*'){
    PARENT_ORIGIN=event.origin;
  }else if(event.origin!==PARENT_ORIGIN){
    return;
  }
  var msg=event.data;
  if(!msg||!msg.type)return;
  switch(msg.type){
    case"picker:on":
      pickerActive=true;
      document.body.style.cursor="crosshair";
      document.body.classList.add("pi-preview-cursor-crosshair");
      document.addEventListener("mousemove",onMouseMove,{capture:true});
      document.addEventListener("click",onClick,{capture:true});
      break;
    case"picker:off":
      pickerActive=false;
      document.body.style.cursor="";
      document.body.classList.remove("pi-preview-cursor-crosshair");
      document.removeEventListener("mousemove",onMouseMove,{capture:true});
      document.removeEventListener("click",onClick,{capture:true});
      hideHighlight();
      break;
    case"highlight:element":
      if(msg.selector){
        try{
          var target=document.querySelector(msg.selector);
          if(target)showHighlight(target);
        }catch(_){}
      }
      break;
  }
});

// ── Notify parent that overlay is ready ──
// Send "overlay:ready" so the parent can re-send the current picker state.
// This handles the race where picker:on was sent before the overlay loaded.
try{
  window.parent.postMessage({type:"overlay:ready"},'*');
}catch(_){}

})();`;
}
