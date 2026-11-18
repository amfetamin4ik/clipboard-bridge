const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');
const topics = new Map(), attachments = new Map(), posts = [];
let sequence = 0, rejectPost = false;
const fakeFetch = async (url, options = {}) => {
  const parsed = new URL(url), topic = parsed.pathname.split('/')[1];
  let body = '';
  if (options.method === 'POST') {
    if (rejectPost) return new Response('', { status: 429 });
    const event = { event: 'message', id: 'event' + ++sequence, message: options.body };
    posts.push(options.body);
    if (parsed.searchParams.has('filename')) {
      const path = '/file/file' + sequence + '.json'; attachments.set(path, options.body);
      event.attachment = { url: 'https://ntfy.sh' + path, size: options.body.length };
      event.message = 'Attachment';
    }
    if (!topics.has(topic)) topics.set(topic, []);
    topics.get(topic).push(event); body = JSON.stringify(event);
  } else if (topic === 'file') body = attachments.get(parsed.pathname) || '';
  else {
    const events = topics.get(topic) || [], since = parsed.searchParams.get('since');
    body = events.slice(since === 'all' ? 0 : events.findIndex(event => event.id === since) + 1).map(event => JSON.stringify(event)).join('\n');
  }
  return new Response(body, { status: 200 });
};
const timers = new Map(); let timerId = 0;
const sandbox = vm.createContext({ module: { exports: {} }, crypto: webcrypto, URL, TextEncoder, TextDecoder, Uint8Array, btoa, atob, AbortController, fetch: fakeFetch,
  setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); }
});
vm.runInContext(fs.readFileSync(__dirname + '/https-bridge.js', 'utf8'), sandbox);
const { HttpsBridge } = sandbox.module.exports;
async function drain(...peers) {
  for (let i = 0; i < 6; i++) {
    for (const peer of peers) { await peer.sendQueue; await peer.receiveQueue; await peer._poll(); }
  }
  for (const peer of peers) { await peer.sendQueue; await peer.receiveQueue; }
}
(async () => {
  const room = HttpsBridge.random(), secret = HttpsBridge.random();
  const receivedHost = [], receivedGuest = [], notices = [];
  const host = new HttpsBridge({ room, secret, joining: false, onText: text => receivedHost.push(text) });
  const guest = new HttpsBridge({ room, secret, joining: true, onText: text => receivedGuest.push(text), onNotice: text => notices.push(text) });
  await host.start(); await guest.start(); await drain(host, guest);
  assert(host.ready && guest.ready, 'fresh challenge/response pairs both devices');
  const text = '<script>alert(1)</script>\nПривет 👋';
  await host.sendText(text); await drain(host, guest);
  assert.equal(receivedGuest[0], text);
  assert.equal(host.pending.size, 0, 'receipt is acknowledged');
  assert(posts.every(body => !body.includes('Привет') && !body.includes(secret)), 'relay sees no plaintext or room key');
  const payload = 'Я\u0000👋'.repeat(25000); assert.equal(payload.length, 100000);
  await guest.sendText(payload); await drain(host, guest);
  assert.equal(receivedHost[0], payload); assert.equal(guest.pending.size, 0);
  assert(attachments.size > 0, 'long encrypted messages use an attachment');
  await assert.rejects(guest.sendText('x'.repeat(100001)), /100 000/);
  // Replaying an encrypted text under a different broker ID cannot show it twice.
  const events = topics.get('clipboard-bridge-' + room);
  const count = receivedGuest.length;
  for (const event of [...events]) guest._event({ ...event, id: 'replay' + event.id });
  await drain(host, guest); assert.equal(receivedGuest.length, count);
  // A client with the wrong key cannot authenticate or inject text.
  const wrong = new HttpsBridge({ room, secret: HttpsBridge.random(), joining: true });
  await wrong.start(); await drain(host, wrong); assert(!wrong.ready); wrong.close();
  // A confirm without a preceding challenge must not pair a fresh host.
  const isolated = new HttpsBridge({ room: HttpsBridge.random(), secret, joining: false }); await isolated.start();
  await isolated._message({ v: 1, from: HttpsBridge.random(), to: isolated.self, type: 'confirm' });
  assert(!isolated.partner); isolated.close();
  // Invalid ciphertext and untrusted attachment URLs are ignored.
  const previous = receivedHost.length;
  host._event({ event: 'message', id: 'invalid', message: '{"v":1,"iv":"AAAAAAAAAAAAAAAA","data":"invalid"}' });
  host._event({ event: 'message', id: 'external', attachment: { url: 'https://example.com/file/test.bin', size: 100 } });
  await host.receiveQueue; assert.equal(receivedHost.length, previous);
  rejectPost = true; await assert.rejects(guest.sendText('not sent'), /лимит/); rejectPost = false;
  assert.equal(guest.pending.size, 0, 'failed POST is not reported as delivered');
  host.close(); guest.close();
  // Reloading both pages changes session IDs; cached messages cannot become fresh messages.
  const reloadedHost = new HttpsBridge({ room, secret, joining: false, onText: () => assert.fail('old text replayed') });
  const reloadedGuest = new HttpsBridge({ room, secret, joining: true, onText: () => assert.fail('old text replayed') });
  await reloadedHost.start(); await reloadedGuest.start(); await drain(reloadedHost, reloadedGuest);
  assert(reloadedHost.ready && reloadedGuest.ready); reloadedHost.close(); reloadedGuest.close();
  console.log('PASS: HTTPS pairing, AES-GCM, bidirectional text, ACK, 100000 characters, attachments, replay protection, wrong keys, invalid packets, rate limits, reload');
})().catch(error => { console.error(error); process.exitCode = 1; });
