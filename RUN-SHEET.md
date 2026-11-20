# Facilitator run sheet: "Pick it up where you left off"

Product + Design workshop on Recent Searches, Recently Viewed and Abandoned Cart (mySearches in myTUI). Owner: Customer Account PM (Account Core).

Pre-read (send 2 days ahead, 10 minutes): the discovery prototype, `../account/discovery-pick-up-where-you-left-off.html` (open it in a browser, no server needed). Ask people to look at: the entry-point map, the state matrix (guest, signed in, no history, no consent) and the open questions.

## Session goal

Leave with (1) a shared view of which entry points matter most, (2) an agreed MVP versus post-MVP cut, (3) the riskiest assumptions ranked, and (4) open questions with an owner and a gate, plus next steps and experiments.

## Agenda (about 90 minutes)

The seven stages match the stages in the app (a to g). In-app timers total 95 minutes. Plan 90 minutes of working time by trimming stage b or d if you start late; keep 5 minutes of buffer.

| # | Time | Stage (app) | What happens | Output |
| --- | --- | --- | --- | --- |
| 0 | -10 | Setup | Start server, create session, share room code, check everyone can join | Everyone on the board |
| a | 10 min | Warm-up and context | Intro, goal, ground rules. Silent notes on three columns: where resume is done well, where customers lose their place, what you want from today. Quick read-out. | Shared context |
| b | 25 min | Entry-point map | 5 min silent notes per column, then walk the columns A to I, 2 min each. Add ideas, concerns, questions. | Notes per entry point |
| c | 10 min | Dot voting on entry points | Each person places their dots on the entry points that matter most for customers. Reveal totals at the end. | Ranked entry points |
| d | 15 min | 2x2 prioritisation | Each person places each entry point on value (up) against effort (right). Reveal the averages, discuss outliers. | Quick wins and big bets |
| e | 15 min | Assumptions and risks | Add what must be true and what could go wrong, by theme. Dot-vote the riskiest. | Top risks and assumptions |
| f | 10 min | Open questions and decisions | Give each open question an owner and a status. Log decisions made in the room. | Questions with owners |
| g | 10 min | Wrap-up | Review top-voted entry points, agree MVP versus post-MVP, capture next steps and experiments. Export. | Recommendation, next steps, export |

## Facilitation prompts

a. Warm-up
- "Think of the last time you came back to a trip you were planning. What helped, what did not?"
- "Where does a customer lose their place today on web, app and across devices?"
- "What would make today a good use of your time?"

b. Entry-point map
- "Who is this for: a guest, a signed-in customer, or someone with a booking in progress?"
- "What would you show here, and what would you leave out so the page stays clean?"
- "What could go wrong on this surface (clutter, performance, consent)?"
- "What do we not know yet? Write it as a question note."

c. Dot voting
- "Vote for customer value, not for the idea you like building. If dots are spread, that is fine."
- Remind people dots can be stacked. Lock voting before you reveal.

d. 2x2
- "Place it where you honestly think it sits, even if you disagree with the room. We look at the spread, not only the average."
- Ask the widest-spread entry point: "Why is your view so different from the others?"

e. Assumptions and risks
- "What must be true for the header eye icon to work? What if consent is declined?"
- "Which of these would make us stop if we found out it was false?"

f. Questions and decisions
- "Who can answer this, and by when? What is the gate (research, design review, Legal)?"
- Do not solve questions in the room. Name an owner. Decisions only if the right people are present.

g. Wrap-up
- "If we could only ship two entry points, which two, and why?"
- "What is the smallest experiment that would tell us we are wrong?"
- "Who takes each next step, and when do we look again?"

## Room and tooling setup

- Host: facilitator laptop runs `node server.js` (see README). Test once the day before.
- In person: everyone on the same Wi-Fi opens `http://<facilitator-LAN-IP>:3000` and enters the room code. Project the facilitator view on the main screen.
- Remote or hybrid: see README "Running for remote participants". Hosting is an open decision, do not improvise on the day.
- Backup: if the server fails, the facilitator can switch to offline demo mode (single user) and capture notes on a shared screen, or use the exported Markdown from the last test session.
- Each person needs a laptop (a phone works for dots and notes). Dark or large-screen projection for the 2x2 and the vote results.
- Create the session with 5 dots per person per voting stage (default). Pre-filled notes are on by default, switch off if you want a blank board.
- Names: ask people to join with a first name. Anonymous mode hides authors on notes if the group needs it.

## Roles

| Role | Who | Does |
| --- | --- | --- |
| Facilitator | Customer Account PM | Runs stages, timer, locks and reveals votes, keeps to time |
| Co-facilitator / timekeeper | Design lead | Watches the board, nudges quiet voices, handles tech issues |
| Scribe | Product Analyst or Tech Lead | Captures decisions and questions with owners (stage f), checks export |
| Participants | Product and Design (Account Core, Loyalty, Search, Book, Inspire) | Add notes, place dots, place 2x2 spots |
| Observer (optional) | UX Research | Notes patterns, links to prior research |

## Ground rules

- Silent first, talk second. Notes before discussion.
- One idea per note. Short and specific.
- Disagree on the board. Unresolved questions get an owner, not a debate.
- Customer value over internal convenience.

## Before, during, after checklist

Before: pre-read sent, server tested, room created, projector tested, ownership questions flagged (Q5), hosting decision for remote participants resolved.
During: advance the stage from the facilitator controls, start the timer per stage, lock voting before reveal.
After (same day): export Markdown and CSV, copy to the team Confluence space (draft first), delete the session data once exports are stored where approved, send a summary within 48 hours.

## Success criteria

- At least 80% of invited people attend and add at least 3 notes each.
- All 9 entry points have a vote total and a 2x2 position.
- A clear top 3 entry points and an agreed MVP versus post-MVP view (recorded in the wrap-up recommendation).
- The top 3 risks are named, each with an owner or a test.
- Every open question has an owner and a gate; no question left without one.
- At least 3 next steps or experiments with owner and date.
- The export is stored and shared within 48 hours.
- Post-session pulse (1 question): "Was this a good use of your time?" 4 or higher out of 5 from most participants.
