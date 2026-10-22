# cli-bridge

**Cihazınızdaki her CLI aracını, diğer tüm CLI araçlarına ve AI ajanlarına bağlayan yerel köprü (bridge).**

`cli-bridge` iki yönlü bir köprüdür:

1. **Araçlar arası** — `curl` çıktısını `jq`'ya, `git log`'u `jq`'ya, `ffmpeg` çıktısını `pdftotext`'e akıtabilirsiniz. Herhangi bir işi *anlamsal operasyon* olarak tanımlayıp zincirleyebilirsiniz.
2. **AI ajanları arası** — MCP (Model Context Protocol) sunucusu ile Claude Code, opencode, Cursor, Gemini CLI gibi ajanlar makinenizdeki **her** CLI aracını çağırabilir.

Katalogda 170+ popüler araç tanımlıdır, ama **katalog bir beyaz liste değildir**: PATH'te bulunan *her* binary, katalogda olmasa bile çağrılabilir. Katalog sadece zengin açıklama, semantik yetenek ve kurulum tarifi ekler.

---

## Hızlı başlangıç

```bash
npm install -g cli-bridge     # veya: npm install && npm run build

bridge doctor                 # ortam raporu
bridge list                   # keşfedilen araçlar
bridge search json            # araç arama
bridge op http.request --url https://api.github.com
bridge chain "http.request url=https://api.github.com/repos/nodejs/node | json.query filter=.stargazers_count"
```

### AI ajanına bağlamak

```bash
bridge init                   # istemciye özel MCP yapılandırmasını yazdırır
```

Claude Code için:

```bash
claude mcp add cli-bridge -- node "C:\...\cli-bridge\dist\mcp\main.js"
```

Ajan artık `bridge_search`, `bridge_call`, `bridge_run_op`, `bridge_chain` araçlarını ve keşfedilen her CLI aracını (`cli_git`, `cli_docker`, ...) kullanabilir.

---

## Üç katmanlı model

| Katman | Ne işe yarar | Örnek |
|---|---|---|
| **Tool** | Makinenizdeki somut binary | `git`, `jq`, `ffmpeg`, `kubectl` |
| **Operation** | Araçtan bağımsız, zincirlenebilir anlamsal eylem | `http.request`, `json.query`, `vcs.log` |
| **Chain** | Birden fazla operasyonun veri akışı | `http.request` → `json.query` → `file.write` |

Operasyonlar birden fazla aracı destekler ve **işe yaramazsa saf Node.js'e düşer**. Yani `jq` kurulu değilse bile `json.query` çalışır (dahili JSONPath motoru ile).

---

## Komutlar

```
discover
  list [--all] [--category X] [--json]      keşfedilen araçları listele
  search <sorgu>                            ada/yeteneğe göre ara
  describe <araç>                           detay, sürüm, kurulum tarifi
  ops                                       zincirlenebilir operasyonlar
  doctor                                    ortam raporu
  rescan                                    PATH'i yeniden tara

run
  call [bayraklar] <araç> [args...]          bir CLI aracını çalıştır
  op <operasyon> --anahtar değer            anlamsal operasyon çalıştır
  chain "op a=b | op c=d"                   boru hattı çalıştır

connect
  serve [--port 8791]                       yerel HTTP hub
  mcp                                       MCP sunucusu (stdio)
  init                                      MCP istemci yapılandırması

manage
  install <araç>                            eksik aracı kur
  policy allow|deny|show <araç>             izin listeleri
  completions <shell>                       kabuk tamamlamaları
```

> **Önemli:** `bridge call` içinde bridge bayrakları **araç adından önce** yazılır.
> Araç adından sonrası birebir araca geçer:
> ```bash
> bridge call git log --oneline -10      # git'e "log --oneline -10" gider
> bridge call --json git log --oneline   # JSON çıktı isterseniz bayrağı önce yazın
> ```

---

## Operasyonlar

| Operasyon | Araçlar (öncelik sırasıyla) | Dahili yedek |
|---|---|---|
| `http.request` | curl, httpie, wget | Node `fetch` |
| `http.download` | curl, wget | Node `fetch` |
| `json.query` | jq, gojq, jaq | JSONPath motoru |
| `yaml.query` | yq | — |
| `file.read` / `file.write` / `file.list` | — | Node `fs` |
| `text.search` | ripgrep, ag | Node regex walker |
| `code.run` | node, python, deno, bun | Node |
| `vcs.log` / `vcs.status` | git | — |
| `container.list` | docker, podman, nerdctl | — |
| `k8s.get` | kubectl | — |
| `db.query` | psql, mysql, sqlite3, duckdb | — |
| `media.info` / `media.convert` | ffprobe, ffmpeg | — |
| `image.convert` | magick | — |
| `doc.extract` / `ocr.read` | pdftotext, tesseract | — |
| `archive.create` | tar, 7z, zip | — |
| `net.dns` | nslookup, dig | — |
| `process.list` | tasklist, ps | — |
| `sys.info` | — | Node `os` |
| `web.search` | curl | DuckDuckGo HTML |

---

## Zincirleme (pipeline)

```bash
# Kısa yazım
bridge chain "http.request url=https://api.github.com/repos/nodejs/node | json.query filter=.stargazers_count"

# Uzun yazım (JSON)
bridge chain --file chain.json
```

`chain.json`:

```json
{
  "input": { "repo": "nodejs/node" },
  "steps": [
    { "id": "fetch", "op": "http.request", "with": { "url": "https://api.github.com/repos/{{input.repo}}" } },
    { "id": "stars", "op": "json.query", "with": { "filter": "$.stargazers_count" } },
    { "id": "save",  "op": "file.write",  "with": { "path": "stars.txt", "content": "{{steps.stars.stdout}}" } }
  ]
}
```

Kullanılabilir referanslar:

| Referans | Anlamı |
|---|---|
| `{{steps.<id>.stdout}}` | adımın ham çıktısı |
| `{{steps.<id>.json}}` | adımın ayrıştırılmış JSON çıktısı |
| `{{steps.<id>.json.<alan>}}` | JSON içindeki alan (`{{steps.a.json.stars}}`) |
| `{{steps.<id>.exitCode}}` | çıkış kodu |
| `{{input.<anahtar>}}` | zincir girişi |
| `{{env.<DEĞİŞKEN>}}` | ortam değişkeni |

Bir adımın `stdout`'u, sonraki adımın `stdin`'i olarak **otomatik** aktarılır.

---

## HTTP API

```bash
bridge serve --port 8791
```

| Uç nokta | Açıklama |
|---|---|
| `GET  /health` | durum |
| `GET  /v1/tools?q=` | araç listesi / arama |
| `GET  /v1/tools/:id` | araç detayı (sürüm dahil) |
| `GET  /v1/ops` | operasyon listesi + mevcut arka uçlar |
| `GET  /v1/ops/:id` | operasyon detayı |
| `POST /v1/call` | araç çağır (`{tool, args, stdin, cwd, timeoutMs}`) |
| `POST /v1/op` | operasyon çalıştır (`{op, input}`) |
| `POST /v1/chain` | boru hattı çalıştır (`{steps, input}`) |
| `GET  /v1/events` | SSE canlı olay akışı |

```bash
curl -s http://127.0.0.1:8791/v1/op -H "Content-Type: application/json" \
  -d '{"op":"json.query","input":{"json":"{\"a\":1}","filter":"$.a"}}'
```

---

## Güvenlik

- **Shell yok.** Argümanlar `spawn` ile dizi olarak geçer; enjeksiyon mümkün değildir.
- **Tehlikeli komut engeli.** `rm -rf /`, `format C:`, `dd of=/dev/sda`, fork bomb gibi kalıplar çalıştırılmadan reddedilir.
- **İzin listesi.** `bridge policy allow <araç>` ile sadece izin verilen arağa daraltın (`mode: allowlist`).
- **Sır temizleme.** Çıktılardaki API anahtarları, GitHub token'ları, JWT'ler ve özel anahtarlar otomatik maskelenir.
- **Yerel varsayılan.** Sunucu `127.0.0.1`'e bağlanır. `config.json` içine `server.token` eklerseniz tüm istekler `Authorization: Bearer <token>` ister.
- **Kayıt.** Her çağrı `~/.cli-bridge/` altında önbelleklenir; `~/.cli-bridge/config.json` tüm ayarları barındırır.

---

## Kurulum

`bridge install <araç>` mevcut paket yöneticisini otomatik seçer:

Windows: `winget` → `scoop` → `choco`
macOS/Linux: `brew` → `apt`/`dnf`
Hepsi: `npm` → `pipx` → `pip` → `gem` → `cargo` → `go`

```bash
bridge install jq          # otomatik kurar
bridge describe jq         # kurulum planını gösterir
```

---

## Yapılandırma

`~/.cli-bridge/config.json`:

```json
{
  "server": { "host": "127.0.0.1", "port": 8791 },
  "exec": { "timeoutMs": 60000, "maxBuffer": 4194304 },
  "policy": {
    "mode": "denylist",
    "allowed": [],
    "denied": [],
    "allowShell": false,
    "blockDangerous": true
  },
  "redact": true,
  "mcp": { "exposeTools": true, "maxTools": 150 },
  "discovery": { "includeSystem": false, "scanTimeoutMs": 5000 }
}
```

---

## Kütüphane olarak kullanımı

```ts
import { registry, runOperation, runChain } from 'cli-bridge';

await registry.load();

const res = await runOperation('http.request', {
  input: { url: 'https://api.github.com/repos/nodejs/node' },
});

const piped = await runChain({
  steps: [
    { id: 'a', op: 'http.request', with: { url: 'https://api.github.com/repos/nodejs/node' } },
    { id: 'b', op: 'json.query', with: { filter: '$.stargazers_count' } },
  ],
});

console.log(piped.steps[1]?.json);
```

---

## Geliştirme

```bash
npm install
npm run build       # TypeScript -> dist
npm test            # 30 birim testi
node scripts/mcp-smoke.mjs   # MCP el sıkışma testi
```

## Lisans

MIT
