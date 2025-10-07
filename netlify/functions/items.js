// Replace the helper with this version:
function deriveWorkComp(minWage, details){
  if (!minWage) return null;

  // Default assumption if details are not available:
  let hrs = 12, wks = 32;

  // If details exist, try to parse "<H> hours/week ... <W> weeks"
  if (details) {
    const m = String(details).match(/(\d+)\s*hours?\s*\/?\s*week.*?(\d+)\s*weeks?/i);
    if (m) {
      const ph = parseInt(m[1], 10); if (ph) hrs = ph;
      const pw = parseInt(m[2], 10); if (pw) wks = pw;
    }
  }
  return minWage * hrs * wks;
}

// …and in your enrichment loop, keep this shape but ensure it uses the fallback:
let wc = getNumCV(cols, FORM_COL.workComp);
if (wc == null){
  const minW = getNumCV(cols, FORM_COL.minWage);
  const det  = findCV(cols, FORM_COL.workDetail)?.text || '';
  const derived = deriveWorkComp(minW, det);
  if (derived != null) wc = derived;
}
if (wc != null) setTextCV(row, FORM_COL.workComp, r0(wc));
