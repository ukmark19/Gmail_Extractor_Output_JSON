import archiver, { type Archiver } from "archiver";
import type { Writable } from "stream";
import type { ExportBundle } from "./export-formatter.js";

export interface AttachmentBufferEntry {
  storagePath: string; // e.g. attachments/<msg>/<...>
  buffer: Buffer;
}

/**
 * Stream the export bundle as a ZIP into the supplied writable.
 * The ZIP is rooted at `<rootDirName>/` and contains:
 *   - full_export.json
 *   - ai_ingestion.jsonl
 *   - attachments_index.json
 *   - export_manifest.json
 *   - processing_log.json
 *   - attachments/<messageId>/<partIdx>_<sha8>_<safe_filename>
 */
export async function streamExportZip(
  bundle: ExportBundle,
  attachmentBuffers: AttachmentBufferEntry[],
  rootDirName: string,
  out: Writable,
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

    // Add downloaded attachment binaries
    for (const att of attachmentBuffers) {
      archive.append(att.buffer, {
        name: `${root}/${att.storagePath}`,
      });
    }

    archive.finalize().catch((err) => reject(err));
  });
}
