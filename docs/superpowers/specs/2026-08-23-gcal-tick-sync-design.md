# Voice note → Google Calendar within 30 min — design (2026-08-23)

## Goal

Family tells @AoifeSchedule_bot something (voice or text) → the "Aoife's School"
Google Calendar reflects it within one daytime tick (≤30 min), instead of at the
4:10 AM nightly sync. Chosen by the owner over "instant via Vercel" (extra secret
distribution + duplicated event logic) and "nightly is fine".

## What already exists (nothing re-built)

voice note → transcription → bot rails → planner override (src:'tg') → nightly
`scripts/gcal-sync` reconcile → calendar. The ONLY change is when the sync runs.

## Design

1. **`gcal-sync --if-changed`** (new flag, in this repo):
   - After fetching the two blobs and computing `desired_state`, hash it
     (sha256 of sorted-keys JSON). If the hash equals the one in the state file
     (`--state-file`, default `~/.local/state/aoife-gcal-sync.hash`), print
     `GCAL-SYNC SKIP <date> unchanged` and exit 0 **without any Google API call**.
   - On a successful sync (`GCAL-SYNC OK`), write the hash — with or without the
     flag, so the nightly full run also refreshes it. Never written on
     DRY-RUN / WAITING / FAIL, so an unsynced change is retried next tick.
   - A state-file write failure never breaks the sync (best-effort).
2. **`tick.sh`** (aoife-school-bot repo): after the tick call — and regardless of
   its outcome — run `run.sh --if-changed`, log its marker line into the tick log
   (`GCAL …` prefix), never let a sync failure change the tick's exit code.
   The tick job is the ONE sanctioned daytime job; this rides it, no new schedule.

## Consistency model

- Quiet tick = one hash comparison, zero Google traffic (≤29 no-op ticks/day).
- The hash covers plan changes only. A synced event hand-deleted from the
  calendar is restored by the next plan change or the 4:10 AM full run (which
  runs without the flag) — same v1 limit philosophy as skip-overrides.
- Undo in the bot removes the override → next tick's hash differs → event
  deleted from the calendar within 30 min.
- Alerting stays with the nightly job's fleet probe; daytime sync lines in the
  tick log are informational.

## Testing

pytest (offline fakes, existing style): skip-on-match, sync-on-change,
WAITING-does-not-write-state (so the change retries), dry-run-does-not-write.
Live: run a tick by hand, confirm `GCAL GCAL-SYNC SKIP` on a quiet plan and an
OK after a real bot add.
