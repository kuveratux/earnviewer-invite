'use strict';

// Service Worker（端末内の受付係）。Manager・Agent 共通
// - 画面のファイル：保管庫を優先して返し、裏で新しい版を取りに行く
// データは扱わない（利用者が読み込み、端末内の IndexedDB に保存する）
// 画面のファイルを変えたら version.js の APP_VERSION を上げる（古い保管庫が削除され、新しい版に入れ替わる）
// 同じドメインに取引ビューアなど他のアプリがあるので、削除するのは自分の接頭辞（app-config.js の cachePrefix）の保管庫だけ

importScripts('app-config.js', 'version.js');
const PREFIX = self.ESV_APP.cachePrefix;
const SHELL = PREFIX + self.APP_VERSION;
// 保管するファイル：app-config.js の shellFiles があればそれ（招待アプリなど、ビューアと部品が違うアプリ）、なければビューアの一覧
const SHELL_FILES = self.ESV_APP.shellFiles || [
  './',
  'index.html',
  'app-config.js',
  'version.js',
  'appearance.js',
  'reward.js',
  'deposits.js',
  'fish.js',
  'report.js',
  'rankview.js',
  'chart.js',
  'views.js',
  'book.js',
  'drive.js',
  'core.js',
  'app.js',
  'style.css',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/bar-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png',
  ...(self.ESV_APP.extraFiles || []), // アプリごとのファイル（app-config.js。Manager の招待など）
];

// 新しい版のファイルは、公開サイトの一時保管（最大 10 分）を通さずに取る（URL に版の印を付ける。保管庫からは印を無視して探す）
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL)
    .then((c) => Promise.all(SHELL_FILES.map((u) => fetch(new Request(u + (u.includes('?') ? '&' : '?') + 'v=' + self.APP_VERSION, { cache: 'reload' }))
      .then((res) => { if (!res.ok) throw new Error(u + ': ' + res.status); return c.put(new Request(u), res); }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (e.request.cache === 'no-store' || e.request.cache === 'reload') return; // 更新確認などは保管庫を通さない

  // 保管庫優先（裏で更新）
  e.respondWith(
    caches.open(SHELL).then((c) =>
      c.match(e.request, { ignoreSearch: true }).then((hit) => {
        const update = fetch(e.request, { cache: 'no-cache' }) // 裏での取り直しは、一時保管を確かめ直してから
          .then((res) => { if (res.ok) c.put(e.request, res.clone()); return res; })
          .catch(() => hit);
        return hit || update;
      })
    )
  );
});
