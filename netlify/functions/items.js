<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Bachelor’s Programs – Freshman Student (Mirror)</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      --bg:#fafafa; --border:#e6e9ef; --text:#2a2e34; --muted:#667085; --primary:#1f76f0;
      --row-h:36px; --shadow:0 1px 2px rgba(16,24,40,.06);
    }
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
    header{position:sticky;top:0;z-index:30;background:#fff;border-bottom:1px solid var(--border);padding:10px 16px;box-shadow:var(--shadow)}
    h1{margin:0 0 6px 0;font-size:18px;font-weight:600}
    .controls{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
    .control{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
    input[type="text"],input[type="number"],button{height:32px;padding:0 10px;border:1px solid var(--border);border-radius:8px;background:#fff;color:var(--text)}
    button{cursor:pointer} button.primary{border-color:var(--primary);background:var(--primary);color:#fff}
    .multiselect{position:relative}
    .multiselect button{min-width:220px;display:inline-flex;align-items:center;justify-content:space-between}
    .dropdown{position:absolute;top:36px;left:0;z-index:40;background:#fff;width:320px;max-height:300px;overflow:auto;border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);display:none}
    .dropdown.open{display:block}
    .dropdown .searchbox{padding:8px;border-bottom:1px solid var(--border)}
    .option{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid #f3f4f6}
    .opt-actions{display:flex;justify-content:space-between;gap:8px;padding:8px;border-top:1px solid var(--border)}
    .col-chooser{position:relative}
    .col-panel{position:absolute;top:36px;right:0;width:360px;max-height:380px;overflow:auto;background:#fff;border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);padding:8px;display:none;z-index:40}
    .col-panel.open{display:block} .col-item{display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid #f3f4f6;font-size:13px}
    .grid-wrap{padding:12px 16px}
    .grid{border:1px solid var(--border);border-radius:12px;background:#fff;overflow:hidden}
    .grid-head{position:sticky;top:58px;z-index:20;background:#f7f9fc;border-bottom:1px solid var(--border);font-weight:600;color:#3b4351;display:grid;align-items:center;min-height:36px}
    .grid-body{position:relative;height:calc(100vh - 210px);overflow:auto}
    .row{position:absolute;left:0;right:0;display:grid;align-items:center;height:var(--row-h);border-bottom:1px solid #f6f7fb}
    .cell{padding:0 10px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:13px}
    .row:hover{background:#f9fbff} .stripe{background:#fcfcfd} .muted{color:var(--muted)}
    .status{margin:8px 16px;font-size:13px;color:var(--muted)}
    .spinner{display:inline-block;width:12px;height:12px;border:2px solid #cfd4dc;border-top-color:var(--primary);border-radius:50%;animation:spin .9s linear infinite;vertical-align:-2px}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style>
</head>
<body>
  <header>
    <h1>Bachelor’s Programs – Freshman Student (Read-only Mirror)</h1>
    <div class="controls">
      <div class="control"><input id="search" type="text" placeholder="Search by name or any cell…" /></div>

      <!-- Multi-select: State -->
      <div class="control multiselect" id="ms-state">
        <button type="button">State ▾</button>
        <div class="dropdown">
          <div class="searchbox"><input type="text" placeholder="Filter states…" /></div>
          <div class="options"></div>
          <div class="opt-actions">
            <button type="button" data-action="clear">Clear</button>
            <button type="button" data-action="apply" class="primary">Apply</button>
          </div>
        </div>
      </div>

      <!-- Multi-select: Major -->
      <div class="control multiselect" id="ms-major">
        <button type="button">Major ▾</button>
        <div class="dropdown">
          <div class="searchbox"><input type="text" placeholder="Filter majors…" /></div>
          <div class="options"></div>
          <div class="opt-actions">
            <button type="button" data-action="clear">Clear</button>
            <button type="button" data-action="apply" class="primary">Apply</button>
          </div>
        </div>
      </div>

      <!-- Numeric filters -->
      <div class="control">Ranking ≤ <input id="f-ranking-max" type="number" placeholder="e.g. 300" /></div>
      <div class="control">Final Cost ≤ <input id="f-cost-max" type="number" placeholder="USD" /></div>
      <div class="control">Min GPA ≥ <input id="f-gpa-min" type="number" step="0.1" placeholder="e.g. 3.0" /></div>

      <!-- Column chooser -->
      <div class="control col-chooser">
        <button id="btn-cols" type="button">Columns ▾</button>
        <div class="col-panel" id="col-panel"></div>
      </div>

      <div class="control"><button id="btn-reset" type="button">Reset filters</button></div>
    </div>
  </header>

  <div class="status" id="status"><span class="spinner"></span> Loading…</div>

  <div class="grid-wrap">
    <div class="grid">
      <div class="grid-head" id="grid-head"></div>
      <div class="grid-body" id="grid-body">
        <div id="spacer" style="height:0px;"></div>
      </div>
    </div>
    <div class="muted" style="margin-top:8px">
      Showing <span id="count-shown">0</span> of <span id="count-total">0</span> rows
    </div>
  </div>

  <script>
    // --- CONFIG: endpoint & board ---
    const BOARD_ID = '2761790925';
    const ENDPOINT = '/.netlify/functions/items';
    const PAGE_LIMIT_PER_CALL = 1;           // pro Call genau 1 Seite (sicher <10s)
    const FETCH_TIMEOUT_MS = 9000;           // unter 10s, damit 504 vermied
