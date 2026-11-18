const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const registry = new Map();
class Channel extends EventEmitter {
  open = true;
  send(data) { queueMicrotask(() => this.other.emit('data', structuredClone(data))); }
  close() { this.open = false; this.emit('close'); }
}
class Peer extends EventEmitter {
  constructor(id = crypto.randomUUID()) { super(); this.id = id; registry.set(id, this); queueMicrotask(() => this.emit('open')); }
  connect(id) { const a = new Channel(), b = new Channel(); a.other = b; b.other = a; queueMicrotask(() => { registry.get(id).emit('connection', b); a.emit('open'); b.emit('open'); }); return a; }
  destroy() { registry.delete(this.id); this.destroyed = true; this.emit('close'); }
  reconnect() {}
}
const code = fs.readFileSync(__dirname + '/app.js', 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function page(hash = '') {
  const elements = new Map();
  const el = id => { if (!elements.has(id)) elements.set(id, { value: '', textContent: '', hidden: false, disabled: false, classList: {toggle() {}}, focus() {}, select() {}, click() { if (!this.disabled) this.onclick?.(); }, dispatchEvent() { this.oninput?.(); } }); return elements.get(id); };
  let timer = 0;
  const context = vm.createContext({ Peer, crypto, URLSearchParams, document: { getElementById: el }, location: { hash, href: 'https://example.com/' + hash }, history: {replaceState() {}}, navigator: { clipboard: {writeText: async () => {}, readText: async () => 'clipboard'} }, window: {addEventListener() {}}, setTimeout: () => ++timer, clearTimeout() {}, Event: class {} });
  vm.runInContext(code, context);
  return { el, context };
}
(async () => {
  const host = page(); host.el('connect').onclick(); await tick();
  const link = host.el('room-link').value;
  assert.match(link, /#[a-f0-9]{32}\.[a-f0-9]{32}$/);
  const guest = page(link.slice(link.indexOf('#'))); guest.el('connect').onclick(); await tick();
  assert.equal(host.el('status').textContent, 'Устройства соединены');
  assert.equal(guest.el('status').textContent, 'Устройства соединены');
  const payload = '<script>alert(1)</script>\nПривет 👋';
  host.el('outgoing').value = payload; host.el('send').onclick(); await tick();
  assert.equal(guest.el('incoming').value, payload);
  assert.equal(host.el('notice').textContent, 'Доставлено на второе устройство.');
  guest.el('outgoing').value = 'Ответ с телефона'; guest.el('send').onclick(); await tick();
  assert.equal(host.el('incoming').value, 'Ответ с телефона');
  guest.el('clear').onclick(); assert.equal(guest.el('incoming').value, '');
  const intruder = page(link.slice(link.indexOf('#')).replace(/.$/, link.endsWith('0') ? '1' : '0'));
  intruder.el('connect').onclick(); await tick();
  assert.notEqual(intruder.el('status').textContent, 'Устройства соединены');
  host.el('outgoing').value = 'x'.repeat(100001); host.el('send').onclick(); await tick();
  assert.equal(guest.el('incoming').value, '');
  host.el('outgoing').value = 'x'.repeat(100000); host.el('send').onclick(); await tick();
  assert.equal(guest.el('incoming').value.length, 100000);
  console.log('PASS: pairing, bidirectional text, delivery ACK, Unicode, inert HTML, invalid secret, size limits, clear');
})().catch(error => { console.error(error); process.exitCode = 1; });

