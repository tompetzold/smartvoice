type PlayerBarProps = {
  isPlaying: boolean;
  isLoadingAudio: boolean;
  hasVoice: boolean;
  chunkCount: number;
  currentGlobalSeconds: number;
  estimatedTotalSeconds: number;
  playbackRate: number;
  onPlayPause: () => void;
  onSeekGlobalTime: (seconds: number) => void;
};

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }

  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const restSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(restSeconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(restSeconds).padStart(2, "0")}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export default function PlayerBar({
  isPlaying,
  isLoadingAudio,
  hasVoice,
  chunkCount,
  currentGlobalSeconds,
  estimatedTotalSeconds,
  playbackRate,
  onPlayPause,
  onSeekGlobalTime,
}: PlayerBarProps) {
  const canPlay = chunkCount > 0 && hasVoice && !isLoadingAudio;
  const effectiveCurrentSeconds = currentGlobalSeconds / playbackRate;
  const effectiveTotalSeconds = estimatedTotalSeconds / playbackRate;
  const progressValue = clamp(currentGlobalSeconds, 0, Math.max(0, estimatedTotalSeconds));

  function seekRelative(offsetSeconds: number) {
    const nextSeconds = clamp(currentGlobalSeconds + offsetSeconds, 0, Math.max(0, estimatedTotalSeconds));
    onSeekGlobalTime(nextSeconds);
  }

  return (
    <section className="player-shell" aria-label="Audio Player">
      <input
        className="player-progress"
        type="range"
        min="0"
        max={Math.max(0, estimatedTotalSeconds)}
        step="0.1"
        value={progressValue}
        onChange={(event) => onSeekGlobalTime(Number(event.target.value))}
        disabled={!hasVoice || chunkCount === 0 || isLoadingAudio}
        aria-label="Position"
      />

      <div className="player-controls">
        <div className="player-time left">{hasVoice ? formatTime(effectiveCurrentSeconds) : "0:00"}</div>

        <div className="player-buttons">
          <button
            className="player-skip-button"
            type="button"
            onClick={() => seekRelative(-10)}
            disabled={!hasVoice || chunkCount === 0 || isLoadingAudio}
            aria-label="10 Sekunden zurück"
            title="10 Sekunden zurück"
          >
            -10
          </button>

          <button className="player-main-button" type="button" onClick={onPlayPause} disabled={!canPlay}>
            {isLoadingAudio ? "…" : isPlaying ? "Ⅱ" : "▶"}
          </button>

          <button
            className="player-skip-button"
            type="button"
            onClick={() => seekRelative(10)}
            disabled={!hasVoice || chunkCount === 0 || isLoadingAudio}
            aria-label="10 Sekunden vor"
            title="10 Sekunden vor"
          >
            +10
          </button>
        </div>

        <div className="player-time right">{hasVoice ? formatTime(effectiveTotalSeconds) : "0:00"}</div>
      </div>
    </section>
  );
}