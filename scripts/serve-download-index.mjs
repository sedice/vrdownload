import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const downloadDir = path.join(rootDir, "download");

const port = Number(process.env.PORT || 3201);
const app = express();

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function scanHtmlByFolder() {
  const items = await fs.readdir(downloadDir, { withFileTypes: true });
  const folders = items
    .filter((it) => it.isDirectory())
    .map((it) => it.name)
    .sort();

  const result = [];
  for (const folderName of folders) {
    const folderPath = path.join(downloadDir, folderName);
    const files = await fs.readdir(folderPath, { withFileTypes: true });
    const htmlFiles = files
      .filter((file) => file.isFile() && /\.(html?|HTML?)$/.test(file.name))
      .map((file) => file.name)
      .sort();

    if (htmlFiles.length === 0) continue;

    const preferredMain = htmlFiles.find(
      (name) => name.toLowerCase() === folderName.toLowerCase(),
    );
    const mainHtml = preferredMain || htmlFiles[0];
    const settings = await readFolderSettings(folderPath);
    const title =
      typeof settings?.title === "string" && settings.title.trim()
        ? settings.title.trim()
        : folderName;
    const thumb = Array.isArray(settings?.thumbJpgList)
      ? settings.thumbJpgList.find((it) => typeof it === "string" && it.trim())
      : null;
    result.push({ folderName, mainHtml, title, thumb: thumb || null });
  }

  return result;
}

async function readFolderSettings(folderPath) {
  const settingsJson = path.join(folderPath, "settings.json");
  const settingJson = path.join(folderPath, "setting.json");
  for (const p of [settingsJson, settingJson]) {
    try {
      const raw = await fs.readFile(p, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // ignore and fallback
    }
  }
  return null;
}

function encodeSlashPath(value) {
  return String(value)
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function renderHomePage(data) {
  const panoramaData = data.map(({ folderName, mainHtml, title, thumb }, index) => ({
    id: index + 1,
    title,
    cover: thumb
      ? `/download/${encodeURIComponent(folderName)}/${encodeSlashPath(thumb)}`
      : null,
    url: `/download/${encodeURIComponent(folderName)}/${encodeURIComponent(mainHtml)}`,
  }));
  const panoramaDataJson = JSON.stringify(panoramaData).replaceAll(
    "</script>",
    "<\\/script>",
  );

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>蓝图空间作品集</title>
    <style>
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        font-family: system-ui, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
        font-size: 14px;
        line-height: 1.5;
        color: #1e293b;
        background: #f8fafc;
      }
      h1, h2, h3, p {
        margin: 0;
      }
      header {
        width: min(1280px, 100%);
        margin: 0 auto;
        padding: 1.25rem 1.25rem 0.75rem;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 0.8rem;
      }
      .header-left h1 {
        font-size: 1.4rem;
        font-weight: 700;
        letter-spacing: 0.01em;
        color: #0f172a;
      }
      .header-left p {
        margin-top: 0.35rem;
        font-size: 0.875rem;
        color: #64748b;
      }
      .search-container {
        position: relative;
        width: min(360px, 48vw);
      }
      .search-container input {
        width: 100%;
        height: 38px;
        padding: 0.5rem 0.75rem 0.5rem 2rem;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        background: #fff;
        color: #1e293b;
        font: inherit;
        transition: border-color 0.15s, box-shadow 0.15s;
      }
      .search-container input::placeholder {
        color: #64748b;
      }
      .search-container input:focus {
        outline: none;
        border-color: #2563eb;
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
      }
      .search-icon {
        position: sticky;
        position: absolute;
        left: 12px;
        top: 50%;
        transform: translateY(-50%);
        width: 14px;
        height: 14px;
        border: 2px solid #94a3b8;
        border-radius: 50%;
      }
      .search-icon::after {
        content: "";
        position: absolute;
        width: 2px;
        height: 6px;
        background: #94a3b8;
        bottom: -5px;
        right: -3px;
        transform: rotate(-45deg);
      }
      main {
        width: min(1280px, 100%);
        margin: 0 auto;
        padding: 0 1.25rem 1.25rem;
      }
      .gallery-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
        gap: 1rem;
      }
      .card {
        background: #fff;
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        overflow: hidden;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
        transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s;
        cursor: pointer;
        text-decoration: none;
        color: inherit;
        display: block;
      }
      .card:hover {
        transform: translateY(-2px);
        border-color: #93c5fd;
        box-shadow: 0 8px 16px rgba(15, 23, 42, 0.08);
      }
      .card-cover {
        position: relative;
        width: 100%;
        padding-top: 60%;
        overflow: hidden;
        background: #f1f5f9;
        border-bottom: 1px solid #e2e8f0;
      }
      .card-cover img {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        transition: transform 0.3s ease;
      }
      .card:hover .card-cover img {
        transform: scale(1.03);
      }
      .cover-empty {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        display: grid;
        place-items: center;
        color: #64748b;
        font-size: 14px;
      }
      .badge-360 {
        position: absolute;
        top: 10px;
        right: 10px;
        background: rgba(15, 23, 42, 0.75);
        color: #fff;
        padding: 0.2rem 0.65rem;
        border-radius: 999px;
        font-size: 0.75rem;
        font-weight: 600;
        letter-spacing: 0.01em;
      }
      .card-info {
        padding: 0.85rem 0.9rem;
      }
      .card-title {
        font-size: 0.95rem;
        font-weight: 600;
        color: #0f172a;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .empty-state {
        text-align: center;
        padding: 3rem 1rem;
        color: #64748b;
        grid-column: 1 / -1;
        background: #fff;
        border: 1px dashed #cbd5e1;
        border-radius: 10px;
        font-size: 0.95rem;
      }
      @media (max-width: 900px) {
        header {
          align-items: flex-start;
          flex-direction: column;
        }
        .search-container {
          width: 100%;
        }
        .gallery-grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="header-left">
        <h1>蓝图空间作品集</h1>
        <p>首页风格已与 Electron 端保持一致</p>
      </div>
      <div class="search-container">
        <i class="search-icon"></i>
        <input type="text" id="searchInput" placeholder="搜索全景图..." />
      </div>
    </header>
    <main>
      <div class="gallery-grid" id="galleryGrid"></div>
    </main>
    <script>
      const panoramaData = ${panoramaDataJson};
      const galleryGrid = document.getElementById("galleryGrid");
      const searchInput = document.getElementById("searchInput");
      const escapeHtml = (value) =>
        String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");

      function renderGallery(data) {
        galleryGrid.innerHTML = "";
        if (data.length === 0) {
          galleryGrid.innerHTML = '<div class="empty-state">没有找到相关的蓝图空间作品</div>';
          return;
        }
        data.forEach((item) => {
          const safeTitle = escapeHtml(item.title);
          const coverHtml = item.cover
            ? '<img src="' + item.cover + '" alt="' + safeTitle + '" loading="lazy" />'
            : '<div class="cover-empty">暂无封面</div>';
          const cardHTML =
            '<a href="' + item.url + '" class="card" title="查看 ' + safeTitle + '">' +
              '<div class="card-cover">' +
                coverHtml +
                '<span class="badge-360">360° VR</span>' +
              "</div>" +
              '<div class="card-info">' +
                '<h3 class="card-title">' + safeTitle + "</h3>" +
              "</div>" +
            "</a>";
          galleryGrid.insertAdjacentHTML("beforeend", cardHTML);
        });
      }

      renderGallery(panoramaData);

      searchInput.addEventListener("input", function (e) {
        const keyword = e.target.value.toLowerCase().trim();
        const filteredData = panoramaData.filter((item) => item.title.toLowerCase().includes(keyword));
        renderGallery(filteredData);
      });
    </script>
  </body>
</html>`;
}

app.use("/download", express.static(downloadDir));

app.get("/", async (_req, res) => {
  try {
    const data = await scanHtmlByFolder();
    res.type("html").send(renderHomePage(data));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res
      .status(500)
      .type("text/plain")
      .send(`扫描 download 目录失败: ${message}`);
  }
});

app.listen(port, () => {
  console.log(`Server ready: http://localhost:${port}`);
  console.log(`Serving static files from: ${downloadDir}`);
});
