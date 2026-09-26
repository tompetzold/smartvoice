import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";

type PdfPageCanvasProps = {
  pdfDocument: PDFDocumentProxy | null;
  pageNumber: number;
  displayScale: number;
  cssWidth: number;
  cssHeight: number;
  viewerRef: RefObject<HTMLElement | null>;
  renderPriority: 0 | 1;
};

const ZOOM_RENDER_DEBOUNCE_MS = 90;
const PRIMARY_RENDER_TIMEOUT_MS = 12_000;
const FALLBACK_RENDER_TIMEOUT_MS = 15_000;
const MAX_CANVAS_PIXELS = 10_000_000;
const MAX_CONCURRENT_PDF_RENDERS = 2;

type QueuedPdfRender = {
  id: number;
  priority: number;
  sequence: number;
  started: boolean;
  cancelled: boolean;
  settled: boolean;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type ScheduledPdfRender = {
  promise: Promise<void>;
  cancel: () => void;
  updatePriority: (priority: number) => void;
};

let activePdfRenderCount = 0;
let nextPdfRenderId = 1;
let nextPdfRenderSequence = 1;
const queuedPdfRenders: QueuedPdfRender[] = [];

function removeQueuedPdfRender(entry: QueuedPdfRender) {
  const index = queuedPdfRenders.indexOf(entry);

  if (index >= 0) {
    queuedPdfRenders.splice(index, 1);
  }
}

function settleCancelledPdfRender(entry: QueuedPdfRender) {
  if (entry.settled) {
    return;
  }

  entry.settled = true;
  entry.resolve();
}

function pumpPdfRenderQueue() {
  queuedPdfRenders.sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }

    return left.sequence - right.sequence;
  });

  while (
    activePdfRenderCount < MAX_CONCURRENT_PDF_RENDERS &&
    queuedPdfRenders.length > 0
  ) {
    const entry = queuedPdfRenders.shift();

    if (!entry) {
      return;
    }

    if (entry.cancelled) {
      settleCancelledPdfRender(entry);
      continue;
    }

    entry.started = true;
    activePdfRenderCount += 1;

    void entry
      .run()
      .then(() => {
        if (!entry.settled) {
          entry.settled = true;
          entry.resolve();
        }
      })
      .catch((error: unknown) => {
        if (!entry.settled) {
          entry.settled = true;
          entry.reject(error);
        }
      })
      .finally(() => {
        activePdfRenderCount = Math.max(
          0,
          activePdfRenderCount - 1,
        );
        pumpPdfRenderQueue();
      });
  }
}

function schedulePdfRender(
  priority: number,
  run: () => Promise<void>,
): ScheduledPdfRender {
  let entry!: QueuedPdfRender;

  const promise = new Promise<void>((resolve, reject) => {
    entry = {
      id: nextPdfRenderId,
      priority,
      sequence: nextPdfRenderSequence,
      started: false,
      cancelled: false,
      settled: false,
      run,
      resolve,
      reject,
    };

    nextPdfRenderId += 1;
    nextPdfRenderSequence += 1;

    queuedPdfRenders.push(entry);
    pumpPdfRenderQueue();
  });

  return {
    promise,
    cancel: () => {
      if (entry.cancelled || entry.settled) {
        return;
      }

      entry.cancelled = true;

      if (!entry.started) {
        removeQueuedPdfRender(entry);
        settleCancelledPdfRender(entry);
      }
    },
    updatePriority: (nextPriority: number) => {
      if (
        entry.started ||
        entry.cancelled ||
        entry.settled ||
        entry.priority === nextPriority
      ) {
        return;
      }

      entry.priority = nextPriority;
      pumpPdfRenderQueue();
    },
  };
}

function getRenderPixelRatio(
  cssWidth: number,
  cssHeight: number,
  preferredRatio: number,
): number {
  const safeWidth = Math.max(1, cssWidth);
  const safeHeight = Math.max(1, cssHeight);
  const safeRatio = Math.max(1, preferredRatio);
  const requestedPixels =
    safeWidth *
    safeHeight *
    safeRatio *
    safeRatio;

  if (requestedPixels <= MAX_CANVAS_PIXELS) {
    return safeRatio;
  }

  return Math.max(
    1,
    Math.sqrt(MAX_CANVAS_PIXELS / (safeWidth * safeHeight)),
  );
}

function isRenderCancellation(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  return (
    message.includes("Rendering cancelled") ||
    message.includes("RenderingCancelledException")
  );
}

function PdfPageCanvas({
  pdfDocument,
  pageNumber,
  displayScale,
  cssWidth,
  cssHeight,
  viewerRef: _viewerRef,
  renderPriority,
}: PdfPageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderGenerationRef = useRef(0);
  const scheduledRenderRef = useRef<ScheduledPdfRender | null>(null);

  const [isReady, setIsReady] = useState(false);
  const [renderError, setRenderError] = useState("");

  useEffect(() => {
    scheduledRenderRef.current?.updatePriority(renderPriority);
  }, [renderPriority]);

  useEffect(() => {
    const visibleCanvas = canvasRef.current;
    const loadedPdfDocument = pdfDocument;

    if (!visibleCanvas) {
      return;
    }

    const generation = renderGenerationRef.current + 1;
    renderGenerationRef.current = generation;

    let disposed = false;
    let debounceTimer: number | null = null;
    let activeRenderTask: RenderTask | null = null;
    let activeTimeout: number | null = null;

    function clearActiveTimeout() {
      if (activeTimeout !== null) {
        window.clearTimeout(activeTimeout);
        activeTimeout = null;
      }
    }

    function cancelActiveRender() {
      clearActiveTimeout();

      if (activeRenderTask) {
        try {
          activeRenderTask.cancel();
        } catch {
          // The render task may already be complete.
        }

        activeRenderTask = null;
      }
    }

    if (!loadedPdfDocument) {
      setIsReady(false);
      setRenderError("");
      visibleCanvas.width = 1;
      visibleCanvas.height = 1;

      return () => {
        disposed = true;
        renderGenerationRef.current += 1;
      };
    }

    const activePdfDocument = loadedPdfDocument;

    setRenderError("");

    async function renderAttempt(
      page: PDFPageProxy,
      pixelRatio: number,
      timeoutMs: number,
    ): Promise<HTMLCanvasElement> {
      const viewport = page.getViewport({
        scale: displayScale,
      });

      const targetCssWidth = Math.max(1, cssWidth);
      const targetCssHeight = Math.max(1, cssHeight);

      const pixelWidth = Math.max(
        1,
        Math.round(targetCssWidth * pixelRatio),
      );
      const pixelHeight = Math.max(
        1,
        Math.round(targetCssHeight * pixelRatio),
      );

      const renderCanvas = window.document.createElement("canvas");
      renderCanvas.width = pixelWidth;
      renderCanvas.height = pixelHeight;

      const context = renderCanvas.getContext("2d", {
        alpha: false,
        willReadFrequently: false,
      });

      if (!context) {
        throw new Error(
          `Canvas-Kontext für PDF-Seite ${pageNumber} konnte nicht erstellt werden.`,
        );
      }

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, pixelWidth, pixelHeight);

      const outputScaleX = pixelWidth / viewport.width;
      const outputScaleY = pixelHeight / viewport.height;

      let timedOut = false;

      activeRenderTask = page.render({
        canvas: renderCanvas,
        canvasContext: context,
        viewport,
        transform: [
          outputScaleX,
          0,
          0,
          outputScaleY,
          0,
          0,
        ],
        background: "rgb(255,255,255)",
      });

      activeTimeout = window.setTimeout(() => {
        timedOut = true;

        try {
          activeRenderTask?.cancel();
        } catch {
          // Ignore an already completed task.
        }
      }, timeoutMs);

      try {
        await activeRenderTask.promise;
      } catch (error) {
        if (timedOut) {
          throw new Error("PDF_RENDER_TIMEOUT");
        }

        throw error;
      } finally {
        clearActiveTimeout();
        activeRenderTask = null;
      }

      return renderCanvas;
    }

    async function renderPage() {
      const page = await activePdfDocument.getPage(pageNumber);

      if (
        disposed ||
        generation !== renderGenerationRef.current
      ) {
        return;
      }

      const preferredRatio = Math.max(
        1,
        window.devicePixelRatio || 1,
      );

      const primaryRatio = getRenderPixelRatio(
        cssWidth,
        cssHeight,
        preferredRatio,
      );

      let renderedCanvas: HTMLCanvasElement;

      try {
        renderedCanvas = await renderAttempt(
          page,
          primaryRatio,
          PRIMARY_RENDER_TIMEOUT_MS,
        );
      } catch (error) {
        if (
          disposed ||
          generation !== renderGenerationRef.current
        ) {
          return;
        }

        if (isRenderCancellation(error)) {
          return;
        }

        const message =
          error instanceof Error
            ? error.message
            : String(error);

        if (message !== "PDF_RENDER_TIMEOUT") {
          throw error;
        }

        cancelActiveRender();

        renderedCanvas = await renderAttempt(
          page,
          1,
          FALLBACK_RENDER_TIMEOUT_MS,
        );
      }

      if (
        disposed ||
        generation !== renderGenerationRef.current
      ) {
        return;
      }

      const currentCanvas = canvasRef.current;

      if (!currentCanvas) {
        return;
      }

      currentCanvas.width = renderedCanvas.width;
      currentCanvas.height = renderedCanvas.height;
      currentCanvas.style.width = `${Math.max(1, cssWidth)}px`;
      currentCanvas.style.height = `${Math.max(1, cssHeight)}px`;

      const visibleContext = currentCanvas.getContext("2d", {
        alpha: false,
        willReadFrequently: false,
      });

      if (!visibleContext) {
        throw new Error(
          `Canvas-Kontext für PDF-Seite ${pageNumber} konnte nicht erstellt werden.`,
        );
      }

      visibleContext.setTransform(1, 0, 0, 1, 0, 0);
      visibleContext.fillStyle = "#ffffff";
      visibleContext.fillRect(
        0,
        0,
        currentCanvas.width,
        currentCanvas.height,
      );
      visibleContext.drawImage(renderedCanvas, 0, 0);

      setRenderError("");
      setIsReady(true);
    }

    debounceTimer = window.setTimeout(() => {
      const scheduledRender = schedulePdfRender(
        renderPriority,
        async () => {
          if (
            disposed ||
            generation !== renderGenerationRef.current
          ) {
            return;
          }

          await renderPage();
        },
      );

      scheduledRenderRef.current = scheduledRender;

      void scheduledRender.promise
        .catch((error: unknown) => {
          if (
            disposed ||
            generation !== renderGenerationRef.current
          ) {
            return;
          }

          if (isRenderCancellation(error)) {
            return;
          }

          const message =
            error instanceof Error
              ? error.message
              : String(error);

          setRenderError(
            message === "PDF_RENDER_TIMEOUT"
              ? "Seite konnte nicht rechtzeitig gerendert werden."
              : "Seite konnte nicht gerendert werden.",
          );

          console.error(
            `PDF-Seite ${pageNumber} konnte nicht gerendert werden:`,
            error,
          );
        })
        .finally(() => {
          if (scheduledRenderRef.current === scheduledRender) {
            scheduledRenderRef.current = null;
          }
        });
    }, ZOOM_RENDER_DEBOUNCE_MS);

    return () => {
      disposed = true;
      renderGenerationRef.current += 1;

      if (debounceTimer !== null) {
        window.clearTimeout(debounceTimer);
      }

      scheduledRenderRef.current?.cancel();
      scheduledRenderRef.current = null;
      cancelActiveRender();
    };
  }, [
    pdfDocument,
    pageNumber,
    displayScale,
    cssWidth,
    cssHeight,
  ]);

  const showSkeleton = !isReady && !renderError;

  return (
    <div
      className={`pdf-canvas-wrapper ${showSkeleton ? "loading" : "ready"}`}
      style={{
        width: `${cssWidth}px`,
        height: `${cssHeight}px`,
      }}
    >
      {showSkeleton && (
        <div
          className="page-skeleton"
          aria-hidden="true"
        >
          <div className="page-skeleton-group page-skeleton-group-heading">
            <div className="page-skeleton-row hero-short" />
            <div className="page-skeleton-row hero-wide" />
            <div className="page-skeleton-row hero-medium" />
          </div>

          <div className="page-skeleton-group">
            <div className="page-skeleton-row medium" />
            <div className="page-skeleton-row wide" />
            <div className="page-skeleton-row wide" />
            <div className="page-skeleton-row narrow" />
          </div>

          <div className="page-skeleton-group">
            <div className="page-skeleton-row short" />
            <div className="page-skeleton-row medium" />
            <div className="page-skeleton-row wide" />
            <div className="page-skeleton-row medium" />
            <div className="page-skeleton-row narrow" />
            <div className="page-skeleton-row wide" />
          </div>

          <div className="page-skeleton-group">
            <div className="page-skeleton-row medium" />
            <div className="page-skeleton-row wide" />
            <div className="page-skeleton-row narrow" />
            <div className="page-skeleton-row medium" />
          </div>
        </div>
      )}

      {renderError && !isReady && (
        <div className="page-skeleton" role="status">
          <div className="page-skeleton-group">
            <div className="page-skeleton-row medium" />
            <div className="page-skeleton-row wide" />
            <div className="page-skeleton-row short" />
          </div>
        </div>
      )}

      <canvas
        className={`pdf-page-canvas ${isReady ? "ready" : "hidden"}`}
        ref={canvasRef}
        aria-label={`PDF-Seite ${pageNumber}`}
        style={{
          width: `${cssWidth}px`,
          height: `${cssHeight}px`,
        }}
      />
    </div>
  );
}

export default PdfPageCanvas;
