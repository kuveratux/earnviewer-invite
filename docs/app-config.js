// アプリごとの設定（画面と Service Worker の両方で使う）
// 同じドメイン（kuveratux.github.io）で EARN VIEWER・ESV・取引ビューアと並ぶため、端末内の保存名をこのアプリだけのものにする
self.ESV_APP = {
  id: 'invite',
  defaultName: 'EV Invite',         // ホーム画面の名前
  title: 'EARN VIEWER INVITE',      // 画面上部の見出し
  db: 'ev-invite',                  // IndexedDB
  lsAppearance: 'evi-appearance',   // localStorage（使わないが、名前は分けておく）
  cachePrefix: 'evi-shell-',        // Service Worker の保管庫（この接頭辞のものだけ削除する）
  filePrefix: 'ev_',                // 招待できるデータファイルの名前の頭（ESV のファイル esv_… は断る）
  viewerPath: 'earnviewer',         // 招待リンクの行き先（同じサイトの EARN VIEWER）
  shellFiles: ['./', 'index.html', 'app-config.js', 'version.js', 'drive.js', 'qrcode.js', 'app.js', 'style.css', 'manifest.webmanifest',
    'icons/icon-180.png', 'icons/bar-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png'],
};
