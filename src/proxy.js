'use strict';

const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const zlib = require('node:zlib');
const { Transform, pipeline } = require('node:stream');
const express = require('express');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const MAX_URL_LENGTH = 4096;
const MAX_ACTIVE_REQUESTS = 48;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_HTML_BYTES = 6 * 1024 * 1024;
const MAX_CSS_BYTES = 2 * 1024 * 1024;
const MAX_TRANSFORMS = 2;
const MAX_ACTIVE_WEBSOCKETS = 16;
const DNS_CACHE_MS = 30_000;
const dnsCache = new Map();
let activeRequests = 0;
let activeTransforms = 0;
let activeWebSockets = 0;

const blockedV4 = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockedV4.addSubnet(address, prefix, 'ipv4');

function isBlockedAddress(address, family) {
  if (family === 4) return blockedV4.check(address, 'ipv4');
  const value = ipv6ToBigInt(address);
  if (value === null) return true;

  if ((value >> 32n) === BigInt('0xffff')) {
    const ipv4 = value & 0xffffffffn;
    const text = [24n, 16n, 8n, 0n].map((shift) => Number((ipv4 >> shift) & 255n)).join('.');
    return blockedV4.check(text, 'ipv4');
  }

  const inRange = (start, bits, prefix) => (value >> BigInt(bits - prefix)) === (start >> BigInt(bits - prefix));
  const globalUnicast = inRange(0x20000000000000000000000000000000n, 128, 3);
  const documentation = inRange(0x20010db8000000000000000000000000n, 128, 32);
  const special2001 = inRange(0x20010000000000000000000000000000n, 128, 23);
  const sixToFour = inRange(0x20020000000000000000000000000000n, 128, 16);
  const nat64 = inRange(0x0064ff9b000000000000000000000000n, 128, 96);
  const nat64Local = inRange(0x0064ff9b000100000000000000000000n, 128, 48);
  return !globalUnicast || documentation || special2001 || sixToFour || nat64 || nat64Local;
}

function ipv6ToBigInt(input) {
  let value = input.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!value.includes(':')) return null;
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const ipv4 = value.slice(lastColon + 1);
    if (net.isIP(ipv4) !== 4) return null;
    const octets = ipv4.split('.').map(Number);
    value = `${value.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(`0x${group}`), 0n);
}

async function resolvePublicAddresses(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.includes('%')) {
    throw blockedTarget();
  }

  const family = net.isIP(host);
  if (family) {
    if (isBlockedAddress(host, family)) throw blockedTarget();
    return [{ address: host, family }];
  }

  const cached = dnsCache.get(host);
  if (cached && cached.expires > Date.now()) return cached.addresses;

  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch (error) {
    throw Object.assign(new Error('DNS lookup failed'), { code: error.code || 'DNS_LOOKUP_FAILED', publicMessage: '接続先を確認できませんでした' });
  }
  if (!addresses.length || addresses.some((entry) => isBlockedAddress(entry.address, entry.family))) throw blockedTarget();

  if (dnsCache.size >= 256) {
    for (const [key, entry] of dnsCache) if (entry.expires <= Date.now()) dnsCache.delete(key);
    if (dnsCache.size >= 256) dnsCache.delete(dnsCache.keys().next().value);
  }
  dnsCache.set(host, { addresses, expires: Date.now() + DNS_CACHE_MS });
  return addresses;
}

function blockedTarget() {
  return Object.assign(new Error('Target is not publicly routable'), {
    code: 'TARGET_BLOCKED',
    publicMessage: 'この接続先にはアクセスできません',
  });
}

async function validateTarget(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > MAX_URL_LENGTH) {
    throw Object.assign(new Error('Invalid URL'), { publicMessage: 'URLを入力してください' });
  }
  let target;
  try {
    const value = input.trim();
    target = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw Object.assign(new Error('Invalid URL'), { publicMessage: 'URLの形式を確認してください' });
  }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || !target.hostname) {
    throw Object.assign(new Error('Unsupported URL'), { publicMessage: 'HTTPまたはHTTPSのURLを入力してください' });
  }
  if (target.port) throw Object.assign(new Error('Unsupported port'), { publicMessage: 'このポートには接続できません' });
  await resolvePublicAddresses(target.hostname);
  return target;
}

function originToken(origin) {
  return Buffer.from(origin).toString('base64url');
}

function encodeProxyUrl(target) {
  return `/proxy/${originToken(target.origin)}${target.pathname}${target.search}${target.hash}`;
}

function decodeOrigin(token) {
  if (typeof token !== 'string' || token.length > 512 || !/^[A-Za-z0-9_-]+$/.test(token)) throw blockedTarget();
  let parsed;
  try {
    parsed = new URL(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw blockedTarget();
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.port || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || originToken(parsed.origin) !== token) throw blockedTarget();
  return parsed;
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function urlForPage(value, baseUrl) {
  const input = String(value || '').trim();
  if (!input || /^(?:#|javascript:|mailto:|tel:|data:|blob:|about:)/i.test(input)) return input;
  try {
    const resolved = new URL(input, baseUrl);
    if (!['http:', 'https:'].includes(resolved.protocol)) return input;
    return encodeProxyUrl(resolved);
  } catch {
    return input;
  }
}

function rewriteSrcset(value, baseUrl) {
  let cursor = 0;
  const parts = [];
  while (cursor < value.length) {
    while (cursor < value.length && /[\s,]/.test(value[cursor])) cursor++;
    if (cursor >= value.length) break;
    let start = cursor;
    while (cursor < value.length && !/\s/.test(value[cursor])) cursor++;
    let url = value.slice(start, cursor);
    let comma = '';
    if (url.endsWith(',')) { url = url.slice(0, -1); comma = ','; }
    let descriptor = '';
    if (!comma) {
      start = cursor;
      while (cursor < value.length && value[cursor] !== ',') cursor++;
      descriptor = value.slice(start, cursor).trim();
    }
    parts.push(`${urlForPage(url, baseUrl)}${descriptor ? ` ${descriptor}` : ''}${comma}`);
    if (value[cursor] === ',') cursor++;
  }
  return parts.join(', ');
}

function rewriteCss(css, baseUrl) {
  return css
    .replace(/url\(\s*(?:(["'])(.*?)\1|([^)]*?))\s*\)/gi, (match, quote, quoted, bare) => {
      const value = (quoted ?? bare ?? '').trim();
      return `url("${urlForPage(value, baseUrl).replace(/"/g, '%22')}")`;
    })
    .replace(/(@import\s+)(["'])(.*?)\2/gi, (_match, prefix, quote, value) => `${prefix}${quote}${urlForPage(value, baseUrl)}${quote}`);
}

function runtimeScript(target) {
  const upstreamUrl = JSON.stringify(target.href).replace(/</g, '\\u003c');
  return `(()=>{
const page=new URL(${upstreamUrl});
const appOrigin=location.origin;
const tokenFor=origin=>btoa(origin).replaceAll('+','-').replaceAll('/','_').replace(/=/g,'');
const isProxyPath=pathname=>{
  const match=pathname.match(new RegExp('^/proxy/([A-Za-z0-9_-]+)(?:/|$)'));
  if(!match)return false;
  try{
    const token=match[1];
    const encoded=token.replaceAll('-','+').replaceAll('_','/');
    const decoded=atob(encoded+'='.repeat((4-encoded.length%4)%4));
    const origin=new URL(decoded);
    return /^https?:$/.test(origin.protocol)&&origin.origin===decoded&&tokenFor(origin.origin)===token;
  }catch{return false}
};
const toProxy=value=>{
  try{
    const raw=value instanceof URL?value.href:String(value);
    if(raw.startsWith('/')&&isProxyPath(raw.split(/[?#]/,1)[0]))return raw;
    const u=new URL(raw,page);
    if(!/^https?:$/.test(u.protocol))return raw;
    if(u.origin===appOrigin){
      if(isProxyPath(u.pathname)||u.pathname.startsWith('/assets/'))return u.pathname+u.search+u.hash;
      u.protocol=page.protocol;u.host=page.host;
    }
    return '/proxy/'+tokenFor(u.origin)+u.pathname+u.search+u.hash;
  }catch{return value}
};
const toProxyWebSocket=value=>{
  const raw=value instanceof URL?value.href:String(value);
  try{
    const u=new URL(raw,page);
    if(u.protocol!=='ws:'&&u.protocol!=='wss:')return toProxy(raw);
    const upstreamProtocol=u.protocol==='wss:'?'https:':'http:';
    const upstreamOrigin=upstreamProtocol+'//'+u.host;
    const socketProtocol=location.protocol==='https:'?'wss:':'ws:';
    return socketProtocol+'//'+location.host+'/proxy/'+tokenFor(upstreamOrigin)+u.pathname+u.search;
  }catch{return raw}
};
const toProxyCss=css=>String(css).replace(/url\\(\\s*(['"]?)([^'")]+)\\1\\s*\\)/gi,(match,quote,url)=>{
  const proxied=toProxy(url.trim());
  if(proxied===url)return match;
  return 'url("'+String(proxied).replace(/"/g,'%22')+'")';
});
window.__YUBIKIRI_UPSTREAM_URL__=page.href;
window.__YUBIKIRI_PROXY_URL__=toProxy;
window.fetch=((nativeFetch)=>((input,init)=>{
  if(input instanceof Request){
    const url=toProxy(input.url);
    if(url===input.url)return nativeFetch(input,init);
    return nativeFetch(new Request(url,input),init);
  }
  return nativeFetch(toProxy(input),init);
}))(window.fetch.bind(window));
const open=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(method,url,...rest){return open.call(this,method,toProxy(url),...rest)};
const NativeWebSocket=window.WebSocket;
if(NativeWebSocket){
  function ProxyWebSocket(url,protocols){
    const proxied=toProxyWebSocket(url);
    return protocols===undefined?new NativeWebSocket(proxied):new NativeWebSocket(proxied,protocols);
  }
  ProxyWebSocket.prototype=NativeWebSocket.prototype;
  Object.setPrototypeOf(ProxyWebSocket,NativeWebSocket);
  window.WebSocket=ProxyWebSocket;
}
const NativeEventSource=window.EventSource;
if(NativeEventSource){
  function ProxyEventSource(url,eventConfig){
    const proxied=toProxy(url);
    return eventConfig===undefined?new NativeEventSource(proxied):new NativeEventSource(proxied,eventConfig);
  }
  ProxyEventSource.prototype=NativeEventSource.prototype;
  Object.setPrototypeOf(ProxyEventSource,NativeEventSource);
  window.EventSource=ProxyEventSource;
}
const NativeWorker=window.Worker;
if(NativeWorker){
  function ProxyWorker(url,workerOptions){
    const proxied=toProxy(url);
    return workerOptions===undefined?new NativeWorker(proxied):new NativeWorker(proxied,workerOptions);
  }
  ProxyWorker.prototype=NativeWorker.prototype;
  Object.setPrototypeOf(ProxyWorker,NativeWorker);
  window.Worker=ProxyWorker;
}
const NativeSharedWorker=window.SharedWorker;
if(NativeSharedWorker){
  function ProxySharedWorker(url,workerOptions){
    const proxied=toProxy(url);
    return workerOptions===undefined?new NativeSharedWorker(proxied):new NativeSharedWorker(proxied,workerOptions);
  }
  ProxySharedWorker.prototype=NativeSharedWorker.prototype;
  Object.setPrototypeOf(ProxySharedWorker,NativeSharedWorker);
  window.SharedWorker=ProxySharedWorker;
}
if(navigator.sendBeacon){
  const nativeSendBeacon=navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon=(url,data)=>nativeSendBeacon(toProxy(url),data);
}
if(navigator.serviceWorker){
  navigator.serviceWorker.register=()=>Promise.reject(new Error('ServiceWorker is unavailable inside Yubikiri Proxy'));
}
const cookieDescriptor=Object.getOwnPropertyDescriptor(Document.prototype,'cookie');
const queryToken=new URLSearchParams(location.search).get('__y');
const tokenFromLocation=(location.pathname.match(new RegExp('^/proxy/([A-Za-z0-9_-]+)(?:/|$)'))||[])[1]||(queryToken&&/^[A-Za-z0-9_-]+$/.test(queryToken)?queryToken:'');
if(cookieDescriptor&&cookieDescriptor.configurable&&cookieDescriptor.set&&tokenFromLocation){
  Object.defineProperty(Document.prototype,'cookie',{
    configurable:true,
    enumerable:cookieDescriptor.enumerable,
    get:cookieDescriptor.get,
    set(value){
      if(typeof value!=='string'){cookieDescriptor.set.call(this,value);return}
      const segments=value.split(';');
      const first=segments.shift();
      const output=[first];
      let hasPath=false;
      for(const segment of segments){
        const trimmed=segment.trim();
        const equals=trimmed.indexOf('=');
        const key=(equals<0?trimmed:trimmed.slice(0,equals)).toLowerCase();
        if(key==='domain')continue;
        if(key==='path'){
          hasPath=true;
          const requested=((equals<0?'/':trimmed.slice(equals+1).trim())||'/');
          const scoped=requested.startsWith('/')?requested:'/'+requested;
          output.push('path=/proxy/'+tokenFromLocation+scoped);
          continue;
        }
        output.push(trimmed);
      }
      cookieDescriptor.set.call(this,output.filter(Boolean).join('; '));
    },
  });
}
// SPA routers read location.pathname and compare it with their own routes.
// Rewrite the visible URL in place so the page lives in app-path space
// (/<path>?__y=<token>) while /proxy/<token>/... stays canonical for every
// request the browser sends to this server. Must run before site scripts.
const proxyPrefix='/proxy/'+tokenFromLocation;
if(tokenFromLocation&&(location.pathname===proxyPrefix||location.pathname.startsWith(proxyPrefix+'/'))){
  const appPath=location.pathname.slice(proxyPrefix.length)||'/';
  const params=new URLSearchParams(location.search);
  if(!params.has('__y')){
    const extra=params.toString();
    History.prototype.replaceState.call(history,history.state,'',appPath+'?__y='+tokenFromLocation+(extra?'&'+extra:'')+location.hash);
  }
}
const proxiedProperties=[
  ['HTMLImageElement','src'],['HTMLImageElement','srcset'],
  ['HTMLScriptElement','src'],
  ['HTMLIFrameElement','src'],['HTMLFrameElement','src'],
  ['HTMLSourceElement','src'],['HTMLSourceElement','srcset'],
  ['HTMLMediaElement','src'],['HTMLMediaElement','poster'],
  ['HTMLTrackElement','src'],
  ['HTMLEmbedElement','src'],['HTMLObjectElement','data'],
  ['HTMLLinkElement','href'],
  ['HTMLAnchorElement','href'],['HTMLAreaElement','href'],
  ['HTMLFormElement','action'],
  ['HTMLInputElement','src'],['HTMLInputElement','formAction'],
  ['HTMLButtonElement','formAction'],
];
for(const [constructorName,property] of proxiedProperties){
  const constructor=window[constructorName];
  const descriptor=constructor&&Object.getOwnPropertyDescriptor(constructor.prototype,property);
  if(!constructor||!descriptor||!descriptor.configurable||!descriptor.set)continue;
  Object.defineProperty(constructor.prototype,property,{
    configurable:true,
    enumerable:descriptor.enumerable,
    get:descriptor.get,
    set(value){descriptor.set.call(this,typeof value==='string'?toProxy(value):value)},
  });
}
const setAttribute=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(name,value){
  if(/^(?:href|src|action|formaction|poster|data|cite|srcset|background)$/i.test(name)){
    value=name.toLowerCase()==='srcset'?String(value).split(',').map(part=>{
      const [url,...descriptor]=part.trim().split(' ').filter(Boolean);
      return [toProxy(url),...descriptor].join(' ');
    }).join(', '):toProxy(value);
  }
  else if(name.toLowerCase()==='style'){
    value=toProxyCss(value);
  }
  return setAttribute.call(this,name,value);
};
const fragmentSelector='a[href], area[href], link[href], img[src], script[src], iframe[src], frame[src], embed[src], source[src], audio[src], video[src], track[src], input[src], form[action], button[formaction], input[formaction], video[poster], object[data], [background], [srcset], use[href], image[href]';
const rewriteElement=element=>{
  for(const attr of ['href','src','action','formaction','poster','data','cite','background','srcset','style']){
    const value=element.getAttribute(attr);
    if(typeof value==='string')element.setAttribute(attr,value);
  }
  if(element.tagName==='STYLE'&&typeof element.textContent==='string')element.textContent=toProxyCss(element.textContent);
};
const rewriteFragment=root=>{
  if(!root||root.nodeType!==1)return;
  try{
    if(root.matches(fragmentSelector))rewriteElement(root);
    for(const element of root.querySelectorAll(fragmentSelector))rewriteElement(element);
  }catch{}
};
const htmlDescriptor=Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');
if(htmlDescriptor&&htmlDescriptor.configurable&&htmlDescriptor.set){
  Object.defineProperty(Element.prototype,'innerHTML',{
    configurable:true,
    enumerable:htmlDescriptor.enumerable,
    get:htmlDescriptor.get,
    set(value){htmlDescriptor.set.call(this,value);rewriteFragment(this)},
  });
}
const adjacentDescriptor=Object.getOwnPropertyDescriptor(Element.prototype,'insertAdjacentHTML');
if(adjacentDescriptor&&adjacentDescriptor.configurable&&adjacentDescriptor.value){
  const walkSiblings=(element,forward)=>{
    let node=forward?element.nextElementSibling:element.previousElementSibling;
    while(node){if(node.nodeType===1)rewriteElement(node);node=forward?node.nextElementSibling:node.previousElementSibling}
  };
  Object.defineProperty(Element.prototype,'insertAdjacentHTML',{
    configurable:true,
    enumerable:adjacentDescriptor.enumerable,
    writable:true,
    value:function(position,text){
      adjacentDescriptor.value.call(this,position,text);
      try{
        if(position==='afterend')walkSiblings(this,true);
        else if(position==='beforebegin')walkSiblings(this,false);
        else for(const child of this.children)rewriteElement(child);
      }catch{}
    },
  });
}
const nativeOpen=window.open;
window.open=function(url,...args){return nativeOpen.call(this,url?toProxy(url):url,...args)};
// History entries live in app-path space (/<path>?__y=<token>) so SPA routers
// that read location.pathname see their own route table. Full document loads
// keep using /proxy/<token>/... via toProxy; the server accepts both forms.
const toAppPage=value=>{
  try{
    const raw=value instanceof URL?value.href:String(value);
    const u=new URL(String(raw),page);
    if(!/^https?:$/.test(u.protocol))return String(raw);
    if(u.origin===page.origin){
      if(u.searchParams.has('__y')||u.pathname.startsWith('/assets/'))return u.pathname+u.search+u.hash;
      if(isProxyPath(u.pathname)){
        const rest=u.pathname.slice('/proxy/'.length);
        const slash=rest.indexOf('/');
        const token=slash<0?rest:rest.slice(0,slash);
        const pathPart=slash<0?'/':rest.slice(slash);
        return pathPart+'?__y='+token+(u.search.length>1?'&'+u.search.slice(1):'')+u.hash;
      }
      return u.pathname+'?__y='+tokenFromLocation+(u.search.length>1?'&'+u.search.slice(1):'')+u.hash;
    }
    return '/proxy/'+tokenFor(u.origin)+u.pathname+u.search+u.hash;
  }catch{return value}
};
for(const name of ['pushState','replaceState']){
  const original=history[name].bind(history);
  history[name]=function(state,title,url){return original(state,title,url==null?url:toAppPage(url))};
}
document.addEventListener('click',event=>{
  const link=event.target instanceof Element?event.target.closest('[data-proxy-home]'):null;
  if(!link)return;
  event.preventDefault();
  event.stopImmediatePropagation();
  location.assign(appOrigin+'/');
},true);
document.addEventListener('DOMContentLoaded',()=>{
  for(const link of document.querySelectorAll('[data-proxy-home]'))setAttribute.call(link,'href',appOrigin+'/');
},{once:true});
})();`;
}

function looksLikeResourceUrl(value) {
  if (!value || /[(){}"'=\s]/.test(value)) return false;
  return /^(?:\.{1,2}\/|\/|https?:\/\/|\/\/)/i.test(value)
    || /^[^/]+\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico|css|js|mjs|mp4|webm|ogv|mp3|wav|woff2?|ttf|otf|eot|json|vtt|pdf)(?:[?#]|$)/i.test(value);
}

function rewriteHtml(source, target, token) {
  const $ = cheerio.load(source, { decodeEntities: false });
  $('base').remove();
  $('meta[http-equiv="content-security-policy" i], meta[http-equiv="content-security-policy-report-only" i]').remove();
  if (!$('head').length) $('html').prepend('<head></head>');

  const attributes = [
    ['a[href],area[href],link[href]', 'href'],
    ['img[src],script[src],iframe[src],frame[src],embed[src],source[src],audio[src],video[src],track[src],input[src]', 'src'],
    ['form[action]', 'action'], ['button[formaction],input[formaction]', 'formaction'],
    ['video[poster]', 'poster'], ['object[data]', 'data'], ['blockquote[cite],q[cite]', 'cite'],
    ['[background]', 'background'],
  ];
  for (const [selector, attribute] of attributes) {
    $(selector).each((_index, element) => {
      const value = $(element).attr(attribute);
      if (value !== undefined) $(element).attr(attribute, urlForPage(value, target));
    });
  }
  $('use, image').each((_index, element) => {
    for (const name of ['href', 'xlink:href']) {
      const value = $(element).attr(name);
      if (value !== undefined) $(element).attr(name, urlForPage(value, target));
    }
  });
  $('[srcset]').each((_index, element) => $(element).attr('srcset', rewriteSrcset($(element).attr('srcset'), target)));
  for (const name of ['data-src', 'data-original', 'data-bg', 'data-background-image', 'data-poster']) {
    $(`[${name}]`).each((_index, element) => {
      const value = $(element).attr(name);
      if (value && looksLikeResourceUrl(value)) $(element).attr(name, urlForPage(value, target));
    });
  }
  $('[data-srcset]').each((_index, element) => {
    const value = $(element).attr('data-srcset');
    if (value && looksLikeResourceUrl(value.split(',')[0].trim().split(/\s+/)[0])) {
      $(element).attr('data-srcset', rewriteSrcset(value, target));
    }
  });
  $('[style]').each((_index, element) => $(element).attr('style', rewriteCss($(element).attr('style'), target)));
  $('style').each((_index, element) => $(element).text(rewriteCss($(element).text(), target)));
  $('meta[http-equiv="refresh" i]').each((_index, element) => {
    const content = $(element).attr('content');
    if (!content) return;
    $(element).attr('content', content.replace(/(url\s*=\s*)(["']?)([^"';]+)\2/i, (_match, prefix, quote, value) => `${prefix}${quote}${urlForPage(value.trim(), target)}${quote}`));
  });
  $('[integrity]').removeAttr('integrity');

  const directory = new URL('.', target).pathname;
  const toolbar = $('<div id="yubikiri-proxy-toolbar"></div>');
  toolbar.append('<a href="/" data-proxy-home aria-label="Yubikiri Proxy">YUBIKIRI PROXY</a>');
  const form = $('<form data-proxy-form action="/api/navigate" method="get"></form>');
  form.append('<label class="visually-hidden" for="yubikiri-address">URL</label>');
  form.append('<input id="yubikiri-address" name="url" type="text" inputmode="url" autocomplete="url" spellcheck="false" autocapitalize="off" required>');
  form.find('input').attr('value', target.href);
  form.append('<button type="submit">Go</button>');
  form.append('<span data-form-error role="status" aria-live="polite"></span>');
  toolbar.append(form);
  $('body').prepend(toolbar);
  $('body').prepend('<div id="yubikiri-proxy-grip" title="Yubikiri Proxyのバーを表示" aria-hidden="true"></div>');
  $('body').append('<span id="yubikiri-proxy-version">Beta 1</span>');

  const head = $('head');
  head.prepend(`<base href="/proxy/${token}${htmlEscape(directory)}"><script>${runtimeScript(target)}</script>`);
  head.append('<link rel="stylesheet" href="/assets/proxy.css">');
  head.append('<script src="/assets/app.js" defer></script>');
  return $.html();
}

function htmlError(status, title, message, detail) {
  const safeTitle = htmlEscape(title);
  const safeMessage = htmlEscape(message);
  const safeDetail = detail ? `<p class="detail">${htmlEscape(detail)}</p>` : '';
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle} - Yubikiri Proxy</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:linear-gradient(135deg,#1a1a1a,#2d2d2d);color:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.box{text-align:center}.box h1{font-size:24px;font-weight:600}.box p{color:#bbb;font-size:14px}.box .detail{margin-top:10px;color:#8f8f8f;font-size:12px;max-width:560px}.box a{display:inline-block;margin-top:14px;padding:11px 20px;border-radius:7px;background:#b7b7b7;color:#1a1a1a;font-size:14px;font-weight:600;text-decoration:none}.version{position:fixed;right:16px;bottom:12px;color:#777;font-size:10px}</style><main class="box"><h1>${safeTitle}</h1><p>${safeMessage}</p>${safeDetail}<a href="/">戻る</a></main><span class="version">Beta 1</span></html>`;
}

function upstreamErrorHint(error) {
  if (error.message === 'UPSTREAM_TIMEOUT') return '接続先が30秒以内に応答しませんでした（UPSTREAM_TIMEOUT）。';
  const code = String(error.code || '');
  switch (code) {
    case '': return '';
    case 'TARGET_BLOCKED': case 'UPLOAD_LIMIT': return '';
    case 'ECONNRESET': return '接続が途中で切断されました（ECONNRESET）。経路上の装置が通信を切断した可能性があります。';
    case 'EPIPE': return '接続が途中で切断されました（EPIPE）。';
    case 'DNS_LOOKUP_FAILED': case 'ENOTFOUND': case 'EAI_AGAIN': return `ドメイン名を解決できませんでした（${code}）。DNSの名前解決がブロックされている可能性があります。`;
    case 'ECONNREFUSED': return '接続を拒否されました（ECONNREFUSED）。';
    case 'EACCES': case 'EPERM': return `この環境からの通信が許可されていません（${code}）。`;
    default:
      if (/CERT|SSL|TLS/i.test(code)) return `TLSの検証で失敗しました（${code}）。`;
      return `エラーコード: ${code}`;
  }
}

function isHopByHop(name, connectionTokens) {
  return new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', ...connectionTokens]).has(name.toLowerCase());
}

function proxyReferer(value) {
  if (!value) return undefined;
  try {
    const referer = new URL(value);
    const appToken = referer.searchParams.get('__y');
    if (typeof appToken === 'string' && /^[A-Za-z0-9_-]+$/.test(appToken)) {
      const origin = decodeOrigin(appToken);
      const search = new URLSearchParams(referer.search);
      search.delete('__y');
      const query = search.toString();
      return new URL(`${referer.pathname}${query ? `?${query}` : ''}`, origin).href;
    }
    const match = referer.pathname.match(/^\/proxy\/([A-Za-z0-9_-]+)(\/.*)?$/);
    if (!match) return undefined;
    const origin = decodeOrigin(match[1]);
    return new URL(match[2] || '/', origin).href;
  } catch {
    return undefined;
  }
}

function scopedSetCookie(value, token, target, clientSecure) {
  const segments = value.split(';');
  const first = segments.shift();
  let path = new URL('.', target).pathname;
  const attributes = [];
  for (const segment of segments) {
    const trimmed = segment.trim();
    const equals = trimmed.indexOf('=');
    const key = (equals < 0 ? trimmed : trimmed.slice(0, equals)).toLowerCase();
    if (key === 'domain') continue;
    if (key === 'secure' && !clientSecure) continue;
    if (key === 'samesite' && !clientSecure && equals >= 0 && /^none$/i.test(trimmed.slice(equals + 1).trim())) continue;
    if (key === 'path') {
      path = equals < 0 ? '/' : trimmed.slice(equals + 1);
      continue;
    }
    attributes.push(trimmed);
  }
  if (!path.startsWith('/')) path = `/${path}`;
  return [first, `Path=/proxy/${token}${path}`, ...attributes].filter(Boolean).join('; ');
}

function decodeResponse(stream, encoding) {
  switch ((encoding || '').toLowerCase()) {
    case 'gzip': return stream.pipe(zlib.createGunzip());
    case 'deflate': return stream.pipe(zlib.createInflate());
    case 'br': return stream.pipe(zlib.createBrotliDecompress());
    default: return stream;
  }
}

async function readLimited(stream, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('REWRITE_LIMIT'), { code: 'REWRITE_LIMIT' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function withTransformSlot() {
  return new Promise((resolve) => {
    const acquire = () => {
      if (activeTransforms < MAX_TRANSFORMS) {
        activeTransforms++;
        resolve(() => { activeTransforms--; });
      } else {
        setTimeout(acquire, 25).unref();
      }
    };
    acquire();
  });
}

function encodingFrom(contentType) {
  const match = String(contentType || '').match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  const requested = match?.[1]?.trim();
  return requested && iconv.encodingExists(requested) ? requested : 'utf-8';
}

function createPinnedLookup(addresses) {
  // Prefer IPv4 when both families are available. Some low-cost hosts expose
  // IPv6 DNS records before IPv4 but do not provide a working IPv6 egress path.
  // Keep IPv6 as a fallback for IPv6-only origins.
  const ordered = [...addresses].sort((left, right) => left.family - right.family);
  let cursor = 0;
  return (_hostname, options, callback) => {
    if (options?.all) return callback(null, ordered);
    const selected = ordered[cursor++ % ordered.length];
    callback(null, selected.address, selected.family);
  };
}

// Buffer a request body so it can travel inside an agent job descriptor.
// Resolves null only when the client disconnected; throws UPLOAD_LIMIT past
// the configured cap (the caller's generic error path answers 413).
function readRequestBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        req.removeAllListeners('data');
        req.destroy();
        reject(Object.assign(new Error('UPLOAD_LIMIT'), { code: 'UPLOAD_LIMIT' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Hand the upstream fetch to the PC agent. Returns a Readable carrying
// statusCode/headers on success, or null when the caller must fall back to
// its own direct upstream connection.
async function dispatchToAgent(agentHub, req, target, requestHeaders, hasBody) {
  const headers = { ...requestHeaders };
  delete headers['transfer-encoding'];
  let bodyBase64;
  if (hasBody) {
    const body = await readRequestBody(req, MAX_UPLOAD_BYTES);
    headers['content-length'] = String(body.length);
    bodyBase64 = body.toString('base64');
  }
  try {
    const outcome = await agentHub.dispatch({ method: req.method, url: target.href, headers, bodyBase64 });
    if (outcome) console.log(`[agent] via PC: ${req.method} ${target.href}`);
    return outcome;
  } catch {
    return null;
  }
}

function createProxyRouter({ agentHub } = {}) {
  const router = express.Router({ mergeParams: true });
  const handler = async (req, res) => {
    if (activeRequests >= MAX_ACTIVE_REQUESTS) {
      res.status(503).setHeader('Retry-After', '3');
      res.type('html').send(htmlError(503, 'しばらく待ってからお試しください', '接続が混み合っています'));
      return;
    }
    activeRequests++;
    let remoteRequest;
    let remoteResponse;
    try {
      const origin = decodeOrigin(req.params.origin);
      const suffix = req.url || '/';
      let target;
      try { target = new URL(suffix, origin); } catch { throw blockedTarget(); }
      if (target.origin !== origin.origin || target.username || target.password) throw blockedTarget();
      const addresses = await resolvePublicAddresses(target.hostname);
      const transport = target.protocol === 'https:' ? https : http;
      const requestHeaders = {};
      const connectionTokens = String(req.headers.connection || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || name === 'host' || name === 'origin' || name === 'referer' || name === 'accept-encoding' || isHopByHop(name, connectionTokens)) continue;
        requestHeaders[name] = value;
      }
      requestHeaders.host = target.host;
      requestHeaders['accept-encoding'] = 'gzip, deflate, br';
      if (req.headers.origin) requestHeaders.origin = origin.origin;
      const referer = proxyReferer(req.headers.referer);
      if (referer) requestHeaders.referer = referer;

      if (Number(req.headers['content-length']) > MAX_UPLOAD_BYTES) {
        res.status(413).type('html').send(htmlError(413, '送信データが大きすぎます', 'ファイルのサイズを小さくしてください'));
        return;
      }

      const options = {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.protocol === 'https:' ? 443 : 80,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: requestHeaders,
        lookup: createPinnedLookup(addresses),
        servername: net.isIP(target.hostname.replace(/^\[|\]$/g, '')) ? undefined : target.hostname,
        agent: target.protocol === 'https:' ? https.globalAgent : http.globalAgent,
      };
      const hasBody = !['GET', 'HEAD'].includes(req.method) && (Number(req.headers['content-length']) > 0 || Boolean(req.headers['transfer-encoding']));

      // When the user's PC agent is connected, fetch through it; the PC's
      // network path is usually faster than the Render instance's.
      if (agentHub && agentHub.isActive()) {
        const viaAgent = await dispatchToAgent(agentHub, req, target, requestHeaders, hasBody);
        if (viaAgent) {
          remoteResponse = viaAgent;
          await sendResponse(remoteResponse, res, req, target, req.params.origin);
          return;
        }
      }

      res.on('close', () => { if (!res.writableEnded) remoteRequest?.destroy(); });
      // Filtering gateways and CDNs occasionally drop the first connection of
      // a session. One silent retry for bodiless requests keeps those sites
      // usable without masking real failures.
      const sendUpstream = async () => {
        const attempt = transport.request(options);
        remoteRequest = attempt;
        attempt.setTimeout(30_000, () => attempt.destroy(new Error('UPSTREAM_TIMEOUT')));
        const responsePromise = new Promise((resolve, reject) => {
          attempt.once('response', resolve);
          attempt.once('error', reject);
        });
        if (hasBody) {
          let uploaded = 0;
          const limiter = new Transform({
            transform(chunk, _encoding, callback) {
              uploaded += chunk.length;
              if (uploaded > MAX_UPLOAD_BYTES) callback(Object.assign(new Error('UPLOAD_LIMIT'), { code: 'UPLOAD_LIMIT' }));
              else callback(null, chunk);
            },
          });
          pipeline(req, limiter, attempt, (error) => {
            if (error && !res.headersSent) {
              attempt.destroy();
              const tooLarge = error.code === 'UPLOAD_LIMIT';
              res.status(tooLarge ? 413 : 400).type('html').send(htmlError(tooLarge ? 413 : 400, tooLarge ? '送信データが大きすぎます' : 'リクエストを送信できませんでした', tooLarge ? 'ファイルのサイズを小さくしてください' : 'もう一度お試しください'));
            }
          });
        } else {
          attempt.end();
        }
        return responsePromise;
      };
      try {
        remoteResponse = await sendUpstream();
      } catch (error) {
        const transient = !hasBody && !res.writableEnded && ['ECONNRESET', 'EPIPE'].includes(error.code);
        if (!transient) throw error;
        remoteResponse = await sendUpstream();
      }
      await sendResponse(remoteResponse, res, req, target, req.params.origin);
    } catch (error) {
      const targetHref = (() => { try { return target?.href; } catch { return req.originalUrl; } })();
      console.error(`[proxy] ${req.method} ${targetHref}: ${error.code || ''} ${error.message}`);
      if (res.headersSent) {
        res.destroy();
      } else {
        const status = error.code === 'TARGET_BLOCKED' ? 403 : error.code === 'UPLOAD_LIMIT' ? 413 : 502;
        const title = status === 403 ? 'この接続先にはアクセスできません' : status === 413 ? '送信データが大きすぎます' : 'ページを読み込めませんでした';
        const message = error.publicMessage || (error.message === 'UPSTREAM_TIMEOUT' ? '接続が時間切れになりました' : '接続先から応答がありませんでした');
        res.status(status).type('html').send(htmlError(status, title, message, upstreamErrorHint(error)));
      }
    } finally {
      remoteResponse?.resume();
      activeRequests--;
    }
  };

  router.all('/', handler);
  router.all('*', handler);
  return router;
}

async function sendResponse(upstream, res, req, target, token) {
  const status = upstream.statusCode || 502;
  const contentType = String(upstream.headers['content-type'] || 'application/octet-stream');
  const html = /(?:text\/html|application\/xhtml\+xml)/i.test(contentType);
  const css = /text\/css/i.test(contentType);
  const rewrite = html || css;
  const connectionTokens = String(upstream.headers.connection || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  const headers = upstream.headers;

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name === 'set-cookie' || name === 'location' || name === 'refresh' || name === 'referrer-policy' || isHopByHop(name, connectionTokens)) continue;
    if (name === 'content-security-policy' || name === 'content-security-policy-report-only' || name === 'x-content-security-policy' || name === 'x-webkit-csp') continue;
    if (rewrite && ['content-length', 'content-encoding', 'etag', 'last-modified', 'content-md5'].includes(name)) continue;
    if (name.startsWith('access-control-') || name === 'cross-origin-resource-policy' || name === 'cross-origin-opener-policy' || name === 'cross-origin-embedder-policy') continue;
    res.setHeader(name, value);
  }
  if (Array.isArray(headers['set-cookie'])) res.setHeader('set-cookie', headers['set-cookie'].map((cookie) => scopedSetCookie(cookie, token, target, req.protocol === 'https')));
  res.setHeader('Referrer-Policy', 'same-origin');
  if (headers.location) {
    try {
      const destination = new URL(headers.location, target);
      res.setHeader('Location', ['http:', 'https:'].includes(destination.protocol) ? encodeProxyUrl(destination) : headers.location);
    } catch { res.setHeader('Location', headers.location); }
  }
  if (headers.refresh) {
    const refresh = String(headers.refresh).replace(/(url\s*=\s*["']?)([^"';]+)(["']?)/i, (match, before, value, after) => `${before}${urlForPage(value.trim(), target)}${after}`);
    res.setHeader('Refresh', refresh);
  }
  res.setHeader('Cache-Control', html || headers['set-cookie'] ? 'private, no-store' : 'private, max-age=180');
  res.status(status);

  if (req.method === 'HEAD' || status === 204 || status === 304) {
    upstream.resume();
    res.end();
    return;
  }

  if (rewrite) {
    upstream.pause();
    const release = await withTransformSlot();
    try {
      const limit = html ? MAX_HTML_BYTES : MAX_CSS_BYTES;
      const decoded = decodeResponse(upstream, headers['content-encoding']);
      const body = await readLimited(decoded, limit);
      const charset = encodingFrom(contentType);
      const source = iconv.decode(body, charset);
      const output = html ? rewriteHtml(source, target, token) : rewriteCss(source, target);
      const encoded = iconv.encode(output, charset);
      res.setHeader('content-type', contentType);
      res.setHeader('content-length', encoded.length);
      res.end(encoded);
    } catch (error) {
      upstream.destroy();
      if (!res.headersSent) {
        const tooLarge = error.code === 'REWRITE_LIMIT';
        res.status(tooLarge ? 502 : 502).type('html').send(htmlError(502, 'ページを表示できませんでした', tooLarge ? 'このページのデータが大きすぎます' : 'ページの文字コードを読み取れませんでした'));
      } else {
        res.destroy(error);
      }
    } finally {
      release();
    }
    return;
  }

  res.setHeader('content-type', contentType);
  await new Promise((resolve) => {
    pipeline(upstream, res, (error) => {
      if (error && !res.destroyed) res.destroy(error);
      resolve();
    });
  });
}

function writeRawHttpResponse(socket, statusCode, statusMessage, rawHeaders = []) {
  if (socket.destroyed) return;
  const headers = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    headers.push(`${rawHeaders[index]}: ${rawHeaders[index + 1]}`);
  }
  socket.write(`HTTP/1.1 ${statusCode} ${statusMessage || ''}\r\n${headers.join('\r\n')}\r\n\r\n`);
}

async function handleWebSocketUpgrade(req, clientSocket, clientHead) {
  const reject = (status, message) => {
    if (!clientSocket.destroyed) {
      clientSocket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  };
  if (activeWebSockets >= MAX_ACTIVE_WEBSOCKETS) {
    reject(503, 'Service Unavailable');
    return;
  }

  activeWebSockets++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeWebSockets--;
  };
  let remoteRequest;
  let remoteSocket;

  try {
    if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !req.headers['sec-websocket-key']) {
      reject(400, 'Bad Request');
      release();
      return;
    }
    const incoming = new URL(req.url || '/', 'http://localhost');
    const match = incoming.pathname.match(/^\/proxy\/([A-Za-z0-9_-]+)(\/.*)?$/);
    if (!match) {
      reject(404, 'Not Found');
      release();
      return;
    }
    const origin = decodeOrigin(match[1]);
    const target = new URL(`${match[2] || '/'}${incoming.search}`, origin);
    if (target.origin !== origin.origin || target.username || target.password || target.port) throw blockedTarget();

    const addresses = await resolvePublicAddresses(target.hostname);
    const requestHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || ['host', 'origin', 'referer', 'connection', 'upgrade'].includes(name.toLowerCase())) continue;
      requestHeaders[name] = value;
    }
    requestHeaders.host = target.host;
    requestHeaders.connection = 'Upgrade';
    requestHeaders.upgrade = 'websocket';
    if (req.headers.origin) requestHeaders.origin = origin.origin;
    const referer = proxyReferer(req.headers.referer);
    if (referer) requestHeaders.referer = referer;

    const transport = target.protocol === 'https:' ? https : http;
    remoteRequest = transport.request({
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.protocol === 'https:' ? 443 : 80,
      method: 'GET',
      path: `${target.pathname}${target.search}`,
      headers: requestHeaders,
      lookup: createPinnedLookup(addresses),
      servername: net.isIP(target.hostname.replace(/^\[|\]$/g, '')) ? undefined : target.hostname,
    });
    remoteRequest.once('upgrade', (response, upstreamSocket, upstreamHead) => {
      remoteSocket = upstreamSocket;
      writeRawHttpResponse(clientSocket, response.statusCode || 101, response.statusMessage || 'Switching Protocols', response.rawHeaders);
      if (upstreamHead.length) clientSocket.write(upstreamHead);
      if (clientHead?.length) upstreamSocket.write(clientHead);
      clientSocket.on('error', () => upstreamSocket.destroy());
      upstreamSocket.on('error', () => clientSocket.destroy());
      clientSocket.on('close', () => { release(); upstreamSocket.destroy(); });
      upstreamSocket.on('close', () => { release(); clientSocket.destroy(); });
      clientSocket.pipe(upstreamSocket).pipe(clientSocket);
    });
    remoteRequest.once('response', (response) => {
      writeRawHttpResponse(clientSocket, response.statusCode || 502, response.statusMessage, response.rawHeaders);
      response.on('end', release);
      response.on('error', () => { release(); clientSocket.destroy(); });
      response.pipe(clientSocket);
    });
    remoteRequest.once('error', (error) => {
      if (!clientSocket.destroyed && !remoteSocket) {
        reject(error.code === 'TARGET_BLOCKED' ? 403 : 502, error.code === 'TARGET_BLOCKED' ? 'Forbidden' : 'Bad Gateway');
      }
      release();
    });
    clientSocket.once('close', () => { release(); remoteRequest.destroy(); });
    remoteRequest.end();
  } catch (error) {
    if (!clientSocket.destroyed) {
      reject(error.code === 'TARGET_BLOCKED' ? 403 : 502, error.code === 'TARGET_BLOCKED' ? 'Forbidden' : 'Bad Gateway');
    }
    remoteSocket?.destroy();
    remoteRequest?.destroy();
    release();
  }
}

module.exports = { createProxyRouter, encodeProxyUrl, handleWebSocketUpgrade, validateTarget, htmlEscape, rewriteHtml, rewriteCss };
