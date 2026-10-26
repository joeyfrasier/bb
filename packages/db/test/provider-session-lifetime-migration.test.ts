import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { PERSONAL_PROJECT_ID, threadScope } from "@bb/domain";
import {
  createConnection,
  createThread,
  getThread,
  insertEvents,
  listEvents,
  migrate,
  noopNotifier,
  type DbConnection,
} from "../src/index.js";

const legacyLifetimeWhen = 1792516479961;
const legacyLifetimeHash = createHash("sha256")
  .update("ALTER TABLE `threads` ADD `provider_session_lifetime` text DEFAULT 'persistent' NOT NULL;")
  .digest("hex");
const pendingColumn = "_bb_provider_session_lifetime_pending";
const databases: DbConnection[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.$client.close();
});

function migration(tag: string): { when: number; hash: string } {
  const journal: unknown = JSON.parse(
    readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
  );
  if (typeof journal !== "object" || journal === null || !("entries" in journal) || !Array.isArray(journal.entries))
    throw new Error("Invalid migration journal");
  const entry: unknown = journal.entries.find(
    (value: unknown) => typeof value === "object" && value !== null && "tag" in value && value.tag === tag,
  );
  if (typeof entry !== "object" || entry === null || !("when" in entry) || typeof entry.when !== "number")
    throw new Error("Missing migration " + tag);
  return {
    when: entry.when,
    hash: createHash("sha256").update(readFileSync(new URL("../drizzle/" + tag + ".sql", import.meta.url))).digest("hex"),
  };
}

function lifetimeMigration() {
  return migration("0147_provider_session_lifetime");
}

function rows(db: DbConnection, table: "threads" | "events" | "queued_thread_messages" | "__drizzle_migrations") {
  return db.$client.prepare("SELECT * FROM " + table + " ORDER BY id").all();
}

function seed() {
  const db = createConnection(":memory:");
  databases.push(db);
  migrate(db);
  const thread = createThread(db, noopNotifier, { projectId: PERSONAL_PROJECT_ID, providerId: "codex", status: "idle" });
  insertEvents(db, noopNotifier, [{
    threadId: thread.id,
    environmentId: null,
    providerThreadId: "original-native-uuid",
    scope: threadScope(),
    sequence: 1,
    type: "thread/identity",
    data: "{}",
    itemId: null,
    itemKind: null,
    parentToolCallId: null,
  }]);
  db.$client.prepare(`INSERT INTO queued_thread_messages (
    id, thread_id, content, model, reasoning_level, permission_mode,
    service_tier, state, failure_reason, failure_count, sort_key, created_at, updated_at
  ) VALUES ('qmsg_preserved', ?, '[]', 'gpt-6.1-sol', 'medium', 'full', 'default',
    'failed_exhausted', 'retained fixture failure', 1, 'a', 1000, 1000)`).run(thread.id);
  return { db, threadId: thread.id };
}

function rewindLifetime(db: DbConnection, existingColumn: boolean) {
  db.$client.prepare("DELETE FROM __drizzle_migrations WHERE created_at = ?").run(lifetimeMigration().when);
  if (!existingColumn) db.$client.exec("ALTER TABLE threads DROP COLUMN provider_session_lifetime");
}

function repairedLegacyFixture() {
  const result = seed();
  result.db.$client.prepare("UPDATE threads SET provider_session_lifetime = 'disposable' WHERE id = ?").run(result.threadId);
  result.db.$client.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(legacyLifetimeHash, legacyLifetimeWhen);
  rewindLifetime(result.db, true);
  return result;
}

function retainedState(db: DbConnection) {
  return { threads: rows(db, "threads"), events: rows(db, "events"), queue: rows(db, "queued_thread_messages") };
}

function expectNoPendingColumn(db: DbConnection) {
  expect(db.$client.pragma("table_info(threads)")).not.toContainEqual(expect.objectContaining({ name: pendingColumn }));
}

it("upgrades stock252 threads to persistent without changing native UUID events or failed queues", () => {
  const { db, threadId } = seed();
  rewindLifetime(db, false);
  const events = listEvents(db, { threadId });
  const queue = rows(db, "queued_thread_messages");
  migrate(db);
  migrate(db);
  expect(getThread(db, threadId)?.providerSessionLifetime).toBe("persistent");
  expect(listEvents(db, { threadId })).toEqual(events);
  expect(events[0]?.providerThreadId).toBe("original-native-uuid");
  expect(rows(db, "queued_thread_messages")).toEqual(queue);
  expectNoPendingColumn(db);
});

it("preserves repaired custom252 disposable values, history, failed queues and both146 ledger rows", () => {
  const { db, threadId } = repairedLegacyFixture();
  const before = retainedState(db);
  const ledger = rows(db, "__drizzle_migrations");
  migrate(db);
  migrate(db);
  expect(getThread(db, threadId)?.providerSessionLifetime).toBe("disposable");
  expect(retainedState(db)).toEqual(before);
  expect(rows(db, "__drizzle_migrations")).toEqual(expect.arrayContaining(ledger));
  expect(db.$client.prepare("SELECT hash FROM __drizzle_migrations WHERE created_at = ?").get(legacyLifetimeWhen)).toEqual({ hash: legacyLifetimeHash });
  const stock = migration("0146_diff_viewed_files");
  expect(db.$client.prepare("SELECT hash FROM __drizzle_migrations WHERE created_at = ?").get(stock.when)).toEqual({ hash: stock.hash });
  expectNoPendingColumn(db);
});

it("restores existing disposable values if the new migration fails and permits a later retry", () => {
  const { db } = repairedLegacyFixture();
  const before = retainedState(db);
  const ledger = rows(db, "__drizzle_migrations");
  db.$client.exec(`CREATE TEMP TRIGGER fail_lifetime BEFORE INSERT ON __drizzle_migrations
    WHEN NEW.created_at = ${lifetimeMigration().when}
    BEGIN SELECT RAISE(ABORT, 'synthetic lifetime migration failure'); END`);
  expect(() => migrate(db)).toThrow("synthetic lifetime migration failure");
  expect(retainedState(db)).toEqual(before);
  expect(rows(db, "__drizzle_migrations")).toEqual(ledger);
  expectNoPendingColumn(db);
  db.$client.exec("DROP TRIGGER fail_lifetime");
  migrate(db);
  expect(retainedState(db)).toEqual(before);
});

it.each([false, true])("recovers an interrupted staged column, committed147=%s, without defaulting disposable values", (committed) => {
  const { db, threadId } = repairedLegacyFixture();
  const before = retainedState(db);
  if (committed) migrate(db);
  db.$client.exec("ALTER TABLE threads RENAME COLUMN provider_session_lifetime TO " + pendingColumn);
  if (committed) db.$client.exec("ALTER TABLE threads ADD provider_session_lifetime text DEFAULT 'persistent' NOT NULL");
  migrate(db);
  migrate(db);
  expect(getThread(db, threadId)?.providerSessionLifetime).toBe("disposable");
  expect(retainedState(db)).toEqual(before);
  expectNoPendingColumn(db);
});

it("rejects an unrepaired245 migration ledger before staging or applying147", () => {
  const { db } = repairedLegacyFixture();
  const stock = migration("0146_diff_viewed_files");
  db.$client.prepare("DELETE FROM __drizzle_migrations WHERE created_at = ?").run(stock.when);
  db.$client.exec("DROP TABLE diff_viewed_files");
  const before = retainedState(db);
  const ledger = rows(db, "__drizzle_migrations");
  expect(() => migrate(db)).toThrow(/stock.*0146/i);
  expect(retainedState(db)).toEqual(before);
  expect(rows(db, "__drizzle_migrations")).toEqual(ledger);
  expectNoPendingColumn(db);
});

it("rejects an invalid legacy lifetime value before changing threads or the migration ledger", () => {
  const { db, threadId } = repairedLegacyFixture();
  db.$client.prepare("UPDATE threads SET provider_session_lifetime = 'unknown' WHERE id = ?").run(threadId);
  const before = retainedState(db);
  const ledger = rows(db, "__drizzle_migrations");
  expect(() => migrate(db)).toThrow(/invalid.*lifetime/i);
  expect(retainedState(db)).toEqual(before);
  expect(rows(db, "__drizzle_migrations")).toEqual(ledger);
  expectNoPendingColumn(db);
});

it("rejects an invalid legacy lifetime column type before changing the migration ledger", () => {
  const { db } = repairedLegacyFixture();
  db.$client.exec("ALTER TABLE threads DROP COLUMN provider_session_lifetime; ALTER TABLE threads ADD provider_session_lifetime integer NOT NULL DEFAULT 1");
  const ledger = rows(db, "__drizzle_migrations");
  expect(() => migrate(db)).toThrow(/invalid.*lifetime/i);
  expect(rows(db, "__drizzle_migrations")).toEqual(ledger);
  expectNoPendingColumn(db);
});
