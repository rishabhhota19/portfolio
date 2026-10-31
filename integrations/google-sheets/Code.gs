/**
 * Portfolio agent → Google Sheets logger.
 *
 * Setup (once):
 *   1. Create a Google Sheet. Extensions → Apps Script. Replace Code.gs with this file.
 *   2. Project Settings → Script properties → add SHARED_SECRET = <long random string>
 *      (the same value goes in Vercel as GOOGLE_SHEETS_SECRET).
 *   3. Deploy → New deployment → Web app. Execute as: Me. Who has access: Anyone.
 *      Copy the /exec URL into Vercel as GOOGLE_SHEETS_WEBHOOK_URL.
 *   4. After editing this file later: Deploy → Manage deployments → Edit → New version.
 *
 * One row per conversation, upserted by Conversation ID. Empty incoming values never
 * overwrite existing ones, so a lead's details survive a later end-of-chat summary.
 */

var SHEET_NAME = 'Conversations';

// [header, key in the JSON row, column width]
var COLUMNS = [
  ['Conversation ID', 'conversationId', 120],
  ['Started', 'startedAt', 140],
  ['Ended', 'endedAt', 140],
  ['End reason', 'endReason', 110],
  ['Messages', 'messages', 80],
  ['Lead?', 'leadShared', 60],
  ['Name', 'visitorName', 140],
  ['Email', 'email', 190],
  ['Company', 'company', 140],
  ['Role hiring for', 'role', 160],
  ['Intent', 'intent', 130],
  ['Topics asked', 'topics', 220],
  ['Summary', 'summary', 380],
  ['Suggested follow-up', 'followUp', 260],
  ['Recruiter note', 'recruiterNote', 220],
  ['Country', 'country', 70],
  ['City', 'city', 110],
  ['Device', 'device', 130],
  ['Entry page', 'entryPage', 160],
  ['Model', 'model', 160],
];

var DATE_KEYS = { startedAt: true, endedAt: true };

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var expected = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
    if (!expected || body.secret !== expected) return json_({ ok: false, error: 'unauthorized' });
    if (!body.row || !body.row.conversationId) return json_({ ok: false, error: 'missing row' });

    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      upsert_(body.row);
    } finally {
      lock.releaseLock();
    }
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doGet() {
  return json_({ ok: true, service: 'portfolio-agent-logger' });
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
    .createTextFinder(String(row.conversationId))
    .matchEntireCell(true)
    .findNext();

  if (!found) {
    sheet.insertRowBefore(2); // newest conversations on top
    sheet.getRange(2, 1, 1, values.length).setValues([values]);
    return;
  }

  var range = sheet.getRange(found.getRow(), 1, 1, values.length);
  var current = range.getValues()[0];
  var merged = values.map(function (v, i) {
    if (COLUMNS[i][1] === 'startedAt' && current[i]) return current[i]; // keep the first start time
    return v === '' ? current[i] : v;
  });
  range.setValues([merged]);
}

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (sheet) return sheet;

  sheet = ss.insertSheet(SHEET_NAME);
  sheet.getRange(1, 1, 1, COLUMNS.length)
    .setValues([COLUMNS.map(function (c) { return c[0]; })])
    .setFontWeight('bold')
    .setBackground('#15140f')
    .setFontColor('#f4f1ea');
  sheet.setFrozenRows(1);
  COLUMNS.forEach(function (c, i) {
    sheet.setColumnWidth(i + 1, c[2]);
  });
  sheet.getRange('B:C').setNumberFormat('dd mmm yyyy, hh:mm');
  sheet.getRange('K:O').setWrap(true);
  sheet.getRange('A2:T').setVerticalAlignment('top');
  return sheet;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
