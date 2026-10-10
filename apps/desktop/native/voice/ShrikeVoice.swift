// Shrike's ears. Mic → 500ms pre-roll ring → Silero VAD → Nemotron 3.5 streaming ASR (speech-swift, MLX), all on this Mac.
// Push-to-talk ends on stop with an immediate flush; hands-free cuts turns itself (Silero pause + Smart Turn, 1.8s cap).
// While the open model is missing (first download), English runs on Apple's SpeechTranscriber (macOS 26+).
// JSON lines. In: start{id} stop context{words} auth hands{on} config{langs: [hint, second]} arm{on} reload quit
// Out: hello ready permission partial final alt level error setup vad lang turn engine barge (+ stat with --stats)
// Transport: --port N --token T connects back to 127.0.0.1:N (the hello line carries the token); else stdin/stdout.
// --models DIR: asr/ vad/ turn/ bundles downloaded by Shrike (default: $SHRIKE_MODELS, then the dev app's userData/models). --fake "a|b": one transcript per start (protocol tests).
// --wav "a.wav|b.wav": one file per start (or all of them in hands-free) in real time instead of the mic.
// --autostop: in --wav mode, stop at the end of each file (latency bench).
import AVFoundation
import AppKit
import Darwin
import Foundation
import Network
import NemotronStreamingASR
import Speech
import SpeechVAD

let args = CommandLine.arguments
func arg(_ name: String) -> String? {
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}

let out = DispatchQueue(label: "shrike.voice.out")
var writeLine: (Data) -> Void = { d in FileHandle.standardOutput.write(d) }

func quit(_ code: Int32) -> Never {
  out.sync {}
  exit(code)
}

func send(_ msg: [String: Any]) {
  guard var d = try? JSONSerialization.data(withJSONObject: msg) else { return }
  d.append(0x0A)
  out.async { writeLine(d) }
}

func micStatus() -> String {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: return "granted"
  case .denied: return "denied"
  case .restricted: return "restricted"
  default: return "unknown"
  }
}

func now() -> Double { CFAbsoluteTimeGetCurrent() }

func footprintMB() -> Double {
  var info = task_vm_info_data_t()
  var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
  let r = withUnsafeMutablePointer(to: &info) { $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) } }
  return r == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : 0
}

let fake = args.contains("--fake")
let stats = args.contains("--stats")
let autostop = args.contains("--autostop")
let modelsDir = URL(fileURLWithPath: arg("--models") ?? ProcessInfo.processInfo.environment["SHRIKE_MODELS"] ?? NSHomeDirectory() + "/Library/Application Support/@shrike/desktop/models", isDirectory: true)
let SR = 16_000
let fmt16 = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(SR), channels: 1, interleaved: false)!

// ---------- tuning (docs/16-voice.md) ----------
let PREROLL = SR / 2 // 500ms
let VAD_ON: Float = 0.5, VAD_OFF: Float = 0.35
let PAUSE_S = 0.25 // Silero pause before Smart Turn is asked
let CAP_S = 1.8 // hard cap on silence in a hands-free turn
let TURN_MAX_S = 20.0
let FLUSH = SR * 96 / 100 // 960ms of silence after the turn so the last word comes out (docs/16-voice.md)
let EARLY_FLUSH_S = 0.1 // VAD silence this long: flush now (zeros between words are just a pause to the model)
let LATE_FINAL_S = 0.15 // push-to-talk: act on the last partial when the final is later than this
let ARM_IDLE_S = 600.0 // push-to-talk pre-roll mic closes after 10 minutes without a press
let STOP_WORDS: Set<String> = ["stop", "cancel", "ruko", "ruk", "ruk jao", "bas", "bas karo", "rehne do", "रुको", "रुक", "रुक जाओ", "बस", "बस करो", "रहने दो", "स्टॉप", "कैंसल"]

/// Lowercased letters and spaces only, so "Stop." and "स्टॉप।" compare.
func plain(_ s: String) -> String {
  let kept = s.lowercased().unicodeScalars.map { CharacterSet.letters.union(.nonBaseCharacters).contains($0) ? Character($0) : " " }
  return String(kept).split(separator: " ").joined(separator: " ")
}

/// "en" → "en-US", "hi" → "hi-IN", "ja" → "ja-JP": the model's own locale for a base language; unknown → auto.
func nemoTag(_ l: String?, _ known: [String: Int]) -> String {
  guard let l, !l.isEmpty, l != "auto" else { return "auto" }
  if let pick = ["en": "en-US", "hi": "hi-IN", "ja": "ja-JP", "zh": "zh-CN", "ko": "ko-KR"][l] { return pick }
  if known[l] != nil { return l }
  return known.keys.filter { $0.hasPrefix("\(l)-") }.sorted().first ?? "auto"
}

/// Smart Turn scores complete Hindi and Japanese commands low (0.01 to 0.17 on the corpus), so an imperative
/// ending also ends the turn: करो, खोलो, दिखाओ, "kholo", 表示して. A trailing "and" / "और" never does.
func soundsFinished(_ text: String, _ lang: String?) -> Bool {
  let words = plain(text).split(separator: " ")
  guard let last = words.last.map(String.init) else { return false }
  switch lang {
  case "hi": return ["दो", "लो", "दें", "करें", "कीजिए", "चाहिए"].contains(last) || last.hasSuffix("ो") || last.hasSuffix("ओ") || (last.count >= 3 && last.hasSuffix("o") && last.allSatisfy(\.isASCII))
  case "ja": return text.hasSuffix("て") || text.hasSuffix("ください") || text.hasSuffix("して。")
  default: return false
  }
}

// ---------- open models ----------

/// A downloaded, verified bundle (main writes `ready` after the sha256 check).
func modelDir(_ id: String) -> URL? {
  let d = modelsDir.appendingPathComponent(id, isDirectory: true)
  guard FileManager.default.fileExists(atPath: d.appendingPathComponent("ready").path) else { return nil }
  return d
}

// ---------- Apple fallback (English while the open model downloads) ----------

@available(macOS 26, *)
final class Analyzer {
  var format: AVAudioFormat?
  var cont: AsyncStream<AnalyzerInput>.Continuation?
  var analyzer: SpeechAnalyzer?
  var converter: AVAudioConverter?
  let locale = Locale(identifier: "en-US")

  func warm() async {
    let probe = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
    do {
      if let req = try await AssetInventory.assetInstallationRequest(supporting: [probe]) {
        send(["type": "setup"])
        try await req.downloadAndInstall()
      }
    } catch {
      send(["type": "error", "message": "Couldn't get Apple's speech model: \(error.localizedDescription)"])
    }
    format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [probe])
  }

  func begin(words: [String], onText: @escaping (String, Bool) -> Void) {
    let (stream, cont) = AsyncStream<AnalyzerInput>.makeStream()
    self.cont = cont
    if let f = format { converter = AVAudioConverter(from: fmt16, to: f) }
    let module = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults], attributeOptions: [])
    let a = SpeechAnalyzer(modules: [module], options: .init(priority: .userInitiated, modelRetention: .processLifetime))
    analyzer = a
    Task {
      var done = "", guess = ""
      do {
        if !words.isEmpty {
          let ctx = AnalysisContext()
          ctx.contextualStrings[.general] = words
          try? await a.setContext(ctx)
        }
        try await a.start(inputSequence: stream)
        for try await r in module.results {
          let t = String(r.text.characters)
          if r.isFinal { done += t; guess = "" } else { guess = t }
          onText((done + guess).trimmingCharacters(in: .whitespaces), false)
        }
      } catch {}
      onText((done + guess).trimmingCharacters(in: .whitespaces), true)
    }
  }

  func feed(_ samples: [Float]) {
    guard let conv = converter, let f = format, let cont = cont, !samples.isEmpty,
      let buf = AVAudioPCMBuffer(pcmFormat: fmt16, frameCapacity: AVAudioFrameCount(samples.count)) else { return }
    buf.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { buf.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
    guard let o = AVAudioPCMBuffer(pcmFormat: f, frameCapacity: AVAudioFrameCount(Double(samples.count) * f.sampleRate / Double(SR)) + 32) else { return }
    var given = false
    var err: NSError?
    _ = conv.convert(to: o, error: &err) { _, st in
      if given { st.pointee = .noDataNow; return nil }
      given = true
      st.pointee = .haveData
      return buf
    }
    if err == nil && o.frameLength > 0 { cont.yield(AnalyzerInput(buffer: o)) }
  }

  func end(cancel: Bool) {
    cont?.finish()
    cont = nil
    guard let a = analyzer else { return }
    analyzer = nil
    Task { if cancel { await a.cancelAndFinishNow() } else { try? await a.finalizeAndFinishThroughEndOfInput() } }
  }
}

// ---------- one turn ----------

final class Turn {
  let id: Int
  let hands: Bool
  let lang: String?
  let alt: String? // second language, decoded again after the final
  let started = now()
  var audio: [Float] = [] // this turn's audio, memory only: Smart Turn and the second-language decode read it
  var session: NemotronMLXStreamingSession?
  var partial = ""
  var firstPartialAt: Double?
  var stoppedAt: Double?
  var finalSent = false
  var barged = false
  var speech = false // VAD state inside the turn
  var speechFrames = 0
  var silenceSince: Double?
  var tail = 0 // samples of trailing silence the model already has
  var flushed = false // the flush went in early, during the pause
  var flushes = 0, flushesDone = 0 // early flushes queued / decoded: when equal and still flushed, the partial already holds every word
  var pushed = 0 // t.audio[..<pushed] went to the model
  var live = false // the recognizer has this turn (it waits while the models load)
  var ending = false // stopped before it was live
  var askedTurn = false
  init(id: Int, hands: Bool, langs: [String]) { self.id = id; self.hands = hands; lang = langs.first; alt = langs.count > 1 ? langs[1] : nil }
}

// ---------- the ears ----------

final class Ears {
  let pipe = DispatchQueue(label: "shrike.voice.pipe") // VAD, turn state, ring buffer
  let asrQ = DispatchQueue(label: "shrike.voice.asr", qos: .userInitiated) // model load and inference, serialized
  let engine = AVAudioEngine()
  var micConverter: AVAudioConverter?
  var apple: AnyObject? // pipe-only
  var appleReady = false // main-only

  // main-thread state
  var words: [String] = []
  var langs: [String] = [] // [hint, alternate]; [] = auto
  var hands = false
  var armed = false
  var lastPress = now()
  var held: Int? // push-to-talk turn whose stop hasn't arrived
  var idleTimer: Timer?
  var fakes: [String] = arg("--fake").map { $0.split(separator: "|").map(String.init) } ?? []
  var wavs: [String] = arg("--wav").map { $0.split(separator: "|").map(String.init) } ?? []
  var wavTimer: DispatchSourceTimer?
  var handsId = 1_000_000
  var handsPipe = false // pipe mirrors of hands and langs
  var langsPipe: [String] = []

  // pipe-queue state
  var ring = [Float](repeating: 0, count: PREROLL)
  var ringAt = 0
  var ringFilled = false
  var frame: [Float] = []
  var turn: Turn?
  var speechRun = 0
  var lastLevel = 0.0
  var levelAcc: Float = 0
  var levelN = 0

  // asrQ-only
  var asr: NemotronStreamingASRMLXModel?
  // pipe-only
  var vad: SileroVADModel?
  var smart: SmartTurnModel?
  var open = false // the open speech model is loaded
  var booting = false
  // main-only mirrors
  var openMain = false
  var vadMain = false

  var engineName: String { open ? "open" : "apple" }

  func ready() {
    send(["type": "ready", "onDevice": true, "available": fake || openMain || appleReady, "speech": "granted", "mic": micStatus()])
    send(["type": "engine", "engine": openMain ? "open" : "apple"])
  }

  /// Loads the open models (or Apple's fallback when the speech model isn't downloaded yet), then reports.
  func boot() {
    if fake { return ready() }
    pipe.sync { booting = true }
    asrQ.async {
      let sem = DispatchSemaphore(value: 0)
      var v: SileroVADModel?, st: SmartTurnModel?
      var apple = self.pipe.sync { self.apple }
      Task {
        if let d = modelDir("vad") { v = try? await SileroVADModel.fromPretrained(engine: .coreml, cacheDir: d, offlineMode: true) }
        if let d = modelDir("turn") {
          st = try? await SmartTurnModel.fromPretrained(cacheDir: d, offlineMode: true)
          try? st?.prewarm()
        }
        if let d = modelDir("asr") {
          if self.asr == nil {
            do {
              let m = try await NemotronStreamingASRMLXModel.fromDirectory(d)
              try m.warmUp()
              self.asr = m
            } catch {
              send(["type": "error", "message": "Couldn't load the speech model. Download it again in Settings › Voice. (\(error.localizedDescription))"])
            }
          }
        } else {
          self.asr = nil
        }
        if self.asr == nil, #available(macOS 26, *), SpeechTranscriber.isAvailable, apple == nil {
          let a = Analyzer()
          await a.warm()
          apple = a
        }
        sem.signal()
      }
      sem.wait()
      let open = self.asr != nil
      self.pipe.sync {
        self.vad = v
        self.smart = st
        self.open = open
        self.apple = apple
        self.booting = false
      }
      DispatchQueue.main.async {
        self.appleReady = apple != nil
        self.openMain = open
        self.vadMain = v != nil
        if v == nil && self.hands { self.hands = false; self.pipe.async { self.handsPipe = false } }
        self.ready()
      }
    }
  }

  func authorize(_ done: @escaping (Bool) -> Void) {
    if fake || !wavs.isEmpty { return done(true) }
    if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
      AVCaptureDevice.requestAccess(for: .audio) { _ in DispatchQueue.main.async { self.authorize(done) } }
      return
    }
    send(["type": "permission", "speech": "granted", "mic": micStatus()])
    done(micStatus() == "granted")
  }

  func handle(_ msg: [String: Any]) {
    switch msg["cmd"] as? String {
    case "context": words = Array(((msg["words"] as? [String]) ?? []).prefix(300))
    case "auth": authorize { _ in }
    case "config":
      let l = Array(((msg["langs"] as? [String]) ?? []).prefix(2))
      langs = l
      pipe.async { self.langsPipe = l }
    case "reload": boot()
    case "arm": if (msg["on"] as? Bool) == false { disarm() } else { authorize { ok in if ok { self.arm() } } }
    case "hands":
      let on = (msg["on"] as? Bool) == true
      if on && !vadMain && !fake { return send(["type": "error", "message": "Hands-free needs the voice models. Download them in Settings › Voice."]) }
      hands = on
      pipe.async { self.handsPipe = on }
      if on { authorize { ok in if ok && self.hands { self.arm(); if !self.wavs.isEmpty { self.playAll() } } } } else { pipe.async { if self.turn?.hands == true { self.endTurn() } } }
    case "start":
      let id = (msg["id"] as? Int) ?? 0
      lastPress = now()
      held = id
      if fake { return startFake(id) }
      authorize { ok in
        guard ok, self.held == id else { return send(["type": "final", "id": id, "text": ""]) } // let go during the mic prompt: no turn left open
        self.arm()
        let t = Turn(id: id, hands: false, langs: self.langs)
        self.pipe.async { self.begin(t, preroll: true) }
        if !self.wavs.isEmpty { self.playWav(self.wavs.removeFirst(), stopAtEnd: autostop) }
      }
    case "stop":
      held = nil
      if fake { return stopFake() }
      let at = now()
      pipe.async { if let t = self.turn, !t.hands { t.stoppedAt = at; self.endTurn() } }
    case "quit": quit(0)
    default: break
    }
  }

  // ---- mic ----

  func arm() {
    if armed { return }
    armed = true
    idleTimer?.invalidate()
    idleTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
      guard let self, !self.hands, now() - self.lastPress > ARM_IDLE_S else { return }
      self.disarm()
    }
    if !wavs.isEmpty || fake { return }
    let input = engine.inputNode
    let inFmt = input.outputFormat(forBus: 0)
    micConverter = AVAudioConverter(from: inFmt, to: fmt16)
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 512, format: inFmt) { [weak self] buf, _ in self?.take(buf) }
    engine.prepare()
    do { try engine.start() } catch {
      input.removeTap(onBus: 0)
      armed = false
      send(["type": "error", "message": "Couldn't open the microphone: \(error.localizedDescription)"])
    }
  }

  func disarm() {
    guard armed else { return }
    armed = false
    hands = false
    pipe.async { self.handsPipe = false }
    idleTimer?.invalidate()
    wavTimer?.cancel()
    wavTimer = nil
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
    pipe.async {
      if self.turn != nil { self.endTurn() }
      self.ringFilled = false
      self.ringAt = 0
    }
  }

  /// Any input buffer → 16 kHz mono → the pipe.
  func take(_ buf: AVAudioPCMBuffer, converter: AVAudioConverter? = nil) {
    guard let conv = converter ?? micConverter else { return }
    let cap = AVAudioFrameCount(Double(buf.frameLength) * Double(SR) / buf.format.sampleRate) + 64
    guard let o = AVAudioPCMBuffer(pcmFormat: fmt16, frameCapacity: cap) else { return }
    var given = false
    var err: NSError?
    _ = conv.convert(to: o, error: &err) { _, st in
      if given { st.pointee = .noDataNow; return nil }
      given = true
      st.pointee = .haveData
      return buf
    }
    guard err == nil, o.frameLength > 0 else { return }
    let s = Array(UnsafeBufferPointer(start: o.floatChannelData![0], count: Int(o.frameLength)))
    pipe.async { self.feed(s) }
  }

  // ---- WAV injection ----

  func wavSource(_ path: String) -> (AVAudioFile, AVAudioConverter)? {
    guard let f = try? AVAudioFile(forReading: URL(fileURLWithPath: path)), let c = AVAudioConverter(from: f.processingFormat, to: fmt16) else {
      send(["type": "error", "message": "Couldn't read \(path)"])
      return nil
    }
    return (f, c)
  }

  /// One file in real time (20ms buffers), then silence like a held key; --autostop stops at the end.
  func playWav(_ path: String, stopAtEnd: Bool) {
    guard let (file, conv) = wavSource(path) else { return }
    stream([(file, conv)], gap: 0) { [weak self] in
      guard stopAtEnd, let self else { return }
      let at = now()
      self.pipe.async { if let t = self.turn, !t.hands { t.stoppedAt = at; self.endTurn() } }
    }
  }

  /// Hands-free test: every queued file back to back, 1.5s of silence between, then silence.
  func playAll() {
    let srcs = wavs.compactMap(wavSource)
    wavs = []
    stream(srcs, gap: 1.5) {}
  }

  func stream(_ srcs: [(AVAudioFile, AVAudioConverter)], gap: Double, atEnd: @escaping () -> Void) {
    wavTimer?.cancel()
    var i = 0, gapLeft = 0.0, ended = false
    let silenceConv = AVAudioConverter(from: fmt16, to: fmt16)!
    let t = DispatchSource.makeTimerSource(queue: .main)
    t.schedule(deadline: .now(), repeating: .milliseconds(20))
    t.setEventHandler { [weak self] in
      guard let self else { return }
      if i < srcs.count, gapLeft <= 0 {
        let (file, conv) = srcs[i]
        let n = AVAudioFrameCount(file.processingFormat.sampleRate / 50)
        if file.framePosition < file.length, let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: n), (try? file.read(into: buf, frameCount: n)) != nil {
          return self.take(buf, converter: conv)
        }
        i += 1
        gapLeft = gap
        if i == srcs.count && !ended { ended = true; atEnd() }
      }
      gapLeft -= 0.02
      let z = AVAudioPCMBuffer(pcmFormat: fmt16, frameCapacity: 320)!
      z.frameLength = 320
      memset(z.floatChannelData![0], 0, 320 * 4)
      self.take(z, converter: silenceConv)
    }
    wavTimer = t
    t.resume()
  }

  // ---- the pipe (all below runs on `pipe`) ----

  func feed(_ s: [Float]) {
    for x in s {
      ring[ringAt] = x
      ringAt = (ringAt + 1) % PREROLL
      if ringAt == 0 { ringFilled = true }
    }
    if let t = turn {
      t.audio += s
      if t.live && t.pushed == t.audio.count - s.count && !t.flushed && (!t.hands || t.speech || (t.silenceSince.map { now() - $0 < PAUSE_S } ?? true)) { // hands-free: ASR only while speech
        asrPush(t, s)
        t.pushed = t.audio.count
        t.tail = t.speech || t.speechFrames == 0 ? 0 : t.tail + s.count
      }
    }
    level(s)
    frame += s
    while frame.count >= SileroVADModel.chunkSize {
      let f = Array(frame.prefix(SileroVADModel.chunkSize))
      frame.removeFirst(SileroVADModel.chunkSize)
      vadFrame(f)
    }
  }

  func preroll() -> [Float] {
    ringFilled ? Array(ring[ringAt...] + ring[..<ringAt]) : Array(ring[..<ringAt])
  }

  func vadFrame(_ f: [Float]) {
    guard let vad = vad, turn != nil || handsPipe else { return }
    let p = vad.processChunk(f)
    if let t = turn {
      if !t.speech && p >= VAD_ON {
        t.speech = true
        t.silenceSince = nil
        t.askedTurn = false
        if t.live && t.pushed < t.audio.count { // speech again after a gated or flushed pause: catch up, onset included
          let from = max(t.pushed, t.audio.count - SR / 4)
          asrPush(t, Array(t.audio[from...]))
          t.pushed = t.audio.count
          t.tail = 0
        }
        send(["type": "vad", "id": t.id, "speech": true])
      } else if t.speech && p < VAD_OFF {
        t.speech = false
        t.silenceSince = now()
        send(["type": "vad", "id": t.id, "speech": false])
      }
      if t.speech { t.speechFrames += 1; t.flushed = false }
      if t.hands, !t.speech, !t.flushed, open, t.speechFrames > 0, let q = t.silenceSince, now() - q >= EARLY_FLUSH_S { // hands-free: the flush goes in during the pause, so the end costs one chunk
        t.flushed = true
        t.flushes += 1
        let n = max(0, FLUSH - t.tail) + SR * 32 / 100, k = t.flushes // plus the padded chunk finalize() would add, so the partial can stand in for the final
        asrQ.async { self.decode(t, [Float](repeating: 0, count: n)); self.pipe.async { t.flushesDone = k } }
      }
      if t.hands { handsTick(t) }
      return
    }
    // hands-free, between turns: two speech frames in a row (64ms) open a turn with the pre-roll
    speechRun = p >= VAD_ON ? speechRun + 1 : 0
    if speechRun >= 2 {
      speechRun = 0
      handsId += 1
      let t = Turn(id: handsId, hands: true, langs: langsPipe)
      begin(t, preroll: true)
      t.speech = true
      t.speechFrames = 2
      send(["type": "vad", "id": t.id, "speech": true])
    }
  }

  func handsTick(_ t: Turn) {
    if now() - t.started > TURN_MAX_S { return endTurn() }
    guard let since = t.silenceSince else { return }
    let quiet = now() - since
    if quiet >= CAP_S { return endTurn() }
    if quiet >= PAUSE_S && !t.askedTurn {
      t.askedTurn = true
      if t.speechFrames < 6 { return endTurn() } // under ~200ms of speech: a click or a cough
      let p = (try? smart?.turnCompleteProbability(audio: t.audio, sampleRate: SR)) ?? 1
      let done = p >= SmartTurnModel.defaultThreshold || soundsFinished(t.partial, t.lang)
      send(["type": "turn", "id": t.id, "complete": done])
      if done { endTurn() }
    }
  }

  func begin(_ t: Turn, preroll withPreroll: Bool) {
    if let old = turn { cancelTurn(old) }
    turn = t
    if !t.hands { vad?.resetState() } // between presses it heard nothing, so its state is stale
    t.audio = withPreroll ? preroll() : []
    send(["type": "lang", "id": t.id, "lang": t.lang ?? "auto"])
    engage(t)
  }

  /// Hands the turn to the recognizer and catches it up on the audio so far (pre-roll included).
  func engage(_ t: Turn) {
    if t.finalSent { return }
    if booting { return asrQ.async { self.pipe.async { self.engage(t) } } } // first press while the models load: wait for them
    if open {
      asrQ.async {
        t.session = try? self.asr?.createSession(language: nemoTag(t.lang, self.asr?.languages.promptDictionary ?? [:]))
        self.pipe.async { self.goLive(t) }
      }
    } else if #available(macOS 26, *), let a = apple as? Analyzer {
      a.begin(words: words) { [weak self] text, final in self?.pipe.async { self?.appleText(t, text, final) } }
      goLive(t)
    } else {
      t.finalSent = true
      if turn === t { turn = nil }
      send(["type": "error", "id": t.id, "message": "Voice is getting ready. Download the speech model in Settings › Voice."])
    }
  }

  func goLive(_ t: Turn) {
    t.live = true
    let prime = t.pushed == 0 && t.audio.count < PREROLL ? [Float](repeating: 0, count: SR / 10) : [] // no pre-roll yet: 100ms of silence so a sharp first word isn't dropped
    if t.pushed < t.audio.count { asrPush(t, prime + Array(t.audio[t.pushed...])) }
    t.pushed = t.audio.count
    if t.ending { close(t) }
  }

  func asrPush(_ t: Turn, _ s: [Float]) {
    if open { asrQ.async { self.decode(t, s) } }
    else if #available(macOS 26, *), let a = apple as? Analyzer { a.feed(s) }
  }

  /// asrQ: one chunk into the session; a changed text goes out as a partial.
  func decode(_ t: Turn, _ s: [Float]) {
    guard let sess = t.session, let ps = try? sess.pushAudio(s), let last = ps.last?.text else { return }
    pipe.async { self.partial(t, last) }
  }

  func partial(_ t: Turn, _ text: String) {
    guard !t.finalSent, text != t.partial, !text.isEmpty else { return }
    t.partial = text
    if t.firstPartialAt == nil { t.firstPartialAt = now() }
    send(["type": "partial", "id": t.id, "text": text])
    bargeCheck(t, text)
  }

  func bargeCheck(_ t: Turn, _ text: String) {
    guard !t.barged, STOP_WORDS.contains(plain(text)) else { return }
    t.barged = true
    send(["type": "barge", "id": t.id])
  }

  func appleText(_ t: Turn, _ text: String, _ final: Bool) {
    final ? finish(t, text) : partial(t, text)
  }

  /// Ends the current turn: flush now; if the final is late, act on the last partial.
  func endTurn() {
    guard let t = turn else { return }
    turn = nil
    if t.speech { send(["type": "vad", "id": t.id, "speech": false]) }
    if t.hands && t.speechFrames < 6 { return finish(t, "") }
    close(t)
  }

  func close(_ t: Turn) {
    if !t.live { t.ending = true; return }
    if open, t.flushed, t.flushesDone == t.flushes, !t.partial.isEmpty { // only silence is left for the model: the partial is the final
      finish(t, t.partial)
      asrQ.async { self.alt(t) }
    } else if open {
      pipe.asyncAfter(deadline: .now() + LATE_FINAL_S) { if !t.finalSent && !t.partial.isEmpty { self.finish(t, t.partial) } }
      let pad = t.flushed ? 0 : max(SR / 4, FLUSH - t.tail) // read here: pipe state never crosses to asrQ
      asrQ.async {
        var text: String?
        if let sess = t.session {
          if pad > 0 { _ = try? sess.pushAudio([Float](repeating: 0, count: pad)) }
          text = (try? sess.finalize())?.last?.text
        }
        self.pipe.async { self.finish(t, text ?? t.partial) }
        self.alt(t)
      }
    } else if #available(macOS 26, *), let a = apple as? Analyzer {
      a.end(cancel: false)
    } else {
      finish(t, t.partial)
    }
  }

  func cancelTurn(_ t: Turn) {
    t.finalSent = true
    if #available(macOS 26, *), !open, let a = apple as? Analyzer { a.end(cancel: true) }
  }

  func finish(_ t: Turn, _ text: String) {
    guard !t.finalSent else { return }
    t.finalSent = true
    let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
    send(["type": "final", "id": t.id, "text": clean])
    bargeCheck(t, clean)
    if stats {
      var m: [String: Any] = ["type": "stat", "id": t.id, "audioMs": Int(Double(t.audio.count) / Double(SR) * 1000), "mb": Int(footprintMB()), "engine": engineName]
      if let f = t.firstPartialAt { m["firstPartialMs"] = Int((f - t.started) * 1000) }
      if let s = t.stoppedAt { m["finalMs"] = Int((now() - s) * 1000) }
      if t.hands, let s = t.silenceSince { m["pauseMs"] = Int((now() - s) * 1000) }
      send(m)
    }
  }

  /// asrQ: the same audio again with the second language, for the understanding layer to pick from on a miss.
  func alt(_ t: Turn) {
    guard let lang = t.alt, let m = asr, t.audio.count > SR / 4 else { return }
    guard let sess = try? m.createSession(language: nemoTag(lang, m.languages.promptDictionary)) else { return }
    _ = try? sess.pushAudio(t.audio + [Float](repeating: 0, count: FLUSH))
    let text = (try? sess.finalize())?.last?.text ?? ""
    send(["type": "alt", "id": t.id, "lang": lang, "text": text.trimmingCharacters(in: .whitespacesAndNewlines)])
  }

  func level(_ s: [Float]) {
    guard turn != nil || handsPipe, !s.isEmpty else { return }
    for x in s { levelAcc += x * x }
    levelN += s.count
    let t = now()
    if t - lastLevel < 0.032 { return }
    lastLevel = t
    let db = 20 * log10(max(sqrt(levelAcc / Float(max(levelN, 1))), 1e-7))
    levelAcc = 0
    levelN = 0
    send(["type": "level", "value": Double(min(1, max(0, (db + 55) / 45)))])
  }

  // ponytail: fake mode emits each word as a partial 40ms apart and the whole line as final on stop.
  var fakeText = ""
  var fakeId = 0
  var fakeLive = false
  func startFake(_ sid: Int) {
    fakeId = sid
    fakeText = fakes.isEmpty ? "" : fakes.removeFirst()
    fakeLive = true
    let parts = fakeText.split(separator: " ")
    for i in parts.indices {
      DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(40 * (i + 1))) {
        guard self.fakeLive && self.fakeId == sid else { return }
        send(["type": "level", "value": 0.6])
        send(["type": "partial", "id": sid, "text": parts[0...i].joined(separator: " ")])
      }
    }
  }

  func stopFake() {
    guard fakeLive else { return }
    fakeLive = false
    send(["type": "final", "id": fakeId, "text": fakeText])
  }
}

let ears = Ears()

func onLine(_ line: Data) {
  guard !line.isEmpty, let msg = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { return }
  DispatchQueue.main.async { ears.handle(msg) }
}

final class Lines {
  var buf = Data()
  func feed(_ d: Data) {
    buf.append(d)
    while let nl = buf.firstIndex(of: 0x0A) {
      let line = buf.subdata(in: buf.startIndex..<nl)
      buf.removeSubrange(buf.startIndex...nl)
      onLine(line)
    }
  }
}
let lines = Lines()

if let p = arg("--port"), let port = NWEndpoint.Port(p) {
  let conn = NWConnection(host: "127.0.0.1", port: port, using: .tcp)
  writeLine = { d in conn.send(content: d, completion: .contentProcessed { _ in }) }
  func receive() {
    conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, done, err in
      if let d = data { lines.feed(d) }
      if done || err != nil { quit(0) } // Shrike went away: so do we
      receive()
    }
  }
  conn.stateUpdateHandler = { st in
    switch st {
    case .ready:
      send(["type": "hello", "token": arg("--token") ?? ""])
      DispatchQueue.main.async { ears.boot() }
      receive()
    case .failed, .cancelled: quit(1)
    default: break
    }
  }
  conn.start(queue: DispatchQueue(label: "shrike.voice.net"))
} else {
  FileHandle.standardInput.readabilityHandler = { h in
    let d = h.availableData
    if d.isEmpty { quit(0) }
    lines.feed(d)
  }
  ears.boot()
}

NSApplication.shared.setActivationPolicy(.prohibited)
NSApplication.shared.run()
