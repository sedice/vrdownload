package main

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/kardianos/service"
)

type item struct {
	FolderName string
	MainHTML   string
	Title      string
	Thumb      *string
}

type panorama struct {
	ID    int     `json:"id"`
	Folder string `json:"folder"`
	Title string  `json:"title"`
	Cover *string `json:"cover"`
	URL   string  `json:"url"`
}

type appProgram struct {
	downloadDir string
	port        int
	server      *http.Server
}

func main() {
	rootDir, err := resolveRootDir()
	if err != nil {
		log.Fatalf("resolve app root failed: %v", err)
	}
	program := &appProgram{
		downloadDir: filepath.Join(rootDir, "download"),
		port:        resolvePort(),
	}

	svcConfig := &service.Config{
		Name:        "download-vr",
		DisplayName: "Download VR Server",
		Description: "Serve and manage local VR panorama files.",
	}
	svc, err := service.New(program, svcConfig)
	if err != nil {
		log.Fatalf("create service failed: %v", err)
	}

	if len(os.Args) > 1 {
		if err := service.Control(svc, os.Args[1]); err != nil {
			log.Fatalf("service command failed: %v", err)
		}
		return
	}

	if err := svc.Run(); err != nil {
		log.Fatalf("service run failed: %v", err)
	}
}

func resolvePort() int {
	port := 3201
	if rawPort := os.Getenv("PORT"); rawPort != "" {
		parsed, parseErr := strconv.Atoi(rawPort)
		if parseErr == nil && parsed > 0 {
			port = parsed
		}
	}
	return port
}

func resolveRootDir() (string, error) {
	if cwd, err := os.Getwd(); err == nil {
		if st, statErr := os.Stat(filepath.Join(cwd, "download")); statErr == nil && st.IsDir() {
			return cwd, nil
		}
	}
	exePath, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Dir(exePath), nil
}

func (p *appProgram) Start(_ service.Service) error {
	go p.run()
	return nil
}

func (p *appProgram) run() {
	addr := fmt.Sprintf(":%d", p.port)
	p.server = &http.Server{
		Addr:    addr,
		Handler: newMux(p.downloadDir),
	}
	log.Printf("Server ready: http://localhost:%d", p.port)
	log.Printf("Serving static files from: %s", p.downloadDir)
	if err := p.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Printf("http server stopped with error: %v", err)
	}
}

func (p *appProgram) Stop(_ service.Service) error {
	if p.server == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return p.server.Shutdown(ctx)
}

func newMux(downloadDir string) *http.ServeMux {
	mux := http.NewServeMux()
	downloadHandler := http.StripPrefix("/download/", http.FileServer(http.Dir(downloadDir)))
	mux.Handle("/download/", downloadHandler)
	mux.HandleFunc("/default.mp3", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
			return
		}
		defaultMp3Path := filepath.Join(downloadDir, "default.mp3")
		if st, err := os.Stat(defaultMp3Path); err != nil || st.IsDir() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "audio/mpeg")
		http.ServeFile(w, r, defaultMp3Path)
	})
	mux.HandleFunc("/api/upload", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
			return
		}
		if err := r.ParseMultipartForm(512 << 20); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": fmt.Sprintf("解析表单失败: %v", err)})
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "缺少 file 字段"})
			return
		}
		defer file.Close()

		sessionName := strings.TrimSpace(r.FormValue("sessionName"))
		if sessionName == "" {
			sessionName = strings.TrimSpace(strings.TrimSuffix(header.Filename, filepath.Ext(header.Filename)))
		}
		if !isSafeSessionName(sessionName) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "sessionName 非法"})
			return
		}
		destDir := filepath.Join(downloadDir, sessionName)
		if err := removeDirAll(destDir); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": fmt.Sprintf("清理目录失败: %v", err)})
			return
		}
		if err := os.MkdirAll(destDir, 0o755); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": fmt.Sprintf("创建目录失败: %v", err)})
			return
		}
		if err := unzipMultipartToDir(file, header, destDir); err != nil {
			_ = removeDirAll(destDir)
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": fmt.Sprintf("解压失败: %v", err)})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true,
			"data": map[string]any{
				"folder": sessionName,
			},
		})
	})

	mux.HandleFunc("/api/folder/", func(w http.ResponseWriter, r *http.Request) {
		// Routes:
		// - GET    /api/folder/{folder}/settings
		// - PUT    /api/folder/{folder}/settings   { "title": "...", "cover": "relative/path.jpg" | null }
		// - DELETE /api/folder/{folder}
		//
		// NOTE: this is a hidden admin mode entry on the homepage; there is no auth.
		rest := strings.TrimPrefix(r.URL.Path, "/api/folder/")
		rest = strings.Trim(rest, "/")
		if rest == "" {
			http.NotFound(w, r)
			return
		}

		parts := strings.Split(rest, "/")
		folderName := parts[0]
		folderPath, ok := resolveSafeFolderPath(downloadDir, folderName)
		if !ok {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "folder 参数无效"})
			return
		}

		if len(parts) == 1 {
			// /api/folder/{folder}
			if r.Method != http.MethodDelete {
				w.Header().Set("Allow", http.MethodDelete)
				writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
				return
			}
			if err := removeDirAll(folderPath); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
			return
		}

		if len(parts) == 2 && parts[1] == "settings" {
			switch r.Method {
			case http.MethodGet:
				settings := readFolderSettings(folderPath)
				title := folderName
				if raw, ok := settings["title"].(string); ok && strings.TrimSpace(raw) != "" {
					title = strings.TrimSpace(raw)
				}
				var cover *string
				if rawCover, ok := settings["cover"].(string); ok && strings.TrimSpace(rawCover) != "" {
					trimmed := strings.TrimSpace(rawCover)
					cover = &trimmed
				}
				thumbs := normalizeStringList(settings["thumbJpgList"])
				if cover == nil && len(thumbs) > 0 {
					c := thumbs[0]
					cover = &c
				}
				writeJSON(w, http.StatusOK, map[string]any{
					"ok": true,
					"data": map[string]any{
						"title":  title,
						"cover":  cover,
						"thumbs": thumbs,
					},
				})
				return
			case http.MethodPut:
				var body struct {
					Title string  `json:"title"`
					Cover *string `json:"cover"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "JSON 格式无效"})
					return
				}
				settings := readFolderSettings(folderPath)
				if settings == nil {
					settings = map[string]any{}
				}
				settings["title"] = strings.TrimSpace(body.Title)

				thumbs := normalizeStringList(settings["thumbJpgList"])
				nextCover := ""
				if body.Cover != nil {
					nextCover = strings.TrimSpace(*body.Cover)
				}
				if nextCover != "" && containsString(thumbs, nextCover) {
					thumbs = append([]string{nextCover}, filterOut(thumbs, nextCover)...)
					settings["thumbJpgList"] = thumbs
					settings["cover"] = nextCover
				} else if len(thumbs) > 0 {
					settings["cover"] = thumbs[0]
				} else {
					settings["cover"] = nil
				}

				if err := writeFolderSettings(folderPath, settings); err != nil {
					writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
					return
				}
				writeJSON(w, http.StatusOK, map[string]any{"ok": true})
				return
			default:
				w.Header().Set("Allow", strings.Join([]string{http.MethodGet, http.MethodPut}, ", "))
				writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
				return
			}
		}

		http.NotFound(w, r)
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}

		data, scanErr := scanHTMLByFolder(downloadDir)
		if scanErr != nil {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(fmt.Sprintf("扫描 download 目录失败: %s", scanErr.Error())))
			return
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(renderHomePage(data)))
	})

	return mux
}

func isSafeSessionName(name string) bool {
	if strings.TrimSpace(name) == "" {
		return false
	}
	if strings.Contains(name, "/") || strings.Contains(name, "\\") {
		return false
	}
	if name == "." || name == ".." {
		return false
	}
	clean := filepath.Clean(name)
	return clean == name
}

func unzipMultipartToDir(file multipart.File, header *multipart.FileHeader, destDir string) error {
	readerAt, ok := file.(io.ReaderAt)
	if !ok {
		return fmt.Errorf("上传文件不可随机读取")
	}
	zr, err := zip.NewReader(readerAt, header.Size)
	if err != nil {
		return err
	}
	destAbs, err := filepath.Abs(destDir)
	if err != nil {
		return err
	}
	for _, f := range zr.File {
		name := filepath.Clean(f.Name)
		if name == "." || name == "" {
			continue
		}
		targetPath := filepath.Join(destDir, name)
		targetAbs, err := filepath.Abs(targetPath)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(destAbs, targetAbs)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return fmt.Errorf("zip 包含非法路径: %s", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(targetPath, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			return err
		}
		src, err := f.Open()
		if err != nil {
			return err
		}
		dst, err := os.OpenFile(targetPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			_ = src.Close()
			return err
		}
		_, copyErr := io.Copy(dst, src)
		closeErr := dst.Close()
		_ = src.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

func removeDirAll(path string) error {
	err := os.RemoveAll(path)
	if err == nil {
		return nil
	}
	if runtime.GOOS != "windows" {
		return err
	}
	// Windows 下某些异常文件名会导致 RemoveAll 返回 The parameter is incorrect。
	cmd := exec.Command("cmd", "/C", "rd", "/s", "/q", path)
	if runErr := cmd.Run(); runErr != nil {
		return fmt.Errorf("%w (fallback rd failed: %v)", err, runErr)
	}
	return nil
}

func scanHTMLByFolder(downloadDir string) ([]item, error) {
	entries, err := os.ReadDir(downloadDir)
	if err != nil {
		return nil, err
	}

	var folders []string
	for _, entry := range entries {
		if entry.IsDir() {
			folders = append(folders, entry.Name())
		}
	}
	sort.Strings(folders)

	var result []item
	for _, folderName := range folders {
		folderPath := filepath.Join(downloadDir, folderName)
		files, readErr := os.ReadDir(folderPath)
		if readErr != nil {
			return nil, readErr
		}

		var htmlFiles []string
		for _, file := range files {
			if !file.Type().IsRegular() {
				continue
			}
			name := file.Name()
			ext := strings.ToLower(filepath.Ext(name))
			if ext == ".html" || ext == ".htm" {
				htmlFiles = append(htmlFiles, name)
			}
		}
		sort.Strings(htmlFiles)
		if len(htmlFiles) == 0 {
			continue
		}

		mainHTML := htmlFiles[0]
		for _, name := range htmlFiles {
			if strings.EqualFold(name, folderName) {
				mainHTML = name
				break
			}
		}

		settings := readFolderSettings(folderPath)
		title := folderName
		if raw, ok := settings["title"].(string); ok && strings.TrimSpace(raw) != "" {
			title = strings.TrimSpace(raw)
		}

		var thumb *string
		if rawCover, ok := settings["cover"].(string); ok && strings.TrimSpace(rawCover) != "" {
			trimmed := strings.TrimSpace(rawCover)
			thumb = &trimmed
		}
		if rawList, ok := settings["thumbJpgList"].([]any); ok {
			for _, raw := range rawList {
				if v, strOK := raw.(string); strOK && strings.TrimSpace(v) != "" {
					trimmed := strings.TrimSpace(v)
					if thumb == nil {
						thumb = &trimmed
					}
					if rawCover, ok := settings["cover"].(string); ok && strings.TrimSpace(rawCover) == trimmed {
						thumb = &trimmed
						break
					}
				}
			}
		}

		result = append(result, item{
			FolderName: folderName,
			MainHTML:   mainHTML,
			Title:      title,
			Thumb:      thumb,
		})
	}

	return result, nil
}

func readFolderSettings(folderPath string) map[string]any {
	for _, file := range []string{"settings.json", "setting.json"} {
		p := filepath.Join(folderPath, file)
		raw, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var parsed map[string]any
		if unmarshalErr := json.Unmarshal(raw, &parsed); unmarshalErr != nil {
			continue
		}
		if parsed != nil {
			return parsed
		}
	}
	return nil
}

func writeFolderSettings(folderPath string, settings map[string]any) error {
	p := filepath.Join(folderPath, "settings.json")
	raw, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	return os.WriteFile(p, raw, 0o644)
}

func resolveSafeFolderPath(downloadDir, folderName string) (string, bool) {
	if strings.TrimSpace(folderName) == "" {
		return "", false
	}
	// Disallow path traversal / separators.
	if strings.Contains(folderName, "/") || strings.Contains(folderName, "\\") {
		return "", false
	}
	if folderName == "." || folderName == ".." {
		return "", false
	}
	clean := filepath.Clean(folderName)
	if clean != folderName {
		return "", false
	}
	abs := filepath.Join(downloadDir, folderName)
	absDownload, err1 := filepath.Abs(downloadDir)
	absFolder, err2 := filepath.Abs(abs)
	if err1 != nil || err2 != nil {
		return "", false
	}
	rel, err := filepath.Rel(absDownload, absFolder)
	if err != nil {
		return "", false
	}
	if rel == "." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || rel == ".." {
		return "", false
	}
	if st, err := os.Stat(absFolder); err != nil || !st.IsDir() {
		return "", false
	}
	return absFolder, true
}

func normalizeStringList(value any) []string {
	rawList, ok := value.([]any)
	if !ok || rawList == nil {
		return []string{}
	}
	out := make([]string, 0, len(rawList))
	seen := map[string]bool{}
	for _, raw := range rawList {
		s, ok := raw.(string)
		if !ok {
			continue
		}
		s = strings.TrimSpace(s)
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

func containsString(list []string, value string) bool {
	for _, v := range list {
		if v == value {
			return true
		}
	}
	return false
}

func filterOut(list []string, value string) []string {
	out := make([]string, 0, len(list))
	for _, v := range list {
		if v != value {
			out = append(out, v)
		}
	}
	return out
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(payload)
}

func encodeSlashPath(value string) string {
	parts := strings.Split(value, "/")
	encoded := make([]string, 0, len(parts))
	for _, part := range parts {
		if part == "" {
			continue
		}
		encoded = append(encoded, url.PathEscape(part))
	}
	return strings.Join(encoded, "/")
}

func renderHomePage(data []item) string {
	panoramaData := make([]panorama, 0, len(data))
	for i, it := range data {
		var cover *string
		if it.Thumb != nil {
			coverURL := "/download/" + url.PathEscape(it.FolderName) + "/" + encodeSlashPath(*it.Thumb)
			cover = &coverURL
		}
		pageURL := "/download/" + url.PathEscape(it.FolderName) + "/" + url.PathEscape(it.MainHTML)
		panoramaData = append(panoramaData, panorama{
			ID:    i + 1,
			Folder: it.FolderName,
			Title: it.Title,
			Cover: cover,
			URL:   pageURL,
		})
	}

	jsonBytes, _ := json.Marshal(panoramaData)
	panoramaDataJSON := strings.ReplaceAll(string(jsonBytes), "</script>", "<\\/script>")

	return strings.ReplaceAll(`<!doctype html>
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
        user-select: none;
      }
      header h1.admin-armed {
        opacity: 0.75;
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
        position: relative;
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
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .card-title {
        font-size: 16px;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
      }
      .copy-link-btn {
        border: 1px solid #d0d5dd;
        background: #fff;
        color: #344054;
        border-radius: 8px;
        padding: 5px 10px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .copy-link-btn:hover {
        background: #f9fafb;
      }
      .admin-toolbar {
        display: none;
        align-items: center;
        gap: 10px;
        width: 100%;
        margin-top: 6px;
      }
      body.admin-mode .admin-toolbar {
        display: flex;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 999px;
        background: #f2f4f7;
        border: 1px solid #e4e7ec;
        color: #101828;
        font-size: 12px;
      }
      .btn {
        appearance: none;
        border: 1px solid #d0d5dd;
        background: #fff;
        color: #344054;
        padding: 8px 12px;
        border-radius: 10px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
      }
      .btn:hover {
        background: #f9fafb;
      }
      .btn-danger {
        border-color: #fda29b;
        color: #b42318;
        background: #fff5f4;
      }
      .btn-danger:hover {
        background: #ffe4e2;
      }
      .btn-primary {
        border-color: #84caff;
        background: #eff8ff;
        color: #175cd3;
      }
      .btn-primary:hover {
        background: #d1e9ff;
      }
      .admin-actions {
        position: absolute;
        top: 10px;
        left: 10px;
        display: none;
        gap: 8px;
        z-index: 5;
      }
      body.admin-mode .admin-actions {
        display: flex;
      }
      .mini {
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 12px;
      }
      .modal {
        position: fixed;
        inset: 0;
        display: none;
        z-index: 1000;
      }
      .modal.show {
        display: block;
      }
      .modal-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(16, 24, 40, 0.55);
      }
      .modal-panel {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        width: min(880px, calc(100vw - 32px));
        background: #fff;
        border-radius: 16px;
        overflow: hidden;
        box-shadow: 0 20px 60px rgba(0,0,0,0.25);
      }
      .modal-header {
        padding: 16px 18px;
        border-bottom: 1px solid #eaecf0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .modal-title {
        font-size: 16px;
        font-weight: 700;
        color: #101828;
      }
      .modal-body {
        padding: 16px 18px 18px;
        display: grid;
        gap: 14px;
      }
      .field label {
        display: block;
        font-size: 12px;
        color: #475467;
        margin-bottom: 6px;
        font-weight: 600;
      }
      .field input {
        width: 100%;
        border: 1px solid #d0d5dd;
        border-radius: 10px;
        padding: 10px 12px;
        font-size: 14px;
        outline: none;
      }
      .field input:focus {
        border-color: #84caff;
        box-shadow: 0 0 0 4px rgba(46, 144, 250, 0.15);
      }
      .cover-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
        gap: 12px;
      }
      .cover-card {
        border: 2px solid transparent;
        background: #f9fafb;
        border-radius: 12px;
        overflow: hidden;
        cursor: pointer;
        padding: 0;
        aspect-ratio: 4/3;
        position: relative;
      }
      .cover-card img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .cover-card.is-selected {
        border-color: #2e90fa;
        box-shadow: 0 0 0 4px rgba(46, 144, 250, 0.15);
      }
      .modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        padding-top: 6px;
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
      <div style="display:flex; flex-direction:column; gap: 8px; width: 100%;">
        <h1 id="pageTitle">全景图漫游作品集</h1>
        <div class="admin-toolbar" id="adminToolbar">
          <span class="pill">管理模式已开启</span>
          <button type="button" class="btn" id="adminExitBtn">退出管理</button>
        </div>
      </div>
      <div class="search-container">
        <i class="search-icon"></i>
        <input type="text" id="searchInput" placeholder="搜索全景图..." />
      </div>
    </header>
    <main>
      <div class="gallery-grid" id="galleryGrid"></div>
    </main>
    <div class="modal" id="settingsModal" aria-hidden="true">
      <div class="modal-backdrop" id="modalBackdrop"></div>
      <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <div class="modal-header">
          <div class="modal-title" id="modalTitle">编辑</div>
          <button type="button" class="btn" id="modalCloseBtn">关闭</button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label for="settingsTitleInput">标题</label>
            <input id="settingsTitleInput" type="text" autocomplete="off" />
          </div>
          <div class="field">
            <label>封面</label>
            <div class="cover-grid" id="coverGrid"></div>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn" id="modalCancelBtn">取消</button>
            <button type="button" class="btn btn-primary" id="modalSaveBtn">保存</button>
          </div>
        </div>
      </div>
    </div>
    <script>
      const panoramaData = __PANORAMA_DATA__;
      const galleryGrid = document.getElementById("galleryGrid");
      const searchInput = document.getElementById("searchInput");
      const pageTitleEl = document.getElementById("pageTitle");
      const adminExitBtn = document.getElementById("adminExitBtn");
      const settingsModal = document.getElementById("settingsModal");
      const modalBackdrop = document.getElementById("modalBackdrop");
      const modalCloseBtn = document.getElementById("modalCloseBtn");
      const modalCancelBtn = document.getElementById("modalCancelBtn");
      const modalSaveBtn = document.getElementById("modalSaveBtn");
      const settingsTitleInput = document.getElementById("settingsTitleInput");
      const coverGrid = document.getElementById("coverGrid");
      const ADMIN_MODE_SESSION_KEY = "download_vr_admin_mode";
      const escapeHtml = (value) =>
        String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");

      let adminMode = false;
      let clickCount = 0;
      let lastClickAt = 0;
      let modalCtx = null; // { folder, thumbs, selectedCover }

      function setAdminMode(next) {
        adminMode = !!next;
        document.body.classList.toggle("admin-mode", adminMode);
        try {
          if (adminMode) {
            sessionStorage.setItem(ADMIN_MODE_SESSION_KEY, "1");
          } else {
            sessionStorage.removeItem(ADMIN_MODE_SESSION_KEY);
          }
        } catch (_) {
          // ignore storage unavailability
        }
      }

      function coverUrl(folder, relPath) {
        return "/download/" + encodeURIComponent(folder) + "/" + relPath.split("/").map(encodeURIComponent).join("/");
      }

      function showModal() {
        settingsModal.classList.add("show");
        settingsModal.setAttribute("aria-hidden", "false");
      }
      function hideModal() {
        settingsModal.classList.remove("show");
        settingsModal.setAttribute("aria-hidden", "true");
        modalCtx = null;
      }

      async function apiJson(url, opts) {
        const r = await fetch(url, opts);
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data || data.ok === false) {
          const msg = (data && data.error) ? data.error : ("HTTP " + r.status);
          throw new Error(msg);
        }
        return data;
      }

      function renderCoverGrid(thumbs, selected) {
        coverGrid.innerHTML = "";
        if (!thumbs || thumbs.length === 0) {
          coverGrid.innerHTML = '<div class="pill">未找到可用缩略图</div>';
          return;
        }
        thumbs.forEach((p) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "cover-card" + (p === selected ? " is-selected" : "");
          btn.innerHTML = '<img alt="封面候选" loading="lazy" src="' + coverUrl(modalCtx.folder, p) + '" />';
          btn.addEventListener("click", () => {
            modalCtx.selectedCover = p;
            renderCoverGrid(thumbs, p);
          });
          coverGrid.appendChild(btn);
        });
      }

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
          const adminActionsHtml =
            '<div class="admin-actions">' +
              '<button type="button" class="btn mini btn-primary" data-action="edit" data-folder="' + escapeHtml(item.folder) + '">编辑</button>' +
              '<button type="button" class="btn mini btn-danger" data-action="delete" data-folder="' + escapeHtml(item.folder) + '">删除</button>' +
            '</div>';
          const cardHTML =
            '<a href="' + item.url + '" class="card" title="查看 ' + safeTitle + '" data-folder="' + escapeHtml(item.folder) + '">' +
              adminActionsHtml +
              '<div class="card-cover">' +
                coverHtml +
                '<span class="badge-360">360° VR</span>' +
              "</div>" +
              '<div class="card-info">' +
                '<h3 class="card-title">' + safeTitle + "</h3>" +
                '<button type="button" class="copy-link-btn" data-action="copy-link" data-url="' + escapeHtml(item.url) + '">复制</button>' +
              "</div>" +
            "</a>";
          galleryGrid.insertAdjacentHTML("beforeend", cardHTML);
        });
      }

      renderGallery(panoramaData);
      try {
        setAdminMode(sessionStorage.getItem(ADMIN_MODE_SESSION_KEY) === "1");
      } catch (_) {
        setAdminMode(false);
      }

      searchInput.addEventListener("input", function (e) {
        const keyword = e.target.value.toLowerCase().trim();
        const filteredData = panoramaData.filter((item) => item.title.toLowerCase().includes(keyword));
        renderGallery(filteredData);
      });

      pageTitleEl.addEventListener("click", () => {
        const now = Date.now();
        if (now - lastClickAt > 1200) {
          clickCount = 0;
        }
        lastClickAt = now;
        clickCount += 1;
        pageTitleEl.classList.add("admin-armed");
        setTimeout(() => pageTitleEl.classList.remove("admin-armed"), 180);
        if (clickCount >= 12) {
          clickCount = 0;
          setAdminMode(true);
        }
      });

      adminExitBtn.addEventListener("click", () => {
        setAdminMode(false);
      });

      modalBackdrop.addEventListener("click", hideModal);
      modalCloseBtn.addEventListener("click", hideModal);
      modalCancelBtn.addEventListener("click", hideModal);

      galleryGrid.addEventListener("click", async (ev) => {
        const t = ev.target;
        if (!(t instanceof HTMLElement)) return;
        const actionEl = t.closest("[data-action]");
        if (!(actionEl instanceof HTMLElement)) return;
        const action = actionEl.getAttribute("data-action");
        if (!action) return;
        ev.preventDefault();
        ev.stopPropagation();

        if (action === "copy-link") {
          const rawURL = actionEl.getAttribute("data-url") || "";
          if (!rawURL) return;
          const fullURL = new URL(rawURL, location.origin).href;
          try {
            await navigator.clipboard.writeText(fullURL);
            alert("已复制链接: " + fullURL);
          } catch (_) {
            const ta = document.createElement("textarea");
            ta.value = fullURL;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            ta.remove();
            alert("已复制链接: " + fullURL);
          }
          return;
        }

        const folder = actionEl.getAttribute("data-folder");
        if (!folder) return;
        if (!adminMode) return;

        if (action === "delete") {
          const ok = confirm("确定要删除该目录吗？此操作不可恢复。");
          if (!ok) return;
          try {
            await apiJson("/api/folder/" + encodeURIComponent(folder), { method: "DELETE" });
            location.reload();
          } catch (err) {
            alert("删除失败: " + (err && err.message ? err.message : String(err)));
          }
          return;
        }

        if (action === "edit") {
          try {
            const res = await apiJson("/api/folder/" + encodeURIComponent(folder) + "/settings", { method: "GET" });
            const data = res.data || {};
            const title = (typeof data.title === "string") ? data.title : "";
            const thumbs = Array.isArray(data.thumbs) ? data.thumbs.filter((x) => typeof x === "string") : [];
            const selectedCover = (typeof data.cover === "string") ? data.cover : (thumbs[0] || null);
            modalCtx = { folder, thumbs, selectedCover };
            settingsTitleInput.value = title;
            document.getElementById("modalTitle").textContent = "编辑: " + folder;
            renderCoverGrid(thumbs, selectedCover);
            showModal();
            settingsTitleInput.focus();
          } catch (err) {
            alert("读取 settings 失败: " + (err && err.message ? err.message : String(err)));
          }
          return;
        }
      });

      modalSaveBtn.addEventListener("click", async () => {
        if (!modalCtx) return;
        modalSaveBtn.disabled = true;
        modalSaveBtn.textContent = "保存中…";
        try {
          await apiJson("/api/folder/" + encodeURIComponent(modalCtx.folder) + "/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: settingsTitleInput.value || "",
              cover: modalCtx.selectedCover
            })
          });
          hideModal();
          location.reload();
        } catch (err) {
          alert("保存失败: " + (err && err.message ? err.message : String(err)));
        } finally {
          modalSaveBtn.disabled = false;
          modalSaveBtn.textContent = "保存";
        }
      });
    </script>
  </body>
</html>`, "__PANORAMA_DATA__", panoramaDataJSON)
}
