export const viewerHtml = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>LinkRPC Desktop</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{margin:0;width:100%;height:100%;background:#181818;color:#ddd;font:14px system-ui}
body{display:flex;flex-direction:column}header{display:flex;gap:16px;align-items:center;padding:8px 12px}
#desktop{flex:1;min-height:0}button{font:inherit}#status{flex:1}canvas{image-rendering:pixelated}
button:focus-visible{outline:2px solid Highlight;outline-offset:2px}
</style>
<header><strong>LinkRPC Desktop</strong><span id="status" role="status">Connecting…</span><button id="disconnect">Disconnect</button></header>
<main id="desktop" aria-label="Remote Desktop" aria-description="Remote pixels are not readable by screen readers. Press Control Alt Escape to return keyboard focus to Disconnect."></main><script type="module" src="./viewer.js"></script></html>`;

export const viewerScript = `
import { connectDesktop, createViewerClient } from './browser.js';
import RFB from './novnc/core/rfb.js';
const target = document.getElementById('desktop');
const status = document.getElementById('status');
const abort = new AbortController();
const viewport = () => ({
  width: Math.max(32, Math.round(target.clientWidth)),
  height: Math.max(32, Math.round(target.clientHeight)),
  devicePixelRatio,
});
let connection, rfb, observer, media, resizeTimer, changedDpr;
const stop = () => { abort.abort(); connection?.close(); rfb?.disconnect(); observer?.disconnect(); clearTimeout(resizeTimer); media?.removeEventListener('change', changedDpr); };
document.getElementById('disconnect').onclick = () => { status.textContent = 'Disconnected'; stop(); };
addEventListener('pagehide', stop, {once:true});
addEventListener('keydown', event => {
  if (event.ctrlKey && event.altKey && event.code === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    rfb?.blur();
    document.getElementById('disconnect').focus();
  }
}, {capture:true});
try {
  const client = await createViewerClient(new URL('./control', location.href).href.replace('http:', 'ws:'), abort.signal);
  const info = await client.info({params:{}});
  document.title = info.title + ' — LinkRPC Desktop';
  connection = await connectDesktop(client, {}, viewport(), {signal:abort.signal});
  rfb = new RFB(target, connection.channel);
  rfb.scaleViewport = true;
  rfb.resizeSession = true;
  rfb.addEventListener('connect', () => { status.textContent = 'Connected · Lossless WebRTC'; });
  rfb.addEventListener('disconnect', () => { if (!abort.signal.aborted) { status.textContent = 'Disconnected'; stop(); } });
  rfb.addEventListener('credentialsrequired', () => { status.textContent = 'This source requires unsupported VNC credentials'; stop(); });
  const resize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      connection.setViewport(viewport()).catch(error => { status.textContent = error.message; stop(); });
      // The DPI media event may not change the CSS container size.
      rfb._requestRemoteResize();
    }, 150);
  };
  const watchDpr = () => {
    media?.removeEventListener('change', changedDpr);
    media = matchMedia('(resolution: ' + devicePixelRatio + 'dppx)');
    media.addEventListener('change', changedDpr);
  };
  changedDpr = () => { watchDpr(); resize(); };
  watchDpr();
  observer = new ResizeObserver(resize);
  observer.observe(target);
  await connection.done;
  status.textContent = 'Disconnected';
} catch(error) {
  if (!abort.signal.aborted) status.textContent = error.message;
} finally {
  stop();
}
`;
