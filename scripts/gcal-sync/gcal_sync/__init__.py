"""One-way sync: aoifes-schedule planner -> the 'Aoife's School' Google Calendar.

`model` is PURE (no network, no Google client, no clock) and holds every rule the
tests exercise. `cli` is the only module that touches HTTP, the service account
and launchd's stdout.
"""
