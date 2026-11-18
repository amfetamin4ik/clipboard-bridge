// Optional live test: sends only generated test text to a random encrypted room.
const assert = require('node:assert/strict');
const { HttpsBridge } = require('./https-bridge.js');
const peers = [];
async function settle(peer) {
  while (peer.pollBusy) await new Promise(resolve => setTimeout(resolve, 20));
  clearTimeout(peer.pollTimer); await peer.sendQueue; await peer.receiveQueue;
}
async function pump() {
  await new Promise(resolve => setTimeout(resolve, 6000));
  for (const peer of peers) { await settle(peer); await peer._poll(); await settle(peer); }
}
(async () => {
  const room = HttpsBridge.random(), secret = HttpsBridge.random(), received = [[], []], errors = [];
  for (let i = 0; i < 2; i++) {
    const peer = new HttpsBridge({ room, secret, joining: i === 1, onText: text => received[i].push(text), onNotice: text => { if (text.includes('недоступен') || text.includes('лимит')) errors.push(text); } });
    peers.push(peer); await peer.start(); await settle(peer);
  }
  for (let i = 0; i < 8 && !peers.every(peer => peer.ready); i++) await pump();
  assert(peers.every(peer => peer.ready), 'live pairing: ' + errors.join('; ') + JSON.stringify(peers.map(peer => ({online:peer.online, paired:!!peer.partner, seen:peer.seen.size, challenges:peer.challenges.size, offered:!!peer.offeredPartner}))));
  console.log('PASS: real HTTPS pairing');
  const short = 'HTTPS bridge test — Привет 👋';
  await peers[0].sendText(short);
  for (let i = 0; i < 8 && (!received[1].length || peers[0].pending.size); i++) await pump();
  assert.equal(received[1][0], short); assert.equal(peers[0].pending.size, 0);
  console.log('PASS: short text and delivery ACK');
  const long = 'Зашифрованная проверка 👋 '.repeat(250);
  await peers[1].sendText(long);
  for (let i = 0; i < 8 && (!received[0].length || peers[1].pending.size); i++) await pump();
  assert(received[0][0] === long, 'encrypted attachment was not received: ' + errors.join('; ')); assert.equal(peers[1].pending.size, 0);
  console.log('PASS: real HTTPS pairing, bidirectional Unicode text, encrypted attachment and delivery ACK');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => peers.forEach(peer => peer.close()));
