import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { constants, type Mode, type PathLike } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { copyFile, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EncryptedJournalFile, type JournalFileSystem } from './encrypted-file.js';
import { projectRunRecovery } from './recovery.js';
import { JournalTransitionError, reduceRunJournal } from './reducer.js';
import { parseRunJournalV1, type RunJournalV1 } from './schema.js';
import { JournalRevisionConflictError, RunJournalStore, type RunJournalSnapshot } from './store.js';

const key = (): string => randomBytes(32).toString('base64');
const NOW = '2026-08-03T12:00:00.000Z';

/**
 * Assert that a journal path is private to its owner.
 *
 * POSIX: exactly the mode the store asks for — 0o700 for the directory, 0o600 for a journal — and
 * nothing wider.
 *
 * Windows: `fs.chmod` there only toggles the read-only ATTRIBUTE; the mode reads back as 0o666 no
 * matter what was requested, so asserting a POSIX mode is not weakening the test, it is asserting
 * something the platform cannot express. Confidentiality on Windows comes from the ACL the journal
 * root inherits from the user profile directory, and the product sets no explicit ACL of its own.
 *
 * That is a real, unclosed gap, recorded here rather than papered over: closing it means an explicit
 * `icacls <path> /inheritance:r /grant:r "%USERNAME%":F` at store creation plus an icacls-based
 * assertion. Until then we assert the one property Windows does express and that the store depends
 * on operationally — the path exists, is the right kind of object, and is still writable, so the
 * next append can rewrite it.
 */
async function assertOwnerOnly(
  path: string,
  posixMode: number,
  kind: 'dir' | 'file',
): Promise<void> {
  const st = await stat(path);
  assert.equal(kind === 'dir' ? st.isDirectory() : st.isFile(), true, `${path} is not a ${kind}`);
  if (process.platform === 'win32') {
    // 0o200 is the only bit Windows actually reflects (the read-only attribute, inverted).
    assert.equal((st.mode & 0o200) !== 0, true, `${path} lost its write bit`);
    return;
  }
  assert.equal(
    st.mode & 0o777,
    posixMode,
    `${path} has wider permissions than ${posixMode.toString(8)}`,
  );
}

async function withStore(
  fn: (ctx: { dir: string; encryptionKey: string; store: RunJournalStore }) => Promise<void>,
  options: {
    maxEvents?: number;
    maxBytes?: number;
    clock?: () => string;
    flushDelayMs?: number;
    fs?: JournalFileSystem;
  } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'lobee-run-journal-'));
  const encryptionKey = key();
  const store = new RunJournalStore(dir, {
    encryptionKey,
    clock: () => NOW,
    ...options,
  });
  try {
    await fn({ dir, encryptionKey, store });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function append(
  store: RunJournalStore,
  snapshot: RunJournalSnapshot,
  event: Parameters<RunJournalStore['append']>[1],
): Promise<RunJournalSnapshot> {
  return store.append(snapshot.journal.runId, event, snapshot.journal.revision);
}

/**
 * The real filesystem with its physical costs recorded in order: the temp file a durable write
 * creates, every fsync, and the rename that publishes a revision. Order matters as much as count —
 * it is how a test proves a barrier's fsync and rename happened BEFORE its promise resolved, not
 * merely at some point.
 */
function countingFs(): { fs: JournalFileSystem; ops: string[]; count: (op: string) => number } {
  const ops: string[] = [];
  const fs: JournalFileSystem = {
    ...fsp,
    async open(path: PathLike, flags?: string | number, mode?: Mode) {
      const handle = await fsp.open(path, flags, mode);
      if (typeof flags === 'number' && (flags & constants.O_CREAT) !== 0) ops.push('create');
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        ops.push('sync');
        await sync();
      };
      return handle;
    },
    async rename(from: PathLike, to: PathLike) {
      ops.push('rename');
      await fsp.rename(from, to);
    },
  };
  return { fs, ops, count: (op) => ops.filter((entry) => entry === op).length };
}

/** What a process that starts AFTER a crash would read: the durable file, nothing from memory. */
async function onDisk(dir: string, encryptionKey: string, runId: string): Promise<RunJournalV1> {
  const files = new EncryptedJournalFile(dir, { encryptionKey });
  const plaintext = await files.read(files.resolveFile(`${runId}.journal`));
  assert.ok(plaintext !== null, `${runId}.journal is missing`);
  return parseRunJournalV1(JSON.parse(plaintext));
}

/** One durable write on this platform: temp create, file fsync, rename, then the directory fsync. */
const DURABLE_WRITE_OPS =
  process.platform === 'win32'
    ? ['create', 'sync', 'rename']
    : ['create', 'sync', 'rename', 'sync'];

/** A flush delay no test waits for: "the timer has not fired yet" is the state under test. */
const NEVER_MS = 60_000;

test('journal is AES-GCM encrypted, path-bound, and written with private permissions', async () => {
  await withStore(async ({ dir, encryptionKey, store }) => {
    let snapshot = await store.create({
      runId: 'run_secure',
      task: 'Open the private quarterly report',
      mode: 'agent',
      model: 'model-x',
    });
    snapshot = await append(store, snapshot, {
      type: 'action.proposed',
      actionId: 'a1',
      actionKind: 'navigate',
      effect: 'read',
      summary: 'Navigate to the private report host',
      host: 'reports.example',
    });

    const path = join(dir, 'run_secure.journal');
    const raw = await readFile(path, 'utf8');
    assert.match(raw, /^lobee-run-journal-v1:/);
    assert.doesNotMatch(raw, /private quarterly report|reports\.example|model-x/);
    await assertOwnerOnly(dir, 0o700, 'dir');
    await assertOwnerOnly(path, 0o600, 'file');

    // Authenticated additional data binds ciphertext to its final relative path. A copied envelope
    // cannot become another run merely because its filename changed.
    await store.create({ runId: 'other', task: 'Other task', mode: 'agent' });
    await copyFile(path, join(dir, 'other.journal'));
    await assert.rejects(store.load('other'), /authentication failed/);

    // The original remains readable with the same key.
    const reopened = new RunJournalStore(dir, { encryptionKey });
    assert.equal((await reopened.load('run_secure'))?.journal.revision, 2);
  });
});

test('a missing journal root is durably created under its parent with private permissions', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'lobee-run-journal-parent-'));
  const dir = join(parent, 'journals');
  try {
    const store = new RunJournalStore(dir, { encryptionKey: key() });
    await store.create({ runId: 'created_root', task: 'task', mode: 'agent' });
    await assertOwnerOnly(dir, 0o700, 'dir');
    await assertOwnerOnly(join(dir, 'created_root.journal'), 0o600, 'file');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('wrong key, tampering, unsupported envelope/schema versions, and plaintext fail closed', async () => {
  await withStore(async ({ dir, encryptionKey, store }) => {
    await store.create({ runId: 'wrong_key', task: 'task', mode: 'agent' });
    const wrong = new RunJournalStore(dir, { encryptionKey: key() });
    await assert.rejects(wrong.load('wrong_key'), /authentication failed/);

    await store.create({ runId: 'tampered', task: 'task', mode: 'agent' });
    const tamperedPath = join(dir, 'tampered.journal');
    const ciphertext = await readFile(tamperedPath, 'utf8');
    const final = ciphertext.at(-1) === 'A' ? 'B' : 'A';
    await writeFile(tamperedPath, ciphertext.slice(0, -1) + final, { mode: 0o600 });
    await assert.rejects(store.load('tampered'), /authentication failed|corrupt/);

    const files = new EncryptedJournalFile(dir, { encryptionKey });
    await files.write(
      files.resolveFile('future.journal'),
      JSON.stringify({
        version: 2,
        runId: 'future',
        createdAt: NOW,
        updatedAt: NOW,
        revision: 1,
        sensitive: false,
        events: [{ type: 'run.started', seq: 1, at: NOW, task: 'x', mode: 'agent' }],
      }),
    );
    await assert.rejects(store.load('future'), /unsupported version 2/);

    await files.write(
      files.resolveFile('unsafe-v1.journal'),
      JSON.stringify({
        version: 1,
        runId: 'unsafe-v1',
        createdAt: NOW,
        updatedAt: NOW,
        revision: 1,
        sensitive: false,
        events: [
          {
            type: 'run.started',
            seq: 1,
            at: NOW,
            task: 'Use password: synthetic-secret-value',
            mode: 'agent',
          },
        ],
      }),
    );
    await assert.rejects(store.load('unsafe-v1'), /unsanitized sensitive material/);

    await writeFile(join(dir, 'plaintext.journal'), '{"version":1}', { mode: 0o600 });
    await assert.rejects(store.load('plaintext'), /unsupported envelope version/);
  });
});

test('path traversal, final symlinks, and a symlink journal root are refused', async () => {
  await withStore(async ({ dir, store }) => {
    await assert.rejects(
      store.create({ runId: '../escape', task: 'x', mode: 'agent' }),
      /opaque identifier/,
    );
    await assert.rejects(store.load('../../escape'), /opaque identifier/);

    const outside = join(dir, '..', `outside-${randomBytes(4).toString('hex')}`);
    await writeFile(outside, 'not a journal', { mode: 0o600 });
    try {
      await symlink(outside, join(dir, 'linked.journal'));
      await assert.rejects(store.load('linked'), /symbolic link|ELOOP|regular journal file/);
    } finally {
      await rm(outside, { force: true });
    }
  });

  const parent = await mkdtemp(join(tmpdir(), 'lobee-journal-symlink-root-'));
  try {
    const actual = join(parent, 'actual');
    const linked = join(parent, 'linked');
    const bootstrap = new RunJournalStore(actual, { encryptionKey: key() });
    await bootstrap.create({ runId: 'seed', task: 'x', mode: 'agent' });
    await symlink(actual, linked);
    assert.equal((await lstat(linked)).isSymbolicLink(), true);
    const throughLink = new RunJournalStore(linked, { encryptionKey: key() });
    await assert.rejects(
      throughLink.create({ runId: 'escape', task: 'x', mode: 'agent' }),
      /must not be a symlink/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('strict schema rejects extra payloads, non-contiguous revisions, and unknown events', () => {
  const base = {
    version: 1,
    runId: 'run1',
    createdAt: NOW,
    updatedAt: NOW,
    revision: 1,
    sensitive: false,
    events: [{ type: 'run.started', seq: 1, at: NOW, task: 'x', mode: 'agent' }],
  };
  assert.throws(() => parseRunJournalV1({ ...base, screenshot: 'base64' }), /unexpected field/);
  assert.throws(() => parseRunJournalV1({ ...base, revision: 2 }), /revision/);
  assert.throws(() => parseRunJournalV1({ ...base, createdAt: 'August 3, 2026' }), /not ISO-8601/);
  assert.throws(
    () =>
      parseRunJournalV1({
        ...base,
        revision: 2,
        events: [...base.events, { type: 'action.magic', seq: 2, at: NOW }],
      }),
    /unknown event type/,
  );
  assert.throws(
    () => parseRunJournalV1({ ...base, events: [{ ...base.events[0], seq: 2 }] }),
    /contiguous/,
  );
});

test('append scrubs credentials, provider endpoints, image payloads, and raw upload paths', async () => {
  await withStore(async ({ dir, store }) => {
    const secret = 'VENICE_INFERENCE_KEY_testOnly_00000000000000000000000000000000';
    let snapshot = await store.create({
      runId: 'sensitive',
      task: `Use api key: ${secret} at https://api.openai.com/v1/chat/completions`,
      mode: 'agent',
    });
    snapshot = await append(store, snapshot, {
      type: 'action.proposed',
      actionId: 'upload-1',
      actionKind: 'upload',
      effect: 'consequential',
      summary: `Upload /home/alice/private/customer.csv with screenshot data:image/png;base64,${'A'.repeat(300)}`,
      host: 'example.com',
    });

    const serialized = JSON.stringify(snapshot.journal);
    assert.equal(snapshot.journal.sensitive, true);
    assert.doesNotMatch(
      serialized,
      /testOnly_000|api\.openai\.com|\/home\/alice|data:image|A{100}/,
    );
    assert.match(serialized, /REDACTED_CREDENTIAL/);
    assert.match(serialized, /REDACTED_PROVIDER_ENDPOINT/);
    assert.match(serialized, /REDACTED_LOCAL_PATH/);
    assert.match(serialized, /REDACTED_IMAGE_PAYLOAD/);

    const raw = await readFile(join(dir, 'sensitive.journal'), 'utf8');
    assert.doesNotMatch(raw, /testOnly_000|api\.openai\.com|customer\.csv|data:image/);

    const before = snapshot.journal.revision;
    await assert.rejects(
      store.append(
        'sensitive',
        {
          type: 'action.dispatching',
          actionId: 'upload-1',
          screenshot: 'forbidden',
          rawUploadPath: '/home/alice/private/customer.csv',
        } as never,
        before,
      ),
      /unexpected field/,
    );
    assert.equal((await store.load('sensitive'))?.journal.revision, before);
  });
});

test('secret-shaped proposal hosts are omitted and make the journal sensitive before write', async () => {
  await withStore(async ({ store }) => {
    const secretHost = 'tsk-syntheticjournalhost123.example.com';
    let snapshot = await store.create({ runId: 'secret_host', task: 'task', mode: 'agent' });
    snapshot = await append(store, snapshot, {
      type: 'action.proposed',
      actionId: 'a1',
      actionKind: 'navigate',
      effect: 'write',
      summary: 'Proposed navigate action',
      host: secretHost,
    });

    assert.equal(snapshot.journal.sensitive, true);
    assert.equal(snapshot.state.sensitive, true);
    assert.equal(JSON.stringify(snapshot.journal).includes(secretHost), false);
    const proposal = snapshot.journal.events.find((event) => event.type === 'action.proposed');
    assert.ok(proposal?.type === 'action.proposed');
    assert.equal(proposal.host, undefined);

    // The persistence boundary must not create a file that it rejects on its own next authenticated
    // read. Appending after reopening proves the redacted journal remains usable.
    const reopened = await store.load('secret_host');
    assert.ok(reopened);
    snapshot = await append(store, reopened, {
      type: 'action.cancelled',
      actionId: 'a1',
      summary: 'Cancelled safely',
    });
    assert.equal(snapshot.state.phase, 'running');
  });
});

test('generated append timestamps survive a backward clock correction while explicit times stay strict', async () => {
  let clock = '2099-01-01T00:00:00.000Z';
  await withStore(
    async ({ store }) => {
      const generated = await store.create({
        runId: 'generated_time',
        task: 'task',
        mode: 'agent',
      });
      const explicit = await store.create({
        runId: 'explicit_time',
        task: 'task',
        mode: 'agent',
      });
      clock = '2026-08-10T00:00:00.000Z';

      const stopped = await append(store, generated, {
        type: 'run.stopped',
        summary: 'Clock corrected',
      });
      assert.equal(stopped.state.phase, 'stopped');
      assert.equal(stopped.journal.updatedAt, '2099-01-01T00:00:00.000Z');
      assert.equal(stopped.journal.events.at(-1)?.at, '2099-01-01T00:00:00.000Z');

      await assert.rejects(
        append(store, explicit, {
          type: 'run.stopped',
          summary: 'Caller supplied an older time',
          at: '2026-08-10T00:00:00.000Z',
        }),
        /event timestamps may not move backwards/,
      );
      assert.equal((await store.load('explicit_time'))?.journal.revision, 1);
      assert.equal((await store.load('explicit_time'))?.state.phase, 'running');
    },
    { clock: () => clock },
  );
});

test('the reducer enforces action lifecycle and refuses to terminalize ambiguous effects', async () => {
  await withStore(async ({ store }) => {
    let snapshot = await store.create({ runId: 'lifecycle', task: 'x', mode: 'agent' });
    await assert.rejects(
      append(store, snapshot, { type: 'action.dispatching', actionId: 'missing' }),
      JournalTransitionError,
    );
    assert.equal((await store.load('lifecycle'))?.journal.revision, 1);

    snapshot = await append(store, snapshot, {
      type: 'action.proposed',
      actionId: 'a1',
      actionKind: 'click',
      effect: 'consequential',
      summary: 'Submit purchase',
    });
    snapshot = await append(store, snapshot, {
      type: 'approval.requested',
      actionId: 'a1',
    });
    await assert.rejects(
      append(store, snapshot, {
        type: 'approval.resolved',
        actionId: 'wrong',
        decision: 'approved',
      }),
      /does not match the active action/,
    );
    snapshot = await append(store, snapshot, {
      type: 'approval.resolved',
      actionId: 'a1',
      decision: 'approved',
    });
    snapshot = await append(store, snapshot, { type: 'action.dispatching', actionId: 'a1' });
    await assert.rejects(
      append(store, snapshot, { type: 'run.failed', summary: 'driver disappeared' }),
      /not valid while dispatching/,
    );
    snapshot = await append(store, snapshot, {
      type: 'action.observed',
      actionId: 'a1',
      outcome: 'unknown',
      summary: 'No acknowledgement was received',
    });
    await assert.rejects(
      append(store, snapshot, { type: 'run.stopped', summary: 'stop' }),
      /not valid while recovery_required/,
    );
    snapshot = await append(store, snapshot, {
      type: 'recovery.resolved',
      actionId: 'a1',
      resolution: 'verified_not_applied',
      summary: 'Live page shows no order',
    });
    snapshot = await append(store, snapshot, { type: 'run.stopped', summary: 'Stopped safely' });
    assert.equal(snapshot.state.phase, 'stopped');
    await assert.rejects(
      append(store, snapshot, { type: 'run.failed', summary: 'late' }),
      /follows terminal state/,
    );
  });
});

test('unexpected-navigation reconciliation survives rejection until rollback is verified', async () => {
  await withStore(async ({ store }) => {
    let snapshot = await store.create({ runId: 'drift', task: 'x', mode: 'agent' });
    snapshot = await append(store, snapshot, {
      type: 'action.proposed',
      actionId: 'reconcile-1',
      actionKind: 'navigation_reconcile',
      effect: 'write',
      summary: 'Unexpected navigation requires reconciliation',
    });
    snapshot = await append(store, snapshot, {
      type: 'approval.requested',
      actionId: 'reconcile-1',
    });
    await assert.rejects(
      append(store, snapshot, { type: 'run.failed', summary: 'lost panel' }),
      /cannot hide unresolved unexpected navigation/,
    );
    snapshot = await append(store, snapshot, {
      type: 'approval.resolved',
      actionId: 'reconcile-1',
      decision: 'rejected',
    });
    assert.equal(snapshot.state.phase, 'proposed');
    assert.equal(snapshot.state.activeAction?.actionKind, 'navigation_reconcile');
    snapshot = await append(store, snapshot, {
      type: 'action.dispatching',
      actionId: 'reconcile-1',
    });
    snapshot = await append(store, snapshot, {
      type: 'action.observed',
      actionId: 'reconcile-1',
      outcome: 'succeeded',
      summary: 'Prior page restored and verified',
    });
    snapshot = await append(store, snapshot, { type: 'run.stopped', summary: 'safe' });
    assert.equal(snapshot.state.phase, 'stopped');
  });
});

test('per-run serialization plus expected revisions prevents lost concurrent appends', async () => {
  await withStore(async ({ dir, encryptionKey, store }) => {
    const snapshot = await store.create({ runId: 'race', task: 'x', mode: 'agent' });
    const secondFacade = new RunJournalStore(dir, { encryptionKey, clock: () => NOW });
    const proposal = (actionId: string) =>
      (actionId === 'a1' ? store : secondFacade).append(
        'race',
        {
          type: 'action.proposed',
          actionId,
          actionKind: 'navigate',
          effect: 'read',
          summary: actionId,
        },
        snapshot.journal.revision,
      );
    const settled = await Promise.allSettled([proposal('a1'), proposal('a2')]);
    assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1);
    const rejected = settled.find((item) => item.status === 'rejected');
    assert.ok(rejected?.status === 'rejected');
    assert.ok(rejected.reason instanceof JournalRevisionConflictError);
    assert.equal((await store.load('race'))?.journal.revision, 2);
  });
});

test('event and byte caps reject the write without corrupting the last durable revision', async () => {
  await withStore(
    async ({ store }) => {
      let snapshot = await store.create({ runId: 'capped', task: 'x', mode: 'agent' });
      snapshot = await append(store, snapshot, {
        type: 'action.proposed',
        actionId: 'a1',
        actionKind: 'navigate',
        effect: 'read',
        summary: 'x',
      });
      await assert.rejects(
        append(store, snapshot, { type: 'action.dispatching', actionId: 'a1' }),
        /event cap exceeded/,
      );
      assert.equal((await store.load('capped'))?.journal.revision, 2);
    },
    { maxEvents: 2 },
  );

  await withStore(
    async ({ dir, store }) => {
      await assert.rejects(
        store.create({ runId: 'oversized', task: 'x'.repeat(5_000), mode: 'agent' }),
        /byte cap|exceeds/,
      );
      await assert.rejects(stat(join(dir, 'oversized.journal')), /ENOENT/);

      // A buffered append is capped when it is ACCEPTED, so the event that crosses the cap is the
      // one refused — not an unrelated flush seconds later, long after its caller moved on.
      let snapshot = await store.create({ runId: 'buffered', task: 'x', mode: 'agent' });
      const proposal = (summary: string): Parameters<RunJournalStore['append']>[1] => ({
        type: 'action.proposed',
        actionId: 'a1',
        actionKind: 'navigate',
        effect: 'read',
        summary,
      });
      await assert.rejects(
        append(store, snapshot, proposal('y'.repeat(1_000))),
        /byte cap|exceeds/,
      );
      snapshot = await append(store, snapshot, proposal('y'));
      assert.equal(snapshot.journal.revision, 2);
      assert.equal((await store.load('buffered'))?.journal.revision, 2);
    },
    { maxBytes: 1_024 },
  );
});

test('an interrupted temp file is ignored and never replaces the durable revision', async () => {
  await withStore(async ({ dir, store }) => {
    await store.create({ runId: 'stable', task: 'durable task', mode: 'agent' });
    await writeFile(join(dir, '.stable.journal.interrupted.tmp'), 'partial ciphertext', {
      mode: 0o600,
    });
    const loaded = await store.load('stable');
    assert.equal(loaded?.journal.revision, 1);
    assert.equal(loaded?.state.task, 'durable task');
    assert.deepEqual(await store.listRunIds(), ['stable']);
  });
});

test('retention prunes only authenticated terminal journals and never unfinished/corrupt ones', async () => {
  await withStore(async ({ dir, store }) => {
    await store.create({
      runId: 'unfinished',
      task: 'keep me',
      mode: 'agent',
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    let finished = await store.create({
      runId: 'finished',
      task: 'delete me',
      mode: 'agent',
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    finished = await store.append(
      'finished',
      { type: 'run.completed', summary: 'done', at: '2020-01-01T00:01:00.000Z' },
      finished.journal.revision,
    );
    assert.equal(finished.state.phase, 'completed');
    await writeFile(join(dir, 'corrupt.journal'), 'corrupt', { mode: 0o600 });

    const pruned = await store.pruneFinished({ finishedBefore: '2021-01-01T00:00:00.000Z' });
    assert.deepEqual(pruned.deleted, ['finished']);
    assert.deepEqual(pruned.retainedUnreadable, ['corrupt']);
    assert.ok(await store.load('unfinished'));
    assert.equal(await stat(join(dir, 'corrupt.journal')).then(() => true), true);
    await assert.rejects(store.listUnfinished(), /unsupported envelope version/);
  });
});

test('removeFinished deletes only a PROVABLY terminal journal, never an unfinished one', async () => {
  await withStore(async ({ dir, store }) => {
    await store.create({ runId: 'unfinished', task: 'task', mode: 'agent' });
    let finished = await store.create({ runId: 'finished', task: 'task', mode: 'agent' });
    finished = await store.append(
      'finished',
      { type: 'run.completed', summary: 'done' },
      finished.journal.revision,
    );
    assert.equal(finished.state.phase, 'completed');

    // The unfinished journal is the ONE kind that still carries recovery meaning: refusing to
    // delete it — whatever the caller believes — is what makes the primitive safe to call from
    // completion paths and admission sweeps alike.
    assert.equal(await store.removeFinished('unfinished'), false);
    assert.ok(await store.load('unfinished'), 'the unfinished journal must survive');

    assert.equal(await store.removeFinished('finished'), true);
    assert.equal(await store.load('finished'), null);
    // The delete is idempotent and unreadable-safe: a second call finds nothing and says so.
    assert.equal(await store.removeFinished('finished'), false);

    // Corrupt bytes are not provably terminal → retained, exactly like pruneFinished.
    await writeFile(join(dir, 'mangled.journal'), 'garbage', { mode: 0o600 });
    assert.equal(await store.removeFinished('mangled'), false);
    assert.equal(await stat(join(dir, 'mangled.journal')).then(() => true), true);
  });
});

test('quarantineUnreadable moves only a journal that is unreadable RIGHT NOW, under the lock', async () => {
  await withStore(async ({ dir, store }) => {
    // A healthy journal is refused, whatever failure the caller previously observed — between the
    // caller's read and this call the file could have been repaired, and renaming it would silently
    // discard real recovery state.
    await store.create({ runId: 'healthy', task: 'task', mode: 'agent' });
    assert.equal(await store.quarantineUnreadable('healthy'), false);
    assert.ok(await store.load('healthy'));

    await writeFile(join(dir, 'mangled.journal'), 'lobee-run-journal-v1:garbage', { mode: 0o600 });
    assert.equal(await store.quarantineUnreadable('mangled'), true);
    // The bytes survive under a name listRunIds can never match again.
    assert.equal(
      await stat(join(dir, 'mangled.journal')).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(
      await stat(join(dir, 'mangled.journal.corrupt')).then(
        () => true,
        () => false,
      ),
      true,
    );
    assert.deepEqual(await store.listRunIds(), ['healthy']);
  });
});

test('non-barrier appends are batched; only the dispatch barrier pays for durability, before it resolves', async () => {
  const { fs, ops, count } = countingFs();
  await withStore(
    async ({ dir, encryptionKey, store }) => {
      let snapshot = await store.create({ runId: 'batched', task: 'x', mode: 'agent' });
      assert.deepEqual(ops, DURABLE_WRITE_OPS, 'creation is one durable write');

      // Three events that precede no browser effect: accepted, sequenced, reduced — and not written.
      snapshot = await append(store, snapshot, {
        type: 'action.proposed',
        actionId: 'a1',
        actionKind: 'click',
        effect: 'consequential',
        summary: 'Submit the order',
        host: 'shop.example',
      });
      snapshot = await append(store, snapshot, { type: 'approval.requested', actionId: 'a1' });
      snapshot = await append(store, snapshot, {
        type: 'approval.resolved',
        actionId: 'a1',
        decision: 'approved',
      });
      assert.equal(snapshot.journal.revision, 4);
      assert.equal(snapshot.state.phase, 'approved');
      assert.equal(count('rename'), 1, 'no physical write for a non-barrier event');
      assert.equal((await onDisk(dir, encryptionKey, 'batched')).revision, 1);

      // The barrier: one durable write that carries everything before it, finished — temp file
      // fsynced, renamed into place, directory fsynced — before the promise resolves.
      const before = ops.length;
      snapshot = await append(store, snapshot, { type: 'action.dispatching', actionId: 'a1' });
      assert.deepEqual(ops.slice(before), DURABLE_WRITE_OPS);
      assert.equal(count('rename'), 2, 'four appends cost one physical write, not four');
      const durable = await onDisk(dir, encryptionKey, 'batched');
      assert.equal(durable.revision, 5);
      assert.deepEqual(durable.events, snapshot.journal.events);

      // A crash between batched events: what follows the barrier is still in memory, but nothing
      // the barrier covered is lost, and the durable prefix ends on a state recovery understands.
      snapshot = await append(store, snapshot, {
        type: 'action.observed',
        actionId: 'a1',
        outcome: 'succeeded',
        summary: 'Order submitted',
      });
      snapshot = await append(store, snapshot, {
        type: 'action.proposed',
        actionId: 'a2',
        actionKind: 'extract_text',
        effect: 'read',
        summary: 'Read the confirmation',
      });
      assert.equal(snapshot.journal.revision, 7);
      assert.equal(count('rename'), 2);
      const crashed = await onDisk(dir, encryptionKey, 'batched');
      assert.equal(crashed.revision, 5);
      assert.deepEqual(crashed.events, snapshot.journal.events.slice(0, 5));
      const recovered = reduceRunJournal(crashed);
      assert.equal(recovered.phase, 'dispatching');
      assert.deepEqual(projectRunRecovery(recovered), {
        kind: 'recovery_required',
        reason: 'side_effect_may_have_occurred',
        actionId: 'a1',
      });

      // An explicit flush lands the remainder in one more write, and a terminal marker is a barrier
      // of its own: the process that deletes or sweeps the file must find it on disk.
      await store.flush('batched');
      assert.equal(count('rename'), 3);
      assert.deepEqual(
        (await onDisk(dir, encryptionKey, 'batched')).events,
        snapshot.journal.events,
      );
      snapshot = await append(store, snapshot, {
        type: 'action.cancelled',
        actionId: 'a2',
        summary: 'Not needed',
      });
      snapshot = await append(store, snapshot, { type: 'run.completed', summary: 'done' });
      assert.equal(count('rename'), 4, 'the cancellation rode along with the terminal barrier');
      assert.equal((await onDisk(dir, encryptionKey, 'batched')).revision, 9);
      assert.equal(await store.removeFinished('batched'), true);
    },
    { flushDelayMs: NEVER_MS, fs },
  );
});

test('buffered events reach the disk on the flush timer even when no barrier follows', async () => {
  const { fs, count } = countingFs();
  await withStore(
    async ({ dir, encryptionKey, store }) => {
      const snapshot = await store.create({ runId: 'timed', task: 'x', mode: 'agent' });
      await append(store, snapshot, {
        type: 'action.proposed',
        actionId: 'a1',
        actionKind: 'navigate',
        effect: 'read',
        summary: 'Open the page',
      });
      assert.equal(count('rename'), 1);
      const deadline = Date.now() + 5_000;
      while (count('rename') < 2 && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
      assert.equal(count('rename'), 2, 'the timer wrote the buffer without a barrier');
      await store.flush('timed'); // wait for the timer's write to release the run before reading
      assert.equal((await onDisk(dir, encryptionKey, 'timed')).revision, 2);
    },
    { flushDelayMs: 10, fs },
  );
});

test('every reader sees the buffer durably, facades with the key share it, a wrong key never does', async () => {
  const { fs, count } = countingFs();
  await withStore(
    async ({ dir, encryptionKey, store }) => {
      let snapshot = await store.create({ runId: 'shared', task: 'x', mode: 'agent' });
      snapshot = await append(store, snapshot, {
        type: 'action.proposed',
        actionId: 'a1',
        actionKind: 'click',
        effect: 'write',
        summary: 'Press the button',
      });
      assert.equal(count('rename'), 1);

      // A second facade over the same directory and key — the sidecar builds one per bridge request
      // — reads through the shared buffer: the read writes it first, so the revision it reports is
      // one the disk actually holds.
      const twin = new RunJournalStore(dir, {
        encryptionKey,
        clock: () => NOW,
        flushDelayMs: NEVER_MS,
        fs,
      });
      const seen = await twin.load('shared');
      assert.equal(seen?.journal.revision, 2);
      assert.equal(count('rename'), 2, 'a read makes the buffer durable before answering');
      assert.equal((await onDisk(dir, encryptionKey, 'shared')).revision, 2);

      // The buffer is one per (directory, key, run): the twin appends into it, the original
      // continues from what the twin accepted, and neither write reached the disk.
      const viaTwin = await twin.append(
        'shared',
        { type: 'approval.requested', actionId: 'a1' },
        2,
      );
      const viaOriginal = await append(store, viaTwin, {
        type: 'approval.resolved',
        actionId: 'a1',
        decision: 'approved',
      });
      assert.equal(viaOriginal.journal.revision, 4);
      assert.equal(count('rename'), 2);

      // A facade holding a different key has no buffer to read and fails at the authenticated
      // file exactly as before batching — the plaintext in memory is bound to the key, not the path.
      const stranger = new RunJournalStore(dir, { encryptionKey: key(), flushDelayMs: NEVER_MS });
      await assert.rejects(stranger.load('shared'), /authentication failed/);
    },
    { flushDelayMs: NEVER_MS, fs },
  );
});

test('a durable file changed behind the buffer is a revision conflict, never a silent overwrite', async () => {
  await withStore(
    async ({ dir, encryptionKey, store }) => {
      const snapshot = await store.create({ runId: 'guarded', task: 'x', mode: 'agent' });
      const buffered = await append(store, snapshot, {
        type: 'action.proposed',
        actionId: 'a1',
        actionKind: 'click',
        effect: 'write',
        summary: 'Press the button',
      });
      assert.equal(buffered.journal.revision, 2);

      // Another process closes the run underneath this one (the file is at revision 1 on disk).
      const files = new EncryptedJournalFile(dir, { encryptionKey });
      const path = files.resolveFile('guarded.journal');
      const current = await onDisk(dir, encryptionKey, 'guarded');
      await files.write(
        path,
        JSON.stringify({
          ...current,
          updatedAt: NOW,
          revision: 2,
          events: [
            ...current.events,
            { type: 'run.stopped', seq: 2, at: NOW, summary: 'Closed by another process' },
          ],
        }),
      );

      // The barrier re-reads the file before writing and refuses to overwrite what it did not
      // expect; the other process's terminal marker survives, and the stale buffer is discarded so
      // the store describes the file again, not its memory.
      await assert.rejects(
        append(store, buffered, { type: 'action.dispatching', actionId: 'a1' }),
        JournalRevisionConflictError,
      );
      assert.equal(
        (await onDisk(dir, encryptionKey, 'guarded')).events.at(-1)?.type,
        'run.stopped',
      );
      const reloaded = await store.load('guarded');
      assert.equal(reloaded?.journal.revision, 2);
      assert.equal(reloaded?.state.phase, 'stopped');
    },
    { flushDelayMs: NEVER_MS },
  );
});
