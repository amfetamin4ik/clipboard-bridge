'use strict';
(() => {
if (new URLSearchParams(location.search || '').get('mode') === 'https') { startHttpsBridge(); return; }
const $ = id => document.getElementById(id);
const MAX = 100000;
let peer, connection, active = false, ready = false, joining = false, room, secret, attempt = 0;
const pending = new Map();
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
function notice(text) { $('notice').textContent = text; }
function status(text, connected = false) { $('status').textContent = text; $('status').classList.toggle('connected', connected); }
function updateSend() { $('send').disabled = !ready || !$('outgoing').value.length; }
function disconnected(text) {
  ready = false; updateSend(); status(text); $('connect').hidden = false;
  $('connect').textContent = joining ? 'Повторить подключение' : 'Переподключить мост';
  if (pending.size) notice('Подтверждение не получено. Проверьте соединение и отправьте текст ещё раз.');
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
}
function bind(candidate, version) {
  let authenticated = false;
  const authTimer = setTimeout(() => { if (!authenticated) candidate.close(); }, 12000);
  candidate.on('open', () => {
    if (joining) candidate.send({ type: 'hello', secret });
  });
  candidate.on('data', msg => {
    if (version !== attempt || !msg || typeof msg !== 'object') return;
    if (!authenticated) {
      if ((!joining && msg.type === 'hello' && msg.secret === secret) || (joining && msg.type === 'welcome')) {
        if (ready && connection !== candidate) { candidate.close(); return; }
        authenticated = true; clearTimeout(authTimer); connection = candidate; ready = true;
        if (!joining) candidate.send({ type: 'welcome' });
        status('Устройства соединены', true); $('connect').hidden = true; updateSend();
        notice('Мост готов. Можно отправлять текст в обе стороны.');
      } else candidate.close();
      return;
    }
    if (msg.type === 'text' && typeof msg.text === 'string' && msg.text.length <= MAX && typeof msg.id === 'string' && msg.id.length <= 64) {
      $('incoming').value = msg.text; $('incoming').hidden = false; $('empty').hidden = true;
      $('copy-text').disabled = false; $('clear').disabled = false;
      $('received-time').textContent = 'Получено в ' + new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      candidate.send({ type: 'ack', id: msg.id }); notice('Получен новый текст. Нажмите «Скопировать».');
    } else if (msg.type === 'ack' && pending.has(msg.id)) {
      clearTimeout(pending.get(msg.id)); pending.delete(msg.id); notice('Доставлено на второе устройство.');
    }
  });
  const onClose = () => { clearTimeout(authTimer); if (version === attempt && connection === candidate) disconnected('Соединение закрыто'); };
  candidate.on('close', onClose); candidate.on('error', onClose);
}
function start() {
  if (typeof Peer === 'undefined') { notice('Не удалось загрузить модуль соединения. Обновите страницу и проверьте доступ к сайту.'); return; }
  const version = ++attempt;
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
  if (peer) peer.destroy(); connection = null; ready = false; updateSend();
  $('connect').disabled = true; status('Подключаемся…');
  const parts = location.hash.slice(1).split('.');
  joining = parts.length === 2 && parts.every(p => /^[a-f0-9]{32}$/.test(p));
  if (joining) [room, secret] = parts;
  else if (!active) { room = random(); secret = random(); active = true; }
  if (!joining) {
    $('room-link').value = location.href.split('#')[0] + '#' + room + '.' + secret;
    $('invite').hidden = false; $('copy-link').hidden = false;
  }
  $('new-room').hidden = false;
  peer = joining ? new Peer() : new Peer('clipboard-bridge-' + room);
  const current = peer;
  const connectTimer = setTimeout(() => {
    if (version === attempt && !ready) { $('connect').disabled = false; disconnected('Второе устройство не подключено'); notice('Откройте ссылку на втором устройстве. Если не подключается, повторите попытку или смените сеть.'); }
  }, 25000);
  peer.on('open', () => {
    if (version !== attempt) return;
    $('connect').disabled = false;
    if (joining) {
      status('Ищем первое устройство…');
      bind(current.connect('clipboard-bridge-' + room, { reliable: true }), version);
    } else {
      status('Ждём второе устройство'); $('connect').hidden = true;
      notice('Скопируйте ссылку и откройте её на другом устройстве.');
    }
  });
  peer.on('connection', candidate => {
    if (joining || version !== attempt) candidate.close(); else bind(candidate, version);
  });
  peer.on('error', error => {
    if (version !== attempt) return;
    clearTimeout(connectTimer); $('connect').disabled = false;
    disconnected('Не удалось подключиться');
    notice(error.type === 'peer-unavailable' ? 'Первое устройство недоступно. Оставьте его страницу открытой и повторите подключение.' : 'Ошибка соединения. Повторите попытку или попробуйте другую сеть.');
  });
  peer.on('disconnected', () => {
    if (version === attempt && !current.destroyed) { if (!ready) status('Восстанавливаем связь…'); current.reconnect(); }
  });
  peer.on('close', () => { clearTimeout(connectTimer); if (version === attempt) disconnected('Соединение закрыто'); });
}
async function copy(text, field) {
  try { await navigator.clipboard.writeText(text); notice('Скопировано в буфер обмена.'); }
  catch { field.focus(); field.select(); notice('Скопируйте выделенный текст: Ctrl / ⌘ + C или меню «Копировать».'); }
}
$('connect').onclick = start;
$('copy-link').onclick = () => copy($('room-link').value, $('room-link'));
$('new-room').onclick = () => { history.replaceState(null, '', location.href.split('#')[0]); active = false; joining = false; $('invite').hidden = true; $('copy-link').hidden = true; start(); };
$('paste').onclick = async () => {
  try { const text = await navigator.clipboard.readText(); $('outgoing').value = text.slice(0, MAX); $('outgoing').dispatchEvent(new Event('input')); notice(text.length > MAX ? 'Вставлены первые 100 000 символов.' : 'Текст вставлен. Нажмите «Отправить».'); }
  catch { $('outgoing').focus(); notice('Вставьте текст вручную: Ctrl / ⌘ + V или меню «Вставить».'); }
};
$('outgoing').oninput = () => { $('count').textContent = $('outgoing').value.length.toLocaleString('ru-RU') + ' / 100 000'; updateSend(); };
$('send').onclick = () => {
  const text = $('outgoing').value;
  if (!ready || !connection?.open || !text.length || text.length > MAX) return;
  if (pending.size >= 10) { notice('Подождите подтверждения предыдущих сообщений.'); return; }
  const id = random();
  pending.set(id, setTimeout(() => { pending.delete(id); notice('Нет подтверждения доставки. Повторите отправку после проверки соединения.'); }, 15000));
  try { connection.send({ type: 'text', id, text }); notice('Отправляем…'); }
  catch { clearTimeout(pending.get(id)); pending.delete(id); disconnected('Соединение прервано'); }
};
$('outgoing').onkeydown = event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); $('send').click(); } };
$('copy-text').onclick = () => copy($('incoming').value, $('incoming'));
$('clear').onclick = () => { $('incoming').value = ''; $('incoming').hidden = true; $('empty').hidden = false; $('copy-text').disabled = true; $('clear').disabled = true; $('received-time').textContent = 'Ожидаем новое сообщение'; notice('Полученный текст очищен на этом устройстве.'); };
if (location.hash) { $('instructions').textContent = 'Подключитесь к первому устройству. Страница с созданным мостом должна оставаться открытой.'; $('connect').textContent = 'Подключиться к мосту'; }
window.addEventListener('hashchange', () => location.reload());
})();

