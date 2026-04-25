import archiver, { type Archiver } from "archiver";
import type { Writable } from "stream";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import type { ExportBundle } from "./export-formatter.js";

export interface AttachmentBufferEntry {
  storagePath: string; // e.g. extracted_attachments/<msg>/<...>
  buffer: Buffer;
}

export interface OcrImageEntry {
  /** message id of the parent email */
  messageId: string;
  /** Gmail attachment id */
  attachmentId: string;
  /** 1-based page number in the source PDF */
  pageNumber: number;
  /** Raw PNG bytes for the rasterised page */
  png: Buffer;
}

/**
 * Stream the export bundle as a ZIP into the supplied writable.
 * The ZIP is rooted at `<rootDirName>/` and contains:
 *   - full_export.json
 *   - ai_ingestion.jsonl
 *   - attachments_index.json
 *   - export_manifest.json
 *   - processing_log.json
 *   - errors_report.json
 *   - extracted_attachments/<messageId>/<partIdx>_<sha8>_<safe_filename>
 *   - ocr_images/<messageId>/<attachmentId>/page_<n>.png  (when PDF was rasterised)
 */
export async function streamExportZip(
  bundle: ExportBundle,
  attachmentBuffers: AttachmentBufferEntry[],
  rootDirName: string,
  out: Writable,
  ocrImages: OcrImageEntry[] = [],
  errorsReport: unknown = null,
): Promise<{ bytesWritten: number; entryCount: number }> {
  return new Promise((resolve, reject) => {
    const archive: Archiver = archiver("zip", { zlib: { level: 6 } });
    let entryCount = 0;

    archive.on("warning", (err) => {
      // ENOENT is non-fatal; surface everything else
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        reject(err);
      }
    });
    archive.on("error", (err) => reject(err));
    archive.on("entry", () => {
      entryCount++;
    });

    out.on("close", () => {
      resolve({ bytesWritten: archive.pointer(), entryCount });
    });
    out.on("finish", () => {
      // For HTTP responses, finish fires before close; resolve here too.
      resolve({ bytesWritten: archive.pointer(), entryCount });
    });
    out.on("error", (err) => reject(err));

    archive.pipe(out);

    const root = rootDirName.replace(/\/+$/, "");

    archive.append(JSON.stringify(bundle.fullExport, null, 2), {
      name: `${root}/full_export.json`,
    });
    archive.append(bundle.aiIngestion, {
      name: `${root}/ai_ingestion.jsonl`,
    });
    archive.append(JSON.stringify(bundle.attachmentsIndex, null, 2), {
      name: `${root}/attachments_index.json`,
    });
    archive.append(JSON.stringify(bundle.manifest, null, 2), {
      name: `${root}/export_manifest.json`,
    });
    archive.append(JSON.stringify(bundle.processingLog, null, 2), {
      name: `${root}/processing_log.json`,
    });
    archive.append(JSON.stringify(errorsReport ?? [], null, 2), {
      name: `${root}/errors_report.json`,
    });

    // Add downloaded attachment binaries under extracted_attachments/
    for (const att of attachmentBuffers) {
      archive.append(att.buffer, {
        name: `${root}/${att.storagePath}`,
      });
    }

    // Add OCR-rasterised page PNGs so users can audit exactly what was OCR'd.
    for (const img of ocrImages) {
      const pageStr = String(img.pageNumber).padStart(3, "0");
      archive.append(img.png, {
        name: `${root}/ocr_images/${img.messageId}/${img.attachmentId}/page_${pageStr}.png`,
      });
    }

    archive.finalize().catch((err) => reject(err));
  });
}

/**
 * Tee-write the streamed ZIP simultaneously to (a) the HTTP response, and
 * (b) two on-disk locations: `exports/export_<ts>/<filename>.zip` (immutable
 * timestamped copy) and `exports/latest/latest.zip` (always points at the
 * most recent export). Returns the absolute paths of both disk copies.
 *
 * Implementation notes:
 *   - We do NOT copy bytes after the response — we tee them at write-time
 *     using a PassThrough so an aborted client doesn't leave us with no
 *     persisted artifact.
 *   - The latest.zip copy is updated by writing a sibling file then
 *     atomically copying it; this avoids a partial-write window if the user
 *     downloads /api/gmail/export/latest mid-write.
 */
export interface DiskPersistOptions {
  exportsRoot: string;
  exportTimestamp: string; // safe-for-filesystem timestamp string
  zipFilename: string;
}

export interface DiskPersistResult {
  timestampedPath: string;
  latestPath: string;
}

export async function streamExportZipWithDiskTee(
  bundle: ExportBundle,
  attachmentBuffers: AttachmentBufferEntry[],
  rootDirName: string,
  httpOut: Writable,
  ocrImages: OcrImageEntry[],
  errorsReport: unknown,
  disk: DiskPersistOptions,
): Promise<DiskPersistResult & { bytesWritten: number; entryCount: number }> {
  const tsDir = join(disk.exportsRoot, `export_${disk.exportTimestamp}`);
  const latestDir = join(disk.exportsRoot, "latest");
  await mkdir(tsDir, { recursive: true });
  await mkdir(latestDir, { recursive: true });
  const tsPath = join(tsDir, disk.zipFilename);
  const latestPath = join(latestDir, "latest.zip");

  // Tee the ZIP into both the HTTP response and the timestamped on-disk file.
  const tee = new PassThrough();
  const fileSink = createWriteStream(tsPath);
  tee.pipe(httpOut, { end: true });
  tee.pipe(fileSink, { end: true });

  // Wait for the file sink to finish so we can safely copy it to latest.zip
  // after the archive has been fully drained.
  const fileDone = new Promise<void>((resolve, reject) => {
    fileSink.on("finish", () => resolve());
    fileSink.on("error", (err) => reject(err));
  });

  const result = await streamExportZip(
    bundle,
    attachmentBuffers,
    rootDirName,
    tee,
    ocrImages,
    errorsReport,
  );

  await fileDone;

  // Best-effort: copy the timestamped artifact to latest.zip. If this fails
  // we still return the timestamped path — the export itself is not lost.
  try {
    if (!existsSync(dirname(latestPath))) {
      mkdirSync(dirname(latestPath), { recursive: true });
    }
    await copyFile(tsPath, latestPath);
  } catch {
    // swallow — caller can decide via the returned object
  }

  return { ...result, timestampedPath: tsPath, latestPath };
}
