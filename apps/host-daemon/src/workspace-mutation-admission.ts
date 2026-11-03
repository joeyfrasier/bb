import { constants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

interface Tombstone {
  root: string;
  generation: string;
  phase: "provisioning" | "retiring";
}
const coordinators = new Map<string, WorkspaceMutationAdmission>();

export function workspaceMutationAdmission(
  dataDir: string,
): WorkspaceMutationAdmission {
  const key = path.resolve(dataDir);
  let value = coordinators.get(key);
  if (!value) {
    value = new WorkspaceMutationAdmission(
      path.join(key, "workspace-retirement"),
    );
    coordinators.set(key, value);
  }
  return value;
}

export function admitWorkspaceMutation<T>(
  dataDir: string,
  paths: string[],
  run: () => Promise<T>,
): Promise<T> {
  return constants.O_NOFOLLOW
    ? workspaceMutationAdmission(dataDir).mutate(paths, run)
    : run();
}

export async function canonicalMutationPath(value: string): Promise<string> {
  if (!path.isAbsolute(value)) throw new Error("WORKSPACE_PATH_INVALID");
  let current = path.resolve(value);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...missing);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw new Error("WORKSPACE_PATH_UNVERIFIED");
      const parent = path.dirname(current);
      if (parent === current) throw new Error("WORKSPACE_PATH_UNVERIFIED");
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}
async function mutationPathTrace(
  value: string,
): Promise<{ canonical: string; scopes: string[] }> {
  if (!path.isAbsolute(value)) throw new Error("WORKSPACE_PATH_INVALID");
  const absolute = path.resolve(value);
  let root = path.parse(absolute).root;
  let resolved = root;
  let pending = absolute.slice(root.length).split(path.sep).filter(Boolean);
  const scopes = new Set<string>([absolute]);
  let links = 0;
  while (pending.length) {
    const segment = pending.shift()!;
    if (segment === ".") continue;
    if (segment === "..") {
      resolved = path.dirname(resolved);
      continue;
    }
    const candidate = path.join(resolved, segment);
    let info: Stats;
    try {
      info = await fs.lstat(candidate);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        break;
      throw new Error("WORKSPACE_PATH_UNVERIFIED");
    }
    if (info.isSymbolicLink()) {
      if (++links > 40) throw new Error("WORKSPACE_PATH_UNVERIFIED");
      scopes.add(candidate);
      let target: string;
      try {
        target = await fs.readlink(candidate);
      } catch {
        throw new Error("WORKSPACE_PATH_UNVERIFIED");
      }
      if (path.isAbsolute(target)) {
        root = path.parse(target).root;
        resolved = root;
        target = target.slice(root.length);
      }
      pending = [...target.split(path.sep).filter(Boolean), ...pending];
    } else {
      resolved = candidate;
    }
  }
  const canonical = await canonicalMutationPath(value);
  scopes.add(canonical);
  return { canonical, scopes: [...scopes].sort() };
}

function contains(a: string, b: string): boolean {
  const relative = path.relative(a, b);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
function overlaps(a: string, b: string): boolean {
  return contains(a, b) || contains(b, a);
}

export class WorkspaceMutationAdmission {
  private readonly blocked = new Map<string, Tombstone>();
  private readonly running = new Set<string>();
  private readonly writes = new Map<
    string,
    { paths: string[]; done: Promise<void> }
  >();
  private readonly ready: Promise<void>;
  constructor(private readonly storage: string) {
    this.ready = this.load();
  }
  private async load(): Promise<void> {
    await fs.mkdir(this.storage, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(this.storage);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0
    )
      throw new Error("WORKSPACE_FENCE_STORAGE_UNSAFE");
    for (const name of await fs.readdir(this.storage)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = path.join(this.storage, name);
      const stat = await fs.lstat(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size > 32768 ||
        (stat.mode & 0o077) !== 0
      )
        throw new Error("WORKSPACE_FENCE_STORAGE_UNSAFE");
      const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      if (
        !value ||
        typeof value !== "object" ||
        !("root" in value) ||
        typeof value.root !== "string" ||
        !path.isAbsolute(value.root) ||
        !("generation" in value) ||
        typeof value.generation !== "string" ||
        !("phase" in value) ||
        (value.phase !== "provisioning" && value.phase !== "retiring")
      )
        throw new Error("WORKSPACE_FENCE_STORAGE_INVALID");
      if (this.file(value.root) !== file)
        throw new Error("WORKSPACE_FENCE_STORAGE_INVALID");
      this.blocked.set(value.root, {
        root: value.root,
        generation: value.generation,
        phase: value.phase,
      });
    }
  }
  private file(root: string): string {
    return path.join(
      this.storage,
      createHash("sha256").update(root).digest("hex") + ".json",
    );
  }
  private async persist(record: Tombstone): Promise<void> {
    const target = this.file(record.root);
    try {
      const info = await fs.lstat(target);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size > 32768 ||
        (info.mode & 0o077) !== 0
      )
        throw new Error("WORKSPACE_FENCE_STORAGE_UNSAFE");
      const prior: unknown = JSON.parse(await fs.readFile(target, "utf8"));
      if (
        !prior ||
        typeof prior !== "object" ||
        !("root" in prior) ||
        prior.root !== record.root ||
        !("generation" in prior) ||
        prior.generation !== record.generation
      )
        throw new Error("WORKSPACE_GENERATION_CHANGED");
      if (
        !("phase" in prior) ||
        (prior.phase !== "provisioning" && prior.phase !== "retiring") ||
        (prior.phase === "retiring" && record.phase !== "retiring")
      )
        throw new Error("WORKSPACE_GENERATION_RETIRED");
      if (prior.phase === record.phase) return;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    const temporary = path.join(this.storage, randomUUID() + ".tmp");
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
    if ((await fs.readFile(target, "utf8")) !== JSON.stringify(record))
      throw new Error("WORKSPACE_FENCE_STORAGE_INVALID");
    const dir = await fs.open(this.storage, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
  async available(rootPath: string): Promise<boolean> {
    await this.ready;
    const root = await canonicalMutationPath(rootPath);
    return ![...this.blocked.keys()].some((other) => overlaps(other, root));
  }
  async mutate<T>(paths: string[], run: () => Promise<T>): Promise<T> {
    await this.ready;
    const traces = await Promise.all(paths.map(mutationPathTrace));
    const protectedPaths = [
      ...new Set(traces.flatMap((trace) => trace.scopes)),
    ];
    if (
      [...this.blocked.keys()].some((root) =>
        protectedPaths.some((target) => overlaps(root, target)),
      )
    )
      throw new Error("WORKSPACE_RETIRING");
    const id = randomUUID();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const predecessors = [...this.writes.values()]
      .filter((write) =>
        write.paths.some((a) => protectedPaths.some((b) => overlaps(a, b))),
      )
      .map((write) => write.done);
    this.writes.set(id, { paths: protectedPaths, done });
    try {
      await Promise.all(predecessors);
      const current = await Promise.all(paths.map(mutationPathTrace));
      if (
        current.some(
          (trace, index) =>
            trace.canonical !== traces[index]?.canonical ||
            JSON.stringify(trace.scopes) !==
              JSON.stringify(traces[index]?.scopes),
        )
      )
        throw new Error("WORKSPACE_MUTATION_PATH_CHANGED");
      return await run();
    } finally {
      this.writes.delete(id);
      release();
    }
  }
  async protect<T>(
    rootPath: string,
    generation: string,
    permanent: boolean,
    run: (root: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.ready;
    const root = await canonicalMutationPath(rootPath);
    if (this.running.has(root)) throw new Error("WORKSPACE_RETIREMENT_BUSY");
    const prior = this.blocked.get(root);
    if (prior && !permanent && prior.phase === "retiring")
      throw new Error("WORKSPACE_GENERATION_RETIRED");
    if (prior && prior.generation !== generation)
      throw new Error("WORKSPACE_GENERATION_CHANGED");
    if (
      [...this.blocked.keys()].some(
        (other) => other !== root && overlaps(other, root),
      )
    )
      throw new Error("WORKSPACE_RETIRING");
    this.running.add(root);
    const record: Tombstone = {
      root,
      generation,
      phase: permanent ? "retiring" : "provisioning",
    };
    this.blocked.set(root, record);
    try {
      await this.persist(record);
      signal?.throwIfAborted();
      const draining = Promise.all(
        [...this.writes.values()]
          .filter((write) =>
            write.paths.some((target) => overlaps(root, target)),
          )
          .map((write) => write.done),
      );
      let abort: (() => void) | undefined;
      try {
        if (signal)
          await Promise.race([
            draining,
            new Promise<never>((_resolve, reject) => {
              abort = () => reject(new Error("WORKSPACE_RETIREMENT_CANCELLED"));
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
            }),
          ]);
        else await draining;
      } finally {
        if (signal && abort) signal.removeEventListener("abort", abort);
      }
      signal?.throwIfAborted();
      const result = await run(root);
      signal?.throwIfAborted();
      if (!permanent) {
        await fs.unlink(this.file(root));
        const dir = await fs.open(this.storage, "r");
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
        this.blocked.delete(root);
      }
      return result;
    } finally {
      this.running.delete(root);
    }
  }
}
