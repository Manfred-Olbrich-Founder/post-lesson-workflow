/**
 * LESSON SUMMARY AUTOMATION
 * Built and run by Manfred Olbrich for his private maths tutoring practice.
 * Runs every 10 minutes from a time trigger in the tutor's Google Workspace account.
 *
 * For each new Meet transcript in Meet Recordings (subfolders included):
 *   1. Works out the student from the transcript's Attendees line + meeting title
 *   2. Reads the STUDENT PROFILE, the template and the previous lesson summary
 *   3. Asks Gemini for the filled template + the content of a parent/student email
 *   4. Creates "Lesson Summary _ Course _ Student _ DD.MM.YYYY" as a Google Doc
 *   5. Moves summary, transcript, recording and chat into
 *      Students/Name/YYYY/N. Month YYYY/DD.MM.YYYY
 *   6. Adds a tracker row, then makes a formatted Gmail draft to the student (cc parent) with
 *      the whiteboard link and any whiteboard PDF found in the lesson folder attached
 *   7. Emails the tutor a confirmation and marks the Meet email as read
 *
 * Lessons with a transcript but no video (transcribed, not recorded) are processed after
 * WAIT_FOR_RECORDING_HOURS — or straight away with processNowWithoutVideo. If a video does turn up
 * later, it is moved into the lesson folder and you get an email with its link.
 *
 * Useful functions to run by hand:
 *   testGemini              – checks the API key
 *   testFindLessons         – dry run, changes nothing
 *   processNowWithoutVideo  – processes finished transcripts now, without waiting for a video
 *   testEmailDraft          – makes ONLY a new email draft for a lesson already processed
 *   setupWhiteboards        – creates the "Whiteboards" drop folder and logs its link
 *
 * Whiteboard PDFs: save them into the "Whiteboards" folder with any name that includes the student
 * (e.g. "Alex 04.10.2026.pdf") — they are filed into the right lesson folder and attached automatically.
 *   installTrigger / removeTrigger
 */

// ───────────────────────── CONFIG ─────────────────────────
const CONFIG = {
  SOURCE_FOLDER_ID:   'YOUR_MEET_RECORDINGS_FOLDER_ID',               // Meet Recordings
  STUDENTS_FOLDER_ID: 'YOUR_STUDENTS_FOLDER_ID',                      // Students
  TEMPLATE_DOC_ID:    'YOUR_SUMMARY_TEMPLATE_DOC_ID',                // LESSON SUMMARY TEMPLATE
  TRACKER_SHEET_ID:   'YOUR_TRACKER_SHEET_ID',
  ADMIN_EMAIL:        'you@example.com',
  GEMINI_MODEL:       'gemini-3.8-flash',
  TIMEZONE:           'Europe/London',

  // true  → Students/Name/2026/2. October 2026/01.10.2026
  // false → Students/Name/2026/01.10.2026
  USE_MONTH_FOLDERS: true,

  // The transcript usually arrives about an hour before the video. Wait this long for the video;
  // after that the lesson is processed without it (a video that arrives later is still filed).
  WAIT_FOR_RECORDING_HOURS: 2,

  MAX_LESSONS_PER_RUN: 3,

  // PDFs bigger than this are linked in the email instead of attached
  MAX_ATTACHMENT_MB: 20,

  // Put links to the lesson recording / transcript in the email. They are shared (view only) with the
  // To and Cc people of the email you actually send — never before you send, never "anyone with the link".
  SHARE_RECORDING:  true,
  SHARE_TRANSCRIPT: true,

  // Drop folder for whiteboard PDFs (created automatically next to your Students folder)
  WHITEBOARD_INBOX_NAME: 'Whiteboards',

  // Students are found automatically: every folder inside Students is a student, matched by the
  // words in its folder name plus the "Preferred name:" in its STUDENT PROFILE.
  // Only add something here if a student joins Meet under a name that matches neither, e.g.
  //   EXTRA_ALIASES: { 'Alex Example': ['jordan'] },
  EXTRA_ALIASES: {},
};

const MONTHS = ['January','February','March','April','May','June','July',
                'August','September','October','November','December'];

// Set to true by processNowWithoutVideo for one run only
let FORCE_NO_RECORDING_ = false;

// ───────────────────────── ENTRY POINTS ─────────────────────────

/** Main job — the trigger runs this. */
function processNewLessons() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { console.log('Another run is in progress — try again in a minute.'); return; }
  try {
    try { shareFilesFromSentEmails_(); } catch (e) { console.warn('Sharing step skipped: ' + e.message); }
    try { learnFromSentEmails_(); } catch (e) { console.warn('Learning step skipped: ' + e.message); }
    try { sweepWhiteboardInbox_(); } catch (e) { console.warn('Whiteboard sweep skipped: ' + e.message); }
    try { fileLateRecordings_(); } catch (e) { console.warn('Late recording sweep skipped: ' + e.message); }
    let done = 0;
    for (const lesson of findPendingLessons_()) {
      if (done >= CONFIG.MAX_LESSONS_PER_RUN) break;
      if (!lesson.ready) continue;
      try {
        processLesson_(lesson);
        markDone_(lesson.transcript.getId());
        try {
          const st = identifyStudent_(lesson);
          if (st) PropertiesService.getScriptProperties().setProperty('title_' + norm_(lesson.meetingTitle), st.folder);
        } catch (e) {}
        (lesson.extraDocs || []).forEach(d => markDone_(d.getId()));
        done++;
      } catch (err) {
        handleFailure_(lesson, err);
      }
    }
  } finally {
    lock.releaseLock();
  }
}

/** Processes finished transcripts now, without waiting for a video (e.g. lessons you only transcribed). */
function processNowWithoutVideo() {
  FORCE_NO_RECORDING_ = true;
  processNewLessons();
  Logger.log('Done — check your inbox for the confirmation email(s).');
}

/** Dry run: lists what the next run would do, changes nothing. */
function testFindLessons() {
  const lessons = findPendingLessons_();
  if (!lessons.length) { Logger.log('No unprocessed transcripts found in Meet Recordings.'); return; }
  lessons.forEach(l => {
    const student = identifyStudent_(l);
    Logger.log([
      '— ' + l.transcript.getName(),
      '   meeting: ' + l.meetingTitle + ' | date: ' + l.dateStr,
      '   student: ' + (student ? student.folder : '❌ NO MATCH (attendees: ' + l.attendees + ')'),
      '   recording: ' + (l.recording ? l.recording.getName() : 'not found yet'),
      '   chat file: ' + (l.chat ? l.chat.getName() : 'none'),
      '   ready to process: ' + l.ready + (l.ready ? '' : ' (run processNowWithoutVideo to process it without a video)'),
    ].join('\n'));
    if (student) {
      try {
        const p = readProfile_(getStudentFolder_(student.folder));
        Logger.log('   profile → student: %s | parent: %s | course: %s',
          p.studentEmail || '❌ missing', p.parentEmail || '❌ missing', p.course);
      } catch (e) { Logger.log('   profile → ❌ ' + e.message); }
    }
  });
}

/**
 * Re-makes ONLY the email draft for a lesson that has already been processed
 * (nothing else is created, moved or emailed). Paste the transcript's file ID below —
 * it's the long code in the transcript's URL between /d/ and /edit.
 */
function testEmailDraft() {
  const TRANSCRIPT_ID = 'PASTE_TRANSCRIPT_FILE_ID';
  const t = DriveApp.getFileById(TRANSCRIPT_ID);
  const dateFolder = t.getParents().next();
  const lesson = buildLesson_(t, null, findChatIn_(dateFolder, stripSuffix_(t.getName())));
  const student = identifyStudent_(lesson);
  if (!student) throw new Error('Could not match a student for this transcript.');
  const profile = readProfile_(getStudentFolder_(student.folder));
  const ai = runGemini_(student.folder, lesson, profile);
  const draft = createEmailDraft_(student.folder, lesson, profile, ai, dateFolder);
  Logger.log('Draft created → To: %s  Cc: %s\nWhiteboard link: %s\nAttached: %s\nNotes: %s',
    draft.to, draft.cc || '-', draft.whiteboard || 'none', draft.attached.join(', ') || 'nothing',
    draft.warnings.join(' | ') || 'none');
}

/** Creates (or finds) the Whiteboards drop folder and shows its link. */
function setupWhiteboards() {
  const f = whiteboardInbox_();
  Logger.log('Whiteboards folder: ' + f.getUrl());
}

/** Checks that your Gmail signature can be read (needs Services → Gmail API). */
function testSignature() {
  const s = getGmailSignature_();
  Logger.log(s ? 'Signature found:\n' + htmlToText_(s) : '❌ No signature found — add the Gmail API service, or set a signature in Gmail settings.');
}

/** Runs the learning step now instead of waiting for the next scheduled run. */
function learnNow() { learnFromSentEmails_(); Logger.log('Done — check EMAIL STYLE GUIDE in your Templates folder.'); }

/** Checks your API key and model name. */
function testGemini() {
  Logger.log(callGemini_('Reply with JSON {"ok":"yes"}', 'ping', null));
}

/** Run once to start the 10-minute schedule. */
function installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'processNewLessons')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('processNewLessons').timeBased().everyMinutes(10).create();
  Logger.log('Trigger installed: processNewLessons every 10 minutes.');
}

/** Stops the automation (also clears any old triggers from earlier versions of this project). */
function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  Logger.log('All triggers removed.');
}

/** Lets a lesson be processed again (the transcript must be back in Meet Recordings). */
function resetLesson(transcriptId) {
  const props = PropertiesService.getScriptProperties();
  ['done_', 'fail_'].forEach(k => props.deleteProperty(k + transcriptId));
}

// ───────────────────────── FIND LESSONS ─────────────────────────

function findPendingLessons_() {
  const props = PropertiesService.getScriptProperties();
  const transcripts = [], recordings = {}, chats = {};
  walkFolder_(DriveApp.getFolderById(CONFIG.SOURCE_FOLDER_ID), file => {
    const name = file.getName(), mime = file.getMimeType();
    if (isChatFile_(name)) chats[keyOf_(name)] = file;
    else if (mime === MimeType.GOOGLE_DOCS && /(Transcript|Notes by Gemini)\s*$/i.test(name)) transcripts.push(file);
    else if (mime === 'video/mp4') recordings[keyOf_(name)] = file;
  });

  // One lesson per meeting: if Meet saved both a "Transcript" doc and a "Notes by Gemini" doc,
  // the Transcript doc is the main one and the notes doc is filed alongside it.
  const byKey = {};
  transcripts.forEach(t => {
    const k = keyOf_(t.getName());
    (byKey[k] = byKey[k] || []).push(t);
  });

  const lessons = [];
  Object.keys(byKey).forEach(k => {
    const docs = byKey[k].sort((a, b) => (/Transcript\s*$/i.test(b.getName()) ? 1 : 0) - (/Transcript\s*$/i.test(a.getName()) ? 1 : 0));
    const t = docs[0], id = t.getId();
    if (props.getProperty('done_' + id)) return;
    if (Number(props.getProperty('fail_' + id) || 0) >= 3) return;
    const lesson = buildLesson_(t, recordings[k] || null, chats[k] || null);
    lesson.extraDocs = docs.slice(1);
    const ageHours = (Date.now() - t.getDateCreated().getTime()) / 3.6e6;
    // "Notes by Gemini" docs are created when the meeting starts and filled in afterwards,
    // so wait until the transcript has finished ("… ended after hh:mm:ss").
    const finished = /(Meeting|Transcription) ended after/i.test(lesson.text);
    // No video yet: wait WAIT_FOR_RECORDING_HOURS for one, unless processNowWithoutVideo was run
    lesson.ready = (finished && (!!lesson.recording || FORCE_NO_RECORDING_ ||
                    ageHours >= CONFIG.WAIT_FOR_RECORDING_HOURS)) || ageHours >= 8;
    lessons.push(lesson);
  });
  return lessons;
}

function buildLesson_(transcript, recording, chat) {
  const base = stripSuffix_(transcript.getName());
  // e.g. "IB Maths SL Wednesday Session - 2026/09/30 16:57 BST"
  const m = base.match(/^(.*?)\s*[–—-]\s*(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
  let meetingTitle = base, y, mo, d;
  if (m) { meetingTitle = m[1].trim(); y = +m[2]; mo = +m[3]; d = +m[4]; }
  else {
    const c = transcript.getDateCreated();
    y = +fmt_(c, 'yyyy'); mo = +fmt_(c, 'MM'); d = +fmt_(c, 'dd');
  }
  const text = docText_(transcript.getId());
  // Attendees: the "Attendees" line (Transcript docs), the "Invited" line (Notes by Gemini docs),
  // plus everyone who speaks in the transcript
  const att = text.match(/Attendees[ \t]*\n+[ \t]*(.+)/i) || text.match(/^[ \t]*Invited[ \t]+(\S.*)$/im);
  // Speakers = names that start transcript lines ("Zoë Kowalczyk: …") several times.
  // Section headings in Gemini's notes also end in a colon, but only once — so they are ignored.
  const transcriptPart = (text.split(/=== [^=]*Transcript[^=]* ===/i)[1]) || text;
  const counts = {};
  (transcriptPart.match(/^[A-Za-zÀ-ž' .-]{2,40}(?=:\s)/gm) || []).forEach(n => { n = n.trim(); counts[n] = (counts[n] || 0) + 1; });
  const speakers = Object.keys(counts).filter(n => counts[n] >= 3).slice(0, 6);
  // People chips (invitees / speakers shown as name bubbles) aren't in plain text — read them directly
  const people = docPeople_(transcript.getId());
  return {
    transcript, recording, chat, meetingTitle,
    year: y, month: mo, day: d,
    dateStr: pad_(d) + '.' + pad_(mo) + '.' + y,          // 30.09.2026
    longDate: d + ' ' + MONTHS[mo - 1] + ' ' + y,         // 30 September 2026
    text,
    attendees: [(att ? att[1].trim() : '')].concat(speakers, people).filter(Boolean).join(', '),
    isGeminiNotes: /Notes by Gemini\s*$/i.test(transcript.getName()),
    extraDocs: [],
    ready: true,
  };
}

function walkFolder_(folder, fn) {
  const files = folder.getFiles();
  while (files.hasNext()) fn(files.next());
  const subs = folder.getFolders();
  while (subs.hasNext()) walkFolder_(subs.next(), fn);
}

function isChatFile_(name) { return /[–—-]\s*Chat[^–—-]*$/i.test(name); }

/** "X - 2026/09/30 16:57 BST – Transcript" → "X - 2026/09/30 16:57 BST" (also Recording / Chat) */
function stripSuffix_(name) {
  return name.replace(/\.(txt|sbv)$/i, '')
             .replace(/\s*[–—-]\s*(Transcript|Recording|Notes by Gemini|Chat[^–—-]*)\s*$/i, '').trim();
}

/** Same key for the notes, transcript, recording and chat of one meeting, whatever dashes Google used. */
function keyOf_(name) {
  return stripSuffix_(name).replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Names and emails of every person chip in the doc (all tabs). */
function docPeople_(docId) {
  const out = new Set();
  try {
    const doc = DocumentApp.openById(docId);
    const bodies = [];
    try {
      const walk = list => list.forEach(t => { bodies.push(t.asDocumentTab().getBody()); walk(t.getChildTabs()); });
      walk(doc.getTabs());
    } catch (e) {}
    if (!bodies.length) bodies.push(doc.getBody());
    bodies.forEach(body => {
      let r = null, n = 0;
      while ((r = body.findElement(DocumentApp.ElementType.PERSON, r)) && n++ < 200) {
        const p = r.getElement().asPerson();
        if (p.getName()) out.add(p.getName());
        if (p.getEmail()) out.add(p.getEmail());
      }
    });
  } catch (e) { console.warn('Could not read people chips: ' + e.message); }
  return [...out];
}

/** Text of EVERY tab in a Google Doc ("Notes by Gemini" keeps the transcript on its own tab). */
function docText_(docId) {
  const doc = DocumentApp.openById(docId);
  try {
    const tabs = [];
    const walk = list => list.forEach(t => { tabs.push(t); walk(t.getChildTabs()); });
    walk(doc.getTabs());
    if (tabs.length > 1) {
      return tabs.map(t => '=== ' + t.getTitle() + ' ===\n' + t.asDocumentTab().getBody().getText()).join('\n\n');
    }
  } catch (e) { /* older docs without tabs */ }
  return doc.getBody().getText();
}

function findChatIn_(folder, base) {
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (isChatFile_(f.getName()) && keyOf_(f.getName()) === keyOf_(base)) return f;
  }
  return null;
}

/**
 * A video (or chat file) that arrives in Meet Recordings after its lesson was already processed
 * without it is moved into that lesson's folder, and you get an email with the link.
 */
function fileLateRecordings_() {
  const props = PropertiesService.getScriptProperties();
  const found = {};
  walkFolder_(DriveApp.getFolderById(CONFIG.SOURCE_FOLDER_ID), f => {
    const name = f.getName();
    if (f.getMimeType() !== 'video/mp4' && !isChatFile_(name)) return;
    const k = 'late_' + keyOf_(name);
    if (props.getProperty(k)) (found[k] = found[k] || []).push(f);
  });
  Object.keys(found).forEach(k => {
    const folder = DriveApp.getFolderById(props.getProperty(k));
    const video = found[k].find(f => f.getMimeType() === 'video/mp4');
    found[k].forEach(f => f.moveTo(folder));
    if (!video) return;                                          // chat file only — keep waiting for the video
    props.deleteProperty(k);
    MailApp.sendEmail(CONFIG.ADMIN_EMAIL, '🎥 Late recording filed: ' + stripSuffix_(video.getName()),
      'The video arrived after this lesson had already been processed without it, so it is not linked in the email draft.\n\n' +
      'Moved into the lesson folder: ' + folder.getUrl() + '\nVideo: ' + video.getUrl() +
      '\n\nIf you want to send it, add the link to the draft (or a follow-up email) and share it with the student yourself.');
  });
}

// ───────────────────────── PROCESS ONE LESSON ─────────────────────────

function processLesson_(lesson) {
  const student = identifyStudent_(lesson);
  if (!student) throw new Error('Could not match a student. Attendees: "' + lesson.attendees +
    '", meeting: "' + lesson.meetingTitle + '". Check the student has a folder in Students (or add an alias in CONFIG.EXTRA_ALIASES).');
  const studentFolder = getStudentFolder_(student.folder);
  const profile = readProfile_(studentFolder);

  const ai = runGemini_(student.folder, lesson, profile);

  // Summary doc + filing
  const dateFolder = getDateFolder_(studentFolder, lesson);
  try { claimWhiteboardPdfs_(student.folder, lesson.dateStr, dateFolder); }
  catch (e) { console.warn('Could not check the Whiteboards folder: ' + e.message); }
  const docName = 'Lesson Summary _ ' + profile.course + ' _ ' + student.folder + ' _ ' + lesson.dateStr;
  const doc = DocumentApp.create(docName);
  writeSummaryDoc_(doc, ai.summary);
  DriveApp.getFileById(doc.getId()).moveTo(dateFolder);
  lesson.transcript.moveTo(dateFolder);
  if (lesson.recording) lesson.recording.moveTo(dateFolder);
  if (lesson.chat) lesson.chat.moveTo(dateFolder);
  (lesson.extraDocs || []).forEach(d => d.moveTo(dateFolder));

  // Processed without a video: if one turns up later, file it into this lesson folder
  if (!lesson.recording) {
    PropertiesService.getScriptProperties().setProperty('late_' + keyOf_(lesson.transcript.getName()), dateFolder.getId());
  }

  // Tracker
  SpreadsheetApp.openById(CONFIG.TRACKER_SHEET_ID).getSheets()[0].appendRow([
    "'" + lesson.dateStr, student.folder, profile.course, lesson.meetingTitle,
    doc.getUrl(), 'Processed', new Date(),
  ]);

  // Email draft
  const draft = createEmailDraft_(student.folder, lesson, profile, ai, dateFolder);
  if (!lesson.recording) draft.warnings.push('No video recording was found; only the transcript was filed.');

  // Mark the Meet email(s) read
  const q = 'from:meetings-noreply@google.com is:unread newer_than:3d "' + lesson.meetingTitle.replace(/"/g, '') + '"';
  GmailApp.search(q).forEach(th => th.markRead());

  // Tell Manfred
  const flags = (ai.summary.split(/FLAGS FOR MANFRED/i)[1] || '').trim() || 'None';
  MailApp.sendEmail({
    to: CONFIG.ADMIN_EMAIL,
    subject: '✅ Lesson processed: ' + student.folder + ' ' + lesson.dateStr,
    htmlBody:
      '<p><b>' + esc_(student.folder) + '</b> — ' + esc_(profile.course) + ' — ' + lesson.longDate + '</p>' +
      '<p>📁 <a href="' + dateFolder.getUrl() + '">Lesson folder</a><br>' +
      '📄 <a href="' + doc.getUrl() + '">Summary doc</a><br>' +
      '✉️ Draft waiting in Gmail → To: ' + esc_(draft.to) + (draft.cc ? ', Cc: ' + esc_(draft.cc) : '') + '<br>' +
      '🖍️ Whiteboard link: ' + (draft.whiteboard ? esc_(draft.whiteboard) : 'none found') + '<br>' +
      '📎 Attached: ' + (draft.attached.length ? draft.attached.map(esc_).join(', ') : 'nothing') + '</p>' +
      '<p><b>Flags:</b><br>' + esc_(flags).replace(/\n/g, '<br>') + '</p>' +
      (draft.warnings.length ? '<p>⚠️ ' + draft.warnings.map(esc_).join('<br>⚠️ ') + '</p>' : ''),
  });
}

/**
 * Every folder in Students is a student. Match words = folder-name words + profile "Preferred name"
 * + any EXTRA_ALIASES. The folder sharing the most whole words with the attendees + meeting title wins.
 */
function identifyStudent_(lesson) {
  const words = s => norm_(s).split(/[^a-z0-9]+/).filter(w => w.length >= 3);
  const ignore = new Set(words('manfred olbrich'));
  const hay = new Set(words(lesson.attendees + ' ' + lesson.meetingTitle).filter(w => !ignore.has(w)));

  let best = null, bestScore = 0, tie = false;
  for (const s of getStudentList_()) {
    const score = s.match.filter(w => hay.has(w)).length;
    if (score > bestScore) { best = s; bestScore = score; tie = false; }
    else if (score && score === bestScore) tie = true;
  }
  if (tie) throw new Error('More than one student folder matches "' + lesson.attendees + '" — add an alias in CONFIG.EXTRA_ALIASES.');
  if (best) return best;
  // Last resort: the student this meeting title belonged to last time (recurring lessons keep their title)
  const remembered = PropertiesService.getScriptProperties().getProperty('title_' + norm_(lesson.meetingTitle));
  return remembered ? (getStudentList_().find(s => s.folder === remembered) || null) : null;
}

let STUDENT_CACHE_ = null;
function getStudentList_() {
  if (STUDENT_CACHE_) return STUDENT_CACHE_;
  const words = s => norm_(s).split(/[^a-z0-9]+/).filter(w => w.length >= 3);
  const list = [];
  const it = DriveApp.getFolderById(CONFIG.STUDENTS_FOLDER_ID).getFolders();
  while (it.hasNext()) {
    const f = it.next(), name = f.getName();
    const match = new Set(words(name));
    try {
      const p = f.getFilesByName('STUDENT PROFILE');
      if (p.hasNext()) {
        const m = DocumentApp.openById(p.next().getId()).getBody().getText().match(/Preferred name:\s*([^\n\[]+)/i);
        if (m) words(m[1]).forEach(w => match.add(w));
      }
    } catch (e) { /* profile unreadable — folder name still works */ }
    (CONFIG.EXTRA_ALIASES[name] || []).forEach(a => words(a).forEach(w => match.add(w)));
    list.push({ folder: name, match: [...match] });
  }
  return (STUDENT_CACHE_ = list);
}

function getStudentFolder_(name) {
  const it = DriveApp.getFolderById(CONFIG.STUDENTS_FOLDER_ID).getFoldersByName(name);
  if (!it.hasNext()) throw new Error('No folder called "' + name + '" inside Students.');
  return it.next();
}

/** Reads STUDENT PROFILE. Emails and links come from the doc, never from the AI. */
function readProfile_(studentFolder) {
  const it = studentFolder.getFilesByName('STUDENT PROFILE');
  if (!it.hasNext()) throw new Error('No "STUDENT PROFILE" doc in ' + studentFolder.getName());
  const text = DocumentApp.openById(it.next().getId()).getBody().getText();

  const section = (start, end) => {
    const re = new RegExp('^\\s*' + start + '\\s*$([\\s\\S]*?)^\\s*' + end + '\\s*$', 'im');
    const m = text.match(re);
    return m ? m[1] : '';
  };
  const firstEmail = s => ((s.match(/[\w.+'-]+@[\w-]+(\.[\w-]+)+/) || [])[0] || '').toLowerCase();

  let course = '';
  const courseBlock = section('COURSE', 'ASPIRATIONS');
  const sl = courseBlock.match(/Subject and level:\s*(.+)/i);
  if (sl && !/^\[/.test(sl[1].trim())) course = sl[1].trim();
  if (!course) {
    const line = courseBlock.split('\n').map(l => l.replace(/^[-\s]+/, '').trim())
      .find(l => l && !/^\[/.test(l) && !/:\s*\[/.test(l));
    course = line || 'Maths';
  }

  const wb = text.match(/Whiteboard(?: link)?:\s*(https?:\/\/\S+)/i);

  return {
    studentEmail: firstEmail(section('STUDENT', 'PARENTS / GUARDIANS')),
    parentEmail:  firstEmail(section('PARENTS / GUARDIANS', 'LESSON EMAILS')),
    course: course.replace(/[\\\/:*?"<>|]/g, '-'),
    whiteboard: wb ? wb[1] : '',
    fullText: text,
  };
}

function getPreviousSummary_(studentName, currentDateStr) {
  const q = "title contains 'Lesson Summary _' and title contains '" + studentName.replace(/'/g, "\\'") +
            "' and mimeType = 'application/vnd.google-apps.document' and trashed = false";
  const it = DriveApp.searchFiles(q);
  let latest = null;
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName().endsWith(currentDateStr)) continue;
    if (!latest || f.getDateCreated() > latest.getDateCreated()) latest = f;
  }
  return latest ? DocumentApp.openById(latest.getId()).getBody().getText().slice(0, 8000) : '';
}

function getDateFolder_(studentFolder, lesson) {
  let parent = getOrCreate_(studentFolder, String(lesson.year));
  if (CONFIG.USE_MONTH_FOLDERS) {
    const suffix = MONTHS[lesson.month - 1] + ' ' + lesson.year;
    let monthFolder = null;
    const subs = parent.getFolders();
    while (subs.hasNext()) {
      const f = subs.next();
      if (f.getName().trim().endsWith(suffix)) { monthFolder = f; break; }
    }
    if (!monthFolder) {
      const academicIdx = ((lesson.month - 9 + 12) % 12) + 1;   // Sep = 1, Oct = 2 …
      monthFolder = parent.createFolder(academicIdx + '. ' + suffix);
    }
    parent = monthFolder;
  }
  return getOrCreate_(parent, lesson.dateStr);
}

function getOrCreate_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

// ───────────────────────── WHITEBOARD ─────────────────────────

/** The link posted in the Meet chat during the recording (boards change every lesson, so no fallback). */
function findWhiteboardLink_(lesson, profile) {
  if (lesson.chat) {
    try {
      const txt = lesson.chat.getMimeType() === MimeType.GOOGLE_DOCS
        ? DocumentApp.openById(lesson.chat.getId()).getBody().getText()
        : lesson.chat.getBlob().getDataAsString();
      const urls = (txt.match(/https?:\/\/[^\s<>"')]+/g) || [])
        .map(u => u.replace(/[.,;]+$/, ''))
        .filter(u => !/meet\.google\.com/i.test(u));
      if (urls.length) return urls[urls.length - 1];       // the last link shared = current board
    } catch (e) { console.warn('Could not read chat file: ' + e.message); }
  }
  return '';
}

// ───────────────────────── WHITEBOARDS DROP FOLDER ─────────────────────────
//
// Save whiteboard PDFs into the "Whiteboards" folder (next to your Students folder) with any name.
// Each PDF is matched to a lesson by:
//   • date  — a date in the file name (04.10.2026, 4-10-2026, 2026-10-04, 4 Oct 2026, 04.10),
//             otherwise the day the file was saved;
//   • student — a student's name in the file name (folder name or preferred name, e.g. "Alex").
//             With no name in the file name, it goes to the only lesson that day (if there is just one).
// Matching PDFs are moved into Students/Name/YYYY/N. Month YYYY/DD.MM.YYYY and attached to the draft.
// A PDF saved AFTER the draft was made is added to the existing draft (if not sent yet), and you get an email.

function whiteboardInbox_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('WB_INBOX_ID');
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  const parent = DriveApp.getFolderById(CONFIG.STUDENTS_FOLDER_ID).getParents().next();
  const it = parent.getFoldersByName(CONFIG.WHITEBOARD_INBOX_NAME);
  const folder = it.hasNext() ? it.next() : parent.createFolder(CONFIG.WHITEBOARD_INBOX_NAME);
  props.setProperty('WB_INBOX_ID', folder.getId());
  return folder;
}

/** Reads the date and student from a PDF's name (falling back to the day it was saved). */
function whiteboardMeta_(file) {
  const name = file.getName().replace(/\.pdf$/i, '');
  const created = file.getDateCreated();
  const cy = +fmt_(created, 'yyyy');
  const mk = (d, m, y) => (d >= 1 && d <= 31 && m >= 1 && m <= 12) ? pad_(d) + '.' + pad_(m) + '.' + y : null;
  let nameDate = null, mm;
  const MON = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  if ((mm = name.match(/(\d{4})[.\-_](\d{1,2})[.\-_](\d{1,2})/))) nameDate = mk(+mm[3], +mm[2], +mm[1]);
  else if ((mm = name.match(/(\d{1,2})[.\-_ ](\d{1,2})[.\-_ ](\d{4})/))) nameDate = mk(+mm[1], +mm[2], +mm[3]);
  else if ((mm = name.match(/(\d{1,2})(?:st|nd|rd|th)?[\s\-_]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s\-_]*(\d{4})?/i)))
    nameDate = mk(+mm[1], MON.indexOf(mm[2].toLowerCase()) + 1, mm[3] ? +mm[3] : cy);
  else if ((mm = name.match(/(?:^|[^\d.])(\d{1,2})[.\-](\d{1,2})(?![.\-]?\d)/))) {
    // "04.10" with no year: only trust it if it's within two weeks of when the file was saved
    // (so things like "SL 1.2" aren't mistaken for a date)
    const guess = new Date(cy, +mm[2] - 1, +mm[1]);
    if (Math.abs(guess - created) <= 14 * 864e5) nameDate = mk(+mm[1], +mm[2], cy);
  }

  const words = s => norm_(s).split(/[^a-z0-9]+/).filter(w => w.length >= 3);
  const inName = new Set(words(name));
  let student = null, best = 0, tie = false;
  for (const s of getStudentList_()) {
    const score = s.match.filter(w => inName.has(w)).length;
    if (score > best) { student = s.folder; best = score; tie = false; }
    else if (score && score === best) tie = true;
  }
  return {
    nameDate,
    savedDate: fmt_(created, 'dd.MM.yyyy'),
    student: tie ? null : student,
    ambiguous: tie,
  };
}

function dateMatches_(meta, dateStr) {
  if (meta.nameDate) return meta.nameDate === dateStr;
  return meta.savedDate === dateStr;
}

/** While a lesson is being processed: move its whiteboard PDF(s) from the drop folder into the lesson folder. */
function claimWhiteboardPdfs_(studentName, dateStr, dateFolder) {
  const it = whiteboardInbox_().getFilesByType(MimeType.PDF);
  const unnamed = [];
  let moved = 0;
  while (it.hasNext()) {
    const f = it.next(), meta = whiteboardMeta_(f);
    if (!dateMatches_(meta, dateStr)) continue;
    if (meta.student === studentName) { f.moveTo(dateFolder); moved++; }
    else if (!meta.student && !meta.ambiguous) unnamed.push(f);
  }
  // No name in the file → only take it if no other student has a lesson that day
  if (unnamed.length && lessonsOnDate_(dateStr).filter(n => n !== studentName).length === 0) {
    unnamed.forEach(f => { f.moveTo(dateFolder); moved++; });
  }
  return moved;
}

/**
 * Every run: PDFs that arrive after their lesson was already processed are filed into the lesson
 * folder and added to the waiting Gmail draft. PDFs for lessons not processed yet are left for later.
 */
function sweepWhiteboardInbox_() {
  const it = whiteboardInbox_().getFilesByType(MimeType.PDF);
  while (it.hasNext()) {
    const f = it.next();
    if (Date.now() - f.getDateCreated().getTime() < 5 * 60 * 1000) continue;   // still uploading
    const meta = whiteboardMeta_(f);
    const dateStr = meta.nameDate || meta.savedDate;
    let studentName = meta.student;
    if (!studentName) {
      if (meta.ambiguous) continue;
      const onDay = lessonsOnDate_(dateStr);
      if (onDay.length !== 1) continue;
      studentName = onDay[0];
    }
    const dateFolder = findDateFolder_(studentName, dateStr);
    if (!dateFolder) continue;                                  // lesson not processed yet — claimed later
    const summaryDone = dateFolder.getFiles();
    let processed = false;
    while (summaryDone.hasNext()) if (/^Lesson Summary _/.test(summaryDone.next().getName())) { processed = true; break; }
    f.moveTo(dateFolder);
    if (!processed) continue;                                   // folder made by hand; the draft will pick it up

    const added = addPdfToDraft_(studentName, dateStr, f);
    MailApp.sendEmail(CONFIG.ADMIN_EMAIL,
      '🖍️ Whiteboard PDF filed: ' + studentName + ' ' + dateStr,
      f.getName() + ' was moved into ' + studentName + ' / ' + dateStr + '.\n\n' +
      (added ? 'It has been attached to the waiting email draft.'
             : 'No unsent draft was found for this lesson (probably already sent), so please send the PDF separately if needed.') +
      '\n\nFolder: ' + dateFolder.getUrl());
  }
}

/** Adds a PDF to the unsent lesson-summary draft for that student/date, keeping any edits you made. */
function addPdfToDraft_(studentName, dateStr, file) {
  const suffix = ' _ ' + studentName + ' _ ' + dateStr;
  const draft = GmailApp.getDrafts().find(d => d.getMessage().getSubject().endsWith(suffix));
  if (!draft) return false;
  const m = draft.getMessage();
  const attachments = m.getAttachments({ includeInlineImages: false }).concat([file.getBlob()]);
  const opts = { htmlBody: m.getBody(), attachments, name: 'Manfred Olbrich' };
  if (m.getCc()) opts.cc = m.getCc();
  if (m.getBcc()) opts.bcc = m.getBcc();
  draft.update(m.getTo(), m.getSubject(), m.getPlainBody(), opts);
  return true;
}

/** Students who have a lesson folder for this date (without creating anything). */
function lessonsOnDate_(dateStr) {
  return getStudentList_().map(s => s.folder).filter(n => !!findDateFolder_(n, dateStr));
}

/** Finds Students/Name/YYYY/(N. Month YYYY/)DD.MM.YYYY without creating anything. */
function findDateFolder_(studentName, dateStr) {
  const [d, m, y] = dateStr.split('.').map(Number);
  const s = DriveApp.getFolderById(CONFIG.STUDENTS_FOLDER_ID).getFoldersByName(studentName);
  if (!s.hasNext()) return null;
  const yi = s.next().getFoldersByName(String(y));
  if (!yi.hasNext()) return null;
  const yearFolder = yi.next();
  const direct = yearFolder.getFoldersByName(dateStr);
  if (direct.hasNext()) return direct.next();
  const suffix = MONTHS[m - 1] + ' ' + y;
  const months = yearFolder.getFolders();
  while (months.hasNext()) {
    const mf = months.next();
    if (!mf.getName().trim().endsWith(suffix)) continue;
    const di = mf.getFoldersByName(dateStr);
    if (di.hasNext()) return di.next();
  }
  return null;
}

function findWhiteboardPdfs_(dateFolder) {
  const out = [];
  const it = dateFolder.getFilesByType(MimeType.PDF);
  while (it.hasNext()) out.push(it.next());
  return out;
}

// ───────────────────────── EMAIL DRAFT ─────────────────────────

function createEmailDraft_(studentName, lesson, profile, ai, dateFolder) {
  const e = ai.email || {};
  const warnings = [];

  let to = profile.studentEmail, cc = profile.parentEmail;
  if (!to && cc) { to = cc; cc = ''; warnings.push('No student email in profile — draft addressed to parent only.'); }
  if (!to) { to = CONFIG.ADMIN_EMAIL; warnings.push('No student or parent email in profile — draft addressed to you.'); }

  const whiteboard = findWhiteboardLink_(lesson, profile);
  if (!whiteboard) warnings.push('No whiteboard link was posted in the Meet chat while recording. Replace the yellow placeholder in the draft.');

  const attachments = [], attached = [], linkedPdfs = [];
  findWhiteboardPdfs_(dateFolder).forEach(f => {
    if (f.getSize() <= CONFIG.MAX_ATTACHMENT_MB * 1024 * 1024) { attachments.push(f.getBlob()); attached.push(f.getName()); }
    else linkedPdfs.push(f);
  });
  if (!attached.length && !linkedPdfs.length) warnings.push('No whiteboard PDF was in the lesson folder, so nothing is attached.');

  // ---------- HTML ----------
  // No font, size or colour is set anywhere, so Gmail shows it in your default font (Sans Serif, normal).
  const list = arr => '<ul>' + arr.map(x => '<li>' + esc_(x) + '</li>').join('') + '</ul>';
  const section = (title, arr) => (arr && arr.length) ? '<div><br></div><div><b>' + title + '</b></div>' + list(arr) : '';

  const resources = [];
  if (whiteboard) resources.push('Whiteboard: <a href="' + esc_(whiteboard) + '">' + esc_(whiteboard) + '</a>');
  else resources.push('Whiteboard: <span style="background-color:#fff59d"><b>[PASTE WHITEBOARD LINK]</b></span>');
  if (attached.length) resources.push('The whiteboard from today is attached as a PDF.');
  linkedPdfs.forEach(f => resources.push('Whiteboard PDF: <a href="' + f.getUrl() + '">' + esc_(f.getName()) + '</a>'));

  // Recording + transcript links (shared with the recipients only once you send the email)
  const shareFiles = [];
  if (CONFIG.SHARE_RECORDING && lesson.recording) {
    resources.push('Lesson recording, to rewatch: <a href="' + lesson.recording.getUrl() + '">watch the lesson</a>');
    shareFiles.push(lesson.recording.getId());
  } else if (CONFIG.SHARE_RECORDING) {
    warnings.push('No recording was found, so no recording link is in the email.');
  }
  if (CONFIG.SHARE_TRANSCRIPT) {
    resources.push((lesson.isGeminiNotes ? 'Lesson notes and full transcript' : 'Lesson transcript') +
      ', to review or use with an AI tool: <a href="' + lesson.transcript.getUrl() + '">open the ' +
      (lesson.isGeminiNotes ? 'notes' : 'transcript') + '</a>');
    shareFiles.push(lesson.transcript.getId());
  }

  const signature = getGmailSignature_();
  if (!signature) warnings.push('Your Gmail signature could not be added — check the Gmail API service is switched on in the script (Services → Gmail API).');
  const signOff = esc_(e.sign_off || 'Best wishes,');

  const html =
    '<div>' + esc_(e.greeting || 'Hi,') + '</div><div><br></div>' +
    (e.intro ? '<div>' + esc_(e.intro) + '</div>' : '') +
    section('Topics Covered', e.topics_covered) +
    section('Progress Made', e.progress_made) +
    section('Areas to Work On', e.areas_to_work_on) +
    section('Homework', e.homework) +
    (e.next_lesson ? '<div><br></div><div><b>Next Lesson</b></div><div>' + esc_(e.next_lesson) + '</div>' : '') +
    '<div><br></div><div><b>Lesson Resources</b></div><ul>' + resources.map(r => '<li>' + r + '</li>').join('') + '</ul>' +
    (e.closing ? '<div><br></div><div>' + esc_(e.closing) + '</div>' : '') +
    '<div><br></div><div>' + signOff + '</div>' +
    (signature ? '<div><br></div><div class="gmail_signature">' + signature + '</div>' : '<div>Manfred</div>');

  // ---------- plain-text version (also what the learning step compares against) ----------
  const tsec = (t, arr) => (arr && arr.length) ? '\n' + t + '\n' + arr.map(x => '- ' + x).join('\n') + '\n' : '';
  const plain = [
    e.greeting || 'Hi,', '', e.intro || '',
    tsec('Topics Covered', e.topics_covered), tsec('Progress Made', e.progress_made),
    tsec('Areas to Work On', e.areas_to_work_on), tsec('Homework', e.homework),
    e.next_lesson ? '\nNext Lesson\n' + e.next_lesson + '\n' : '',
    '\nWhiteboard: ' + (whiteboard || '[PASTE WHITEBOARD LINK]'),
    attached.length ? 'The whiteboard from today is attached as a PDF.' : '',
    CONFIG.SHARE_RECORDING && lesson.recording ? 'Lesson recording, to rewatch: ' + lesson.recording.getUrl() : '',
    CONFIG.SHARE_TRANSCRIPT ? 'Lesson transcript, to review or use with an AI tool: ' + lesson.transcript.getUrl() : '',
    '', e.closing || '', '', e.sign_off || 'Best wishes,',
    signature ? htmlToText_(signature) : 'Manfred',
  ].join('\n');

  const subject = 'Lesson Summary _ ' + profile.course + ' _ ' + studentName + ' _ ' + lesson.dateStr;
  const opts = { name: 'Manfred Olbrich', htmlBody: html };
  if (cc) opts.cc = cc;
  if (attachments.length) opts.attachments = attachments;
  GmailApp.createDraft(to, subject, plain, opts);

  // Remember what the AI wrote, so we can compare it with what you actually send
  PropertiesService.getScriptProperties().setProperty('draft_' + subject, plain.slice(0, 8000));
  // Files to share once this email is actually sent (see shareFilesFromSentEmails_)
  if (shareFiles.length) PropertiesService.getScriptProperties().setProperty('share_' + subject, JSON.stringify(shareFiles));

  return { to, cc, whiteboard, attached, warnings };
}

/** Your Gmail signature for the default "send as" address (needs the Gmail API advanced service). */
function getGmailSignature_() {
  try {
    const list = Gmail.Users.Settings.SendAs.list('me').sendAs || [];
    const me = list.find(s => s.isDefault) || list.find(s => s.isPrimary) || list[0];
    return (me && me.signature) || '';
  } catch (e) {
    console.warn('Signature lookup failed: ' + e.message);
    return '';
  }
}

function htmlToText_(html) {
  return String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n').trim();
}

// ───────────────────────── SHARING RECORDING + TRANSCRIPT ON SEND ─────────────────────────

/**
 * When a lesson email has been SENT, gives its To/Cc recipients view access to the recording and
 * transcript linked in it. Uses the recipients of the email you actually sent (so your edits count),
 * and only shares files whose link is still in the sent email.
 */
function shareFilesFromSentEmails_() {
  const props = PropertiesService.getScriptProperties();
  const threads = GmailApp.search('in:sent subject:"Lesson Summary" newer_than:14d', 0, 20);
  for (const th of threads) {
    for (const m of th.getMessages()) {
      if (!m.getFrom().toLowerCase().includes(CONFIG.ADMIN_EMAIL.toLowerCase())) continue;
      if (/^(re|fwd?):/i.test(m.getSubject())) continue;
      const key = 'share_' + m.getSubject();
      const pending = props.getProperty(key);
      if (!pending) continue;

      const body = m.getBody() + ' ' + m.getPlainBody();
      const recipients = (m.getTo() + ',' + m.getCc()).split(',')
        .map(s => ((s.match(/<([^>]+)>/) || [])[1] || s).trim().toLowerCase())
        .filter(s => s.includes('@') && s !== CONFIG.ADMIN_EMAIL.toLowerCase());
      const problems = [];
      JSON.parse(pending).forEach(id => {
        if (!body.includes(id)) return;                              // you removed that link before sending
        recipients.forEach(email => {
          const err = shareView_(id, email);
          if (err) problems.push(email + ': ' + err);
        });
      });
      props.deleteProperty(key);
      if (problems.length) {
        MailApp.sendEmail(CONFIG.ADMIN_EMAIL, '⚠️ Could not share lesson files: ' + m.getSubject(),
          'The recording/transcript could not be shared with:\n\n' + problems.join('\n') +
          '\n\nThey may not have a Google account, or your Workspace may block sharing outside your domain ' +
          '(admin.google.com → Apps → Google Workspace → Drive and Docs → Sharing settings).');
      }
    }
  }
}

/** View-only access for one person, without Google's own notification email. Returns an error message or ''. */
function shareView_(fileId, email) {
  try {                                                             // Drive API (advanced service) — silent
    Drive.Permissions.create({ role: 'reader', type: 'user', emailAddress: email }, fileId,
                             { sendNotificationEmail: false });
    return '';
  } catch (e1) {
    try {                                                           // fallback: may send Google's share email
      DriveApp.getFileById(fileId).addViewer(email);
      return '';
    } catch (e2) {
      return e2.message;
    }
  }
}

// ───────────────────────── LEARNING FROM YOUR SENT EMAILS ─────────────────────────

/**
 * Looks for lesson emails you've sent since the last run, compares each with the AI's draft,
 * and updates the "EMAIL STYLE GUIDE" doc in your Templates folder with what you changed.
 * The style guide + your most recent sent emails are then used for every new draft.
 */
function learnFromSentEmails_() {
  const props = PropertiesService.getScriptProperties();
  const threads = GmailApp.search('in:sent subject:"Lesson Summary" newer_than:21d', 0, 20);
  for (const th of threads) {
    for (const m of th.getMessages()) {
      if (!m.getFrom().toLowerCase().includes(CONFIG.ADMIN_EMAIL.toLowerCase())) continue;
      if (m.isDraft && m.isDraft()) continue;
      if (/^(re|fwd?):/i.test(m.getSubject())) continue;       // only the original lesson email
      const learnedKey = 'learned_' + m.getId();
      if (props.getProperty(learnedKey)) continue;              // already learned from this one
      const subject = m.getSubject();
      const draftKey = 'draft_' + subject;
      const aiDraft = props.getProperty(draftKey) || '';        // empty if sent before learning existed
      const sent = stripQuoted_(m.getPlainBody());
      try {
        updateStyleGuide_(aiDraft || '(no AI draft stored — learn the style directly from what he sent)', sent);
        props.setProperty(learnedKey, '1');
        props.deleteProperty(draftKey);
      } catch (e) {
        console.warn('Learning step failed for "' + subject + '": ' + e.message);
      }
    }
  }
}

function updateStyleGuide_(aiDraft, sent) {
  const doc = getStyleGuideDoc_();
  const current = doc.getBody().getText();
  const system = [
    'You maintain a short style guide describing how Manfred Olbrich, a private maths tutor, writes his',
    'post-lesson emails to students (with the parent in cc). You are given the current guide, an email draft',
    'written by an AI assistant, and the version Manfred actually sent after editing it.',
    'Work out what he changed and why (wording, tone, length, level of detail, greeting, sign-off, what he',
    'adds or removes, how he phrases homework or praise, British spelling, etc.), then return the UPDATED guide.',
    'Rules: keep it under 350 words; short bullet points under the headings TONE, STRUCTURE, PHRASING,',
    'ALWAYS, NEVER; keep earlier points unless this edit contradicts them; generalise — do not copy',
    'lesson-specific content or student names; ignore the signature block and the whiteboard, recording and transcript links, and ignore',
    'differences that are only formatting (bullet symbols, spacing). If he made no meaningful change,',
    'return the current guide unchanged (or, if it is empty, describe the style of what he sent).',
    'Return JSON {"guide": "..."} with the guide as plain text.',
  ].join('\n');
  const user = '=== CURRENT GUIDE ===\n' + (current || '(empty)') +
               '\n\n=== AI DRAFT ===\n' + aiDraft + '\n\n=== WHAT MANFRED SENT ===\n' + sent;
  const out = callGemini_(system, user, {
    type: 'OBJECT', properties: { guide: { type: 'STRING' } }, required: ['guide'],
  });
  if (!out.guide) return;
  const body = doc.getBody();
  body.clear();
  body.appendParagraph('EMAIL STYLE GUIDE').setHeading(DocumentApp.ParagraphHeading.TITLE);
  body.appendParagraph('Updated automatically from the lesson emails you send. You can edit this yourself too. ' +
                       'Last updated: ' + fmt_(new Date(), 'd MMMM yyyy HH:mm'));
  out.guide.split('\n').forEach(l => { if (l.trim()) body.appendParagraph(l.trim()); });
  if (body.getChild(0).asText().getText() === '') body.getChild(0).removeFromParent();
  doc.saveAndClose();
}

function getStyleGuideDoc_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('STYLE_GUIDE_ID');
  if (id) { try { return DocumentApp.openById(id); } catch (e) { /* deleted — make a new one */ } }
  const templatesFolder = DriveApp.getFileById(CONFIG.TEMPLATE_DOC_ID).getParents().next();
  const doc = DocumentApp.create('EMAIL STYLE GUIDE');
  DriveApp.getFileById(doc.getId()).moveTo(templatesFolder);
  props.setProperty('STYLE_GUIDE_ID', doc.getId());
  return doc;
}

/** Style guide text + your 3 most recent sent lesson emails, for the drafting prompt. */
function getStyleContext_() {
  let guide = '';
  try {
    const id = PropertiesService.getScriptProperties().getProperty('STYLE_GUIDE_ID');
    if (id) guide = DocumentApp.openById(id).getBody().getText();
  } catch (e) { /* none yet */ }
  const examples = [];
  GmailApp.search('in:sent subject:"Lesson Summary"', 0, 3).forEach(th => {
    const msgs = th.getMessages();
    const m = msgs[msgs.length - 1];
    examples.push(stripQuoted_(m.getPlainBody()).slice(0, 3000));
  });
  return { guide, examples };
}

function stripQuoted_(text) {
  return String(text).split(/\nOn .+wrote:\s*\n/)[0].trim();
}
function normWs_(s) { return String(s).replace(/\s+/g, ' ').trim(); }

// ───────────────────────── GEMINI ─────────────────────────

function runGemini_(studentName, lesson, profile) {
  const template = DocumentApp.openById(CONFIG.TEMPLATE_DOC_ID).getBody().getText();
  const previous = getPreviousSummary_(studentName, lesson.dateStr);

  const system = [
    'You are the teaching assistant of Manfred Olbrich, an experienced private maths tutor (GCSE, A-Level, IB).',
    'You write the post-lesson record from a Google Meet transcript. Speaker "manfred olbrich" is the tutor;',
    'the other speaker is the student. Transcripts are auto-generated and contain recognition errors in maths',
    'terms: interpret sensibly, but never invent topics, questions, homework or results that are not supported',
    'by the transcript. If something is not in the transcript, write "Not discussed".',
    'The document may be Google\'s "Notes by Gemini" (tabs: Quick notes, Full notes, Transcript). The',
    'Transcript tab is the source of truth; use the notes tabs only as a guide.',
    'Write maths readably in plain text (x², dy/dx, √, fractions like 11/4). British English throughout.',
    '',
    'Return JSON with two fields:',
    '',
    '1. "summary": the LESSON SUMMARY TEMPLATE filled in. Keep every heading, in the same order and wording,',
    'in capitals. Replace every [placeholder]. Bullets start with "- ". Plain text only, no markdown.',
    'Use the previous lesson summary (if given) for "Progress since last lesson".',
    '"FLAGS FOR MANFRED" is private: anything he should act on (missed homework, a worry raised,',
    'scheduling, equipment, safeguarding), or "None".',
    '',
    '2. "email": the content of an email from Manfred, written TO THE STUDENT (the parent is only in cc).',
    '   - greeting: "Hi <student preferred name>," (preferred name from the profile).',
    '   - intro: 1–2 warm, specific sentences about the lesson, addressed to the student ("you").',
    '   - topics_covered: 2–5 short bullets.',
    '   - progress_made: 2–4 bullets on what the student did well or now understands, with concrete examples.',
    '   - areas_to_work_on: 1–3 bullets, constructive, each with a practical tip.',
    '   - homework: bullets exactly as agreed in the lesson; if none was set, one bullet saying so',
    '     (e.g. "Keep up with your school homework").',
    '   - next_lesson: one sentence with the planned focus and, if mentioned, the day/time.',
    '   - closing: one short sentence inviting questions between lessons.',
    '   - sign_off: just the sign-off words, e.g. "Best wishes," (no name — the signature is added).',
    '   Tone: follow the "Tone notes" in the profile; formal but warm, succinct and precise.',
    '   MOST IMPORTANT: Manfred\'s own style guide and his recently sent emails are given below. Match',
    '   his wording, tone, length and habits as closely as possible — they override the defaults above',
    '   (but keep the JSON fields). Never copy content about other students from those examples.',
    '   Bullets are plain sentences without leading dashes. Do NOT include the name/signature or the',
    '   whiteboard link (added automatically). NEVER include anything from Flags, and NEVER mention',
    '   medical, diagnostic or support-needs information from the profile.',
  ].join('\n');

  const style = getStyleContext_();

  const user = [
    'STUDENT: ' + studentName,
    'DATE: ' + lesson.longDate,
    'COURSE: ' + profile.course,
    'MEETING TITLE: ' + lesson.meetingTitle,
    '', '=== STUDENT PROFILE ===', profile.fullText,
    '', '=== LESSON SUMMARY TEMPLATE ===', template,
    '', '=== PREVIOUS LESSON SUMMARY ===', previous || '(none — this is the first recorded lesson)',
    '', '=== MANFRED\'S EMAIL STYLE GUIDE ===', style.guide || '(not built yet)',
    '', '=== EMAILS MANFRED RECENTLY SENT (style reference only — other lessons, possibly other students) ===',
    style.examples.length ? style.examples.join('\n\n-----\n\n') : '(none yet)',
    '', '=== TRANSCRIPT ===', lesson.text,
  ].join('\n');

  const arr = { type: 'ARRAY', items: { type: 'STRING' } };
  const schema = {
    type: 'OBJECT',
    properties: {
      summary: { type: 'STRING' },
      email: {
        type: 'OBJECT',
        properties: {
          greeting: { type: 'STRING' }, intro: { type: 'STRING' },
          topics_covered: arr, progress_made: arr, areas_to_work_on: arr, homework: arr,
          next_lesson: { type: 'STRING' }, closing: { type: 'STRING' }, sign_off: { type: 'STRING' },
        },
        required: ['greeting', 'intro', 'topics_covered', 'progress_made', 'areas_to_work_on',
                   'homework', 'next_lesson', 'closing', 'sign_off'],
      },
    },
    required: ['summary', 'email'],
  };

  const out = callGemini_(system, user, schema);
  if (!out.summary || !out.email) throw new Error('Gemini returned an incomplete answer.');
  return out;
}

function callGemini_(systemText, userText, schema) {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY is missing: Project Settings → Script properties.');

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + CONFIG.GEMINI_MODEL + ':generateContent';
  const gen = { temperature: 0.3, responseMimeType: 'application/json' };
  if (schema) gen.responseSchema = schema;
  const payload = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: gen,
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(payload), muteHttpExceptions: true,
    });
    const code = res.getResponseCode(), body = res.getContentText();
    if (code === 200) {
      const parts = ((((JSON.parse(body).candidates || [])[0]) || {}).content || {}).parts;
      if (!parts || !parts[0]) throw new Error('Gemini gave no content: ' + body.slice(0, 500));
      return JSON.parse(parts[0].text);
    }
    if ((code === 429 || code >= 500) && attempt < 3) { Utilities.sleep(15000 * attempt); continue; }
    throw new Error('Gemini API error ' + code + ': ' + body.slice(0, 800));
  }
}

// ───────────────────────── DOC FORMATTING ─────────────────────────

function writeSummaryDoc_(doc, text) {
  const body = doc.getBody();
  body.clear();
  const isLabel = s => /^[^:]{2,40}:\s*$/.test(s);
  let first = true;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    let p;
    if (/^\s*[-•]\s+/.test(line)) {
      p = body.appendListItem(line.replace(/^\s*[-•]\s+/, '')).setGlyphType(DocumentApp.GlyphType.BULLET);
    } else if (/^[A-Z0-9 /&'’-]{4,}$/.test(line.trim())) {
      p = body.appendParagraph(line.trim())
              .setHeading(first ? DocumentApp.ParagraphHeading.TITLE : DocumentApp.ParagraphHeading.HEADING2);
    } else {
      p = body.appendParagraph(line.trim());
    }
    if (p.editAsText().getText().length) p.editAsText().setBold(isLabel(line.trim()));
    first = false;
  }
  if (body.getNumChildren() > 1 && body.getChild(0).asText().getText() === '') body.getChild(0).removeFromParent();
  doc.saveAndClose();
}

// ───────────────────────── STATE + ERRORS ─────────────────────────

function markDone_(id) {
  const p = PropertiesService.getScriptProperties();
  p.setProperty('done_' + id, new Date().toISOString());
  p.deleteProperty('fail_' + id);
}

function handleFailure_(lesson, err) {
  const props = PropertiesService.getScriptProperties();
  const id = lesson.transcript.getId();
  const fails = Number(props.getProperty('fail_' + id) || 0) + 1;
  props.setProperty('fail_' + id, String(fails));
  console.error(lesson.transcript.getName() + ': ' + err.stack);
  if (fails === 1 || fails === 3) {
    MailApp.sendEmail(CONFIG.ADMIN_EMAIL,
      (fails === 3 ? '❌ Gave up on lesson: ' : '⚠️ Lesson processing problem: ') + lesson.meetingTitle + ' ' + lesson.dateStr,
      'Transcript: ' + lesson.transcript.getUrl() + '\n\nError: ' + err.message +
      (fails === 3 ? '\n\nIt will not retry. Fix the issue, then run resetLesson("' + id + '").'
                   : '\n\nIt will retry automatically (up to 3 attempts).'));
  }
}

// ───────────────────────── HELPERS ─────────────────────────

function norm_(s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').toLowerCase(); }
function pad_(n) { return (n < 10 ? '0' : '') + n; }
function fmt_(d, f) { return Utilities.formatDate(d, CONFIG.TIMEZONE, f); }
function esc_(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }