# Social Media Studio (`/social-media`)

The Studio is a module inside the PMS. It uses the PMS login and user records, the PMS database (`db.json`), and the existing EJS layout and design tokens. It has no separate server, login or front-end framework.

## Who can do what

Identity always comes from the logged-in PMS session. Each Studio "slot" (Bansi, Bhavin, Vishnu, Krutik, Dhara, Ashmita) is **linked to an existing PMS user** in *Settings & Targets → Studio members*. Linking never creates or edits a user account.

| PMS user | Studio access |
|---|---|
| Admin | Studio manager: create/edit/delete reels, reassign with a reason, blockers, reopen, delay/reschedule, settings, member links |
| Linked Bansi / Bhavin / Vishnu / Krutik | Claim, release and complete shoots; mark raw footage ready; schedule; confirm publishing on their own pages; claim editing only where they are an eligible editor; ranked |
| Linked Dhara / Ashmita | View only (all screens, including preparation details). Every Studio POST returns 403. Never ranked or scored |
| PMS viewer | View only |
| Any other user | No access (403); no sidebar link |

The permission flags are fixed in `lib/studio/config.js`. Every POST is checked on the server in `routes/social.js` (read-only guard + CSRF) and again in `lib/studio/actions.js` (per-action rules).

Default page teams: Product = Bansi, Krutik · Farma Pattern = Bansi, Vishnu · Stencil = Dhara, Bhavin · Butterpaper = Ashmita, Bhavin. Editors for a page = the page team ∩ {Bansi, Bhavin, Vishnu, Krutik}.

## Workflow

Content Planning → Shoot Scheduled (claimed) → Shoot Completed → (raw footage ready) → Editing → Ready to Publish → Scheduled → Published.

- Reels are created without owners. Work is claimed.
- Editing cannot start until the raw footage is marked ready.
- Publishing is never assigned in advance. The user who confirms the upload enters the real Instagram URL and the actual posting time, and is recorded as the Publishing Owner. Scheduling is not publishing. The URL is not verified with Instagram.
- Reopening an edit requires a reason. The earlier completion is kept in `editing.previousCompletions`.
- Every claim, release, reassignment, completion, deadline change, blocker, schedule and publish is written to the reel's activity log. Ownership changes are also written to `ownershipHistory`.
- Deleting a reel is a soft delete. The record and its history stay in the database.

## Data

- All Studio data lives in `db.socialStudio`: members, settings, reels, nextReelId and notification read-state. It is separate from the general `db.tasks`.
- Schema v4 migration (`migrate()` in `db.js` → `migrateStudio()`) adds `socialStudio` only if it is missing. It never overwrites data and is safe to re-run.
- Follower numbers are generated mock data, always labelled **DEMO DATA — INSTAGRAM NOT CONNECTED**.
- The JSON file is not transactional. Within one server process, each request loads, validates, changes and saves the data synchronously, so double claims are refused. Don't run several server processes against the same file.

## Tests

```
npm test
```

The tests run `test/studio.unit.test.js` (permissions, transitions, migration, scoring) and `test/studio.http.test.js`. The HTTP tests boot `server.js` against a temporary copy of `db.json` through `PMS_DB_FILE` and never write the real file.
