# Worktree

Creates an isolated Git worktree from the project checkout on an enrolled machine. The plugin supplies base-branch inputs, runs workspace setup, and removes owned worktrees after core retires them. Project sub-threads receive fresh worktrees by default.

Bundled and installed automatically. Select it through the environment picker or `bb thread spawn --environment-provider git-worktree`. Use `bb environment providers --json` for its inputs and availability.

New branches start at the selected base without an upstream. Publish with `git push -u origin HEAD` to track the task's remote branch. Existing branches keep their upstream configuration.

The Plugin Guide documents the experimental environment-provider contract. Core owns durable launches, retries, cancellation, retirement, and teardown; this plugin owns resource creation and removal.

Existing-worktree inputs (`{"kind":"existing","path":"/absolute/worktree"}`)
reuse the project's recorded environment on the selected machine before running
provider creation. Its ownership and cleanup behavior stay intact. When the path
has no environment, the plugin validates it against Git and adopts it without
taking ownership; retiring that environment leaves the worktree on disk.

Default and named bases share one comparison: use the remote when local is
equal or behind, and preserve local commits when ahead, diverged or unknown.
Remote-only branches are usable too. Explicit remote names and fully qualified
refs are honored exactly. Selected remote bases are fetched before creation.
When the plugin chose `origin/<name>` itself and that fetch fails for any
reason other than cancellation, it creates the worktree from the last fetched
`origin/<name>` and reports the failure and the commit it used in the
provisioning progress. That ref already contains every local commit, because
it is only chosen when local is equal or behind. An explicit `origin/<name>`
still fails, and `refs/remotes/origin/<name>` uses the last fetched ref without
fetching. The resolved base is returned and stored with the environment; this does not
refresh existing worktrees before later agent turns.

## Preserve chat files during retirement

Native host admission closes SDK file writes, directory creation, moves, and
removals before worktree retirement. It drains admitted operations, and retains a
private generation-bound tombstone through removal, cancellation, or worker death.
The provider copies the complete root `.bb` tree to private `preserved-chat-data`
storage outside its `worktrees` root and verifies file bytes before removal.
Unsupported links, nested repositories, unreadable files, and changed captures
block removal. Other ignored files still block removal.

`experimental_workspacePreservationStatus({ environmentId })` is a read-only
plugin RPC. It resolves the environment and owning host itself. Version 1 returns
`protected` with environment, host, canonical root, and generation only when the
native manager and this provider support mandatory capture. Missing native support
returns `unavailable`; unowned or inactive environments return `blocked`.
Inspection does not create a snapshot. Archive completion is distinct from
workspace removal and snapshot readback.

Admission protects the SDK file mutation routes used by automatic chat exports.
It cannot constrain arbitrary processes writing directly to the filesystem.
Retirement still stops workspace processes, refuses unsafe captures, and preserves
uncertain state. Never treat this as a universal filesystem transaction. Native
retirement tombstones are retained after failure and restart; do not clear them
or reuse the same generation implicitly. Snapshots have no automatic deletion.
