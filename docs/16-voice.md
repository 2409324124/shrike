# 16 · Voice

Approved 2026-10-10. This is the voice architecture as built. The measured benchmark behind it lives with the decision record; the numbers that matter are repeated here.

## Owner answers (the decision's open questions)

| Question | Answer |
|---|---|
| Hinglish on screen | Roman script ("PR 42 kholo"). Devanagari is transliterated before it is shown or understood |
| Hands-free and outward actions | Hands-free may push, merge, open a PR or rerun CI after a spoken "yes" / "haan" while the plan card is on screen. "no" / "cancel" cancels |
| Jev | Retired from the voice path. A small planner ships with Shrike instead |
| Licences | Nemotron 3.5 ASR Streaming 0.6B weights (OpenMDW-1.1) are acceptable |
| Languages | Hindi, Hinglish, English and the major world languages |
| Where it runs | On this Mac only. The one network call is the first-use model download |
| Speech output | None. Voice listens and acts; feedback is visual |
| Modes | Push-to-talk (hold Option+Space) and hands-free |
| Quality bar | Smooth and highly polished |
| Recordings | Come later (the phase 0 gate). The eval runs on the synthetic corpus until then |

## The loop

1. **Hear.** `ShrikeVoice.app` keeps the mic warm with a 500 ms pre-roll, runs Silero VAD, and in hands-free uses Smart Turn v3.2 to decide when you have finished.
2. **Transcribe.** Nemotron 3.5 ASR Streaming 0.6B inside the helper (speech-swift on MLX, INT5), 320 ms chunks, with a language hint. Apple's en-US recognizer is only the English fallback while the model downloads.
3. **Understand.** Two tiers. The instant grammar (tier 0 and 1) settles most commands in well under a millisecond. Whatever it can't place goes to the bundled planner (tier 2), which can only pick actions and values from a closed list.
4. **Act.** One action registry that every key, slash command, hidden-move button and MCP drive tool maps to. Plans run step by step; anything that leaves the Mac or destroys work waits on the plan card.

## Hearing (`native/voice/`, `main/voice.ts`)

**The helper.** `ShrikeVoice.app` is still its own bundle, launched with `open -g -n -a` so the mic prompt names it, and still talks JSON lines over a token-checked localhost socket. Inside it now runs, all on this Mac:

1. **Capture.** The mic feeds a 500 ms ring buffer while voice is armed (push-to-talk arms on its first press; the mic closes after 10 minutes without a press, or on `arm off`). A press starts the turn with the half second before it.
2. **Silero VAD v6.2** on 32 ms frames (on at 0.5, off under 0.35). It drives the orb's hearing state (`vad` events) and hands-free.
3. **Nemotron** streaming at the bundle's 320 ms chunk. Partials go out as soon as the text changes. The first turn after launch waits for the models (about 0.4 s warm) and then catches up on the audio, so the first press is never lost. A turn with no pre-roll yet gets 100 ms of silence first, so a sharp first word is not dropped.
4. **End of turn.** Push-to-talk: on release the helper pushes 960 ms of silence and finalizes (shorter flushes cut the last word: Hindi CER 24 at 240 ms, 17 at 640 and 960); if the final is more than 150 ms late it sends the last partial instead. Hands-free: ASR only while speech (plus the onset it missed, caught up from the turn's audio), the flush (960 ms plus the one padded chunk a finalize would add) goes in after 100 ms of quiet, so when the turn ends with that flush decoded its partial is sent as the final with no more model work; then a 250 ms Silero pause asks Smart Turn v3.2; complete ends the turn, otherwise it keeps listening up to a 1.8 s cap. Smart Turn scores complete Hindi and Japanese commands low on the corpus (0.01 to 0.17), so an imperative ending (करो, खोलो, दिखाओ, "kholo", 表示して) also ends a turn; a trailing "and" / "और" never does. Under about 200 ms of speech is a cough and sends an empty final.
5. **Language.** `config.langs` from voice settings: the first is the hint, the second is decoded again from the same audio after the final and sent as `alt`. The understanding layer keeps the hint sticky by putting the language of the last understood command first. Measured: the Hindi hint on English audio gives CER 51 (English hint 4), so English plus Hindi speakers need both, not one. `[]` is auto (it costs English accuracy).
6. **Stop words.** A partial or final that is only "stop", "cancel", "ruko", "bas" or "rehne do" (either script) sends `barge` at once, so a running plan can stop before the turn ends.
7. **Apple fallback.** Until the speech model is downloaded and verified, English runs on Apple's on-device `SpeechTranscriber` (macOS 26). The old `SFSpeechRecognizer` path, which sends Hindi to Apple's servers, is gone.

Protocol additions (`@shrike/schema`): commands `arm`, `reload`; events `alt`, `barge`, plus `vad`, `lang`, `turn` and `engine`. `--wav "a.wav|b.wav"` plays files in real time instead of the mic (one per press, or all of them in hands-free), `--autostop` releases at the end of each file, `--stats` adds timing lines that main never relays. Main replays the last `config`, `context` and `hands` to a helper it restarts, so a restart never falls back to auto language; if the helper dies while hands-free is on, main restarts it at once (up to 3 times a minute) because no key press will. The default models folder is `$SHRIKE_MODELS`, then the dev app's `userData/models`, so the eval can call the helper directly.

**The runtime bake-off** (80 synthetic clips, real time through the helper, M4 Pro; WER with script-agnostic CER in brackets; final is from release):

| Runtime | en | Hinglish | Hindi | Final p50 / p95 | First words | Memory | Load |
|---|---|---|---|---|---|---|---|
| **speech-swift MLX INT5, 320 ms (chosen)** | 8 (4) | 50 (22) | 28 (17) | 104 / 137 ms | about 0.97 s | 692 MB footprint, 618 MB RSS | 0.4 s |
| speech-swift Core ML INT8, 320 ms | 11 (4) | 55 (22) | 25 (10) | 112 / 168 ms | about 0.82 s | 817 MB footprint, **1.24 GB RSS** | 17 s first, 0.7 s after |
| sherpa-onnx int8, 160 ms (benchmark) | 13 (6) | 55 (23) | 28 (15) | 137 / 161 ms | about 1.0 s | **2.0 GB** | 0.9 s |
| FluidAudio Core ML | not run: its Hindi build ships only at 560 ms chunks and up | | | | | | |

MLX INT5 is the smallest quantisation and the only runtime well inside the 1 GB memory gate, with the best English and Hinglish. Core ML reads Hindi better (CER 10 against 17); MLX INT8 (733 MB on disk) is the next lever if your recordings miss the Hindi gate (it did not fit on this disk next to the planner). **Chunk: 320 ms**, the only geometry the published MLX bundles accept. The 80 ms chunk is not published for the multilingual model on any Apple runtime; first words arrive about 0.8 to 1.1 s in on every runtime and chunk measured (sherpa at 160 ms was no faster), so the model's emission, not the chunk, sets it. The orb's level ring stays the instant feedback.

**Gates** (`node --test fixtures/voice/asr.test.ts`, real time, models from `$SHRIKE_MODELS`; e2e `e2e/voice-asr.test.ts`):

| Gate | Target | Measured |
|---|---|---|
| Final after release, p50 / p95 | 160 / 250 ms | 103 to 114 / 143 to 153 ms |
| Release to the action on screen ("show the logs", built app, real audio) | 250 ms | 105 to 168 ms |
| ASR memory | 1 GB | 690 to 694 MB footprint, 616 to 620 MB RSS |
| CPU while speaking, p95 | 150% | 11 to 14% |
| Idle hands-free (VAD only) | 5% of a core | 2.2 to 2.8% |
| Helper load with the models on disk | 1.5 s | 0.22 to 0.41 s warm; 1.0 to 2.3 s for the first load after the files left the disk cache (Shrike starts the helper 1.2 s after launch for anyone who has used voice, and a press during the load is caught up) |
| Turns opened by 2 minutes of fan noise | 0 | 0 |
| Mid-sentence pauses kept as one turn (`fixtures/voice/handsfree/`) | all | all (4 English, 2 Hindi) |
| Finished command fires after the pause, p50 | 300 ms | 257 to 264 ms from VAD silence (250 ms of it is the pause itself) |

Chunk phase matters on short, fast words: the synthetic "show the … network requests" clip comes out as "Shall the", "Shall da", "Shall Shall" or just "Network requests" depending on where the speech falls inside the 320 ms chunk grid (moving its start by 0.3 s changes it, in push-to-talk and hands-free alike). The audio reaches the model once and in order; this is the model, so the owner's recordings decide whether it matters.

**Models** (`main/voice.ts` `VOICE_MODELS`, pinned revisions, every file checked against its sha256 before it gets its real name; a bundle folder gets a `ready` marker the helper looks for): Silero VAD v6.2 Core ML (0.6 MB, MIT), Smart Turn v3.2 Core ML (17 MB, BSD-2-Clause), Nemotron 3.5 MLX INT5 (565 MB, OpenMDW-1.1), and the planner file. `VoiceModelStore` downloads them small first, one at a time, resumes a cut download from its `.part` with a Range request (and starts over if the server ignores it), refuses to start without the space plus 256 MB, sends progress on `voice:models`, and tells the helper to `reload` when a model lands or is deleted. Settings › Voice downloads, cancels and deletes them.

## Understanding (`renderer/src/voice/understand/`)

**Tier 0, normalise** (`normalize.ts`). NFKC and Unicode-safe lowercase. Devanagari to Roman with medial schwa deletion ("अगला" to "aglaa", "करके" to "karke"). Japanese loanwords swapped for Roman words. Number words in English, Hindi (1 to 100, with short ones like "do" and "saath" only after "PR" or "number"), Spanish, French and German. A lexicon maps English, Hinglish and world-language words to canonical command words (dikhao, muestra, zeig to show; kholo, abre, ouvre to open; roko, band, bas to stop). Unknown words snap to the command vocabulary by the Hinglish phonetic key (aspirates collapsed, long vowels shortened, w=v, z=j, trailing schwa dropped) or an English consonant skeleton with the same first letter.

**Tier 1, grammar** (`parse.ts`). A clause splitter on and, then, after that, aur, phir, karke, ke baad, y, et, und. Each clause is matched against order-free templates written in the registry (`(open|show) pr {pr}` also matches "PR 42 kholo"). Every clause must parse or the grammar abstains. Slots snap to live lists (`snap.ts`): Jaro-Winkler 0.88 or more, the same Hinglish key, or the same skeleton, with a 0.05 margin over the runner-up; two close values become "Did you mean" chips, and so do two project files that fit the words equally well ("open the todo file": TodoForm or TodoList). A word that is also a command word stays part of a file name when a live file contains it ("open todo list" opens `TodoList.tsx`), and the recognizer's "to do" is read as "todo". A value that is not live never parses (PR 99 when 99 is not open). File names only match after a file verb, so "kill the server" stops the app instead of opening `server/todos.controller.ts`. On live partials only a single safe step acts, and only when the same parse held for two partials in a row.

**The agent** gets words only through `agent.ask`: "ask Claude …", "… Claude se pucho", or a why / how question. Length never sends anything to the agent; the old 4-word and 8-word rules are deleted.

**Tier 2, planner** (`plan.ts`, `main/voice-planner*.ts`). Qwen3 1.7B at Q4_K_M (Apache-2.0, 1.1 GB) through node-llama-cpp with Metal, in an Electron `utilityProcess`. The prompt is a fixed prefix (one line per action, 15 examples in English, Hindi and Hinglish) that stays evaluated, then the live app state, then what was heard. Each turn's output is forced by a JSON schema: up to 6 steps, each one registry action, every slot an enum of live values (PR numbers as numbers, check names, workspaces, recent files) or a typed free field. Temperature 0, 96 tokens at most, a 1.5 s timeout. The process loads when voice turns on and unloads after 15 minutes without a turn.

**Rule checks after the planner** (`checkPlan`): zod against the registry; plan-control words refused; every slot value live; free text must be the person's own words (not an example's); a number said aloud must be the number used; a step nothing said asks for is dropped; an outward step needs one of its own words said, where "PR" and a number alone do not count (so "PR forty two colo" never puts up a merge card), and a destructive one its verb (so "fall the latest changes" never puts up a discard card); no more steps than clauses; garbled input (fewer than 2 known words) gets one step at most. On timeout, failure or an empty plan: "Didn't catch that", what was heard, and the three nearest commands as chips.

## The registry (`renderer/src/actions/`)

`registry.ts` is pure data: 75 actions, each with an id, card title, one-line help, risk, slots and their live source, templates, examples in several languages, and what it is bound to (keys, slash commands, moves, MCP tools). `run.ts` binds each action to the function its key, button or slash command already calls; outward steps still go through main's own approval cards. `registry.test.ts` fails when a keyboard command, slash command, hidden move or Shrike MCP tool has no row (MCP tools only the agent uses are listed by name in `AGENT_ONLY_TOOLS`), when an action has no binding, or when none of an action's own examples parses to it.

| Risk | Examples | Behaviour |
|---|---|---|
| safe | panels, the open PR list (PR14), open a check, navigate | Runs at once; may run on partials |
| undoable | stage, commit, run or stop the app, switch workspace | Runs; Undo for 5 seconds, "undo that" / "wapas karo" |
| outward | push, open / merge / approve a PR, rerun CI | The whole plan waits on the card. Runs on "yes", "haan", "push it", Enter or a click |
| destructive | discard changes | Card, a click, and a spoken repeat that names it ("yes, discard") |

## The executor (`understand/executor.ts`, wired in `voice/act.ts`)

Steps run in order and stop at the first failure, with the failure in plain words. If any step is outward or destructive, nothing in the plan runs until the yes, so "no" leaves nothing done. Precondition repair is a rule and shows on the card: "push" with uncommitted changes gets a Commit step first, flagged as added, with "Voice: <what you said>" as its message. "Stop" (recognised words, not sound) skips pending steps and stops the agent turn. With nothing running, a bare "stop" / "bas" / "ruko" acts on nothing and offers a Stop the app chip; stopping the app needs "stop the app" or "server band karo". "Haan push kar do" confirms the card when it is up, and starts the push (with its card) when nothing waits. A go-ahead the recognizer runs together ("Yeshipper" or "yesship it" for "Yes, ship it") snaps to yes by the same Jaro-Winkler and skeleton scores as slots, only when no other command word is in it (so "yes stop it" never is one); with a card up, "ship it" is a yes whatever the card holds. "Again" / "phir se" re-runs the last plan through the same gates. Once an outward step has run, the steps before it can no longer be undone (a pushed commit is not taken back). After a spoken yes the turn settles as soon as the plan runs and the card carries on; "stop" ends with the card saying Stopped. The card and the strip are the UI lane's (V-ui3 and V-ui1 in `design-system/README.md`); they read the executor through `onPlan`.

## What you see (`renderer/src/voice/VoiceOrb.tsx`, `useVoice.ts`, `ui/`)

Design IDs V5 and V-ui1 to V-ui8 in `design-system/README.md`. Every colour is a token; all six themes; Calm drops the motion and keeps the states and words.

- **Push-to-talk.** Hold Option+Space (or press and hold the orb). The orb answers inside a frame (the e2e asserts under 50 ms from keydown) and the strip opens with "Say a command, then let go". A wordless tap goes quiet instead of saying it missed. The key can be ⌥ Space, ⌃⌥ Space or ⌥ \` (settings).
- **Hands-free** (V-ui8). Double tap the key (two wordless taps within 380 ms) or click the lock next to the orb. While the mic is open the orb stays lit with a slow halo and LISTENING sits beside it. Any press of the key, the lock, or "stop listening" turns it off. It also turns off after 5, 10 (default) or 30 quiet minutes, and after 10 minutes with Shrike in the background, and says why on the strip. If the helper sends no mic level within 2.5 s of turning on, it turns itself off and says the helper isn't hearing the mic, so the orb is never lit over a closed mic. Speech with no words (a cough, the fan) stays quiet.
- **Orb states** (V5): idle, listening (the ring follows the mic level every frame), hearing (speech detected or words arrived: white-hot core), working it out (a steady violet ring, only when the result takes over 250 ms, so a grammar command never flashes it), acting (the ring fills as steps finish), needs yes (amber, steady glow), done (a tick), didn't catch (dim, `slow` ring), needs attention (red, with the problem line).
- **Transcript strip** (V-ui1, V-ui2). Just above the caption, over the composer. A level meter, the state in mono caps, the turn's language, then the newest words as they stream in, in Roman script (Devanagari is transliterated for display). As soon as the grammar matches, the intents show as chips after an arrow ("OPEN PR 42"). Then the echo of what it did.
- **Plan card** (V-ui3). For two or more steps, any step that needs a yes, or a failure; one quick step speaks through the strip. Numbered steps with icons and live state, outward steps marked "Leaves your Mac", destructive ones "Throws work away", rule-added steps "Added". Waiting: say "yes" or "haan" (a destructive step needs its name too, then a click), click Yes, or press Enter when no field has focus; "no", Esc or No cancels and nothing was sent. Running: Stop, or say "stop" / "ruko". Done: Undo for 5 seconds when an undoable step ran (safe steps get the tick, no Undo). While the card is up it speaks for the turn; the strip below it hides its echo. When a running step waits on main's own approval (the push's "Send 1 commit to GitHub?"), the plan card steps aside so only that question shows, and a pending question stays above an open sheet.
- **Never a dead end** (V-ui4, V-ui5). A miss shows what was heard, up to three "Did you mean" chips (tap or say), and What can I say?, which lists the focused panel's commands first and then the global ones, in English and Roman Hinglish, read from the registry.
- **First run** (V-ui6). The first press with the speech model missing shows the download in plain words: size, progress, a warning when the disk would drop under 1.5 GB free, and that English works on Apple's on-device speech meanwhile. Not now is remembered.
- **Settings** (V-ui7, the sliders next to the orb). Mode, push-to-talk key, languages I speak (Auto, English, Hindi + Hinglish and nine more; sent to the helper as its language hint), hands-free auto-off, and the on-device models with download, cancel and delete.
- Tests: `ui/logic.test.ts` (orb state priority, double tap, the key, step icons), `ui/hints.test.ts` (registry hints, Roman only), e2e `e2e/voice-ux.test.ts` (the helper stood in for at the IPC boundary: orb timing, live words, Hinglish card that pushes nothing until yes, "nahi" cancels, hands-free on and off, a spoken "haan" in hands-free that runs the push, a cough that stays quiet, the mic watchdog, no sweep on a grammar turn, a miss with its way out, settings, Daylight).

## Measured (M4 Pro, synthetic corpus, `node fixtures/voice/eval.ts --planner`)

| Source | Grammar alone | Grammar + planner |
|---|---|---|
| Held-out text paraphrases (36) | 94% | 97% |
| Nemotron 160 ms (sherpa benchmark) transcripts of the audio set (80) | 76% | 85% |
| whisper turbo transcripts (80) | 75% | 86% |
| Apple transcripts (74) | 55% | 72% |
| The shipping helper (MLX INT5, 320 ms) on the audio set, through the recordings path (80) | 74% | 83% (en 82, Hinglish 76, Hindi 91, other 92; wrong safe 6%) |
| Before this change (`grammar.ts`, held-out) | 8% | |

Grammar p50 0.1 ms. Planner warm p50 about 310 ms, p95 about 410 to 540 ms (66 calls; it varies with machine load); in the built app a planner turn took 413 ms from the final words to the echo. Planner load 2.1 s, prefix warm-up under 1.6 s, process RSS about 2.1 GB with the model mapped (budget 2.6 GB). Zero outward or destructive steps ran without a card across every predicted plan.

**Caveat.** The held-out paraphrases were visible while this grammar was written, so their 94% is optimistic. The ASR-transcript rows and, above all, your recordings are the honest measure. The 4B planner comparison was not run: free disk was about 2 GB and the decision's floor is 1.5 GB.

## Acceptance in the built app (`e2e/voice-journeys.test.ts`, 2026-10-10, 3 runs, all green)

Real audio: the helper plays fixture WAVs through Silero, Nemotron (MLX INT5) and the bundled planner, into the built app on a running todo-app copy with a local bare origin and a fake gh.

| Gate | Target | Measured |
|---|---|---|
| Simple command, release to action, p50 / p95 | 250 / 400 ms | 105 / 613 ms over 22 presses. Every press the grammar placed took 4 to 121 ms; the slow ones were misheard words the planner rescued ("nogs dikhao", "show made the network requests"), so p95 misses because of ASR errors, not the pipeline |
| Planner command, release to action | 700 / 1000 ms | 638 to 673 ms ("what did the server print" to the terminal) |
| First partial words after speech starts, p50 / p95 | 300 ms target | 840 / 1220 ms (the 320 ms chunk; see Hearing) |
| Helper memory | 1 GB | 622 MB RSS |
| Planner memory | 2.6 GB | 1.89 to 1.91 GB working set |
| Voice in total | 3.6 GB | 2.5 GB |
| Outward step without the card and a yes | 0 | 0: the push waited on the card, then on main's own approval, and "stop" mid-plan left nothing pushed and nothing asked |
| False actions in hands-free on 20 s of fan noise and a sentence of chatter | 0 | 0 |

Synthetic simple commands understood: 7 of 8 per run. The miss is "logs dikhao" heard as "लॉर्ड्स दिखे हो", which the planner turned into Showing network (a wrong safe action). Short single words are the weak spot on synthetic voices: some voices' "yes", "stop" and "haan" come back empty, so the journeys use the voices that are heard. Your recordings of yes, haan, nahi and stop (listed in `fixtures/voice/README.md`) settle this.

In hands-free, a command and chatter 1.5 s later can land in one turn (Smart Turn did not end it inside the 1.8 s cap). The command still acted, because a safe step acts on a stable partial, and the chatter added nothing.

## Eval and recordings (`fixtures/voice/`)

- `corpus.json` (80 synthetic clips, WAVs in `audio/`), `heldout.json`, `nearmiss.json`, `hallucinations.json`, `context.json` (the live state the eval runs against), `transcripts/` (benchmark ASR output).
- **How to record your 40 commands:** `fixtures/voice/README.md` (the list, the convert command, and the yes / haan / nahi / stop files). `node fixtures/voice/eval.ts --prompts` prints every id you can record. Save each as `<id>.wav` in `fixtures/voice/recordings/` (add `-fan`, `-music` or `-noisy` for noisy takes), or any name with a `<name>.json` beside it holding `{lang, plan}`. The eval transcribes them through the real helper (`--wav`), caches the text, and a `<name>.txt` beside a WAV overrides it.
- `node --test fixtures/voice/eval.test.ts` prints every table and fails on any gate that ran and missed. The model is used when it is in userData/models (`SHRIKE_EVAL_PLANNER=0` skips it).

| Gate | Target | Now |
|---|---|---|
| Phase 1: held-out text, grammar alone | 47% or more | 94% |
| Phase 2: held-out text, grammar + planner | 85% or more | 97% |
| Phase 2: planner p95, warm | under 1 s | about 0.4 to 0.55 s |
| Outward or destructive steps run without a card | 0 | 0 |
| Hallucinated-step fixtures dropped | all | 11 of 11 |
| Your recordings: en / Hinglish / Hindi / other | 90 / 80 / 80 / 75% | waiting for recordings |
| Your recordings: wrong safe action | 5% or less | waiting for recordings |

## Models

Downloaded on first use into `userData/models/` with a progress bar and a sha256 check, never committed. The planner is pinned in `main/voice-planner-model.ts` (unsloth/Qwen3-1.7B-GGUF at revision d7f544e, `Qwen3-1.7B-Q4_K_M.gguf`, 1,107,409,472 bytes). The ASR, VAD and Smart Turn models are in Hearing above; the same `VoiceModelStore` downloads all four.

## Privacy

Audio never leaves the Mac and is never written to disk. Transcripts stay in memory; anything stored or sent to the agent goes through `@shrike/redact` first. The planner and ASR have no telemetry.

## Phases

| Phase | State |
|---|---|
| 0 Ground truth | Eval harness built on the synthetic corpus; ready for recordings |
| 1 Registry and grammar | Built: registry, coverage test, tier 0 and 1, executor with card, undo and stop; agent-length rules deleted |
| 2 Planner | Built: node-llama-cpp in a utilityProcess, schema-forced plans, cached prefix, rule checks; Jev out of voice |
| 3 Open ASR | Built: Nemotron in the helper (bake-off above), Silero and the 500 ms pre-roll, language hint with a second-language decode, download manager with the Apple English fallback, WAV-injection e2e. The accuracy gates wait for your recordings |
| 4 Hands-free | Built in the helper: Smart Turn end of turn with the 1.8 s cap, stop words as `barge`, 0 turns on fan noise. The 10 minutes of music and TV wait for real recordings |
| 5 Polish and learning | Later; each item ships only if it moves an eval number |
