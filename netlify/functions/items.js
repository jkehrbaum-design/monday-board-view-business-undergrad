// netlify/functions/items.js
// Computes backend fields for total cost, 3 net cost variants, # live on campus, and work compensation.
// Includes: warm-instance cache, progressive paging support, resilient timeouts, CORS, and 429 backoff.

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
  // ----- CORS preflight -----
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: 'OK',
    };
  }

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
  const clientLimit = clampInt(p.limit, 12, 5, 50); // reduced default limit for faster responses
  let cursor = p.cursor || null;

  const DEFAULT_MIN_FIRST = 15;
  const minFirst   = clampInt(p.min ?? DEFAULT_MIN_FIRST, DEFAULT_MIN_FIRST, 0, 200);
  const maxPages   = clampInt(p.maxPages, 3, 1, 5);
  const progressive = String(p.progressive || '').toLowerCase() === 'true';

  const cacheKey = JSON.stringify({ board: BOARD_ID, limit: clientLimit, min: minFirst, progressive });
  if (!cursor) {
    const now = Date.now();
    if (FIRST_PAGE_CACHE.payload && FIRST_PAGE_CACHE.key === cacheKey && (now - FIRST_PAGE_CACHE.ts) < CACHE_TTL_MS) {
      return json(FIRST_PAGE_CACHE.payload);
    }
  }

  const startTs = Date.now();
  const timeBudgetMs = 25000; // within Netlify 30s ceiling
  const timeLeft = () => Math.max(0, timeBudgetMs - (Date.now() - startTs));

  const query = `
    query($boardId: [ID!], $limit: Int, $cursor: String){
      boards(ids: $boardId){
        items_page(limit: $limit, cursor: $cursor){
          cursor
          items {
            id
            name
            column_values {
              id
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

        // Costs
        const tuition = gvNum(cols, 'annual_tuition_cost');
        const room    = gvNum(cols, '_usd__annual_room_cost');
        const board   = gvNum(cols, '_usd__annual_board_cost');
        const fees    = gvNum(cols, 'numbers5');
        const total   = safeSum([tuition, room, board, fees]);

        // Scholarships
        const schLow = gvNum(cols, 'dup__of_minimum__usd__annual_scholarship_amount6');
        const schMid = gvNum(cols, 'numbers68');
        const schHi  = gvNum(cols, 'numbers11');

        // Nets
        const netLow = clampZero(total - safeNum(schHi));  // lowest net = highest scholarship
        const netMid = clampZero(total - safeNum(schMid));
        const netHi  = clampZero(total - safeNum(schLow)); // highest net = lowest scholarship

        // Live on campus
        const enroll = gvNum(cols, 'numbers7');
        let pctLive  = gvNum(cols, 'numbers8'); // this is stored as percent (e.g., 67) in your data
        let livePctCalc = null;
        if (isFiniteNum(pctLive)) {
          if (pctLive > 1) pctLive = pctLive / 100;
          pctLive = Math.min(Math.max(pctLive, 0), 1);
          livePctCalc = Math.round(pctLive * 100); // keep a pct for the UI if needed
        }
        const liveOnCampus = (isFiniteNum(enroll) && pctLive != null)
          ? Math.ceil(enroll * pctLive)
          : null;

        // Campus employment + min wage (ids fixed to your dataset)
        const campusEmploymentText = (gv(cols, 'status_113') || '').toLowerCase(); // 'Yes' / 'Limited' etc.
        const minWage   = gvNum(cols, 'numbers985'); // 2025 Min Wage
        let workComp = 0;
        if ((/yes|limited|shareable|true/.test(campusEmploymentText)) && isFiniteNum(minWage)) {
          // conservative default: 10 hrs/week * 32 weeks
          workComp = minWage * 10 * 32;
        }

        // Rank (if you later store numeric rank elsewhere, map here)
        const rankNum = numFromText(gv(cols, 'rank_num_calc')) || null;

        // Return with the keys your HTML expects to see as backend-calculated fields
        return {
          id: it.id,
          name: it.name,

          // Calculated fields for the table (match colIds in HTML)
          total_calc: total,
          net_low_calc: netLow,
          net_mid_calc: netMid,
          net_hi_calc:  netHi,
          formula5: liveOnCampus,      // "# Live on Campus" in your HTML
          work_comp_calc: workComp,    // annual on-campus comp (est.)
          rank_num_calc: rankNum,
          live_pct_calc: livePctCalc,  // optional helper if needed by UI

          // Keep raw column_values for any fields the client wants to read directly
          column_values: cols,
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
      if (acc.length >= minFirst) break;
      if (!nextCursor || pagesFetched >= maxPages) break;
    } while (timeLeft() > 0);
  } catch (e) {
    const msg = errorMessage(e);
    const looksExpired = /CursorExpiredError|cursor has expired/i.test(msg);
    console.error('Monday API failure:', msg);
    if (!looksExpired) return json({ error: 'Upstream Monday error', detail: msg }, 502);
    nextCursor = null;
  }

  const responsePayload = { cursor: nextCursor, totalLoaded: acc.length, items: acc, ms: Date.now() - startTs };
  if (!cursor) { FIRST_PAGE_CACHE = { key: cacheKey, ts: Date.now(), payload: responsePayload }; }
  return json(responsePayload);
};

async function fetchPageResilient(query, { boardId, cursor, clientLimit }, remainingBudgetMs){
  const ladder = [clampInt(clientLimit, 10, 5, 40), 8, 5, 3];
  let attempt = 0, lastErr = null;

  for (const lim of ladder){
    for (let inner = 0; inner < 2 && attempt < 6; inner++, attempt++){
      try {
        const perCall = Math.max(3000, Math.min(8000, Math.floor((remainingBudgetMs || 8000) * 0.8)));
        return await gqlWithTimeout(query, { boardId, limit: lim, cursor: cursor || null }, perCall);
      } catch (e){
        lastErr = e;
        const msg = String(e && e.message || e);

        // 429 backoff
        if (/HTTP 429/.test(msg)) {
          await sleep(1000 + Math.floor(Math.random()*400));
          continue;
        }

        // retry transient faults
        if (/aborted|AbortError|operation was aborted|network|Failed to fetch|HTTP 50[234]/i.test(msg)) {
          await sleep(150);
          if ((remainingBudgetMs || 0) < 700) break;
          continue;
        }

        // non-transient -> bubble
        throw e;
      }
    }
  }
  throw lastErr || new Error('Operation aborted');
}

async function gqlWithTimeout(query, variables, timeoutMs){
  const token = getEnv('MONDAY_API_TOKEN', '');
  const apiVersion = getEnv('MONDAY_API_VERSION', '2025-04'); // configurable
  const controller = new AbortController();
  const t = setTimeout(()=>controller.abort(), Math.max(500, timeoutMs || 7000));
  try{
    const r = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization' : token,
        'API-Version'  : apiVersion,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal
    });

    // Surface status-specific errors (incl. 429)
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try {
        const jerr = await r.json();
        if (jerr && Array.isArray(jerr.errors)) {
          msg += ': ' + jerr.errors.map(e => e && e.message ? e.message : String(e)).join('; ');
        }
      } catch (_) {}
      throw new Error(msg);
    }

    const j = await r.json().catch(()=>({}));
    if (j && j.errors && Array.isArray(j.errors)) {
      const messages = j.errors.map(e => e && e.message ? e.message : String(e)).join('; ');
      throw new Error(`Monday API error: ${messages}`);
    }
    return j.data;
  } finally { clearTimeout(t); }
}

function corsHeaders() {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, s-maxage=300',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization',
  };
}
function json(obj, status = 200){
  return { statusCode: status, headers: corsHeaders(), body: JSON.stringify(obj) };
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
