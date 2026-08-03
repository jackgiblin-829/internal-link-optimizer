import { promises as fs } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dirname, "..", "data", "runs");

async function ensureDir() {
  await fs.mkdir(DIR, { recursive: true });
}

// IDs are caller-supplied (Date.now-based) so this module stays deterministic.
export async function saveRun(id, record) {
  await ensureDir();
  await fs.writeFile(join(DIR, `${id}.json`), JSON.stringify(record, null, 2));
  return id;
}

export async function listRuns() {
  await ensureDir();
  const files = (await fs.readdir(DIR)).filter((f) => f.endsWith(".json"));
  const runs = await Promise.all(
    files.map(async (f) => {
      try {
        const r = JSON.parse(await fs.readFile(join(DIR, f), "utf8"));
        return {
          id: r.id,
          date: r.date,
          url: r.input?.article,
          domain: r.input?.domain,
          addedCount: r.result?.added?.length ?? 0,
          title: r.result?.title || "",
        };
      } catch {
        return null;
      }
    })
  );
  return runs.filter(Boolean).sort((a, b) => (b.id > a.id ? 1 : -1));
}

export async function getRun(id) {
  try {
    return JSON.parse(await fs.readFile(join(DIR, `${String(id).replace(/[^0-9a-z_-]/gi, "")}.json`), "utf8"));
  } catch {
    return null;
  }
}
