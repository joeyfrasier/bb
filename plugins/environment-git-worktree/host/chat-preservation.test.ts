import { constants, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { preserveChatData } from "./chat-preservation.js";

const roots: string[] = [];

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bb-chat-preservation-")));
  roots.push(root);
  const workspacePath = path.join(root, "workspace");
  const storagePath = path.join(root, "preserved");
  await fs.mkdir(workspacePath);
  return { root, workspacePath, storagePath, chat: path.join(workspacePath, ".bb") };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

it("does not create a snapshot store for a workspace without BB files", async () => {
    const f = await fixture();
    expect(await preserveChatData(f)).toEqual({ status: "empty", fileCount: 0, byteCount: 0 });
    expect(existsSync(f.storagePath)).toBe(false);
});

it.skipIf(Boolean(constants.O_NOFOLLOW))("refuses BB capture when no-follow primitives are unavailable", async () => {
  const f = await fixture();
  await fs.mkdir(f.chat);
  await fs.writeFile(path.join(f.chat, "artifact"), "synthetic private data");
  await expect(preserveChatData(f)).rejects.toMatchObject({ code: "chat_preservation_unsafe" });
  expect(existsSync(f.storagePath)).toBe(false);
  expect(await fs.readFile(path.join(f.chat, "artifact"), "utf8")).toBe("synthetic private data");
});

describe.skipIf(!constants.O_NOFOLLOW)("chat preservation", () => {

  it("restores all file bytes and empty directories after the source workspace is gone", async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.chat, "chats/thread/artifacts"), { recursive: true });
    await fs.mkdir(path.join(f.chat, "chats/thread/notes"));
    await fs.mkdir(path.join(f.chat, "chats/thread/tmp"));
    const bytes = Buffer.from([0, 255, 10, 13, 35]);
    await fs.writeFile(path.join(f.chat, "chats/thread/artifacts/result.bin"), bytes);
    await fs.writeFile(path.join(f.chat, "chats/thread/thread.json"), "synthetic metadata\n");
    const result = await preserveChatData(f);
    expect(result.status).toBe("preserved");
    if (result.status !== "preserved") throw new Error("Missing snapshot");
    expect(result.fileCount).toBe(2);
    expect(result.byteCount).toBe(bytes.length + Buffer.byteLength("synthetic metadata\n"));
    await fs.rm(f.workspacePath, { recursive: true });
    const snapshot = path.join(f.storagePath, result.snapshotId);
    expect(await fs.readFile(path.join(snapshot, "data/chats/thread/artifacts/result.bin"))).toEqual(bytes);
    expect((await fs.stat(path.join(snapshot, "data/chats/thread/tmp"))).isDirectory()).toBe(true);
    const manifest = JSON.parse(await fs.readFile(path.join(snapshot, "manifest.json"), "utf8"));
    expect(manifest.snapshotId).toBe(result.snapshotId);
    expect(manifest.fileCount).toBe(2);
    if (process.platform !== "win32") {
      expect((await fs.stat(snapshot)).mode & 0o077).toBe(0);
      expect((await fs.stat(path.join(snapshot, "manifest.json"))).mode & 0o077).toBe(0);
      expect((await fs.stat(path.join(snapshot, "data/chats/thread/artifacts/result.bin"))).mode & 0o077).toBe(0);
    }
  });

  it("publishes an empty BB directory and never overwrites an earlier snapshot on retry", async () => {
    const f = await fixture();
    await fs.mkdir(f.chat);
    const first = await preserveChatData(f);
    await fs.writeFile(path.join(f.chat, "artifact.txt"), "later");
    const second = await preserveChatData(f);
    if (first.status !== "preserved" || second.status !== "preserved") throw new Error("Missing snapshots");
    expect(first.snapshotId).not.toBe(second.snapshotId);
    expect((await fs.readdir(f.storagePath)).sort()).toEqual([first.snapshotId, second.snapshotId].sort());
    expect(await fs.readdir(path.join(f.storagePath, first.snapshotId, "data"))).toEqual([]);
  });

  for (const kind of ["root-symlink", "child-symlink", "dangling-symlink", "hardlink", "nested-repository"] as const) {
    it(`refuses ${kind} without publishing proof or touching the outside file`, async () => {
      const f = await fixture();
      const outside = path.join(f.root, "outside.txt");
      await fs.writeFile(outside, "keep synthetic data");
      if (kind === "root-symlink") {
        await fs.symlink(f.root, f.chat, "dir");
      } else {
        await fs.mkdir(f.chat);
        if (kind === "child-symlink") await fs.symlink(outside, path.join(f.chat, "link"));
        if (kind === "dangling-symlink") await fs.symlink(path.join(f.root, "missing"), path.join(f.chat, "link"));
        if (kind === "hardlink") await fs.link(outside, path.join(f.chat, "linked"));
        if (kind === "nested-repository") await fs.mkdir(path.join(f.chat, ".git"));
      }
      await expect(preserveChatData(f)).rejects.toMatchObject({ code: "chat_preservation_unsafe" });
      expect(await fs.readFile(outside, "utf8")).toBe("keep synthetic data");
      expect(existsSync(f.storagePath)).toBe(false);
    });
  }

  it("refuses a sparse file above the byte budget before copying it", async () => {
    const f = await fixture();
    await fs.mkdir(f.chat);
    const file = await fs.open(path.join(f.chat, "large"), "wx");
    await file.truncate(512 * 1024 * 1024 + 1);
    await file.close();
    await expect(preserveChatData(f)).rejects.toMatchObject({ code: "chat_preservation_limit" });
    expect(existsSync(f.storagePath)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("refuses a special file without opening it", async () => {
    const f = await fixture();
    await fs.mkdir(f.chat);
    execFileSync("mkfifo", [path.join(f.chat, "pipe")], { stdio: "pipe" });
    await expect(preserveChatData(f)).rejects.toMatchObject({ code: "chat_preservation_unsafe" });
    expect(existsSync(f.storagePath)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0 || process.platform === "win32")("retains unreadable source files and publishes no proof", async () => {
    const f = await fixture();
    await fs.mkdir(f.chat);
    const file = path.join(f.chat, "unreadable");
    await fs.writeFile(file, "synthetic private data");
    await fs.chmod(file, 0);
    try {
      await expect(preserveChatData(f)).rejects.toMatchObject({ code: "chat_preservation_failed" });
      expect(await fs.readdir(f.storagePath)).toEqual([]);
      expect(existsSync(file)).toBe(true);
    } finally {
      await fs.chmod(file, 0o600);
    }
  });

  it("refuses snapshot storage inside the workspace", async () => {
    const f = await fixture();
    await fs.mkdir(f.chat);
    await expect(preserveChatData({ ...f, storagePath: path.join(f.workspacePath, "copy") })).rejects.toMatchObject({ code: "chat_preservation_unsafe" });
    expect(existsSync(path.join(f.workspacePath, "copy"))).toBe(false);
  });

  it("refuses public snapshot storage instead of widening the audience", async () => {
    const f = await fixture();
    await fs.mkdir(f.chat);
    await fs.mkdir(f.storagePath, { mode: 0o755 });
    await fs.chmod(f.storagePath, 0o755);
    await expect(preserveChatData(f)).rejects.toMatchObject({ code: "chat_preservation_unsafe" });
    expect(await fs.readdir(f.storagePath)).toEqual([]);
  });

  for (const target of ["source", "copy"] as const) {
    it(`refuses a same-path ${target} mutation during capture and leaves no completed proof`, async () => {
      const f = await fixture();
      await fs.mkdir(f.chat);
      const source = path.join(f.chat, "artifact.txt");
      await fs.writeFile(source, "synthetic original");
      const controller = new AbortController();
      const abortCheck = controller.signal.throwIfAborted.bind(controller.signal);
      let changed = false;
      controller.signal.throwIfAborted = () => {
        abortCheck();
        if (changed || !existsSync(f.storagePath)) return;
        const staging = readdirSync(f.storagePath).find((name) => name.startsWith(".incomplete-"));
        if (!staging) return;
        const destination = path.join(f.storagePath, staging, "data/artifact.txt");
        if (!existsSync(destination) || statSync(destination).size === 0) return;
        changed = true;
        writeFileSync(target === "source" ? source : destination, "synthetic modified");
      };
      await expect(preserveChatData({ ...f, signal: controller.signal })).rejects.toBeInstanceOf(Error);
      expect(changed).toBe(true);
      expect(await fs.readdir(f.storagePath)).toEqual([]);
      expect(existsSync(source)).toBe(true);
    });
  }

  it("leaves source data and no completed proof on cancellation", async () => {
    const f = await fixture();
    await fs.mkdir(f.chat);
    await fs.writeFile(path.join(f.chat, "artifact.txt"), "synthetic");
    const controller = new AbortController();
    controller.abort(new Error("cancelled synthetic capture"));
    await expect(preserveChatData({ ...f, signal: controller.signal })).rejects.toThrow("cancelled synthetic capture");
    expect(await fs.readFile(path.join(f.chat, "artifact.txt"), "utf8")).toBe("synthetic");
    expect(existsSync(f.storagePath)).toBe(false);
  });
});
