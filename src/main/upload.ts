import { createWriteStream } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { FormData } from "formdata-node";
import { fileFromPath } from "formdata-node/file-from-path";
import { FormDataEncoder } from "form-data-encoder";
import { ZipFile } from "yazl";

async function collectFiles(baseDir: string, dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      await collectFiles(baseDir, abs, out);
    } else if (e.isFile()) {
      out.push(relative(baseDir, abs).replaceAll("\\", "/"));
    }
  }
}

async function createZipFromDir(sourceDir: string): Promise<string> {
  const tmpBase = await mkdtemp(join(tmpdir(), "download-vr-upload-"));
  const zipPath = join(tmpBase, `${basename(sourceDir)}.zip`);
  const files: string[] = [];
  await collectFiles(sourceDir, sourceDir, files);
  await new Promise<void>((resolve, reject) => {
    const zip = new ZipFile();
    const output = createWriteStream(zipPath);
    output.on("close", () => resolve());
    output.on("error", reject);
    for (const rel of files) {
      zip.addFile(join(sourceDir, rel), rel);
    }
    zip.end();
    zip.outputStream.pipe(output);
  });
  return zipPath;
}

export async function uploadProcessedSession(args: {
  sourceDir: string;
  sessionName: string;
  serverUrl: string;
}): Promise<{ folder: string }> {
  const sourceStat = await stat(args.sourceDir);
  if (!sourceStat.isDirectory()) {
    throw new Error("处理目录不存在");
  }
  const normalizedServer = args.serverUrl.replace(/\/+$/, "");
  const endpoint = `${normalizedServer}/api/upload`;
  const zipPath = await createZipFromDir(args.sourceDir);
  try {
    const form = new FormData();
    form.set("sessionName", args.sessionName);
    form.set("file", await fileFromPath(zipPath, `${args.sessionName}.zip`, "application/zip"));
    const encoder = new FormDataEncoder(form);
    const body = Readable.from(encoder.encode());
    const response = await fetch(endpoint, {
      method: "POST",
      headers: encoder.headers,
      body,
      // @ts-expect-error Node fetch requires duplex with stream body.
      duplex: "half",
    });
    const data = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: string; data?: { folder?: string } }
      | null;
    if (!response.ok || !data?.ok) {
      const msg = data?.error || `HTTP ${response.status}`;
      throw new Error(msg);
    }
    return { folder: data.data?.folder || args.sessionName };
  } finally {
    await rm(zipPath, { force: true }).catch(() => undefined);
    await rm(join(zipPath, ".."), { recursive: true, force: true }).catch(() => undefined);
  }
}
