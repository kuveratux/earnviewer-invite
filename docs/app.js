'use strict';

// EARN VIEWER INVITE：EARN VIEWER の招待リンク・招待コード・QR コードを作り、招待する人の合言葉を管理する（2026-10）
// ・その人のデータのファイルを「リンクを知っている全員」に共有し、その共有のリンクと合言葉を入れる
//   → ログインなしで読めるか、名前が ev_ で始まるか、合言葉で開けるかを確かめてから保存する
// ・招待リンク：EARN VIEWER の URL ＋ #invite=<招待コード>（# の後ろはサーバーに送られない）。招待コード＝ファイルの ID
//   合言葉は招待リンク・QR に入れない（［合言葉をコピー］で、別の手段で伝える）
// ・保存するもの（名前・ファイルの ID・合言葉など）は、管理用パスワードで暗号化して、この端末の中（IndexedDB）にだけ置く
//   管理用パスワード → PBKDF2-SHA256（60万回）→ AES-256-GCM。パスワードそのものは保存しない。忘れたら取り出せない
//   プログラムにはファイルの ID や合言葉を書かない
// QR コードは qrcode.js（qrcode-generator、MIT ライセンス、Kazuhiko Arase）で作る。アプリの中に入れてあるので、ネットから読み込まない

const APP = self.ESV_APP;
const $ = (id) => document.getElementById(id);
const KDF_ITER = 600000;
const AUTO_LOCK_MS = 5 * 60 * 1000;
const MIN_PASS = 8;

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}
const fmtJst = (iso) => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');

function toast(msg) {
  let t = $('toast');
  if (!t) { t = el('div', { id: 'toast', class: 'toast', role: 'status' }); document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 4000);
}

//--------------------------------------------------------------
// 端末内の保存（IndexedDB。名前はこのアプリだけのもの）
//--------------------------------------------------------------
const STORE = 'kv';
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(APP.db, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbRun(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const r = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}
const getItem = (k) => dbRun('readonly', (s) => s.get(k));
const putItem = (k, v) => dbRun('readwrite', (s) => s.put(v, k));
const delItem = (k) => dbRun('readwrite', (s) => s.delete(k));

//--------------------------------------------------------------
// 暗号（金庫）：{ v, kdf: { salt, iterations }, iv, data }。data は招待の一覧（JSON）を暗号化したもの
//--------------------------------------------------------------
const enc = new TextEncoder();
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(pass, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

let vaultKey = null;   // 開いている間だけ持つ（取り出せない形の鍵）
let vaultKdf = null;   // { salt, iterations }
let invites = [];      // [{ key, name, fileId, fileName, holderAddress, pass, createdAt, checkedAt, checkText }]

async function saveVault() {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, vaultKey, enc.encode(JSON.stringify({ invites })));
  await putItem('vault', { v: 1, kdf: vaultKdf, iv: toB64(iv), data: toB64(ct) });
}

async function openVault(pass) {
  const v = await getItem('vault');
  const key = await deriveKey(pass, fromB64(v.kdf.salt), v.kdf.iterations);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(v.iv) }, key, fromB64(v.data)); // 違えば例外
  vaultKey = key;
  vaultKdf = v.kdf;
  invites = JSON.parse(new TextDecoder().decode(plain)).invites || [];
}

async function createVault(pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  vaultKdf = { salt: toB64(salt), iterations: KDF_ITER };
  vaultKey = await deriveKey(pass, salt, KDF_ITER);
  invites = [];
  await saveVault();
}

//--------------------------------------------------------------
// 鍵：開く・決める・かける
//--------------------------------------------------------------
function showStatus(text) { $('status').textContent = text || 'Version：' + self.APP_VERSION; }

async function showLock() {
  vaultKey = null;
  invites = [];
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  const has = !!(await getItem('vault'));
  $('mainView').hidden = true;
  $('lockView').hidden = false;
  $('setupBox').hidden = has;
  $('unlockBox').hidden = !has;
  ['setupPass1', 'setupPass2', 'unlockPass'].forEach((id) => { $(id).value = ''; });
  $('unlockMsg').textContent = '';
  (has ? $('unlockPass') : $('setupPass1')).focus();
}

function showMain() {
  $('lockView').hidden = true;
  $('mainView').hidden = false;
  renderList();
}

$('setupBtn').addEventListener('click', async () => {
  const p1 = $('setupPass1').value, p2 = $('setupPass2').value;
  if (p1.length < MIN_PASS) { alert('管理用パスワードは ' + MIN_PASS + ' 文字以上にしてください。'); return; }
  if (p1 !== p2) { alert('2つのパスワードが違います。'); return; }
  showStatus('準備中…');
  await createVault(p1);
  showStatus();
  showMain();
});

async function tryUnlock() {
  const pass = $('unlockPass').value;
  if (!pass) return;
  $('unlockBtn').disabled = true;
  showStatus('確認中…');
  try {
    await openVault(pass);
    $('unlockPass').value = '';
    showMain();
  } catch {
    $('unlockMsg').textContent = 'パスワードが違います。';
  } finally {
    $('unlockBtn').disabled = false;
    showStatus();
  }
}
$('unlockBtn').addEventListener('click', tryUnlock);
$('unlockPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });

$('resetBtn').addEventListener('click', async () => {
  if (!confirm('保存した招待と合言葉を、この端末から全部消しますか？（元に戻せません。ドライブの共有や、招待した人の端末には影響しません）')) return;
  await delItem('vault');
  showLock();
});

$('lockBtn').addEventListener('click', showLock);

// 画面を離れて5分たったら鍵をかける
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') hiddenAt = Date.now();
  else if (vaultKey && hiddenAt && Date.now() - hiddenAt > AUTO_LOCK_MS) showLock();
});

$('changePassBtn').addEventListener('click', () => { ['cpOld', 'cpNew1', 'cpNew2'].forEach((id) => { $(id).value = ''; }); $('passDlg').showModal(); });
$('passDlg').addEventListener('close', async () => {
  if ($('passDlg').returnValue !== 'ok') return;
  const old = $('cpOld').value, p1 = $('cpNew1').value, p2 = $('cpNew2').value;
  ['cpOld', 'cpNew1', 'cpNew2'].forEach((id) => { $(id).value = ''; });
  if (p1.length < MIN_PASS) { alert('新しいパスワードは ' + MIN_PASS + ' 文字以上にしてください。'); return; }
  if (p1 !== p2) { alert('新しいパスワードが2つで違います。'); return; }
  showStatus('確認中…');
  try {
    const keep = invites;
    await openVault(old); // 今のパスワードを確かめる
    invites = keep;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    vaultKdf = { salt: toB64(salt), iterations: KDF_ITER };
    vaultKey = await deriveKey(p1, salt, KDF_ITER);
    await saveVault();
    toast('管理用パスワードを変えました');
  } catch {
    alert('今のパスワードが違います。');
  } finally {
    showStatus();
  }
});

//--------------------------------------------------------------
// 共有のファイルの点検：ログインなしで読めるか・名前・合言葉で開けるか・EARN VIEWER のデータか
//--------------------------------------------------------------
// 招待コード・招待リンク・ドライブの共有のリンクのどれを貼られても、ファイルの ID を取り出す（EARN VIEWER と同じ）
function inviteIdOf(text) {
  const s = String(text || '').trim();
  const m = s.match(/[#&?]invite=([A-Za-z0-9_-]+)/) || s.match(/\/d\/([A-Za-z0-9_-]+)/) || s.match(/[?&]id=([A-Za-z0-9_-]+)/) || s.match(/^([A-Za-z0-9_-]+)$/);
  return m && m[1].length >= 20 ? m[1] : null;
}

async function decryptData(e, pass) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: e.kdf.hash, salt: fromB64(e.kdf.salt), iterations: e.kdf.iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(e.cipher.iv) }, key, fromB64(e.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

// 戻り値：{ ok, text, fileName, holderAddress }（データには名前が入っていない。名前はこの端末で付ける）
async function checkFile(fileId, pass) {
  let meta;
  try { meta = await Drive.publicMeta(fileId); } catch {
    return { ok: false, text: 'ログインなしで読めませんでした。ドライブで、このファイルの共有を「リンクを知っている全員」（閲覧者）にしてください。リンクが正しいかも確かめてください。' };
  }
  const name = String(meta.name || '');
  if (/^esv_/i.test(name)) return { ok: false, text: '「' + name + '」は ESV（EARN SPLIT VIEWER）のファイルです。EARN VIEWER のデータのファイル（' + APP.filePrefix + '…）の共有のリンクを貼ってください。' };
  if (!name.toLowerCase().startsWith(APP.filePrefix)) return { ok: false, text: '「' + name + '」は EARN VIEWER のデータのファイルではないようです（名前が ' + APP.filePrefix + ' で始まっていません）。' };
  let json;
  try { json = JSON.parse(await Drive.publicText(fileId)); } catch { return { ok: false, text: '「' + name + '」を読み込めませんでした（JSON 形式ではないか、通信に失敗しました）。' }; }
  if (json.format === 'esv-data-enc') {
    try { json = await decryptData(json, pass); } catch { return { ok: false, text: '合言葉が違います（「' + name + '」を開けませんでした）。PC で暗号化したときの合言葉を確かめてください。' }; }
  }
  // 暗号化していないファイルも点検はできるが、共有するファイルは暗号化しておく前提
  if (json.format !== 'ev-data' || !json.holder) return { ok: false, text: '「' + name + '」は EARN VIEWER のデータではありません。' };
  return {
    ok: true, fileName: name, holderAddress: json.holder.address || '',
    text: '点検：開けました（' + name + '・' + short(json.holder.address) + '、データ作成 ' + fmtJst(json.generatedAt) + '）',
  };
}

//--------------------------------------------------------------
// 招待を作る
//--------------------------------------------------------------
$('newPassShow').addEventListener('change', () => { $('newPass').type = $('newPassShow').checked ? 'text' : 'password'; });
$('newBtn').addEventListener('click', async () => {
  const fileId = inviteIdOf($('newSrc').value);
  const pass = $('newPass').value;
  if (!fileId) { $('newMsg').textContent = 'リンクの形が正しくありません。ドライブの［リンクをコピー］で取ったリンクをそのまま貼ってください。'; return; }
  if (!pass) { $('newMsg').textContent = '合言葉を入れてください。'; return; }
  $('newBtn').disabled = true;
  $('newMsg').textContent = '点検中…';
  try {
    const r = await checkFile(fileId, pass);
    $('newMsg').textContent = r.text;
    if (!r.ok) return;
    const now = new Date().toISOString();
    const cur = invites.find((x) => x.fileId === fileId);
    if (cur && !confirm('このファイルの招待はもうあります（' + cur.name + '）。合言葉などを今入れたもので置き換えますか？')) return;
    const item = { key: cur ? cur.key : toB64(crypto.getRandomValues(new Uint8Array(9))), name: $('newName').value.trim() || r.fileName,
      fileId, fileName: r.fileName, holderAddress: r.holderAddress, pass, createdAt: cur ? cur.createdAt : now, checkedAt: now, checkText: r.text };
    invites = cur ? invites.map((x) => (x === cur ? item : x)) : [...invites, item];
    await saveVault();
    ['newSrc', 'newPass', 'newName'].forEach((id) => { $(id).value = ''; });
    $('newPassShow').checked = false; $('newPass').type = 'password';
    $('newMsg').textContent = '';
    renderList();
    openDetail(item.key, r.text);
  } finally {
    $('newBtn').disabled = false;
  }
});

//--------------------------------------------------------------
// 一覧と詳細
//--------------------------------------------------------------
function renderList() {
  $('invCount').textContent = String(invites.length);
  const list = [...invites].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  $('invList').replaceChildren(...(list.length ? list.map((x) => el('li', {},
    el('button', { type: 'button', class: 'inv-item', onclick: () => openDetail(x.key) },
      el('span', { class: 'inv-name' }, x.name),
      el('span', { class: 'inv-sub' }, x.fileName + (x.holderAddress ? '・' + short(x.holderAddress) : '')),
      x.fileId ? el('span', { class: 'inv-sub' }, '点検 ' + (x.checkedAt ? fmtJst(x.checkedAt) : '—')) : el('span', { class: 'inv-pending' }, 'リンク未設定（押して共有のリンクを貼る）'))))
    : [el('li', { class: 'muted inv-empty' }, 'まだありません。上の「招待を作る」から作ってください。')]));
}

const inviteUrlOf = (id) => location.origin + location.pathname.replace(/[^/]*\/(index\.html)?$/, APP.viewerPath + '/') + '#invite=' + id;
let current = null;
let passShown = false;

function openDetail(key, msg) {
  current = invites.find((x) => x.key === key);
  if (!current) return;
  passShown = false;
  $('dName').textContent = current.name;
  $('dMeta').textContent = current.fileName + (current.holderAddress ? '・' + short(current.holderAddress) : '') + '・作成 ' + fmtJst(current.createdAt);
  paintPass();
  const ready = !!current.fileId;
  $('dPending').hidden = ready;
  $('dReady').hidden = !ready;
  $('dCheck').disabled = !ready;
  $('dPendFile').textContent = current.fileName;
  $('dSrc').value = '';
  if (ready) {
    const url = inviteUrlOf(current.fileId);
    $('dLink').textContent = url;
    $('dCode').textContent = current.fileId;
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    $('dQr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true }); // 作った図形だけ（データの文字は入れない）
  }
  $('dMsg').textContent = msg || (current.checkText ? current.checkText + '（' + fmtJst(current.checkedAt) + '）' : '');
  if (!$('detailDlg').open) $('detailDlg').showModal();
}
function paintPass() {
  $('dPass').textContent = passShown ? current.pass : '＊＊＊＊＊＊';
  $('dShowPass').textContent = passShown ? '隠す' : '表示する';
}

const copyText = async (text, done) => {
  try { await navigator.clipboard.writeText(text); toast(done); } catch { toast('コピーできませんでした。長押ししてコピーしてください'); }
};
$('dCopyLink').addEventListener('click', () => copyText($('dLink').textContent, '招待リンクをコピーしました'));
$('dCopyCode').addEventListener('click', () => copyText($('dCode').textContent, '招待コードをコピーしました'));
$('dCopyPass').addEventListener('click', () => copyText(current.pass, '合言葉をコピーしました（招待リンクとは別の手段で伝えてください）'));
$('dShowPass').addEventListener('click', () => { passShown = !passShown; paintPass(); });
$('dClose').addEventListener('click', () => $('detailDlg').close());
$('detailDlg').addEventListener('close', () => { current = null; passShown = false; $('dPass').textContent = '＊＊＊＊＊＊'; });

// リンク未設定の人に共有のリンクを貼る：点検し、ファイル名がその人のファイル名と同じときだけ保存する（別の人のリンクの取り違えを防ぐ）
$('dSetLink').addEventListener('click', async () => {
  const x = current;
  const fileId = inviteIdOf($('dSrc').value);
  if (!fileId) { $('dMsg').textContent = 'リンクの形が正しくありません。ドライブの［リンクをコピー］で取ったリンクをそのまま貼ってください。'; return; }
  const other = invites.find((y) => y !== x && y.fileId === fileId);
  if (other) { $('dMsg').textContent = 'このリンクは「' + other.name + '」の招待で使っています。'; return; }
  $('dSetLink').disabled = true;
  $('dMsg').textContent = '点検中…';
  try {
    // 先にファイル名を比べる（別の人のファイルだと合言葉で開けないので、「合言葉が違います」より先に取り違えを知らせる）
    let meta = null;
    try { meta = await Drive.publicMeta(fileId); } catch { /* 読めないときは下の点検で理由を出す */ }
    if (meta && meta.name !== x.fileName) { $('dMsg').textContent = 'このリンクは「' + meta.name + '」のファイルです。「' + x.fileName + '」の共有のリンクを貼ってください。'; return; }
    const r = await checkFile(fileId, x.pass);
    $('dMsg').textContent = r.text;
    if (!r.ok) return;
    Object.assign(x, { fileId, holderAddress: r.holderAddress, checkedAt: new Date().toISOString(), checkText: r.text });
    await saveVault();
    renderList();
    openDetail(x.key, r.text);
  } finally {
    $('dSetLink').disabled = false;
  }
});

// 招待アプリ用ファイル（取得エクセルが作る）：受け渡し用のパスワードで開き、ファイル名で今の一覧と突き合わせる
//   同じファイル名の人がいれば合言葉を新しくする（名前は、ファイル名のままのときだけ入れる）。いなければ「リンク未設定」で足す
function askTransferPass() {
  return new Promise((resolve) => {
    $('tpInput').value = '';
    $('tpDlg').addEventListener('close', () => { const v = $('tpDlg').returnValue === 'ok' ? $('tpInput').value : null; $('tpInput').value = ''; resolve(v); }, { once: true });
    $('tpDlg').showModal();
  });
}
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let w;
  try { w = JSON.parse(await file.text()); } catch { alert('JSON 形式のファイルではありません。'); return; }
  if (!w || w.format !== 'ev-invite-transfer' || !w.enc) { alert('「' + file.name + '」は招待アプリ用ファイルではありません（取得エクセルの［招待アプリ用ファイルを作成］で作ったファイルを選んでください）。'); return; }
  let body = null;
  for (;;) {
    const tp = await askTransferPass();
    if (tp == null) return;
    showStatus('確認中…');
    try { body = await decryptData(w.enc, tp); break; } catch { showStatus(); if (!confirm('受け渡し用のパスワードが違います。もう一度入れますか？')) return; }
  }
  showStatus();
  if (!body || body.format !== 'ev-invite-list' || !Array.isArray(body.people)) { alert('招待アプリ用ファイルの中身の形が違います。'); return; }
  const now = new Date().toISOString();
  const list = body.people.filter((p) => p && p.fileName && p.pass);
  // 合言葉が変わる人がいれば、名前を出して確かめる（古いファイルを読み込んで、合言葉が前のものに戻らないように）
  const changing = list.map((p) => invites.find((x) => x.fileName === p.fileName && x.pass !== p.pass)).filter(Boolean);
  let takePass = true;
  if (changing.length) {
    takePass = confirm('合言葉が変わる人がいます：' + changing.map((x) => x.name).join('、') + '\n\n' +
      '取得エクセルで合言葉を登録し直したときは「OK」で新しい合言葉に置き換えます。\n心当たりがないとき（古いファイルを選んだなど）は「キャンセル」で、合言葉は今のまま、新しい人の追加だけを行います。');
  }
  let added = 0, updated = 0;
  for (const p of list) {
    const cur = invites.find((x) => x.fileName === p.fileName);
    if (cur) {
      if (cur.pass !== p.pass && takePass) { cur.pass = p.pass; updated++; }
      if (p.name && cur.name === cur.fileName) cur.name = p.name;
      if (!cur.holderAddress && p.address) cur.holderAddress = p.address;
    } else {
      invites.push({ key: toB64(crypto.getRandomValues(new Uint8Array(9))), name: p.name || p.fileName, fileId: '', fileName: p.fileName,
        holderAddress: p.address || '', pass: p.pass, createdAt: now, checkedAt: null, checkText: '' });
      added++;
    }
  }
  await saveVault();
  renderList();
  alert('招待アプリ用ファイルを読み込みました（追加 ' + added + ' 人・合言葉を新しくした人 ' + updated + ' 人' + (changing.length && !takePass ? '・合言葉を今のままにした人 ' + changing.length + ' 人' : '') + '）。' + (added ? '\n「リンク未設定」の人を押して、共有のリンクを貼ってください。' : '') +
    (updated ? '\n合言葉を新しくした人は、［もう一度点検］で開けるか確かめてください。' : '') + '\n\n読み込んだファイルは、ドライブやスマホから消してください。');
});

$('dCheck').addEventListener('click', async () => {
  const x = current;
  $('dMsg').textContent = '点検中…';
  const r = await checkFile(x.fileId, x.pass);
  $('dMsg').textContent = r.text;
  if (r.ok) {
    Object.assign(x, { fileName: r.fileName, holderAddress: r.holderAddress, checkedAt: new Date().toISOString(), checkText: r.text });
    await saveVault();
    renderList();
  }
});

$('dEdit').addEventListener('click', () => { $('eName').value = current.name; $('ePass').value = ''; $('editDlg').showModal(); });
$('editDlg').addEventListener('close', async () => {
  if ($('editDlg').returnValue !== 'ok' || !current) return;
  const x = current;
  const name = $('eName').value.trim() || x.name;
  const pass = $('ePass').value;
  $('ePass').value = '';
  if (pass) {
    $('dMsg').textContent = '点検中…';
    const r = await checkFile(x.fileId, pass);
    $('dMsg').textContent = r.text;
    if (!r.ok) { alert('新しい合言葉では開けなかったので、変えませんでした。\n' + r.text); return; }
    Object.assign(x, { pass, fileName: r.fileName, holderAddress: r.holderAddress, checkedAt: new Date().toISOString(), checkText: r.text });
  }
  x.name = name;
  await saveVault();
  renderList();
  openDetail(x.key, $('dMsg').textContent);
});

$('dDelete').addEventListener('click', async () => {
  if (!confirm('「' + current.name + '」の招待と合言葉を、この端末から消しますか？（ドライブの共有や、招待した人の端末には影響しません）')) return;
  const key = current.key;
  $('detailDlg').close();
  invites = invites.filter((x) => x.key !== key);
  await saveVault();
  renderList();
});

//--------------------------------------------------------------
// バージョンと更新
//--------------------------------------------------------------
$('appVersion').textContent = self.APP_VERSION;
async function newerVersion() {
  const res = await fetch('version.js?t=' + Date.now(), { cache: 'no-store' });
  const latest = ((await res.text()).match(/APP_VERSION\s*=\s*'([^']+)'/) || [])[1];
  return latest && latest !== self.APP_VERSION ? latest : null;
}
$('updateBtn').addEventListener('click', async () => {
  try {
    const latest = await newerVersion();
    if (!latest) { alert('最新のバージョンです（' + self.APP_VERSION + '）'); return; }
    if (!confirm('新しいバージョン（' + latest + '）があります。更新しますか？')) return;
    const reg = 'serviceWorker' in navigator && await navigator.serviceWorker.getRegistration();
    if (reg) await reg.update();
    location.reload();
  } catch {
    alert('更新を確認できませんでした（通信を確認してください）');
  }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.error);
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
showStatus();
showLock();
