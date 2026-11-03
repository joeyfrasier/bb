import { constants } from "node:fs";
import fs from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
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
import { describe, it, expect, vi } from "vitest";
import { WorkspaceMutationAdmission } from "./workspace-mutation-admission.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, default: { ...actual } };
});

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
describe.runIf(Boolean(constants.O_NOFOLLOW))(
  "workspace retirement admission",
  () => {
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
    it("serializes a move behind an open writer before retirement captures the tree", async () => {
      const f = await fixture();
      let release!: () => void;
      let spy: ReturnType<typeof vi.spyOn> | undefined;
      try {
        const outside = path.join(f.base, "outside");
        await mkdir(outside);
        await mkdir(path.join(f.root, ".bb"));
        await writeFile(path.join(outside, "note"), "old");
        let opened!: () => void;
        const ready = new Promise<void>((resolve) => {
          opened = resolve;
        });
        const writing = f.admission.mutate(
          [path.join(outside, "note")],
          async () => {
            const fd = await fs.open(path.join(outside, "note"), "r+");
            opened();
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            try {
              await fd.writeFile("latest");
            } finally {
              await fd.close();
            }
          },
        );
        await ready;
        let resolved!: () => void;
        const pathsResolved = new Promise<void>((resolve) => {
          resolved = resolve;
        });
        const actual = fs.realpath;
        let count = 0;
        spy = vi
          .spyOn(fs, "realpath")
          .mockImplementation(
            async (...args: Parameters<typeof fs.realpath>) => {
              const value = await actual(...args);
              if (
                String(args[0]) === outside ||
                String(args[0]) === path.join(f.root, ".bb")
              ) {
                count++;
                if (count === 2) resolved();
              }
              return value;
            },
          );
        let moveEntered = false;
        const moving = f.admission.mutate(
          [outside, path.join(f.root, ".bb")],
          async () => {
            moveEntered = true;
            await fs.rmdir(path.join(f.root, ".bb"));
            await fs.rename(outside, path.join(f.root, ".bb"));
          },
        );
        await pathsResolved;
        await nextTurn();
        expect(moveEntered).toBe(false);
        spy.mockRestore();
        spy = undefined;
        const retirement = f.admission.protect(
          f.root,
          "generation",
          true,
          async () => {
            expect(await readFile(path.join(f.root, ".bb/note"), "utf8")).toBe(
              "latest",
            );
          },
        );
        release();
        await Promise.all([writing, moving, retirement]);
      } finally {
        release?.();
        spy?.mockRestore();
        await rm(f.base, { recursive: true, force: true });
      }
    });
    it("never reopens a retired generation, including after restart", async () => {
      const f = await fixture();
      try {
        await f.admission.protect(f.root, "generation", true, async () => {});
        await expect(
          f.admission.protect(f.root, "generation", false, async () => {}),
        ).rejects.toThrow("WORKSPACE_GENERATION_RETIRED");
        const restarted = new WorkspaceMutationAdmission(f.storage);
        await expect(
          restarted.protect(f.root, "generation", false, async () => {}),
        ).rejects.toThrow("WORKSPACE_GENERATION_RETIRED");
        await expect(
          restarted.mutate([path.join(f.root, "late")], async () => {}),
        ).rejects.toThrow("WORKSPACE_RETIRING");
      } finally {
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
  },
);
