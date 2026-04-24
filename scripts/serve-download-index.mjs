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
    <title>全景图作品集</title>
    <style>
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        background-color: #f5f7fa;
        color: #333;
      }
      header {
        background-color: #ffffff;
        padding: 20px 5%;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
        position: sticky;
        top: 0;
        z-index: 100;
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: 15px;
      }
      header h1 {
        font-size: 24px;
        color: #1a1a1a;
        font-weight: 600;
      }
      .search-container {
        position: relative;
        width: 100%;
        max-width: 300px;
      }
      .search-container input {
        width: 100%;
        padding: 10px 15px 10px 40px;
        border: 1px solid #e0e0e0;
        border-radius: 20px;
        font-size: 14px;
        outline: none;
        transition: border-color 0.3s;
        background-color: #f9f9f9;
      }
      .search-container input:focus {
        border-color: #007bff;
        background-color: #fff;
      }
      .search-icon {
        position: absolute;
        left: 12px;
        top: 50%;
        transform: translateY(-50%);
        width: 14px;
        height: 14px;
        border: 2px solid #888;
        border-radius: 50%;
      }
      .search-icon::after {
        content: "";
        position: absolute;
        width: 2px;
        height: 6px;
        background: #888;
        bottom: -5px;
        right: -3px;
        transform: rotate(-45deg);
      }
      main {
        padding: 30px 5%;
        min-height: calc(100vh - 80px);
      }
      .gallery-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 25px;
      }
      .card {
        background: #fff;
        border-radius: 12px;
        overflow: hidden;
        box-shadow: 0 4px 15px rgba(0, 0, 0, 0.05);
        transition: transform 0.3s ease, box-shadow 0.3s ease;
        cursor: pointer;
        text-decoration: none;
        color: inherit;
        display: block;
      }
      .card:hover {
        transform: translateY(-5px);
        box-shadow: 0 8px 25px rgba(0, 0, 0, 0.1);
      }
      .card-cover {
        position: relative;
        width: 100%;
        padding-top: 60%;
        overflow: hidden;
        background-color: #eef;
      }
      .card-cover img {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        transition: transform 0.5s ease;
      }
      .card:hover .card-cover img {
        transform: scale(1.05);
      }
      .cover-empty {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        display: grid;
        place-items: center;
        color: #667085;
        font-size: 14px;
      }
      .badge-360 {
        position: absolute;
        top: 12px;
        right: 12px;
        background: rgba(0, 0, 0, 0.6);
        color: #fff;
        padding: 4px 10px;
        border-radius: 15px;
        font-size: 12px;
        font-weight: bold;
        letter-spacing: 1px;
        backdrop-filter: blur(4px);
      }
      .card-info {
        padding: 18px 16px;
      }
      .card-title {
        font-size: 16px;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .empty-state {
        text-align: center;
        padding: 50px;
        color: #888;
        grid-column: 1 / -1;
        font-size: 16px;
      }
      @media (max-width: 600px) {
        .search-container {
          max-width: 100%;
        }
        header {
          flex-direction: column;
          align-items: flex-start;
          padding: 15px 5%;
        }
        .gallery-grid {
          grid-template-columns: repeat(auto-fill, minmax(100%, 1fr));
        }
      }
    </style>
  </head>
  <body>
    <header>
      <h1>全景图漫游作品集</h1>
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
          galleryGrid.innerHTML = '<div class="empty-state">没有找到相关的全景图作品</div>';
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
