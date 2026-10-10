# Voice fixtures

What voice is measured against (docs/16). Nothing here is downloaded at run time.

| Path | What |
|---|---|
| `audio/` | 80 synthetic clips (macOS voices): English, Hinglish in both scripts, Hindi, es, fr, de, ja, a few noisy |
| `corpus.json`, `heldout.json`, `nearmiss.json`, `hallucinations.json` | Gold plans for the clips, 36 held-out phrasings, near misses, planner hallucinations |
| `context.json` | The fixed app state the eval plans against |
| `transcripts/` | The benchmark's ASR output for the clips |
| `handsfree/` | Sentences with a pause inside, for the hands-free end-of-turn gate |
| `journeys/` | Extra clips for the acceptance e2e (`apps/desktop/e2e/voice-journeys.test.ts`): yes, हाँ जी, stop, a planner command, an ambiguous file name, chatter. Made with `say` and `afconvert` |
| `recordings/` | **Your recordings.** Empty until you add them |
| `eval.ts` | `node fixtures/voice/eval.ts [--planner] [--misses]` prints accuracy and latency per language, then the gates |

## How to record your 40 commands (phase 0 gate)

The synthetic voices flatter the recognizer. Your voice, your mic and your room are the real test, and the per-language gates (English 90%, Hinglish 80%, Hindi 80%, wrong safe action 5% or less) only count on these.

1. Record each line below on the mic you use with Shrike, one file per line. Say it the way you would to Shrike, at your normal speed. Leave about half a second of quiet before and after.
2. QuickTime Player (File › New Audio Recording) or Voice Memos is fine. Name each file after its id (`en03.m4a`).
3. Convert them all to WAV in one go:
   ```sh
   cd ~/Desktop/voice && for f in *.m4a; do afconvert -f WAVE -d LEI16@16000 -c 1 "$f" "${f%.m4a}.wav"; done
   ```
4. Put the `.wav` files in `fixtures/voice/recordings/` and run `node fixtures/voice/eval.ts --planner`. The eval transcribes them through the real helper once (cached in `recordings/.transcripts.json`) and prints the gates.

For a noisy take, add `-fan`, `-music` or `-tv` to the name (`en07-fan.wav`). Any other phrasing works too: give it a `<name>.json` beside the WAV, like `{"lang": "hinglish", "plan": [{"action": "panel.show", "slots": {"panel": "logs"}}]}`. A `<name>.txt` beside a WAV overrides its transcript.

### English (14)

| id | Say |
|---|---|
| en01 | show the logs |
| en03 | where did it break |
| en04 | run the app |
| en06 | look at all the open pull requests |
| en07 | stage all files and push them |
| en08 | open the failing check |
| en11 | open PR 57 |
| en13 | open the API client |
| en17 | show me the network requests |
| en18 | go back |
| en21 | pull the latest changes |
| en23 | run the tests, then open the terminal |
| en24 | stop the agent |
| en28 | open the todos controller |

### Hinglish (12)

| id | Say |
|---|---|
| hr01 | logs dikhao |
| hr02 | saari files stage karo aur push kar do |
| hr03 | PR 42 kholo |
| hr04 | app chalao |
| hx04 | failing check kholo |
| hx06 | app band karo |
| hx08 | saare open PRs dikhao |
| hx11 | network requests dikhao |
| hx12 | tests chalao phir terminal kholo |
| hx13 | changes commit karo |
| hx16 | latest changes pull kar lo |
| hh03 | kaunse PR khule hain |

### Hindi (8)

| id | Say |
|---|---|
| hi01 | लॉग्स दिखाओ (logs dikhao) |
| hi02 | ऐप चलाओ (app chalao) |
| hi03 | अगला कदम (agla kadam) |
| hi05 | सभी पुल रिक्वेस्ट दिखाओ (sabhi pull request dikhao) |
| hi06 | सारी फाइलें स्टेज करो और पुश करो (saari files stage karo aur push karo) |
| hi09 | गलती कहाँ हुई (galti kahan hui) |
| hi10 | टर्मिनल खोलो (terminal kholo) |
| hd02 | सर्वर बंद कर दो (server band kar do) |

### With a fan, music or the TV on (4)

`en01-fan`, `en07-music`, `hr03-fan`, `hi01-tv`: the same lines as above.

### Yes, no and stop (4)

These are short, and short words are where the recognizer is weakest on synthetic audio, so they matter most. Each needs a `.json` beside it:

| File | Say | `<name>.json` |
|---|---|---|
| `yes.wav` | yes | `{"lang": "en", "plan": [{"action": "confirm.yes", "slots": {}}]}` |
| `haan.wav` | haan | `{"lang": "hinglish", "plan": [{"action": "confirm.yes", "slots": {}}]}` |
| `nahi.wav` | nahi | `{"lang": "hinglish", "plan": [{"action": "confirm.no", "slots": {}}]}` |
| `stop.wav` | stop | `{"lang": "en", "plan": [{"action": "plan.stop", "slots": {}}]}` |

The full list of ids you can record by name (corpus and held-out) is `node fixtures/voice/eval.ts --prompts`.
