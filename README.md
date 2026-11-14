# SquarePilot

SquarePilot là công cụ CLI local-first dành cho người vận hành nội dung cá nhân trên Binance Square, tự động kết hợp các chủ đề đang thịnh hành (Trending Topics) với kho góc nhìn được định nghĩa trước để dựng bản nháp bài đăng ngắn bằng tiếng Anh kèm thẻ ảnh đồ họa 1080x1350. Công cụ tự động hóa toàn bộ phần việc cơ khí như thu thập xu hướng, kiểm tra dữ liệu, đối chiếu giọng văn, đo cấu trúc hình dạng bài viết và kết xuất hình ảnh, trong khi vẫn giữ nguyên quyền quyết định góc nhìn cũng như bước duyệt đăng cuối cùng cho con người. Nguyên tắc cốt lõi của dự án là perspective-first và human-approved: hệ thống không tự sáng tác quan điểm mới và không viết bài điểm tin trung lập, mà chạy theo thang ưu tiên `angle -> lens -> tension -> stop` (nếu cạn cả ba bậc hoặc thiếu số liệu để dựng ảnh thì dừng hẳn, không đăng bài).

## Trạng thái

- **Khởi thảo đặc tả và kế hoạch (`2026-08-18` đến `2026-08-19`)**: Hoàn thành tài liệu đặc tả sản phẩm (PRD v1.0) và kế hoạch triển khai 7 phase (`status: approved`).
- **Phase 1: Nền móng (hoàn thành trong đợt `2026-08-18` đến `2026-09-30`)**: Đã dựng cấu hình TypeScript, ESLint, Vitest, bộ ghi log `logger`, bộ nạp cấu hình `config`, tầng cơ sở dữ liệu SQLite (`better-sqlite3`) với 9 bảng dữ liệu chính, và `llm-client` gọi OpenRouter theo chuẩn OpenAI-compatible (hỗ trợ phân tầng `free`/`paid`, tự động retry khi quá tải, chặn lỗi cắt cụt `finish_reason: 'length'`, và ghi nhận chi phí vào bảng `llm_calls`).
- **Phase 2: Trend Collector (hoàn thành, chạy kiểm chứng thực tế ngày `2026-08-21`)**: Đã dựng `trend-collector` dùng Playwright với persistent profile tại `~/.squarepilot/browser-profile` để vượt Cloudflare và trích xuất JSON từ thẻ `<script id="__APP_DATA">` trên trang trending của Binance Square, kèm `hashtag-reader` đọc các bài viết top qua endpoint `queryByHashtag`, bộ lọc ngưỡng lượt xem tối thiểu (`MIN_VIEW_COUNT = 500`) và bộ lọc tránh lặp lại chủ đề trong 14 ngày (`REUSE_WINDOW_DAYS = 14`).
- **Phase 3: Nguồn góc nhìn, Hình thức và Data Gate (hoàn thành, chạy kiểm chứng thực tế ngày `2026-08-22`)**: Đã dựng `angle-store`, `lens-store`, `evidence`, `topics`, `tension-finder`, `perspective-selector` (thang `angle -> lens -> tension -> stop` có ghi vết kiểm toán đầy đủ vào bảng `selections`), `mode-selector` (xoay vòng 6 hình thức trình bày) và `data-gate` kiểm tra tính khả thi của dữ liệu hình ảnh trước khi viết bài.
- **Phase 4: Drafter và Gate (hoàn thành phần mã nguồn ngày `2026-09-30`, bổ sung thang chọn neo cá nhân từ `2026-10-04` đến `2026-10-08`)**: Đã dựng `text-validation` (đếm ký tự NFC/NFD và trừ ngân sách cho hashtag trước khi cắt), `drafter`, `tone-gate`, `shape-scorer`, `persona-guard`, cùng cơ chế chọn neo tự động (`anchor.ts`, `anchor-bank.ts`, `recent-posts.ts`, migration v2 `draft_anchor_and_attempts`) và bộ kiểm thử hợp đồng với kho quy tắc giọng văn ngoài (tổng cộng 271 test trong 24 file kiểm thử tính đến lần đẩy code lên nhánh `main` ngày `2026-10-08`). Hiện còn 2 tiêu chí nghiệm thu cần thu thập qua các ngày chạy thực tế: sinh 5 bản nháp liên tiếp không trùng khuôn hình dạng và xem đủ 10 bản nháp qua CLI.
- **Phase 5: Visual Renderer (hoàn thành phần mã nguồn ngày `2026-09-30`)**: Đã dựng bộ kết xuất ảnh `satori` + `@resvg/resvg-js` tạo file PNG 1080x1350 dưới 1MB theo 8 `visual_type` và 2 `mood_variant`, cưỡng chế cứng giới hạn ký tự trên từng trường văn bản. Các hạng mục hoàn thiện còn lại gồm: kiểm thử kết xuất đủ cả 8 `visual_type` và đối chiếu lại một visual cũ từ schema tương ứng, bổ sung bước điền `focal_subline` và `risk_bar` từ phía model, và thêm lớp nền texture giấy cũ bằng PNG base64.
- **Bước tiếp theo (chưa triển khai)**:
  - Áp dụng bản cập nhật quy tắc cho các file giọng văn bên ngoài, duyệt kho `anchor-bank.md` sang trạng thái `approved`, và chạy thử nghiệm đầu-cuối thang chọn neo mới với LLM thật.
  - **Phase 6 (Publish và Duyệt)**: Xây dựng `square-client` đăng bài qua OpenAPI của Binance Square, `zalo-approver` gửi bản nháp kèm ảnh qua bot Zalo và nhận lệnh chữ kèm mã draft (`d K7` đăng, `v K7` viết lại, `a K7` đổi visual, `b K7 <số>` bỏ kèm lý do; tự hết hạn sau 6 giờ; ban đầu thiết kế cho Telegram, đổi sang Zalo ngày 2026-11-14; Zalo không có nút bấm nên duyệt bằng lệnh chữ), cùng `vault-writer` xuất bản nháp đã đăng thành file `.md` và `.png` trong kho lưu trữ.
  - **Phase 7 (Vận hành và Hiệu chỉnh)**: Thiết lập lịch chạy tự động bằng `launchd` trên macOS, xây dựng script thống kê tỉ lệ duyệt `npm run stats`, và hiệu chỉnh lại các ngưỡng lọc sau 20 bài đăng.

## Tech Stack

| Thành phần | Công nghệ / Thư viện | Phiên bản (`package.json`) | Vai trò trong dự án |
| :--- | :--- | :--- | :--- |
| Runtime | Node.js (ES Modules) | Node.js 20+ (theo `square-pilot-implementation-plan.md`; `package.json` không khai báo `engines`, chỉ có `@types/node`: `^22.0.0`) | Môi trường thực thi cục bộ (mục tiêu biên dịch `ES2022` trong `tsconfig.json`) |
| Ngôn ngữ | `typescript` | `^5.7.0` | Ngôn ngữ phát triển chính với cấu hình kiểm tra kiểu nghiêm ngặt (`strict`, `noUncheckedIndexedAccess`) |
| Cơ sở dữ liệu | `better-sqlite3` | `^11.0.0` | Lưu trữ SQLite cục bộ ở chế độ WAL (kèm `@types/better-sqlite3`: `^7.6.8`) |
| Trình duyệt tự động | `playwright` | `^1.62.1` | Mở trang Trending Topics của Binance Square qua Cloudflare bằng persistent profile |
| Dựng bố cục ảnh | `satori` | `^0.33.5` | Chuyển đổi cấu trúc thẻ thông tin sang định dạng SVG |
| Kết xuất PNG | `@resvg/resvg-js` | `^2.6.2` | Chuyển đổi SVG từ `satori` thành ảnh PNG kích thước 1080x1350 |
| Phân tích YAML | `yaml` | `^2.9.0` | Đọc phần frontmatter trong các file markdown góc nhìn (`angles`, `lenses`, `anchor-bank`) |
| Biến môi trường | `dotenv` | `^16.4.5` | Nạp cấu hình từ file `.env` vào `process.env` |
| Thực thi TS | `tsx` | `^4.7.0` | Chạy trực tiếp các kịch bản TypeScript trên dòng lệnh không cần bước build trung gian |
| Kiểm thử | `vitest` | `^2.0.0` | Chạy unit test và contract test |
| Kiểm tra mã nguồn | `eslint`, `@eslint/js`, `typescript-eslint` | `^9.0.0`, `^9.0.0`, `^8.0.0` | Kiểm tra quy tắc mã nguồn và phát hiện lỗi tĩnh trên `src` và `tests` |

## Cấu trúc thư mục

```text
SquarePilot/
├── src/
│   ├── collect/        # Thu thập Trending Topics bằng Playwright và đọc bài viết top dưới mỗi hashtag
│   ├── compose/        # Chọn mode, chọn neo (anchor), kiểm tra data gate, nạp file giọng văn ngoài, soạn thảo và chạy 3 cổng kiểm duyệt
│   ├── config/         # Đọc và kiểm tra tính hợp lệ của các biến môi trường ngay lúc khởi động
│   ├── database/       # Khởi tạo kết nối SQLite và thực thi các bước migration cho 9 bảng dữ liệu
│   ├── llm/            # Client gọi OpenRouter API, quản lý phân tầng model free/paid, retry và ghi log chi phí
│   ├── perspective/    # Đọc kho angles, lenses, anchor-bank, thu thập bằng chứng, phân loại chủ đề, tìm tension và chọn góc nhìn
│   ├── scripts/        # Các kịch bản CLI thực thi pipeline (hiện có dry-run.ts)
│   ├── utils/          # Các tiện ích dùng chung (hiện chứa bộ ghi log phân cấp logger.ts)
│   ├── visual/         # Nạp font chữ, định nghĩa bảng màu, dựng bố cục thẻ đồ họa, kiểm tra giới hạn ký tự và kết xuất PNG
│   └── pipeline.ts     # Điều phối luồng chạy chính từ bước đồng bộ kho góc nhìn đến khi tạo xong bản nháp và ảnh
├── tests/
│   ├── fixtures/       # Dữ liệu mẫu phục vụ kiểm thử (như bản chụp HTML trang trending trends-page.html)
│   └── *.test.ts       # Các file kiểm thử đơn vị và kiểm thử hợp đồng chạy bằng Vitest
├── .env.example        # File mẫu khai báo các biến môi trường cần thiết
├── eslint.config.js    # Cấu hình ESLint cho TypeScript
├── package.json        # Khai báo thông tin gói, các script npm và danh sách thư viện phụ thuộc
└── tsconfig.json       # Cấu hình trình biên dịch TypeScript
```

*Lưu ý khác biệt giữa tài liệu và code*: Kế hoạch triển khai (`square-pilot-implementation-plan.md`) phác thảo cấu trúc thư mục gồm `client/`, `collect/`, `perspective/`, `compose/`, `visual/`, `deliver/`, `utils/`. Trong mã nguồn thực tế, phần giao tiếp với OpenRouter được đặt tại `src/llm/`, bổ sung thêm `src/config/`, `src/database/`, `src/scripts/`, `src/client/` (upload ảnh và đăng bài qua Square OpenAPI) và `src/deliver/` (client Zalo, approver, mã draft) đã có code và test cho Phase 6 nhưng chưa được nối vào pipeline; `vault-writer` chưa có.

## Cách chạy

### Điều kiện tiên quyết

- Hệ điều hành macOS: Module kết xuất ảnh (`src/visual/fonts.ts`) đọc trực tiếp các file font chữ có sẵn trên macOS tại `/System/Library/Fonts/Supplemental/` (`Georgia.ttf`, `Times New Roman.ttf`, `Courier New.ttf`, `Arial.ttf`) hoặc `/Library/Fonts/Arial Unicode.ttf`.
- Node.js phiên bản 20 trở lên và `npm` (theo `square-pilot-implementation-plan.md`; `package.json` không khai báo `engines`).
- Trình duyệt Google Chrome đã cài đặt trên máy: `src/collect/browser.ts` khởi chạy Playwright với tùy chọn `channel: 'chrome'` và lưu persistent profile tại `~/.squarepilot/browser-profile`.
- Hai thư mục tài nguyên bên ngoài tồn tại trên đĩa và được khai báo trong `.env`:
  - Thư mục tại `CONTENT_CREATOR_DIR`: phải chứa đủ 3 file định nghĩa nhân vật và quy tắc giọng văn (`about-me.md`, `tone-guidelines.md`, `anti-ai-rules-en.md`), mỗi file dài ít nhất 200 ký tự.
  - Thư mục tại `VAULT_DIR`: chứa các thư mục con `angles/`, `lenses/`, file `anchor-bank.md` (tùy chọn), và bắt buộc phải có thư mục `outputs/square/` khi chạy tới bước viết nháp để đối chiếu lịch sử bài đăng.

### Cài đặt

1. Cài đặt các gói thư viện phụ thuộc bằng lệnh `npm install`.
2. Tạo file cấu hình môi trường cục bộ từ file mẫu bằng lệnh `cp .env.example .env` và điền các giá trị hợp lệ.

### Các script trong `package.json`

- `npm run dry-run` (`tsx src/scripts/dry-run.ts`): Chạy thử nghiệm pipeline mà không xuất bản bất kỳ nội dung nào. Nếu không truyền cờ nào, lệnh sẽ nạp cấu hình, khởi tạo cơ sở dữ liệu SQLite (tự động chạy migration) và in ra số lượng bản ghi hiện có trong 9 bảng. Kịch bản hỗ trợ các cờ dòng lệnh sau:
  - `--live-llm`: Gửi một yêu cầu kiểm tra kết nối (`smoke-test`) tới model miễn phí trên OpenRouter và ghi nhận vào bảng `llm_calls`.
  - `--live-collect`: Mở trình duyệt thu thập 10 Trending Topics thật từ Binance Square, đọc các bài viết top dưới mỗi hashtag, chạy thang chọn góc nhìn (`selectPerspective`), kiểm tra cổng dữ liệu (`runDataGate`) và chọn hình thức trình bày (`selectMode`).
  - `--headed`: Dùng kèm `--live-collect` để mở cửa sổ trình duyệt Chrome hiển thị trực tiếp (hữu ích khi cần vượt thử thách Cloudflare lần đầu cho profile mới).
  - `--live-draft`: Dùng kèm `--live-collect` để gọi LLM viết bản nháp cho ứng viên được chọn và chấm qua 3 cổng (`tone-gate`, `shape-scorer`, `persona-guard`).
  - `--render`: Dùng kèm `--live-collect --live-draft` để kết xuất thẻ ảnh PNG kích thước 1080x1350 vào thư mục `<VAULT_DIR>/outputs/visuals/square-auto` sau khi bản nháp vượt qua các cổng kiểm tra.
- `npm run db:init` (`tsx src/scripts/db-init.ts`): Được khai báo trong `package.json` để khởi tạo cơ sở dữ liệu riêng lẻ. *Lưu ý khác biệt*: File `src/scripts/db-init.ts` hiện không tồn tại trong kho mã nguồn; việc tạo cơ sở dữ liệu và chạy các bước migration hiện được thực hiện tự động thông qua hàm `initDb()` mỗi khi chạy `npm run dry-run`.
- `npm run lint` (`eslint src tests`): Chạy ESLint kiểm tra toàn bộ các file trong hai thư mục `src` và `tests`.
- `npm test` (`vitest run`): Chạy toàn bộ các bài kiểm thử một lần bằng Vitest.
- `npm run test:watch` (`vitest`): Chạy Vitest ở chế độ theo dõi và tự động chạy lại khi mã nguồn thay đổi.
- `npm run build` (`tsc`): Biên dịch mã nguồn TypeScript từ thư mục `src/` sang JavaScript tại thư mục `dist/`.

*Lưu ý khác biệt giữa tài liệu và code*: Kế hoạch triển khai Phase 7 có đề cập tới lệnh `npm run stats` để in bảng thống kê tỉ lệ duyệt bài, nhưng script này hiện chưa được khai báo trong `package.json` và chưa được cài đặt trong mã nguồn.

### Cơ chế lập lịch (Scheduling)

- **Trong mã nguồn hiện tại**: Chưa có file cấu hình lập lịch hay script khởi chạy nền cho scheduler; mọi lần chạy hiện được kích hoạt thủ công qua dòng lệnh với `npm run dry-run`.
- **Theo thiết kế trong PRD và Implementation Plan (Phase 7)**: Hệ thống sẽ chạy tự động trên máy Mac thông qua `launchd` 3 lần mỗi ngày vào lúc `07:00`, `13:00` và `20:00` (giờ Việt Nam, `Asia/Ho_Chi_Minh`), với hạn mức tự đặt tối đa 1 bài/ngày và sàn 0 bài. Dự án không dùng GitHub Actions để chạy pipeline thu thập dữ liệu vì Cloudflare chặn các yêu cầu từ địa chỉ IP của trung tâm dữ liệu.

## Cấu hình

Toàn bộ các biến môi trường trong `.env.example` và cách mã nguồn (`src/config/index.ts`) xử lý chúng:

| Biến môi trường | Bắt buộc (theo code hiện tại) | Giá trị mặc định trong code | Ý nghĩa |
| :--- | :--- | :--- | :--- |
| `OPENROUTER_API_KEY` | Có | Không có | Khóa xác thực API của OpenRouter dùng để gửi yêu cầu sinh văn bản và chấm giọng văn qua endpoint tương thích chuẩn OpenAI. |
| `OPENROUTER_MODEL_FREE` | Không | `nvidia/nemotron-3-ultra-550b-a55b:free` | Định danh model miễn phí trên OpenRouter, được dùng cho lần viết nháp đầu tiên (`attempt 1`) và dùng làm model giám khảo trong `tone-gate`. |
| `OPENROUTER_MODEL_PAID` | Không | `anthropic/claude-sonnet-5` | Định danh model trả phí trên OpenRouter, được gọi khi bản nháp trượt cổng kiểm tra ở lần đầu và phải viết lại. |
| `ZALO_BOT_TOKEN` | Có với `zalo:setup` và bước duyệt | Không có | Token của bot Zalo dùng riêng cho việc duyệt bài, đọc bởi `loadZaloConfig()`. Không in ra log; token nằm trong URL nên mọi lỗi đều được che. |
| `ZALO_CHAT_ID` | Có với bước duyệt | Không có | ID cuộc trò chuyện giữa bot và chủ tài khoản; lấy bằng `npm run zalo:setup` (nhắn một tin bất kỳ cho bot trong lúc script chờ). Tin từ chat khác bị bỏ qua. |
| `ZALO_API_BASE` | Không | `https://bot-api.zaloplatforms.com` | Đổi sang server giả khi test. |
| `BINANCE_SQUARE_OPENAPI_KEY` | Có với upload và đăng bài | Không có | Khóa OpenAPI của Binance Square, đọc bởi `resolveSquareKey()` trong `src/client/square-client.ts`: biến môi trường trước, sau đó tới file `~/.config/binance-square/openapi-key` (nên dùng file, quyền 600). Chỉ gửi qua header, không bao giờ in ra. |
| `CONTENT_CREATOR_DIR` | Có | Không có | Đường dẫn tới thư mục bên ngoài chứa các file quy tắc giọng văn và nhân vật (`about-me.md`, `tone-guidelines.md`, `anti-ai-rules-en.md`). Thư mục phải tồn tại trên đĩa khi khởi động. |
| `VAULT_DIR` | Có | Không có | Đường dẫn tới thư mục kho lưu trữ bên ngoài chứa `angles/`, `lenses/`, `anchor-bank.md` và `outputs/square/`. Thư mục phải tồn tại trên đĩa khi khởi động. |
| `SQUAREPILOT_DB_PATH` | Không | `~/.squarepilot/squarepilot.db` | Đường dẫn tùy chỉnh tới file cơ sở dữ liệu SQLite cục bộ (đang để dưới dạng chú thích trong `.env.example`). |
| `LOG_LEVEL` | Không | `info` | Mức độ chi tiết của log xuất ra thiết bị đầu cuối (`debug`, `info`, `warn`, `error`). |

## Ranh giới và an toàn

Hệ thống thực thi các ranh giới an toàn sau đây thông qua mã nguồn và thiết kế đặc tả:

- **Kiểm tra cấu hình nghiêm ngặt ngay khi khởi động (`src/config/index.ts`)**: Hàm `loadConfig()` kiểm tra sự tồn tại của mọi biến môi trường bắt buộc (`OPENROUTER_API_KEY`, `CONTENT_CREATOR_DIR`, `VAULT_DIR`) và xác nhận các đường dẫn thư mục thực sự tồn tại trên đĩa trước khi chạy bất kỳ tác vụ mạng hay trình duyệt nào. Các khóa API chỉ được đọc từ biến môi trường (hoặc file cấu hình riêng ở Phase 6), tuyệt đối không truyền qua tham số dòng lệnh.
- **Human-in-the-loop bắt buộc và không tự động đăng bài**: Không có nhánh mã nguồn nào tự động xuất bản nội dung lên Binance Square. Theo thiết kế Phase 6, mọi bài đăng đều phải có lệnh duyệt hợp lệ gửi từ đúng cuộc trò chuyện Zalo đã cấu hình (`ZALO_CHAT_ID`), và các bản nháp không phản hồi sẽ tự hết hạn sau 6 giờ. Ảnh duyệt trên điện thoại được upload lên kho ảnh của Square trước (Zalo chỉ nhận ảnh qua URL công khai), và khi duyệt thì bài đăng dùng lại đúng URL đó. HTTP 504 khi đăng được coi là đã đăng, để không bao giờ đăng trùng.
- **Thang ưu tiên góc nhìn có điểm dừng (`src/perspective/selector.ts`)**: Bộ chọn góc nhìn chạy tuần tự qua ba bậc `angle -> lens -> tension`; nếu không bậc nào thỏa mãn điều kiện, hàm trả về kết quả `stop` và pipeline dừng viết bài trong ngày hôm đó thay vì rơi về chế độ tóm tắt tin tức trung lập. Mọi ứng viên bị loại ở từng bậc (kể cả khi kết thúc bằng `stop`) đều được ghi vào cột `rejected_notes` của bảng `selections` để kiểm toán.
  - *Lưu ý khác biệt giữa tài liệu và code*: PRD (§4.3) và schema migration v1 có tạo bảng `tensions` riêng để lưu các mâu thuẫn được chấp nhận hoặc bị từ chối, nhưng trong code hiện tại (`src/perspective/selector.ts`), các `tension` bị loại được gom chung vào mảng `rejected` và lưu trực tiếp trong `selections.rejected_notes` chứ chưa ghi thành dòng riêng trong bảng `tensions`. Ngoài ra, bảng tổng hợp module tại PRD §4.2 ghi tầng database có 7 bảng, nhưng mục PRD §4.3 và code thực tế trong `src/database/migrations.ts` khởi tạo 9 bảng nghiệp vụ (`trends`, `angles`, `lenses`, `tensions`, `selections`, `drafts`, `visuals`, `posts`, `llm_calls`) cùng bảng quản lý `schema_migrations`.
- **Chống ghép nối gượng ép và chống bịa đặt bằng chứng (`src/perspective/`)**:
  - **Bậc `angle` (`angle-store.ts`, `selector.ts`)**: Chỉ xét các file có trạng thái bắt đầu bằng `unused`, có ngày hợp lệ và không cũ quá 30 ngày (`MAX_ANGLE_AGE_DAYS = 30`). Một `angle` chỉ được ghép với trend khi chia sẻ tối thiểu 2 từ khóa có nghĩa (`MIN_ANGLE_OVERLAP = 2`). Các dòng cảnh báo hoặc quy tắc chiến dịch trong thân file được trích xuất tự động qua `extractGuardrails()` và truyền thẳng vào prompt như giới hạn cứng.
  - **Bậc `lens` (`lens-store.ts`, `evidence.ts`)**: Mỗi file lens bắt buộc phải có `evidence_required` (nếu thiếu sẽ bị bỏ qua ngay khi đọc file) và tuân thủ thời gian nghỉ `cooldown_days` (mặc định 4 ngày, theo dõi số lần dùng và ngày dùng cuối trong SQLite tách biệt với file markdown). Trường `evidence_source` nếu không được khai báo rõ là `data` hay `docs` sẽ mặc định rơi về mức an toàn nhất là `author` (bắt buộc phải có ghi chú do con người cung cấp trong lần chạy đó, nếu không sẽ bị loại). Với nguồn `docs`, mọi câu trích dẫn đều phải được đối chiếu khớp chuỗi thực tế trong văn bản gốc qua hàm `verifyQuote()`.
  - **Bậc `tension` (`tension-finder.ts`)**: Chỉ chấp nhận các nhận định qua được hàm `validateClaim()`, yêu cầu độ dài tối thiểu 25 ký tự, không kết thúc bằng dấu chấm hỏi, không mở đầu bằng từ để hỏi (chặn câu hỏi tu từ), và bắt buộc chứa chữ số hoặc từ nối tương phản kèm bằng chứng trích xuất trực tiếp từ dữ liệu.
- **Tiền định neo cá nhân và giới hạn nhắc nghề (`src/compose/anchor.ts`, `persona-guard.ts`, `anchor-bank.ts`)**:
  - Thay vì để LLM tự chọn chi tiết ngôi thứ nhất, pipeline chạy hàm `resolveAnchor()` trước khi viết để chỉ định một trong bốn tầng `raw -> bank -> derived -> stance` và giao cùng bản chỉ dẫn đó cho cả `drafter` lẫn giám khảo `tone-gate` (bắt lỗi `E5 - fabricated` nếu bài viết tự bịa ra trải nghiệm nằm ngoài dữ liệu được cấp, hoặc `E5 - names the job` nếu nhắc nghề khi đã chạm trần).
  - Kho neo trải nghiệm `anchor-bank.md` chỉ được phép đọc khi trường frontmatter `status` có giá trị đúng bằng `approved`; ở mọi trạng thái khác, `parseAnchorBank()` không trả ra bất kỳ neo nào. Khi đã duyệt, hệ thống chỉ lấy neo khớp với `lens` đang dùng, đã qua thời gian nghỉ (`cooldown_days`, mặc định 30 ngày), và không chứa từ khóa nghề nghiệp nếu hạn ngạch đang bị khóa.
  - Tầng `derived` (mô tả hành động thực tế mà pipeline đã thực hiện trong lượt chạy như số bài đã đọc hoặc số lượt xem đã tra cứu) bị giới hạn tối đa 3 lần trong cửa sổ 10 bài đăng gần nhất (`DERIVED_MAX = 3`, `DERIVED_WINDOW = 10`).
  - Cổng `persona-guard.ts` quét 16 cụm từ nhận diện nghề nghiệp (hỗ trợ ranh giới từ Unicode) và giới hạn tối đa 1 bài được nhắc tới nghề trong cửa sổ 10 bài gần nhất (`PERSONA_CAP_MAX = 1`, `PERSONA_CAP_WINDOW = 10`). Lịch sử bài gần đây (`readRecentPosts()` trong `src/compose/recent-posts.ts`) gộp chung cả các bài viết tay trong `<VAULT_DIR>/outputs/square` và các bài trong bảng `posts` (khử trùng theo tên file hoặc `square_post_id`), đồng thời ném lỗi cứng nếu thư mục `outputs/square` không tồn tại để tránh việc cửa sổ rỗng làm tắt bộ chặn một cách âm thầm.
  - *Lưu ý khác biệt giữa tài liệu và code*: Kế hoạch triển khai Phase 4 ghi giới hạn của `persona-guard.ts` là 1 lần / 5 bài, nhưng mã nguồn hiện tại đặt `PERSONA_CAP_WINDOW = 10` (1 lần / 10 bài).
- **Quy tắc "Không có ảnh thì không có bài" và kiểm soát kết xuất đồ họa (`src/compose/data-gate.ts`, `src/visual/`)**:
  - Hàm `runDataGate()` chạy trước khi gọi LLM viết bài để kiểm tra 3 trường cốt lõi (`headline_1`, `focal_number`, `stat_tiles`). Nếu thiếu từ 2 trường cốt lõi trở lên hoặc không tìm được `focal_number` hợp lệ từ các bài viết top (hàm `extractNumbers()` tự động loại bỏ các số năm 4 chữ số dạng `19xx`/`20xx`, số nguyên nhỏ 1-2 chữ số không có đơn vị, và cắt bỏ dấu câu dính cuối), ứng viên đó bị loại ngay.
  - Không bao giờ cắt bớt chữ số của một con số dài để nhét vừa ô thống kê (nếu giá trị dài hơn `CAPS.stat_value = 8` thì bỏ qua ô đó để không biến số đúng thành số sai).
  - Hàm `assertCaps()` (`src/visual/layout.ts`) kiểm tra cứng giới hạn độ dài ký tự (`headline_line: 28`, `focal_number: 12`, `focal_subline: 20`, `stat_value: 8`, `bar: 45`, tối đa 4 `stat_tiles`) và ném lỗi `LayoutError` nếu vi phạm, tuyệt đối không tự co nhỏ font chữ.
  - Hình ảnh được dựng hoàn toàn bằng thuật toán xác định (`satori` + `@resvg/resvg-js`, không dùng model sinh ảnh) và hàm `renderVisual()` từ chối kết quả bằng lỗi `RenderError` nếu dung lượng file PNG vượt quá `MAX_BYTES = 1_000_000` (1MB).
- **Ba cổng kiểm duyệt bản nháp, cơ chế leo thang model và bảo vệ ngân sách ký tự (`src/compose/`)**:
  - **Cổng giọng văn (`tone-gate.ts`)**: Thực hiện kiểm tra cơ học (`checkMechanical()`) trước khi gọi model giám khảo, bao gồm: chặn 20 cụm từ sáo rỗng trong `FORBIDDEN_PHRASES`, cấm ký tự `em-dash` và `en-dash` (`BANNED_CHARS`), bắt buộc có dạng rút gọn từ (`contraction`), yêu cầu ít nhất 3 câu ngắn từ 2 đến 5 từ, và giới hạn tối đa 2 emoji. Nếu kiểm tra cơ học phát hiện lỗi, bản nháp bị trả về ngay mà không tốn lượt gọi model giám khảo. Khi gọi model giám khảo, nếu phản hồi không phân tích được ra JSON hợp lệ, cổng tự động đánh trượt (`ok: false`).
  - **Cổng hình dạng (`shape-scorer.ts`, `modes.ts`)**: Loại bỏ các `mode` đã dùng trong 3 bài đăng gần nhất (`MODE_COOLDOWN_POSTS = 3`; nếu cả 6 mode đều bị chặn thì dùng lại mode cũ nhất với cờ `forced: true`). Khoảng cách hình dạng bài viết được đo trên 6 chiều liên tục; nếu khoảng cách tới bài gần nhất nhỏ hơn `SAME_SHAPE = 0.15`, bài bị từ chối kèm các chỉ dẫn định lượng cụ thể.
    - *Lưu ý khác biệt giữa tài liệu và code*: PRD (§3.5 US#38) mô tả so sánh hình dạng với 5 bài gần nhất, nhưng trong code hiện tại (`src/pipeline.ts` và `src/compose/recent-posts.ts`), `readRecentPosts()` lấy mặc định `limit = PERSONA_CAP_WINDOW = 10` bài gần nhất và truyền toàn bộ danh sách này vào `checkShape()`.
  - **Cơ chế leo thang model (`compose-draft.ts`)**: Nếu bản nháp trượt bất kỳ cổng nào trong 3 cổng (`tone`, `shape`, `persona`), toàn bộ yêu cầu chỉnh sửa cụ thể được gom lại để viết lại (tối đa `maxAttempts = 3`).
    - *Lưu ý khác biệt giữa tài liệu và code*: PRD (§2 bước 5, §3.5 US#40) và chú thích trong `.env.example` ghi rằng chỉ chuyển sang model trả phí sau khi trượt cổng kiểm tra hai lần, nhưng trong code thực tế (`src/compose/compose-draft.ts`, dòng `const tier: Tier = attempt === 1 ? 'free' : 'paid'`), lần thử đầu tiên (`attempt 1`) dùng model `free` và ngay từ lần thử thứ hai (`attempt 2`, tức sau lần trượt đầu tiên) bộ viết nháp đã chuyển sang dùng model `paid` (trong khi `runToneGate` luôn chấm bằng tier `free`).
  - **Đếm ký tự NFD và bảo vệ hashtag (`text-validation.ts`)**: Đo độ dài theo chuẩn `NFD` để khớp với cách đếm của ứng dụng Binance Square (trần cứng `HARD_CAP_NFD = 2100`, ngưỡng cảnh báo `WARN_NFD = 1900`, mục tiêu `TARGET_NFC = 1600`). Hàm `composePost()` luôn trừ trước chi phí độ dài NFD của `#hashtag\n\n` khỏi ngân sách rồi mới cắt gọn phần thân bài theo ranh giới đoạn -> câu -> từ, đảm bảo hashtag định tuyến ở đầu bài không bao giờ bị cắt cụt. Hệ thống cũng không tự động suy ra cashtag (`$TOKEN`) từ trường `tradingPairs` của trend.
  - **Cashtag (`cashtags.ts`)**: Drafter được dặn chỉ gắn `$TICKER` cho coin mà bài thật sự nói tới, tối đa 3, mỗi coin một lần ở lần nhắc đầu. Code giữ luật đó sau khi model viết: cashtag không có căn cứ trong hashtag hay evidence bị bỏ dấu `$` (ca `#GoldReboundsNearly5%` bị Binance map sang `$ENA`), các acronym không phải coin (`SEC`, `ETF`, `CPI`...) không bao giờ thành cashtag, lần nhắc lặp và coin thứ tư trở đi trở lại thành chữ thường. Ngoại lệ duy nhất mà code tự thêm: coin được chính hashtag gọi tên (ví dụ `#BitcoinHits100K` gọi BTC) mà bài viết ghi `BTC` trần thì lần nhắc đầu được gắn `$`, vì Write to Earn trả hoa hồng khi người đọc giao dịch qua cashtag.
  - **Bảo toàn tệp quy tắc giọng văn ngoài (`prompt-assets.ts`)**: Các tệp quy tắc được đọc trực tiếp từ `CONTENT_CREATOR_DIR` ở mỗi lần chạy mà không sao chép vào repo. Mã nguồn không cắt cứng nội dung tệp theo số ký tự (tránh làm mất các quy tắc cấm ở cuối tệp), mà chỉ chọn các mục cần thiết (`TONE_SECTIONS = ['0', '1', '2', '3', '5']` cho `tone-guidelines.md`), báo lỗi `AssetError` nếu thiếu mục nào, và phát cảnh báo nếu tổng độ dài 3 tệp vượt ngân sách `VOICE_BUDGET_CHARS = 36_000`.
- **An toàn khi gọi LLM và thu thập dữ liệu (`src/llm/client.ts`, `src/collect/`)**:
  - `LlmClient` đặt ngân sách mặc định `DEFAULT_MAX_TOKENS = 4096` và coi phản hồi có `finish_reason === 'length'` là lỗi không thử lại (`retryable = false`), ngăn chặn rủi ro các model suy luận trả về phần nháp suy nghĩ nội bộ dang dở trông giống văn xuôi khi hết token. Chỉ các lỗi mạng, phản hồi rỗng hoặc mã trạng thái HTTP tạm thời (`429`, `>= 500`) mới được thử lại (tối đa 3 lần, chờ `1000ms` và `3000ms`). Mọi lần gọi thành công hay thất bại đều được lưu vào bảng `llm_calls`.
  - Bộ phân tích trang trending (`parseTrends()`) và bài viết hashtag (`parseHashtagPosts()`) kiểm tra cấu trúc JSON theo tên trường và ném lỗi rõ ràng (`TrendParseError`, `HashtagReadError`) khi thiếu trường hoặc danh sách rỗng, không bao giờ âm thầm trả về mảng rỗng khi cấu trúc dữ liệu của sàn thay đổi.

## Liên kết

Các tài liệu đặc tả, kế hoạch triển khai và nhật ký phiên làm việc của dự án được lưu trữ tại:

- Đặc tả sản phẩm (PRD v1.0): `/Users/lavopavden/Dev/vault/projects/square-pilot/prd/square-pilot-prd-v1.md`
- Kế hoạch triển khai (Implementation Plan): `/Users/lavopavden/Dev/vault/projects/square-pilot/square-pilot-implementation-plan.md`
- Nhật ký phiên làm việc (từ PRD đến hết Phase 5, `2026-09-30`): `/Users/lavopavden/Dev/vault/claude-sessions/square-pilot/2026-09-30-square-pilot-prd-den-phase5.md`
- Nhật ký phiên làm việc (gỡ xung đột Rule E5 với persona cap và thang chọn neo trước Phase 6, `2026-10-08`): `/Users/lavopavden/Dev/vault/claude-sessions/square-pilot/2026-10-08-square-pilot-e5-anchor-ladder.md`
