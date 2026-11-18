'use strict';

// The relay receives ciphertext only. The room key stays in the URL fragment.
class HttpsBridge {
  static MAX = 100000;
  static RELAY = 'https://ntfy.sh';
  constructor({ room, secret, joining, onStatus = () => {}, onNotice = () => {}, onText = () => {} }) {
    if (![room, secret].every(value => /^[a-f0-9]{32}$/.test(value))) throw new Error('Некорректная ссылка моста.');
    Object.assign(this, { room, secret, joining, onStatus, onNotice, onText });
    this.self = HttpsBridge.random(); this.cursor = 'all'; this.closed = false;
    this.online = false; this.partner = null; this.pending = new Map(); this.challenges = new Map();
    this.seen = new Set(); this.received = new Set(); this.controllers = new Set();
    this.sendQueue = Promise.resolve(); this.receiveQueue = Promise.resolve();
  }
  static random() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join(''); }
  static base64(bytes) {
    let result = '';
    for (let i = 0; i < bytes.length; i += 32768) result += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(result);
  }
  static unbase64(value) { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
  get ready() { return !!this.partner && this.online && !this.closed; }
  _status() {
    if (this.closed) return;
    this.onStatus(this.ready ? 'Устройства соединены · HTTPS' : this.online ? (this.joining ? 'Ищем первое устройство…' : 'Ждём второе устройство · HTTPS') : 'Восстанавливаем HTTPS-связь…', this.ready);
  }
  async start() {
    const hex = value => Uint8Array.from(value.match(/../g), pair => parseInt(pair, 16));
    const material = await crypto.subtle.importKey('raw', hex(this.secret), 'HKDF', false, ['deriveKey']);
    this.key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: hex(this.room), info: new TextEncoder().encode('clipboard-bridge-https-v1') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    if (this.closed) return;
    this.url = HttpsBridge.RELAY + '/clipboard-bridge-' + this.room;
    if (typeof EventSource === 'function') {
      this.source = new EventSource(this.url + '/sse?since=all');
      // Wait for ntfy's actual open event: proxies can buffer a streaming body.
      this.source.addEventListener('open', event => { if (event.data) { clearTimeout(this.streamTimer); this._online(); } });
      this.source.onmessage = event => { try { this._event(JSON.parse(event.data)); } catch {} };
      this.source.onerror = () => this._fallback();
      this.streamTimer = setTimeout(() => this._fallback(), 8000);
    } else this._fallback();
  }
  _online() {
    if (this.closed) return;
    this.online = true; this._status();
    if (!this.helloSent && this.joining) {
      this.helloSent = true;
      this._send({ type: 'hello' }).catch(error => { this.helloSent = false; this._error(error); });
    }
  }
  _fallback() {
    if (this.closed || this.polling) return;
    this.polling = true; clearTimeout(this.streamTimer); this.source?.close();
    this.onNotice('Режим HTTPS: если сеть задерживает поток, проверяем сообщения каждые 15 секунд.');
    this._poll();
  }
  async _request(url, options = {}) {
    if (this.closed) throw new Error('Мост закрыт.');
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error' });
      if (!response.ok) throw new Error(response.status === 429 ? 'Достигнут лимит HTTPS-сервиса. Подождите минуту и повторите попытку.' : 'HTTPS-сервис недоступен (' + response.status + ').');
      if (Number(response.headers.get('content-length')) > 1000000) throw new Error('Ответ сервера слишком большой.');
      const text = await response.text();
      if (text.length > 1000000) throw new Error('Ответ сервера слишком большой.');
      return text;
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  async _poll() {
    if (this.closed || this.pollBusy) return;
    this.pollBusy = true; let delay = 15000;
    try {
      const text = await this._request(this.url + '/json?poll=1&since=' + encodeURIComponent(this.cursor));
      if (this.closed) return;
      this._online();
      for (const line of text.split('\n')) { if (line.trim()) { try { this._event(JSON.parse(line)); } catch {} } }
    } catch (error) { delay = 60000; this._error(error); }
    finally { this.pollBusy = false; if (!this.closed) this.pollTimer = setTimeout(() => this._poll(), delay); }
  }
  _error(error) {
    if (this.closed) return;
    this.online = false; this._status();
    this.onNotice(error.message || 'Не удалось связаться с HTTPS-сервисом. Повторите подключение.');
  }
  async _encrypt(message) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(JSON.stringify({ v: 1, from: this.self, ...message }));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(this.room) }, this.key, data);
    return JSON.stringify({ v: 1, iv: HttpsBridge.base64(iv), data: HttpsBridge.base64(new Uint8Array(encrypted)) });
  }
  async _decrypt(text) {
    if (text.length > 1000000) return null;
    const packet = JSON.parse(text);
    if (packet.v !== 1 || typeof packet.iv !== 'string' || typeof packet.data !== 'string' || packet.iv.length !== 16) return null;
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: HttpsBridge.unbase64(packet.iv), additionalData: new TextEncoder().encode(this.room) }, this.key, HttpsBridge.unbase64(packet.data));
    return JSON.parse(new TextDecoder().decode(decrypted));
  }
  _send(message) {
    const operation = this.sendQueue.then(async () => {
      if (this.closed) return;
      const body = await this._encrypt(message);
      if (this.closed) return;
      // Bigger ciphertext uses one attachment instead of many notification chunks.
      const suffix = body.length > 4000 ? '&filename=clipboard-bridge.bin' : '';
      await this._request(this.url + '?firebase=no' + suffix, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body });
    });
    this.sendQueue = operation.catch(() => {}); return operation;
  }
  _event(event) {
    if (this.closed || event.event !== 'message' || typeof event.id !== 'string' || this.seen.has(event.id)) return;
    this.cursor = event.id; this.seen.add(event.id);
    if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value);
    this.receiveQueue = this.receiveQueue.then(async () => {
      if (this.closed) return;
      let text = event.message;
      if (event.attachment) {
        const url = new URL(event.attachment.url);
        if (url.origin !== HttpsBridge.RELAY || !/^\/file\/[A-Za-z0-9]+\.(bin|txt|json)$/.test(url.pathname) || url.search || event.attachment.size > 1000000) return;
        text = await this._request(url.href);
      }
      let message;
      try { message = await this._decrypt(typeof text === 'string' ? text : ''); } catch { return; }
      if (!this.closed) await this._message(message);
    }).catch(error => this._error(error));
  }
  async _message(message) {
    if (!message || message.v !== 1 || !/^[a-f0-9]{32}$/.test(message.from) || message.from === this.self) return;
    if (message.to && message.to !== this.self) return;
    if (!this.joining && message.type === 'hello') {
      if (this.partner && this.partner !== message.from) return;
      if (!this.challenges.has(message.from)) {
        if (this.challenges.size >= 8) this.challenges.delete(this.challenges.keys().next().value);
        this.challenges.set(message.from, HttpsBridge.random());
      }
      await this._send({ type: 'welcome', to: message.from, challenge: this.challenges.get(message.from) }); return;
    }
    if (this.joining && message.type === 'welcome' && message.to === this.self && /^[a-f0-9]{32}$/.test(message.challenge)) {
      if (this.partner && this.partner !== message.from) return;
      this.offeredPartner = message.from; this.challenge = message.challenge;
      await this._send({ type: 'confirm', to: message.from, challenge: message.challenge }); return;
    }
    if (!this.joining && message.type === 'confirm' && message.to === this.self && this.challenges.has(message.from) && message.challenge === this.challenges.get(message.from)) {
      if (this.partner && this.partner !== message.from) return;
      this.partner = message.from; this._status();
      await this._send({ type: 'ready', to: message.from, challenge: message.challenge });
      this.onNotice('Мост готов через HTTPS. Можно отправлять текст в обе стороны.'); return;
    }
    if (this.joining && message.type === 'ready' && message.to === this.self && message.from === this.offeredPartner && message.challenge === this.challenge) {
      this.partner = message.from; this._status(); this.onNotice('Мост готов через HTTPS. Можно отправлять текст в обе стороны.'); return;
    }
    if (message.from !== this.partner || message.to !== this.self) return;
    if (message.type === 'text' && typeof message.text === 'string' && message.text.length <= HttpsBridge.MAX && /^[a-f0-9]{32}$/.test(message.id)) {
      if (!this.received.has(message.id)) {
        this.received.add(message.id); if (this.received.size > 512) this.received.delete(this.received.values().next().value);
        this.onText(message.text); this.onNotice('Получен новый текст. Нажмите «Скопировать».');
      }
      await this._send({ type: 'ack', to: message.from, id: message.id });
    } else if (message.type === 'ack' && this.pending.has(message.id)) {
      clearTimeout(this.pending.get(message.id)); this.pending.delete(message.id); this.onNotice('Доставлено на второе устройство.');
    }
  }
  async sendText(text) {
    if (!this.ready) throw new Error('Сначала соедините устройства.');
    if (typeof text !== 'string' || !text.length || text.length > HttpsBridge.MAX) throw new Error('Можно отправить от 1 до 100 000 символов.');
    if (this.pending.size >= 10) throw new Error('Подождите подтверждения предыдущих сообщений.');
    const id = HttpsBridge.random();
    this.pending.set(id, setTimeout(() => { this.pending.delete(id); if (!this.closed) this.onNotice('Нет подтверждения доставки. Проверьте, что обе страницы открыты, и повторите отправку.'); }, 90000));
    try { await this._send({ type: 'text', to: this.partner, id, text }); }
    catch (error) { clearTimeout(this.pending.get(id)); this.pending.delete(id); throw error; }
  }
  close() {
    this.closed = true; this.source?.close(); clearTimeout(this.streamTimer); clearTimeout(this.pollTimer);
    for (const controller of this.controllers) controller.abort();
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear(); this.key = null; this.secret = null;
  }
}

function startHttpsBridge() {
  const el = id => document.getElementById(id);
  let bridge, active = false, room, secret, sending = false, version = 0;
  const notice = text => { el('notice').textContent = text; };
  const updateSend = () => { el('send').disabled = !bridge?.ready || sending || !el('outgoing').value.length; };
  el('connection-mode').textContent = 'HTTPS · сквозное шифрование';
  el('compat-mode').textContent = 'Обычный режим WebRTC'; el('compat-mode').href = './';
  el('privacy-note').textContent = 'Режим HTTPS использует ntfy.sh. Текст шифруется в браузере; ключ остаётся в ссылке. Сервис временно хранит зашифрованные данные: сообщения до 12 часов, длинные вложения до 3 часов. Действуют лимиты сервиса. Если сеть задерживает поток, доставка может занять до 30 секунд.';
  const parts = location.hash.slice(1).split('.');
  let joining = parts.length === 2 && parts.every(part => /^[a-f0-9]{32}$/.test(part));
  if (joining) { [room, secret] = parts; el('connect').textContent = 'Подключиться через HTTPS'; }
  else el('connect').textContent = 'Создать мост через HTTPS';
  el('instructions').textContent = joining ? 'Подключитесь к первому устройству. Обе страницы должны оставаться открытыми.' : 'Создайте HTTPS-мост и откройте новую ссылку на втором устройстве. Этот режим работает без WebRTC.';
  async function start() {
    const current = ++version; bridge?.close();
    if (!joining && !active) { room = HttpsBridge.random(); secret = HttpsBridge.random(); active = true; }
    el('connect').disabled = true; el('connect').hidden = false;
    if (!joining) {
      el('room-link').value = location.href.split('#')[0] + '#' + room + '.' + secret;
      el('invite').hidden = false; el('copy-link').hidden = false;
    }
    el('new-room').hidden = false;
    el('status').textContent = 'Подключаемся через HTTPS…'; updateSend();
    bridge = new HttpsBridge({ room, secret, joining,
      onStatus: (text, connected) => {
        if (version !== current) return;
        el('status').textContent = text; el('status').classList.toggle('connected', connected);
        el('connect').disabled = false; el('connect').hidden = connected || (bridge.online && !joining);
        el('connect').textContent = 'Повторить подключение через HTTPS'; updateSend();
      },
      onNotice: text => { if (version === current) notice(text); },
      onText: text => {
        if (version !== current) return;
        el('incoming').value = text; el('incoming').hidden = false; el('empty').hidden = true;
        el('copy-text').disabled = false; el('clear').disabled = false;
        el('received-time').textContent = 'Получено в ' + new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      }
    });
    updateSend();
    try { await bridge.start(); }
    catch { if (version === current) { el('connect').disabled = false; notice('Не удалось запустить защищённый HTTPS-мост. Обновите браузер и повторите попытку.'); } }
  }
  async function copy(text, field) {
    try { await navigator.clipboard.writeText(text); notice('Скопировано в буфер обмена.'); }
    catch { field.focus(); field.select(); notice('Скопируйте выделенный текст вручную.'); }
  }
  el('connect').onclick = start;
  el('copy-link').onclick = () => copy(el('room-link').value, el('room-link'));
  el('new-room').onclick = () => { history.replaceState(null, '', location.href.split('#')[0]); active = false; joining = false; el('invite').hidden = true; el('copy-link').hidden = true; start(); };
  el('outgoing').oninput = () => { el('count').textContent = el('outgoing').value.length.toLocaleString('ru-RU') + ' / 100 000'; updateSend(); };
  el('paste').onclick = async () => {
    try { const text = await navigator.clipboard.readText(); el('outgoing').value = text.slice(0, HttpsBridge.MAX); el('outgoing').dispatchEvent(new Event('input')); notice('Текст вставлен. Нажмите «Отправить».'); }
    catch { el('outgoing').focus(); notice('Вставьте текст вручную в поле.'); }
  };
  el('send').onclick = async () => {
    if (!bridge?.ready || sending) return;
    sending = true; updateSend(); notice('Отправляем зашифрованный текст…');
    const current = version;
    try { await bridge.sendText(el('outgoing').value); }
    catch (error) { if (version === current) notice(error.message); }
    finally { sending = false; updateSend(); }
  };
  el('outgoing').onkeydown = event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); el('send').click(); } };
  el('copy-text').onclick = () => copy(el('incoming').value, el('incoming'));
  el('clear').onclick = () => { el('incoming').value = ''; el('incoming').hidden = true; el('empty').hidden = false; el('copy-text').disabled = true; el('clear').disabled = true; el('received-time').textContent = 'Ожидаем новое сообщение'; notice('Полученный текст очищен на этом устройстве.'); };
  window.addEventListener('beforeunload', () => bridge?.close());
  window.addEventListener('hashchange', () => location.reload());
}
if (typeof module !== 'undefined') module.exports = { HttpsBridge };
