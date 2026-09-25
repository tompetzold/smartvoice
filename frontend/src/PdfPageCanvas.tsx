import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

type PdfPageCanvasProps = {
  pdfDocument: PDFDocumentProxy | null;
  pageNumber: number;
  displayScale: number;
  cssWidth: number;
  cssHeight: number;
  viewerRef: RefObject<HTMLElement | null>;
};

const INTERSECTION_ROOT_MARGIN = "1400px 0px";

function PdfPageCanvas({
  pdfDocument,
  pageNumber,
  displayScale,
  cssWidth,
  cssHeight,
  viewerRef,
}: PdfPageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const renderGenerationRef = useRef(0);

  const [shouldRender, setShouldRender] = useState(false);
  const [isRendering, setIsRendering] = useState(true);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const wrapper = wrapperRef.current;

    if (!wrapper) {
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      setShouldRender(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];

        if (!entry) {
          return;
        }

        setShouldRender(entry.isIntersecting);
      },
      {
        root: viewerRef.current,
        rootMargin: INTERSECTION_ROOT_MARGIN,
        threshold: 0,
      },
    );

    observer.observe(wrapper);

    return () => {
      observer.disconnect();
    };
  }, [viewerRef]);

  useEffect(() => {
    const canvasElement = canvasRef.current;
    const loadedPdfDocument = pdfDocument;

    if (!canvasElement) {
      return;
    }

    if (!loadedPdfDocument) {
      canvasElement.width = 1;
      canvasElement.height = 1;
      setIsReady(false);
      setIsRendering(true);
      return;
    }

    if (!shouldRender) {
      canvasElement.width = 1;
      canvasElement.height = 1;
      setIsReady(false);
      setIsRendering(true);
      return;
    }

    const canvas: HTMLCanvasElement = canvasElement;
    const pdf: PDFDocumentProxy = loadedPdfDocument;

    const generation = renderGenerationRef.current + 1;
    renderGenerationRef.current = generation;

    let disposed = false;
    let renderTask: {
      cancel: () => void;
      promise: Promise<unknown>;
    } | null = null;

    setIsReady(false);
    setIsRendering(true);

    async function renderPage() {
      const page = await pdf.getPage(pageNumber);

      if (disposed || generation !== renderGenerationRef.current) {
        return;
      }

      const viewport = page.getViewport({
        scale: displayScale,
      });

      const devicePixelRatio = Math.max(
        1,
        window.devicePixelRatio || 1,
      );

      const targetCssWidth = Math.max(
        1,
        cssWidth,
      );

      const targetCssHeight = Math.max(
        1,
        cssHeight,
      );

      const pixelWidth = Math.max(
        1,
        Math.round(targetCssWidth * devicePixelRatio),
      );

      const pixelHeight = Math.max(
        1,
        Math.round(targetCssHeight * devicePixelRatio),
      );

      canvas.width = pixelWidth;
      canvas.height = pixelHeight;

      canvas.style.width = `${targetCssWidth}px`;
      canvas.style.height = `${targetCssHeight}px`;

      const context = canvas.getContext("2d", {
        alpha: false,
        willReadFrequently: false,
      });

      if (!context) {
        throw new Error(
          `Canvas-Kontext für PDF-Seite ${pageNumber} konnte nicht erstellt werden.`,
        );
      }

      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.fillStyle = "#ffffff";
      context.fillRect(
        0,
        0,
        pixelWidth,
        pixelHeight,
      );
      context.restore();

      const outputScaleX =
        pixelWidth / viewport.width;

      const outputScaleY =
        pixelHeight / viewport.height;

      const transform: [
        number,
        number,
        number,
        number,
        number,
        number,
      ] = [
        outputScaleX,
        0,
        0,
        outputScaleY,
        0,
        0,
      ];

      renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform,
        background: "rgb(255,255,255)",
      });

      await renderTask.promise;

      if (
        disposed ||
        generation !== renderGenerationRef.current
      ) {
        return;
      }

      setIsReady(true);
      setIsRendering(false);
    }

    void renderPage().catch((error: unknown) => {
      if (disposed) {
        return;
      }

      const message =
        error instanceof Error
          ? error.message
          : String(error);

      if (
        message.includes("Rendering cancelled") ||
        message.includes("RenderingCancelledException")
      ) {
        return;
      }

      setIsReady(false);
      setIsRendering(false);

      console.error(
        `PDF-Seite ${pageNumber} konnte nicht gerendert werden:`,
        error,
      );
    });

    return () => {
      disposed = true;
      renderGenerationRef.current += 1;

      if (renderTask) {
        renderTask.cancel();
      }
    };
  }, [
    pdfDocument,
    pageNumber,
    displayScale,
    cssWidth,
    cssHeight,
    shouldRender,
  ]);

  const showSkeleton = !isReady || isRendering;

  return (
    <div
      className={`pdf-canvas-wrapper ${showSkeleton ? "loading" : "ready"}`}
      ref={wrapperRef}
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

      <canvas
        className={`pdf-page-canvas ${showSkeleton ? "hidden" : "ready"}`}
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
