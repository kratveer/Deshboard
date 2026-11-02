/**
 * Daylight health data — Apple Health / Health Connect / Google Fit adapters.
 * Every summary is normalized before the Statistics (Health) tab renders.
 */
(function (root) {
  const FITNESS_SCOPES = [
    'https://www.googleapis.com/auth/fitness.activity.read',
    'https://www.googleapis.com/auth/fitness.heart_rate.read',
    'https://www.googleapis.com/auth/fitness.sleep.read',
    'https://www.googleapis.com/auth/fitness.body.read'
  ];
  const CACHE_KEY = 'daylight-health-cache';
  const RANGE_KEY = 'daylight-health-range';

  function dayStart(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function avg(nums) {
    const list = (nums || []).filter((n) => Number.isFinite(n));
    if (!list.length) return 0;
    return list.reduce((a, b) => a + b, 0) / list.length;
  }

  function sum(nums) {
    return (nums || []).reduce((a, b) => a + (Number(b) || 0), 0);
  }

  function pctDelta(cur, prev) {
    if (!prev) return cur ? 100 : 0;
    return Math.round(((cur - prev) / Math.abs(prev)) * 100);
  }

  function readCache() {
    try {
      return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function writeCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ...data, cachedAt: Date.now() }));
    } catch {}
  }

  function getRangeDays() {
    try {
      const n = +localStorage.getItem(RANGE_KEY);
      return [7, 14, 30].includes(n) ? n : 7;
    } catch {
      return 7;
    }
  }

  function setRangeDays(n) {
    try {
      localStorage.setItem(RANGE_KEY, String(n));
    } catch {}
  }

  function emptySeries(days) {
    const out = [];
    const start = dayStart(new Date());
    start.setDate(start.getDate() - (days - 1));
    for (let i = 0; i < days; i++) {
      const d = new Date(start.getTime() + i * 86400000);
      out.push({ date: d.toISOString().slice(0, 10), steps: 0, calories: 0, sleepMin: 0, heartRate: 0, activeMin: 0 });
    }
    return out;
  }

  function demoSeries(days) {
    const base = emptySeries(days);
    const stepsPat = [7420, 9100, 6800, 10240, 8650, 12100, 8942];
    const calPat = [2100, 2380, 1950, 2520, 2280, 2710, 2480];
    const sleepPat = [420, 455, 390, 470, 440, 480, 440];
    const hrPat = [64, 61, 63, 60, 62, 59, 62];
    const actPat = [28, 35, 18, 42, 30, 48, 22];
    return base.map((row, i) => {
      const k = i % 7;
      const wobble = ((i * 17) % 9) - 4;
      return {
        ...row,
        steps: Math.max(1200, stepsPat[k] + wobble * 80),
        calories: Math.max(1400, calPat[k] + wobble * 12),
        sleepMin: Math.max(300, sleepPat[k] + wobble),
        heartRate: Math.max(52, hrPat[k] + (wobble > 0 ? 1 : 0)),
        activeMin: Math.max(8, actPat[k] + Math.floor(wobble / 2))
      };
    });
  }

  function summarize(series, source, connected) {
    const days = series.length || 7;
    const half = Math.max(1, Math.floor(days / 2));
    const recent = series.slice(-half);
    const prior = series.slice(0, Math.max(1, days - half));
    const stepsAvg = Math.round(avg(series.map((d) => d.steps)));
    const calAvg = Math.round(avg(series.map((d) => d.calories)));
    const sleepAvg = Math.round(avg(series.map((d) => d.sleepMin)));
    const hrAvg = Math.round(avg(series.map((d) => d.heartRate).filter(Boolean)) || 0);
    const activeWeek = Math.round(sum(series.slice(-7).map((d) => d.activeMin)));
    const stepsPrev = avg(prior.map((d) => d.steps));
    const sleepPrev = avg(prior.map((d) => d.sleepMin));
    const stepsDelta = pctDelta(avg(recent.map((d) => d.steps)), stepsPrev);
    const sleepDeltaMin = Math.round(avg(recent.map((d) => d.sleepMin)) - sleepPrev);
    const activityGoal = 150;
    const activityPct = clamp(Math.round((activeWeek / activityGoal) * 100), 0, 100);

    // Simple 0–100 score: steps, sleep, activity blend
    const stepScore = clamp((stepsAvg / 10000) * 40, 0, 40);
    const sleepScore = clamp((sleepAvg / 480) * 35, 0, 35);
    const actScore = clamp((activeWeek / activityGoal) * 25, 0, 25);
    const score = Math.round(stepScore + sleepScore + actScore);
    const scorePrev = clamp(score - Math.round(stepsDelta / 4) - Math.round(sleepDeltaMin / 6), 40, 98);
    const scoreDelta = score - scorePrev;

    const insightParts = [];
    if (sleepDeltaMin) {
      insightParts.push(
        `Your average sleep ${sleepDeltaMin > 0 ? 'increased' : 'decreased'} by ${Math.abs(sleepDeltaMin)} minutes`
      );
    }
    if (stepsDelta) {
      insightParts.push(`activity was ${Math.abs(stepsDelta)}% ${stepsDelta >= 0 ? 'higher' : 'lower'} this period`);
    }
    const insight = insightParts.length
      ? `Insight for you: ${insightParts.join(' and ')}. ${scoreDelta >= 0 ? 'Great job!' : 'A steadier routine will lift your score.'}`
      : 'Insight for you: Keep logging movement and sleep to unlock personalised tips.';

    return {
      source: source || 'none',
      connected: !!connected,
      rangeDays: days,
      score,
      scoreDelta,
      stepsAvg,
      stepsDelta,
      caloriesAvg: calAvg,
      sleepAvgMin: sleepAvg,
      sleepDeltaMin,
      restingHr: hrAvg,
      activeMinWeek: activeWeek,
      activityGoal,
      activityPct,
      series,
      insight,
      fetchedAt: Date.now()
    };
  }

  function capacitorHealthPlugin() {
    const Cap = root.Capacitor;
    if (!Cap?.Plugins) return null;
    return Cap.Plugins.Health || Cap.Plugins.HealthKit || Cap.Plugins.CapacitorHealthkit || null;
  }

  async function fromCapacitor(days) {
    const Health = capacitorHealthPlugin();
    if (!Health) return null;
    const end = new Date();
    const start = dayStart(new Date());
    start.setDate(start.getDate() - (days - 1));
    try {
      if (Health.requestAuthorization) {
        await Health.requestAuthorization({
          read: ['steps', 'calories', 'distance', 'heartRate', 'sleepAnalysis', 'activity'],
          write: []
        });
      } else if (Health.requestHealthPermissions) {
        await Health.requestHealthPermissions({
          read: ['STEPS', 'CALORIES', 'HEART_RATE', 'SLEEP', 'DISTANCE'],
          write: []
        });
      }
    } catch (e) {
      console.warn('health auth', e);
    }

    const series = emptySeries(days);
    const byDate = Object.create(null);
    series.forEach((r) => {
      byDate[r.date] = r;
    });

    const queryFns = [
      ['steps', 'stepCount', 'STEPS', (v) => ({ steps: Math.round(v) })],
      ['calories', 'activeEnergyBurned', 'CALORIES', (v) => ({ calories: Math.round(v) })],
      ['heartRate', 'heartRate', 'HEART_RATE', (v) => ({ heartRate: Math.round(v) })],
      ['sleep', 'sleepAnalysis', 'SLEEP', (v) => ({ sleepMin: Math.round(v > 24 ? v : v * 60) })],
      ['activity', 'appleExerciseTime', 'ACTIVITY', (v) => ({ activeMin: Math.round(v) })]
    ];

    for (const [key, apple, android, map] of queryFns) {
      try {
        let samples = [];
        if (Health.queryHKitSampleType) {
          samples = (await Health.queryHKitSampleType({
            sampleName: apple,
            startDate: start.toISOString(),
            endDate: end.toISOString(),
            limit: 0
          })) || [];
        } else if (Health.readSamples) {
          samples = (await Health.readSamples({
            dataType: android,
            startDate: start.toISOString(),
            endDate: end.toISOString()
          })) || [];
        } else if (Health.queryAggregated) {
          const agg = await Health.queryAggregated({
            dataType: key,
            startDate: start.toISOString(),
            endDate: end.toISOString(),
            bucket: 'day'
          });
          samples = (agg?.samples || agg || []).map((s) => ({
            startDate: s.startDate || s.start,
            value: s.value ?? s.quantity ?? s.sum
          }));
        }
        (Array.isArray(samples) ? samples : []).forEach((s) => {
          const when = new Date(s.startDate || s.endDate || s.date || s.start);
          if (Number.isNaN(when.getTime())) return;
          const keyDate = dayStart(when).toISOString().slice(0, 10);
          const row = byDate[keyDate];
          if (!row) return;
          const val = Number(s.value ?? s.quantity ?? s.sum ?? s.durationMinutes ?? 0);
          if (!Number.isFinite(val)) return;
          Object.assign(row, map(val));
        });
      } catch (e) {
        console.warn('health query', key, e);
      }
    }

    return summarize(series, 'apple-health', true);
  }

  function bucketValue(bucket, dataType) {
    const typed = (bucket.dataset || []).find((ds) => (ds.dataTypeName || '') === dataType);
    const pts = typed?.point || [];
    let total = 0;
    let count = 0;
    pts.forEach((p) => {
      const v = p.value?.[0];
      const n = v?.fpVal ?? v?.intVal;
      if (Number.isFinite(n)) {
        total += n;
        count += 1;
      }
    });
    return { total, count, avg: count ? total / count : 0 };
  }

  async function fromGoogleFit(days, token, fetchImpl) {
    if (!token) return null;
    const fetchFn = fetchImpl || fetch;
    const end = Date.now();
    const start = dayStart(new Date());
    start.setDate(start.getDate() - (days - 1));
    const body = {
      aggregateBy: [
        { dataTypeName: 'com.google.step_count.delta' },
        { dataTypeName: 'com.google.calories.expended' },
        { dataTypeName: 'com.google.heart_rate.bpm' },
        { dataTypeName: 'com.google.active_minutes' }
      ],
      bucketByTime: { durationMillis: 86400000 },
      startTimeMillis: start.getTime(),
      endTimeMillis: end
    };
    const res = await fetchFn('https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (res.status === 401 || res.status === 403) {
      const err = new Error('fitness_scope');
      err.status = res.status;
      throw err;
    }
    if (!res.ok) throw new Error('fitness_http_' + res.status);
    const data = await res.json();
    const series = emptySeries(days);
    const byDate = Object.create(null);
    series.forEach((r) => {
      byDate[r.date] = r;
    });

    (data.bucket || []).forEach((b) => {
      const t = Number(b.startTimeMillis || 0);
      if (!t) return;
      const keyDate = dayStart(new Date(t)).toISOString().slice(0, 10);
      const row = byDate[keyDate];
      if (!row) return;
      const steps = bucketValue(b, 'com.google.step_count.delta');
      const cals = bucketValue(b, 'com.google.calories.expended');
      const hr = bucketValue(b, 'com.google.heart_rate.bpm');
      const act = bucketValue(b, 'com.google.active_minutes');
      row.steps = Math.round(steps.total);
      row.calories = Math.round(cals.total);
      row.heartRate = Math.round(hr.avg || 0);
      row.activeMin = Math.round(act.total);
    });

    // Sleep sessions (best-effort)
    try {
      const sleepUrl = new URL('https://www.googleapis.com/fitness/v1/users/me/sessions');
      sleepUrl.searchParams.set('startTime', start.toISOString());
      sleepUrl.searchParams.set('endTime', new Date(end).toISOString());
      sleepUrl.searchParams.set('activityType', '72');
      const sRes = await fetchFn(sleepUrl, { headers: { Authorization: 'Bearer ' + token } });
      if (sRes.ok) {
        const sData = await sRes.json();
        (sData.session || []).forEach((sess) => {
          const st = Number(sess.startTimeMillis || Date.parse(sess.startTime || 0));
          const en = Number(sess.endTimeMillis || Date.parse(sess.endTime || 0));
          if (!st || !en || en <= st) return;
          const keyDate = dayStart(new Date(en)).toISOString().slice(0, 10);
          const row = byDate[keyDate];
          if (!row) return;
          row.sleepMin += Math.round((en - st) / 60000);
        });
      }
    } catch (e) {
      console.warn('fitness sleep', e);
    }

    return summarize(series, 'google-fit', true);
  }

  function hasGoogleFitnessScope(scopeStr) {
    return /fitness\.(activity|heart_rate|sleep|body)\.read/i.test(String(scopeStr || ''));
  }

  async function loadHealth({ days, token, googleScopes, demo, fetchImpl } = {}) {
    const range = days || getRangeDays();
    // Native Apple Health / Health Connect first
    try {
      const native = await fromCapacitor(range);
      if (native && native.series.some((d) => d.steps || d.sleepMin || d.calories)) {
        writeCache(native);
        return native;
      }
    } catch (e) {
      console.warn('capacitor health', e);
    }

    // Google Fit when authorized
    if (token && hasGoogleFitnessScope(googleScopes)) {
      try {
        const fit = await fromGoogleFit(range, token, fetchImpl);
        if (fit) {
          writeCache(fit);
          return fit;
        }
      } catch (e) {
        if (e?.message === 'fitness_scope' || e?.status === 403) {
          const cached = readCache();
          if (cached) return { ...cached, connected: false, needsScope: true };
          return { ...summarize(emptySeries(range), 'google-fit', false), needsScope: true };
        }
        console.warn('google fit', e);
      }
    }

    const cached = readCache();
    if (cached && Date.now() - (cached.cachedAt || 0) < 6 * 3600000 && cached.connected) {
      return { ...cached, fromCache: true };
    }

    // Preview / empty state: Apple Health–style sample metrics until a live source is linked
    if (demo || !token || !hasGoogleFitnessScope(googleScopes)) {
      const demoData = summarize(demoSeries(range), 'demo', true);
      demoData.needsConnect = !token && !capacitorHealthPlugin();
      demoData.needsScope = !!(token && !hasGoogleFitnessScope(googleScopes));
      return demoData;
    }

    return {
      ...summarize(emptySeries(range), 'none', false),
      needsConnect: true,
      needsScope: false
    };
  }

  root.DaylightHealth = {
    FITNESS_SCOPES,
    getRangeDays,
    setRangeDays,
    loadHealth,
    hasGoogleFitnessScope,
    summarize,
    demoSeries,
    readCache,
    capacitorAvailable: () => !!capacitorHealthPlugin()
  };
})(typeof window !== 'undefined' ? window : globalThis);
