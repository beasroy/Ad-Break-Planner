import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { config } from "../config";

/** Where multipart uploads land before they are moved into place. */
export const uploadDir = path.join(config.dataDir, "_uploads");

/**
 * Disk storage that (re)creates the upload folder for every file, so deleting data/ while the
 * server runs never breaks uploads with ENOENT.
 */
export const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      fs.mkdirSync(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (err) {
      cb(err as Error, uploadDir);
    }
  },
});
