/**
 * Per-aspect scoring for the anti-detect oracles.
 *
 * "The engine passes anti-detect benchmarks" is not a number. "Every declared aspect has at least one
 * conclusive measurement and 100% of its closed oracles pass" is, and this module computes it.
 *
 * THE BAR, and why each half of it exists:
 *
 *   - An aspect with NO oracle FAILS. A surface nobody probes is not a surface that works; it is a
 *     surface nobody looked at. Declaring an aspect here is therefore a commitment to cover it, and
 *     the scorer is what collects on that commitment offline, with no browser involved.
 *   - An aspect whose oracles all measured NOTHING is BLOCKED, never green. An inconclusive probe is
 *     evidence about the harness, not about the engine, so counting it as a pass would launder a
 *     missing GPU or an absent WebGPU implementation into a claim about the shipping product.
 *   - An aspect where a `status: 'fixed'` oracle measured and failed is a REGRESSION. That verdict
 *     outranks blocked: something we closed is open again, and that is the more urgent fact even if
 *     other probes in the same aspect could not run.
 *
 * BLOCKED and FAILED are deliberately different exit codes upstream (2 vs 1). Collapsing them is how
 * a run against an engine that could not be measured gets filed as a regression report.
 */

/**
 * The aspects the product claims to control. This list is the contract: adding an aspect without an
 * oracle turns the gate red, which is the only mechanism that keeps "we should test WebRTC one day"
 * from staying a comment forever.
 */
export const ASPECTS = [
  { id: 'canvas', title: '2D canvas readback fidelity' },
  { id: 'audio', title: 'Web Audio render fidelity' },
  { id: 'webgl', title: 'WebGL / WebGL2 driver surfaces' },
  { id: 'webgpu', title: 'WebGPU adapter coherence' },
  { id: 'clientRects', title: 'Element geometry' },
  { id: 'fonts', title: 'Installed font set' },
  { id: 'screen', title: 'Display metrics' },
  { id: 'navigator', title: 'navigator / UA-CH identity' },
  { id: 'timezone', title: 'Timezone and clock' },
  { id: 'languages', title: 'Locale, languages and Accept-Language' },
  { id: 'mediaDevices', title: 'Media device enumeration' },
  { id: 'webrtc', title: 'WebRTC ICE exposure' },
  { id: 'crossContext', title: 'Window / worker / iframe coherence' },
  { id: 'networkTls', title: 'TLS ClientHello (JA3 / JA4)' },
  { id: 'networkHttp2', title: 'HTTP/2 SETTINGS and header order' },
];

export const ASPECT_IDS = ASPECTS.map((a) => a.id);

/**
 * Oracles carry a `surface` because that is how the audit names them. Aspects are the coarser thing a
 * release claim is made about, so most surfaces map straight through and only the ones the audit split
 * differently need an entry. An oracle may override with an explicit `aspect`.
 */
export const SURFACE_ASPECTS = {
  canvas: 'canvas',
  audio: 'audio',
  webgl: 'webgl',
  webgpu: 'webgpu',
  geometry: 'clientRects',
  fonts: 'fonts',
  screen: 'screen',
  navigator: 'navigator',
  // The audit filed timezone under `locale`; the languages half of locale is its own aspect and its
  // oracles say so explicitly.
  locale: 'timezone',
  mediaDevices: 'mediaDevices',
  webrtc: 'webrtc',
};

export function aspectOf(oracle) {
  return oracle.aspect ?? SURFACE_ASPECTS[oracle.surface] ?? 'unclassified';
}

/**
 * @param {Array<{id:string, aspect?:string, surface?:string, status?:string, pass?:boolean,
 *                inconclusive?:boolean, applicable?:boolean, detail?:string, personaOs?:string}>} rows
 * @param {{ aspects?: typeof ASPECTS }} [options]
 */
export function scoreAspects(rows, options = {}) {
  const declared = options.aspects ?? ASPECTS;
  const byAspect = new Map(declared.map((a) => [a.id, []]));
  const skippedByAspect = new Map(declared.map((a) => [a.id, []]));
  const unclassified = [];
  for (const row of rows) {
    const id = aspectOf(row);
    // A row the environment does not apply to (a Windows-only probe under a Linux persona, a proxy
    // exit check with no proxy) is not evidence in either direction. It is recorded, never scored —
    // but it is remembered, because an aspect that HAS oracles none of which can run here is a gap in
    // the environment, while an aspect with no oracles at all is a gap in the work.
    if (row.applicable === false) {
      if (skippedByAspect.has(id)) skippedByAspect.get(id).push(row);
      continue;
    }
    if (byAspect.has(id)) byAspect.get(id).push(row);
    else unclassified.push({ ...row, aspect: id });
  }

  const aspects = {};
  for (const { id, title } of declared) {
    const own = byAspect.get(id) ?? [];
    const skipped = skippedByAspect.get(id) ?? [];
    const passed = own.filter((r) => r.pass);
    const inconclusive = own.filter((r) => r.inconclusive && !r.pass);
    const failed = own.filter((r) => !r.pass && !r.inconclusive);
    const fixed = own.filter((r) => (r.status ?? 'fixed') === 'fixed');
    const regressions = fixed.filter((r) => !r.pass && !r.inconclusive);
    const unmeasuredFixed = fixed.filter((r) => r.inconclusive && !r.pass);
    const conclusive = own.filter((r) => !r.inconclusive);

    let verdict;
    let reason;
    if (own.length === 0 && skipped.length === 0) {
      verdict = 'fail';
      reason = 'no oracle covers this aspect';
    } else if (own.length === 0) {
      verdict = 'blocked';
      reason = `all ${skipped.length} oracle(s) are inapplicable here: ${skipped.map((r) => r.id).join(', ')}`;
    } else if (regressions.length) {
      verdict = 'fail';
      reason = `closed oracle(s) failed: ${regressions.map((r) => r.id).join(', ')}`;
    } else if (unmeasuredFixed.length) {
      verdict = 'blocked';
      reason = `closed oracle(s) measured nothing: ${unmeasuredFixed.map((r) => r.id).join(', ')}`;
    } else if (conclusive.length === 0) {
      verdict = 'blocked';
      reason = 'no conclusive measurement in this environment';
    } else {
      verdict = 'pass';
      reason = `${passed.length}/${own.length} pass, ${conclusive.length} conclusive`;
    }

    aspects[id] = {
      title,
      verdict,
      reason,
      total: own.length,
      passed: passed.length,
      failed: failed.length,
      inconclusive: inconclusive.length,
      conclusive: conclusive.length,
      inapplicable: skipped.length,
      oracles: own.map((r) => ({
        id: r.id,
        personaOs: r.personaOs,
        status: r.status ?? 'fixed',
        result: r.pass ? 'pass' : r.inconclusive ? 'inconclusive' : 'fail',
        detail: r.detail,
      })),
    };
  }

  const list = Object.values(aspects);
  const passedAspects = list.filter((a) => a.verdict === 'pass');
  const failedAspects = declared.filter(({ id }) => aspects[id].verdict === 'fail').map((a) => a.id);
  const blockedAspects = declared
    .filter(({ id }) => aspects[id].verdict === 'blocked')
    .map((a) => a.id);
  const scoredRows = list.reduce((n, a) => n + a.total, 0);

  return {
    aspects,
    // The headline number: aspects fully green over aspects claimed. Oracle-level pass rate is
    // reported next to it because it moves for reasons the release bar does not care about — adding
    // three probes to an already-green aspect changes one and not the other.
    coverageIndex: declared.length ? passedAspects.length / declared.length : 0,
    oracleIndex: scoredRows
      ? list.reduce((n, a) => n + a.passed, 0) / scoredRows
      : 0,
    aspectsPassed: passedAspects.length,
    aspectsTotal: declared.length,
    failedAspects,
    blockedAspects,
    unclassified: unclassified.map((r) => ({ id: r.id, aspect: r.aspect })),
    // fail outranks blocked: a measured regression is a fact about the engine, a block is a fact
    // about the environment.
    verdict: failedAspects.length ? 'fail' : blockedAspects.length ? 'blocked' : 'pass',
  };
}

/** 0 = every aspect green, 1 = a closed oracle regressed, 2 = could not be measured here. */
export function exitCodeFor(score) {
  return score.verdict === 'fail' ? 1 : score.verdict === 'blocked' ? 2 : 0;
}

export function formatAspectTable(score) {
  const mark = { pass: 'PASS', fail: 'FAIL', blocked: 'BLK ' };
  const lines = [];
  for (const { id } of ASPECTS) {
    const a = score.aspects[id];
    if (!a) continue;
    lines.push(
      `  [${mark[a.verdict]}] ${id.padEnd(14)} ${String(a.passed).padStart(2)}/${String(a.total).padEnd(2)} pass` +
        `  ${String(a.inconclusive).padStart(2)} inconclusive  ${a.reason}`,
    );
  }
  lines.push(
    `\naspect coverage ${score.aspectsPassed}/${score.aspectsTotal} ` +
      `(${(score.coverageIndex * 100).toFixed(1)}%), oracle pass rate ${(score.oracleIndex * 100).toFixed(1)}%`,
  );
  return lines.join('\n');
}
