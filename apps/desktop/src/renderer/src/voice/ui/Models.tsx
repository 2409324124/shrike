import { Check, Download, Trash2, X } from "lucide-react";
import type { VoiceModel, VoiceModels } from "@shrike/schema";
import { api } from "../../lib/api.ts";
import { cx, IconButton, Spinner } from "../../components/ui.tsx";
import { setPrefs, useVoiceStore } from "../store.ts";
import { bytes } from "./logic.ts";

// V-ui6: the one-time download (first run card and the rows in voice settings). Progress arrives on "voice:models".

const RESERVE = 1.5e9; // keep this much disk free after the download

export function totals(m: VoiceModels): { need: number; got: number; total: number; busy: boolean; ready: boolean; failed: VoiceModel | undefined } {
  const total = m.models.reduce((a, x) => a + x.bytes, 0);
  const got = m.models.reduce((a, x) => a + (x.state === "ready" || x.state === "verifying" ? x.bytes : (x.got ?? 0)), 0);
  const need = m.models.filter((x) => x.state !== "ready").reduce((a, x) => a + x.bytes, 0);
  return { need, got, total, busy: m.models.some((x) => x.state === "downloading" || x.state === "verifying"), ready: m.models.every((x) => x.state === "ready"), failed: m.models.find((x) => x.state === "failed") };
}

const act = (a: "download" | "cancel" | "delete", id?: VoiceModel["id"]) =>
  void api()
    .voiceModelAct(a, id)
    .then((models) => useVoiceStore.setState({ models }))
    .catch(() => {});

function Bar({ value, tone }: { value: number; tone?: "ok" | "fail" }) {
  return (
    <div className={cx("v-bar", tone)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <i style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

/** First press with the open model missing: what it costs, progress, and what works meanwhile. */
export function FirstRun() {
  const open = useVoiceStore((s) => s.firstRun);
  const models = useVoiceStore((s) => s.models);
  if (!open || !models) return null;
  const t = totals(models);
  const short = models.freeBytes - t.need < RESERVE;
  const close = () => useVoiceStore.setState({ firstRun: false });
  return (
    <section role="dialog" aria-label="Set up voice" className="v-card glass solid rise" data-voice-firstrun>
      <header className="flex items-center gap-2">
        <span className="lbl text-ink">{t.ready ? "Voice is ready" : "Voice runs on your Mac"}</span>
        <span className="flex-1" />
        <IconButton label="Close voice setup" onClick={close}>
          <X size={12} />
        </IconButton>
      </header>
      {t.ready ? (
        <p className="m-0 mt-1 text-[13px] text-ink">
          <Check size={13} className="mr-1.5 inline text-ok" aria-hidden />
          English, Hindi, Hinglish and 40 more languages, all on this Mac.
        </p>
      ) : (
        <>
          <p className="m-0 mt-1 text-[13px] text-ink">
            One download of {bytes(t.busy || t.got ? t.total : t.need)}: the speech model, a small planner and two tiny helpers. Audio never leaves your Mac.
          </p>
          {t.busy || t.got > 0 ? (
            <div className="mt-2.5 grid gap-1">
              <Bar value={t.total ? t.got / t.total : 0} tone={t.failed ? "fail" : undefined} />
              <span className="flex font-mono text-[11px] text-dim">
                <span>
                  {bytes(t.got)} of {bytes(t.total)}
                </span>
                <span className="flex-1" />
                <span>{models.models.some((m) => m.state === "verifying") ? "Checking the files" : `${Math.round((t.got / Math.max(1, t.total)) * 100)}%`}</span>
              </span>
            </div>
          ) : null}
          {t.failed && <p className="v-err m-0 mt-1.5 text-[12px]">{t.failed.name} didn't download: {t.failed.error ?? "the connection dropped"}. Try again.</p>}
          {short && <p className="m-0 mt-1.5 text-[12px] text-slow">Only {bytes(models.freeBytes)} free. Free up {bytes(t.need + RESERVE - models.freeBytes)} first so your Mac keeps 1.5 GB spare.</p>}
          <p className="m-0 mt-1.5 text-[12px] text-dim">Until it finishes, English works with Apple's on-device speech.</p>
          <footer className="mt-2.5 flex items-center justify-end gap-2">
            {t.busy ? (
              <button type="button" className="btn" onClick={() => act("cancel")}>
                Cancel
              </button>
            ) : (
              <>
                <button type="button" className="btn" onClick={() => (setPrefs({ later: true }), close())}>
                  Not now
                </button>
                <button type="button" className="btn go" disabled={short} onClick={() => act("download")}>
                  <Download size={11} aria-hidden />
                  {t.failed ? "Try again" : `Download ${bytes(t.need)}`}
                </button>
              </>
            )}
          </footer>
        </>
      )}
    </section>
  );
}

const STATE: Record<VoiceModel["state"], string> = { missing: "Not downloaded", downloading: "Downloading", verifying: "Checking", ready: "Ready", failed: "Failed" };

/** One row per model in voice settings. */
export function ModelRows({ models }: { models: VoiceModels }) {
  const t = totals(models);
  return (
    <div className="grid gap-1.5">
      {models.models.map((m) => (
        <div key={m.id} className="v-model" data-model={m.id} data-state={m.state}>
          <span className="min-w-0">
            <span className="block truncate text-[13px] text-ink">{m.name}</span>
            <span className="block font-mono text-[10.5px] text-dim">
              {bytes(m.bytes)} · {m.license}
            </span>
          </span>
          <span className={cx("micro text-[9.5px]", m.state === "ready" ? "text-ok" : m.state === "failed" ? "text-fail" : m.state === "missing" ? "text-faint" : "text-signal")}>
            {m.state === "downloading" && m.got != null ? `${Math.round((m.got / m.bytes) * 100)}%` : STATE[m.state]}
          </span>
          {m.state === "downloading" || m.state === "verifying" ? (
            <IconButton label={`Cancel ${m.name}`} onClick={() => act("cancel", m.id)}>
              {m.state === "verifying" ? <Spinner size={11} /> : <X size={12} />}
            </IconButton>
          ) : m.state === "ready" ? (
            <IconButton label={`Delete ${m.name}`} onClick={() => act("delete", m.id)}>
              <Trash2 size={12} />
            </IconButton>
          ) : (
            <IconButton label={`Download ${m.name}`} onClick={() => act("download", m.id)}>
              <Download size={12} />
            </IconButton>
          )}
          {m.state === "downloading" && (
            <span className="col-span-3">
              <Bar value={(m.got ?? 0) / m.bytes} />
            </span>
          )}
        </div>
      ))}
      <span className="flex items-center gap-2 font-mono text-[10.5px] text-dim">
        <span>
          {bytes(t.total - t.need)} of {bytes(t.total)} on disk · {bytes(models.freeBytes)} free
        </span>
        <span className="flex-1" />
        {!t.ready && !t.busy && (
          <button type="button" className="hud-btn solid" onClick={() => act("download")}>
            <Download size={11} aria-hidden />
            Download all
          </button>
        )}
      </span>
    </div>
  );
}
