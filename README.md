# Yubikiri Proxy

軽量なHTTPプロキシの試作です。トップ画面は旧版の暗い配色と中央配置を引き継ぎ、サーバー側はブラウザ自動起動に頼らない構成にしています。

## 起動

- Node.js 20.11 以降
- `npm install`
- `npm start`
- `http://localhost:3000` を開く

開発時は `npm run dev` を使えます。

## URL の形式

閲覧先は接続先 origin を base64url 化したトークンで表します。

- 正規のプロキシURL: `http://localhost:3000/proxy/<トークン>/<パス>`
- 表示用URL（SPA対策）: `http://localhost:3000/<パス>?__y=<トークン>`

プロキシ下のページは読み込み直後に表示用URLへ書き換えます（URLランダリング）。これは Svelte 等のSPAルーターが `location.pathname` を自分のルート表として厳密比較するためで、`/proxy/<トークン>/` 接頭辞が付いたままだとアプリ側が404扱いにしてしまうからです。表示用URLで再読込・ブックマークした場合はサーバーが `__y` を取り除いて正規のプロキシURLへ渡し直すため、両方の形式が常に使えます。

## 現在の実装

- HTTP/HTTPS ページ、リダイレクト、フォーム送信（GET/POST）の中継
- HTML のリンク・画像・スクリプト・スタイル・フォーム先・srcset・meta refresh・インラインstyle を書き換え
- CSS の `url()` と `@import` を書き換え
- 上流の gzip / deflate / brotli 圧縮を展開してから書き換え
- ブラウザ上のランタイムスクリプトが次のAPIを中継URLへ変換:
  `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `Worker` / `SharedWorker` / `navigator.sendBeacon` / `window.open`
- 要素プロパティ（`src` / `href` / `action` など）の setter、`setAttribute`、`innerHTML` / `insertAdjacentHTML` による動的挿入も書き換え
- `history.pushState` / `replaceState` を表示用URLへ変換し、SPAの戻る・進む・再読込が成立
- 接続先ごとのパス（`Path=/proxy/<トークン>/...`）でCookieを分離
- 内部・プライベートIPへの接続を拒否し、接続先DNSを検査
- HTML変換サイズ、アップロードサイズ、同時接続数を制限
- メモリ上のキャッシュやユーザー履歴を持たない

処理はすべてサーバー側で行い、サイト固有の分岐はありません。書き換えは接続先URLを機械的に中継URLへ写す汎用処理のみです。

接続先ポートは標準のHTTP/HTTPSに制限しています。

ブラウザ上で実行されるJavaScriptを完全に仲介する仕組みではありません。Service Worker、複雑なCORS設計、外部認証・ボット対策、DRM付き動画などを使うサイトは正常に動作しない場合があります。localStorage / sessionStorage は生成元（このプロキシ）単位で共有されるため、同一キーを使う複数サイト間で値が混ざることがあります。ブラウザの同一生成元モデルに依存するため、初版で全サイトの互換性を保証するものではありません。

現段階のパス型ルーティングでは、異なる閲覧先もブラウザ上では同じ生成元になります。公開利用やログインを伴う利用の前に、サイト間のブラウザ分離と濫用対策を追加する必要があります。

## Render で公開する

1. GitHub にこのリポジトリをpushする（現状は未push）
2. Render の Dashboard → New → Blueprint でリポジトリを選択し、`render.yaml` を適用する
3. 環境変数 `AGENT_SECRET` に 8文字以上のランダムな文字列を設定する（PCエージェントを使わないなら空のままでよい）
4. `https://<サービス名>.onrender.com` を開いて動作を確認する

無料インスタンスは15分アクセスがないとスリープし、再起動に時間がかかります。PCエージェントを接続しておくとエージェントの定期ポーリングがアクセス扱いになるため、PCの電源が入っている間はスリープしにくくなります。

## メインPCを経由させる（PCエージェント）

PCの電源が入っている間だけ、上流への取得をメインPCの回線経由で行います。PCが停止している場合はRenderから直接取得へ自動で切り替わるため、切り替え作業は不要です。

PC側の起動:

```
set RENDER_URL=https://<サービス名>.onrender.com
set AGENT_SECRET=<Renderに設定したのと同じ値>
npm run agent
```

仕組み:

- PC側は `src/agent.js` がRenderへ**外向き**に常時接続するだけです。PCでポート開放やルーター設定は不要
- プロキシへのリクエストがあるとRenderが「取得ジョブ」を発行し、待機中のPCエージェントが受け取ってPCの回線から上流へアクセスし、結果をストリームでRenderに返します
- エージェントが6秒以内にジョブを受け取れない場合（PCスリープ中等）は、Renderが自分で上流へアクセスします。どちらの経路でもブラウザ側の見た目は変わりません
- 取得の並列数は `AGENT_CONCURRENCY`（既定6）で調整できます
- WebSocket中継と、ブラウザとRender間の通信は常にRender直です。PC経由になるのは「Render→上流サーバー」の区間のみです
- 接続には `AGENT_SECRET`（timing-safe比較）で認証します。秘密の値が漏れると第三者がPCの回線を経由して取得できるため、推測しにくい値を使ってください

## Render（参考）

`render.yaml` は Node Web Service の Free プランを指定しています。Free インスタンスのCPU/RAMには上限があり、大きなファイルの同時中継や常時稼働を前提とする構成ではありません。サービスの仕様変更は [Render の Free インスタンス説明](https://render.com/docs/free) と [Blueprint YAML リファレンス](https://render.com/docs/blueprint-spec) を確認してください。
