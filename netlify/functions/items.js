// netlify/functions/items.js
// Computes backend fields for total cost, 3 net cost variants, # live on campus, and work compensation.
// Includes: warm-instance cache, quicker first screen, tighter timeouts.

function getEnv(name, fallback = '') {
  try {
    if (typeof process !== 'undefined' && process.env && name in process.env) return process.env[name] || fallback;
  } catch (_) {}
  try {
    if (globalThis && globalThis.Deno && globalThis.Deno.env && typeof globalThis.Deno.env.get === 'function') {
      const v = globalThis.Deno.env.get(name);
      if (v != null) return v;
    }
  } catch (_) {}
  return fallback;
}

// ---------- Warm-instance micro cache (persists while the function is warm) ----------
let FIRST_PAGE_CACHE = { key: null, ts: 0, payload: null };
const CACHE_TTL_MS = 60 * 1000; // 60s

export const handler = async (event) => {
  const TOKEN    = getEnv('MONDAY_API_TOKEN', '');
  const BOARD_ID = getEnv('MONDAY_BOARD_ID', '2738090584');

  if (event.queryStringParameters?.debug === 'env') {
    return json({ hasToken: !!TOKEN, boardId: BOARD_ID, runtime: runtimeInfo() });
  }
  if (!TOKEN) {
    return json({
      error: 'Missing environment variables',
      detail: 'Set MONDAY_API_TOKEN (and optionally MONDAY_BOARD_ID) in Netlify → Site settings → Build & deploy → Environment.',
      runtime: runtimeInfo()
    }, 500);
  }

  const p = event.queryStringParameters || {};
  const clientLimit = clampInt(p.limit, 25, 1, 200);
  let cursor = p.cursor || null;

  const DEFAULT_MIN_FIRST = 20;
  const minFirst = clampInt(p.min ?? DEFAULT_MIN_FIRST, DEFAULT_MIN_FIRST, 0, 200);
  const maxPages = clampInt(p.maxPages, 4, 1, 8);
  const progressive = String(p.progressive || '').toLowerCase() === 'true';

  // ---------- Fast path via warm cache for the first screen (no cursor) ----------
  const cacheKey = JSON.stringify({
    board: BOARD_ID,
    limit: clientLimit,
    min: minFirst,
    progressive
  });
  if (!cursor) {
    const now = Date.now();
    if (FIRST_PAGE_CACHE.payload && FIRST_PAGE_CACHE.key === cacheKey && (now - FIRST_PAGE_CACHE.ts) < CACHE_TTL_MS) {
      return json(FIRST_PAGE_CACHE.payload);
    }
  }

  const startTs = Date.now();
  const timeBudgetMs = 5000; // quicker first response (was 8000)
  const timeLeft = () => Math.max(0, timeBudgetMs - (Date.now() - startTs));

  // Monday query
  const query = `
    query($boardId: [ID!], $limit: Int, $cursor: String){
      boards(ids: $boardId){
        items_page (limit: $limit, cursor: $cursor){
          cursor
          items {
            id
            name
            column_values {
              id
              type
              text
              value
            }
          }
        }
      }
    }`;

  const gv    = (cols, id) => (cols.find(c => c.id === id)?.text || '').trim();
  const gvNum = (cols, id) => numFromText(gv(cols, id));

  const SHAREABLE_COL_ID = 'dup__of_sharable___bachelor_s___freshman___average_';
  const isShareable = (cols) => {
    const c = cols.find(x => x.id === SHAREABLE_COL_ID);
    if (!c) return false;
    if ((c.text || '').toLowerCase() === 'shareable') return true;
    try {
      const v = c.value && JSON.parse(c.value);
      if (v && (v.index === 1 || v.index === "1")) return true;
    } catch {}
    return false;
  };

  const acc = [];
  function process(items){
    const prepped = (items || [])
      .filter(it => isShareable(it.column_values || []))
      .map(it => {
        const cols = it.column_values || [];

        // === TOTAL (Tuition + Room + Board + Fees) ===
        const tuition = gvNum(cols, 'annual_tuition_cost');
        const room    = gvNum(cols, '_usd__annual_room_cost');
        const board   = gvNum(cols, '_usd__annual_board_cost');
        const fees    = gvNum(cols, 'numbers5');
        const total = safeSum([tuition, room, board, fees]);

        // === Scholarship amounts ===
        const schLow = gvNum(cols, 'dup__of_minimum__usd__annual_scholarship_amount6'); // Lowest
        const schMid = gvNum(cols, 'numbers68');                                        // Mid
        const schHi  = gvNum(cols, 'numbers11');                                        // Highest

        // === Net costs ===
        const netLow = clampZero(total - safeNum(schHi));
        const netMid = clampZero(total - safeNum(schMid));
        const netHi  = clampZero(total - safeNum(schLow));

        // === Live on Campus (#) ===
        const enroll = gvNum(cols, 'numbers7');
        let pctLive  = gvNum(cols, 'numbers8');
        if (isFiniteNum(pctLive)) {
          if (pctLive > 1) pctLive = pctLive / 100;
          pctLive = Math.min(Math.max(pctLive, 0), 1);
        } else pctLive = null;
        const liveOnCampus = (isFiniteNum(enroll) && isFiniteNum(pctLive))
          ? Math.ceil(enroll * pctLive)
          : null;

        // === Work on Campus Compensation ===
        const campusOpp = (gv(cols, 'bachelor_s___campus_employment_opportunities_') || '').toLowerCase();
        const minWage   = gvNum(cols, 'numbers70'); // 2025 Minimum Wage column
        let workComp = 0;
        if (campusOpp === 'yes' && isFiniteNum(minWage)) {
          workComp = minWage * 20 * 32; // weekly hours * weeks
        }

        return {
          id: it.id,
          name: it.name,
          state: gv(cols, 'state1'),
          totalCost: total,
          minGpa: gvNum(cols, 'numbers34'),
          column_values: cols,

          // Exposed computed fields
          total_calc: total,
          net_low_calc: netLow,
          net_mid_calc: netMid,
          net_hi_calc: netHi,
          formula5: liveOnCampus,
          work_comp_calc: workComp
        };
      });

    for (const row of prepped) acc.push(row);
  }

  async function getOnePage(curCursor){
    if (timeLeft() <= 0) return null;
    const data = await fetchPageResilient(query, { boardId: BOARD_ID, cursor: curCursor, clientLimit }, timeLeft());
    const page  = data?.boards?.[0]?.items_page || {};
    const items = Array.isArray(page.items) ? page.items : [];
    process(items);
    return page.cursor || null;
  }

  let nextCursor = cursor;
  let pagesFetched = 0;

  try {
    do {
      nextCursor = await getOnePage(nextCursor);
      pagesFetched++;
      if (progressive) break;

      // Hard cap first-screen work so we return quickly even if minFirst is large
      const FIRST_SCREEN_CAP = 20;
      if (acc.length >= Math.min(minFirst, FIRST_SCREEN_CAP)) break;

      if (!nextCursor) break;
      if (pagesFetched >= maxPages) break;
    } while (timeLeft() > 0);
  } catch (e) {
    const msg = errorMessage(e);
    const looksExpired = /CursorExpiredError|cursor has expired/i.test(msg);
    if (!looksExpired) return json({ error: 'Upstream Monday error', detail: msg }, 502);
    nextCursor = null;
  }

  const responsePayload = { cursor: nextCursor, totalLoaded: acc.length, items: acc };
  if (!cursor) { FIRST_PAGE_CACHE = { key: cacheKey, ts: Date.now(), payload: responsePayload }; }
  return json(responsePayload);
};

// ---------- Helpers ----------
async function fetchPageResilient(query, { boardId, cursor, clientLimit }, remainingBudgetMs){
  const ladder = [clampInt(clientLimit, 25, 10, 50), 25, 20, 15, 10];
  let attempt = 0, lastErr = null;

  for (const lim of ladder){
    for (let inner = 0; inner < 1 && attempt < 3; inner++, attempt++){
      try {
        // Tighter per-call timeouts: fail slow calls sooner to keep the UX snappy
        const perCall = Math.max(1800, Math.min(4000, Math.floor((remainingBudgetMs || 6000) * 0.6)));
        return await gqlWithTimeout(query, { boardId, limit: lim, cursor: cursor || null }, perCall);
      } catch (e){
        lastErr = e;
        if (!/aborted|AbortError|operation was aborted|network|Failed to fetch|HTTP 50[234]/i.test(e.message)) throw e;
        await sleep(150);
        if ((remainingBudgetMs || 0) < 800) break;
      }
    }
  }
  throw lastErr || new Error('This operation was aborted');
}

async function gqlWithTimeout(query, variables, timeoutMs){
  const token = getEnv('MONDAY_API_TOKEN', '');
  const controller = new AbortController();
  const t = setTimeout(()=>controller.abort(), Math.max(1000, timeoutMs || 6000));
  try{
    const r = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization': token },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal
    });
    const j = await r.json().catch(()=>({}));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (j && j.errors) throw new Error(JSON.stringify(j.errors));
    return j.data;
  } finally { clearTimeout(t); }
}

function json(obj, status = 200){
  return { statusCode: status, headers: { 'content-type':'application/json; charset=utf-8' }, body: JSON.stringify(obj) };
}
function sleep(ms){ return new Promise(res=>setTimeout(res, ms)); }
function clampInt(v, def, min, max){ const n = parseInt(v,10); if(isNaN(n))return def; return Math.max(min,Math.min(max,n)); }
function numFromText(t){ if(!t)return NaN; const n = +(`${t}`.replace(/[, $€£%]/g,'')); return isNaN(n)?NaN:n; }
function safeNum(n){ return isFiniteNum(n)?n:0; }
function safeSum(arr){ return arr.reduce((s,v)=>s+safeNum(v),0); }
function clampZero(n){ return isFiniteNum(n)?Math.max(0,n):null; }
function isFiniteNum(n){ return typeof n==='number'&&isFinite(n); }
function errorMessage(e){ if(!e)return'Unknown error'; if(typeof e==='string')return e; if(e.message)return e.message; try{return JSON.stringify(e);}catch{return String(e);} }
function runtimeInfo(){ const isEdge=!!(globalThis&&globalThis.Deno); return{runtime:isEdge?'edge (Deno)':'lambda (Node)',nodeVersion:typeof process!=='undefined'&&process.version?process.version:null}; }
