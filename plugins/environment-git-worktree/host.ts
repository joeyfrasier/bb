import nodePath from "node:path";
import { realpath } from "node:fs/promises";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { readdir } from "node:fs/promises";
import { createHostProgress } from "bb-environment-provider-host/progress";
import { worktreeHostContract, worktreeHostSignals } from "./contract.js";
import { resolveWorktreeBaseBranch } from "./host/base-branch.js";
import {
  resolveWorktreeChildPath,
  resolveWorktreesRoot,
  resolveWorktreeAttemptRoot,
  resolveWorktreeTargetPath,
} from "./host/paths.js";
import {
  createWorktree,
  listAdoptableWorktrees,
  removeWorktree,
  resolveAdoptableWorktree,
} from "./host/worktree.js";

function completionPathForWorktree(worktreePath: string): string {
  return `${worktreePath}.completed`;
}

async function worktreePathsForPathKey(args: {
  dataDir: string;
  pathKey: string;
}): Promise<string[]> {
  const root = resolveWorktreeAttemptRoot(args);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        resolveWorktreeChildPath({
          dataDir: args.dataDir,
          pathKey: args.pathKey,
          childName: entry.name,
        }),
      );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function createWorktreeHostEntry() {
  return experimental_defineHostEntry({
    contract: worktreeHostContract,
    experimental_signals: worktreeHostSignals,
    handlers: {
      async workspacePreservationStatus(input, context) {
        if (context.internal_DO_NOT_USE_workspaceFenceVersion !== 1)
          return {
            status: "unavailable",
            reason: "NATIVE_WRITER_FENCE_UNAVAILABLE",
          } as const;
        const root = await realpath(input.path);
        const managedRoot = await realpath(
          resolveWorktreesRoot(context.experimental_paths.dataDir),
        );
        const relative = nodePath.relative(managedRoot, root);
        if (
          !relative ||
          relative.startsWith("..") ||
          nodePath.isAbsolute(relative) ||
          relative.split(nodePath.sep)[0] !== input.pathKey
        )
          return {
            status: "blocked",
            reason: "UNSUPPORTED_ENVIRONMENT",
          } as const;
        return {
          status: "protected",
          canonicalRoot: root,
          generation: input.pathKey,
        } as const;
      },
      async defaultBaseBranch(input) {
        const resolved = await resolveWorktreeBaseBranch(input.sourcePath, {
          kind: "default",
        });
        return { branch: resolved?.ref ?? null };
      },
      async listWorktrees(input, context) {
        const worktrees = await listAdoptableWorktrees({
          sourcePath: input.sourcePath,
          managedRoot: resolveWorktreesRoot(context.experimental_paths.dataDir),
        });
        return {
          worktrees: worktrees.map((entry) => ({
            path: entry.path,
            branch: entry.branch,
            locked: entry.locked,
            prunable: entry.prunable,
          })),
        };
      },
      async resolveExistingWorktree(input, context) {
        return resolveAdoptableWorktree({
          sourcePath: input.sourcePath,
          path: input.path,
          managedRoot: resolveWorktreesRoot(context.experimental_paths.dataDir),
        });
      },
      async create(input, context) {
        const targetPath = resolveWorktreeTargetPath({
          dataDir: context.experimental_paths.dataDir,
          pathKey: input.pathKey,
          sourcePath: input.sourcePath,
        });
        try {
          const baseBranch = await resolveWorktreeBaseBranch(
            input.sourcePath,
            input.baseBranch,
          );
          const created = await createWorktree({
            chatProtection: {
              storagePath: nodePath.join(
                context.experimental_paths.dataDir,
                "preserved-chat-data",
              ),
              fence: context.internal_DO_NOT_USE_workspaceFence ?? null,
            },
            sourcePath: input.sourcePath,
            targetPath,
            completionPath: completionPathForWorktree(targetPath),
            ownWorktreesRoot: resolveWorktreesRoot(
              context.experimental_paths.dataDir,
            ),
            branchName: input.branchName,
            baseBranch,
            branchMode: input.branchMode,
            onProgress: createHostProgress({
              operationId: input.operationId,
              emit: (payload) =>
                context.experimental_emitSignal("progress", payload),
            }),
            signal: context.signal,
          });
          return {
            status: "created",
            path: created.path,
            baseBranch: baseBranch?.ref ?? null,
          } as const;
        } catch (error) {
          if (context.signal.aborted) throw error;
          return {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          } as const;
        }
      },

      async remove(input, context) {
        try {
          const paths =
            input.path === null
              ? await worktreePathsForPathKey({
                  dataDir: context.experimental_paths.dataDir,
                  pathKey: input.pathKey,
                })
              : [input.path];
          for (const path of paths) {
            await removeWorktree({
              path,
              chatProtection: {
                storagePath: nodePath.join(
                  context.experimental_paths.dataDir,
                  "preserved-chat-data",
                ),
                fence: context.internal_DO_NOT_USE_workspaceFence ?? null,
              },
              completionPath: completionPathForWorktree(path),
              onProgress: createHostProgress({
                operationId: input.operationId,
                emit: (payload) =>
                  context.experimental_emitSignal("progress", payload),
              }),
              signal: context.signal,
            });
          }
          return { status: "removed" } as const;
        } catch (error) {
          if (context.signal.aborted) throw error;
          return {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          } as const;
        }
      },
    },
  });
}

export default createWorktreeHostEntry();
