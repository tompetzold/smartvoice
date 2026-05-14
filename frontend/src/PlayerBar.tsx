type ReadingUnit = {
  unitId: string;
  text: string;
  type: string;
  source: string;
  pageNumber: number;
  pageNumbers: number[];
  lineBoxes: number[][];
  wordIds: string[];
};

type PlayerBarProps = {
  activeUnit: ReadingUnit | null;
  activeChunkIndex: number;
  chunkCount: number;
  isPlaying: boolean;
  isLoadingAudio: boolean;
  hasVoice: boolean;
  currentGlobalSeconds: number;
  estimatedTotalSeconds: number;
  playbackRate: number;
  autoScrollEnabled: boolean;
  onPlayPause: () => void;
  onStop: () => void;
  onSeekGlobalTime: (seconds: number) => void;
  onPlaybackRateChange: (rate: number) => void;
  onAutoScrollChange: (enabled: boolean) => void;
};

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "00:00";
  }

  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const restSeconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(restSeconds).padStart(2, "0")}`;
}

export default function PlayerBar({
  activeUnit,
  activeChunkIndex,
  chunkCount,
  isPlaying,
  isLoadingAudio,
  hasVoice,
  currentGlobalSeconds,
  estimatedTotalSeconds,
  playbackRate,
  autoScrollEnabled,
  onPlayPause,
  onStop,
  onSeekGlobalTime,
  onPlaybackRateChange,
  onAutoScrollChange,
}: PlayerBarProps) {
  const canPlay = chunkCount > 0 && hasVoice && !isLoadingAudio;
  const effectiveCurrentSeconds = currentGlobalSeconds / playbackRate;
  const effectiveTotalSeconds = estimatedTotalSeconds / playbackRate;

  return (
    <section className="player-shell">
      <div className="player-main compact">
        <button className="player-button primary" type="button" onClick={onPlayPause} disabled={!canPlay}>
          {isLoadingAudio ? "Lädt..." : isPlaying ? "Pause" : "Play"}
        </button>

        <button
          className="player-button secondary"
          type="button"
          onClick={onStop}
          disabled={!hasVoice || chunkCount === 0 || isLoadingAudio}
        >
          Stop
        </button>
      </div>

      <div className="player-meta">
        <strong>
          {hasVoice
            ? `${formatTime(effectiveCurrentSeconds)} / ${formatTime(effectiveTotalSeconds)} · Chunk ${
                activeChunkIndex + 1
              } / ${chunkCount}`
            : "Keine Piper-Stimme gefunden"}
        </strong>
        <span>{activeUnit?.text ?? "Lege eine Piper-Stimme unter backend/data/piper_voices ab."}</span>
      </div>

      <div className="player-right">
        <input
          className="player-seeker"
          type="range"
          min="0"
          max={Math.max(0, estimatedTotalSeconds)}
          step="0.1"
          value={Math.min(currentGlobalSeconds, Math.max(0, estimatedTotalSeconds))}
          onChange={(event) => onSeekGlobalTime(Number(event.target.value))}
          disabled={!hasVoice || chunkCount === 0 || isLoadingAudio}
        />

        <div className="player-options">
          <div className="speed-control">
            <span>Speed</span>
            <input
              type="range"
              min="0.1"
              max="2.0"
              step="0.05"
              value={playbackRate}
              onChange={(event) => onPlaybackRateChange(Number(event.target.value))}
              disabled={!hasVoice || chunkCount === 0}
            />
            <strong>{playbackRate.toFixed(2)}x</strong>
          </div>

          <label className="autoscroll-toggle">
            <input
              type="checkbox"
              checked={autoScrollEnabled}
              onChange={(event) => onAutoScrollChange(event.target.checked)}
              disabled={chunkCount === 0}
            />
            <span>AutoScroll</span>
          </label>
        </div>
      </div>
    </section>
  );
}