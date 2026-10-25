# Social Media Studio (`/social-media`)

The Studio is a module inside the PMS. It uses the PMS login and user records, the PMS database (`db.json`), and the existing EJS layout and design tokens. It has no separate server, login or front-end framework.

## Who can do what

Identity always comes from the logged-in PMS session. Each Studio "slot" (Bansi, Bhavin, Vishnu, Krutik, Dhara, Ashmita) is **linked to an existing PMS user** in *Settings & Targets → Studio members*. Linking never creates or edits a user account.

| PMS user | Studio access |
|---|---|
| Admin | Studio manager: create/edit/delete reels, reassign with a reason, blockers, reopen, delay/reschedule, settings, member links |
| Linked Bansi / Bhavin / Vishnu / Krutik | Claim, release and complete shoots; mark raw footage ready; schedule; confirm publishing on their own pages; claim editing only where they are an eligible editor; ranked |
| …with "Can create reels" on | An admin can turn this on per member in Settings → Studio members. That member can then create reels for their own page-team pages. Editing and deleting reels stays admin-only |
| Linked Dhara / Ashmita | View only (all screens, including preparation details). Every Studio POST returns 403. Never ranked or scored |
| PMS viewer | View only |
| Any other user | No access (403); no sidebar link |

**Studio access switch.** *Settings & Targets → Studio access* controls who sees the Studio. It is off by default, so only admins see it and everyone else gets no sidebar link and a 403. Turn it on to open the Studio to the roles in the table above (`settings.teamAccess`). The Content Sheet is not affected by this switch.

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
- **Manage reels** (`/social-media/manage-reels`, admin only, linked from Task Management and Settings) deletes or restores many reels at once. You can filter by page, status, title and created date, and use "Select all shown". Every reel goes through the same delete rules and history logging as a single delete.

## Publishing schedule and the 24-hour editing deadline

- **Weekly publishing schedule.** In *Settings & Targets → Publishing Schedule*, each page has its own Monday–Sunday schedule. Each day can be turned on or off and can have several times, stored as 24-hour `HH:mm` in the server's time zone. Only admins can change it. Each save covers one page only and is recorded in `socialStudio.scheduleHistory` (before, after, who, when).
- **Suggestions only.** The schedule only suggests publishing times. When a reel is created, its publishing time defaults to the first slot that still leaves 24 hours for editing after the shoot. The Schedule and Reschedule pop-ups also suggest the next slot. Changing the weekly schedule never changes reels that already have a publishing time.
- **Editing deadline.** Each reel's editing deadline is always `editingDeadline = publishAt − 24 hours`. It is saved on the reel and recalculated whenever that reel's publishing time changes. The change history keeps the old and new publishing time and deadline, who changed them, when, and why; a reason is required when an existing time is changed. A reel without a publishing time has no deadline. If the new deadline has already passed, the PMS shows a warning and never moves the deadline forward.
- **Completion.** "Mark editing completed" records the server time and the logged-in editor, and compares them with the deadline. Completed at or before the deadline counts as on time; after it, late. That result is stored with the completion and never rewritten. If the publishing time changes later, the reel shows whether the earlier completion also meets the new deadline. Reopening keeps the earlier completion in `editing.previousCompletions`.
- **Overdue warning.** "Editing Overdue" is a warning badge only. The reel's workflow status, such as "Editing", stays as it is. Scoring uses the stored on-time or late result; the weights (35/25/25/15) and the four ranked employees are unchanged.
- **Time zone.** `server.js` pins the whole PMS to one business time zone (`Asia/Kolkata`, or `PMS_TIMEZONE`). Typed times, "today", slots and deadlines therefore mean the same thing on any host, including a cloud server whose clock is UTC. The publish pop-up's "now" uses the same zone.
- **Migration.** Schema v5 adds the saved deadline to existing reels. An old manually entered editing deadline is kept as `legacyEditDeadline` for reference only.

## Content Sheet (`/content-sheet`)

A plain planning sheet with its own **Content Sheet** link in the main sidebar menu, outside the Studio. The columns are Publish Date, Name, Shoot Date, Material Ready For Shoot, Shoot Status, Editing Status, Publish Status, Post Link and Add Note.

- **Who sees it:** everyone who could view the Studio (admins, linked Studio members, PMS viewers), even while the Studio access switch is off, plus any PMS user an admin ticks under **Who can see this sheet** on the sheet page (`contentSheet.viewers`). Sharing gives view-only sheet access, never Studio access. Everyone else gets a 403 and no link.
- **Who changes it:** only admins can add, edit (Save on each row) or delete rows. Everyone else sees it read-only.
- **Post link and lock:** a row can only be marked **Published** together with its post link (an http/https URL). Saving it that way locks the link and the Published status (`lockedAt`, `lockedBy`); later saves keep both. To correct a locked link, delete the row and add it again.
- **Storage:** the rows live in `socialStudio.contentSheet` and are independent of reels, so they do not affect tasks, deadlines or scoring.

## Data

- All Studio data lives in `db.socialStudio`: members, settings, reels, nextReelId and notification read-state. It is separate from the general `db.tasks`.
- Schema v4 migration (`migrate()` in `db.js` → `migrateStudio()`) adds `socialStudio` only if it is missing. It never overwrites data and is safe to re-run.
- Follower numbers are generated mock data, always labelled **DEMO DATA — INSTAGRAM NOT CONNECTED**.
- The JSON file is not transactional. Within one server process, each request loads, validates, changes and saves the data synchronously, so double claims are refused. Don't run several server processes against the same file.

## Real Instagram follower counts

The counts come from the official Instagram API with Instagram Login (`graph.instagram.com`, v26.0). The Meta app is "Social Media" → Instagram API → *API setup with Instagram login*, and needs the permissions `instagram_business_basic` and `instagram_business_manage_insights`. The four accounts are Instagram Testers on that app.

1. In Meta, click **Generate token** next to each account.
2. In the PMS, go to **Social Media Studio → Settings & Targets → Instagram connection**. Paste each token next to its page and click **Connect** (admin only).
3. The PMS checks that the token belongs to that page's handle, saves today's count, and tries to estimate the previous ~30 days from Instagram's daily follower change.

How it works:
- **Tokens** are stored in `instagram-tokens.json`, which is git-ignored and not part of `db.json`. They are never shown again and are refreshed automatically before their 60-day expiry.
- **Updates:** while the server runs, connected pages update about once a day. *Fetch follower counts now* forces an update.
- **Storage:** daily snapshots are saved in `db.socialStudio.instagram`.
- **Unconnected pages** keep showing generated numbers, and every screen says which pages are live and which are demo.
- **Reminders:** admins get a popup on any PMS page when a connected page's token is within 10 days of expiry, has expired, is missing, or its last update failed. "Remind me tomorrow" hides the popup for the day. A banner and a red count on the bell stay until the problem is fixed, and *Renew tokens now* asks Instagram for fresh 60-day tokens.
- **Turning sync off:** set `PMS_IG_SYNC=off` to stop background syncing. The tests do this.

## Tests

```
npm test
```

The tests run `test/studio.unit.test.js` (permissions, transitions, migration, scoring) and `test/studio.http.test.js`. The HTTP tests boot `server.js` against a temporary copy of `db.json` through `PMS_DB_FILE` and never write the real file.
