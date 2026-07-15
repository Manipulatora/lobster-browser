#!/usr/bin/env node
/**
 * Repeatable anti-detect verification matrix.
 *
 * This runner deliberately separates three operations:
 *   --check            validate the versioned 10+ provider manifest (offline, CI-safe)
 *   --init <file>      create an evidence report for a human/product-profile run
 *   --capture <file>   attach to an already-running PRODUCT profile over its supported CDP endpoint
 *                      and collect low-volume public-tester evidence (explicit live opt-in required)
 *   --grade <file>     grade completeness and evidence preconditions without turning "page loaded"
 *                      or "identifier computed" into a pass
 *
 * Live capture is intentionally advisory. Most public tools have UI-only or opaque results, so the
 * runner records screenshots + hashes and leaves them `inconclusive` for a reviewer. Only parsers with
 * a narrow, machine-readable contract (Sannysoft rows, CreepJS lies, DeviceInfo JSON) assign pass/fail.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MATRIX_PATH = join(here, 'detector-matrix.json');
const KNOWN_PARSERS = new Set(['manual', 'sannysoft', 'creepjs', 'deviceinfo-bot']);
const KNOWN_CAPTURE_POLICIES = new Set(['single-visit', 'manual-consent', 'self-host-pinned']);

async function loadJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function loadMatrix(path = MATRIX_PATH) {
  return loadJson(path);
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Validate the manifest without network or browser access. */
export function validateMatrix(matrix) {
  const errors = [];
  if (!matrix || typeof matrix !== 'object') return ['matrix must be an object'];
  if (matrix.schemaVersion !== 1) errors.push('schemaVersion must equal 1');
  if (typeof matrix.matrixVersion !== 'string' || !matrix.matrixVersion) {
    errors.push('matrixVersion must be a non-empty string');
  }
  if (
    !Number.isInteger(matrix.minimumIndependentProviders) ||
    matrix.minimumIndependentProviders < 10
  ) {
    errors.push('minimumIndependentProviders must be an integer >= 10');
  }
  if (!Array.isArray(matrix.verdicts)) errors.push('verdicts must be an array');
  for (const verdict of ['pass', 'fail', 'inconclusive', 'not_run']) {
    if (!matrix.verdicts?.includes(verdict)) errors.push(`verdicts is missing ${verdict}`);
  }

  const scenarios = Array.isArray(matrix.scenarios) ? matrix.scenarios : [];
  const tools = Array.isArray(matrix.tools) ? matrix.tools : [];
  if (scenarios.length === 0) errors.push('scenarios must not be empty');
  if (tools.length < 10) errors.push('tools must contain at least 10 entries');

  const scenarioIds = scenarios.map((scenario) => scenario?.id);
  const toolIds = tools.map((tool) => tool?.id);
  for (const id of duplicateValues(scenarioIds)) errors.push(`duplicate scenario id: ${id}`);
  for (const id of duplicateValues(toolIds)) errors.push(`duplicate tool id: ${id}`);
  const knownScenarioIds = new Set(scenarioIds);

  for (const scenario of scenarios) {
    if (!scenario || typeof scenario !== 'object') {
      errors.push('every scenario must be an object');
      continue;
    }
    if (typeof scenario.id !== 'string' || !scenario.id) errors.push('scenario id is required');
    if (typeof scenario.label !== 'string' || !scenario.label) {
      errors.push(`scenario ${scenario.id || '(unknown)'} is missing label`);
    }
    if (typeof scenario.purpose !== 'string' || !scenario.purpose) {
      errors.push(`scenario ${scenario.id || '(unknown)'} is missing purpose`);
    }
  }

  for (const tool of tools) {
    const prefix = `tool ${tool?.id || '(unknown)'}`;
    if (!tool || typeof tool !== 'object') {
      errors.push('every tool must be an object');
      continue;
    }
    for (const key of [
      'id',
      'name',
      'providerId',
      'provider',
      'tier',
      'kind',
      'criterion',
      'limitations',
    ]) {
      if (typeof tool[key] !== 'string' || !tool[key]) errors.push(`${prefix} is missing ${key}`);
    }
    if (!KNOWN_PARSERS.has(tool.parser)) errors.push(`${prefix} has unknown parser ${tool.parser}`);
    if (!KNOWN_CAPTURE_POLICIES.has(tool.capturePolicy)) {
      errors.push(`${prefix} has unknown capturePolicy ${tool.capturePolicy}`);
    }
    if (!Array.isArray(tool.routes)) errors.push(`${prefix} routes must be an array`);
    for (const route of tool.routes || []) {
      if (!isHttpsUrl(route)) errors.push(`${prefix} route must be HTTPS: ${route}`);
    }
    if (!isHttpsUrl(tool.sourceUrl)) errors.push(`${prefix} sourceUrl must be HTTPS`);
    if (!Array.isArray(tool.signals) || tool.signals.length === 0) {
      errors.push(`${prefix} signals must not be empty`);
    }
    if (!Array.isArray(tool.requiredScenarios) || tool.requiredScenarios.length === 0) {
      errors.push(`${prefix} requiredScenarios must not be empty`);
    }
    for (const id of duplicateValues(tool.requiredScenarios || [])) {
      errors.push(`${prefix} repeats required scenario ${id}`);
    }
    for (const id of tool.requiredScenarios || []) {
      if (!knownScenarioIds.has(id)) errors.push(`${prefix} references unknown scenario ${id}`);
    }
  }

  const requiredProviders = new Set(
    tools.filter((tool) => tool?.tier === 'required').map((tool) => tool.providerId),
  );
  if (requiredProviders.size < (matrix.minimumIndependentProviders || 10)) {
    errors.push(
      `only ${requiredProviders.size} independent required providers; need ${matrix.minimumIndependentProviders}`,
    );
  }

  // Security invariant: the upstream project says its GitHub Pages deployment is the only official
  // CreepJS site. This catches an accidental return to the unrelated creepjs.org domain.
  const creep = tools.find((tool) => tool.id === 'creepjs');
  if (!creep?.routes?.every((route) => new URL(route).hostname === 'abrahamjuliot.github.io')) {
    errors.push('creepjs must use only the official abrahamjuliot.github.io deployment');
  }
  return errors;
}

export function createReportTemplate(matrix, now = new Date()) {
  return {
    schemaVersion: 1,
    matrixVersion: matrix.matrixVersion,
    runId: `matrix-${now.toISOString().replace(/[:.]/g, '-')}`,
    capturedAt: null,
    environment: {
      productBuild: null,
      lobiumBinarySha256: null,
      profileId: null,
      profileSeed: null,
      secondProfileId: null,
      secondProfileSeed: null,
      os: null,
      headful: null,
      gpuMode: null,
      softwareRenderer: null,
      observedRenderer: null,
      gpuBaselineReportSha256: null,
      provisional: null,
      provisionalReason: null,
      releaseGateEligible: null,
      expectedProxyIp: null,
      observedProxyIp: null,
      expectedDirectIp: null,
      observedDirectIp: null,
      expectedTimezone: null,
      observedTimezone: null,
      stockBrowserBuild: null,
      stockBrowserBinarySha256: null,
      connectionModesTested: [],
      notes: null,
    },
    results: matrix.tools.flatMap((tool) =>
      tool.requiredScenarios.map((scenarioId) => ({
        toolId: tool.id,
        providerId: tool.providerId,
        scenarioId,
        verdict: 'not_run',
        provisional: null,
        provisionalReason: null,
        observed: null,
        artifacts: [],
        reviewer: null,
        reviewedAt: null,
        notes: null,
      })),
    ),
  };
}

function reportResultKey(result) {
  return `${result?.toolId || ''}\u0000${result?.scenarioId || ''}`;
}

/** Grade evidence completeness. This never infers pass from capture success. */
export function evaluateReport(matrix, report, nowMs = Date.now()) {
  const checks = [];
  const check = (id, pass, detail) => checks.push({ id, pass: Boolean(pass), detail });
  check('report.schema', report?.schemaVersion === 1, `schemaVersion=${report?.schemaVersion}`);
  check(
    'report.matrix-version',
    report?.matrixVersion === matrix.matrixVersion,
    `report=${report?.matrixVersion}, expected=${matrix.matrixVersion}`,
  );

  const capturedMs = Date.parse(report?.capturedAt || '');
  const maxAgeMs = Number(matrix.evidencePolicy?.maxAgeHours || 24) * 60 * 60 * 1000;
  const ageMs = Number.isFinite(capturedMs) ? nowMs - capturedMs : Number.POSITIVE_INFINITY;
  check(
    'environment.fresh',
    Number.isFinite(capturedMs) && ageMs >= 0 && ageMs <= maxAgeMs,
    Number.isFinite(capturedMs)
      ? `ageHours=${(ageMs / 3_600_000).toFixed(2)}`
      : 'capturedAt missing/invalid',
  );

  const env = report?.environment || {};
  check(
    'environment.product-build',
    typeof env.productBuild === 'string' && env.productBuild.length > 0,
    `productBuild=${env.productBuild}`,
  );
  check(
    'environment.binary-hash',
    /^[a-f0-9]{64}$/i.test(env.lobiumBinarySha256 || ''),
    'Lobium binary SHA-256 recorded',
  );
  check(
    'environment.primary-profile',
    typeof env.profileId === 'string' &&
      env.profileId.length > 0 &&
      typeof env.profileSeed === 'string' &&
      env.profileSeed.length > 0,
    `profileId=${env.profileId}, seedRecorded=${typeof env.profileSeed === 'string' && env.profileSeed.length > 0}`,
  );
  check(
    'environment.second-profile',
    typeof env.secondProfileId === 'string' &&
      env.secondProfileId.length > 0 &&
      env.secondProfileId !== env.profileId &&
      typeof env.secondProfileSeed === 'string' &&
      env.secondProfileSeed.length > 0 &&
      env.secondProfileSeed !== env.profileSeed,
    `secondProfileId=${env.secondProfileId}, distinct=${env.secondProfileId !== env.profileId && env.secondProfileSeed !== env.profileSeed}`,
  );
  check('environment.headful', env.headful === true, `headful=${env.headful}`);
  check(
    'environment.gpu-mode',
    env.gpuMode === matrix.evidencePolicy.requireExplicitGpuMode,
    `gpuMode=${env.gpuMode}`,
  );
  check(
    'environment.real-renderer',
    env.softwareRenderer === false &&
      typeof env.observedRenderer === 'string' &&
      env.observedRenderer.length > 0,
    `softwareRenderer=${env.softwareRenderer}, renderer=${env.observedRenderer}`,
  );
  check(
    'environment.gpu-baseline-artifact',
    /^[a-f0-9]{64}$/i.test(env.gpuBaselineReportSha256 || ''),
    'unspoofed GPU baseline report SHA-256 recorded',
  );
  check(
    'environment.proxy-ip',
    typeof env.expectedProxyIp === 'string' &&
      env.expectedProxyIp.length > 0 &&
      env.observedProxyIp === env.expectedProxyIp,
    `expected=${env.expectedProxyIp}, observed=${env.observedProxyIp}`,
  );
  check(
    'environment.negative-control-ip',
    typeof env.expectedDirectIp === 'string' &&
      env.expectedDirectIp.length > 0 &&
      env.observedDirectIp === env.expectedDirectIp &&
      env.observedDirectIp !== env.observedProxyIp,
    `expected=${env.expectedDirectIp}, observed=${env.observedDirectIp}, proxy=${env.observedProxyIp}`,
  );
  check(
    'environment.timezone',
    typeof env.expectedTimezone === 'string' &&
      env.expectedTimezone.length > 0 &&
      env.observedTimezone === env.expectedTimezone,
    `expected=${env.expectedTimezone}, observed=${env.observedTimezone}`,
  );
  check(
    'environment.stock-browser',
    typeof env.stockBrowserBuild === 'string' &&
      env.stockBrowserBuild.length > 0 &&
      /^[a-f0-9]{64}$/i.test(env.stockBrowserBinarySha256 || ''),
    `stockBrowserBuild=${env.stockBrowserBuild}, hashRecorded=${/^[a-f0-9]{64}$/i.test(env.stockBrowserBinarySha256 || '')}`,
  );
  const modes = new Set(Array.isArray(env.connectionModesTested) ? env.connectionModesTested : []);
  check(
    'environment.connection-modes',
    modes.has('uncontrolled') && modes.has('controlled'),
    `modes=${[...modes].join(',') || '(none)'}`,
  );

  const validVerdicts = new Set(matrix.verdicts);
  const resultList = Array.isArray(report?.results) ? report.results : [];
  const duplicateKeys = duplicateValues(resultList.map(reportResultKey)).filter(
    (key) => key !== '\u0000',
  );
  check('results.no-duplicates', duplicateKeys.length === 0, `duplicates=${duplicateKeys.length}`);
  const resultMap = new Map(resultList.map((result) => [reportResultKey(result), result]));
  const requiredPairs = matrix.tools.flatMap((tool) =>
    tool.requiredScenarios.map((scenarioId) => ({ tool, scenarioId })),
  );
  const missing = [];
  const failed = [];
  const inconclusive = [];
  const notRun = [];
  const invalid = [];
  const unreviewed = [];
  const evidenceMissing = [];
  for (const { tool, scenarioId } of requiredPairs) {
    const key = `${tool.id}\u0000${scenarioId}`;
    const result = resultMap.get(key);
    if (!result) {
      missing.push(`${tool.id}/${scenarioId}`);
      continue;
    }
    if (!validVerdicts.has(result.verdict)) {
      invalid.push(`${tool.id}/${scenarioId}:${result.verdict}`);
    } else if (result.verdict === 'fail') {
      failed.push(`${tool.id}/${scenarioId}`);
    } else if (result.verdict === 'inconclusive') {
      inconclusive.push(`${tool.id}/${scenarioId}`);
    } else if (result.verdict === 'not_run') {
      notRun.push(`${tool.id}/${scenarioId}`);
    } else if (result.verdict === 'pass') {
      const reviewedMs = Date.parse(result.reviewedAt || '');
      if (
        typeof result.reviewer !== 'string' ||
        result.reviewer.length === 0 ||
        !Number.isFinite(reviewedMs) ||
        (Number.isFinite(capturedMs) && reviewedMs < capturedMs) ||
        reviewedMs > nowMs
      ) {
        unreviewed.push(`${tool.id}/${scenarioId}`);
      }
      const hasObserved =
        result.observed !== null &&
        result.observed !== undefined &&
        (typeof result.observed !== 'object' || Object.keys(result.observed).length > 0);
      const hasArtifact =
        Array.isArray(result.artifacts) &&
        result.artifacts.some((artifact) => typeof artifact === 'string' && artifact.length > 0);
      if (!hasObserved || !hasArtifact) evidenceMissing.push(`${tool.id}/${scenarioId}`);
    }
  }
  check('results.present', missing.length === 0, `missing=${missing.length}`);
  check('results.valid-verdicts', invalid.length === 0, `invalid=${invalid.length}`);
  check('results.no-failures', failed.length === 0, `failed=${failed.length}`);
  check(
    'results.no-inconclusive',
    inconclusive.length === 0,
    `inconclusive=${inconclusive.length}`,
  );
  check('results.all-run', notRun.length === 0, `notRun=${notRun.length}`);
  check('results.reviewed', unreviewed.length === 0, `unreviewedPasses=${unreviewed.length}`);
  check(
    'results.evidence-attached',
    evidenceMissing.length === 0,
    `passesMissingEvidence=${evidenceMissing.length}`,
  );

  const passingProviderIds = new Set();
  for (const tool of matrix.tools.filter((entry) => entry.tier === 'required')) {
    if (
      tool.requiredScenarios.every(
        (scenarioId) => resultMap.get(`${tool.id}\u0000${scenarioId}`)?.verdict === 'pass',
      )
    ) {
      passingProviderIds.add(tool.providerId);
    }
  }
  check(
    'results.independent-providers',
    passingProviderIds.size >= matrix.minimumIndependentProviders,
    `passingProviders=${passingProviderIds.size}/${matrix.minimumIndependentProviders}`,
  );

  return {
    releaseReady: checks.every((entry) => entry.pass),
    checks,
    counts: {
      requiredPairs: requiredPairs.length,
      missing: missing.length,
      failed: failed.length,
      inconclusive: inconclusive.length,
      notRun: notRun.length,
      invalid: invalid.length,
      unreviewed: unreviewed.length,
      evidenceMissing: evidenceMissing.length,
      passingIndependentProviders: passingProviderIds.size,
    },
    details: { missing, failed, inconclusive, notRun, invalid, unreviewed, evidenceMissing },
  };
}

function bodyHash(text) {
  return createHash('sha256').update(text).digest('hex');
}

function safeName(value) {
  return value
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

async function parseSannysoft(page) {
  const rows = await page.$$eval('table tr', (trs) =>
    trs
      .map((tr) => {
        const cells = Array.from(tr.querySelectorAll('td'));
        if (cells.length < 2) return null;
        const className = cells[1].className || '';
        return {
          name: (cells[0].textContent || '').trim().slice(0, 100),
          status: className.includes('failed')
            ? 'failed'
            : className.includes('passed')
              ? 'passed'
              : 'info',
        };
      })
      .filter(Boolean),
  );
  const failed = rows.filter((row) => row.status === 'failed');
  return {
    verdict: rows.length >= 5 ? (failed.length === 0 ? 'pass' : 'fail') : 'inconclusive',
    observed: { totalRows: rows.length, failedTests: failed.map((row) => row.name) },
  };
}

async function parseDeviceInfo(page) {
  const text = await page
    .locator('body')
    .innerText()
    .catch(() => '');
  const match = text.match(/\{[\s\S]*"isBot"[\s\S]*\}/);
  if (!match) return { verdict: 'inconclusive', observed: { reason: 'JSON result not found' } };
  try {
    const detection = JSON.parse(match[0]);
    if (typeof detection?.isBot !== 'boolean') {
      return { verdict: 'inconclusive', observed: { reason: 'isBot boolean not found' } };
    }
    const flags = Object.entries(detection.details || {})
      .filter(([, value]) => value === true)
      .map(([key]) => key);
    return {
      verdict: detection.isBot || flags.length > 0 ? 'fail' : 'pass',
      observed: { isBot: detection.isBot, trueFlags: flags },
    };
  } catch (error) {
    return { verdict: 'inconclusive', observed: { reason: `invalid JSON: ${String(error)}` } };
  }
}

async function parseCreepjs(page, context) {
  const cdp = await context.newCDPSession(page);
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { result } = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const fp = window.Fingerprint;
          if (!fp) return null;
          return {
            lies: typeof fp.lies?.totalLies === 'number' ? fp.lies.totalLies : null,
            lieItems: Object.keys(fp.lies?.data || {}),
            workerUa: fp.workerScope?.userAgent ?? null,
            workerPlatform: fp.workerScope?.platform ?? null,
            headlessRating: fp.headless?.headlessRating ?? null,
            stealthRating: fp.headless?.stealthRating ?? null
          };
        })()`,
        returnByValue: true,
      });
      const observed = result?.value;
      if (observed && typeof observed.lies === 'number') {
        return { verdict: observed.lies === 0 ? 'pass' : 'fail', observed };
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
    }
    return {
      verdict: 'inconclusive',
      observed: { reason: 'window.Fingerprint/lie count unavailable' },
    };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function parseTool(tool, page, context) {
  if (tool.parser === 'sannysoft') return parseSannysoft(page);
  if (tool.parser === 'deviceinfo-bot') return parseDeviceInfo(page);
  if (tool.parser === 'creepjs') return parseCreepjs(page, context);
  return {
    verdict: 'inconclusive',
    observed: {
      reason: 'capture completed; tool requires explicit human review against its criterion',
    },
  };
}

async function capturePinnedSelfHost(tool, page, artifactDir, scenarioId) {
  const fixtureRoot = resolve(
    process.env.LOBSTER_MATRIX_SELF_HOST_DIR || join(here, 'reports', 'self-host-pinned'),
  );
  const screenshot = join(artifactDir, `${safeName(tool.id)}-self-host.png`);
  const rawPath = join(artifactDir, `${safeName(tool.id)}-self-host.json`);
  let observed;
  let fixture;
  if (tool.id === 'botd') {
    fixture = {
      package: '@fingerprintjs/botd',
      version: '2.0.0',
      bundle: join(fixtureRoot, 'botd-2.0.0', 'package', 'dist', 'botd.esm.js'),
      tarball: join(fixtureRoot, 'fingerprintjs-botd-2.0.0.tgz'),
    };
    const source = await readFile(fixture.bundle, 'utf8');
    await page.setContent('<!doctype html><title>BotD pinned self-host</title><pre>pending</pre>');
    await page.addScriptTag({
      type: 'module',
      content: `${source}
        load().then((agent) => agent.detect())
          .then((result) => {
            const output = document.querySelector('pre');
            output.textContent = JSON.stringify(result);
            output.dataset.complete = '1';
          })
          .catch((error) => {
            const output = document.querySelector('pre');
            output.textContent = JSON.stringify({ error: String(error) });
            output.dataset.complete = '1';
          });`,
    });
    await page.waitForSelector('pre[data-complete="1"]', { timeout: 20_000 });
    observed = JSON.parse((await page.locator('pre').textContent()) || '{}');
  } else if (tool.id === 'thumbmarkjs') {
    fixture = {
      package: '@thumbmarkjs/thumbmarkjs',
      version: '1.10.0',
      bundle: join(fixtureRoot, 'thumbmarkjs-1.10.0', 'package', 'dist', 'thumbmark.umd.js'),
      tarball: join(fixtureRoot, 'thumbmarkjs-thumbmarkjs-1.10.0.tgz'),
    };
    await page.setContent(
      '<!doctype html><title>ThumbmarkJS pinned self-host</title><pre>pending</pre>',
    );
    const source = await readFile(fixture.bundle, 'utf8');
    await page.addScriptTag({
      content: `${source}
        new globalThis.ThumbmarkJS.Thumbmark({ logging: false, timeout: 10000 }).get()
          .then((result) => {
            const output = document.querySelector('pre');
            output.textContent = JSON.stringify(result);
            output.dataset.complete = '1';
          })
          .catch((error) => {
            const output = document.querySelector('pre');
            output.textContent = JSON.stringify({ error: String(error) });
            output.dataset.complete = '1';
          });`,
    });
    await page.waitForSelector('pre[data-complete="1"]', { timeout: 20_000 });
    observed = JSON.parse((await page.locator('pre').textContent()) || '{}');
  } else {
    return {
      verdict: 'inconclusive',
      observed: { reason: `no pinned self-host adapter for ${tool.id}` },
      artifacts: [],
    };
  }
  const tarballSha256 = bodyHash(await readFile(fixture.tarball));
  const raw = {
    toolId: tool.id,
    scenarioId,
    fixture: {
      package: fixture.package,
      version: fixture.version,
      tarballSha256,
    },
    observed,
  };
  await writeFile(rawPath, `${JSON.stringify(raw, null, 2)}\n`);
  await page.evaluate((value) => {
    document.querySelector('pre').textContent = JSON.stringify(value, null, 2);
  }, raw);
  const bodyText = await page.locator('body').innerText();
  await page.screenshot({ path: screenshot, fullPage: false });
  const detectedBot = tool.id === 'botd' && observed?.bot === true;
  return {
    verdict: detectedBot ? 'fail' : 'inconclusive',
    observed: {
      fixture: raw.fixture,
      raw: observed,
      bodySha256: bodyHash(bodyText),
      limitation:
        tool.id === 'botd'
          ? 'A non-bot observation remains inconclusive because the required positive detection control was not run in this product session.'
          : 'ThumbmarkJS is an identifier; one computed fingerprint is never a pass without relaunch and cross-profile comparison.',
    },
    artifacts: [rawPath, screenshot],
  };
}

const WAIT_BY_TOOL = {
  creepjs: 18_000,
  pixelscan: 12_000,
  iphey: 15_000,
  'cover-your-tracks': 3_000,
  amiunique: 3_000,
};

async function safelyDisconnect(browser) {
  if (process.env.LOBSTER_MATRIX_CLOSE_BROWSER === '1') {
    await browser.close();
    return;
  }
  // Browser.close terminates a CDP-attached product profile. Closing only the client connection is the
  // safer default; Patchright/Playwright do not expose a public disconnect method, so use the connection
  // primitive when available and fall back to process exit after the report has been flushed.
  const connection = browser?._connection;
  if (connection && typeof connection.close === 'function') {
    try {
      await connection.close();
    } catch {
      /* best-effort client detach; do not terminate the product profile */
    }
  }
}

async function captureLive(matrix, outPath) {
  if (process.env.LOBSTER_MATRIX_LIVE !== '1') {
    throw new Error(
      'live capture is disabled; set LOBSTER_MATRIX_LIVE=1 after reviewing tester terms/privacy',
    );
  }
  const endpoint = process.env.LOBSTER_MATRIX_CDP;
  if (!endpoint)
    throw new Error('LOBSTER_MATRIX_CDP must point to the running product profile CDP endpoint');
  const scenarioId = process.env.LOBSTER_MATRIX_SCENARIO || 'proxy-headful-controlled';
  if (scenarioId === 'proxy-headful-uncontrolled') {
    throw new Error(
      'CDP capture cannot claim the uncontrolled scenario; run and review that scenario manually',
    );
  }
  if (!matrix.scenarios.some((scenario) => scenario.id === scenarioId)) {
    throw new Error(`unknown LOBSTER_MATRIX_SCENARIO: ${scenarioId}`);
  }

  const artifactDir = resolve(
    process.env.LOBSTER_MATRIX_ARTIFACT_DIR ||
      join(here, 'reports', `detector-matrix-${Date.now()}`),
  );
  await mkdir(artifactDir, { recursive: true });
  const report = createReportTemplate(matrix);
  report.capturedAt = new Date().toISOString();
  report.environment = {
    ...report.environment,
    productBuild: process.env.LOBSTER_MATRIX_PRODUCT_BUILD || null,
    lobiumBinarySha256: process.env.LOBSTER_MATRIX_BINARY_SHA256 || null,
    profileId: process.env.LOBSTER_MATRIX_PROFILE_ID || null,
    profileSeed: process.env.LOBSTER_MATRIX_PROFILE_SEED || null,
    secondProfileId: process.env.LOBSTER_MATRIX_SECOND_PROFILE_ID || null,
    secondProfileSeed: process.env.LOBSTER_MATRIX_SECOND_PROFILE_SEED || null,
    os: process.env.LOBSTER_MATRIX_OS || null,
    headful: process.env.LOBSTER_MATRIX_HEADFUL === '1' ? true : null,
    gpuMode: process.env.LOBSTER_GPU || null,
    softwareRenderer:
      process.env.LOBSTER_MATRIX_SOFTWARE_RENDERER === '0'
        ? false
        : process.env.LOBSTER_MATRIX_SOFTWARE_RENDERER === '1'
          ? true
          : null,
    observedRenderer: process.env.LOBSTER_MATRIX_OBSERVED_RENDERER || null,
    gpuBaselineReportSha256: process.env.LOBSTER_MATRIX_GPU_BASELINE_SHA256 || null,
    expectedProxyIp: process.env.LOBSTER_MATRIX_EXPECTED_PROXY_IP || null,
    observedProxyIp: process.env.LOBSTER_MATRIX_OBSERVED_PROXY_IP || null,
    expectedDirectIp: process.env.LOBSTER_MATRIX_EXPECTED_DIRECT_IP || null,
    observedDirectIp: process.env.LOBSTER_MATRIX_OBSERVED_DIRECT_IP || null,
    expectedTimezone: process.env.LOBSTER_MATRIX_EXPECTED_TIMEZONE || null,
    observedTimezone: process.env.LOBSTER_MATRIX_OBSERVED_TIMEZONE || null,
    stockBrowserBuild: process.env.LOBSTER_MATRIX_STOCK_BROWSER_BUILD || null,
    stockBrowserBinarySha256: process.env.LOBSTER_MATRIX_STOCK_BROWSER_SHA256 || null,
    connectionModesTested: ['controlled'],
    notes: 'Generic CDP capture; uncontrolled evidence must be collected before attachment.',
  };
  report.environment.provisional =
    report.environment.gpuMode !== 'gpu' || report.environment.softwareRenderer !== false;
  report.environment.releaseGateEligible = !report.environment.provisional;
  report.environment.provisionalReason = report.environment.provisional
    ? 'Software/non-GPU host evidence can never satisfy the real-GPU release gate.'
    : null;

  const { chromium } = await import('patchright');
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error('CDP endpoint exposed no browser context');
    const selectedToolIds = new Set(
      (process.env.LOBSTER_MATRIX_TOOL_IDS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    );
    for (const tool of matrix.tools) {
      if (selectedToolIds.size > 0 && !selectedToolIds.has(tool.id)) continue;
      if (!tool.requiredScenarios.includes(scenarioId)) continue;
      if (tool.capturePolicy === 'manual-consent') continue;
      if (tool.capturePolicy === 'self-host-pinned') {
        const page = await context.newPage();
        let captured;
        try {
          captured = await capturePinnedSelfHost(tool, page, artifactDir, scenarioId);
        } catch (error) {
          captured = {
            verdict: 'inconclusive',
            observed: { reason: String(error) },
            artifacts: [],
          };
        } finally {
          await page.close().catch(() => {});
        }
        const key = `${tool.id}\u0000${scenarioId}`;
        const result = report.results.find((entry) => reportResultKey(entry) === key);
        if (result) {
          result.verdict = captured.verdict;
          result.provisional = report.environment.provisional;
          result.provisionalReason = report.environment.provisionalReason;
          result.observed = captured.observed;
          result.artifacts = captured.artifacts;
          result.notes =
            'Pinned self-host capture; package version and tarball SHA-256 are recorded. Review scenario comparisons explicitly.';
        }
        process.stderr.write(`  ${captured.verdict.toUpperCase().padEnd(12)} ${tool.id}\n`);
        continue;
      }
      if (tool.capturePolicy !== 'single-visit' || tool.routes.length === 0) continue;
      const routeEvidence = [];
      let parsed = { verdict: 'inconclusive', observed: { reason: 'no route completed' } };
      for (let index = 0; index < tool.routes.length; index += 1) {
        const route = tool.routes[index];
        const page = await context.newPage();
        const started = Date.now();
        try {
          const response = await page.goto(route, {
            waitUntil: 'domcontentloaded',
            timeout: 60_000,
          });
          await page.waitForTimeout(WAIT_BY_TOOL[tool.id] || 6_000);
          const bodyText = await page
            .locator('body')
            .innerText()
            .catch(() => '');
          const screenshot = join(artifactDir, `${safeName(tool.id)}-${index + 1}.png`);
          const rawBody = join(artifactDir, `${safeName(tool.id)}-${index + 1}-body.txt`);
          await writeFile(rawBody, bodyText);
          await page.screenshot({ path: screenshot, fullPage: false });
          routeEvidence.push({
            requestedUrl: route,
            finalUrl: page.url(),
            status: response?.status() ?? null,
            title: await page.title().catch(() => ''),
            bodySha256: bodyHash(bodyText),
            bodyCharacters: bodyText.length,
            rawBody,
            screenshot,
            elapsedMs: Date.now() - started,
          });
          if (index === 0) parsed = await parseTool(tool, page, context);
        } catch (error) {
          routeEvidence.push({
            requestedUrl: route,
            error: String(error),
            elapsedMs: Date.now() - started,
          });
          parsed = { verdict: 'inconclusive', observed: { reason: String(error) } };
        } finally {
          await page.close().catch(() => {});
        }
      }
      const key = `${tool.id}\u0000${scenarioId}`;
      const result = report.results.find((entry) => reportResultKey(entry) === key);
      if (result) {
        result.verdict = parsed.verdict;
        result.provisional = report.environment.provisional;
        result.provisionalReason = report.environment.provisionalReason;
        result.observed = { parser: parsed.observed, routes: routeEvidence };
        result.artifacts = routeEvidence.flatMap((entry) =>
          [entry.rawBody, entry.screenshot].filter(
            (artifact) => typeof artifact === 'string' && artifact.length > 0,
          ),
        );
        result.notes =
          parsed.verdict === 'inconclusive'
            ? 'Capture is evidence only; review screenshots/raw values and assign a verdict explicitly.'
            : 'Machine-parsed narrow diagnostic result; still review before release sign-off.';
      }
      process.stderr.write(`  ${parsed.verdict.toUpperCase().padEnd(12)} ${tool.id}\n`);
    }
  } finally {
    await safelyDisconnect(browser);
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function printList(matrix) {
  process.stdout.write('id\tprovider\tkind\tcapture\troutes\n');
  for (const tool of matrix.tools) {
    process.stdout.write(
      `${tool.id}\t${tool.providerId}\t${tool.kind}\t${tool.capturePolicy}\t${tool.routes.length}\n`,
    );
  }
}

async function main() {
  const matrix = await loadMatrix();
  const errors = validateMatrix(matrix);
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`ERROR ${error}\n`);
    process.exitCode = 1;
    return;
  }

  if (process.argv.includes('--list')) {
    printList(matrix);
    return;
  }
  const initPath = argValue('--init');
  if (initPath) {
    const output = resolve(initPath);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(createReportTemplate(matrix), null, 2)}\n`);
    process.stdout.write(`${output}\n`);
    return;
  }
  const capturePath = argValue('--capture');
  if (capturePath) {
    const output = resolve(capturePath);
    await captureLive(matrix, output);
    process.stdout.write(`${output}\n`);
    // connectOverCDP has no public disconnect primitive. The report is fully flushed above, so exit
    // the short-lived capture client explicitly without sending Browser.close to the product profile.
    process.exit(0);
    return;
  }
  const gradePath = argValue('--grade');
  if (gradePath) {
    const evaluation = evaluateReport(matrix, await loadJson(resolve(gradePath)));
    process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
    if (!evaluation.releaseReady) process.exitCode = 1;
    return;
  }

  const requiredProviders = new Set(
    matrix.tools.filter((tool) => tool.tier === 'required').map((tool) => tool.providerId),
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        valid: true,
        matrixVersion: matrix.matrixVersion,
        tools: matrix.tools.length,
        independentRequiredProviders: requiredProviders.size,
        minimumIndependentProviders: matrix.minimumIndependentProviders,
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 2;
  });
}
