import { useMemo, useState } from "react";
import thorstenImage from "./assets/thorsten.png";

type VoiceProvider = "piper" | "kokoro";

type VoiceOption = {
  id: string;
  name: string;
  provider: VoiceProvider;
  variantLabel: string;
  language: string;
  quality: string;
  available: boolean;
  downloaded: boolean;
  requiredBytes: number;
  requiredSizeLabel: string;
  downloadState: "idle" | "downloading" | "paused" | "ready" | "error";
  downloadProgress: number;
  downloadMessage: string;
  downloadError: string;
  downloadBytes: number;
  downloadTotalBytes: number;
  downloadBytesExact: boolean;
  isDefault: boolean;
};

type VoiceVariant = {
  id: VoiceProvider;
  label: string;
};

type PlayerBarProps = {
  isPlaying: boolean;
  isLoadingAudio: boolean;
  playbackError: string | null;
  hasVoice: boolean;
  chunkCount: number;
  currentGlobalSeconds: number;
  estimatedTotalSeconds: number;
  playbackRate: number;
  volume: number;
  voices: VoiceOption[];
  voiceVariants: VoiceVariant[];
  selectedVoiceId: string;
  autoScrollEnabled: boolean;
  onPlayPause: () => void;
  onSeekGlobalTime: (seconds: number) => void;
  onPlaybackRateChange: (rate: number) => void;
  onVolumeChange: (volume: number) => void;
  onVoiceChange: (voiceId: string) => void;
  onVoiceDownload: (voiceId: string) => Promise<void>;
  onVoiceDownloadPause: (voiceId: string) => Promise<void>;
  onVoiceDownloadResume: (voiceId: string) => Promise<void>;
  onVoiceDownloadCancel: (voiceId: string) => Promise<void>;
  onAutoScrollChange: (enabled: boolean) => void;
  onRetryPlayback: () => void;
  onDismissPlaybackError: () => void;
  onClose: () => void;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatRemainingTime(seconds: number): string {
  const rounded = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;

  if (hours > 0) {
    return `-${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }

  return `-${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8.25 6.1c0-1.03 1.12-1.67 2.02-1.15l8.25 4.78c.89.52.89 1.8 0 2.32l-8.25 4.78c-.9.52-2.02-.12-2.02-1.15V6.1Z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="5" width="3.6" height="14" rx="1.3" fill="currentColor" />
      <rect x="13.4" y="5" width="3.6" height="14" rx="1.3" fill="currentColor" />
    </svg>
  );
}

function SpeakerIcon({ muted = false }: { muted?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5.5 9.2H8l4.2-3.3a1 1 0 0 1 1.62.78v10.66a1 1 0 0 1-1.62.78L8 14.8H5.5a1.5 1.5 0 0 1-1.5-1.5v-2.6a1.5 1.5 0 0 1 1.5-1.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      {muted ? (
        <path d="m16.2 9.1 4.2 5.8m0-5.8-4.2 5.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      ) : (
        <>
          <path d="M17 8.2a5.4 5.4 0 0 1 0 7.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M15.2 10.1a2.8 2.8 0 0 1 0 3.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

function SkipIcon({ direction }: { direction: "back" | "forward" }) {
  return (
    <svg viewBox="0 0 28 28" aria-hidden="true">
      <path
        d={direction === "back" ? "M7.1 10.3V5.8l-3.8 3.8 3.8 3.8V10.3c1.55-2.2 4.12-3.62 7.02-3.62A8.54 8.54 0 1 1 6.2 18.42" : "M20.9 10.3V5.8l3.8 3.8-3.8 3.8V10.3c-1.55-2.2-4.12-3.62-7.02-3.62A8.54 8.54 0 1 0 21.8 18.42"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text x="14" y="18" textAnchor="middle" fontSize="8.4" fontWeight="800" fill="currentColor">
        10
      </text>
    </svg>
  );
}


function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m6 8 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m5.4 5.4 9.2 9.2M14.6 5.4l-9.2 9.2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5 10h10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 5v10M5 10h10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function voiceSubtitle(voice: VoiceOption): string {
  const parts = [voice.language || "Deutsch"];

  if (voice.provider === "piper" && voice.quality) {
    parts.push(voice.quality);
  } else if (voice.provider === "kokoro") {
    parts.push("Kokoro");
  }

  return parts.join(" · ");
}

function formatDownloadMegabytes(value: number): string {
  const bytes = Math.max(0, value);
  return `${Math.floor(bytes / 1_000_000)} MB`;
}

function DownloadProgressRing({ voice }: { voice: VoiceOption }) {
  const normalized = clamp(voice.downloadProgress, 0, 100);
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalized / 100) * circumference;
  const totalBytes = voice.downloadTotalBytes || 0;

  const downloadedMegabytes = formatDownloadMegabytes(voice.downloadBytes);
  const byteStatus = totalBytes > 0
    ? `${downloadedMegabytes} / ${formatDownloadMegabytes(totalBytes)}`
    : `${downloadedMegabytes} geladen`;

  return (
    <span
      className="voice-download-progress"
      aria-label={`Download ${byteStatus}`}
    >
      <svg viewBox="0 0 26 26" aria-hidden="true">
        <circle className="voice-download-track" cx="13" cy="13" r={radius} />
        <circle
          className="voice-download-value"
          cx="13"
          cy="13"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
        />
      </svg>
      <span className="voice-download-bytes">{byteStatus}</span>
    </span>
  );
}

export default function PlayerBar({
  isPlaying,
  isLoadingAudio,
  playbackError,
  hasVoice,
  chunkCount,
  currentGlobalSeconds,
  estimatedTotalSeconds,
  playbackRate,
  volume,
  voices,
  voiceVariants,
  selectedVoiceId,
  autoScrollEnabled,
  onPlayPause,
  onSeekGlobalTime,
  onPlaybackRateChange,
  onVolumeChange,
  onVoiceChange,
  onVoiceDownload,
  onVoiceDownloadPause,
  onVoiceDownloadResume,
  onVoiceDownloadCancel,
  onAutoScrollChange,
  onRetryPlayback,
  onDismissPlaybackError,
  onClose,
}: PlayerBarProps) {
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceVariantOpen, setVoiceVariantOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<VoiceProvider>("piper");
  const [speedOpen, setSpeedOpen] = useState(false);
  const [progressHovered, setProgressHovered] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const canPlay = chunkCount > 0 && hasVoice && !isLoadingAudio;
  const normalizedVolume = clamp(volume, 0, 1);
  const selectedVoice = useMemo(
    () => voices.find((voice) => voice.id === selectedVoiceId) ?? voices[0] ?? null,
    [voices, selectedVoiceId],
  );
  const effectiveProvider = selectedVoice?.provider ?? selectedProvider;
  const activeProvider = voiceOpen ? selectedProvider : effectiveProvider;
  const selectedVariant =
    voiceVariants.find((variant) => variant.id === activeProvider)
    ?? voiceVariants[0]
    ?? { id: "piper" as VoiceProvider, label: "Piper" };
  const filteredVoices = voices.filter((voice) => voice.provider === selectedVariant.id);
  const progressPercent =
    estimatedTotalSeconds > 0
      ? clamp((currentGlobalSeconds / estimatedTotalSeconds) * 100, 0, 100)
      : 0;
  const remainingPlaybackSeconds =
    estimatedTotalSeconds > 0
      ? Math.max(
          0,
          (estimatedTotalSeconds - currentGlobalSeconds) / Math.max(0.1, playbackRate),
        )
      : 0;
  const progressTooltipPercent = clamp(
    progressPercent,
    8,
    92,
  );


  function seekRelative(offsetSeconds: number) {
    const nextSeconds = clamp(currentGlobalSeconds + offsetSeconds, 0, Math.max(0, estimatedTotalSeconds));
    onSeekGlobalTime(nextSeconds);
  }

  function closePopovers() {
    setVoiceOpen(false);
    setVoiceVariantOpen(false);
    setSpeedOpen(false);
    setVolumeOpen(false);
  }

  function updateRate(nextRate: number) {
    onPlaybackRateChange(clamp(Math.round(nextRate * 10) / 10, 0.5, 2.5));
  }

  function openVolume() {
    setVoiceOpen(false);
    setSpeedOpen(false);
    setVolumeOpen((open) => !open);
  }

  function openVoice() {
    setVolumeOpen(false);
    setSpeedOpen(false);
    setSelectedProvider(selectedVoice?.provider ?? "piper");
    setVoiceVariantOpen(false);
    setVoiceOpen((open) => !open);
  }

  function openSpeed() {
    setVolumeOpen(false);
    setVoiceOpen(false);
    setVoiceVariantOpen(false);
    setSpeedOpen((open) => !open);
  }

  return (
    <>
      {voiceOpen && (
        <div className="player-popover voice-popover" role="dialog" aria-label="Stimme auswählen">
          <div className="voice-popover-header">
            <div className="voice-variant-control">
              <button
                className="voice-variant-select"
                type="button"
                onClick={() => setVoiceVariantOpen((current) => !current)}
                aria-expanded={voiceVariantOpen}
              >
                {selectedVariant.label}
                <ChevronDownIcon />
              </button>

              {voiceVariantOpen && (
                <div className="voice-variant-menu" role="menu">
                  {voiceVariants.map((variant) => (
                    <button
                      className={variant.id === selectedVariant.id ? "active" : ""}
                      type="button"
                      role="menuitem"
                      key={variant.id}
                      onClick={() => {
                        setSelectedProvider(variant.id);
                        setVoiceVariantOpen(false);
                      }}
                    >
                      <span>{variant.label}</span>
                      {variant.id === selectedVariant.id && <span className="voice-variant-check">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              className="popover-close"
              type="button"
              onClick={() => {
                setVoiceVariantOpen(false);
                setVoiceOpen(false);
              }}
              aria-label="Stimmenauswahl schließen"
            >
              <CloseIcon />
            </button>
          </div>

          <div className="voice-list">
            {filteredVoices.map((voice) => {
              const active = voice.id === selectedVoiceId;
              const downloading = voice.downloadState === "downloading";
              const paused = voice.downloadState === "paused";
              const activeDownload = downloading || paused;
              const failed = voice.downloadState === "error";

              return (
                <div
                  className={`voice-list-item ${active ? "active" : ""} ${!voice.downloaded ? "not-downloaded" : ""}`}
                  key={voice.id}
                >
                  <button
                    className="voice-choice-main"
                    type="button"
                    disabled={!voice.downloaded}
                    onClick={() => {
                      onVoiceChange(voice.id);
                      setVoiceVariantOpen(false);
                      setVoiceOpen(false);
                    }}
                    aria-pressed={active}
                  >
                    <span className="voice-flag-avatar" aria-hidden="true">
                      <img src={thorstenImage} alt="" />
                    </span>
                    <span className="voice-list-copy">
                      <strong>Thorsten</strong>
                      <small>{voiceSubtitle(voice)}</small>
                      {!voice.downloaded && (
                        <span className="voice-storage-hint">{voice.requiredSizeLabel} Speicher</span>
                      )}
                    </span>
                  </button>

                  <div className="voice-list-action">
                    {voice.downloaded ? (
                      active ? (
                        <span className="voice-selected-check" aria-label="Ausgewählt">✓</span>
                      ) : (
                        <button
                          className="voice-use-button"
                          type="button"
                          onClick={() => {
                            onVoiceChange(voice.id);
                            setVoiceVariantOpen(false);
                            setVoiceOpen(false);
                          }}
                        >
                          Auswählen
                        </button>
                      )
                    ) : activeDownload ? (
                      <div className="voice-download-active">
                        <DownloadProgressRing voice={voice} />
                        <div className="voice-download-controls">
                          <button
                            type="button"
                            onClick={() =>
                              void (paused
                                ? onVoiceDownloadResume(voice.id)
                                : onVoiceDownloadPause(voice.id))
                            }
                          >
                            {paused ? "Fortsetzen" : "Pause"}
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() => void onVoiceDownloadCancel(voice.id)}
                          >
                            Beenden
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        className={`voice-download-button ${failed ? "retry" : ""}`}
                        type="button"
                        onClick={() => void onVoiceDownload(voice.id)}
                        title={failed ? voice.downloadError : `Benötigt ${voice.requiredSizeLabel}`}
                      >
                        {failed ? "Erneut" : "Download"}
                      </button>
                    )}
                  </div>

                  {activeDownload && voice.downloadMessage && (
                    <div className="voice-download-message">
                      {paused ? "Pausiert" : voice.downloadMessage}
                    </div>
                  )}
                  {failed && voice.downloadError && (
                    <div className="voice-download-message error">{voice.downloadError}</div>
                  )}
                </div>
              );
            })}

            {filteredVoices.length === 0 && (
              <div className="voice-empty">Keine Thorsten-Stimme für diese Variante gefunden.</div>
            )}
          </div>
        </div>
      )}

      {speedOpen && (
        <div className="player-popover speed-popover" role="dialog" aria-label="Lesegeschwindigkeit">
          <div className="popover-header speed-header">
            <div>
              <div className="speed-title">Lesegeschwindigkeit</div>
              <div className="speed-subtitle">{playbackRate < 0.9 ? "Langsam" : playbackRate > 1.25 ? "Schnell" : "Normal"}</div>
            </div>
            <button className="popover-close" type="button" onClick={() => setSpeedOpen(false)} aria-label="Geschwindigkeit schließen">
              <CloseIcon />
            </button>
          </div>

          <div className="speed-stepper">
            <button type="button" onClick={() => updateRate(playbackRate - 0.1)} aria-label="Langsamer">
              <MinusIcon />
            </button>
            <strong>{playbackRate.toFixed(playbackRate % 1 === 0 ? 0 : 1)}x</strong>
            <button type="button" onClick={() => updateRate(playbackRate + 0.1)} aria-label="Schneller">
              <PlusIcon />
            </button>
          </div>

          <div className="speed-presets">
            {[0.8, 1, 1.2, 1.5, 2, 2.5].map((rate) => (
              <button
                className={Math.abs(playbackRate - rate) < 0.01 ? "active" : ""}
                type="button"
                key={rate}
                onClick={() => onPlaybackRateChange(rate)}
              >
                {rate}x
              </button>
            ))}
          </div>

          <div className="speed-setting-row">
            <div>
              <strong>Automatisch folgen</strong>
              <span>Dokument folgt der gesprochenen Stelle</span>
            </div>
            <button
              className={`switch ${autoScrollEnabled ? "on" : ""}`}
              type="button"
              onClick={() => onAutoScrollChange(!autoScrollEnabled)}
              aria-pressed={autoScrollEnabled}
              aria-label="Automatisch folgen"
            >
              <span />
            </button>
          </div>
        </div>
      )}

      {playbackError && (
        <div className="player-error-banner" role="alert">
          <div className="player-error-copy">
            <strong>Audio konnte nicht erzeugt werden</strong>
            <span>{playbackError}</span>
          </div>
          <div className="player-error-actions">
            <button type="button" className="player-error-retry" onClick={onRetryPlayback}>
              Erneut versuchen
            </button>
            <button
              type="button"
              className="player-error-dismiss"
              onClick={onDismissPlaybackError}
              aria-label="Fehlermeldung schließen"
            >
              <CloseIcon />
            </button>
          </div>
        </div>
      )}

      <section className="player-shell" aria-label="Audio Player">
        {estimatedTotalSeconds > 0 && (
          <>
            <div className="player-progress-clip" aria-hidden="true">
              <div
                className="player-progress-fill"
                style={{ width: `${progressPercent}%` }}
              />
            </div>

            <div
              className="player-progress-indicator"
              role="progressbar"
              aria-label={`Verbleibende Wiedergabezeit ${formatRemainingTime(remainingPlaybackSeconds)}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progressPercent)}
              onMouseEnter={() => setProgressHovered(true)}
              onMouseLeave={() => setProgressHovered(false)}
            >
              {progressHovered && (
                <span
                  className="player-progress-tooltip"
                  style={{ left: `${progressTooltipPercent}%` }}
                >
                  {formatRemainingTime(remainingPlaybackSeconds)}
                </span>
              )}
            </div>
          </>
        )}

        <div className="player-main-row">
          <div className="player-left-actions">
            <div className="player-volume-control">
              {volumeOpen && (
                <div className="volume-popover" role="dialog" aria-label="Lautstärke">
                  <input
                    className="volume-slider"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={normalizedVolume}
                    onChange={(event) => onVolumeChange(Number(event.target.value))}
                    aria-label={`Lautstärke ${Math.round(normalizedVolume * 100)} Prozent`}
                  />
                </div>
              )}

              <button
                className={`player-icon-button volume-button ${volumeOpen ? "active" : ""}`}
                type="button"
                onClick={openVolume}
                aria-label={`Lautstärke ${Math.round(normalizedVolume * 100)} Prozent`}
                aria-expanded={volumeOpen}
              >
                <SpeakerIcon muted={normalizedVolume === 0} />
              </button>
            </div>
            <button
              className="player-voice-avatar"
              type="button"
              onClick={openVoice}
              aria-label="Stimme auswählen"
              title={
                selectedVoice
                  ? `Thorsten · ${selectedVoice.variantLabel}${selectedVoice.quality ? ` · ${selectedVoice.quality}` : ""}`
                  : "Stimme auswählen"
              }
            >
              <img src={thorstenImage} alt="" aria-hidden="true" />
            </button>
          </div>

          <button
            className="player-icon-button skip"
            type="button"
            onClick={() => seekRelative(-10)}
            disabled={!hasVoice || chunkCount === 0 || isLoadingAudio}
            aria-label="10 Sekunden zurück"
            title="10 Sekunden zurück"
          >
            <SkipIcon direction="back" />
          </button>

          <button className="player-main-button" type="button" onClick={onPlayPause} disabled={!canPlay} aria-label={isPlaying ? "Pause" : "Abspielen"}>
            {isLoadingAudio ? <span className="player-loading-dot">•••</span> : isPlaying ? <PauseIcon /> : <PlayIcon />}
          </button>

          <button
            className="player-icon-button skip"
            type="button"
            onClick={() => seekRelative(10)}
            disabled={!hasVoice || chunkCount === 0 || isLoadingAudio}
            aria-label="10 Sekunden vor"
            title="10 Sekunden vor"
          >
            <SkipIcon direction="forward" />
          </button>

          <button
            className="player-rate-button"
            type="button"
            onClick={openSpeed}
            aria-label="Geschwindigkeit"
          >
            {playbackRate.toFixed(playbackRate % 1 === 0 ? 0 : 1)}x
          </button>

          <button
            className="player-close-button"
            type="button"
            onClick={() => {
              closePopovers();
              onClose();
            }}
            aria-label="Player schließen"
            title="Lesemodus"
          >
            <CloseIcon />
          </button>
        </div>
      </section>
    </>
  );
}
