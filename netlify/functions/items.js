// netlify/functions/items.js
// Computes backend fields for total cost, 3 net cost variants, # live on campus, and work compensation.
// Includes: warm-instance cache, progressive paging support, and resilient timeouts.

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
  // Use a smaller default client limit to reduce page size and ease load on the Monday API.
  const clientLimit = clampInt(p.limit, 10, 1, 200);
  let cursor = p.cursor || null;

  // return at least this many items for first (non-progressive) call
  const DEFAULT_MIN_FIRST = 20;
  const minFirst   = clampInt(p.min ?? DEFAULT_MIN_FIRST, DEFAULT_MIN_FIRST, 0, 200);
  const maxPages   = clampInt(p.maxPages, 4, 1, 8);
  const progressive = String(p.progressive || '').toLowerCase() === 'true';

  // ---------- Fast path via warm cache for the first screen (no cursor) ----------
  const cacheKey = JSON.stringify({ board: BOARD_ID, limit: clientLimit, min: minFirst, progressive });
  if (!cursor) {
    const now = Date.now();
    if (FIRST_PAGE_CACHE.payload && FIRST_PAGE_CACHE.key === cacheKey && (now - FIRST_PAGE_CACHE.ts) < CACHE_TTL_MS) {
      return json(FIRST_PAGE_CACHE.payload);
    }
  }

  // Wider budget + slightly looser per-call window (prevents spurious aborts)
  const startTs = Date.now();
  // Increase the overall time budget to give the Monday API more time to respond.
  const timeBudgetMs = 15000; // 15s budget for slower pages
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

  // Shareable gate
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

        // === Additional computed fields ===
        // Compute numeric ranking from the U.S. News ranking column (long_text).
        const rankNum = gvNum(cols, 'long_text');

        // Compute live percentage as a whole number (0-100) where available.
        let livePctCalc = null;
        if (isFiniteNum(pctLive)) {
          // pctLive is in range 0..1; multiply to get percentage.
          livePctCalc = Math.round(pctLive * 100);
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
          work_comp_calc: workComp,

          // New computed fields for front-end sorting/filtering
          rank_num_calc: isFiniteNum(rankNum) ? rankNum : null,
          live_pct_calc: livePctCalc
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

      // Progressive mode: caller wants exactly one page quickly.
      if (progressive) break;

      // Non-progressive: stop once we have enough for the first screen.
      if (acc.length >= minFirst) break;

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
  // Try with descending page sizes; retry quickly on transient network/abort
  // Start with the client limit but clamp to a smaller default and progressively decrease the page size to avoid timeouts.
  const ladder = [clampInt(clientLimit, 10, 5, 50), 10, 8, 5, 3];
  let attempt = 0, lastErr = null;

  for (const lim of ladder){
    for (let inner = 0; inner < 2 && attempt < 4; inner++, attempt++){
      try {
        // Looser per-call cap than before (prevents “operation aborted” on slow pages)
        // Increase per-call timeouts to give Monday more time to respond.
        const perCall = Math.max(4000, Math.min(10000, Math.floor((remainingBudgetMs || 10000) * 0.8)));
        return await gqlWithTimeout(query, { boardId, limit: lim, cursor: cursor || null }, perCall);
      } catch (e){
        lastErr = e;
        // Only retry on abort/network/50x; bubble up other errors
        if (!/aborted|AbortError|operation was aborted|network|Failed to fetch|HTTP 50[234]/i.test(String(e && e.message || e))) throw e;
        await sleep(150);
        if ((remainingBudgetMs || 0) < 900) break;
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
      // Explicitly set a stable API version header. By specifying 2025-04 we opt in to the
      // April 2025 version of the monday API. This version still supports the items_page
      // query but is marked as maintenance, which ensures backward compatibility for at
      // least six months. Adjust this value as future versions are released.
      headers: {
        'Content-Type': 'application/json',
        'Authorization' : token,
        'API-Version'  : '2025-04'
      },
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
