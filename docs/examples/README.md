# Workflow examples

Reference copies of workflow definitions running on the owner's machine. The
live source of truth is `~/.bearclaw/workflows/<slug>.json`; these are snapshots
for reading and diffing, not loaded by anything.

| File               | What it shows                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feed-triage.json` | The nightly RSS digest. Deterministic `shell` and `transform` nodes around a single schema'd `agent` node; the send guard is an edge, marking items read is structurally after a confirmed send, the caught-up branch still refreshes the batch file, and the watchdog is `policies.alerts.on_missed`. Ends on a silent `human` step that the email reply resolves. |
