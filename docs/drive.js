'use strict';

// Google ドライブからの取得
// - 権限は drive.file（このアプリで選んだファイルだけ読める）。ドライブのほかのファイルは見えない
// - 初回だけ Google Picker でファイルを選び、以降は同じファイルを「最新データを取得」で読み直す
// - Google のスクリプトは、ボタンを押したときに初めて読み込む（起動時には Google に通信しない）

// Google Cloud の設定値（公開しても問題ない値。API キーは HTTP リファラーと API の種類で制限しておく）
const GOOGLE = {
  clientId: '62334130469-9cd1ogi940lagb7cm9l25f8809l7k7tg.apps.googleusercontent.com',  // OAuth クライアント ID（…apps.googleusercontent.com）
  apiKey: 'AIzaSyD7iwB6KuIykAVptoMmMD7Dg43x0xm_nxQ',    // API キー（Google Picker API 用）
  appId: '62334130469',     // プロジェクト番号（数字）
};
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

const Drive = (() => {
  let tokenClient = null;
  let token = null; // { value, expiresAt }
  let loading = null;

  const configured = () => !!(GOOGLE.clientId && GOOGLE.apiKey && GOOGLE.appId);

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Google のスクリプトを読み込めませんでした（通信を確認してください）'));
      document.head.append(s);
    });
  }

  // 読み込み済みなら false、今回読み込んだなら true を返す
  async function ensureLoaded() {
    if (tokenClient) return false;
    if (!loading) {
      loading = (async () => {
        await Promise.all([loadScript('https://accounts.google.com/gsi/client'), loadScript('https://apis.google.com/js/api.js')]);
        await new Promise((resolve) => gapi.load('picker', resolve));
        tokenClient = google.accounts.oauth2.initTokenClient({ client_id: GOOGLE.clientId, scope: SCOPE, callback: () => {} });
      })().catch((e) => { loading = null; throw e; }); // 失敗したら、次に押したときに読み込み直す
    }
    await loading;
    return true;
  }

  function requestToken(prompt) {
    return new Promise((resolve, reject) => {
      tokenClient.callback = (r) => {
        if (r.error) return reject(new Error('Google ログインに失敗しました：' + r.error));
        token = { value: r.access_token, expiresAt: Date.now() + (Number(r.expires_in) - 60) * 1000 };
        resolve(token.value);
      };
      tokenClient.error_callback = (e) => {
        const err = new Error((e.type === 'popup_failed_to_open'
          ? 'ログイン画面を開けませんでした。もう一度ボタンを押してください。'
          : e.type === 'popup_closed' ? 'ログインが中断されました。' : 'Google ログインに失敗しました。') + '（' + e.type + '）');
        err.retry = e.type === 'popup_failed_to_open';
        reject(err);
      };
      tokenClient.requestAccessToken({ prompt });
    });
  }

  async function getToken() {
    if (token && Date.now() < token.expiresAt) return token.value;
    return requestToken('');
  }

  // ボタンの処理の最初（await より前）に呼ぶ。ログインが必要なら、その場でログイン画面を開く
  // iPhone の Safari は、ボタンを押した直後に開いたウィンドウしか許さない（間に待ち時間のある処理を挟むとブロックされる）
  // Google の部品をまだ読み込んでいないときは何もしない（null）
  function authorizeNow() {
    if (!tokenClient || (token && Date.now() < token.expiresAt)) return null;
    return requestToken('');
  }

  // Google の部品を前もって読み込む（設定タブを開いたときに呼ぶ。ボタンを押したときに間に合うように）
  function preload() {
    if (configured()) ensureLoaded().catch(() => { /* 読み込めなくても、ボタンを押したときにもう一度試す */ });
  }

  // ファイルを選ぶ（初回・ファイルを変えるとき）。[{ id, name }] を返す（multi なら複数選べる）。キャンセル時は null
  // query：最初からこの文字で絞り込んで表示する（例：esv_manager）
  async function pick(title, multi, query) {
    const accessToken = await getToken();
    return new Promise((resolve) => {
      const mine = new google.picker.DocsView(google.picker.ViewId.DOCS).setIncludeFolders(true).setMode(google.picker.DocsViewMode.LIST);
      const shared = new google.picker.DocsView(google.picker.ViewId.DOCS).setIncludeFolders(true).setOwnedByMe(false).setMode(google.picker.DocsViewMode.LIST);
      if (query) { mine.setQuery(query); shared.setQuery(query); }
      const builder = new google.picker.PickerBuilder()
        .setOAuthToken(accessToken)
        .setDeveloperKey(GOOGLE.apiKey)
        .setAppId(GOOGLE.appId)
        .setLocale('ja')
        .setTitle(title || 'データファイルを選んでください')
        .addView(shared)
        .addView(mine)
        .setCallback((d) => {
          if (d.action === google.picker.Action.PICKED) resolve(d.docs.map((x) => ({ id: x.id, name: x.name })));
          else if (d.action === google.picker.Action.CANCEL) resolve(null);
        });
      if (multi) builder.enableFeature(google.picker.Feature.MULTISELECT_ENABLED);
      builder.build().setVisible(true);
    });
  }

  async function api(url, accessToken) {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
    if (res.status === 401) { token = null; throw Object.assign(new Error('ログインの有効期限が切れました。もう一度押してください。'), { retry: true }); }
    if (res.status === 403 || res.status === 404) throw Object.assign(new Error('ファイルにアクセスできません（共有が外れたか、ファイルが置き換えられた可能性があります）。ファイルを選び直してください。'), { repick: true });
    if (!res.ok) throw new Error('ドライブからの取得に失敗しました（HTTP ' + res.status + '）');
    return res;
  }

  // ファイルの情報と中身を取得
  async function download(fileId) {
    const accessToken = await getToken();
    const base = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId);
    const meta = await (await api(base + '?fields=id,name,modifiedTime&supportsAllDrives=true', accessToken)).json();
    const text = await (await api(base + '?alt=media&supportsAllDrives=true', accessToken)).text();
    return { meta, text };
  }

  // ログインなしで読む（2026-10）：「リンクを知っている全員」に共有したファイルだけ読める。API キー（kuveratux.github.io からだけ使える）を使う
  // 共有になっていない・ファイルがない・通信できないときは例外（呼ぶ側は静かにやめる）
  async function publicApi(url) {
    const res = await fetch(url + '&key=' + encodeURIComponent(GOOGLE.apiKey));
    if (!res.ok) throw Object.assign(new Error('共有のファイルを読めませんでした（HTTP ' + res.status + '）'), { status: res.status });
    return res;
  }
  const fileUrl = (fileId) => 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId);
  // ファイルの情報（md5Checksum は中身が変わると変わる目印）
  async function publicMeta(fileId) {
    return (await publicApi(fileUrl(fileId) + '?fields=id,name,modifiedTime,md5Checksum&supportsAllDrives=true')).json();
  }
  async function publicText(fileId) {
    return (await publicApi(fileUrl(fileId) + '?alt=media&supportsAllDrives=true')).text();
  }

  function signOut() {
    if (token && window.google) google.accounts.oauth2.revoke(token.value, () => {});
    token = null;
  }

  return { configured, ensureLoaded, authorizeNow, preload, pick, download, publicMeta, publicText, signOut };
})();
