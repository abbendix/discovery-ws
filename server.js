#!/usr/bin/env node
/*
 * Workshop server: "Pick it up where you left off" (Customer Account discovery workshop)
 * Zero dependencies (Node >= 18, built-in modules only).
 *
 *   node server.js                       -> http://localhost:3000 (PORT env to change; binds 0.0.0.0)
 *   node server.js --new "Session title" -> also creates a session at startup and prints its PIN
 *   DATA_DIR=/path node server.js        -> where session-<ID>.json and exports/ are stored (default ./data)
 *
 * ---------------------------------------------------------------------------------------------
 * API OVERVIEW (JSON in/out, UTF-8; max body 64 KB; errors: {"error":{"code","message"}})
 * ---------------------------------------------------------------------------------------------
 * Auth: no accounts. Joining returns a secret participant `token`. Send it as
 *   `Authorization: Bearer <token>` or `?token=<token>` (needed for SSE and download links).
 * Facilitator = a participant that joined with the facilitator PIN (or created the session).
 * Facilitator-only calls from anyone else return 403 {"error":{"code":"forbidden"}}.
 * Page URLs: /s/<ID> serves public/index.html (join link), static files come from public/.
 *
 * Public
 *   GET  /api/health                         -> {ok:true, time}
 *   GET  /api/seed                           -> seed content from the discovery prototype
 *                                               {categories, stages, entryPoints, quadrants, states, evidence,
 *                                                assumptions, risks, kpis, openQuestions, experiments, nextSteps}
 *   GET  /api/sessions                       -> {sessions:[{id,title,createdAt,updatedAt,stage,participants,notes,votes}]}
 *   POST /api/sessions                       body {title?, dotsPerParticipant?(1-50, default 5), anonymous?, prefill?(default true),
 *                                                  facilitatorName?}
 *                                            -> 201 {id, title, facilitatorPin, token, participant, joinPath:"/s/<ID>"}
 *                                               (PIN is also printed in the server console; it is only shown once)
 *   GET  /api/sessions/:id                   -> {id,title,stage,exists:true}   (for the join screen)
 *   POST /api/sessions/:id/join              body {name, pin?, token?} -> {token, participant:{id,name,isFacilitator}}
 *                                               pin => facilitator; token => re-join as same participant
 *   GET  /api/sessions/:id/readonly          -> view (see below) for archived/read-only browsing, no token needed
 *   GET  /api/sessions/:id/state             -> view for the caller (token optional; without token = read-only)
 *   GET  /api/sessions/:id/events            -> SSE stream (see SSE section)
 *
 * Participants (token required)
 *   POST   /api/sessions/:id/notes           body {stage, column, category, text} -> {note}
 *   PATCH  /api/sessions/:id/notes/:nid      body {text?, category?, column?, index?}  own note (or facilitator).
 *                                            column+index = drag and drop: moves to that column at position index (0 = top)
 *   DELETE /api/sessions/:id/notes/:nid      own note (or facilitator)
 *   POST   /api/sessions/:id/votes           body {targetType:"entry"|"note", targetId} adds one dot. Limit enforced
 *                                            server-side per participant PER VOTING STAGE (409 "no_dots_left");
 *                                            423 "voting_locked" when locked. Dots may be stacked on one target.
 *   DELETE /api/sessions/:id/votes           body or query {targetType,targetId} removes one of your own dots
 *   PUT    /api/sessions/:id/placements/:entryId   body {x,y} 0..100 (x = effort low->high, y = value low->high) your 2x2 spot
 *   DELETE /api/sessions/:id/placements/:entryId   remove your placement
 *   POST   /api/sessions/:id/questions       body {kind:"question"|"decision", text, owner?, status?, decision?} -> {item}
 *   PATCH  /api/sessions/:id/questions/:qid  body any of the above; author or facilitator
 *   DELETE /api/sessions/:id/questions/:qid  author or facilitator
 *   POST   /api/sessions/:id/nextsteps       body {text, owner?, type:"experiment"|"action"|"research", due?} -> {item}
 *   PATCH/DELETE /api/sessions/:id/nextsteps/:sid   author or facilitator
 *
 * Facilitator only
 *   POST /api/sessions/:id/voting            body {locked:true|false}          lock / unlock all dot voting
 *   POST /api/sessions/:id/reveal            body {revealed:true|false}        reveal / hide vote totals + 2x2 aggregates
 *   POST /api/sessions/:id/settings          body {anonymous?, dotsPerParticipant?, title?}
 *   POST /api/sessions/:id/stage             body {stage:"<stageId>"|"next"|"prev"}   advance stage
 *   POST /api/sessions/:id/timer             body {action:"start", seconds} | {action:"stop"}
 *   POST /api/sessions/:id/clear             body {stage:"<stageId>"|"all"}    clears notes/votes/placements of that stage
 *   PUT  /api/sessions/:id/recommendation    body {mvp:[entryId], postMvp:[entryId], rationale}
 *   POST /api/sessions/:id/export            -> {file, downloadUrl, markdown}  (saved to DATA_DIR/exports/)
 *   GET  /api/sessions/:id/export.md         Markdown summary download (also saved to DATA_DIR/exports/)
 *   GET  /api/sessions/:id/export.csv?kind=notes|votes|placements   CSV download (default notes)
 *   GET  /api/sessions/:id/export.json       raw session JSON (token hashes removed)
 *   GET  /api/sessions/:id/exports/:file     download a saved export
 *   DELETE /api/sessions/:id                 deletes the session data file and its exports
 *   (downloads use ?token=<facilitator token>)
 *
 * ---------------------------------------------------------------------------------------------
 * JSON SHAPES
 * ---------------------------------------------------------------------------------------------
 * View (response of /state, /readonly and the SSE `state` event; personalised per caller):
 * { rev, serverTime, id, title, createdAt, updatedAt, readOnly,
 *   me: {id,name,isFacilitator} | null,
 *   settings: {dotsPerParticipant, anonymous, votingLocked, votesRevealed},
 *   stage: "warmup", stageIndex: 0,
 *   stages: [{id,title,goal,minutes,type:"board"|"vote"|"matrix"|"qa"|"wrapup",votable,columns:[{id,title,hint}]}],
 *   timer: {running, durationSec, endsAt (ms epoch|null), remainingMs, expired},
 *   participants: [{id,name,isFacilitator,online}],
 *   notes: [{id,stage,column,order,category,text,seed,authorId,authorName,mine,
 *            votes:{total,mine}, createdAt,updatedAt}],
 *      // authorId/authorName are null when anonymous mode is on (mine still tells you which are yours)
 *      // votes.total is null while votes are hidden (non-facilitator, not revealed); mine is always your own count
 *   entries: [{id,votes:{total,mine},placement:{mine:{x,y}|null, avg:{x,y,n}|null, quadrant|null, all:[{x,y}]}}],
 *      // avg/all/total are hidden for non-facilitators until revealed. Quadrants: quick-win, big-bet, fill-in, reconsider
 *   dots: {perParticipant, used:{<stageId>:n}, remaining:{<stageId>:n}}   // for the caller; stages: entry-vote, entry-map, assumptions
 *   questions: [{id,kind,text,owner,status:"open"|"discussing"|"decided"|"parked",decision,authorId,authorName,mine,createdAt,updatedAt}],
 *   wrapup: {topVoted:[{id,votes,avgX,avgY,quadrant}] (empty while hidden), recommendation:{mvp,postMvp,rationale},
 *            nextSteps:[{id,text,owner,type,due,authorId,authorName,mine,createdAt}]},
 *   counts: {participants, online, notes, votes} }
 *
 * Note   {id,stage,column,order,category,text,...}   category: idea|concern|question|opportunity|assumption|evidence
 * Vote   (internal) {id,pid,targetType:"entry"|"note",targetId,stage,at}   (exported by export.csv?kind=votes)
 *
 * ---------------------------------------------------------------------------------------------
 * SSE (GET /api/sessions/:id/events?token=...)   Content-Type: text/event-stream
 * ---------------------------------------------------------------------------------------------
 *   event: hello      data: {"serverTime":<ms>,"rev":<n>}                    sent once on connect
 *   event: state      data: <full personalised view JSON>                    on connect and after EVERY change
 *   event: activity   data: {"rev":<n>,"type":"note.add"|"vote.add"|...,"by":"<display name|null>"}  just before `state`
 *   event: deleted    data: {"id":"<ID>"}                                    session deleted; stream then closes
 *   : ping                                                                   comment heartbeat every 20 s
 * Browsers' EventSource reconnects automatically; the first `state` after reconnect re-syncs everything.
 *
 * Security notes: no secrets in repo; tokens/PIN stored hashed; user text is stripped of control chars and
 * HTML angle brackets and length-capped (frontend must still render with textContent); payload <= 64 KB;
 * in-memory rate limiting; CSP forbids third-party CDNs/fonts.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) >= 0 ? parseInt(process.env.PORT, 10) : 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const EXPORT_DIR = path.join(DATA_DIR, 'exports');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 64 * 1024;
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_MIN, 10) || 900;

const LIM = { title: 120, name: 40, note: 400, owner: 60, decision: 400, question: 400, rationale: 800, due: 30,
  maxNotes: 1500, maxParticipants: 300, maxQuestions: 150, maxNextSteps: 100, maxVotes: 20000 };

/* ================================================================================================
 * SEED CONTENT (from output/account/discovery-pick-up-where-you-left-off.html)
 * ============================================================================================== */
const CATEGORIES = [
  { id: 'idea', label: 'Idea', colour: '#fff3a8' },
  { id: 'concern', label: 'Concern / risk', colour: '#ffc9d4' },
  { id: 'question', label: 'Question', colour: '#c6eafb' },
  { id: 'opportunity', label: 'Opportunity', colour: '#c9f0d8' },
  { id: 'assumption', label: 'Assumption', colour: '#ffd9a3' },
  { id: 'evidence', label: 'Evidence / insight', colour: '#e3cffa' },
];
const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

const ENTRY_POINTS = [
  { id: 'A', name: 'Global header: eye icon + top-3 panel', scope: 'proposed', prio: 'P1', effort: 'M', confidence: 'Medium',
    what: 'Eye icon on every page opens a panel with the 3 last viewed (and a pinned unfinished booking). "See all" links to mySearches.',
    note: 'TUI.NL pattern. The deck proposes replacing the NL legacy viewed hotels with the mySearches MFE. Global Header is an open "?" entry point in the deck.' },
  { id: 'B', name: 'Homepage / Inspire hero area', scope: 'proposed', prio: 'P2', effort: 'S', confidence: 'Medium',
    what: '"Pick up where you left off" strip under the hero for returning visitors: unfinished booking first, then last search and views.',
    note: 'Fits Inspire goals of personalised, content-rich homepages.' },
  { id: 'C', name: 'Directly under the search form', scope: 'proposed', prio: 'P1', effort: 'S', confidence: 'High',
    what: 'Recent-search chips and a "Resume last search" action prefill destination, airport, party and dates.',
    note: 'Search is an open "?" entry point in the deck; wireframes show recent-search cards with a search button.' },
  { id: 'D', name: 'Search results page', scope: 'proposed', prio: 'P2', effort: 'M', confidence: 'Medium',
    what: 'Compact recently-viewed strip above results, plus a sticky "Continue" bar for an unfinished booking.',
    note: 'Risk of clutter above results; test with a conversion guardrail.' },
  { id: 'E', name: 'Unit (hotel) detail page', scope: 'proposed', prio: 'P2', effort: 'M', confidence: 'Medium',
    what: '"You viewed this 2 days ago" message, price-change badge and a compare strip with recently viewed hotels.',
    note: 'Helps shortlisting; needs price-change data from the cache.' },
  { id: 'F', name: 'Booking flow / checkout', scope: 'proposed', prio: 'P1', effort: 'M', confidence: 'Medium',
    what: 'Restores the booking at the step left ("step 3 of 5") and offers save for later when leaving.',
    note: 'Exit-intent pattern is an open question. Restoration depends on price and availability checks.' },
  { id: 'G', name: 'myTUI dashboard module', scope: 'mvp', prio: 'P0', effort: 'M', confidence: 'High',
    what: 'Sales-centric when there is no active booking; service and ancillaries first when there is one. Continue booking card, Recently viewed, Your recent searches.',
    note: 'In MVP scope in the deck.' },
  { id: 'H', name: 'mySearches page + "Searches" menu item', scope: 'mvp', prio: 'P0', effort: 'M', confidence: 'High',
    what: 'Dedicated page in myTUI with full lists, remove, clear all, show more. Desktop and mobile.',
    note: 'In MVP scope in the deck.' },
  { id: 'I', name: 'Post-MVP: app, Braze email/push, Concierge', scope: 'post', prio: 'P2-P3', effort: 'M-L', confidence: 'Low',
    what: 'App cross-channel resume via USL; Braze reminder for an incomplete booking and price-drop alerts (suppressed once booked); Concierge greets returning customers with a resume prompt.',
    note: 'Deck: post-MVP. AI activity summary needs Legal approval and EU AI Act review.' },
];
const ENTRY_IDS = ENTRY_POINTS.map((e) => e.id);

const STAGES = [
  { id: 'warmup', title: 'Warm-up and context', goal: 'Share what we know about continuity today and align on the problem, evidence and MVP scope.', minutes: 10, type: 'board', votable: false,
    columns: [
      { id: 'seen', title: 'Where have you seen "resume" done well?', hint: 'Sites, apps, competitors' },
      { id: 'frustrations', title: 'Where do customers lose their place?', hint: 'Pains we know about' },
      { id: 'expectations', title: 'What do you want from today?', hint: 'Hopes and worries' },
    ] },
  { id: 'entry-map', title: 'Entry-point map', goal: 'Add ideas, concerns and questions on every place where "Pick it up where you left off" could appear.', minutes: 25, type: 'board', votable: true,
    columns: ENTRY_POINTS.map((e) => ({ id: e.id, title: e.name, hint: e.scope === 'mvp' ? 'MVP scope' : e.scope === 'post' ? 'Post-MVP' : 'Proposed' })) },
  { id: 'entry-vote', title: 'Dot voting on entry points', goal: 'Place your dots on the entry points where this would matter most for customers.', minutes: 10, type: 'vote', votable: true, columns: [] },
  { id: 'prioritise', title: '2x2 prioritisation', goal: 'Place each entry point on value (up) against effort (right). The server averages everyone\'s placement.', minutes: 15, type: 'matrix', votable: false, columns: [] },
  { id: 'assumptions', title: 'Assumptions and risks', goal: 'Surface what must be true and what could go wrong, then dot-vote the riskiest.', minutes: 15, type: 'board', votable: true,
    columns: [
      { id: 'consent-privacy', title: 'Consent and privacy', hint: 'Tealium re-consent, opt-out, GDPR' },
      { id: 'guest-support', title: 'Guest support', hint: 'Outside the account?' },
      { id: 'retention-windows', title: 'Retention windows', hint: 'How long do we keep history?' },
      { id: 'just-booked-dedupe', title: 'Just-booked dedupe', hint: 'No stale items after purchase' },
      { id: 'other', title: 'Other assumptions and risks', hint: 'Clutter, performance, timing' },
    ] },
  { id: 'questions', title: 'Open questions and decisions', goal: 'Agree an owner and a status for each open question, and log decisions made.', minutes: 10, type: 'qa', votable: false, columns: [] },
  { id: 'wrapup', title: 'Wrap-up', goal: 'Review top-voted entry points, agree MVP versus post-MVP, and capture next steps and experiments with owners.', minutes: 10, type: 'wrapup', votable: false, columns: [] },
];
const STAGE_IDS = STAGES.map((s) => s.id);
const STAGE_BY_ID = Object.fromEntries(STAGES.map((s) => [s.id, s]));

const QUADRANTS = [
  { id: 'quick-win', label: 'Quick win (high value, low effort)' },
  { id: 'big-bet', label: 'Big bet (high value, high effort)' },
  { id: 'fill-in', label: 'Fill-in (lower value, low effort)' },
  { id: 'reconsider', label: 'Reconsider (lower value, high effort)' },
];

const SEED_ASSUMPTIONS = [
  { id: 'A1', text: 'Customers will accept the Tealium re-consent banner at a rate high enough to make the feature worthwhile.', type: 'Viability', test: 'Consent-rate measurement, copy test', column: 'consent-privacy' },
  { id: 'A2', text: 'A persistent header icon is discovered and understood without a label.', type: 'Usability', test: 'Unmoderated test, icon vs icon + label', column: 'other' },
  { id: 'A3', text: 'Guests value history enough to sign in to keep it.', type: 'Desirability', test: 'Fake-door / A/B on guest nudge', column: 'guest-support' },
  { id: 'A4', text: 'Several in-flow modules do not clutter search and unit pages or hurt conversion.', type: 'Desirability', test: 'A/B per entry point with guardrails', column: 'other' },
  { id: 'A5', text: 'Abandoned cart can be restored reliably at the step left (price and availability changes).', type: 'Feasibility', test: 'Spike with Booking flow team', column: 'just-booked-dedupe' },
  { id: 'A6', text: 'Engagement Events API cache latency supports a header-level widget on every page.', type: 'Feasibility', test: 'Performance spike, lazy loading and fallback', column: 'other' },
];
const SEED_RISKS = [
  { id: 'R1', title: 'Privacy and consent', source: 'Deck', text: 'Tracking via Tealium needs a re-consent banner, opt-out and GDPR handling. A header widget on every page raises the stakes if consent is declined.', column: 'consent-privacy' },
  { id: 'R2', title: 'AI summary', source: 'Deck', text: 'Post-MVP summary of activity needs Legal approval and EU AI Act review. Not in MVP.', column: 'other' },
  { id: 'R3', title: 'Duplication', source: 'Deck', text: 'Just-booked items must not keep appearing after purchase. Handle in the account layer, as Braze does.', column: 'just-booked-dedupe' },
  { id: 'R4', title: 'Clutter and conversion', source: 'Hypothesis', text: 'Too many surfaces can distract from search and checkout. Roll out per entry point with guardrail metrics.', column: 'other' },
  { id: 'R5', title: 'Performance', source: 'Hypothesis', text: 'A global header component must lazy load and fail silently so it never slows page loads.', column: 'other' },
  { id: 'R6', title: 'Delivery timing', source: 'Deck', text: 'Dev start December; go-live between December and February or Q2, depending on code freeze. Inconsistent across deck notes.', column: 'other' },
];
const SEED_QUESTIONS = [
  { id: 'Q1', text: 'Should guests see the header dropdown and in-flow modules, or is MVP strictly account-exclusive?', owner: 'PM Account Core + Search', gate: 'Research before dev start' },
  { id: 'Q2', text: 'Header entry: eye icon replacing the NL legacy "viewed hotels", or a different icon or label? Global Header and Search are open "?" entry points in the deck.', owner: 'PM + Design + Inspire pod', gate: 'Design review' },
  { id: 'Q3', text: 'Retention windows: the deck suggests about 30 days for searches and views and shorter for cart. Exact values?', owner: 'PM + Legal', gate: 'Before build' },
  { id: 'Q4', text: 'Empty states: no booking + no searches vs booking + no searches.', owner: 'PM + Design', gate: 'Design review' },
  { id: 'Q5', text: 'Who owns the in-flow modules and the checkout resume (Search, Book, Account)? Ownership undecided.', owner: 'Heads of Product', gate: 'Roadmap alignment' },
  { id: 'Q6', text: 'Exit-intent / save-for-later at checkout: acceptable pattern, and for guests too?', owner: 'PM Book + Account Core', gate: 'Experiment design' },
  { id: 'Q7', text: 'Green deals / Uniqodo codes on cards, and AI summary: post-MVP scope and Legal approval.', owner: 'PM + Legal', gate: 'Post-MVP planning' },
  { id: 'Q8', text: 'BENE markets (BE, NL, TUIFly) need outside-account support: shared component or separate path?', owner: 'PM + Tech Lead', gate: 'Post-MVP planning' },
];
const SEED = {
  categories: CATEGORIES,
  stages: STAGES,
  entryPoints: ENTRY_POINTS,
  quadrants: QUADRANTS,
  problem: {
    summary: 'Legacy markets (NL, DE) already offer recent views. The 1Web / MWA stack does not. Customer Account is approved to deliver an MVP based on Tealium search-activity tracking.',
    problems: ['Users drop off mid-booking.', 'Users forget what they viewed or searched.', 'Sessions are fragmented across devices.',
      'A classic "recently viewed" list misses an in-progress booking.', 'Abandoned bookings are lost revenue.'],
    objectives: ['Account-exclusive searches, views and abandoned cart, enabling cross-channel.', 'Boost conversion by recovering incomplete bookings.',
      'More revenue through personalised, contextual re-engagement.', 'Strengthen loyalty and trust, make the account stickier.'],
  },
  states: [
    { state: 'Guest', header: 'Open decision: show local-browser items with a sign-in nudge, or hide', inFlow: 'Same open decision', dashboard: 'n/a (needs sign-in)', mySearches: 'Sign-in gate' },
    { state: 'Signed in', header: 'Top 3 viewed, "See all" to mySearches', inFlow: 'All modules; abandoned cart takes priority', dashboard: 'Sales-centric: continue booking, recently viewed, recent searches', mySearches: 'Full lists with remove and clear all' },
    { state: 'Signed in + active booking', header: 'As signed in', inFlow: 'As signed in; just-booked hotel excluded', dashboard: 'Service and ancillaries first, then history', mySearches: 'As signed in' },
    { state: 'No history', header: 'Empty message', inFlow: 'Modules hidden, or a gentle empty state', dashboard: 'Empty state differs: no booking + no searches vs booking + no searches (open)', mySearches: 'Empty state with search CTA' },
    { state: 'Consent not given', header: 'Prompt to enable tracking', inFlow: 'Re-consent prompt instead of items', dashboard: 'Re-consent banner', mySearches: 'Re-consent banner; opt-out stays visible' },
  ],
  evidence: [
    { insight: 'NL and DE legacy sites already ship recent views; 1Web / MWA lacks them.', source: 'Deck', confidence: 'High' },
    { insight: 'TUI.NL shows an eye icon in the header; click opens a panel with the top 3 last viewed.', source: 'Deck / request', confidence: 'High (observed pattern)' },
    { insight: 'Tracking comes from Tealium events: Search, View/Select, Abandoned Cart, via the Engagement Events API cache.', source: 'Deck', confidence: 'High' },
    { insight: 'Wireframes (UX wireframes, July 2025 tested version) cover dashboard modules and a dedicated mySearches page, desktop and mobile.', source: 'Deck', confidence: 'High' },
    { insight: 'Journey pain: cannot remember viewed hotels; inconsistent across devices; hesitant at payment; lose track of in-progress bookings.', source: 'Deck', confidence: 'Medium (qualitative)' },
    { insight: 'A header entry point converts better than an in-page module because it is reachable from every page.', source: 'Hypothesis', confidence: 'Low, test it' },
    { insight: 'Showing history to guests will lift sign-ins ("keep and sync your history").', source: 'Hypothesis', confidence: 'Low, test it' },
    { insight: 'A "resume at step N" prompt recovers more bookings than email alone.', source: 'Hypothesis', confidence: 'Low, test it' },
    { insight: 'Price-drop badges on viewed items increase click-through.', source: 'Hypothesis', confidence: 'Low, test it' },
  ],
  assumptions: SEED_ASSUMPTIONS,
  risks: SEED_RISKS,
  kpis: {
    deck: ['New account registrations', 'Active accounts', 'Sales'],
    perEntryPoint: ['Impression to click-through', 'Resume rate (search, view, cart)', 'Recovered bookings and revenue', 'Guest-to-sign-in rate from nudge'],
    guardrails: ['Search-to-book conversion', 'Page load / Core Web Vitals', 'Consent opt-out rate', 'Remove / clear-all rate (relevance signal)'],
  },
  openQuestions: SEED_QUESTIONS,
  experiments: [
    { name: 'A/B: header eye vs none', metric: 'Viewing-return rate', entry: 'A' },
    { name: 'A/B: recent-search chips vs empty form', metric: 'Search-start rate', entry: 'C' },
    { name: 'A/B: guest nudge copy', metric: 'Sign-in rate', entry: 'I4 (guest)' },
    { name: 'Holdout: resume-at-step prompt vs email only', metric: 'Recovery rate by channel', entry: 'F' },
  ],
  nextSteps: {
    now: ['Dashboard module and mySearches page with re-consent banner (G, H).', 'Confirm the header "?" decision with Design and Inspire pod (A).', 'Spike: Engagement Events API latency for a global widget.'],
    next: ['A/B test: header eye, top-3 panel vs control.', 'A/B test: recent-search chips under the search form vs empty form.', 'A/B test: guest nudge copy for sign-in.', 'Holdout test: resume-at-step prompt vs email only.'],
    later: ['App via USL; Braze email and push; Concierge resume.', 'Public views outside the account; BENE markets.', 'Uniqodo deal codes; AI activity summary after Legal approval.'],
    research: ['Guest availability study (Q1).', 'Icon comprehension test (A2).', 'Consent-rate benchmarking (A1).'],
  },
};

/* ================================================================================================
 * Helpers
 * ============================================================================================== */
class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const now = () => Date.now();
const rid = (prefix) => prefix + '_' + crypto.randomBytes(5).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** Strip control chars and HTML (angle brackets), cap length. multiline keeps \n. */
function clean(v, max, multiline) {
  if (typeof v !== 'string') return '';
  let s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g, '');
  s = s.replace(/<[^>]*>/g, '').replace(/[<>]/g, '');
  s = multiline ? s.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  return s.trim().slice(0, max);
}
const num = (v, min, max, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
const bool = (v) => v === true || v === 'true';

const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newRoomCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
    if (!sessions.has(c)) return c;
  }
}
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9]{4,12}$/.test(id);

/* rate limiting (fixed window, per IP + bucket) */
const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const t = now();
  let b = buckets.get(key);
  if (!b || b.reset <= t) { b = { n: 0, reset: t + windowMs }; buckets.set(key, b); }
  b.n++;
  return b.n <= limit;
}
setInterval(() => { const t = now(); for (const [k, b] of buckets) if (b.reset <= t) buckets.delete(k); }, 60000).unref();

/* ================================================================================================
 * Persistence
 * ============================================================================================== */
const sessions = new Map(); // id -> persistent session object
const runtime = new Map(); // id -> {clients:Set, timer}
function rt(id) { let r = runtime.get(id); if (!r) { r = { clients: new Set(), pending: null }; runtime.set(id, r); } return r; }
const sessionFile = (id) => path.join(DATA_DIR, 'session-' + id + '.json');

function atomicWrite(file, data) {
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function save(s) {
  s.updatedAt = now();
  s.rev++;
  atomicWrite(sessionFile(s.id), JSON.stringify(s));
}
function loadAll() {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  for (const f of fs.readdirSync(DATA_DIR)) {
    const m = /^session-([A-Za-z0-9]{4,12})\.json$/.exec(f);
    if (!m) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      if (s && s.id === m[1]) sessions.set(s.id, s);
    } catch (e) { console.warn('Skipping unreadable session file', f, e.message); }
  }
  for (const f of fs.readdirSync(DATA_DIR)) if (f.endsWith('.tmp')) { try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch (e) { /* ignore */ } }
}

/* ================================================================================================
 * Session logic
 * ============================================================================================== */
function pinHash(pin, salt) { return crypto.scryptSync(String(pin), salt, 32).toString('hex'); }

function addParticipant(s, name, isFacilitator) {
  const token = crypto.randomBytes(24).toString('hex');
  const p = { id: rid('p'), name: clean(name, LIM.name) || 'Guest', isFacilitator: !!isFacilitator, tokenHash: sha256(token), joinedAt: now() };
  s.participants[p.id] = p;
  return { p, token };
}

function createSession(opts) {
  const id = newRoomCode();
  const pin = String(crypto.randomInt(100000, 1000000));
  const salt = crypto.randomBytes(12).toString('hex');
  const t = now();
  const s = {
    v: 1, id, title: clean(opts.title, LIM.title) || 'Pick it up where you left off: workshop',
    createdAt: t, updatedAt: t, rev: 0,
    settings: { dotsPerParticipant: Math.round(num(opts.dotsPerParticipant, 1, 50, 5)), anonymous: bool(opts.anonymous), votingLocked: false, votesRevealed: false },
    stage: STAGES[0].id,
    timer: { running: false, durationSec: 0, endsAt: null },
    pinSalt: salt, pinHash: pinHash(pin, salt),
    participants: {}, notes: [], votes: [], placements: [], questions: [], nextSteps: [],
    recommendation: { mvp: [], postMvp: [], rationale: '' },
  };
  const fac = addParticipant(s, clean(opts.facilitatorName, LIM.name) || 'Facilitator', true);
  if (opts.prefill !== false) prefill(s);
  sessions.set(id, s);
  save(s);
  console.log('\n  Session created: ' + id + '  "' + s.title + '"');
  console.log('  Facilitator PIN: ' + pin + '   (keep private; shown once)');
  return { s, pin, token: fac.token, participant: fac.p };
}

function prefill(s) {
  const t = now();
  let order = {};
  const addNote = (stage, column, category, text) => {
    const k = stage + '|' + column; order[k] = (order[k] || 0) + 1;
    s.notes.push({ id: rid('n'), stage, column, order: order[k], category, text: clean(text, LIM.note, true), authorId: null, authorName: 'Discovery pack', seed: true, createdAt: t, updatedAt: t });
  };
  for (const a of SEED_ASSUMPTIONS) addNote('assumptions', a.column, 'assumption', a.id + ' (' + a.type + '): ' + a.text);
  for (const r of SEED_RISKS) addNote('assumptions', r.column, 'concern', r.title + ': ' + r.text);
  for (const q of SEED_QUESTIONS) {
    s.questions.push({ id: rid('q'), kind: 'question', text: clean(q.id + ': ' + q.text, LIM.question), owner: clean(q.owner, LIM.owner), status: 'open', decision: '', gate: clean(q.gate, LIM.owner), authorId: null, authorName: 'Discovery pack', seed: true, createdAt: t, updatedAt: t });
  }
}

function getSession(id) {
  if (!validId(id)) throw new HttpError(404, 'not_found', 'Session not found');
  const s = sessions.get(String(id).toUpperCase());
  if (!s) throw new HttpError(404, 'not_found', 'Session not found');
  return s;
}

function viewerFrom(s, req, url) {
  let tok = '';
  const h = req.headers.authorization || '';
  if (/^Bearer /i.test(h)) tok = h.slice(7).trim();
  if (!tok) tok = url.searchParams.get('token') || '';
  if (!tok || tok.length > 200) return null;
  const hh = sha256(tok);
  for (const p of Object.values(s.participants)) if (safeEq(p.tokenHash, hh)) return p;
  return null;
}
function requireViewer(s, req, url) {
  const v = viewerFrom(s, req, url);
  if (!v) throw new HttpError(401, 'unauthorized', 'Join the session first');
  return v;
}
function requireFacilitator(s, req, url) {
  const v = requireViewer(s, req, url);
  if (!v.isFacilitator) throw new HttpError(403, 'forbidden', 'Facilitator only');
  return v;
}

/* ----- aggregation ----- */
function quadrantOf(x, y) { return y >= 50 ? (x < 50 ? 'quick-win' : 'big-bet') : (x < 50 ? 'fill-in' : 'reconsider'); }
function voteCounts(s) {
  const total = {}; const byP = {};
  for (const v of s.votes) {
    const k = v.targetType + ':' + v.targetId;
    total[k] = (total[k] || 0) + 1;
    (byP[v.pid] || (byP[v.pid] = {}))[k] = ((byP[v.pid] || {})[k] || 0) + 1;
  }
  return { total, byP };
}
function entryStats(s) {
  const vc = voteCounts(s);
  return ENTRY_IDS.map((id) => {
    const pl = s.placements.filter((p) => p.entryId === id);
    const n = pl.length;
    const avg = n ? { x: Math.round(pl.reduce((a, p) => a + p.x, 0) / n * 10) / 10, y: Math.round(pl.reduce((a, p) => a + p.y, 0) / n * 10) / 10, n } : null;
    return { id, votes: vc.total['entry:' + id] || 0, placements: pl, avg, quadrant: avg ? quadrantOf(avg.x, avg.y) : null };
  });
}
function dotsUsed(s, pid) {
  const used = {};
  for (const v of s.votes) if (v.pid === pid) used[v.stage] = (used[v.stage] || 0) + 1;
  return used;
}

/** Personalised view. viewer = participant or null (read-only). */
function buildView(s, viewer) {
  const fac = !!(viewer && viewer.isFacilitator);
  const anon = s.settings.anonymous;
  const showAgg = fac || s.settings.votesRevealed || (!viewer && s.stage === 'wrapup');
  const vc = voteCounts(s);
  const mineV = viewer ? (vc.byP[viewer.id] || {}) : {};
  const rtm = rt(s.id);
  const online = new Set(); for (const c of rtm.clients) if (c.pid) online.add(c.pid);
  const nameOf = (id, fallback) => (anon ? null : (id && s.participants[id] ? s.participants[id].name : (fallback || null)));
  const idOf = (id) => (anon ? null : (id || null));
  const t = now();
  const tm = s.timer;
  const remainingMs = tm.running && tm.endsAt ? Math.max(0, tm.endsAt - t) : 0;
  const stats = entryStats(s);
  const used = viewer ? dotsUsed(s, viewer.id) : {};
  const remaining = {};
  for (const st of STAGES) if (st.votable || st.id === 'entry-vote') remaining[st.id] = Math.max(0, s.settings.dotsPerParticipant - (used[st.id] || 0));

  const entries = stats.map((e) => ({
    id: e.id,
    votes: { total: showAgg ? e.votes : null, mine: mineV['entry:' + e.id] || 0 },
    placement: {
      mine: viewer ? ((e.placements.find((p) => p.pid === viewer.id) || null) && { x: e.placements.find((p) => p.pid === viewer.id).x, y: e.placements.find((p) => p.pid === viewer.id).y }) : null,
      avg: showAgg ? e.avg : null,
      quadrant: showAgg ? e.quadrant : null,
      all: showAgg ? e.placements.map((p) => ({ x: p.x, y: p.y })) : [],
    },
  }));
  const topVoted = showAgg ? stats.filter((e) => e.votes > 0).sort((a, b) => b.votes - a.votes || ENTRY_IDS.indexOf(a.id) - ENTRY_IDS.indexOf(b.id))
    .map((e) => ({ id: e.id, votes: e.votes, avgX: e.avg ? e.avg.x : null, avgY: e.avg ? e.avg.y : null, quadrant: e.quadrant })) : [];

  return {
    rev: s.rev, serverTime: t, id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt,
    readOnly: !viewer, me: viewer ? { id: viewer.id, name: viewer.name, isFacilitator: viewer.isFacilitator } : null,
    settings: { ...s.settings },
    stage: s.stage, stageIndex: STAGE_IDS.indexOf(s.stage),
    stages: STAGES,
    timer: { running: tm.running, durationSec: tm.durationSec, endsAt: tm.endsAt, remainingMs, expired: !!(tm.running && tm.endsAt && tm.endsAt <= t) },
    participants: Object.values(s.participants).map((p) => ({ id: p.id, name: p.name, isFacilitator: p.isFacilitator, online: online.has(p.id) })),
    notes: s.notes.slice().sort((a, b) => a.order - b.order).map((n) => ({
      id: n.id, stage: n.stage, column: n.column, order: n.order, category: n.category, text: n.text, seed: !!n.seed,
      authorId: n.seed ? null : idOf(n.authorId), authorName: n.seed ? n.authorName : nameOf(n.authorId),
      mine: !!(viewer && n.authorId === viewer.id),
      votes: { total: showAgg ? (vc.total['note:' + n.id] || 0) : null, mine: mineV['note:' + n.id] || 0 },
      createdAt: n.createdAt, updatedAt: n.updatedAt,
    })),
    entries,
    dots: { perParticipant: s.settings.dotsPerParticipant, used, remaining },
    questions: s.questions.map((q) => ({
      id: q.id, kind: q.kind, text: q.text, owner: q.owner, status: q.status, decision: q.decision, gate: q.gate || '', seed: !!q.seed,
      authorId: q.seed ? null : idOf(q.authorId), authorName: q.seed ? q.authorName : nameOf(q.authorId),
      mine: !!(viewer && q.authorId === viewer.id), createdAt: q.createdAt, updatedAt: q.updatedAt,
    })),
    wrapup: {
      topVoted, recommendation: s.recommendation,
      nextSteps: s.nextSteps.map((n) => ({ id: n.id, text: n.text, owner: n.owner, type: n.type, due: n.due, authorId: idOf(n.authorId), authorName: nameOf(n.authorId), mine: !!(viewer && n.authorId === viewer.id), createdAt: n.createdAt })),
    },
    counts: { participants: Object.keys(s.participants).length, online: online.size, notes: s.notes.length, votes: s.votes.length },
  };
}

/* ----- SSE ----- */
function sseSend(res, event, data) { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); }
function broadcast(s, type, by) {
  const r = rt(s.id);
  if (!r.clients.size) return;
  for (const c of r.clients) {
    try {
      sseSend(c.res, 'activity', { rev: s.rev, type, by: s.settings.anonymous ? null : (by || null) });
      sseSend(c.res, 'state', buildView(s, c.pid ? s.participants[c.pid] || null : null));
    } catch (e) { r.clients.delete(c); }
  }
}
/** persist + notify. */
function commit(s, type, viewer) { save(s); broadcast(s, type, viewer && viewer.name); }

/* ----- mutations ----- */
function stageOrThrow(id) { if (!STAGE_BY_ID[id]) throw new HttpError(400, 'bad_stage', 'Unknown stage'); return STAGE_BY_ID[id]; }
function columnsOf(stageId) { return STAGE_BY_ID[stageId].columns.map((c) => c.id); }

function placeNote(s, note, column, index) {
  const siblings = s.notes.filter((n) => n.stage === note.stage && n.column === column && n.id !== note.id).sort((a, b) => a.order - b.order);
  const i = index === undefined ? siblings.length : Math.max(0, Math.min(siblings.length, Math.round(index)));
  siblings.splice(i, 0, note);
  note.column = column;
  siblings.forEach((n, k) => { n.order = k + 1; });
}

function canEdit(item, viewer) { return viewer.isFacilitator || (item.authorId && item.authorId === viewer.id); }
function findIn(arr, id, label) { const x = arr.find((i) => i.id === id); if (!x) throw new HttpError(404, 'not_found', label + ' not found'); return x; }

const QSTATUS = ['open', 'discussing', 'decided', 'parked'];
const NSTYPES = ['experiment', 'action', 'research'];

function cleanEntryList(arr) { return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && ENTRY_IDS.includes(x)).filter((x, i, a) => a.indexOf(x) === i) : []; }

/* ================================================================================================
 * Exports
 * ============================================================================================== */
const mdEsc = (t) => String(t == null ? '' : t).replace(/\r?\n/g, ' ').replace(/([\\`*_{}\[\]|#])/g, '\\$1');
const csvCell = (v) => {
  let t = String(v == null ? '' : v).replace(/\r?\n/g, ' ');
  if (/^[=+\-@\t]/.test(t)) t = "'" + t; // neutralise spreadsheet formulas
  return '"' + t.replace(/"/g, '""') + '"';
};
const csvRow = (arr) => arr.map(csvCell).join(',');
const iso = (t) => new Date(t).toISOString();
const entryName = (id) => (ENTRY_POINTS.find((e) => e.id === id) || { name: id }).name;
const authorLabel = (s, id) => (s.settings.anonymous ? 'Anonymous' : (id && s.participants[id] ? s.participants[id].name : 'Discovery pack'));

function buildMarkdown(s) {
  const stats = entryStats(s);
  const L = [];
  L.push('# ' + mdEsc(s.title), '');
  L.push('- Session: `' + s.id + '`', '- Created: ' + iso(s.createdAt), '- Last update: ' + iso(s.updatedAt),
    '- Participants: ' + Object.keys(s.participants).length, '- Dots per participant (per voting stage): ' + s.settings.dotsPerParticipant,
    '- Anonymous mode: ' + (s.settings.anonymous ? 'on' : 'off'), '- Notes: ' + s.notes.length + ', dots: ' + s.votes.length, '');
  L.push('## Top voted entry points', '');
  const ranked = stats.slice().sort((a, b) => b.votes - a.votes || ENTRY_IDS.indexOf(a.id) - ENTRY_IDS.indexOf(b.id));
  L.push('| Rank | Entry point | Dots | Avg effort | Avg value | 2x2 quadrant |', '|---|---|---|---|---|---|');
  ranked.forEach((e, i) => L.push('| ' + (i + 1) + ' | ' + e.id + ' ' + mdEsc(entryName(e.id)) + ' | ' + e.votes + ' | ' + (e.avg ? e.avg.x : '-') + ' | ' + (e.avg ? e.avg.y : '-') + ' | ' + (e.quadrant || '-') + ' |'));
  L.push('', '## 2x2 prioritisation (x = effort, y = value, 0 to 100)', '');
  L.push('| Entry point | Placements | Avg effort | Avg value | Quadrant | Individual placements (x,y) |', '|---|---|---|---|---|---|');
  stats.forEach((e) => L.push('| ' + e.id + ' ' + mdEsc(entryName(e.id)) + ' | ' + e.placements.length + ' | ' + (e.avg ? e.avg.x : '-') + ' | ' + (e.avg ? e.avg.y : '-') + ' | ' + (e.quadrant || '-') + ' | ' + (e.placements.map((p) => '(' + p.x + ',' + p.y + ')').join(' ') || '-') + ' |'));
  const vc = voteCounts(s);
  L.push('', '## Notes by stage and category', '');
  for (const st of STAGES) {
    const notes = s.notes.filter((n) => n.stage === st.id);
    if (!notes.length) continue;
    L.push('### ' + mdEsc(st.title), '');
    const cols = st.columns.length ? st.columns : [{ id: '', title: '' }];
    for (const col of cols) {
      const inCol = notes.filter((n) => n.column === col.id).sort((a, b) => a.order - b.order);
      if (!inCol.length) continue;
      if (col.title) L.push('#### ' + mdEsc(col.title), '');
      for (const cat of CATEGORIES) {
        const group = inCol.filter((n) => n.category === cat.id);
        if (!group.length) continue;
        L.push('**' + cat.label + '**', '');
        group.forEach((n) => L.push('- ' + mdEsc(n.text) + ' (' + (vc.total['note:' + n.id] || 0) + ' dots, ' + mdEsc(authorLabel(s, n.authorId)) + ')'));
        L.push('');
      }
    }
  }
  const qs = s.questions.filter((q) => q.kind === 'question');
  const ds = s.questions.filter((q) => q.kind === 'decision');
  L.push('## Open questions', '');
  if (!qs.length) L.push('_None recorded._');
  qs.forEach((q) => L.push('- [' + q.status + '] ' + mdEsc(q.text) + ' Owner: ' + mdEsc(q.owner || 'unassigned') + (q.decision ? '. Answer: ' + mdEsc(q.decision) : '')));
  L.push('', '## Decisions', '');
  if (!ds.length) L.push('_None recorded._');
  ds.forEach((q) => L.push('- [' + q.status + '] ' + mdEsc(q.text) + ' Owner: ' + mdEsc(q.owner || 'unassigned') + (q.decision ? '. Decision: ' + mdEsc(q.decision) : '')));
  const rec = s.recommendation;
  L.push('', '## MVP vs post-MVP recommendation', '');
  L.push('- MVP: ' + (rec.mvp.length ? rec.mvp.map((i) => i + ' ' + mdEsc(entryName(i))).join('; ') : '_not set_'));
  L.push('- Post-MVP: ' + (rec.postMvp.length ? rec.postMvp.map((i) => i + ' ' + mdEsc(entryName(i))).join('; ') : '_not set_'));
  if (rec.rationale) L.push('- Rationale: ' + mdEsc(rec.rationale));
  L.push('', '## Next steps and experiments', '');
  if (!s.nextSteps.length) L.push('_None recorded._');
  s.nextSteps.forEach((n) => L.push('- [' + n.type + '] ' + mdEsc(n.text) + ' Owner: ' + mdEsc(n.owner || 'unassigned') + (n.due ? ', due ' + mdEsc(n.due) : '')));
  L.push('', '_Exported ' + iso(now()) + '. Dot counts and 2x2 positions are from all participants._', '');
  return L.join('\n');
}

function buildCsv(s, kind) {
  const nm = (id) => authorLabel(s, id);
  const rows = [];
  if (kind === 'votes') {
    rows.push(csvRow(['stage', 'target_type', 'target_id', 'target_label', 'participant', 'at']));
    for (const v of s.votes) {
      const label = v.targetType === 'entry' ? entryName(v.targetId) : ((s.notes.find((n) => n.id === v.targetId) || {}).text || '');
      rows.push(csvRow([v.stage, v.targetType, v.targetId, label, nm(v.pid), iso(v.at)]));
    }
  } else if (kind === 'placements') {
    rows.push(csvRow(['entry_id', 'entry_name', 'participant', 'effort_x', 'value_y', 'quadrant']));
    for (const p of s.placements) rows.push(csvRow([p.entryId, entryName(p.entryId), nm(p.pid), p.x, p.y, quadrantOf(p.x, p.y)]));
  } else {
    const vc = voteCounts(s);
    rows.push(csvRow(['note_id', 'stage', 'column', 'category', 'text', 'author', 'dots', 'created_at']));
    for (const n of s.notes) rows.push(csvRow([n.id, n.stage, n.column, n.category, n.text, nm(n.authorId), vc.total['note:' + n.id] || 0, iso(n.createdAt)]));
  }
  return '\uFEFF' + rows.join('\r\n') + '\r\n';
}

function rawExport(s) {
  const copy = JSON.parse(JSON.stringify(s));
  delete copy.pinHash; delete copy.pinSalt;
  for (const p of Object.values(copy.participants)) delete p.tokenHash;
  return copy;
}

function saveMarkdown(s) {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const md = buildMarkdown(s);
  const file = 'session-' + s.id + '-' + now() + '.md';
  atomicWrite(path.join(EXPORT_DIR, file), md);
  return { file, markdown: md };
}

/* ================================================================================================
 * HTTP plumbing
 * ============================================================================================== */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.map': 'application/json' };
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function sendJson(res, status, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...SEC_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...(extra || {}) });
  res.end(body);
}
function sendText(res, status, text, type, filename) {
  const h = { ...SEC_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) };
  if (filename) h['Content-Disposition'] = 'attachment; filename="' + filename + '"';
  res.writeHead(status, h); res.end(text);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (['GET', 'HEAD'].includes(req.method)) return resolve({});
    const len = parseInt(req.headers['content-length'], 10);
    if (len > MAX_BODY) { req.resume(); return reject(new HttpError(413, 'too_large', 'Payload too large')); }
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'too_large', 'Payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        const o = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(o && typeof o === 'object' && !Array.isArray(o) ? o : {});
      } catch (e) { reject(new HttpError(400, 'bad_json', 'Invalid JSON')); }
    });
    req.on('error', () => reject(new HttpError(400, 'bad_request', 'Request error')));
  });
}

const DISCOVERY_ROUTE = '/discovery/pick-up-where-you-left-off.html';
const DISCOVERY_FILE = path.resolve(__dirname, '..', 'account', 'discovery-pick-up-where-you-left-off.html');
/* Read-only: serves exactly one fixed file (no user-controlled path). Relaxed CSP so the prototype's own inline script/style work. */
function serveDiscovery(req, res) {
  fs.stat(DISCOVERY_FILE, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'Not found', 'text/plain; charset=utf-8');
    res.writeHead(200, { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'",
      'Content-Type': 'text/html; charset=utf-8', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(DISCOVERY_FILE).pipe(res);
  });
}
function serveStatic(req, res, pathname) {
  if (pathname === DISCOVERY_ROUTE) return serveDiscovery(req, res);
  let rel = pathname;
  if (rel === '/' || /^\/s\/[A-Za-z0-9]{4,12}\/?$/.test(rel)) rel = '/index.html';
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch (e) { return sendText(res, 400, 'Bad request', 'text/plain; charset=utf-8'); }
  if (decoded.includes('\0')) return sendText(res, 400, 'Bad request', 'text/plain; charset=utf-8');
  const file = path.normalize(path.join(PUBLIC_DIR, decoded));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return sendText(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'Not found', 'text/plain; charset=utf-8');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ================================================================================================
 * Routes
 * ============================================================================================== */
async function handleApi(req, res, url) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (!rateLimit('g:' + ip, RATE_LIMIT, 60000)) throw new HttpError(429, 'rate_limited', 'Too many requests, slow down');
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const m = req.method;
  const seg = parts.slice(1);

  if (seg[0] === 'health' && m === 'GET') return sendJson(res, 200, { ok: true, time: now() });
  if (seg[0] === 'seed' && m === 'GET') return sendJson(res, 200, SEED);

  if (seg[0] !== 'sessions') throw new HttpError(404, 'not_found', 'Unknown endpoint');

  /* collection */
  if (seg.length === 1) {
    if (m === 'GET') {
      const list = [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((s) => ({
        id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, stage: s.stage,
        participants: Object.keys(s.participants).length, notes: s.notes.length, votes: s.votes.length }));
      return sendJson(res, 200, { sessions: list });
    }
    if (m === 'POST') {
      if (!rateLimit('c:' + ip, 30, 60000)) throw new HttpError(429, 'rate_limited', 'Too many sessions created');
      const body = await readBody(req);
      const r = createSession(body);
      return sendJson(res, 201, { id: r.s.id, title: r.s.title, facilitatorPin: r.pin, token: r.token,
        participant: { id: r.participant.id, name: r.participant.name, isFacilitator: true }, joinPath: '/s/' + r.s.id });
    }
    throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
  }

  const s = getSession(seg[1]);
  const sub = seg[2];
  const arg = seg[3];

  if (!sub) {
    if (m === 'GET') return sendJson(res, 200, { id: s.id, title: s.title, stage: s.stage, exists: true });
    if (m === 'DELETE') {
      const v = requireFacilitator(s, req, url);
      void v;
      const r = rt(s.id);
      for (const c of r.clients) { try { sseSend(c.res, 'deleted', { id: s.id }); c.res.end(); } catch (e) { /* ignore */ } }
      runtime.delete(s.id); sessions.delete(s.id);
      try { fs.unlinkSync(sessionFile(s.id)); } catch (e) { /* ignore */ }
      try { for (const f of fs.readdirSync(EXPORT_DIR)) if (f.startsWith('session-' + s.id + '-')) fs.unlinkSync(path.join(EXPORT_DIR, f)); } catch (e) { /* ignore */ }
      console.log('  Session deleted: ' + s.id);
      return sendJson(res, 200, { ok: true, deleted: s.id });
    }
    throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
  }

  if (sub === 'join' && m === 'POST') {
    const body = await readBody(req);
    if (typeof body.token === 'string' && body.token) {
      const hh = sha256(body.token);
      const p = Object.values(s.participants).find((x) => safeEq(x.tokenHash, hh));
      if (p) return sendJson(res, 200, { token: body.token, participant: { id: p.id, name: p.name, isFacilitator: p.isFacilitator } });
    }
    const name = clean(body.name, LIM.name);
    if (!name) throw new HttpError(400, 'name_required', 'Please enter a display name');
    let fac = false;
    if (body.pin !== undefined && body.pin !== '') {
      if (!rateLimit('pin:' + ip + ':' + s.id, 10, 300000)) throw new HttpError(429, 'rate_limited', 'Too many PIN attempts');
      if (!safeEq(pinHash(String(body.pin).slice(0, 40), s.pinSalt), s.pinHash)) throw new HttpError(403, 'bad_pin', 'Wrong facilitator PIN');
      fac = true;
    }
    if (Object.keys(s.participants).length >= LIM.maxParticipants) throw new HttpError(409, 'session_full', 'Session is full');
    const { p, token } = addParticipant(s, name, fac);
    commit(s, 'participant.join', p);
    return sendJson(res, 200, { token, participant: { id: p.id, name: p.name, isFacilitator: p.isFacilitator } });
  }

  if ((sub === 'state' || sub === 'readonly') && m === 'GET') {
    const v = sub === 'readonly' ? null : viewerFrom(s, req, url);
    return sendJson(res, 200, buildView(s, v));
  }

  if (sub === 'events' && m === 'GET') {
    const v = viewerFrom(s, req, url);
    const r = rt(s.id);
    if (r.clients.size >= 400) throw new HttpError(503, 'busy', 'Too many live connections');
    res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const client = { res, pid: v ? v.id : null };
    r.clients.add(client);
    sseSend(res, 'hello', { serverTime: now(), rev: s.rev });
    sseSend(res, 'state', buildView(s, v));
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* closed */ } }, 20000);
    req.on('close', () => { clearInterval(hb); r.clients.delete(client); if (sessions.has(s.id)) broadcastPresence(s); });
    if (v) broadcastPresence(s);
    return undefined;
  }

  /* ---- downloads (facilitator) ---- */
  if (sub === 'export.md' && m === 'GET') {
    requireFacilitator(s, req, url);
    const r = saveMarkdown(s);
    return sendText(res, 200, r.markdown, 'text/markdown; charset=utf-8', r.file);
  }
  if (sub === 'export.csv' && m === 'GET') {
    requireFacilitator(s, req, url);
    const kind = ['notes', 'votes', 'placements'].includes(url.searchParams.get('kind')) ? url.searchParams.get('kind') : 'notes';
    return sendText(res, 200, buildCsv(s, kind), 'text/csv; charset=utf-8', 'session-' + s.id + '-' + kind + '.csv');
  }
  if (sub === 'export.json' && m === 'GET') {
    requireFacilitator(s, req, url);
    return sendText(res, 200, JSON.stringify(rawExport(s), null, 2), 'application/json; charset=utf-8', 'session-' + s.id + '.json');
  }
  if (sub === 'exports' && m === 'GET' && arg) {
    requireFacilitator(s, req, url);
    if (!new RegExp('^session-' + s.id + '-\\d+\\.md$').test(arg)) throw new HttpError(404, 'not_found', 'Export not found');
    let txt; try { txt = fs.readFileSync(path.join(EXPORT_DIR, arg), 'utf8'); } catch (e) { throw new HttpError(404, 'not_found', 'Export not found'); }
    return sendText(res, 200, txt, 'text/markdown; charset=utf-8', arg);
  }
  if (sub === 'export' && m === 'POST') {
    requireFacilitator(s, req, url);
    const r = saveMarkdown(s);
    return sendJson(res, 200, { file: r.file, downloadUrl: '/api/sessions/' + s.id + '/exports/' + r.file, markdown: r.markdown });
  }

  /* ---- everything below mutates ---- */
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
  const viewer = requireViewer(s, req, url);
  const body = await readBody(req);
  if (m === 'DELETE' && !Object.keys(body).length) { for (const [k, val] of url.searchParams) if (k !== 'token') body[k] = val; }
  const ok = (type, extra) => { commit(s, type, viewer); return sendJson(res, 200, { ok: true, rev: s.rev, ...(extra || {}) }); };

  /* notes */
  if (sub === 'notes') {
    if (m === 'POST' && !arg) {
      if (s.notes.length >= LIM.maxNotes) throw new HttpError(409, 'limit', 'Note limit reached');
      const st = stageOrThrow(body.stage);
      if (!columnsOf(st.id).length) throw new HttpError(400, 'bad_stage', 'This stage has no board');
      if (!columnsOf(st.id).includes(body.column)) throw new HttpError(400, 'bad_column', 'Unknown column');
      const text = clean(body.text, LIM.note, true);
      if (!text) throw new HttpError(400, 'text_required', 'Note text required');
      const category = CATEGORY_IDS.includes(body.category) ? body.category : 'idea';
      const t = now();
      const note = { id: rid('n'), stage: st.id, column: body.column, order: 0, category, text, authorId: viewer.id, authorName: viewer.name, createdAt: t, updatedAt: t };
      s.notes.push(note);
      placeNote(s, note, body.column);
      commit(s, 'note.add', viewer);
      return sendJson(res, 201, { ok: true, rev: s.rev, note: { id: note.id, stage: note.stage, column: note.column, order: note.order, category, text } });
    }
    if (arg) {
      const note = findIn(s.notes, arg, 'Note');
      if (m === 'DELETE') {
        if (!canEdit(note, viewer)) throw new HttpError(403, 'forbidden', 'You can only delete your own notes');
        s.notes = s.notes.filter((n) => n.id !== note.id);
        s.votes = s.votes.filter((v) => !(v.targetType === 'note' && v.targetId === note.id));
        return ok('note.delete');
      }
      if (m === 'PATCH') {
        if (!canEdit(note, viewer)) throw new HttpError(403, 'forbidden', 'You can only edit your own notes');
        if (body.text !== undefined) { const t = clean(body.text, LIM.note, true); if (!t) throw new HttpError(400, 'text_required', 'Note text required'); note.text = t; }
        if (body.category !== undefined) { if (!CATEGORY_IDS.includes(body.category)) throw new HttpError(400, 'bad_category', 'Unknown category'); note.category = body.category; }
        if (body.column !== undefined) {
          if (!columnsOf(note.stage).includes(body.column)) throw new HttpError(400, 'bad_column', 'Unknown column');
          placeNote(s, note, body.column, body.index === undefined ? undefined : num(body.index, 0, 100000, 0));
        } else if (body.index !== undefined) {
          placeNote(s, note, note.column, num(body.index, 0, 100000, 0));
        }
        note.updatedAt = now();
        return ok(body.column !== undefined || body.index !== undefined ? 'note.move' : 'note.edit');
      }
    }
  }

  /* votes (dots) */
  if (sub === 'votes' && !arg) {
    const targetType = body.targetType; const targetId = typeof body.targetId === 'string' ? body.targetId : '';
    let stage;
    if (targetType === 'entry') {
      if (!ENTRY_IDS.includes(targetId)) throw new HttpError(400, 'bad_target', 'Unknown entry point');
      stage = 'entry-vote';
    } else if (targetType === 'note') {
      const n = s.notes.find((x) => x.id === targetId);
      if (!n) throw new HttpError(404, 'not_found', 'Note not found');
      if (!STAGE_BY_ID[n.stage].votable) throw new HttpError(400, 'not_votable', 'Notes in this stage cannot be voted on');
      stage = n.stage;
    } else throw new HttpError(400, 'bad_target', 'targetType must be "entry" or "note"');
    if (m === 'POST') {
      if (s.settings.votingLocked) throw new HttpError(423, 'voting_locked', 'Voting is locked');
      if (s.votes.length >= LIM.maxVotes) throw new HttpError(409, 'limit', 'Vote limit reached');
      const used = s.votes.filter((v) => v.pid === viewer.id && v.stage === stage).length;
      if (used >= s.settings.dotsPerParticipant) throw new HttpError(409, 'no_dots_left', 'You have used all your dots for this stage');
      s.votes.push({ id: rid('v'), pid: viewer.id, targetType, targetId, stage, at: now() });
      return ok('vote.add', { used: used + 1, remaining: s.settings.dotsPerParticipant - used - 1 });
    }
    if (m === 'DELETE') {
      if (s.settings.votingLocked) throw new HttpError(423, 'voting_locked', 'Voting is locked');
      let idx = -1;
      for (let i = s.votes.length - 1; i >= 0; i--) { const v = s.votes[i]; if (v.pid === viewer.id && v.targetType === targetType && v.targetId === targetId) { idx = i; break; } }
      if (idx < 0) throw new HttpError(404, 'not_found', 'You have no dot there');
      s.votes.splice(idx, 1);
      const used = s.votes.filter((v) => v.pid === viewer.id && v.stage === stage).length;
      return ok('vote.remove', { used, remaining: Math.max(0, s.settings.dotsPerParticipant - used) });
    }
  }

  /* 2x2 placements */
  if (sub === 'placements' && arg) {
    if (!ENTRY_IDS.includes(arg)) throw new HttpError(400, 'bad_target', 'Unknown entry point');
    if (m === 'PUT') {
      if (s.settings.votingLocked) throw new HttpError(423, 'voting_locked', 'Voting is locked');
      if (!Number.isFinite(Number(body.x)) || !Number.isFinite(Number(body.y))) throw new HttpError(400, 'bad_position', 'x and y required (0..100)');
      const x = Math.round(num(body.x, 0, 100, 50) * 10) / 10; const y = Math.round(num(body.y, 0, 100, 50) * 10) / 10;
      const ex = s.placements.find((p) => p.entryId === arg && p.pid === viewer.id);
      if (ex) { ex.x = x; ex.y = y; ex.at = now(); } else s.placements.push({ entryId: arg, pid: viewer.id, x, y, at: now() });
      return ok('placement.set', { x, y });
    }
    if (m === 'DELETE') {
      if (s.settings.votingLocked) throw new HttpError(423, 'voting_locked', 'Voting is locked');
      s.placements = s.placements.filter((p) => !(p.entryId === arg && p.pid === viewer.id));
      return ok('placement.remove');
    }
  }

  /* questions & decisions */
  if (sub === 'questions') {
    const apply = (q, b) => {
      if (b.text !== undefined) { const t = clean(b.text, LIM.question); if (!t) throw new HttpError(400, 'text_required', 'Text required'); q.text = t; }
      if (b.owner !== undefined) q.owner = clean(b.owner, LIM.owner);
      if (b.decision !== undefined) q.decision = clean(b.decision, LIM.decision, true);
      if (b.status !== undefined) { if (!QSTATUS.includes(b.status)) throw new HttpError(400, 'bad_status', 'Status must be one of ' + QSTATUS.join(', ')); q.status = b.status; }
      if (b.kind !== undefined) { if (!['question', 'decision'].includes(b.kind)) throw new HttpError(400, 'bad_kind', 'kind must be question or decision'); q.kind = b.kind; }
      q.updatedAt = now();
    };
    if (m === 'POST' && !arg) {
      if (s.questions.length >= LIM.maxQuestions) throw new HttpError(409, 'limit', 'Limit reached');
      const t = now();
      const q = { id: rid('q'), kind: 'question', text: '', owner: '', status: 'open', decision: '', authorId: viewer.id, authorName: viewer.name, createdAt: t, updatedAt: t };
      apply(q, body);
      if (!q.text) throw new HttpError(400, 'text_required', 'Text required');
      s.questions.push(q);
      commit(s, 'question.add', viewer);
      return sendJson(res, 201, { ok: true, rev: s.rev, item: { id: q.id, kind: q.kind, text: q.text, owner: q.owner, status: q.status, decision: q.decision } });
    }
    if (arg) {
      const q = findIn(s.questions, arg, 'Item');
      if (!canEdit(q, viewer)) throw new HttpError(403, 'forbidden', 'Only the author or facilitator can change this item');
      if (m === 'PATCH') { apply(q, body); return ok('question.edit'); }
      if (m === 'DELETE') { s.questions = s.questions.filter((x) => x.id !== q.id); return ok('question.delete'); }
    }
  }

  /* next steps */
  if (sub === 'nextsteps') {
    const apply = (n, b) => {
      if (b.text !== undefined) { const t = clean(b.text, LIM.question); if (!t) throw new HttpError(400, 'text_required', 'Text required'); n.text = t; }
      if (b.owner !== undefined) n.owner = clean(b.owner, LIM.owner);
      if (b.due !== undefined) n.due = clean(b.due, LIM.due);
      if (b.type !== undefined) { if (!NSTYPES.includes(b.type)) throw new HttpError(400, 'bad_type', 'type must be ' + NSTYPES.join(', ')); n.type = b.type; }
    };
    if (m === 'POST' && !arg) {
      if (s.nextSteps.length >= LIM.maxNextSteps) throw new HttpError(409, 'limit', 'Limit reached');
      const n = { id: rid('s'), text: '', owner: '', type: 'action', due: '', authorId: viewer.id, createdAt: now() };
      apply(n, body);
      if (!n.text) throw new HttpError(400, 'text_required', 'Text required');
      s.nextSteps.push(n);
      commit(s, 'nextstep.add', viewer);
      return sendJson(res, 201, { ok: true, rev: s.rev, item: { id: n.id, text: n.text, owner: n.owner, type: n.type, due: n.due } });
    }
    if (arg) {
      const n = findIn(s.nextSteps, arg, 'Item');
      if (!canEdit(n, viewer)) throw new HttpError(403, 'forbidden', 'Only the author or facilitator can change this item');
      if (m === 'PATCH') { apply(n, body); return ok('nextstep.edit'); }
      if (m === 'DELETE') { s.nextSteps = s.nextSteps.filter((x) => x.id !== n.id); return ok('nextstep.delete'); }
    }
  }

  /* ---- facilitator-only ---- */
  const FAC = ['voting', 'reveal', 'settings', 'stage', 'timer', 'clear', 'recommendation'];
  if (FAC.includes(sub)) {
    if (!viewer.isFacilitator) throw new HttpError(403, 'forbidden', 'Facilitator only');
    if (sub === 'voting' && m === 'POST') { s.settings.votingLocked = bool(body.locked); return ok(s.settings.votingLocked ? 'voting.lock' : 'voting.unlock'); }
    if (sub === 'reveal' && m === 'POST') { s.settings.votesRevealed = bool(body.revealed); return ok(s.settings.votesRevealed ? 'votes.reveal' : 'votes.hide'); }
    if (sub === 'settings' && m === 'POST') {
      if (body.anonymous !== undefined) s.settings.anonymous = bool(body.anonymous);
      if (body.dotsPerParticipant !== undefined) s.settings.dotsPerParticipant = Math.round(num(body.dotsPerParticipant, 1, 50, 5));
      if (body.title !== undefined) { const t = clean(body.title, LIM.title); if (t) s.title = t; }
      return ok('settings.update');
    }
    if (sub === 'stage' && m === 'POST') {
      const i = STAGE_IDS.indexOf(s.stage);
      let target = body.stage;
      if (target === 'next') target = STAGE_IDS[Math.min(STAGE_IDS.length - 1, i + 1)];
      else if (target === 'prev') target = STAGE_IDS[Math.max(0, i - 1)];
      if (!STAGE_IDS.includes(target)) throw new HttpError(400, 'bad_stage', 'Unknown stage');
      s.stage = target;
      s.timer = { running: false, durationSec: 0, endsAt: null };
      return ok('stage.change', { stage: s.stage });
    }
    if (sub === 'timer' && m === 'POST') {
      if (body.action === 'start') {
        const sec = Math.round(num(body.seconds, 5, 3 * 3600, 300));
        s.timer = { running: true, durationSec: sec, endsAt: now() + sec * 1000 };
      } else if (body.action === 'stop') s.timer = { running: false, durationSec: 0, endsAt: null };
      else throw new HttpError(400, 'bad_action', 'action must be start or stop');
      return ok('timer.' + body.action);
    }
    if (sub === 'clear' && m === 'POST') {
      const target = body.stage;
      if (target !== 'all' && !STAGE_BY_ID[target]) throw new HttpError(400, 'bad_stage', 'Unknown stage');
      const all = target === 'all';
      const keepNote = (n) => !(all || n.stage === target);
      const gone = new Set(s.notes.filter((n) => !keepNote(n)).map((n) => n.id));
      s.notes = s.notes.filter(keepNote);
      s.votes = s.votes.filter((v) => !(all || v.stage === target || (v.targetType === 'note' && gone.has(v.targetId))));
      if (all || target === 'prioritise') s.placements = [];
      if (all || target === 'questions') s.questions = [];
      if (all || target === 'wrapup') { s.nextSteps = []; s.recommendation = { mvp: [], postMvp: [], rationale: '' }; }
      return ok('board.clear', { cleared: target });
    }
    if (sub === 'recommendation' && m === 'PUT') {
      const mvp = cleanEntryList(body.mvp);
      const postMvp = cleanEntryList(body.postMvp).filter((x) => !mvp.includes(x));
      s.recommendation = { mvp, postMvp, rationale: clean(body.rationale, LIM.rationale, true) };
      return ok('recommendation.set');
    }
  }

  throw new HttpError(404, 'not_found', 'Unknown endpoint');
}

function broadcastPresence(s) {
  const r = rt(s.id);
  for (const c of r.clients) {
    try { sseSend(c.res, 'state', buildView(s, c.pid ? s.participants[c.pid] || null : null)); } catch (e) { r.clients.delete(c); }
  }
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { return sendText(res, 400, 'Bad request', 'text/plain; charset=utf-8'); }
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (['GET', 'HEAD'].includes(req.method)) serveStatic(req, res, url.pathname);
    else sendText(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch (x) { /* ignore */ } return; }
    if (e instanceof HttpError) return sendJson(res, e.status, { error: { code: e.code, message: e.message } });
    console.error('Unhandled error:', e);
    sendJson(res, 500, { error: { code: 'server_error', message: 'Internal error' } });
  }
});
server.headersTimeout = 15000;
server.requestTimeout = 30000;

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}

function start() {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  loadAll();
  server.listen(PORT, HOST, () => {
    const port = server.address().port;
    console.log('\nWorkshop server running (data: ' + DATA_DIR + ', ' + sessions.size + ' stored session(s))');
    console.log('  Local:  http://localhost:' + port + '/');
    for (const ip of lanAddresses()) console.log('  LAN:    http://' + ip + ':' + port + '/   (share this join URL on the same network)');
    const ni = process.argv.indexOf('--new');
    if (ni > -1) {
      const r = createSession({ title: process.argv[ni + 1] });
      console.log('  Join:   http://localhost:' + port + '/s/' + r.s.id);
      for (const ip of lanAddresses()) console.log('          http://' + ip + ':' + port + '/s/' + r.s.id);
    }
    console.log('');
    if (process.send) process.send({ ready: true, port });
  });
}

function shutdown() {
  for (const r of runtime.values()) for (const c of r.clients) { try { c.res.end(); } catch (e) { /* ignore */ } }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (require.main === module) start();
module.exports = { server, start };
