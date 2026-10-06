# Local spoken controls

This optional adapter adds a bounded command recognizer to the existing VoiX
process. Vosk checks the complete mono PCM WAV for a standalone Stop/silence
command while general transcription already runs, so an ordinary request waits
for the longer of the two passes, not their sum; a recognized command answers
at once and the transcription started beside it is dropped unread. Unknown
words and mixed requests retain Whisper, its language choice and its existing
native decoder. Core remains the
conversation and memory owner. No audio or transcript is stored by this adapter.

Install `requirements-controls.txt` into the existing VoiX Python environment.
Download the Apache-2.0 French `vosk-model-small-fr-0.22` from the
[official model catalog](https://alphacephei.com/vosk/models) into an external
instance directory. Neither models nor machine settings belong in Git.

On Windows, the instance launcher invokes `start-controls.ps1` with `-VoiXRoot`
and `-ModelDirectory`. On other hosts, add this directory and the VoiX root to
`PYTHONPATH`, set `VOIX_CONTROL_MODEL_DIR`, then run
`python -m uvicorn agentx_voix_controls:app` using the existing VoiX environment.
The same VoiX process serves its normal endpoints and
`/v1/audio/transcriptions/controls`. `/api/voice-controls/status` reports readiness.

Set `VOIX_SPOKEN_CONTROLS_ENABLED=true` in Core's external instance settings
only after the adapter is ready. Blank/false preserves the ordinary VoiX upload
endpoint. A structured `control: stop` resumes browser listening without a user
turn or spoken acknowledgement. Pending native cancellation still settles before
another turn. This is an endpoint command check, not an always-on wake word.

`python -m unittest discover -s integrations/voix -p 'test_*.py'` runs the pure
control tests without installing a model. Qualify positive commands, ordinary
speech, short corrections, mixed requests and silence against the installed
model, then perform real microphone and audible interruption acceptance.
