import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

export class ChatPreservationError extends Error {
  readonly code: "chat_preservation_unsafe" | "chat_preservation_limit" | "chat_preservation_changed" | "chat_preservation_failed";

  constructor(code: ChatPreservationError["code"]) {
    super("BB chat preservation could not be verified. The workspace must be retained.");
    this.code = code;
  }
}

export type ChatPreservationResult =
  | { status: "empty"; fileCount: 0; byteCount: 0 }
  | {
      status: "preserved";
      snapshotId: string;
      fileCount: number;
      byteCount: number;
    };

type Entry = {
  relativePath: string;
  kind: "directory" | "file";
  identity: string;
  size: number;
  mode: number;
  digest: string | null;
};

const MAX_ENTRIES = 100_000;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_DEPTH = 64;

function within(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function identity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

async function checkedDirectory(directory: string): Promise<BigIntStats> {
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) {
    throw new ChatPreservationError("chat_preservation_unsafe");
  }
  return stat;
}

async function inventory(root: string, signal?: AbortSignal): Promise<Entry[]> {
  const entries: Entry[] = [];
  let byteCount = 0;
  const visit = async (relativePath: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    if (depth > MAX_DEPTH || entries.length >= MAX_ENTRIES) {
      throw new ChatPreservationError("chat_preservation_limit");
    }
    const absolute = path.join(root, relativePath);
    const stat = await fs.lstat(absolute, { bigint: true });
    const isDirectory = stat.isDirectory();
    if (stat.isSymbolicLink() || (!isDirectory && !stat.isFile()) || (!isDirectory && stat.nlink !== 1n)) {
      throw new ChatPreservationError("chat_preservation_unsafe");
    }
    if (await fs.realpath(absolute) !== absolute || !within(root, absolute)) {
      throw new ChatPreservationError("chat_preservation_unsafe");
    }
    const size = isDirectory ? 0 : Number(stat.size);
    byteCount += size;
    if (!Number.isSafeInteger(size) || byteCount > MAX_BYTES) {
      throw new ChatPreservationError("chat_preservation_limit");
    }
    entries.push({ relativePath, kind: isDirectory ? "directory" : "file", identity: identity(stat), size, mode: Number(stat.mode & 0o777n), digest: null });
    if (!isDirectory) return;
    const children = (await fs.readdir(absolute)).sort();
    if (children.includes(".git")) throw new ChatPreservationError("chat_preservation_unsafe");
    for (const child of children) await visit(path.join(relativePath, child), depth + 1);
    if (identity(await fs.lstat(absolute, { bigint: true })) !== identity(stat)) {
      throw new ChatPreservationError("chat_preservation_changed");
    }
  };
  await visit("", 0);
  return entries;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function consumeFile(
  file: string,
  expectedIdentity: string | null,
  expectedSize: number,
  signal?: AbortSignal,
  destination?: FileHandle,
): Promise<string> {
  const source = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || Number(before.size) !== expectedSize ||
        (expectedIdentity !== null && identity(before) !== expectedIdentity)) {
      throw new ChatPreservationError("chat_preservation_changed");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let read = 0;
    for (;;) {
      signal?.throwIfAborted();
      const result = await source.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      read += result.bytesRead;
      if (read > expectedSize) throw new ChatPreservationError("chat_preservation_changed");
      hash.update(buffer.subarray(0, result.bytesRead));
      if (destination !== undefined) {
        let written = 0;
        while (written < result.bytesRead) {
          const resultWrite = await destination.write(buffer, written, result.bytesRead - written, null);
          if (resultWrite.bytesWritten === 0) throw new ChatPreservationError("chat_preservation_failed");
          written += resultWrite.bytesWritten;
        }
      }
    }
    if (read !== expectedSize || identity(await source.stat({ bigint: true })) !== identity(before) ||
        identity(await fs.lstat(file, { bigint: true })) !== identity(before)) {
      throw new ChatPreservationError("chat_preservation_changed");
    }
    return hash.digest("hex");
  } finally {
    await source.close();
  }
}

async function forEachBounded(entries: Entry[], work: (entry: Entry) => Promise<void>): Promise<void> {
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(16, entries.length) }, async () => {
    while (!failed && cursor < entries.length) {
      const entry = entries[cursor++];
      try {
        await work(entry);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw failure;
}

export async function preserveChatData(args: {
  workspacePath: string;
  storagePath: string;
  signal?: AbortSignal;
}): Promise<ChatPreservationResult> {
  let staging: string | undefined;
  try {
    args.signal?.throwIfAborted();
    if (!path.isAbsolute(args.workspacePath) || !path.isAbsolute(args.storagePath)) {
      throw new ChatPreservationError("chat_preservation_unsafe");
    }
    const workspace = await fs.realpath(args.workspacePath);
    await checkedDirectory(workspace);
    const source = path.join(workspace, ".bb");
    try {
      await fs.lstat(source);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { status: "empty", fileCount: 0, byteCount: 0 };
      }
      throw error;
    }
    if (!constants.O_NOFOLLOW) throw new ChatPreservationError("chat_preservation_unsafe");
    const entries = await inventory(source, args.signal);
    const storage = path.resolve(args.storagePath);
    if (within(workspace, storage) || within(storage, workspace)) {
      throw new ChatPreservationError("chat_preservation_unsafe");
    }
    await fs.mkdir(storage, { recursive: true, mode: 0o700 });
    const storageStat = await checkedDirectory(storage);
    if ((storageStat.mode & 0o077n) !== 0n ||
        (process.getuid !== undefined && storageStat.uid !== BigInt(process.getuid()))) {
      throw new ChatPreservationError("chat_preservation_unsafe");
    }
    staging = await fs.mkdtemp(path.join(storage, ".incomplete-"));
    const payload = path.join(staging, "data");
    await fs.mkdir(payload, { mode: 0o700 });
    for (const entry of entries) {
      args.signal?.throwIfAborted();
      if (entry.kind === "directory") {
        if (entry.relativePath !== "") await fs.mkdir(path.join(payload, entry.relativePath), { mode: 0o700 });
      }
    }
    const files = entries.filter((entry) => entry.kind === "file");
    const copy = async (entry: Entry): Promise<void> => {
      args.signal?.throwIfAborted();
      const destinationPath = path.join(payload, entry.relativePath);
      const destination = await fs.open(destinationPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        entry.digest = await consumeFile(path.join(source, entry.relativePath), entry.identity, entry.size, args.signal, destination);
        await destination.sync();
      } finally {
        await destination.close();
      }
      if (await consumeFile(destinationPath, null, entry.size, args.signal) !== entry.digest) {
        throw new ChatPreservationError("chat_preservation_failed");
      }
    };
    await forEachBounded(files, copy);
    const after = await inventory(source, args.signal);
    if (after.length !== entries.length || after.some((entry, i) => entry.relativePath !== entries[i].relativePath || entry.identity !== entries[i].identity)) {
      throw new ChatPreservationError("chat_preservation_changed");
    }
    await forEachBounded(files, async (entry) => {
      if (await consumeFile(path.join(source, entry.relativePath), entry.identity, entry.size, args.signal) !== entry.digest) {
        throw new ChatPreservationError("chat_preservation_changed");
      }
    });
    const snapshotId = randomUUID();
    const fileCount = entries.filter((entry) => entry.kind === "file").length;
    const byteCount = entries.reduce((sum, entry) => sum + entry.size, 0);
    const manifest = await fs.open(path.join(staging, "manifest.json"), "wx", 0o600);
    try {
      await manifest.writeFile(JSON.stringify({ version: 1, snapshotId, workspace, fileCount, byteCount, entries }));
      await manifest.sync();
    } finally {
      await manifest.close();
    }
    for (const entry of [...entries].reverse()) {
      if (entry.kind === "directory") await syncDirectory(path.join(payload, entry.relativePath));
    }
    await syncDirectory(staging);
    args.signal?.throwIfAborted();
    const finalDirectory = path.join(storage, snapshotId);
    await fs.rename(staging, finalDirectory);
    staging = undefined;
    await syncDirectory(storage);
    return { status: "preserved", snapshotId, fileCount, byteCount };
  } catch (error) {
    if (error instanceof ChatPreservationError) throw error;
    if (args.signal?.aborted) throw args.signal.reason;
    throw new ChatPreservationError("chat_preservation_failed");
  } finally {
    if (staging !== undefined) await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
