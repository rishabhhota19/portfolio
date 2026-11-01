/**
 * Portfolio → Google Sheets logger: one row per visit in the "Sessions" tab.
 *
 * Setup (once):
 *   1. Create a Google Sheet. Extensions → Apps Script. Replace Code.gs with this file.
 *   2. Project Settings → Script properties → add SHARED_SECRET = <long random string>
 *      (the same value goes in Vercel as GOOGLE_SHEETS_SECRET).
 *   3. Deploy → New deployment → Web app. Execute as: Me. Who has access: Anyone.
 *      Copy the /exec URL into Vercel as GOOGLE_SHEETS_WEBHOOK_URL.
 *   4. After editing this file later: Deploy → Manage deployments → Edit → New version (same URL).
 *
 * Rows are upserted by Session ID. Empty incoming values never overwrite filled cells, so the visit beacon,
 * chat summaries and a lead submission all land in the same row. When the site has no Resend key it sends
 * notify: true with a lead, and this script emails it to your own inbox (MailApp, free).
 * Privacy: IP addresses older than 90 days are blanked automatically (checked once a day).
 */

var SHEET_NAME = 'Sessions';
var IP_RETENTION_DAYS = 90;

// [header, key in the JSON row, column width]
var COLUMNS = [
  // the visit
  ['Session ID', 'sessionId', 110],
  ['Started', 'startedAt', 130],
  ['Last seen', 'lastSeen', 130],
  ['Time on site', 'timeOnSite', 90],
  ['Pages viewed', 'pageCount', 80],
  ['Pages', 'pages', 260],
  ['Entry page', 'entryPage', 140],
  ['Exit page', 'exitPage', 140],
  ['Source', 'source', 110],
  ['Referrer', 'referrer', 140],
  ['Campaign (UTM)', 'utm', 130],
  ['Returning?', 'returning', 80],
  ['Actions', 'actions', 220],
  // where and network
  ['IP', 'ip', 120],
  ['IP hash', 'ipHash', 120],
  ['City', 'city', 110],
  ['Region', 'region', 70],
  ['Country', 'country', 60],
  ['Lat, Lon', 'location', 120],
  ['Timezone', 'timezone', 120],
  ['Network / company', 'network', 180],
  // device
  ['Device', 'device', 70],
  ['OS', 'os', 70],
  ['Browser', 'browser', 70],
  ['Screen', 'screen', 80],
  ['Language', 'language', 70],
  // the chat
  ['Chats', 'chats', 50],
  ['Messages', 'messages', 70],
  ['Tokens in', 'tokensIn', 70],
  ['Tokens out', 'tokensOut', 70],
  ['Tokens total', 'tokensTotal', 80],
  ['LLM calls', 'llmCalls', 60],
  ['Models', 'models', 180],
  ['Model switches', 'switches', 70],
  ['Avg latency (ms)', 'avgLatency', 90],
  ['Summary tokens', 'summaryTokens', 80],
  ['Intent', 'intent', 130],
  ['Topics asked', 'topics', 220],
  ['Summary', 'summary', 380],
  ['Suggested follow-up', 'followUp', 260],
  ['Chat end reason', 'chatEndReason', 110],
  // the lead (only what the visitor typed into "Share your details")
  ['Lead?', 'leadShared', 50],
  ['Name', 'visitorName', 140],
  ['Email', 'email', 190],
  ['Phone', 'phone', 120],
  ['Company', 'company', 140],
  ['Role hiring for', 'role', 160],
  ['Recruiter note', 'recruiterNote', 220],
];

var DATE_KEYS = { startedAt: true, lastSeen: true };
var WRAP_KEYS = ['pages', 'actions', 'topics', 'summary', 'followUp', 'recruiterNote'];

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var expected = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
    if (!expected || body.secret !== expected) return json_({ ok: false, error: 'unauthorized' });
    if (!body.row || !body.row.sessionId) return json_({ ok: false, error: 'missing row' });

    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      upsert_(body.row);
      blankOldIpsDaily_();
    } finally {
      lock.releaseLock();
    }
    if (body.notify) notify_(body.row);
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doGet() {
  return json_({ ok: true, service: 'portfolio-agent-logger' });
}

function col_(key) {
  for (var i = 0; i < COLUMNS.length; i++) if (COLUMNS[i][1] === key) return i;
  return -1;
}

function upsert_(row) {
  var sheet = sheet_();
  var values = COLUMNS.map(function (c) {
    var v = row[c[1]];
    if (v === undefined || v === null) return '';
    if (DATE_KEYS[c[1]] && v) return new Date(v);
    return typeof v === 'string' ? v.slice(0, 5000) : v;
  });

  var found = sheet
    .getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 1)
    .createTextFinder(String(row.sessionId))
    .matchEntireCell(true)
    .findNext();

  if (!found) {
    sheet.insertRowBefore(2); // newest visits on top
    styleRow_(sheet, 2);
    sheet.getRange(2, 1, 1, values.length).setValues([values]);
    return;
  }

  var range = sheet.getRange(found.getRow(), 1, 1, values.length);
  var current = range.getValues()[0];
  var started = col_('startedAt');
  var merged = values.map(function (v, i) {
    if (i === started && current[i] && v && current[i] < v) return current[i]; // keep the earliest start
    return v === '' ? current[i] : v;
  });
  range.setValues([merged]);
}

// Blanks IP addresses older than IP_RETENTION_DAYS (by "Last seen"). Runs at most once a day.
function blankOldIpsDaily_() {
  var props = PropertiesService.getScriptProperties();
  var today = new Date().toISOString().slice(0, 10);
  if (props.getProperty('IPS_BLANKED_ON') === today) return;
  props.setProperty('IPS_BLANKED_ON', today);

  var sheet = sheet_();
  var rows = sheet.getLastRow() - 1;
  if (rows < 1) return;
  var cutoff = new Date(Date.now() - IP_RETENTION_DAYS * 86400000);
  var seenCol = col_('lastSeen') + 1, ipCol = col_('ip') + 1;
  var seen = sheet.getRange(2, seenCol, rows, 1).getValues();
  var ips = sheet.getRange(2, ipCol, rows, 1).getValues();
  var changed = false;
  for (var i = 0; i < rows; i++) {
    if (ips[i][0] && seen[i][0] instanceof Date && seen[i][0] < cutoff) {
      ips[i][0] = '';
      changed = true;
    }
  }
  if (changed) sheet.getRange(2, ipCol, rows, 1).setValues(ips);
}

// Plain-text lead alert to the sheet owner (you). Reply goes straight to the recruiter.
function notify_(row) {
  var where = [row.city, row.country].filter(String).join(', ');
  var body = [
    'Name: ' + (row.visitorName || ''),
    'Email: ' + (row.email || ''),
    'Phone: ' + (row.phone || '-'),
    'Company: ' + (row.company || '-'),
    'Hiring for: ' + (row.role || '-'),
    'Their note: ' + (row.recruiterNote || '-'),
    '',
    'Chat summary: ' + (row.summary || '-'),
    'Suggested follow-up: ' + (row.followUp || '-'),
    '',
    'From: ' + (where || '-') + (row.network ? ' (' + row.network + ')' : ''),
    'Sheet: ' + SpreadsheetApp.getActiveSpreadsheet().getUrl(),
  ].join('\n');
  var mail = {
    to: Session.getEffectiveUser().getEmail(),
    subject: 'New recruiter lead: ' + (row.visitorName || 'someone') + (row.company ? ' (' + row.company + ')' : ''),
    body: body,
  };
  if (row.email) mail.replyTo = row.email;
  MailApp.sendEmail(mail);
}

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (sheet) return sheet;

  sheet = ss.insertSheet(SHEET_NAME, 0);
  sheet.getRange(1, 1, 1, COLUMNS.length)
    .setValues([COLUMNS.map(function (c) { return c[0]; })])
    .setFontWeight('bold')
    .setBackground('#15140f')
    .setFontColor('#f4f1ea');
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);
  COLUMNS.forEach(function (c, i) {
    sheet.setColumnWidth(i + 1, c[2]);
  });
  return sheet;
}

// A new row sits under the header and would copy its dark style, so set its look explicitly.
function styleRow_(sheet, r) {
  sheet.getRange(r, 1, 1, COLUMNS.length)
    .setFontWeight('normal')
    .setBackground(null)
    .setFontColor(null)
    .setWrap(false)
    .setVerticalAlignment('top');
  Object.keys(DATE_KEYS).forEach(function (key) {
    sheet.getRange(r, col_(key) + 1).setNumberFormat('dd mmm yyyy, hh:mm');
  });
  WRAP_KEYS.forEach(function (key) {
    sheet.getRange(r, col_(key) + 1).setWrap(true);
  });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
