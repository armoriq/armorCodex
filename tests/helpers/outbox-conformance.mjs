/* Shared adapter contract for ArmorClaude, ArmorCodex, ArmorOpenCode and ArmorAntigravity.
 * makeAdapter({ login, clock, sizeLimits, timing }) creates an isolated store, or uses the reference below.
 * clock has now(), random(), advance(ms). timing has baseMs, maxMs, lockTtlMs, authProbeMs.
 */
/* append(row, { fallback?, loggedOut? }?) resolves only after durable capture, or rejects on write failure.
 * drain(send, { probe }?) runs one eligible pass; send({ login, rows }) returns { status, body, headers? } or throws.
 * body is parsed JSON or unreadable text; results use the backend wire format. headers use lower case.
 */
/* readPending() returns [{ row, login, attempts, nextAttemptAt }]; readDeadLetters() returns [{ row, reason, attempts }].
 * status() returns { undeliverable, captureFailures, deadLetters }, as shown by the plugin's local status command.
 * switchLogin(login | null) changes credentials; login is { backend, keyId, available?: boolean }.
 */
/* secondDrainer() opens the same store with a separate lock owner; restart() loses volatile state and replays storage.
 * failNext('append' | 'ack' | 'deadLetter') injects a storage failure before the corresponding atomic commit.
 * Real adapters bridge these controls to their own queue, fault injection and lock implementation.
 */
/* probe({ login }) returns { status } or throws; a paused login probes when authProbeMs elapses.
 * authenticationSucceeded(login) reports a successful authenticated call with that exact backend and key id.
 * ArmorClaude, ArmorCodex, ArmorOpenCode and ArmorAntigravity keep row attempts for non transient refusals only.
 */

import assert from 'node:assert/strict';

const copy = (value) => JSON.parse(JSON.stringify(value));
const bytes = (value) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
const loginA = { backend: 'https://a.invalid', keyId: 'key-a' };
const row = (n = 1) => ({
  client_row_id: `11111111-1111-5111-8111-${String(n).padStart(12, '0')}`,
  session_id: 'root-session',
  plan_id: '22222222-2222-5222-8222-222222222222',
  context_plan_id: '33333333-3333-5333-8333-333333333333',
  prompt_id: 'prompt-at-decision',
  tool: 'Bash',
  action: 'Bash',
  status: 'blocked',
  decision_code: 'policy_deny',
  executed_at: '2026-11-14T12:00:00.000Z',
  duration_ms: 0,
  input: { command: 'pwd' },
  output: null,
});
const outcomes = (rows, outcome = 'accepted') => ({
  status: 200,
  body: {
    results: rows.map(({ client_row_id }) => ({ client_row_id, outcome })),
  },
});
const accept = async ({ rows }) => outcomes(rows);
const pendingIds = async (adapter) =>
  (await adapter.readPending()).map(({ row }) => row.client_row_id);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function observeSenderAssertions(adapter) {
  return {
    append: (...args) => adapter.append(...args),
    readPending: () => adapter.readPending(),
    readDeadLetters: () => adapter.readDeadLetters(),
    status: () => adapter.status(),
    switchLogin: (login) => adapter.switchLogin(login),
    authenticationSucceeded: (login) => adapter.authenticationSucceeded(login),
    failNext: (point) => adapter.failNext(point),
    restart: async () => observeSenderAssertions(await adapter.restart()),
    secondDrainer: async () =>
      observeSenderAssertions(await adapter.secondDrainer()),
    async drain(send, { probe } = {}) {
      let assertion;
      const observe = (callback) => async (request) => {
        try {
          return await callback(request);
        } catch (error) {
          if (error instanceof assert.AssertionError) assertion = error;
          throw error;
        }
      };
      try {
        await adapter.drain(observe(send), {
          probe: probe ? observe(probe) : undefined,
        });
      } finally {
        if (assertion) throw assertion;
      }
    },
  };
}

export function defineOutboxConformance({
  describe,
  it,
  makeAdapter = makeReferenceAdapter,
}) {
  async function setup({ sizeLimits = {}, random = 0.5, login = loginA } = {}) {
    let now = Date.parse('2026-11-14T12:00:00.000Z');
    const clock = {
      now: () => now,
      random: () => random,
      advance: (ms) => {
        now += ms;
      },
    };
    const limits = {
      maxRowBytes: 1024,
      maxBatchBytes: 4096,
      maxBatchRows: 10,
      truncationMarker: { truncated: true },
      ...sizeLimits,
    };
    const timing = {
      baseMs: 1000,
      maxMs: 8000,
      lockTtlMs: 100,
      authProbeMs: 120_000,
    };
    const adapter = observeSenderAssertions(
      await makeAdapter({
        login: copy(login),
        clock,
        sizeLimits: limits,
        timing,
      }),
    );
    return { adapter, clock, limits, timing };
  }

  async function advanceToRetry(adapter, clock) {
    const pending = await adapter.readPending();
    clock.advance(
      Math.max(
        0,
        ...pending.map(({ nextAttemptAt }) => nextAttemptAt - clock.now()),
      ),
    );
  }

  describe('durable outbox v1.1', () => {
    it('R1: append survives immediate restart before any drain', async () => {
      const { adapter } = await setup();
      await adapter.append(row());
      const recovered = await adapter.restart();
      assert.deepEqual(
        (await recovered.readPending()).map(({ row }) => row),
        [row()],
      );
    });

    it('R1: a failed append is visible to the hook caller', async () => {
      const { adapter } = await setup();
      await adapter.failNext('append');
      await assert.rejects(() => adapter.append(row()), /injected/);
      assert.deepEqual(await pendingIds(await adapter.restart()), []);
    });

    it('R2: retries preserve the captured identity, context and times', async () => {
      const { adapter, clock } = await setup();
      const captured = row();
      const expected = copy(captured);
      await adapter.append(captured);
      captured.plan_id = 'later-plan';
      captured.prompt_id = 'later-prompt';
      captured.input.command = 'later-command';
      await adapter.drain(async ({ rows }) => {
        assert.deepEqual(rows, [expected]);
        rows[0].session_id = 'sender-mutation';
        return { status: 503, body: {} };
      });
      await advanceToRetry(adapter, clock);
      await (await adapter.restart()).drain(async ({ rows }) => {
        assert.deepEqual(rows, [expected]);
        return outcomes(rows, 'duplicate');
      });
      assert.deepEqual(await pendingIds(adapter), []);
    });

    it('R3: a second drainer cannot send while the queue lock is live', async () => {
      const { adapter } = await setup();
      await adapter.append(row());
      const entered = deferred();
      const release = deferred();
      const first = adapter.drain(async ({ rows }) => {
        entered.resolve();
        await release.promise;
        return outcomes(rows);
      });
      await entered.promise;
      try {
        await (await adapter.secondDrainer()).drain(() =>
          assert.fail('second drainer sent'),
        );
        assert.deepEqual(await pendingIds(adapter), [row().client_row_id]);
      } finally {
        release.resolve();
        await first;
      }
    });

    it('R3: stale takeover fences the old owner from acknowledgement and lock release', async () => {
      const { adapter, clock, timing } = await setup();
      await adapter.append(row());
      const entered = deferred();
      const oldReply = deferred();
      const newEntered = deferred();
      const newReply = deferred();
      const first = adapter.drain(async ({ rows }) => {
        entered.resolve();
        await oldReply.promise;
        return outcomes(rows);
      });
      await entered.promise;
      clock.advance(timing.lockTtlMs + 1);
      const second = (await adapter.secondDrainer()).drain(async ({ rows }) => {
        newEntered.resolve();
        await newReply.promise;
        return outcomes(rows);
      });
      await newEntered.promise;
      try {
        oldReply.resolve();
        await first;
        assert.deepEqual(await pendingIds(adapter), [row().client_row_id]);
        await (await adapter.secondDrainer()).drain(() =>
          assert.fail('old owner released the new lock'),
        );
      } finally {
        newReply.resolve();
        await second;
      }
      assert.deepEqual(await pendingIds(adapter), []);
    });

    it('R4: a failed acknowledgement replays the same row, then duplicate completes it', async () => {
      const { adapter } = await setup();
      await adapter.append(row());
      await adapter.failNext('ack');
      await assert.rejects(() => adapter.drain(accept), /injected/);
      const recovered = await adapter.restart();
      assert.deepEqual(await pendingIds(recovered), [row().client_row_id]);
      await recovered.drain(async ({ rows }) => outcomes(rows, 'duplicate'));
      assert.deepEqual(await pendingIds(await recovered.restart()), []);
    });

    it('R4: acknowledging a batch preserves a row appended while the sender runs', async () => {
      const { adapter } = await setup();
      await adapter.append(row(1));
      await adapter.drain(async ({ rows }) => {
        await adapter.append(row(2));
        return outcomes(rows);
      });
      assert.deepEqual(await pendingIds(await adapter.restart()), [
        row(2).client_row_id,
      ]);
    });

    it('R5: a failed dead letter commit loses nothing and recovery counts it once', async () => {
      const { adapter } = await setup();
      await adapter.append(row());
      await adapter.failNext('deadLetter');
      const reject = async ({ rows }) => ({
        status: 200,
        body: {
          results: rows.map(({ client_row_id }) => ({
            client_row_id,
            outcome: 'rejected',
            error: 'invalid tool',
          })),
        },
      });
      await assert.rejects(() => adapter.drain(reject), /injected/);
      const recovered = await adapter.restart();
      assert.deepEqual(await pendingIds(recovered), [row().client_row_id]);
      assert.deepEqual(await recovered.readDeadLetters(), []);
      await recovered.drain(reject);
      const reopened = await recovered.restart();
      assert.deepEqual(await pendingIds(reopened), []);
      const dead = await reopened.readDeadLetters();
      assert.equal(dead.length, 1);
      assert.deepEqual(dead[0].row, row());
      assert.equal(dead[0].reason, 'invalid tool');
      assert.equal((await reopened.status()).deadLetters, 1);
    });

    for (const login of [
      { backend: loginA.backend, keyId: 'key-b' },
      { backend: 'https://b.invalid', keyId: loginA.keyId },
      { ...loginA, available: false },
      null,
    ]) {
      it(`R6: a queue remains bound when login becomes ${JSON.stringify(login)}`, async () => {
        const { adapter } = await setup();
        await adapter.append(row());
        await adapter.switchLogin(login);
        const recovered = await adapter.restart();
        await recovered.drain(() =>
          assert.fail('sent with the wrong or missing login'),
        );
        assert.deepEqual(await pendingIds(recovered), [row().client_row_id]);
        assert.equal((await recovered.readPending())[0].attempts, 0);
        assert.equal((await recovered.status()).undeliverable, 1);
        await recovered.switchLogin(loginA);
        await recovered.drain(async ({ login: used, rows }) => {
          assert.equal(used.backend, loginA.backend);
          assert.equal(used.keyId, loginA.keyId);
          return outcomes(rows);
        });
        assert.deepEqual(await pendingIds(recovered), []);
      });
    }

    it('R6: a new login drains its own queue without adopting the previous login rows', async () => {
      const { adapter } = await setup();
      await adapter.append(row(1));
      const loginB = { ...loginA, keyId: 'key-b' };
      await adapter.switchLogin(loginB);
      await adapter.append(row(2));
      await adapter.drain(async ({ login, rows }) => {
        assert.equal(login.keyId, loginB.keyId);
        assert.deepEqual(rows, [row(2)]);
        return outcomes(rows);
      });
      assert.deepEqual(await pendingIds(adapter), [row(1).client_row_id]);
      assert.equal((await adapter.status()).undeliverable, 1);
    });

    // regression: #0010
    it('R7: per row outcomes settle by id, including duplicates, with omitted rows retained', async () => {
      const { adapter } = await setup();
      for (let n = 1; n <= 5; n += 1) await adapter.append(row(n));
      await adapter.drain(async () => ({
        status: 200,
        body: {
          results: [
            {
              client_row_id: row(4).client_row_id,
              outcome: 'rejected',
              error: 'invalid tool',
            },
            { client_row_id: row(2).client_row_id, outcome: 'duplicate' },
            {
              client_row_id: row(3).client_row_id,
              outcome: 'retryable',
              error: 'busy',
            },
            { client_row_id: row(1).client_row_id, outcome: 'accepted' },
          ],
        },
      }));
      assert.deepEqual(await pendingIds(adapter), [
        row(3).client_row_id,
        row(5).client_row_id,
      ]);
      assert.deepEqual(
        (await adapter.readPending()).map(({ attempts }) => attempts),
        [0, 0],
      );
      assert.equal(
        (await adapter.readDeadLetters())[0].row.client_row_id,
        row(4).client_row_id,
      );
      await adapter.append(row(6));
      await adapter.drain(accept);
      assert.deepEqual(await pendingIds(adapter), [
        row(3).client_row_id,
        row(5).client_row_id,
      ]);
    });

    for (const body of [
      'unreadable JSON',
      null,
      {},
      { results: null, failures: [] },
      {
        results: [{ client_row_id: row(1).client_row_id, outcome: 'unknown' }],
      },
      {
        results: [{ client_row_id: 'not-in-this-batch', outcome: 'accepted' }],
      },
      { results: [1] },
      {
        results: [
          { client_row_id: row(1).client_row_id, outcome: 'accepted' },
          { client_row_id: row(1).client_row_id, outcome: 'duplicate' },
        ],
      },
      { failures: [{ index: 99, error: 'bad index' }] },
    ]) {
      it(`R7: unreadable or ambiguous reply acknowledges nothing: ${JSON.stringify(body)}`, async () => {
        const { adapter } = await setup();
        await adapter.append(row());
        await adapter.drain(async () => ({ status: 200, body }));
        assert.deepEqual(await pendingIds(await adapter.restart()), [
          row().client_row_id,
        ]);
        assert.deepEqual(await adapter.readDeadLetters(), []);
      });
    }

    for (const status of [400, 422]) {
      // regression: #0010
      it(`R8: legacy HTTP ${status} bisects, isolating poison without charging split attempts`, async () => {
        const { adapter } = await setup();
        for (let n = 1; n <= 3; n += 1) await adapter.append(row(n));
        await adapter.drain(async ({ rows }) => {
          if (rows.length > 1 || rows[0].client_row_id === row(2).client_row_id)
            return { status, body: {} };
          if (rows[0].client_row_id === row(3).client_row_id)
            return { status: 503, body: {} };
          return { status: 200, body: { failures: [] } };
        });
        assert.deepEqual(await pendingIds(adapter), [row(3).client_row_id]);
        assert.equal((await adapter.readPending())[0].attempts, 0);
        const dead = await adapter.readDeadLetters();
        assert.equal(dead.length, 1);
        assert.equal(dead[0].row.client_row_id, row(2).client_row_id);
        assert.equal(dead[0].attempts, 1);
        assert.match(dead[0].reason, new RegExp(String(status)));
      });
    }

    // regression: #0010
    it('R8: readable per row outcomes take precedence over a whole batch 400', async () => {
      const { adapter } = await setup();
      await adapter.append(row(1));
      await adapter.append(row(2));
      let sends = 0;
      await adapter.drain(async ({ rows }) => {
        sends += 1;
        return { ...outcomes(rows, 'retryable'), status: 400 };
      });
      assert.equal(sends, 1);
      assert.deepEqual(
        (await adapter.readPending()).map(({ attempts }) => attempts),
        [0, 0],
      );
    });

    // regression: #0010
    it('R8: legacy failures retain only the failed indices', async () => {
      const { adapter } = await setup();
      await adapter.append(row(1));
      await adapter.append(row(2));
      await adapter.drain(async () => ({
        status: 200,
        body: { written: 1, failures: [{ index: 1, error: 'busy' }] },
      }));
      assert.deepEqual(await pendingIds(adapter), [row(2).client_row_id]);
      assert.equal((await adapter.readPending())[0].attempts, 0);
    });

    for (const status of [401, 403]) {
      // regression: #0010
      it(`R9: HTTP ${status} pauses this login without spending attempts`, async () => {
        const { adapter, clock, timing } = await setup();
        await adapter.append(row());
        await adapter.drain(async () => ({ status, body: {} }));
        const recovered = await adapter.restart();
        await recovered.drain(
          () => assert.fail('a paused login sent rows before revalidation'),
          { probe: () => assert.fail('authentication was probed too soon') },
        );
        assert.equal((await recovered.readPending())[0].attempts, 0);
        assert.equal((await recovered.status()).undeliverable, 1);
        clock.advance(timing.authProbeMs);
        let probes = 0;
        await recovered.drain(
          () => assert.fail('a failed probe resumed delivery'),
          {
            probe: async ({ login }) => {
              assert.deepEqual(login, loginA);
              probes += 1;
              return { status };
            },
          },
        );
        assert.equal(probes, 1);
        assert.equal((await recovered.readPending())[0].attempts, 0);
        assert.equal((await recovered.status()).undeliverable, 1);
        await recovered.switchLogin(loginA);
        await recovered.drain(accept);
        assert.deepEqual(await pendingIds(recovered), []);
      });
    }

    // regression: #0010
    it('R9: a periodic successful probe resumes the same login after restart', async () => {
      const { adapter, clock, timing } = await setup();
      await adapter.append(row());
      await adapter.drain(async () => ({ status: 401, body: {} }));
      let recovered = await adapter.restart();
      clock.advance(timing.authProbeMs);
      await recovered.drain(
        () => assert.fail('a failed probe resumed delivery'),
        { probe: async () => ({ status: 503 }) },
      );
      recovered = await recovered.restart();
      await recovered.drain(
        () => assert.fail('a paused login sent rows'),
        { probe: () => assert.fail('probe delay did not survive restart') },
      );
      clock.advance(timing.authProbeMs);
      let probes = 0;
      await recovered.drain(accept, {
        probe: async ({ login }) => {
          assert.deepEqual(login, loginA);
          probes += 1;
          return { status: 200 };
        },
      });
      assert.equal(probes, 1);
      assert.deepEqual(await pendingIds(await recovered.restart()), []);
      assert.equal((await recovered.status()).undeliverable, 0);
    });

    // regression: #0010
    it('R9: another authenticated call resumes only its own credential and backend', async () => {
      const { adapter } = await setup();
      await adapter.append(row());
      await adapter.drain(async () => ({ status: 401, body: {} }));
      const recovered = await adapter.restart();
      for (const login of [
        { ...loginA, keyId: 'key-b' },
        { ...loginA, backend: 'https://b.invalid' },
      ]) {
        await recovered.authenticationSucceeded(login);
        await recovered.drain(() =>
          assert.fail('another credential lifted the pause'),
        );
        assert.equal((await recovered.status()).undeliverable, 1);
      }
      await recovered.authenticationSucceeded(loginA);
      await (await recovered.restart()).drain(accept);
      assert.deepEqual(await pendingIds(recovered), []);
    });

    it('R9: a structured row refusal on 403 is settled without an authentication pause', async () => {
      const { adapter } = await setup();
      await adapter.append(row(1));
      await adapter.drain(async ({ rows }) => ({
        ...outcomes(rows, 'rejected'),
        status: 403,
      }));
      assert.deepEqual(await pendingIds(adapter), []);
      assert.equal((await adapter.readDeadLetters()).length, 1);
      await adapter.append(row(2));
      await adapter.drain(accept);
      assert.deepEqual(await pendingIds(adapter), []);
    });

    for (const [status, attempts] of [
      [413, 1],
      [429, 0],
      [500, 0],
    ]) {
      // regression: #0010
      it(`R9: HTTP ${status} charges ${attempts} attempts and does not bisect`, async () => {
        const { adapter } = await setup();
        await adapter.append(row(1));
        await adapter.append(row(2));
        let sends = 0;
        await adapter.drain(async () => {
          sends += 1;
          return { status, body: {} };
        });
        assert.equal(sends, 1);
        assert.deepEqual(
          (await adapter.readPending()).map(({ attempts }) => attempts),
          [attempts, attempts],
        );
      });
    }

    it('R10: retry delay grows exponentially, persists and varies with jitter', async () => {
      const delays = [];
      for (const random of [0.25, 0.75]) {
        const { adapter, clock, timing } = await setup({ random });
        await adapter.append(row());
        await adapter.drain(async () => ({ status: 503, body: {} }));
        const first =
          (await adapter.readPending())[0].nextAttemptAt - clock.now();
        assert.ok(first > 0 && first <= timing.baseMs);
        const recovered = await adapter.restart();
        await recovered.drain(() => assert.fail('sent before retry delay'));
        await advanceToRetry(recovered, clock);
        await recovered.drain(async () => ({ status: 503, body: {} }));
        const second =
          (await recovered.readPending())[0].nextAttemptAt - clock.now();
        assert.ok(second > first && second <= 2 * timing.baseMs);
        delays.push(first);
      }
      assert.notEqual(delays[0], delays[1]);
    });

    for (const header of ['120', 'Sat, 14 Nov 2026 12:02:00 GMT']) {
      it(`R10: Retry-After ${header} is a lower bound even beyond the backoff cap`, async () => {
        const { adapter, clock } = await setup();
        await adapter.append(row());
        const until = clock.now() + 120_000;
        await adapter.drain(async () => ({
          status: 429,
          body: {},
          headers: { 'retry-after': header },
        }));
        assert.ok((await adapter.readPending())[0].nextAttemptAt >= until);
        clock.advance(119_999);
        const recovered = await adapter.restart();
        await recovered.drain(() => assert.fail('Retry-After was shortened'));
        await advanceToRetry(recovered, clock);
        await recovered.drain(accept);
        assert.deepEqual(await pendingIds(recovered), []);
      });
    }

    for (const [failure, reply] of [
      [
        'network',
        async () => {
          throw new Error('connection lost');
        },
      ],
      [
        'timeout',
        async () => {
          throw new Error('request timed out');
        },
      ],
      ['unreadable', async () => ({ status: 200, body: 'unreadable JSON' })],
      ['5xx', async () => ({ status: 503, body: {} })],
      ['408', async () => ({ status: 408, body: {} })],
      ['429', async () => ({ status: 429, body: {} })],
      [
        'request_in_progress',
        async () => ({ status: 409, body: { error: 'request_in_progress' } }),
      ],
      ['retryable', async ({ rows }) => outcomes(rows, 'retryable')],
    ]) {
      // regression: #0010
      it(`R11: a long ${failure} outage keeps every row pending and then delivers it`, async () => {
        let { adapter, clock, timing } = await setup();
        const captured = [row(1), row(2), row(3)];
        for (const capturedRow of captured) await adapter.append(capturedRow);
        for (let attempt = 1; attempt <= 40; attempt += 1) {
          let sends = 0;
          await adapter.drain(async (request) => {
            sends += 1;
            assert.deepEqual(request.rows, captured);
            return reply(request);
          });
          assert.equal(sends, 1);
          adapter = await adapter.restart();
          const pending = await adapter.readPending();
          assert.deepEqual(pending.map(({ row }) => row), captured);
          assert.deepEqual(
            pending.map(({ attempts }) => attempts),
            [0, 0, 0],
          );
          assert.deepEqual(await adapter.readDeadLetters(), []);
          assert.equal((await adapter.status()).deadLetters, 0);
          for (const entry of pending) {
            const delay = entry.nextAttemptAt - clock.now();
            assert.ok(delay > 0 && delay <= timing.maxMs);
            if (attempt >= 4) assert.ok(delay >= timing.maxMs / 2);
          }
          await adapter.drain(() =>
            assert.fail('sent before the persisted retry time'),
          );
          clock.advance(24 * 60 * 60 * 1000);
        }
        let delivered = 0;
        await adapter.drain(async ({ rows }) => {
          assert.deepEqual(rows, captured);
          delivered += rows.length;
          return outcomes(rows);
        });
        assert.equal(delivered, captured.length);
        assert.deepEqual(await pendingIds(await adapter.restart()), []);
        assert.deepEqual(await adapter.readDeadLetters(), []);
      });
    }

    for (const [status, body] of [
      [413, {}],
      [409, { error: 'conflict' }],
    ]) {
      // regression: #0010
      it(`R11: ten non transient HTTP ${status} refusals become one retained dead letter`, async () => {
        let { adapter, clock } = await setup();
        await adapter.append(row(1));
        for (let attempt = 1; attempt <= 10; attempt += 1) {
          await adapter.drain(async () => ({ status, body }));
          adapter = await adapter.restart();
          if (attempt < 10) {
            assert.equal((await adapter.readPending())[0].attempts, attempt);
            assert.deepEqual(await adapter.readDeadLetters(), []);
            await advanceToRetry(adapter, clock);
            if (attempt === 9) {
              for (let outage = 0; outage < 12; outage += 1) {
                await adapter.drain(async () => ({ status: 503, body: {} }));
                adapter = await adapter.restart();
                assert.deepEqual(await pendingIds(adapter), [row(1).client_row_id]);
                assert.equal((await adapter.readPending())[0].attempts, 9);
                assert.deepEqual(await adapter.readDeadLetters(), []);
                await advanceToRetry(adapter, clock);
              }
            }
          }
        }
        assert.deepEqual(await pendingIds(adapter), []);
        const dead = await adapter.readDeadLetters();
        assert.equal(dead.length, 1);
        assert.deepEqual(dead[0].row, row(1));
        assert.equal(dead[0].attempts, 10);
        assert.match(dead[0].reason, new RegExp(String(status)));
        clock.advance(100 * 365 * 24 * 60 * 60 * 1000);
        adapter = await adapter.restart();
        await adapter.drain(() => assert.fail('dead letter was sent again'));
        assert.deepEqual(await adapter.readDeadLetters(), dead);
        assert.equal((await adapter.status()).deadLetters, 1);
        await adapter.append(row(2));
        await adapter.drain(accept);
        assert.deepEqual(await pendingIds(adapter), []);
      });
    }

    it('R12: the exact UTF-8 row cap fits and one byte over is shrunk', async () => {
      const { adapter, limits } = await setup();
      const exact = row(1);
      exact.input = { value: 'é' };
      exact.input.value += 'x'.repeat(limits.maxRowBytes - bytes(exact));
      assert.equal(bytes(exact), limits.maxRowBytes);
      await adapter.append(exact);
      const over = { ...copy(exact), client_row_id: row(2).client_row_id };
      over.input.value += 'x';
      await adapter.append(over);
      const pending = await adapter.readPending();
      assert.deepEqual(pending[0].row, exact);
      assert.deepEqual(pending[1].row.input, limits.truncationMarker);
      assert.ok(bytes(pending[1].row) <= limits.maxRowBytes);
    });

    for (const boundary of ['bytes', 'rows']) {
      it(`R12: batch ${boundary} cap includes the JSON envelope`, async () => {
        const sample = { ...row(), input: { value: '😀'.repeat(50) } };
        const maxBatchBytes = bytes({ rows: [sample, sample] });
        const sizeLimits =
          boundary === 'bytes' ? { maxBatchBytes } : { maxBatchRows: 2 };
        const { adapter, limits } = await setup({ sizeLimits });
        for (let n = 1; n <= 3; n += 1)
          await adapter.append({
            ...sample,
            client_row_id: row(n).client_row_id,
          });
        const sizes = [];
        await adapter.drain(async ({ rows }) => {
          assert.ok(bytes({ rows }) <= limits.maxBatchBytes);
          assert.ok(rows.length <= limits.maxBatchRows);
          sizes.push(rows.length);
          return outcomes(rows);
        });
        assert.deepEqual(sizes, [2, 1]);
        assert.deepEqual(await pendingIds(adapter), []);
      });
    }

    it('R13: shrinking replaces input before output and preserves all other fields', async () => {
      const { adapter, limits } = await setup();
      const first = {
        ...row(1),
        input: { value: 'é'.repeat(1024) },
        output: { value: 'keep' },
      };
      const second = {
        ...row(2),
        input: { value: 'small' },
        output: { value: '😀'.repeat(1024) },
      };
      await adapter.append(first);
      await adapter.append(second);
      const pending = await adapter.readPending();
      assert.deepEqual(pending[0].row, {
        ...first,
        input: limits.truncationMarker,
      });
      assert.deepEqual(pending[1].row, {
        ...second,
        input: limits.truncationMarker,
        output: limits.truncationMarker,
      });
      assert.equal(first.input.value.length, 1024);
      await adapter.drain(async ({ rows }) => {
        for (const fitted of rows)
          assert.ok(bytes(fitted) <= limits.maxRowBytes);
        return outcomes(rows);
      });
    });

    it('R13: metadata that cannot fit is dead lettered as oversize without a delivery', async () => {
      const { adapter } = await setup();
      const large = { ...row(), error_message: 'x'.repeat(2048) };
      await adapter.append(large);
      const recovered = await adapter.restart();
      await recovered.drain(() => assert.fail('oversize metadata was sent'));
      assert.deepEqual(await pendingIds(recovered), []);
      const dead = await recovered.readDeadLetters();
      assert.equal(dead.length, 1);
      assert.deepEqual(dead[0].row, large);
      assert.equal(dead[0].reason, 'oversize');
      assert.equal(dead[0].attempts, 0);
    });

    it('R14: fallback capture uses only the minimal sanitized envelope', async () => {
      const { adapter } = await setup();
      const unsafe = {
        ...row(),
        input: { authorization: 'untrusted input' },
        output: 'raw output',
        error_message: 'raw crash details',
      };
      await adapter.append(unsafe, { fallback: true });
      const expected = {
        client_row_id: unsafe.client_row_id,
        session_id: unsafe.session_id,
        tool: 'unknown',
        action: 'unknown',
        input: {},
        executed_at: unsafe.executed_at,
        decision_code: unsafe.decision_code,
        status: 'blocked',
      };
      assert.deepEqual((await adapter.readPending())[0].row, expected);
      await adapter.drain(async ({ rows }) => {
        assert.deepEqual(rows, [expected]);
        return outcomes(rows);
      });
      const sessionless = row(2);
      delete sessionless.session_id;
      await adapter.append(sessionless, { fallback: true });
      const pending = await adapter.readPending();
      assert.equal(Object.hasOwn(pending[0].row, 'session_id'), false);
      await adapter.drain(accept);
    });

    it('R14: missing identity counts a capture failure and a later login cannot adopt it', async () => {
      const { adapter } = await setup({ login: null });
      await adapter.append(row(), { fallback: true });
      assert.equal((await adapter.status()).captureFailures, 1);
      await adapter.append(row(2), { fallback: true, loggedOut: true });
      assert.equal((await adapter.status()).captureFailures, 1);
      const recovered = await adapter.restart();
      assert.equal((await recovered.status()).captureFailures, 1);
      await recovered.switchLogin(loginA);
      await recovered.drain(() =>
        assert.fail('a fallback without identity acquired a guessed login'),
      );
      assert.deepEqual(await pendingIds(recovered), []);
    });
  });
}

function makeReferenceAdapter({ login, clock, sizeLimits, timing }, store) {
  store ??= {
    disk: JSON.stringify({
      pending: [],
      dead: [],
      paused: [],
      captureFailures: 0,
    }),
    locks: new Map(),
    current: copy(login),
    fault: null,
  };
  const read = () => JSON.parse(store.disk);
  const write = (state) => {
    store.disk = JSON.stringify(state);
  };
  const loginKey = (value) =>
    value ? JSON.stringify([value.backend, value.keyId]) : null;
  const boundLogin = (value) => ({
    backend: value.backend,
    keyId: value.keyId,
  });
  const identified = (value) =>
    typeof value?.backend === 'string' && typeof value?.keyId === 'string';
  const hasCredential = (binding) =>
    identified(store.current) &&
    store.current.available !== false &&
    loginKey(store.current) === binding;
  const canSend = (binding) =>
    hasCredential(binding) &&
    !read().paused.some((pause) => pause.binding === binding);
  const authenticationSucceeded = (login) => {
    const state = read();
    state.paused = state.paused.filter(
      ({ binding }) => binding !== loginKey(login),
    );
    write(state);
  };
  const fault = (point) => {
    if (store.fault !== point) return;
    store.fault = null;
    throw new Error(`injected ${point} storage failure`);
  };
  const reopen = () =>
    makeReferenceAdapter({ login, clock, sizeLimits, timing }, store);

  function shrink(original) {
    const fitted = copy(original);
    for (const field of ['input', 'output']) {
      if (bytes(fitted) <= sizeLimits.maxRowBytes) break;
      if (Object.hasOwn(fitted, field))
        fitted[field] = copy(sizeLimits.truncationMarker);
    }
    return bytes(fitted) <= sizeLimits.maxRowBytes ? fitted : null;
  }

  function parseResults(body, batch) {
    if (!body || typeof body !== 'object') return null;
    const ids = new Set(batch.map(({ row }) => row.client_row_id));
    const results = new Map();
    if (Object.hasOwn(body, 'results')) {
      if (!Array.isArray(body.results)) return null;
      for (const result of body.results) {
        if (
          !result ||
          !ids.has(result.client_row_id) ||
          results.has(result.client_row_id) ||
          !['accepted', 'duplicate', 'retryable', 'rejected'].includes(
            result.outcome,
          ) ||
          (result.error !== undefined && typeof result.error !== 'string')
        )
          return null;
        results.set(result.client_row_id, result);
      }
      return results;
    }
    if (!Array.isArray(body.failures)) return null;
    const failed = new Set();
    for (const failure of body.failures) {
      if (
        !failure ||
        !Number.isInteger(failure.index) ||
        failure.index < 0 ||
        failure.index >= batch.length ||
        failed.has(failure.index) ||
        typeof failure.error !== 'string'
      )
        return null;
      failed.add(failure.index);
      results.set(batch[failure.index].row.client_row_id, {
        outcome: 'retryable',
        error: failure.error,
      });
    }
    for (const entry of batch) {
      if (!results.has(entry.row.client_row_id))
        results.set(entry.row.client_row_id, { outcome: 'accepted' });
    }
    return results;
  }

  function retryDelay(retries, header) {
    const ceiling = Math.min(timing.maxMs, timing.baseMs * 2 ** (retries - 1));
    const jittered = ceiling / 2 + (clock.random() * ceiling) / 2;
    let retryAfter = 0;
    if (typeof header === 'string' && header.trim() !== '') {
      const seconds = Number(header);
      retryAfter = Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(header) - clock.now();
    }
    return Math.max(jittered, Number.isFinite(retryAfter) ? retryAfter : 0);
  }

  async function deliver(batch, send, binding, owns) {
    if (!owns() || !canSend(binding)) return;
    let reply;
    let networkError;
    try {
      reply = await send({
        login: copy(batch[0].login),
        rows: batch.map(({ row }) => copy(row)),
      });
    } catch (error) {
      networkError = String(error);
      reply = { status: 0, body: null };
    }
    if (!owns()) return;
    const body = reply?.body;
    const hasResults =
      body !== null &&
      typeof body === 'object' &&
      Object.hasOwn(body, 'results');
    const results =
      hasResults || (reply?.status >= 200 && reply?.status < 300)
        ? parseResults(body, batch)
        : null;
    if (
      reply?.status === 401 ||
      (reply?.status === 403 && !(hasResults && results))
    ) {
      const state = read();
      if (!state.paused.some((pause) => pause.binding === binding))
        state.paused.push({
          binding,
          nextProbeAt: clock.now() + timing.authProbeMs,
        });
      write(state);
      return;
    }
    if (!hasResults && [400, 422].includes(reply?.status) && batch.length > 1) {
      const middle = Math.floor(batch.length / 2);
      await deliver(batch.slice(0, middle), send, binding, owns);
      await deliver(batch.slice(middle), send, binding, owns);
      return;
    }
    const state = read();
    const decisions = new Map();
    const nonTransientRefusal =
      !hasResults &&
      reply?.status >= 300 &&
      reply.status < 500 &&
      ![408, 429].includes(reply.status) &&
      !(reply.status === 409 && body?.error === 'request_in_progress');
    for (const sent of batch) {
      const entry = state.pending.find(({ id }) => id === sent.id);
      if (!entry) continue;
      const result = results?.get(entry.row.client_row_id);
      if (result?.outcome === 'rejected' || (!result && nonTransientRefusal))
        entry.attempts += 1;
      const isolatedRejection =
        !hasResults && batch.length === 1 && [400, 422].includes(reply?.status);
      const reason =
        result?.error ||
        networkError ||
        (result
          ? result.outcome
          : `HTTP ${reply?.status ?? 0}: unreadable or missing outcome`);
      entry.lastError = reason;
      if (result?.outcome === 'accepted' || result?.outcome === 'duplicate')
        decisions.set(entry.id, 'ack');
      else if (
        result?.outcome === 'rejected' ||
        isolatedRejection ||
        entry.attempts >= 10
      )
        decisions.set(entry.id, 'deadLetter');
      else {
        entry.retries += 1;
        entry.nextAttemptAt =
          clock.now() +
          retryDelay(entry.retries, reply?.headers?.['retry-after']);
      }
    }
    write(state);
    if ([...decisions.values()].includes('deadLetter')) fault('deadLetter');
    if ([...decisions.values()].includes('ack')) fault('ack');
    const committed = read();
    committed.pending = committed.pending.filter((entry) => {
      const decision = decisions.get(entry.id);
      if (decision === 'deadLetter')
        committed.dead.push({
          row: entry.row,
          attempts: entry.attempts,
          reason: entry.lastError,
        });
      return !decision;
    });
    write(committed);
  }

  return {
    async append(original, { fallback = false, loggedOut = false } = {}) {
      if (loggedOut) return;
      fault('append');
      const state = read();
      if (!identified(store.current)) {
        state.captureFailures += 1;
        write(state);
        return;
      }
      let captured = copy(original);
      if (fallback) {
        captured = {
          client_row_id: original.client_row_id,
          tool: 'unknown',
          action: 'unknown',
          input: {},
          executed_at: original.executed_at,
          decision_code: original.decision_code,
          status: 'blocked',
        };
        if (typeof original.session_id === 'string')
          captured.session_id = original.session_id;
      }
      const fitted = shrink(captured);
      if (!fitted) {
        fault('deadLetter');
        state.dead.push({ row: captured, reason: 'oversize', attempts: 0 });
      } else {
        const binding = boundLogin(store.current);
        const id = JSON.stringify([loginKey(binding), fitted.client_row_id]);
        if (!state.pending.some((entry) => entry.id === id))
          state.pending.push({
            id,
            row: fitted,
            login: binding,
            attempts: 0,
            retries: 0,
            nextAttemptAt: clock.now(),
          });
      }
      write(state);
    },
    async drain(send, { probe } = {}) {
      const binding = loginKey(store.current);
      if (!hasCredential(binding)) return;
      const held = store.locks.get(binding);
      if (held && held.expiresAt > clock.now()) return;
      const lease = { expiresAt: clock.now() + timing.lockTtlMs };
      store.locks.set(binding, lease);
      const owns = () =>
        store.locks.get(binding) === lease && lease.expiresAt > clock.now();
      try {
        const state = read();
        const pause = state.paused.find((pause) => pause.binding === binding);
        if (pause) {
          if (!probe || pause.nextProbeAt > clock.now()) return;
          pause.nextProbeAt = clock.now() + timing.authProbeMs;
          write(state);
          let reply;
          try {
            reply = await probe({ login: boundLogin(store.current) });
          } catch {
            return;
          }
          if (!owns() || !hasCredential(binding)) return;
          if (reply?.status >= 200 && reply.status < 300)
            authenticationSucceeded(store.current);
          if (!canSend(binding)) return;
        }
        const eligible = read().pending.filter(
          (entry) =>
            loginKey(entry.login) === binding &&
            entry.nextAttemptAt <= clock.now(),
        );
        let batch = [];
        for (const entry of eligible) {
          if (entry.attempts >= 10) {
            fault('deadLetter');
            const state = read();
            state.dead.push({
              row: entry.row,
              reason: entry.lastError,
              attempts: entry.attempts,
            });
            state.pending = state.pending.filter(({ id }) => id !== entry.id);
            write(state);
            continue;
          }
          const next = [...batch, entry];
          if (
            next.length > sizeLimits.maxBatchRows ||
            bytes({ rows: next.map(({ row }) => row) }) >
              sizeLimits.maxBatchBytes
          ) {
            if (batch.length === 0)
              throw new Error('row does not fit the configured batch cap');
            await deliver(batch, send, binding, owns);
            batch = [];
          }
          batch.push(entry);
        }
        if (batch.length > 0) await deliver(batch, send, binding, owns);
      } finally {
        if (store.locks.get(binding) === lease) store.locks.delete(binding);
      }
    },
    async readPending() {
      return read().pending;
    },
    async readDeadLetters() {
      return read().dead;
    },
    async status() {
      const state = read();
      return {
        undeliverable: state.pending.filter(
          ({ login }) => !canSend(loginKey(login)),
        ).length,
        captureFailures: state.captureFailures,
        deadLetters: state.dead.length,
      };
    },
    async switchLogin(next) {
      store.current = copy(next);
      if (identified(next) && next.available !== false)
        authenticationSucceeded(next);
    },
    async authenticationSucceeded(login) {
      authenticationSucceeded(login);
    },
    async failNext(point) {
      store.fault = point;
    },
    async secondDrainer() {
      return reopen();
    },
    async restart() {
      return reopen();
    },
  };
}
