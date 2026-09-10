<div align="center">

<img src="https://img.shields.io/badge/Tampermonkey-userscript-00485B?style=for-the-badge&logo=tampermonkey&logoColor=white" alt="Tampermonkey userscript">
<img src="https://img.shields.io/badge/license-CC%20BY%204.0-6daa45?style=for-the-badge" alt="CC BY 4.0">
<img src="https://img.shields.io/badge/size-~19%20KB-797876?style=for-the-badge" alt="~19 KB">
<img src="https://img.shields.io/badge/network-instagram.com%20only-437a22?style=for-the-badge" alt="No third-party requests">

<br/><br/>

# 📸 Instagram Oldest Posts — Full Post History & Metadata Extractor

**A Tampermonkey userscript (+ legacy console scripts) for reconstructing a profile's full available post history on Instagram.**
Export any accessible Instagram profile's posts to **CSV** or **JSON** — with resumable, retry-safe pagination that reaches deeper than Instagram's own infinite scroll.

<br/>

</div>

---

## ✨ Features

- 🕵️ **Intercepts Instagram's own authenticated pagination request** — no third-party API or credentials needed
- 🧬 **DOM-seeds initially rendered posts** — recovers the posts Instagram renders on page load without ever sending an XHR
- ⏪ **Backward pagination** (`before`/`last`) fills in missing publish dates for those DOM-seeded posts
- 🔁 **Auto-retry with exponential backoff** on HTTP 429/503 and network errors
- 💾 **Resumable** — pauses, closed tabs, or crashes pick up from the last saved checkpoint (`localStorage`)
- 🧹 **Dedup by shortcode** — no duplicate rows even across multiple resumed sessions
- 📊 **Two export formats** — CSV (flat table) and JSON (full structured array)
- 🌐 **English and Russian UI builds**, identical logic
- 🚫 **No servers, no third-party APIs, no analytics** — everything runs in your own browser tab

---

## 🚀 Installation

### Option A — Tampermonkey userscript *(recommended)*

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open Tampermonkey → **Create a new script**.
3. Paste the full contents of [`instagram-oldest-posts.user.js`](./instagram-oldest-posts.user.js) (English UI) or [`instagram-oldest-posts.ru.user.js`](./instagram-oldest-posts.ru.user.js) (Russian UI).
4. Save (**Ctrl+S**). A control panel will appear on any `instagram.com` page.

### Option B — Manual console scripts *(legacy)*

For environments where browser extensions aren't allowed. No UI, no retries, no resume.

<details>
<summary><b>▶ Show legacy usage</b></summary>

1. Log in to Instagram and open the target profile.
2. Open Chrome DevTools → **Console**.
3. Paste and run [`legacy/capture.js`](./legacy/capture.js).
4. Scroll the profile until the console prints `IG XHR CAPTURED`.
5. Paste and run [`legacy/collect.js`](./legacy/collect.js), wait for `TOTAL ...`.
6. Paste and run [`legacy/export-csv.js`](./legacy/export-csv.js) to download `instagram_posts.csv`.

</details>

---

## 🎬 How to use

```text
1. Open   →  the target Instagram profile, do NOT scroll yet
2. Click  →  "0. Scan DOM"              (grabs posts rendered before any scroll)
3. Click  →  "1. Auto-scroll + capture" (waits until the pagination request is intercepted)
4. Click  →  "2. Collect"               (walks pagination forward until Instagram reports the end)
5. Click  →  "CSV" or "JSON"            (downloads the deduplicated result)
6. If it stops early → "Resume" continues from the last checkpoint
   To start clean     → "New capture" clears saved state
```

---

## 📤 Export formats

| Format | Structure | Best for |
| :-- | :-- | :-- |
| **CSV** | Flat `date,time,code,url` rows, sorted oldest → newest | Excel, Google Sheets |
| **JSON** | Full array of `{code, id, taken_at, url}` objects | Python/pandas, further scripting |

---

## 🔬 How data is collected

Three complementary sources are merged to cover the full timeline:

| Strategy | Targets | What it captures |
| :-- | :-- | :-- |
| **DOM seed** | `<a href="/p/...">` links rendered on initial page load | Posts shown before any XHR ever fires (server-side rendered) |
| **Backward pagination** (`before`/`last`) | Same GraphQL connection, reversed | Publish dates for the DOM-seeded posts |
| **Forward pagination** (`after`/`first`) | Same GraphQL connection | All older posts, walked page by page via cursor |

---

## 🔒 Privacy & security

- Uses only **your own authenticated Instagram session** — no credentials are collected or sent anywhere else
- Makes requests **only to instagram.com** endpoints — no third-party servers
- Stores progress **only in `localStorage`** on your machine (pagination cursor + collected posts), so you can resume after closing the tab
- **Do not share** captured request headers, cookies, or CSRF tokens — they are tied to your personal session

---

## 📄 License

**[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)**

Built by **Pavel "Pogoda" Bannikov** for [Provereno.Media](https://provereno.media), 2026.
Original concept and v1 scripts co-authored with **Vasyl Kozak**.
