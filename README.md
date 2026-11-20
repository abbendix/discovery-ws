# Workshop app: "Pick it up where you left off"

Interactive board for a Product + Design workshop (Customer Account). Participants add sticky notes, place dots, and position entry points on a 2x2. Results are stored on the host machine and can be exported. Based on the discovery prototype at `../account/discovery-pick-up-where-you-left-off.html` (not modified by this app; the server also serves it read-only at `/discovery/pick-up-where-you-left-off.html` so in-app links work for every participant). The facilitator script is in [RUN-SHEET.md](RUN-SHEET.md).

No dependencies. Requires Node 18 or newer.

## Run it

```bash
cd output/workshop-pickup
node server.js
```

- Default port is 3000. Change it with `PORT=4000 node server.js`.
- The server listens on all network interfaces, so people on the same network can reach it.
- Optional: `node server.js --new "Session title"` creates a session at startup and prints its facilitator PIN.
- Optional: `DATA_DIR=/some/path node server.js` stores data somewhere else.

## Join a session

1. Facilitator opens `http://localhost:3000`, enters a title and name, and creates a session. The app shows the room code (6 characters) and a one-time facilitator PIN. Note the PIN, it is shown once (it is also printed in the server console).
2. Participants on the same network open `http://<facilitator-LAN-IP>:3000` (find it with `ipconfig getifaddr en0` on macOS), pick the session or open `http://<LAN-IP>:3000/s/<ROOM-CODE>`, and enter a display name.
3. A co-facilitator can join with the same room code plus the facilitator PIN.
4. Closing the tab does not lose your place: the browser remembers your participant token and you rejoin as the same person.

## Where data is stored

- Sessions: `data/session-<ROOM-CODE>.json` (next to `server.js`, created on first use).
- Exports: `data/exports/` (Markdown, saved when the facilitator exports).
- Downloads from the UI: Markdown summary, CSV (notes, votes, placements) and raw JSON. Participant tokens are stored hashed, never in exports.
- Sessions survive a server restart.
- `data/` is under `output/`, which is git-ignored, so nothing is committed.

## Offline demo mode (single user only)

On the start screen, "Start offline demo" runs the whole board in the browser using localStorage. It is for trying the format. It is single-user: nothing is shared, nothing is sent to the server, and it is not suitable for the real session. Data stays in that browser only.

## Test

```bash
node test-smoke.js
```

Starts the server on a random port with a temporary data folder, runs the API checks (join, notes, votes, 2x2, exports, persistence across restart, deletion) and cleans up after itself. Expected last line: `All 81 checks passed.`

## Running it for remote participants

The app is a plain Node process, so remote access just needs a way to reach it. Options, in order of how little they change:

1. Same VPN or corporate network: share `http://<host-IP>:3000`. No extra tooling.
2. A tunnel from the facilitator laptop (for example ngrok or cloudflared): `ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000`. This exposes the board to anyone with the URL and room code, via a third-party service.
3. Deploy this folder to an internal host (a company VM or container platform): copy the folder, run `PORT=<port> node server.js` behind the company's reverse proxy with HTTPS, and point `DATA_DIR` at persistent storage.

This project does not run any of these for you. Nothing here has been deployed or exposed to the internet. The app has no accounts: access is by room code, and the facilitator PIN protects facilitator actions. Use HTTPS when the board is reachable beyond your own network.

### OPEN DECISION (not decided)

- Where will the session really be hosted for remote participants (which company-approved tooling: VPN, internal host, or an approved tunnel service)?
- May session data (participant names, notes) leave the company network, for example via a third-party tunnel or a cloud host?

Owner: Customer Account PM, with InfoSec / Data Protection. Gate: before the session invitation is sent. Until decided, run the session in person or on the corporate network only.

## Privacy note

Participant display names are personal data. Ask people to join with a first name only, or turn on anonymous mode in the session settings so notes do not show authors. Do not put customer data in notes. Export what you need, then delete the session.

Delete a session and its exports:

- In the UI: facilitator uses the "Delete session data" button in the session.
- From the command line: `rm data/session-<ROOM-CODE>.json data/exports/*<ROOM-CODE>*` (check the file names in `data/exports/` first), or call the API with the facilitator token: `curl -X DELETE -H "Authorization: Bearer <FACILITATOR-TOKEN>" http://localhost:3000/api/sessions/<ROOM-CODE>`.
- To remove everything: stop the server, then `rm -r data/`.
- Offline demo data lives in the browser: clear site data for the page to remove it.
