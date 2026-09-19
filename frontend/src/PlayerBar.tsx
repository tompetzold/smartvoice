import { useMemo, useState } from "react";

type VoiceOption = {
  id: string;
  name: string;
  isDefault: boolean;
};

type PlayerBarProps = {
  isPlaying: boolean;
  isLoadingAudio: boolean;
  hasVoice: boolean;
  chunkCount: number;
  currentGlobalSeconds: number;
  estimatedTotalSeconds: number;
  playbackRate: number;
  volume: number;
  voices: VoiceOption[];
  selectedVoiceId: string;
  autoScrollEnabled: boolean;
  onPlayPause: () => void;
  onSeekGlobalTime: (seconds: number) => void;
  onPlaybackRateChange: (rate: number) => void;
  onVolumeChange: (volume: number) => void;
  onVoiceChange: (voiceId: string) => void;
  onAutoScrollChange: (enabled: boolean) => void;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
      <path d="m5.5 7.7 4.5 4.5 4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
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

function formatVoiceName(voice: VoiceOption | null): string {
  if (!voice) {
    return "Stimme";
  }

  const idParts = voice.id.split("-").filter(Boolean);

  if (idParts.length >= 2) {
    return idParts[1]
      .split("_")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  return voice.name
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export default function PlayerBar({
  isPlaying,
  isLoadingAudio,
  hasVoice,
  chunkCount,
  currentGlobalSeconds,
  estimatedTotalSeconds,
  playbackRate,
  volume,
  voices,
  selectedVoiceId,
  autoScrollEnabled,
  onPlayPause,
  onSeekGlobalTime,
  onPlaybackRateChange,
  onVolumeChange,
  onVoiceChange,
  onAutoScrollChange,
}: PlayerBarProps) {
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const canPlay = chunkCount > 0 && hasVoice && !isLoadingAudio;
  const normalizedVolume = clamp(volume, 0, 1);
  const selectedVoice = useMemo(
    () => voices.find((voice) => voice.id === selectedVoiceId) ?? voices[0] ?? null,
    [voices, selectedVoiceId],
  );

  const voiceInitials = useMemo(() => {
    const source = formatVoiceName(selectedVoice);
    const parts = source
      .replaceAll("_", " ")
      .replaceAll("-", " ")
      .split(/\s+/)
      .filter(Boolean);

    if (parts.length === 0) {
      return "SV";
    }

    if (parts.length === 1) {
      return parts[0].slice(0, 2).toUpperCase();
    }

    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }, [selectedVoice]);

  function seekRelative(offsetSeconds: number) {
    const nextSeconds = clamp(currentGlobalSeconds + offsetSeconds, 0, Math.max(0, estimatedTotalSeconds));
    onSeekGlobalTime(nextSeconds);
  }

  function closePopovers() {
    setVoiceOpen(false);
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
    setVoiceOpen((open) => !open);
  }

  function openSpeed() {
    setVolumeOpen(false);
    setVoiceOpen(false);
    setSpeedOpen((open) => !open);
  }

  return (
    <>
      {voiceOpen && (
        <div className="player-popover voice-popover" role="dialog" aria-label="Stimme auswählen">
          <div className="popover-header">
            <button className="popover-select-pill" type="button">
              Stimme
              <ChevronDownIcon />
            </button>
            <button className="popover-close" type="button" onClick={() => setVoiceOpen(false)} aria-label="Stimmenauswahl schließen">
              <CloseIcon />
            </button>
          </div>

          <div className="voice-section-label">Verfügbar</div>

          {voices.length === 0 ? (
            <div className="voice-empty">Keine Stimme installiert.</div>
          ) : (
            <div className="voice-grid">
              {voices.map((voice) => {
                const active = voice.id === selectedVoiceId;
                const cleaned = formatVoiceName(voice);
                const parts = cleaned.split(/\s+/).filter(Boolean);
                const initials = parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : cleaned.slice(0, 2);

                return (
                  <button
                    className={`voice-card ${active ? "active" : ""}`}
                    type="button"
                    key={voice.id}
                    onClick={() => {
                      onVoiceChange(voice.id);
                      setVoiceOpen(false);
                    }}
                  >
                    <span className="voice-avatar">{initials.toUpperCase()}</span>
                    <span className="voice-card-name">{cleaned}</span>
                    <span className="voice-card-meta">Deutsch{voice.isDefault ? " · Standard" : ""}</span>
                  </button>
                );
              })}
            </div>
          )}
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

      <section className="player-shell" aria-label="Audio Player">
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
                className={`player-icon-button ${volumeOpen ? "active" : ""}`}
                type="button"
                onClick={openVolume}
                aria-label="Lautstärke"
                aria-expanded={volumeOpen}
                title={`Lautstärke ${Math.round(normalizedVolume * 100)} %`}
              >
                <SpeakerIcon muted={normalizedVolume === 0} />
              </button>
            </div>
            <button
              className="player-voice-avatar"
              type="button"
              onClick={openVoice}
              aria-label="Stimme auswählen"
              title={selectedVoice ? formatVoiceName(selectedVoice) : "Stimme auswählen"}
            >
              {voiceInitials}
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

          <button className="player-close-button" type="button" onClick={closePopovers} aria-label="Player-Menüs schließen">
            <CloseIcon />
          </button>
        </div>
      </section>
    </>
  );
}
