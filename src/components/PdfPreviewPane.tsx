import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  ExternalLink,
  Loader2,
  AlertCircle,
  FileText,
  Layers,
  Crosshair,
} from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import type {
  ExtractionConfidenceLevel,
  ExtractionRegionTag,
  HeaderLayoutInfo,
  NormalizedBBox,
} from '../types';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface PdfHighlightTarget {
  page: number;
  bbox?: NormalizedBBox;
  label?: string;
  rawText?: string;
  normalizedValue?: string;
  region?: ExtractionRegionTag;
  confidence?: ExtractionConfidenceLevel;
  estimated?: boolean;
  nonce?: number;
}

interface PdfPreviewPaneProps {
  pdfUrl: string;
  fileName?: string;
  relevantPages?: number[];
  jumpToPage?: number | null;
  highlightBox?: PdfHighlightTarget | null;
  headerLayout?: HeaderLayoutInfo;
  showHeaderRegions?: boolean;
  onToggleHeaderRegions?: () => void;
}

const REGION_LABEL_MAP: Record<ExtractionRegionTag, { text: string; badgeClass: string }> = {
  region_a: {
    text: 'Vùng A – Trên trái',
    badgeClass: 'bg-sky-100 text-sky-900 border-sky-300',
  },
  region_b: {
    text: 'Vùng B – Trên phải',
    badgeClass: 'bg-emerald-100 text-emerald-900 border-emerald-300',
  },
  title_zone: {
    text: 'Vùng tiêu đề',
    badgeClass: 'bg-indigo-100 text-indigo-900 border-indigo-300',
  },
  signature_zone: {
    text: 'Vùng chữ ký',
    badgeClass: 'bg-purple-100 text-purple-900 border-purple-300',
  },
  other: {
    text: 'Trang văn bản',
    badgeClass: 'bg-slate-100 text-slate-800 border-slate-300',
  },
};

export const PdfPreviewPane: React.FC<PdfPreviewPaneProps> = ({
  pdfUrl,
  fileName,
  relevantPages = [],
  jumpToPage,
  highlightBox,
  headerLayout,
  showHeaderRegions = false,
  onToggleHeaderRegions,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.1);
  const [loading, setLoading] = useState<boolean>(true);
  const [rendering, setRendering] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [renderGeneration, setRenderGeneration] = useState<number>(0);
  const lastScrolledNonceRef = useRef<number | null>(null);

  // Load PDF document
  useEffect(() => {
    let cancelled = false;
    let loadedDoc: any = null;
    let loadedTask: any = null;
    const fetchAbort = new AbortController();

    const loadPdf = async () => {
      if (!pdfUrl) return;
      setLoading(true);
      setError(null);
      setPdfDoc(null);
      setCurrentPage(1);

      try {
        const isBlobOrData = pdfUrl.startsWith('blob:') || pdfUrl.startsWith('data:');
        const res = await fetch(pdfUrl, {
          signal: fetchAbort.signal,
          ...(isBlobOrData ? {} : { credentials: 'include' as RequestCredentials }),
        });
        if (!res.ok) {
          throw new Error(`Không thể tải bản xem trước PDF (HTTP ${res.status})`);
        }
        const arrayBuffer = await res.arrayBuffer();
        if (cancelled) return;
        const loadingTask = pdfjsLib.getDocument({
          data: new Uint8Array(arrayBuffer),
        });
        loadedTask = loadingTask;
        const doc: any = await loadingTask.promise;
        if (cancelled) {
          doc?.destroy?.().catch?.(() => {});
          loadingTask?.destroy?.().catch?.(() => {});
          return;
        }
        loadedDoc = doc;
        setPdfDoc(doc);
        setNumPages(doc.numPages || 1);
      } catch (err: any) {
        if (!cancelled && err?.name !== 'AbortError') {
          setError(err.message || 'Không thể hiển thị xem trước tệp PDF.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadPdf();

    return () => {
      cancelled = true;
      fetchAbort.abort();
      if (loadedDoc?.destroy) {
        loadedDoc.destroy().catch(() => {});
      } else if (loadedTask?.destroy) {
        loadedTask.destroy().catch(() => {});
      }
    };
  }, [pdfUrl]);

  // Observe preview container width (re-measures on mobile pane toggle & screen rotation)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateWidth = () => {
      const w = el.clientWidth || 0;
      setContainerWidth((prev) => (Math.abs(prev - w) >= 4 || (prev === 0 && w > 0) ? w : prev));
    };

    updateWidth();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => updateWidth());
      observer.observe(el);
    }
    window.addEventListener('resize', updateWidth);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateWidth);
    };
  }, [loading, error]);

  // Sync external page jump requests
  useEffect(() => {
    if (jumpToPage && numPages > 0 && jumpToPage >= 1 && jumpToPage <= numPages) {
      setCurrentPage(jumpToPage);
    }
  }, [jumpToPage, numPages]);

  // Sync highlightBox page request immediately
  useEffect(() => {
    if (!highlightBox || numPages <= 0) return;
    const targetPage = Math.max(1, Math.min(numPages, highlightBox.page || 1));
    setCurrentPage(targetPage);
  }, [highlightBox, numPages]);

  // Render active page to canvas whenever pdfDoc, currentPage, scale, or visible containerWidth changes
  useEffect(() => {
    let renderTask: any = null;
    let cancelled = false;

    const renderPage = async () => {
      if (!pdfDoc || !canvasRef.current || containerWidth <= 0) return;
      setRendering(true);

      try {
        const page = await pdfDoc.getPage(currentPage);
        if (cancelled) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const targetWidth = Math.max(containerWidth - 20, 260);
        const fitScale = targetWidth / baseViewport.width;
        const effectiveScale = Math.max(0.35, Math.min(2.6, fitScale * scale));
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        const viewport = page.getViewport({ scale: effectiveScale });
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');
        if (!context) return;

        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        context.setTransform(dpr, 0, 0, dpr, 0, 0);

        renderTask = page.render({
          canvasContext: context,
          viewport,
        });
        await renderTask.promise;
        if (!cancelled) {
          setRenderGeneration((g) => g + 1);
        }
      } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException' && !cancelled) {
          console.error('Lỗi vẽ trang PDF:', err);
        }
      } finally {
        if (!cancelled) setRendering(false);
      }
    };

    renderPage();

    return () => {
      cancelled = true;
      if (renderTask) {
        try {
          renderTask.cancel();
        } catch {
          // ignore
        }
      }
    };
  }, [pdfDoc, currentPage, scale, containerWidth]);

  // Smooth scroll to highlightBox after canvas has rendered cleanly in a visible pane
  useEffect(() => {
    if (!highlightBox || numPages <= 0 || containerWidth <= 0 || rendering || renderGeneration <= 0) {
      return;
    }
    const targetPage = Math.max(1, Math.min(numPages, highlightBox.page || 1));
    if (currentPage !== targetPage) return;

    const nonceKey = highlightBox.nonce ?? targetPage;
    if (lastScrolledNonceRef.current === nonceKey) return;
    lastScrolledNonceRef.current = nonceKey;

    const raf = requestAnimationFrame(() => {
      if (!containerRef.current || !canvasRef.current) return;
      if (highlightBox.bbox) {
        const canvasHeight = canvasRef.current.clientHeight || 0;
        const containerHeight = containerRef.current.clientHeight || 0;
        if (canvasHeight > 0) {
          const targetTop = Math.max(0, highlightBox.bbox.y0 * canvasHeight - containerHeight * 0.25);
          containerRef.current.scrollTo({ top: targetTop, behavior: 'smooth' });
        }
      } else {
        containerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });

    return () => cancelAnimationFrame(raf);
  }, [highlightBox, numPages, currentPage, containerWidth, rendering, renderGeneration]);

  const uniqueRelevantPages = Array.from(
    new Set(relevantPages.filter((p) => p >= 1 && p <= (numPages || 999)))
  ).sort((a, b) => a - b);

  const highlightTheme = (() => {
    if (!highlightBox) {
      return {
        box: 'border-amber-500 bg-amber-300/25 shadow-[0_0_0_2px_rgba(245,158,11,0.35)]',
        tag: 'bg-amber-600 text-white',
      };
    }
    if (highlightBox.confidence === 'low' || highlightBox.estimated) {
      return {
        box: 'border-amber-500 bg-amber-300/25 shadow-[0_0_0_2px_rgba(245,158,11,0.4)]',
        tag: 'bg-amber-600 text-white',
      };
    }
    if (highlightBox.region === 'region_a') {
      return {
        box: 'border-sky-600 bg-sky-300/25 shadow-[0_0_0_2px_rgba(2,132,199,0.35)]',
        tag: 'bg-sky-700 text-white',
      };
    }
    if (highlightBox.region === 'region_b') {
      return {
        box: 'border-emerald-600 bg-emerald-300/25 shadow-[0_0_0_2px_rgba(5,150,105,0.35)]',
        tag: 'bg-emerald-700 text-white',
      };
    }
    return {
      box: 'border-amber-500 bg-amber-300/25 shadow-[0_0_0_2px_rgba(245,158,11,0.35)]',
      tag: 'bg-amber-600 text-white',
    };
  })();

  const regionMeta = highlightBox?.region ? REGION_LABEL_MAP[highlightBox.region] : null;
  const hasHeaderZones = Boolean(headerLayout?.regionABBox || headerLayout?.regionBBBox);

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs flex flex-col">
      {/* Toolbar */}
      <div className="px-2.5 sm:px-3.5 py-2 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <FileText className="w-4 h-4 text-sky-700 shrink-0" />
          <span className="text-xs font-bold text-slate-800 truncate" title={fileName}>
            {fileName || 'Bản PDF gốc'}
          </span>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {hasHeaderZones && onToggleHeaderRegions && (
            <button
              type="button"
              onClick={() => {
                if (!showHeaderRegions && currentPage !== 1) {
                  setCurrentPage(1);
                }
                onToggleHeaderRegions();
              }}
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 min-h-[36px] text-[11px] font-semibold border rounded-lg transition-colors ${
                showHeaderRegions
                  ? 'bg-sky-700 text-white border-sky-700'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
              }`}
              title="Hiện khung phân tách Vùng A (trên trái) và Vùng B (trên phải) trên Trang 1"
            >
              <Layers className="w-3.5 h-3.5 shrink-0" />
              <span>Vùng A/B</span>
            </button>
          )}

          {/* Page navigation */}
          <div className="flex items-center bg-white border border-slate-200 rounded-lg overflow-hidden">
            <button
              type="button"
              disabled={currentPage <= 1}
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              className="p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-40 min-h-[36px] min-w-[34px] inline-flex items-center justify-center"
              title="Trang trước"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="px-2 text-[11px] font-mono font-semibold text-slate-700">
              {numPages > 0 ? `${currentPage}/${numPages}` : '...'}
            </span>
            <button
              type="button"
              disabled={currentPage >= numPages}
              onClick={() => setCurrentPage((p) => Math.min(numPages, p + 1))}
              className="p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-40 min-h-[36px] min-w-[34px] inline-flex items-center justify-center"
              title="Trang sau"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Zoom */}
          <div className="flex items-center bg-white border border-slate-200 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setScale((s) => Math.max(0.6, +(s - 0.15).toFixed(2)))}
              className="p-2 text-slate-600 hover:bg-slate-100 min-h-[36px] min-w-[34px] inline-flex items-center justify-center"
              title="Thu nhỏ"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="px-1.5 text-[11px] font-mono text-slate-600">
              {Math.round(scale * 100)}%
            </span>
            <button
              type="button"
              onClick={() => setScale((s) => Math.min(2.0, +(s + 0.15).toFixed(2)))}
              className="p-2 text-slate-600 hover:bg-slate-100 min-h-[36px] min-w-[34px] inline-flex items-center justify-center"
              title="Phóng to"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>

          <a
            href={pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 min-h-[36px] text-[11px] font-semibold text-sky-700 bg-white hover:bg-sky-50 border border-slate-200 rounded-lg"
            title="Mở bản PDF ở tab mới"
          >
            <ExternalLink className="w-3 h-3" />
            <span>Tab mới</span>
          </a>
        </div>
      </div>

      {/* Quick jump to relevant pages */}
      {uniqueRelevantPages.length > 0 && (
        <div className="px-3.5 py-2 bg-amber-50/70 border-b border-amber-100 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="font-semibold text-amber-900 mr-1">Chuyển nhanh:</span>
          {uniqueRelevantPages.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setCurrentPage(p)}
              className={`px-2 py-0.5 rounded font-semibold border transition-colors ${
                currentPage === p
                  ? 'bg-amber-600 text-white border-amber-700'
                  : 'bg-white text-amber-900 border-amber-200 hover:bg-amber-100'
              }`}
            >
              {p === 1
                ? 'Trang 1 (Đầu VB)'
                : p === numPages
                ? `Trang ${p} (Chữ ký)`
                : `Trang ${p}`}
            </button>
          ))}
        </div>
      )}

      {/* Active extraction inspection banner */}
      {highlightBox && (
        <div
          data-testid="pdf-extraction-inspection-banner"
          className={`px-3.5 py-2 border-b text-[11px] space-y-1 ${
            highlightBox.estimated || !highlightBox.bbox
              ? 'bg-amber-50 border-amber-200 text-amber-950'
              : 'bg-sky-50/80 border-sky-200 text-slate-800'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <div className="flex items-center gap-1.5 flex-wrap">
              <Crosshair className="w-3.5 h-3.5 text-sky-700 shrink-0" />
              <strong className="font-bold text-slate-900">
                {highlightBox.label || 'Vị trí trích xuất'}
              </strong>
              <span className="text-slate-500 font-mono">(Trang {highlightBox.page})</span>
              {regionMeta && (
                <span
                  className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${regionMeta.badgeClass}`}
                >
                  {regionMeta.text}
                </span>
              )}
              {(highlightBox.estimated || !highlightBox.bbox) && (
                <span className="px-1.5 py-0.5 rounded bg-amber-600 text-white font-bold uppercase text-[10px]">
                  Chưa khoanh chính xác vùng chữ
                </span>
              )}
            </div>
            {highlightBox.normalizedValue && (
              <span className="px-2 py-0.5 rounded bg-white border border-slate-300 font-mono font-bold text-slate-900">
                {highlightBox.normalizedValue}
              </span>
            )}
          </div>
          {highlightBox.rawText && (
            <p className="text-[11px] text-slate-600 truncate" title={highlightBox.rawText}>
              Văn bản đọc được tại vùng này:{' '}
              <span className="font-mono text-slate-900">"{highlightBox.rawText}"</span>
            </p>
          )}
        </div>
      )}

      {/* Canvas area */}
      <div
        ref={containerRef}
        className="bg-slate-100 p-2 sm:p-3 overflow-auto max-h-[68dvh] sm:max-h-[680px] min-h-[280px] sm:min-h-[380px] flex flex-col items-center justify-start relative"
      >
        {loading ? (
          <div className="my-auto flex flex-col items-center gap-2 text-slate-500 py-16">
            <Loader2 className="w-6 h-6 animate-spin text-sky-700" />
            <span className="text-xs font-medium">Đang tải xem trước bản PDF gốc...</span>
          </div>
        ) : error ? (
          <div className="my-auto p-4 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800 flex items-start gap-2 max-w-md">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        ) : (
          <div className="relative shadow-md bg-white border border-slate-200 inline-block">
            {rendering && (
              <div className="absolute top-2 right-2 z-20 bg-slate-900/75 text-white text-[10px] px-2 py-0.5 rounded flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Đang hiển thị...</span>
              </div>
            )}
            <canvas ref={canvasRef} className="block max-w-full" />

            {/* Optional Page 1 Region A / Region B layout overlays */}
            {showHeaderRegions && currentPage === 1 && headerLayout?.regionABBox && (
              <div
                aria-label="Vùng A – Trên trái"
                className="pointer-events-none absolute z-[8] border-2 border-dashed border-sky-500/80 bg-sky-200/10 rounded-sm"
                style={{
                  left: `${Math.max(0, headerLayout.regionABBox.x0 * 100)}%`,
                  top: `${Math.max(0, headerLayout.regionABBox.y0 * 100)}%`,
                  width: `${Math.max((headerLayout.regionABBox.x1 - headerLayout.regionABBox.x0) * 100, 6)}%`,
                  height: `${Math.max((headerLayout.regionABBox.y1 - headerLayout.regionABBox.y0) * 100, 4)}%`,
                }}
              >
                <span className="absolute -top-4 left-0 px-1.5 py-0.5 bg-sky-700/90 text-white text-[9px] font-bold rounded whitespace-nowrap">
                  Vùng A (Cơ quan · Số)
                </span>
              </div>
            )}

            {showHeaderRegions && currentPage === 1 && headerLayout?.regionBBBox && (
              <div
                aria-label="Vùng B – Trên phải"
                className="pointer-events-none absolute z-[8] border-2 border-dashed border-emerald-500/80 bg-emerald-200/10 rounded-sm"
                style={{
                  left: `${Math.max(0, headerLayout.regionBBBox.x0 * 100)}%`,
                  top: `${Math.max(0, headerLayout.regionBBBox.y0 * 100)}%`,
                  width: `${Math.max((headerLayout.regionBBBox.x1 - headerLayout.regionBBBox.x0) * 100, 6)}%`,
                  height: `${Math.max((headerLayout.regionBBBox.y1 - headerLayout.regionBBBox.y0) * 100, 4)}%`,
                }}
              >
                <span className="absolute -top-4 right-0 px-1.5 py-0.5 bg-emerald-700/90 text-white text-[9px] font-bold rounded whitespace-nowrap">
                  Vùng B (Quốc hiệu · Ngày)
                </span>
              </div>
            )}

            {/* Active Field Highlight Box */}
            {highlightBox &&
              highlightBox.page === currentPage &&
              highlightBox.bbox && (
                <div
                  aria-label={`Vùng nguồn: ${highlightBox.label || ''}`}
                  className={`pointer-events-none absolute z-10 border-2 rounded-sm transition-all duration-200 ${highlightTheme.box}`}
                  style={{
                    left: `${Math.max(0, highlightBox.bbox.x0 * 100)}%`,
                    top: `${Math.max(0, highlightBox.bbox.y0 * 100)}%`,
                    width: `${Math.max((highlightBox.bbox.x1 - highlightBox.bbox.x0) * 100, 3)}%`,
                    height: `${Math.max((highlightBox.bbox.y1 - highlightBox.bbox.y0) * 100, 1.8)}%`,
                  }}
                >
                  {highlightBox.label && (
                    <span
                      className={`absolute -top-5 left-0 px-1.5 py-0.5 text-[10px] font-bold rounded shadow-xs whitespace-nowrap ${highlightTheme.tag}`}
                    >
                      {highlightBox.label}
                      {highlightBox.normalizedValue ? `: ${highlightBox.normalizedValue}` : ''}
                    </span>
                  )}
                </div>
              )}
          </div>
        )}
      </div>
    </div>
  );
};
