import { promises as fs } from "fs";

export function createStateFileStore({ dataDir, stateFile }) {
  async function ensureDataDir() {
    await fs.mkdir(dataDir, { recursive: true });
  }

  async function writeStatePayload(payload) {
    await ensureDataDir();

    const serialized = JSON.stringify(payload, null, 2);
    const tmpFile = `${stateFile}.tmp`;
    const backupFile = `${stateFile}.bak`;

    await fs.writeFile(tmpFile, serialized, "utf8");

    try {
      await fs.copyFile(stateFile, backupFile);
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error("PERSIST BACKUP ERROR:", err);
      }
    }

    await fs.rename(tmpFile, stateFile);
  }

  async function readStatePayload() {
    try {
      const raw = await fs.readFile(stateFile, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === "ENOENT") throw err;

      console.error("PRIMARY STATE READ FAILED, TRYING BACKUP:", err?.message || String(err));

      const rawBackup = await fs.readFile(`${stateFile}.bak`, "utf8");
      return JSON.parse(rawBackup);
    }
  }

  return {
    ensureDataDir,
    writeStatePayload,
    readStatePayload,
  };
}
