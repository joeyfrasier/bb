import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { WorkspaceMutationAdmission } from "./workspace-mutation-admission.js";

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), "bb-admission-"));
  const root = path.join(base, "workspace");
  await mkdir(root);
  const storage = path.join(base, "private");
  return {
    base,
    root,
    storage,
    admission: new WorkspaceMutationAdmission(storage),
  };
}
describe("workspace retirement admission", () => {
  it("drains an admitted write before retirement, then refuses late writes", async () => {
    const f = await fixture();
    try {
      let admitted!: () => void;
      const started = new Promise<void>((r) => {
        admitted = r;
      });
      let finish!: () => void;
      const release = new Promise<void>((r) => {
        finish = r;
      });
      const writing = f.admission.mutate(
        [path.join(f.root, "note")],
        async () => {
          admitted();
          await release;
          await writeFile(path.join(f.root, "note"), "unique");
        },
      );
      await started;
      const removal = f.admission.protect(
        f.root,
        "generation",
        true,
        async () => {
          expect(await readFile(path.join(f.root, "note"), "utf8")).toBe(
            "unique",
          );
        },
      );
      finish();
      await Promise.all([writing, removal]);
      await expect(
        f.admission.mutate([path.join(f.root, "late")], async () => {}),
      ).rejects.toThrow("WORKSPACE_RETIRING");
    } finally {
      await rm(f.base, { recursive: true, force: true });
    }
  });
  it("cancels a drain without running deletion or reopening admission", async () => {
    const f = await fixture();
    let finish!: () => void;
    try {
      let admitted!: () => void;
      const started = new Promise<void>((resolve) => {
        admitted = resolve;
      });
      const write = f.admission.mutate(
        [path.join(f.root, "pending")],
        async () => {
          admitted();
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
      );
      await started;
      const controller = new AbortController();
      let deleted = false;
      const retirement = f.admission.protect(
        f.root,
        "generation",
        true,
        async () => {
          deleted = true;
        },
        controller.signal,
      );
      controller.abort();
      await expect(retirement).rejects.toThrow();
      expect(deleted).toBe(false);
      finish();
      await write;
      await expect(
        f.admission.mutate([path.join(f.root, "late")], async () => {}),
      ).rejects.toThrow("WORKSPACE_RETIRING");
    } finally {
      finish?.();
      await rm(f.base, { recursive: true, force: true });
    }
  });
  it("retains tombstones across restart and failure", async () => {
    const f = await fixture();
    try {
      await expect(
        f.admission.protect(f.root, "generation", true, async () => {
          throw new Error("copy failed");
        }),
      ).rejects.toThrow("copy failed");
      const restarted = new WorkspaceMutationAdmission(f.storage);
      await expect(
        restarted.mutate([path.join(f.root, "late")], async () => {}),
      ).rejects.toThrow("WORKSPACE_RETIRING");
      await expect(
        restarted.protect(f.root, "other-generation", true, async () => {}),
      ).rejects.toThrow("WORKSPACE_GENERATION_CHANGED");
    } finally {
      await rm(f.base, { recursive: true, force: true });
    }
  });
  it("covers move sources and destinations, ancestors, and path aliases", async () => {
    const f = await fixture();
    try {
      const alias = path.join(f.base, "alias");
      await symlink(f.root, alias);
      await f.admission.protect(f.root, "generation", true, async () => {});
      for (const targets of [
        [f.base],
        [path.join(f.base, "outside"), path.join(f.root, "destination")],
        [path.join(alias, "note")],
      ]) {
        await expect(
          f.admission.mutate(targets, async () => {}),
        ).rejects.toThrow("WORKSPACE_RETIRING");
      }
      await f.admission.mutate(
        [path.join(f.base, "unrelated")],
        async () => {},
      );
    } finally {
      await rm(f.base, { recursive: true, force: true });
    }
  });
  it("reopens a successful provision but retains failed provision admission", async () => {
    const f = await fixture();
    try {
      await f.admission.protect(f.root, "generation", false, async () => {});
      await f.admission.mutate([path.join(f.root, "file")], async () => {});
      await expect(
        f.admission.protect(f.root, "generation", false, async () => {
          throw new Error("interrupted");
        }),
      ).rejects.toThrow("interrupted");
      await expect(
        f.admission.mutate([path.join(f.root, "file")], async () => {}),
      ).rejects.toThrow("WORKSPACE_RETIRING");
    } finally {
      await rm(f.base, { recursive: true, force: true });
    }
  });
});
