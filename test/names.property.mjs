/**
 * Laws of peer naming, checked by fast-check over generated rosters. A
 * failing law shrinks to a minimal roster.
 *
 * Generators are adversarial on purpose: uniform random strings almost never
 * collide, so a law would pass for the wrong reason. Session ids come from a
 * pool whose tails collide at 4, 6 and 8 characters, repeat, or are empty;
 * bases include case variants and bases forged from those tails; raw
 * records may publish a separator in their base or name.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';

const { SUFFIX_SEPARATOR, deriveNames, lookupPeer, nameRoster, recordBase } = await import('../dist/index.js');

const RUNS = { numRuns: 500 };

const SESSION_IDS = [
  '01a0e7f7-aaaa-0000-0000-00005e777d',
  '01a0e7f7-bbbb-0000-0000-000011777d', // same last 4 as the one above
  '01a0e7f7-cccc-0000-0000-00a15e777d', // same last 6 as the first
  '01a0e7f7-dddd-0000-0000-9aa15e777d', // same last 8 as the third
  '01a0e7f7-eeee-0000-0000-00000c580',
  'AB-CD', // short, mixed case, punctuation
  '', // host exposed none
];
const TAILS = ['777d', '5e777d', 'a15e777d', 'c580', 'abcd'];
const BASES = [
  'foo',
  'Foo',
  'FOO',
  'bar',
  ...TAILS.map((tail) => `foo-${tail}`),
  ...TAILS.map((tail) => `foo_${tail}`),
];

const sessionId = fc.constantFrom(...SESSION_IDS);
const base = fc.constantFrom(...BASES);
const pid = fc.integer({ min: 1, max: 40 });

/** Name sources with distinct pids — what one presence directory can hold. */
const sources = fc.uniqueArray(fc.record({ pid, base, sessionId }), { selector: (s) => s.pid, maxLength: 7 });

function record({ pid, base, sessionId, name = base, aliases }) {
  return {
    v: 1,
    pid,
    name,
    base,
    cwd: `/w/${pid}`,
    project: 'p',
    harness: 'omp',
    sessionId,
    model: '',
    socket: '',
    startedAt: 1,
    beatAt: 1,
    busy: false,
    ...(aliases !== undefined ? { aliases } : {}),
  };
}

/** Raw records as other versions or a hostile peer might publish them. */
const rawRecords = fc
  .uniqueArray(
    fc.record({
      pid,
      sessionId,
      base: fc.oneof(base, fc.constantFrom(...TAILS.map((tail) => `foo${SUFFIX_SEPARATOR}${tail}`))),
      name: fc.oneof(base, fc.constantFrom(...TAILS.map((tail) => `foo${SUFFIX_SEPARATOR}${tail}`))),
      aliases: fc.option(fc.array(base, { maxLength: 2 }), { nil: undefined }),
    }),
    { selector: (r) => r.pid, maxLength: 7 }
  )
  .map((rs) => rs.map(record));

const lower = (name) => name.toLowerCase();

describe('naming laws', () => {
  it('derived names are pairwise distinct, case-insensitively', () => {
    fc.assert(
      fc.property(sources, (ss) => {
        const names = [...deriveNames(ss).values()].map(lower);
        assert.equal(new Set(names).size, ss.length);
      }),
      RUNS
    );
  });

  it('names do not depend on the order peers are listed in', () => {
    fc.assert(
      fc.property(
        sources.chain((ss) => fc.tuple(fc.constant(ss), fc.shuffledSubarray(ss, { minLength: ss.length }))),
        ([ss, shuffled]) => {
          assert.deepEqual(
            [...deriveNames(shuffled)].sort(([a], [b]) => a - b),
            [...deriveNames(ss)].sort(([a], [b]) => a - b)
          );
        }
      ),
      RUNS
    );
  });

  it('a peer with a different base never renames anyone', () => {
    fc.assert(
      fc.property(sources, fc.record({ pid: fc.integer({ min: 41, max: 60 }), base, sessionId }), (ss, joiner) => {
        const before = deriveNames(ss);
        const after = deriveNames([...ss, joiner]);
        for (const s of ss) {
          if (lower(s.base) !== lower(joiner.base)) assert.equal(after.get(s.pid), before.get(s.pid));
        }
      }),
      RUNS
    );
  });

  it('a name is the bare base exactly when no other peer shares the base', () => {
    fc.assert(
      fc.property(sources, (ss) => {
        const names = deriveNames(ss);
        for (const s of ss) {
          const alone = ss.filter((o) => lower(o.base) === lower(s.base)).length === 1;
          const name = names.get(s.pid);
          if (alone) assert.equal(name, s.base);
          else assert.ok(name?.startsWith(`${s.base}${SUFFIX_SEPARATOR}`), `${name} suffixes ${s.base}`);
        }
      }),
      RUNS
    );
  });

  it('every peer reading the same records computes the same names', () => {
    fc.assert(
      fc.property(rawRecords, (records) => {
        const views = records.map((own) =>
          nameRoster(records, { pid: own.pid, base: recordBase(own), sessionId: own.sessionId })
        );
        const reference = new Map();
        records.forEach((own, i) => {
          reference.set(own.pid, views[i].self);
        });
        for (const view of views) {
          for (const other of view.others) assert.equal(other.name, reference.get(other.pid));
        }
        const names = [...reference.values()].map(lower);
        assert.equal(new Set(names).size, records.length, `distinct: ${names.join(', ')}`);
      }),
      RUNS
    );
  });

  it('every derived name resolves to exactly its owner, in any case', () => {
    fc.assert(
      fc.property(rawRecords, pid, (records, readerPid) => {
        const { others } = nameRoster(records, { pid: 100 + readerPid, base: 'reader', sessionId: '' });
        for (const r of others) {
          assert.equal(lookupPeer(r.name, others).record?.pid, r.pid);
          assert.equal(lookupPeer(r.name.toUpperCase(), others).record?.pid, r.pid);
        }
      }),
      RUNS
    );
  });

  it('a lookup never guesses between peers', () => {
    const key = fc.oneof(base, fc.constantFrom(...SESSION_IDS.map((id) => id.slice(0, 8)), ...SESSION_IDS));
    fc.assert(
      fc.property(rawRecords, key, (records, to) => {
        const found = lookupPeer(to, records);
        if (!found.found) return;
        const k = lower(to.trim());
        const byName = records.filter((r) => lower(r.name) === k);
        const byAlias = records.filter((r) => (r.aliases ?? []).some((a) => lower(a) === k));
        const bySession = records.filter((r) => r.sessionId !== '' && lower(r.sessionId).startsWith(k));
        if (byName.length > 0) assert.deepEqual(byName, [found.record]);
        else if (byAlias.length > 0) assert.deepEqual(byAlias, [found.record]);
        else assert.deepEqual(bySession, [found.record]);
      }),
      RUNS
    );
  });
});
