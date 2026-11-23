import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { createRequire } from 'module';
import { execFile } from 'child_process';
import { pathToFileURL } from 'url';
import { promisify } from 'util';
import type {
  DateComparisonStatus,
  DocNumberResolutionInfo,
  ExtractableFieldKey,
  ExtractedDateSource,
  ExtractionConfidenceLevel,
  FieldExtractionMeta,
  FieldLocation,
  HeaderLayoutInfo,
  NormalizedBBox,
  PdfExtractionResult,
  PdfPageContent,
} from '../src/types.js';
import {
  getMaxWordFileSizeBytes,
  getMaxWordFileSizeMB,
  validatePdfFileBuffer,
} from './googleDrive.js';
import {
  normalizeDateOnlyDdMmYyyy,
  normalizeDocNumber,
  parseDocNumberComponents,
  reconcileDocNumberWithFilename,
  removeVietnameseDiacritics,
} from '../src/utils/fileNaming.js';

export { normalizeDocNumber, reconcileDocNumberWithFilename };

const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);

export class PdfUrlFetchError extends Error {
  public readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'PdfUrlFetchError';
    this.statusCode = statusCode;
  }
}

interface NormalizedBox {
  text: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  height: number;
  fontName?: string;
}

interface NormalizedLine {
  text: string;
  x0: number;
  x1: number;
  xCenter: number;
  y0: number;
  y1: number;
  yCenter: number;
  avgHeight: number;
  fontNames: string[];
  words: NormalizedBox[];
  isDivider: boolean;
}

interface PdfPageTextInfo {
  pageNumber: number;
  fullText: string;
  leftTopText: string;
  rightTopText: string;
  rightBottomText: string;
  rightHalfText: string;
  bottomText: string;
  annotationText: string;
  alphaNumCount: number;
  boxes: NormalizedBox[];
  dividerYs: number[];
}

function countMeaningfulChars(str: string): number {
  const matches = str.match(/[\p{L}\p{N}]/gu);
  return matches ? matches.length : 0;
}

function isGarbledText(str: string): boolean {
  if (!str) return true;
  const meaningful = countMeaningfulChars(str);
  if (meaningful < 35) return true;
  const replacementCount = (str.match(/\uFFFD/g) || []).length;
  return replacementCount > 5 || replacementCount / Math.max(str.length, 1) > 0.08;
}

function normalizeUrlForPdfFetch(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  // Chuyển liên kết xem Google Drive sang liên kết tải trực tiếp
  const driveFileMatch = trimmed.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (driveFileMatch) {
    return `https://drive.google.com/uc?export=download&id=${driveFileMatch[1]}`;
  }
  const driveOpenMatch = trimmed.match(/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/);
  if (driveOpenMatch) {
    return `https://drive.google.com/uc?export=download&id=${driveOpenMatch[1]}`;
  }
  return trimmed;
}

export async function fetchPdfFromUrl(rawUrl: string): Promise<{
  buffer: Buffer;
  fileName: string;
  finalUrl: string;
}> {
  let parsed: URL;
  try {
    parsed = new URL((rawUrl || '').trim());
  } catch {
    throw new PdfUrlFetchError(
      'Đường dẫn PDF không đúng định dạng URL (cần bắt đầu bằng http:// hoặc https://).'
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PdfUrlFetchError('Chỉ hỗ trợ đường dẫn giao thức http:// hoặc https://.');
  }

  // Chặn truy cập metadata nội bộ đám mây
  const blockedHosts = ['169.254.169.254', 'metadata.google.internal', 'metadata.goog'];
  if (blockedHosts.includes(parsed.hostname.toLowerCase())) {
    throw new PdfUrlFetchError('Đường dẫn không hợp lệ hoặc bị từ chối vì lý do bảo mật.');
  }

  const targetUrl = normalizeUrlForPdfFetch(parsed.toString());
  const maxBytes = getMaxWordFileSizeBytes();
  const maxMB = getMaxWordFileSizeMB();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch(targetUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'NCT-DocumentRegistry/1.0 (+PDF-Import)',
        Accept: 'application/pdf,application/octet-stream,*/*;q=0.8',
      },
    });

    if (res.status === 401 || res.status === 403) {
      throw new PdfUrlFetchError(
        `Đường dẫn yêu cầu đăng nhập hoặc không có quyền truy cập (HTTP ${res.status}). Vui lòng tải tệp PDF về máy và dùng cách "Tải PDF từ máy".`
      );
    }
    if (!res.ok) {
      throw new PdfUrlFetchError(
        `Không thể tải tệp từ đường dẫn (HTTP ${res.status}). Vui lòng kiểm tra lại liên kết hoặc tải PDF về máy để nhập thủ công.`
      );
    }

    const contentLengthHeader = res.headers.get('content-length');
    if (contentLengthHeader) {
      const expectedLen = parseInt(contentLengthHeader, 10);
      if (Number.isFinite(expectedLen) && expectedLen > maxBytes) {
        throw new PdfUrlFetchError(`Dung lượng tệp PDF từ đường dẫn vượt quá giới hạn tối đa ${maxMB} MB.`);
      }
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) {
      throw new PdfUrlFetchError(
        'Đường dẫn trả về trang web hoặc trang đăng nhập thay vì tệp PDF trực tiếp. Vui lòng tải tệp PDF về máy rồi dùng cách "Tải PDF từ máy".'
      );
    }

    if (!res.body) {
      throw new PdfUrlFetchError('Máy chủ nguồn không trả về dữ liệu tệp.');
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          controller.abort();
          throw new PdfUrlFetchError(`Dung lượng tệp PDF từ đường dẫn vượt quá giới hạn tối đa ${maxMB} MB.`);
        }
        chunks.push(value);
      }
    }

    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const cd = res.headers.get('content-disposition') || '';
    let fileName = '';
    const cdUtf8 = cd.match(/filename\*=UTF-8''([^;\n]+)/i);
    const cdPlain = cd.match(/filename="?([^";\n]+)"?/i);
    if (cdUtf8) {
      fileName = decodeURIComponent(cdUtf8[1].trim());
    } else if (cdPlain) {
      fileName = cdPlain[1].trim();
    } else {
      const pathPart = new URL(res.url || targetUrl).pathname.split('/').filter(Boolean).pop() || '';
      fileName = decodeURIComponent(pathPart);
    }
    if (!fileName || !fileName.toLowerCase().endsWith('.pdf')) {
      fileName = fileName ? `${fileName}.pdf` : 'van-ban-nhap.pdf';
    }

    const validation = validatePdfFileBuffer(fileName, contentType, buffer);
    if (!validation.valid) {
      throw new PdfUrlFetchError(
        validation.error + ' Vui lòng kiểm tra lại đường dẫn hoặc tải tệp PDF về máy để nhập thủ công.'
      );
    }

    return {
      buffer,
      fileName,
      finalUrl: res.url || targetUrl,
    };
  } catch (err: any) {
    if (err instanceof PdfUrlFetchError) throw err;
    if (err?.name === 'AbortError') {
      throw new PdfUrlFetchError(
        'Quá thời gian tải PDF từ đường dẫn (20 giây). Vui lòng tải tệp PDF về máy và dùng cách "Tải PDF từ máy".'
      );
    }
    throw new PdfUrlFetchError(
      err?.message || 'Không thể tải tệp PDF từ đường dẫn. Vui lòng kiểm tra lại liên kết hoặc tải PDF từ máy.'
    );
  } finally {
    clearTimeout(timeout);
  }
}

function clamp01(val: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.max(0, Math.min(1, val));
}

function isDividerLineText(str: string): boolean {
  const t = (str || '').trim();
  if (!t) return true;
  if (/^[\s_\-—–=~*•·.,|\\\/]{2,}$/.test(t) && countMeaningfulChars(t) === 0) {
    return true;
  }
  return countMeaningfulChars(t) < 2 && t.length <= 4;
}

/**
 * Ước lượng độ nghiêng ngang (slope = dy / dx) của trang quét từ các cặp hộp chữ gần nhau.
 * Trả về 0 nếu tài liệu thẳng (< ~0.25°), giới hạn trong ±7° (|slope| <= 0.125).
 */
function estimateHeaderSkewSlope(boxes: NormalizedBox[]): number {
  const candidates = boxes.filter((b) => {
    const yc = (b.y0 + b.y1) / 2;
    return yc >= 0.02 && yc <= 0.52 && b.height >= 0.005 && b.height <= 0.045 && b.text.trim().length > 0;
  });
  if (candidates.length < 4) return 0;

  const slopes: number[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const a = candidates[i];
    const ax = (a.x0 + a.x1) / 2;
    const ay = (a.y0 + a.y1) / 2;
    for (let j = i + 1; j < candidates.length; j++) {
      const b = candidates[j];
      const bx = (b.x0 + b.x1) / 2;
      const by = (b.y0 + b.y1) / 2;
      const dx = bx - ax;
      const absDx = Math.abs(dx);
      if (absDx < 0.015 || absDx > 0.22) continue;
      // Chỉ ghép các từ có cùng tầm chiều cao và lệch dọc nhỏ hơn giới hạn góc nghiêng ±7°
      const hRatio = Math.min(a.height, b.height) / Math.max(a.height, b.height, 0.001);
      if (hRatio < 0.65) continue;
      const dy = by - ay;
      const slope = dy / dx;
      if (Math.abs(slope) > 0.125) continue;
      if (Math.abs(dy) > Math.max(0.024, Math.max(a.height, b.height) * 1.8)) continue;
      slopes.push(slope);
    }
  }

  if (slopes.length < 4) return 0;
  slopes.sort((a, b) => a - b);
  const median = slopes[Math.floor(slopes.length / 2)];
  // Chỉ áp dụng nếu độ nghiêng có ý nghĩa và nhất quán (tránh nhiễu trên văn bản thẳng)
  if (Math.abs(median) < 0.004) return 0;
  const nearMedian = slopes.filter((s) => Math.abs(s - median) <= 0.018);
  if (nearMedian.length < Math.max(3, Math.floor(slopes.length * 0.45))) return 0;
  const avg = nearMedian.reduce((acc, v) => acc + v, 0) / nearMedian.length;
  return Math.max(-0.125, Math.min(0.125, avg));
}

function groupBoxesIntoLines(boxes: NormalizedBox[], skewSlope = 0): NormalizedLine[] {
  if (boxes.length === 0) return [];
  const getAdjYCenter = (b: NormalizedBox) => {
    const yc = (b.y0 + b.y1) / 2;
    if (!skewSlope) return yc;
    const xc = (b.x0 + b.x1) / 2;
    return yc - skewSlope * (xc - 0.5);
  };
  const getAdjY0 = (b: NormalizedBox) => {
    if (!skewSlope) return b.y0;
    const xc = (b.x0 + b.x1) / 2;
    return b.y0 - skewSlope * (xc - 0.5);
  };
  const getAdjY1 = (b: NormalizedBox) => {
    if (!skewSlope) return b.y1;
    const xc = (b.x0 + b.x1) / 2;
    return b.y1 - skewSlope * (xc - 0.5);
  };

  const sorted = [...boxes].sort((a, b) => {
    const ay = getAdjYCenter(a);
    const by = getAdjYCenter(b);
    if (Math.abs(ay - by) > 0.004) return ay - by;
    return a.x0 - b.x0;
  });

  const rows: NormalizedBox[][] = [];
  for (const box of sorted) {
    const boxYCenter = getAdjYCenter(box);
    const boxY0 = getAdjY0(box);
    const boxY1 = getAdjY1(box);
    let matchedRow: NormalizedBox[] | null = null;
    let bestScore = Infinity;

    for (let i = Math.max(0, rows.length - 5); i < rows.length; i++) {
      const row = rows[i];
      const rowYCenter =
        row.reduce((acc, w) => acc + getAdjYCenter(w), 0) / row.length;
      const rowY0 = Math.min(...row.map((w) => getAdjY0(w)));
      const rowY1 = Math.max(...row.map((w) => getAdjY1(w)));
      const rowAvgH = row.reduce((acc, w) => acc + w.height, 0) / row.length;
      const minH = Math.max(0.005, Math.min(rowAvgH, box.height));
      const tol = Math.max(skewSlope ? 0.008 : 0.006, (skewSlope ? 0.68 : 0.58) * minH);

      const overlap = Math.min(rowY1, boxY1) - Math.max(rowY0, boxY0);
      const overlapRatio = overlap / minH;
      const dy = Math.abs(boxYCenter - rowYCenter);

      if (dy <= tol || overlapRatio >= 0.40) {
        if (dy < bestScore) {
          bestScore = dy;
          matchedRow = row;
        }
      }
    }

    if (matchedRow) {
      matchedRow.push(box);
    } else {
      rows.push([box]);
    }
  }

  const lines: NormalizedLine[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x0 - b.x0);
    const avgHeight = row.reduce((acc, w) => acc + w.height, 0) / row.length;

    let joined = '';
    for (let i = 0; i < row.length; i++) {
      const cur = row[i];
      const t = cur.text.trim();
      if (!t) continue;
      if (!joined) {
        joined = t;
        continue;
      }
      const prev = row[i - 1];
      const gap = cur.x0 - prev.x1;
      const hasPrevWidth = prev.x1 > prev.x0 + 0.0002;
      if (hasPrevWidth && gap <= 0.0012 && gap >= -0.005) {
        joined += t;
      } else {
        joined += ` ${t}`;
      }
    }

    const text = joined.replace(/\s+/g, ' ').trim();
    if (!text) continue;

    const x0 = Math.min(...row.map((w) => w.x0));
    const x1 = Math.max(...row.map((w) => w.x1));
    const y0 = Math.min(...row.map((w) => w.y0));
    const y1 = Math.max(...row.map((w) => w.y1));
    const fontNames = Array.from(
      new Set(row.map((w) => w.fontName).filter((f): f is string => Boolean(f)))
    );

    lines.push({
      text,
      x0,
      x1,
      xCenter: (x0 + x1) / 2,
      y0,
      y1,
      yCenter: (y0 + y1) / 2,
      avgHeight,
      fontNames,
      words: row,
      isDivider: isDividerLineText(text),
    });
  }

  lines.sort((a, b) => {
    const ay = skewSlope ? a.yCenter - skewSlope * (a.xCenter - 0.5) : a.yCenter;
    const by = skewSlope ? b.yCenter - skewSlope * (b.xCenter - 0.5) : b.yCenter;
    return ay - by;
  });
  return lines;
}

function boxesToText(boxes: NormalizedBox[], skewSlope = 0): string {
  return groupBoxesIntoLines(boxes, skewSlope)
    .map((l) => l.text)
    .filter(Boolean)
    .join('\n');
}

async function detectHorizontalDividerYsFromPdfOps(
  page: any,
  pdfjsOps: any,
  viewportWidth: number,
  viewportHeight: number
): Promise<number[]> {
  const dividerYs: number[] = [];
  if (!page || typeof page.getOperatorList !== 'function' || !viewportWidth || !viewportHeight) {
    return dividerYs;
  }

  try {
    const opList = await page.getOperatorList();
    const fnArray: number[] = opList?.fnArray || [];
    const argsArray: any[] = opList?.argsArray || [];

    const checkHorizontalSegment = (xA: number, yA: number, xB: number, yB: number) => {
      const x0Frac = Math.min(xA, xB) / viewportWidth;
      const x1Frac = Math.max(xA, xB) / viewportWidth;
      const yTopFrac = 1 - Math.max(yA, yB) / viewportHeight;
      const yBotFrac = 1 - Math.min(yA, yB) / viewportHeight;
      const wFrac = x1Frac - x0Frac;
      const hFrac = Math.abs(yBotFrac - yTopFrac);
      const xCenterFrac = (x0Frac + x1Frac) / 2;
      const yCenterFrac = (yTopFrac + yBotFrac) / 2;

      if (
        yCenterFrac >= 0.04 &&
        yCenterFrac <= 0.42 &&
        xCenterFrac <= 0.52 &&
        wFrac >= 0.05 &&
        wFrac <= 0.46 &&
        hFrac <= 0.008
      ) {
        dividerYs.push(yCenterFrac);
      }
    };

    let curX = 0;
    let curY = 0;

    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i];
      const args = argsArray[i];
      if (!args) continue;

      if (fn === pdfjsOps?.constructPath && Array.isArray(args[0]) && Array.isArray(args[1])) {
        const subOps: number[] = args[0];
        const coords: number[] = args[1];
        let ci = 0;
        let lx = 0;
        let ly = 0;
        for (const sop of subOps) {
          if (sop === pdfjsOps.moveTo && ci + 1 < coords.length) {
            lx = coords[ci++];
            ly = coords[ci++];
          } else if (sop === pdfjsOps.lineTo && ci + 1 < coords.length) {
            const nx = coords[ci++];
            const ny = coords[ci++];
            checkHorizontalSegment(lx, ly, nx, ny);
            lx = nx;
            ly = ny;
          } else if (sop === pdfjsOps.rectangle && ci + 3 < coords.length) {
            const rx = coords[ci++];
            const ry = coords[ci++];
            const rw = coords[ci++];
            const rh = coords[ci++];
            checkHorizontalSegment(rx, ry, rx + rw, ry + rh);
          } else if (sop === 15 || sop === 16 || sop === 17) {
            // curveTo / curveTo2 / curveTo3
            ci += sop === 15 ? 6 : 4;
          }
        }
      } else if (fn === pdfjsOps?.moveTo && args.length >= 2) {
        curX = Number(args[0]) || 0;
        curY = Number(args[1]) || 0;
      } else if (fn === pdfjsOps?.lineTo && args.length >= 2) {
        const nx = Number(args[0]) || 0;
        const ny = Number(args[1]) || 0;
        checkHorizontalSegment(curX, curY, nx, ny);
        curX = nx;
        curY = ny;
      } else if (fn === pdfjsOps?.rectangle && args.length >= 4) {
        const rx = Number(args[0]) || 0;
        const ry = Number(args[1]) || 0;
        const rw = Number(args[2]) || 0;
        const rh = Number(args[3]) || 0;
        checkHorizontalSegment(rx, ry, rx + rw, ry + rh);
      }
    }
  } catch {
    // ignore operator list errors
  }

  return Array.from(new Set(dividerYs.map((y) => Math.round(y * 1000) / 1000))).sort((a, b) => a - b);
}

let serverPdfJsLoadPromise: Promise<{
  pdfjs: any;
  standardFontDataUrl?: string;
  cMapUrl?: string;
  workerResolvedPath: string;
}> | null = null;

export function getServerPdfWorkerDiagnostics(): {
  workerPath: string;
  workerExists: boolean;
  standardFontsExists: boolean;
  cmapsExists: boolean;
  pdfjsVersion: string;
} {
  let workerPath = '';
  let workerExists = false;
  let standardFontsExists = false;
  let cmapsExists = false;
  let pdfjsVersion = '';
  try {
    workerPath = requireFromHere.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
    workerExists = fs.existsSync(workerPath);
  } catch {
    workerPath = path.resolve(process.cwd(), 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs');
    workerExists = fs.existsSync(workerPath);
  }
  try {
    const pkgPath = requireFromHere.resolve('pdfjs-dist/package.json');
    const pkgDir = path.dirname(pkgPath);
    pdfjsVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))?.version || '';
    standardFontsExists = fs.existsSync(path.join(pkgDir, 'standard_fonts'));
    cmapsExists = fs.existsSync(path.join(pkgDir, 'cmaps'));
  } catch {
    // ignore
  }
  return {
    workerPath,
    workerExists,
    standardFontsExists,
    cmapsExists,
    pdfjsVersion,
  };
}

async function loadServerPdfJs() {
  if (!serverPdfJsLoadPromise) {
    serverPdfJsLoadPromise = (async () => {
      // Import tường minh cả pdf.mjs và pdf.worker.mjs cùng phiên bản để trình đóng gói Vercel (@vercel/nft)
      // luôn theo dõi và đưa tệp worker vào gói Serverless Function (/var/task/node_modules/pdfjs-dist/legacy/build/)
      const [pdfjs, pdfjsWorker] = await Promise.all([
        import('pdfjs-dist/legacy/build/pdf.mjs'),
        // @ts-ignore pdfjs-dist legacy worker module has no .d.mts declarations
        import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
      ]);

      // Cấu hình worker riêng cho runtime máy chủ (tách biệt hoàn toàn khỏi PdfPreviewPane phía trình duyệt)
      if (pdfjsWorker?.WorkerMessageHandler) {
        (globalThis as any).pdfjsWorker = pdfjsWorker;
      }

      let workerResolvedPath = '';
      try {
        workerResolvedPath = requireFromHere.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
        if (workerResolvedPath && fs.existsSync(workerResolvedPath) && pdfjs?.GlobalWorkerOptions) {
          pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerResolvedPath).href;
        }
      } catch {
        // Fallback sử dụng globalThis.pdfjsWorker đã nạp trực tiếp ở trên
      }

      let standardFontDataUrl: string | undefined;
      let cMapUrl: string | undefined;
      try {
        const pdfPkgDir = path.dirname(requireFromHere.resolve('pdfjs-dist/package.json'));
        const fontsDir = path.join(pdfPkgDir, 'standard_fonts');
        const cmapsDir = path.join(pdfPkgDir, 'cmaps');
        if (fs.existsSync(fontsDir)) {
          standardFontDataUrl = pathToFileURL(fontsDir + path.sep).href;
        }
        if (fs.existsSync(cmapsDir)) {
          cMapUrl = pathToFileURL(cmapsDir + path.sep).href;
        }
      } catch {
        // ignore optional font/cmap assets
      }

      return { pdfjs, standardFontDataUrl, cMapUrl, workerResolvedPath };
    })().catch((err) => {
      serverPdfJsLoadPromise = null;
      throw err;
    });
  }
  return serverPdfJsLoadPromise;
}

async function extractPdfTextWithPdfJs(buffer: Buffer): Promise<{
  pageCount: number;
  pages: PdfPageTextInfo[];
  rawSigDates: string[];
  rawSigSigners: string[];
}> {
  const { pdfjs, standardFontDataUrl, cMapUrl } = await loadServerPdfJs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    verbosity: 0,
    useSystemFonts: true,
    isEvalSupported: false,
    ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
    ...(cMapUrl ? { cMapUrl, cMapPacked: true } : {}),
  });

  const pdfDoc = await loadingTask.promise;
  const pageCount = pdfDoc.numPages || 1;
  const pages: PdfPageTextInfo[] = [];

  for (let p = 1; p <= pageCount; p++) {
    const page = await pdfDoc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();

    const allBoxes: NormalizedBox[] = [];
    const leftTopBoxes: NormalizedBox[] = [];
    const rightTopBoxes: NormalizedBox[] = [];
    const rightBottomBoxes: NormalizedBox[] = [];
    const rightHalfBoxes: NormalizedBox[] = [];
    const bottomBoxes: NormalizedBox[] = [];

    for (const item of textContent.items as any[]) {
      if (!item || typeof item.str !== 'string' || !item.str.trim()) continue;
      const txX = Number(item.transform?.[4] ?? 0);
      const txY = Number(item.transform?.[5] ?? 0);
      const itemW = Math.max(0, Number(item.width ?? 0));
      const itemH = Math.max(4, Math.abs(Number(item.height || item.transform?.[3] || 10)));

      const x0 = clamp01(txX / viewport.width);
      const x1 = clamp01((txX + itemW) / viewport.width);
      const y1 = clamp01(1 - txY / viewport.height);
      const y0 = clamp01(1 - (txY + itemH) / viewport.height);
      const height = Math.max(0.004, y1 - y0);
      const yCenter = (y0 + y1) / 2;
      const xCenter = (x0 + x1) / 2;

      const box: NormalizedBox = {
        text: item.str.normalize('NFC'),
        x0,
        x1: Math.max(x0 + 0.001, x1),
        y0,
        y1: Math.max(y0 + 0.004, y1),
        height,
        fontName: typeof item.fontName === 'string' ? item.fontName : undefined,
      };
      allBoxes.push(box);

      if (yCenter <= 0.45) {
        if (xCenter < 0.52) leftTopBoxes.push(box);
        if (x0 >= 0.45) rightTopBoxes.push(box);
      }
      if (yCenter >= 0.35) {
        bottomBoxes.push(box);
        if (x0 >= 0.40) rightBottomBoxes.push(box);
      }
      if (x0 >= 0.40) {
        rightHalfBoxes.push(box);
      }
    }

    const dividerYs =
      p === 1
        ? await detectHorizontalDividerYsFromPdfOps(page, pdfjs.OPS, viewport.width, viewport.height)
        : [];

    let annotationText = '';
    try {
      const annots = await page.getAnnotations();
      const annotParts: string[] = [];
      for (const a of annots || []) {
        const strVal =
          (a.contentsObj?.str && String(a.contentsObj.str)) ||
          (typeof a.contents === 'string' && a.contents) ||
          (typeof a.fieldValue === 'string' && a.fieldValue) ||
          '';
        if (strVal.trim()) {
          annotParts.push(strVal.trim());
        }

        // Bổ sung hộp tọa độ cho annotation không phải chữ ký số ở vùng đầu Trang 1 (vd số văn bản / ngày cấp từ hệ thống e-office)
        if (
          p === 1 &&
          strVal.trim() &&
          Array.isArray(a.rect) &&
          a.rect.length === 4 &&
          a.fieldType !== 'Sig' &&
          a.subtype !== 'Link'
        ) {
          const cleanAnnot = strVal.normalize('NFC').replace(/\u00D0/g, 'Đ').replace(/\u00F0/g, 'đ').trim();
          const normAnnot = removeVietnameseDiacritics(cleanAnnot);
          const isSigStamp = /(ky\s*boi|signed\s*by|thoi\s*gian\s*ky|ngay\s*ky\s*:|signing\s*time|chung\s*thu\s*so|signature\s*valid)/i.test(
            normAnnot
          );
          if (!isSigStamp && cleanAnnot.length <= 80) {
            const [rx0, ry0, rx1, ry1] = a.rect.map(Number);
            const ax0 = clamp01(Math.min(rx0, rx1) / viewport.width);
            const ax1 = clamp01(Math.max(rx0, rx1) / viewport.width);
            const ay0 = clamp01(1 - Math.max(ry0, ry1) / viewport.height);
            const ay1 = clamp01(1 - Math.min(ry0, ry1) / viewport.height);
            const ayCenter = (ay0 + ay1) / 2;
            const axCenter = (ax0 + ax1) / 2;
            if (ayCenter <= 0.36 && ax1 > ax0 && ay1 > ay0) {
              const annotBox: NormalizedBox = {
                text: cleanAnnot,
                x0: ax0,
                x1: ax1,
                y0: ay0,
                y1: ay1,
                height: Math.max(0.006, ay1 - ay0),
              };
              allBoxes.push(annotBox);
              if (axCenter < 0.52) leftTopBoxes.push(annotBox);
              if (ax0 >= 0.45) rightTopBoxes.push(annotBox);
            }
          }
        }
      }
      annotationText = annotParts.join('\n').trim();
    } catch {
      // ignore annotation read errors
    }

    const fullText = boxesToText(allBoxes);
    pages.push({
      pageNumber: p,
      fullText,
      leftTopText: boxesToText(leftTopBoxes),
      rightTopText: boxesToText(rightTopBoxes),
      rightBottomText: boxesToText(rightBottomBoxes),
      rightHalfText: boxesToText(rightHalfBoxes),
      bottomText: boxesToText(bottomBoxes),
      annotationText,
      alphaNumCount: countMeaningfulChars(fullText),
      boxes: allBoxes,
      dividerYs,
    });
  }

  // Quét metadata chữ ký số nhúng trong raw PDF (/M (D:YYYYMMDD...) và /Name (...)) — chỉ lấy ngày/tháng/năm
  const rawLatin = buffer.toString('latin1');
  const rawSigDates: string[] = [];
  const rawSigSigners: string[] = [];

  const sigBlockMatches = rawLatin.match(/\/Type\s*\/Sig[\s\S]{0,800}/g) || [];
  for (const blk of sigBlockMatches) {
    const mMatch = blk.match(/\/M\s*\(D:(\d{4})(\d{2})(\d{2})/);
    if (mMatch) {
      const [, yyyy, mm, dd] = mMatch;
      const dateOnly = formatDateDdMmYyyy(dd, mm, yyyy);
      if (dateOnly) rawSigDates.push(dateOnly);
    }
    const nameMatch = blk.match(/\/Name\s*\(([^)]{2,100})\)/);
    if (nameMatch && !nameMatch[1].startsWith('þÿ')) {
      rawSigSigners.push(nameMatch[1].trim());
    }
  }

  if (typeof pdfDoc.destroy === 'function') {
    await pdfDoc.destroy().catch(() => {});
  } else if (typeof loadingTask.destroy === 'function') {
    await loadingTask.destroy().catch(() => {});
  }
  return { pageCount, pages, rawSigDates, rawSigSigners };
}

function getPngDimensions(pngPath: string): { width: number; height: number } {
  try {
    const fd = fs.openSync(pngPath, 'r');
    const hdr = Buffer.alloc(24);
    fs.readSync(fd, hdr, 0, 24, 0);
    fs.closeSync(fd);
    if (hdr.toString('ascii', 1, 4) === 'PNG') {
      const width = hdr.readUInt32BE(16);
      const height = hdr.readUInt32BE(20);
      if (width > 0 && height > 0) return { width, height };
    }
  } catch {
    // ignore
  }
  return { width: 1654, height: 2339 };
}

function extractBoxesFromTesseractData(
  data: any,
  imgWidth: number,
  imgHeight: number
): NormalizedBox[] {
  const boxes: NormalizedBox[] = [];
  if (!data?.blocks || !Array.isArray(data.blocks)) return boxes;

  for (const block of data.blocks) {
    for (const para of block?.paragraphs || []) {
      for (const line of para?.lines || []) {
        for (const word of line?.words || []) {
          const text = (word?.text || '')
            .normalize('NFC')
            .replace(/\u00D0/g, 'Đ')
            .replace(/\u00F0/g, 'đ')
            .trim();
          const bbox = word?.bbox;
          if (!text || !bbox) continue;
          const x0 = clamp01(Number(bbox.x0) / imgWidth);
          const x1 = clamp01(Number(bbox.x1) / imgWidth);
          const y0 = clamp01(Number(bbox.y0) / imgHeight);
          const y1 = clamp01(Number(bbox.y1) / imgHeight);
          if (x1 <= x0 || y1 <= y0) continue;
          boxes.push({
            text,
            x0,
            x1,
            y0,
            y1,
            height: Math.max(0.004, y1 - y0),
          });
        }
      }
    }
  }
  return boxes;
}

async function renderPdfPageToPng(
  pdfPath: string,
  pageNumber: number,
  outPngPath: string,
  dpi = 200
): Promise<void> {
  await execFileAsync('gs', [
    '-dNOPAUSE',
    '-dBATCH',
    '-dQUIET',
    '-sDEVICE=png16m',
    `-r${dpi}`,
    `-dFirstPage=${pageNumber}`,
    `-dLastPage=${pageNumber}`,
    `-sOutputFile=${outPngPath}`,
    pdfPath,
  ]);
}

const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function pngCrc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = PNG_CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(pngCrc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function cropRgbPngRegion(
  pngPath: string,
  outCropPath: string,
  xFrac0: number,
  yFrac0: number,
  xFrac1: number,
  yFrac1: number,
  enhanceColoredInk = false
): { width: number; height: number } | null {
  try {
    const fileBuf = fs.readFileSync(pngPath);
    if (fileBuf.length < 32 || fileBuf.toString('ascii', 1, 4) !== 'PNG') return null;

    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 8;
    let colorType = 2;
    const idatChunks: Buffer[] = [];

    while (offset + 8 <= fileBuf.length) {
      const len = fileBuf.readUInt32BE(offset);
      const type = fileBuf.toString('ascii', offset + 4, offset + 8);
      const dataStart = offset + 8;
      const dataEnd = dataStart + len;
      if (dataEnd + 4 > fileBuf.length) break;
      const data = fileBuf.subarray(dataStart, dataEnd);
      if (type === 'IHDR' && data.length >= 13) {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        bitDepth = data[8];
        colorType = data[9];
      } else if (type === 'IDAT') {
        idatChunks.push(data);
      } else if (type === 'IEND') {
        break;
      }
      offset = dataEnd + 4;
    }

    if (!width || !height || bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || idatChunks.length === 0) {
      return null;
    }

    const bpp = colorType === 6 ? 4 : 3;
    const stride = width * bpp;
    const raw = zlib.inflateSync(Buffer.concat(idatChunks));
    if (raw.length < height * (stride + 1)) return null;

    const recon = Buffer.alloc(height * stride);
    const paethPredictor = (a: number, b: number, c: number) => {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      if (pa <= pb && pa <= pc) return a;
      if (pb <= pc) return b;
      return c;
    };

    for (let y = 0; y < height; y++) {
      const filterType = raw[y * (stride + 1)];
      const rowInStart = y * (stride + 1) + 1;
      const rowOutStart = y * stride;
      const prevOutStart = (y - 1) * stride;
      for (let x = 0; x < stride; x++) {
        const val = raw[rowInStart + x];
        const a = x >= bpp ? recon[rowOutStart + x - bpp] : 0;
        const b = y > 0 ? recon[prevOutStart + x] : 0;
        const c = y > 0 && x >= bpp ? recon[prevOutStart + x - bpp] : 0;
        let resByte = val;
        if (filterType === 1) resByte = (val + a) & 0xff;
        else if (filterType === 2) resByte = (val + b) & 0xff;
        else if (filterType === 3) resByte = (val + ((a + b) >> 1)) & 0xff;
        else if (filterType === 4) resByte = (val + paethPredictor(a, b, c)) & 0xff;
        recon[rowOutStart + x] = resByte;
      }
    }

    const cx0 = Math.max(0, Math.min(width - 1, Math.floor(xFrac0 * width)));
    const cy0 = Math.max(0, Math.min(height - 1, Math.floor(yFrac0 * height)));
    const cx1 = Math.max(cx0 + 1, Math.min(width, Math.ceil(xFrac1 * width)));
    const cy1 = Math.max(cy0 + 1, Math.min(height, Math.ceil(yFrac1 * height)));
    const cropW = cx1 - cx0;
    const cropH = cy1 - cy0;
    const cropStride = cropW * bpp;
    const cropRaw = Buffer.alloc(cropH * (cropStride + 1));

    for (let y = 0; y < cropH; y++) {
      const srcOffset = (cy0 + y) * stride + cx0 * bpp;
      const dstOffset = y * (cropStride + 1);
      cropRaw[dstOffset] = 0; // None filter
      if (!enhanceColoredInk) {
        recon.copy(cropRaw, dstOffset + 1, srcOffset, srcOffset + cropStride);
      } else {
        // Tăng tương phản mực màu (đỏ/xanh đóng dấu số văn bản hoặc ngày) bằng kênh min(R, G, B)
        for (let px = 0; px < cropW; px++) {
          const si = srcOffset + px * bpp;
          const di = dstOffset + 1 + px * bpp;
          const minCh = Math.min(recon[si], recon[si + 1], recon[si + 2]);
          const boosted = minCh >= 205 ? 255 : Math.max(0, Math.round((minCh - 20) * 0.65));
          cropRaw[di] = boosted;
          cropRaw[di + 1] = boosted;
          cropRaw[di + 2] = boosted;
          if (bpp === 4) cropRaw[di + 3] = 255;
        }
      }
    }

    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(cropW, 0);
    ihdr.writeUInt32BE(cropH, 4);
    ihdr[8] = 8;
    ihdr[9] = colorType;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    const compressed = zlib.deflateSync(cropRaw, { level: 4 });
    const outPng = Buffer.concat([
      sig,
      makePngChunk('IHDR', ihdr),
      makePngChunk('IDAT', compressed),
      makePngChunk('IEND', Buffer.alloc(0)),
    ]);
    fs.writeFileSync(outCropPath, outPng);
    return { width: cropW, height: cropH };
  } catch {
    return null;
  }
}

interface OcrPageResult {
  text: string;
  confidence: number;
  boxes: NormalizedBox[];
}

async function extractEmbeddedJpegFromPdfPage(
  buffer: Buffer,
  pageNumber: number
): Promise<Buffer | null> {
  try {
    const { PDFDocument, PDFDict, PDFName, PDFRawStream } = await import('pdf-lib');
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const pages = doc.getPages();
    const page = pages[pageNumber - 1];
    if (!page) return null;
    const resources = page.node.Resources();
    if (!resources) return null;
    const xObject = resources.lookup(PDFName.of('XObject'));
    if (!(xObject instanceof PDFDict)) return null;

    let bestJpeg: Buffer | null = null;
    for (const [, val] of xObject.entries()) {
      const resolved = doc.context.lookup(val);
      if (resolved instanceof PDFRawStream) {
        const subtype = resolved.dict.lookup(PDFName.of('Subtype'));
        const filter = resolved.dict.lookup(PDFName.of('Filter'));
        const isImage = subtype === PDFName.of('Image');
        const filterText = filter?.toString?.() || '';
        if (isImage && filterText.includes('DCTDecode') && resolved.contents.length > 0) {
          const candidate = Buffer.from(resolved.contents);
          if (!bestJpeg || candidate.length > bestJpeg.length) {
            bestJpeg = candidate;
          }
        }
      }
    }
    return bestJpeg;
  } catch {
    return null;
  }
}

// Pooled warm Vietnamese Tesseract worker (serializes concurrent calls & auto-terminates after 90s idle to free RAM)
let sharedVieOcrWorker: any = null;
let sharedVieOcrIdleTimer: ReturnType<typeof setTimeout> | null = null;
let sharedVieOcrQueue: Promise<void> = Promise.resolve();
const SHARED_OCR_IDLE_MS = 90_000;

function resetSharedVieOcrIdleTimer() {
  if (sharedVieOcrIdleTimer) {
    clearTimeout(sharedVieOcrIdleTimer);
    sharedVieOcrIdleTimer = null;
  }
  sharedVieOcrIdleTimer = setTimeout(() => {
    sharedVieOcrIdleTimer = null;
    const w = sharedVieOcrWorker;
    sharedVieOcrWorker = null;
    if (w) {
      w.terminate().catch(() => {});
    }
  }, SHARED_OCR_IDLE_MS);
  if (typeof (sharedVieOcrIdleTimer as any)?.unref === 'function') {
    (sharedVieOcrIdleTimer as any).unref();
  }
}

async function withVietnameseOcrWorker<T>(fn: (worker: any) => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = sharedVieOcrQueue;
  sharedVieOcrQueue = prev.catch(() => {}).then(() => gate);
  await prev.catch(() => {});

  if (sharedVieOcrIdleTimer) {
    clearTimeout(sharedVieOcrIdleTimer);
    sharedVieOcrIdleTimer = null;
  }

  try {
    if (!sharedVieOcrWorker) {
      const { createWorker } = await import('tesseract.js');
      const langPath = path.resolve(process.cwd(), 'node_modules/@tesseract.js-data/vie/4.0.0');
      const workerOpts: any = fs.existsSync(path.join(langPath, 'vie.traineddata.gz'))
        ? { langPath, gzip: true }
        : {};
      sharedVieOcrWorker = await createWorker('vie', 1, workerOpts);
    }
    try {
      return await fn(sharedVieOcrWorker);
    } catch (runErr) {
      // Nếu worker gặp lỗi nội bộ, hủy để lần sau khởi tạo lại sạch sẽ
      const broken = sharedVieOcrWorker;
      sharedVieOcrWorker = null;
      if (broken) {
        broken.terminate().catch(() => {});
      }
      throw runErr;
    }
  } finally {
    if (sharedVieOcrWorker) {
      resetSharedVieOcrIdleTimer();
    }
    release();
  }
}

async function runVietnameseOcrOnPages(
  buffer: Buffer,
  pageNumbers: number[]
): Promise<{
  results: Map<number, OcrPageResult>;
  ocrUnavailableReason?: string;
}> {
  const results = new Map<number, OcrPageResult>();
  if (pageNumbers.length === 0) return { results };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nct-pdf-ocr-'));
  const pdfPath = path.join(tmpDir, 'input.pdf');
  fs.writeFileSync(pdfPath, buffer);

  let ocrUnavailableReason: string | undefined;
  try {
    await withVietnameseOcrWorker(async (worker) => {
      for (const p of pageNumbers) {
        let imagePathToRecognize = '';
        const outPng = path.join(tmpDir, `page-${p}.png`);
        try {
          await renderPdfPageToPng(pdfPath, p, outPng);
          if (fs.existsSync(outPng)) {
            imagePathToRecognize = outPng;
          }
        } catch (renderErr: any) {
          // Trên môi trường serverless không cài Ghostscript (gs), fallback trích ảnh JPEG nhúng trong trang scan
          const jpegBuf = await extractEmbeddedJpegFromPdfPage(buffer, p);
          if (jpegBuf) {
            const outJpg = path.join(tmpDir, `page-${p}.jpg`);
            fs.writeFileSync(outJpg, jpegBuf);
            imagePathToRecognize = outJpg;
          } else {
            console.warn(
              `[PDF OCR] Không thể chuyển trang ${p} sang ảnh để OCR (${renderErr?.code || renderErr?.message || 'render_error'}).`
            );
            ocrUnavailableReason =
              'Bản PDF dạng scan trên máy chủ hiện cần kiểm tra trực tiếp từ bản gốc bên cạnh; vui lòng đối chiếu và bổ sung thông tin còn thiếu trước khi lưu.';
          }
        }

        if (imagePathToRecognize && fs.existsSync(imagePathToRecognize)) {
          const dims = imagePathToRecognize.endsWith('.png')
            ? getPngDimensions(imagePathToRecognize)
            : { width: 1654, height: 2339 };
          const ret = await worker.recognize(imagePathToRecognize, {}, { blocks: true });
          const boxes = extractBoxesFromTesseractData(ret?.data, dims.width, dims.height);
          const rawText = (ret?.data?.text || '').trim();
          const reconstructed = boxes.length > 0 ? boxesToText(boxes) : rawText;
          results.set(p, {
            text: reconstructed || rawText,
            confidence: Number(ret?.data?.confidence ?? 0),
            boxes,
          });
        }
      }
    });
  } catch (ocrErr: any) {
    console.warn('[PDF OCR] Lỗi chạy OCR tiếng Việt, giữ lại kết quả đọc PDF & xác nhận thủ công:', ocrErr?.message);
    ocrUnavailableReason =
      'Không thể chạy OCR tự động cho bản scan này; vui lòng đối chiếu bản PDF gốc bên cạnh và kiểm tra các trường thông tin.';
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return { results, ocrUnavailableReason };
}

function formatDateDdMmYyyy(day: string, month: string, year: string): string {
  const d = day.padStart(2, '0');
  const m = month.padStart(2, '0');
  const y = year.length === 2 ? `20${year}` : year;
  return normalizeDateOnlyDdMmYyyy(`${d}/${m}/${y}`);
}

const BODY_DATE_CONTEXT_REGEX =
  /\b(?:can\s+cu|dieu\s+\d+|khoan\s+\d+|diem\s+[a-z]|ngay\s+hieu\s+luc|co\s+hieu\s+luc|ke\s+tu\s+ngay|han\s+(?:nop|cuoi)|cham\s+nhat|truoc\s+ngay|tu\s+ngay|den\s+(?:het\s+)?ngay|lich\s+trinh|thoi\s+gian\s+(?:to\s+chuc|nhan|nop|thi)|quyet\s+dinh\s+so|cong\s+van\s+so|thong\s+tu\s+so|nghi\s+dinh\s+so|ke\s+hoach\s+so|ban\s+hanh\s+kem\s+theo)\b/i;

const DIGITAL_SIG_STAMP_DATE_REGEX =
  /(?:thoi\s*gian\s*ky|ngay\s*ky\s*[:\-.]?|ky\s*ngay\s*[:\-.]?|ky\s*boi|ky\s*so|nguoi\s*ky\s*[:\-]|co\s*quan\s*[:\-]|don\s*vi\s*[:\-]|email\s*[:\-]|signed\s+on|signed\s+by|signing\s+time|signature\s+valid|digitally\s+signed|chu\s+ky\s+so|chung\s+thu\s+so|smartca|vnpt|vgca|bkav|viettel[\-\s]?ca|fpt[\-\s]?ca|safe[\-\s]?ca|newca|trustca|ban\s+co\s+yeu|serial(?:\s*number)?|timestamp|valid\s+from|issued\s+by|\bUTC\b|\bGMT\b)/i;

function isDigitalSignatureDateLine(lineText: string): boolean {
  const s = (lineText || '').normalize('NFC').trim();
  if (!s) return false;
  // Thời điểm có giờ:phút (vd 18/11/2026 14:22:10, 09:15 +07:00) luôn là dấu thời gian ký số/hệ thống
  if (/\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(s) || /[+-]\d{2}:?\d{2}\b/.test(s)) {
    return true;
  }
  const norm = removeVietnameseDiacritics(s);
  if (DIGITAL_SIG_STAMP_DATE_REGEX.test(norm)) {
    return true;
  }
  if (isDigitalSignatureNoise(s)) {
    return true;
  }
  return false;
}

function extractAllRawDatesFromString(text: string): string[] {
  if (!text) return [];
  const norm = removeVietnameseDiacritics(text.normalize('NFC'));
  const found = new Set<string>();
  for (const m of norm.matchAll(/\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})\b/g)) {
    const d = formatDateDdMmYyyy(m[1], m[2], m[3]);
    if (d) found.add(d);
  }
  for (const m of norm.matchAll(/\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/g)) {
    const d = formatDateDdMmYyyy(m[3], m[2], m[1]);
    if (d) found.add(d);
  }
  for (const m of norm.matchAll(/\bngay\s*(\d{1,2})\s*thang\s*(\d{1,2})\s*nam\s*(\d{4})\b/gi)) {
    const d = formatDateDdMmYyyy(m[1], m[2], m[3]);
    if (d) found.add(d);
  }
  return Array.from(found);
}

function collectDigitalSignatureDates(params: {
  rawSigDates: string[];
  pages: PdfPageTextInfo[];
  pageTextByNum: Map<number, string>;
}): Set<string> {
  const ignored = new Set<string>();
  for (const raw of params.rawSigDates) {
    const d = normalizeDateOnlyDdMmYyyy(raw);
    if (d) ignored.add(d);
  }
  for (const p of params.pages) {
    if (p.annotationText) {
      for (const d of extractAllRawDatesFromString(p.annotationText)) {
        ignored.add(d);
      }
    }
    const text = params.pageTextByNum.get(p.pageNumber) || p.fullText || '';
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (isDigitalSignatureDateLine(lines[i])) {
        for (const d of extractAllRawDatesFromString(lines[i])) {
          ignored.add(d);
        }
        // Trường hợp khung chữ ký số tách "Ngày ký:" và "18/11/2026" thành 2 dòng kề nhau
        if (i + 1 < lines.length && lines[i + 1].length <= 40) {
          for (const d of extractAllRawDatesFromString(lines[i + 1])) {
            ignored.add(d);
          }
        }
      }
    }
  }
  return ignored;
}

function repairOcrDateDigits(token: string): string {
  return (token || '')
    .trim()
    .replace(/[OoQq]/g, '0')
    .replace(/[lI|!]/g, '1')
    .replace(/[Zz]/g, '2')
    .replace(/[Ss]/g, '5')
    .replace(/[Bb]/g, '8');
}

function parseVietnameseSmallNumber(rawNorm: string, maxVal = 31): number | null {
  const s = (rawNorm || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;

  // Thử dạng số trực tiếp (có hỗ trợ sửa lỗi OCR nhẹ)
  const repairedDigits = repairOcrDateDigits(s.replace(/^(?:mung|mong)\s+/, ''));
  if (/^\d{1,2}$/.test(repairedDigits)) {
    const n = parseInt(repairedDigits, 10);
    return n >= 1 && n <= maxVal ? n : null;
  }

  const cleaned = s.replace(/^(?:mung|mong)\s+/, '').trim();
  if (cleaned === 'gieng') return maxVal >= 1 ? 1 : null;
  if (cleaned === 'chap') return maxVal >= 12 ? 12 : null;

  const unitMap: Record<string, number> = {
    mot: 1,
    moot: 1,
    hai: 2,
    ba: 3,
    bon: 4,
    tu: 4,
    nam: 5,
    lam: 5,
    nham: 5,
    sau: 6,
    bay: 7,
    tam: 8,
    chin: 9,
    muoi: 10,
  };

  if (unitMap[cleaned] !== undefined) {
    const n = unitMap[cleaned];
    return n >= 1 && n <= maxVal ? n : null;
  }

  const tokens = cleaned.split(' ').filter(Boolean);
  if (tokens.length === 2 && tokens[0] === 'muoi' && unitMap[tokens[1]] !== undefined && unitMap[tokens[1]] <= 9) {
    const n = 10 + unitMap[tokens[1]];
    return n >= 1 && n <= maxVal ? n : null;
  }
  if (tokens.length === 2 && (tokens[0] === 'hai' || tokens[0] === 'ba') && tokens[1] === 'muoi') {
    const n = unitMap[tokens[0]] * 10;
    return n >= 1 && n <= maxVal ? n : null;
  }
  if (
    tokens.length === 2 &&
    (tokens[0] === 'hai' || tokens[0] === 'ba') &&
    unitMap[tokens[1]] !== undefined &&
    unitMap[tokens[1]] <= 9
  ) {
    // Dạng nói gọn: "hai lam" -> 25, "hai tam" -> 28, "ba mot" -> 31
    const n = unitMap[tokens[0]] * 10 + unitMap[tokens[1]];
    return n >= 1 && n <= maxVal ? n : null;
  }
  if (
    tokens.length === 3 &&
    (tokens[0] === 'hai' || tokens[0] === 'ba') &&
    tokens[1] === 'muoi' &&
    unitMap[tokens[2]] !== undefined &&
    unitMap[tokens[2]] <= 9
  ) {
    const n = unitMap[tokens[0]] * 10 + unitMap[tokens[2]];
    return n >= 1 && n <= maxVal ? n : null;
  }

  return null;
}

function parseVietnameseYearWord(rawNorm: string): number | null {
  const s = (rawNorm || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;

  const repairedDigits = repairOcrDateDigits(s.replace(/\s+/g, ''));
  if (/^\d{4}$/.test(repairedDigits)) {
    const y = parseInt(repairedDigits, 10);
    return y >= 1990 && y <= 2100 ? y : null;
  }

  // Hỗ trợ năm viết bằng chữ: "hai nghin khong tram hai muoi sau" / "hai ngan khong tram hai lam"
  const m2k = s.match(
    /^hai\s+(?:nghin|ngan)(?:\s+khong\s+tram)?(?:\s+(?:le|linh))?\s+(.+)$/
  );
  if (m2k && m2k[1]) {
    const tail = parseVietnameseSmallNumber(m2k[1], 99);
    if (tail !== null) {
      const y = 2000 + tail;
      return y >= 1990 && y <= 2100 ? y : null;
    }
  }
  return null;
}

function validateAdministrativeDate(formattedDdMmYyyy: string): string {
  if (!formattedDdMmYyyy) return '';
  const parts = formattedDdMmYyyy.split('/');
  if (parts.length !== 3) return '';
  const y = parseInt(parts[2], 10);
  if (!Number.isFinite(y) || y < 1990 || y > 2100) return '';
  return formattedDdMmYyyy;
}

function extractDateFromHeaderOrSigLine(
  lineText: string,
  options?: { allowStandaloneNumeric?: boolean }
): string {
  if (!lineText) return '';
  const nfc = lineText.normalize('NFC').trim();
  if (isDigitalSignatureDateLine(nfc)) return '';
  const norm = removeVietnameseDiacritics(nfc).replace(/\s+/g, ' ').trim();
  if (BODY_DATE_CONTEXT_REGEX.test(norm)) return '';

  // 1. "An Giang, ngày 18 tháng 11 năm 2026" hoặc "ngày18 tháng 11 năm 2026" (chấp nhận lỗi OCR chữ số l/I/O)
  const mNumericVn = norm.match(
    /\bng[aăâ]y\s*([0-9OoIl|]{1,2})\s*th[aăâ]ng\s*([0-9OoIl|]{1,2})\s*n[aăâ]m\s*([0-9OoIl|]{4})\b/i
  );
  if (mNumericVn) {
    const dStr = repairOcrDateDigits(mNumericVn[1]);
    const mStr = repairOcrDateDigits(mNumericVn[2]);
    const yStr = repairOcrDateDigits(mNumericVn[3]);
    if (/^\d{1,2}$/.test(dStr) && /^\d{1,2}$/.test(mStr) && /^\d{4}$/.test(yStr)) {
      const formatted = validateAdministrativeDate(formatDateDdMmYyyy(dStr, mStr, yStr));
      if (formatted) return formatted;
    }
  }

  // 2. Ngày tháng viết bằng chữ tiếng Việt: "An Giang, ngày mười tám tháng mười một năm 2026"
  const mWordVn = norm.match(
    /\bng[aăâ]y\s+([a-z0-9\s]{1,24}?)\s+th[aăâ]ng\s+([a-z0-9\s]{1,20}?)\s+n[aăâ]m\s+([a-z0-9\s]{4,45})(?:[.,;]|$)/i
  );
  if (mWordVn) {
    const dNum = parseVietnameseSmallNumber(mWordVn[1], 31);
    const mNum = parseVietnameseSmallNumber(mWordVn[2], 12);
    const yNum = parseVietnameseYearWord(mWordVn[3]);
    if (dNum !== null && mNum !== null && yNum !== null) {
      const formatted = validateAdministrativeDate(
        formatDateDdMmYyyy(String(dNum), String(mNum), String(yNum))
      );
      if (formatted) return formatted;
    }
  }

  // 3. "An Giang, ngày 18/11/2026", "Ngày 18-11-2026", "Ngày 18.11.2026"
  const mSlash = norm.match(
    /(?:^|[,\s])ng[aăâ]y\s*[:\-]?\s*(\d{1,2})\s*[\/\-\.]\s*(\d{1,2})\s*[\/\-\.]\s*(\d{4})\b/i
  );
  if (mSlash) {
    const formatted = validateAdministrativeDate(formatDateDdMmYyyy(mSlash[1], mSlash[2], mSlash[3]));
    if (formatted) return formatted;
  }

  // 4. Dạng số trực tiếp CHỈ dùng trong Vùng B (góc trên bên phải dưới Tiêu ngữ): "An Giang, 18/11/2026", "18/11/2026", "18-11-2026"
  if (options?.allowStandaloneNumeric) {
    // Bỏ qua nếu dòng giống Số/ký hiệu văn bản
    if (!/\bso\s*[:.;]/i.test(norm)) {
      const mDirect = norm.match(
        /(?:^|[,\s])(\d{1,2})\s*[\/\-\.]\s*(\d{1,2})\s*[\/\-\.]\s*(\d{4})(?:[.,;\s]|$)/
      );
      if (mDirect) {
        const formatted = validateAdministrativeDate(
          formatDateDdMmYyyy(mDirect[1], mDirect[2], mDirect[3])
        );
        if (formatted) return formatted;
      }
    }
  }

  return '';
}

interface TopRightDateAnalysis {
  primary: ExtractedDateSource | null;
  candidates: string[];
  regionBBBox?: NormalizedBBox;
}

function extractTopRightHeaderDate(
  page1Boxes: NormalizedBox[],
  rightTopText: string,
  splitX: number,
  options?: { skewSlope?: number; soLineYCenter?: number; titleTopY?: number }
): TopRightDateAnalysis {
  const skewSlope = options?.skewSlope || 0;
  const maxHeaderY = Math.min(0.46, Math.max(0.26, (options?.titleTopY ?? 0.45) + 0.015));

  // VÙNG B – PHÍA TRÊN BÊN PHẢI: chỉ lấy các hộp nằm bên phải ranh giới động splitX và phía trên vùng tiêu đề
  const topRightBoxes = page1Boxes.filter((b) => {
    const yc = (b.y0 + b.y1) / 2;
    const xc = (b.x0 + b.x1) / 2;
    const adjY = skewSlope ? yc - skewSlope * (xc - 0.5) : yc;
    return adjY <= maxHeaderY && xc >= splitX - 0.01 && b.x0 >= Math.max(0.24, splitX - 0.045);
  });

  const allRightLines = groupBoxesIntoLines(topRightBoxes, skewSlope).filter((l) => !l.isDivider);
  const regionBBBox = unionLineBBoxes(allRightLines);

  let foundMottoIdx = -1;
  for (let i = 0; i < allRightLines.length; i++) {
    const norm = removeVietnameseDiacritics(allRightLines[i].text);
    if (/(CONG HOA|XA HOI CHU NGHIA|DOC LAP\s*[-–—]?\s*TU DO|HANH PHUC)/i.test(norm)) {
      foundMottoIdx = i;
    }
  }

  const candidateLines =
    foundMottoIdx !== -1 ? allRightLines.slice(foundMottoIdx + 1) : allRightLines;

  const stopRegex =
    /^(KE HOACH|QUYET DINH|THONG BAO|BAO CAO|CONG VAN|TO TRINH|CHUONG TRINH|HUONG DAN|NGHI QUYET|CHI THI|CAN CU|KINH GUI|DIEU \d+|I\.\s|1\.\s)/i;

  const scoredHits: Array<{
    source: ExtractedDateSource;
    score: number;
  }> = [];

  const pushHit = (date: string, linesUsed: NormalizedLine[], rawText: string, bonus: number) => {
    if (!date) return;
    const bbox = unionLineBBoxes(linesUsed);
    const lineY = linesUsed[0]?.yCenter ?? 0.18;
    let score = bonus;
    if (foundMottoIdx !== -1) score += 25;
    if (options?.soLineYCenter !== undefined) {
      const yDiff = Math.abs(lineY - options.soLineYCenter);
      if (yDiff <= 0.025) score += 30;
      else if (yDiff <= 0.055) score += 15;
    }
    if (/ng[àa]y/i.test(rawText) && /th[áa]ng/i.test(rawText) && /n[ăa]m/i.test(rawText)) {
      score += 20;
    }
    scoredHits.push({
      source: {
        date,
        positionLabel: 'Vùng B – Góc trên bên phải (Trang 1)',
        page: 1,
        bbox,
        rawText: rawText.trim(),
      },
      score,
    });
  };

  for (let i = 0; i < candidateLines.length; i++) {
    const line = candidateLines[i];
    const norm = removeVietnameseDiacritics(line.text);
    if (stopRegex.test(norm)) {
      break;
    }

    // 1. Khớp trực tiếp trên 1 dòng trong Vùng B (ưu tiên dạng "ngày ... tháng ... năm ..." trước, sau đó dạng số trực tiếp)
    const parsedFull = extractDateFromHeaderOrSigLine(line.text, { allowStandaloneNumeric: false });
    if (parsedFull) {
      pushHit(parsedFull, [line], line.text, 40);
      continue;
    }

    // 2. Ghép 2 dòng kề nhau trong Vùng B (vd chữ nghiêng/xuống dòng: "An Giang, ngày 18" + "tháng 11 năm 2026")
    if (i + 1 < candidateLines.length) {
      const nextLine = candidateLines[i + 1];
      const nextNorm = removeVietnameseDiacritics(nextLine.text);
      if (!stopRegex.test(nextNorm) && nextLine.yCenter - line.yCenter <= 0.042) {
        const combined = `${line.text} ${nextLine.text}`.replace(/\s+/g, ' ').trim();
        const parsedPair = extractDateFromHeaderOrSigLine(combined, {
          allowStandaloneNumeric: true,
        });
        if (parsedPair) {
          pushHit(parsedPair, [line, nextLine], combined, 35);
          i++; // đã dùng nextLine
          continue;
        }
      }
    }

    // 3. Dạng số ngắn gọn trong Vùng B ("An Giang, 18/11/2026", "18/11/2026", "18-11-2026")
    const parsedStandalone = extractDateFromHeaderOrSigLine(line.text, {
      allowStandaloneNumeric: true,
    });
    if (parsedStandalone) {
      pushHit(parsedStandalone, [line], line.text, 25);
    }
  }

  // 4. Gom band dọc hẹp trong Vùng B quanh dòng ngang hàng với "Số:" (chữa lỗi token in nghiêng lệch nhẹ theo trục Y)
  if (scoredHits.length === 0 && options?.soLineYCenter !== undefined && topRightBoxes.length > 0) {
    const nearSoBoxes = topRightBoxes
      .filter((b) => {
        const yc = (b.y0 + b.y1) / 2;
        const xc = (b.x0 + b.x1) / 2;
        const adjY = skewSlope ? yc - skewSlope * (xc - 0.5) : yc;
        return Math.abs(adjY - options.soLineYCenter!) <= 0.032;
      })
      .sort((a, b) => a.x0 - b.x0);
    if (nearSoBoxes.length >= 2) {
      const bandText = nearSoBoxes.map((b) => b.text.trim()).join(' ').replace(/\s+/g, ' ').trim();
      const parsedBand = extractDateFromHeaderOrSigLine(bandText, {
        allowStandaloneNumeric: true,
      });
      if (parsedBand) {
        const bandLine: NormalizedLine = {
          text: bandText,
          x0: Math.min(...nearSoBoxes.map((b) => b.x0)),
          x1: Math.max(...nearSoBoxes.map((b) => b.x1)),
          xCenter:
            (Math.min(...nearSoBoxes.map((b) => b.x0)) + Math.max(...nearSoBoxes.map((b) => b.x1))) / 2,
          y0: Math.min(...nearSoBoxes.map((b) => b.y0)),
          y1: Math.max(...nearSoBoxes.map((b) => b.y1)),
          yCenter:
            (Math.min(...nearSoBoxes.map((b) => b.y0)) + Math.max(...nearSoBoxes.map((b) => b.y1))) / 2,
          avgHeight: nearSoBoxes.reduce((a, b) => a + b.height, 0) / nearSoBoxes.length,
          fontNames: [],
          words: nearSoBoxes,
          isDivider: false,
        };
        pushHit(parsedBand, [bandLine], bandText, 30);
      }
    }
  }

  // 5. Fallback từ text Vùng B (chỉ khi không có hộp tọa độ khớp)
  if (scoredHits.length === 0 && rightTopText) {
    const rawLines = rightTopText.split('\n').map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < rawLines.length; i++) {
      const rawLine = rawLines[i];
      const norm = removeVietnameseDiacritics(rawLine);
      if (/(CONG HOA|DOC LAP|HANH PHUC)/i.test(norm)) continue;
      if (stopRegex.test(norm)) break;
      const parsed = extractDateFromHeaderOrSigLine(rawLine, { allowStandaloneNumeric: true });
      if (parsed) {
        scoredHits.push({
          source: {
            date: parsed,
            positionLabel: 'Vùng B – Góc trên bên phải (Trang 1)',
            page: 1,
            estimated: true,
            rawText: rawLine,
          },
          score: 18,
        });
        continue;
      }
      if (i + 1 < rawLines.length) {
        const pair = `${rawLine} ${rawLines[i + 1]}`.replace(/\s+/g, ' ').trim();
        const parsedPair = extractDateFromHeaderOrSigLine(pair, { allowStandaloneNumeric: true });
        if (parsedPair) {
          scoredHits.push({
            source: {
              date: parsedPair,
              positionLabel: 'Vùng B – Góc trên bên phải (Trang 1)',
              page: 1,
              estimated: true,
              rawText: pair,
            },
            score: 16,
          });
          i++;
        }
      }
    }
  }

  scoredHits.sort((a, b) => b.score - a.score);
  const uniqueCandidates = Array.from(new Set(scoredHits.map((h) => h.source.date)));

  return {
    primary: scoredHits[0]?.source || null,
    candidates: uniqueCandidates,
    regionBBBox,
  };
}

/**
 * CHỈ trích xuất ngày ký được IN TRONG NỘI DUNG VĂN BẢN gần khối người ký.
 * Loại bỏ hoàn toàn thời điểm ký số, tem/khung chữ ký điện tử ("Ký bởi", "Ngày ký:", "Thời gian ký:", ...),
 * annotation chữ ký số và metadata PDF (/Type /Sig /M D:...).
 */
function extractSignatureZoneDate(params: {
  signaturePage: number;
  pageBoxes: NormalizedBox[];
  signerPageText: string;
}): ExtractedDateSource | null {
  const { signaturePage, pageBoxes, signerPageText } = params;

  // Lọc các hộp thuộc phần nội dung/khối ký (bỏ phần tiêu đề góc trên trang 1 để không trùng Vị trí 1)
  const sigZoneBoxes = pageBoxes.filter((b) => {
    const yc = (b.y0 + b.y1) / 2;
    if (signaturePage === 1 && yc <= 0.42) return false;
    return yc >= 0.20;
  });
  const sigZoneLines = groupBoxesIntoLines(sigZoneBoxes).filter((l) => !l.isDivider);

  // Xác định các vùng khung/tem chữ ký số để loại trừ tuyệt đối mọi dòng nằm trong hoặc sát tem ký số
  const stampAnchorLines = sigZoneLines.filter((l) => isDigitalSignatureDateLine(l.text));
  const isInsideDigitalSigStamp = (line: NormalizedLine): boolean => {
    if (isDigitalSignatureDateLine(line.text)) return true;
    for (const anchor of stampAnchorLines) {
      const dy = Math.abs(line.yCenter - anchor.yCenter);
      const horizOverlap =
        Math.min(line.x1, anchor.x1) - Math.max(line.x0, anchor.x0) > -0.08;
      if (dy <= 0.065 && horizOverlap) {
        return true;
      }
    }
    return false;
  };

  // Tìm dòng chức vụ ký đầu tiên ở vùng chữ ký
  let roleLineIdx = -1;
  for (let i = 0; i < sigZoneLines.length; i++) {
    if (isInsideDigitalSigStamp(sigZoneLines[i])) continue;
    const norm = removeVietnameseDiacritics(sigZoneLines[i].text);
    if (SIGNER_ROLE_REGEX.test(norm) && sigZoneLines[i].x0 >= 0.28) {
      roleLineIdx = i;
      break;
    }
  }

  // Ưu tiên quét các dòng in ngay phía trên và trong khối người ký (không đọc tem chữ ký số)
  const sigScopeLines =
    roleLineIdx !== -1
      ? sigZoneLines.slice(Math.max(0, roleLineIdx - 5), Math.min(sigZoneLines.length, roleLineIdx + 10))
      : sigZoneLines.filter((l) => l.x0 >= 0.30 && l.yCenter >= 0.45);

  for (const line of sigScopeLines) {
    if (signaturePage === 1 && line.yCenter <= 0.42) continue;
    if (isInsideDigitalSigStamp(line)) continue;
    const norm = removeVietnameseDiacritics(line.text);
    if (BODY_DATE_CONTEXT_REGEX.test(norm)) continue;

    const fromVn = extractDateFromHeaderOrSigLine(line.text);
    if (fromVn) {
      return {
        date: fromVn,
        positionLabel: `Khối chữ ký (Trang ${signaturePage})`,
        page: signaturePage,
        bbox: unionLineBBoxes([line]),
        rawText: line.text,
      };
    }
  }

  // Fallback từ text trang ký khi chưa có boxes (ví dụ PDF scan fallback text), vẫn loại trừ hoàn toàn tem ký số
  if (sigZoneBoxes.length === 0 && signerPageText) {
    const rawLines = signerPageText.split('\n').map((s) => s.trim()).filter(Boolean);
    const searchLines = signaturePage === 1 ? rawLines.slice(Math.floor(rawLines.length * 0.45)) : rawLines;
    for (let i = 0; i < searchLines.length; i++) {
      const l = searchLines[i];
      if (isDigitalSignatureDateLine(l)) continue;
      // Bỏ qua nếu nằm ngay cạnh nhãn tem chữ ký số
      const nearStamp =
        (i > 0 && isDigitalSignatureDateLine(searchLines[i - 1])) ||
        (i + 1 < searchLines.length && isDigitalSignatureDateLine(searchLines[i + 1]));
      if (nearStamp) continue;

      const d = extractDateFromHeaderOrSigLine(l);
      if (d) {
        return {
          date: d,
          positionLabel: `Khối chữ ký (Trang ${signaturePage})`,
          page: signaturePage,
          estimated: true,
          rawText: l,
        };
      }
    }
  }

  return null;
}

function extractDocNumberFromSoValue(rawAfterLabel: string): string {
  return normalizeDocNumber(rawAfterLabel);
}

function isSoLabelLine(lineText: string): boolean {
  const cleaned = lineText.normalize('NFC').replace(/^[\s_\-—–=~*•·.]+/, '').trim();
  if (!cleaned) return false;
  // Chấp nhận "Số:8773", "Số: 2937", "Số : 8773 /KH-SGDĐT", "Số;8773", "Sổ:8773", "56:8773", "S6:8773", "Số/Ký hiệu:..."
  if (/^(?:[S5][ốoôơổộ6](?:\s*\/\s*K[ýy]\s*hi[ệe]u)?)\s*[:;\.]/i.test(cleaned)) {
    return true;
  }
  // Hỗ trợ "Số2937 /QĐ-SGDĐT", "Số 2937/QĐ-SGDĐT", "Số /QĐ-SGDĐT", hoặc nhãn đứng riêng "Số"
  if (
    /^[S5][ốoôơổộ6](?:\s*\d{1,5})?\s*[\/\-]/i.test(cleaned) ||
    /^[S5][ốoôơổộ6]\s*\d{1,5}(?:\s|$)/i.test(cleaned) ||
    /^[S5][ốoôơổộ6]$/i.test(cleaned)
  ) {
    return true;
  }
  return false;
}

function extractValueFromSoLine(lineText: string): string {
  return normalizeDocNumber(lineText);
}

function extractDocNumberCandidates(text: string): string[] {
  if (!text) return [];
  const nfc = text.normalize('NFC').replace(/\u00D0/g, 'Đ').replace(/\u00F0/g, 'đ');
  const lineStartRegex =
    /^(?:[S5][ốoôơổộ6]|Số\s*\/\s*Ký\s*hiệu)\s*[:;\.]?[ \t]*([0-9OoIl]{0,5}(?:[ \t]+[0-9OoIl]{1,3})?[ \t]*[\/\-][ \t]*[\p{L}\p{N}_\-\.\/]+(?:[ \t]*[\-\/][ \t]*[\p{L}\p{N}_\-\.]+)*)/iu;
  const results: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of nfc.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const normLine = removeVietnameseDiacritics(line);
    // Tuyệt đối không lấy số văn bản viện dẫn trong nội dung ("Căn cứ Quyết định số...", "Theo Công văn số...")
    if (CITED_DOC_CONTEXT_REGEX.test(normLine)) continue;
    const m = line.match(lineStartRegex);
    if (!m) continue;
    const num = normalizeDocNumber(m[1] || '');
    if (!num) continue;
    const key = num.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      results.push(num);
    }
  }
  return results;
}

function isIncompleteOrSuspiciousDocNumber(val: string): { suspicious: boolean; reason: string } {
  const trimmed = (val || '').normalize('NFC').trim();
  if (!trimmed) {
    return {
      suspicious: true,
      reason: 'Chưa nhận diện được Số/ký hiệu văn bản ở góc trên bên trái trang 1.',
    };
  }
  if (/^[\/\-]/.test(trimmed)) {
    return {
      suspicious: true,
      reason: `Số/ký hiệu đọc được ("${trimmed}") đang thiếu chữ số gốc đứng trước dấu "/". Vui lòng đối chiếu bản PDF gốc và bổ sung đủ số văn bản.`,
    };
  }
  if (!/\d/.test(trimmed)) {
    return {
      suspicious: true,
      reason: `Số/ký hiệu đọc được ("${trimmed}") chưa có phần chữ số rõ ràng. Vui lòng kiểm tra lại với bản PDF gốc.`,
    };
  }
  if (!/[\/\-]/.test(trimmed)) {
    return {
      suspicious: true,
      reason: `Số/ký hiệu đọc được ("${trimmed}") có thể bị thiếu phần ký hiệu sau dấu "/". Vui lòng kiểm tra lại.`,
    };
  }
  if (/[\/\-]$/.test(trimmed) || !/[\/\-][\p{L}]/u.test(trimmed)) {
    return {
      suspicious: true,
      reason: `Số/ký hiệu đọc được ("${trimmed}") chưa đầy đủ phần ký hiệu sau dấu "/". Vui lòng kiểm tra lại.`,
    };
  }
  if (/[\uFFFD?\uE000-\uF8FF]/.test(trimmed)) {
    return {
      suspicious: true,
      reason: `Số/ký hiệu đọc được ("${trimmed}") có ký tự lỗi mã hóa phông chữ. Vui lòng kiểm tra lại.`,
    };
  }
  return { suspicious: false, reason: '' };
}

const KNOWN_DOC_TYPE_CODES_ASCII = new Set([
  'QD',
  'KH',
  'TB',
  'BC',
  'CV',
  'TTR',
  'CT',
  'HD',
  'NQ',
  'QC',
  'GM',
  'TM',
  'VB',
  'BB',
  'GT',
  'GN',
  'GNP',
  'GXN',
  'TT',
  'CTr',
  'CTR',
  'KL',
  'CD',
  'PA',
  'DA',
  'BCN',
]);

const FILENAME_NON_AGENCY_WORDS_ASCII = new Set([
  'VE',
  'VIEC',
  'BOI',
  'DUONG',
  'BOIDUONG',
  'HOC',
  'SINH',
  'GIOI',
  'NAM',
  'KY',
  'THI',
  'CONG',
  'NHAN',
  'TRIEN',
  'KHAI',
  'THUC',
  'HIEN',
  'TO',
  'CHUC',
  'SIGNED',
  'SCAN',
  'FINAL',
  'PDF',
  'BAN',
  'HANH',
  'PHU',
  'LUC',
  'DINH',
  'KEM',
  'QUYET',
  'DINH',
  'KE',
  'HOACH',
  'THONG',
  'BAO',
  'HUONG',
  'DAN',
  'BAO',
  'CAO',
  'VAN',
  'CAP',
  'TINH',
  'TRUONG',
]);

function isLikelyFilenameAgencyToken(token: string): boolean {
  const trimmed = (token || '').trim();
  if (!trimmed || trimmed.length < 2 || trimmed.length > 12) return false;
  if (/^\d+$/.test(trimmed)) return false;

  const asciiUpper = removeVietnameseDiacritics(trimmed).toUpperCase();
  if (FILENAME_NON_AGENCY_WORDS_ASCII.has(asciiUpper)) return false;

  // CamelCase title word like "BoiDuong", "BoiDuongHSG", "KeHoach" (has lowercase + uppercase with >=2 consecutive lowercase letters)
  if (/[A-ZÀ-ỸĐ]/.test(trimmed) && /[a-zà-ỹđ]{2,}/.test(trimmed)) {
    // Allow known Vietnamese education/admin acronyms like "GDTrH", "TTr", "CTr"
    if (!/^(?:GDTrH|TTr|CTr|TrH|PhG|KTT|QLCL|GDTH|GDMN|GDTX)$/i.test(asciiUpper)) {
      return false;
    }
  }

  // All-lowercase word: only accept if it's a known agency acronym (e.g. sgddt, bgddt, ubnd, dtn, thptnct)
  if (trimmed === trimmed.toLowerCase()) {
    return /^(?:sgddt|bgddt|ubnd|hdnd|dtn|thptnct|thpt|gdtrh|gdth|gdmn|gdtx|khtc|tccb|vp|qlcl|cb|cbgd|ctd|tinhdoan|doantruong)$/.test(
      asciiUpper.toLowerCase()
    );
  }

  // Mostly uppercase letters/digits (e.g., SGDĐT, UBND, BGDĐT, THPTNCT, ĐTN, GDTrH, KHTC)
  const letters = trimmed.match(/\p{L}/gu) || [];
  if (letters.length === 0) return false;
  const upperCount = letters.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length;
  return upperCount / letters.length >= 0.7;
}

export function extractFilenameDocNumberHint(fileName: string): string {
  const base = (fileName || '')
    .normalize('NFC')
    .replace(/\u00D0/g, 'Đ')
    .replace(/\u00F0/g, 'đ')
    .replace(/\.[^.]+$/, '')
    .trim();
  if (!base) return '';

  // 1. Mẫu số văn bản nối bằng ".", "-", "_", "/" (vd "2937-QD-SGDDT", "2937_QD_BoiDuong", "2937.QD", "03-TB.DTN")
  const sepMatch = base.match(
    /(?:^|[^\d])(\d{1,5})([.\-\/_])([\p{L}]{1,8})((?:[.\-\/_][\p{L}\p{N}]+)*)/iu
  );
  if (sepMatch) {
    const [, numPart, firstSep, firstCode, restRaw] = sepMatch;
    const rawCandidate = `${numPart}${firstSep}${firstCode}${restRaw || ''}`;
    if (!/^\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}$/.test(rawCandidate)) {
      const firstAscii = removeVietnameseDiacritics(firstCode).toUpperCase();
      const firstLooksValid =
        KNOWN_DOC_TYPE_CODES_ASCII.has(firstAscii) || isLikelyFilenameAgencyToken(firstCode);
      if (firstLooksValid) {
        const extraTokens: string[] = [];
        if (restRaw) {
          const parts = restRaw.split(/[.\-\/_]+/).filter(Boolean);
          for (const part of parts) {
            if (extraTokens.length >= 2) break;
            if (isLikelyFilenameAgencyToken(part)) {
              extraTokens.push(part);
            } else {
              // Gặp từ thuộc tiêu đề văn bản -> dừng ngay, không nuốt tên văn bản vào ký hiệu
              break;
            }
          }
        }
        const combined =
          extraTokens.length > 0
            ? `${numPart}/${firstCode}-${extraTokens.join('-')}`
            : `${numPart}/${firstCode}`;
        const normalized = normalizeDocNumber(combined);
        if (normalized) return normalized;
      }
    }
  }

  // 2. Mẫu có khoảng trắng giữa số và mã loại (vd "2937 QĐ SGDĐT", "So 2937 QD", "2937 QĐ-SGDĐT")
  const spaceMatch = base.match(
    /(?:^|[^\d])(\d{1,5})\s+(QĐ|QD|KH|TB|BC|CV|TTr|TTR|CT|HD|NQ|QC|GM|TM|VB)(?:[\s.\-\/_]+([\p{L}\p{N}]{2,12}))?/iu
  );
  if (spaceMatch) {
    const [, numPart, typePart, maybeAgency] = spaceMatch;
    const agencyPart = maybeAgency && isLikelyFilenameAgencyToken(maybeAgency) ? maybeAgency : '';
    const combined = agencyPart ? `${numPart}/${typePart}-${agencyPart}` : `${numPart}/${typePart}`;
    const normalized = normalizeDocNumber(combined);
    if (normalized) return normalized;
  }

  return '';
}

function isMostlyUppercaseLine(str: string): boolean {
  const letters = (str || '').match(/\p{L}/gu) || [];
  if (letters.length === 0) return false;
  const upperCount = letters.filter((ch) => ch === ch.toUpperCase() && ch !== ch.toLowerCase()).length;
  return upperCount / letters.length >= 0.82;
}

function startsWithAgencyNoun(str: string): boolean {
  const norm = removeVietnameseDiacritics(str).trim();
  return /^(?:SO|PHONG|TRUONG|TRUNG TAM|UY BAN|UBND|BO|CUC|VU|CHI CUC|CHI BO|DOAN|BAN|VIEN|HOC VIEN|CONG AN|TINH DOAN|HUYEN DOAN|THANH DOAN|HDND|DAI HOC)\b/i.test(
    norm
  );
}

function isWrappedAgencyContinuation(prevText: string, curText: string): boolean {
  const normPrev = removeVietnameseDiacritics(prevText).trim();
  const normCur = removeVietnameseDiacritics(curText).trim();
  if (!normPrev || !normCur) return false;
  if (startsWithAgencyNoun(curText)) return false;
  if (/^(?:VA|CUA|TINH|THANH PHO|THPT|THCS|TH|QUAN|HUYEN|THI XA|TP\.|VIET NAM|NGUYEN|AN GIANG|DAO TAO)\b/i.test(normCur)) {
    return true;
  }
  if (/\b(?:VA|CUA|GIAO DUC|DAO TAO|NHAN DAN|THPT|TRUONG|TRUNG TAM|PHONG)\s*$/i.test(normPrev)) {
    return true;
  }
  return false;
}

function detectHeaderColumnSplitX(topBoxes: NormalizedBox[], skewSlope = 0): number {
  const headerTopBoxes = topBoxes.filter((b) => {
    const yc = (b.y0 + b.y1) / 2;
    const xc = (b.x0 + b.x1) / 2;
    const adjY = skewSlope ? yc - skewSlope * (xc - 0.5) : yc;
    return adjY <= 0.36;
  });
  if (headerTopBoxes.length === 0) return 0.48;

  // 1. Neo theo VÙNG B (Quốc hiệu, Tiêu ngữ, dòng địa danh/ngày tháng) — hỗ trợ cả text span nhiều từ lẫn từng từ OCR rời
  const rightPhraseRegex =
    /(?:CONG\s+HOA|XA\s+HOI|CHU\s+NGHIA|VIET\s+NAM|DOC\s+LAP|TU\s+DO|HANH\s+PHUC|\bNGAY\s*\d{1,2}\s*THANG\b|\bNGAY\s+[A-Z]+\s+THANG\b)/i;
  const rightSingleTokenRegex =
    /^(?:CONG|HOA|XA|HOI|CHU|NGHIA|VIET|NAM|DOC|LAP|TU|DO|HANH|PHUC)$/i;

  const rightAnchors = headerTopBoxes.filter((b) => {
    const norm = removeVietnameseDiacritics(b.text).replace(/\s+/g, ' ').trim();
    if (!norm || b.x0 < 0.28) return false;
    if (rightPhraseRegex.test(norm)) return true;
    const alphaOnly = norm.replace(/[^A-Za-z]/g, '');
    return b.x0 >= 0.34 && rightSingleTokenRegex.test(alphaOnly);
  });

  // 2. Neo theo VÙNG A (Cơ quan chủ quản, Cơ quan ban hành, dòng Số:)
  const leftPhraseRegex =
    /^(?:UBND|UY\s+BAN|SO\s+GIAO\s+DUC|BO\s+GIAO\s+DUC|PHONG\s+GIAO\s+DUC|TRUONG\s+|CHI\s+BO|DOAN\s+|BAN\s+CHAP\s+HANH|[S5]O\s*[:.;])/i;
  const leftAnchors = headerTopBoxes.filter((b) => {
    const norm = removeVietnameseDiacritics(b.text).replace(/\s+/g, ' ').trim();
    const xc = (b.x0 + b.x1) / 2;
    return norm.length >= 2 && xc <= 0.62 && leftPhraseRegex.test(norm) && !rightPhraseRegex.test(norm);
  });

  if (rightAnchors.length >= 1) {
    const minRightX = Math.min(...rightAnchors.map((b) => b.x0));
    // Tìm mép phải lớn nhất của Vùng A nằm hoàn toàn bên trái Vùng B
    const strictlyLeft = leftAnchors.filter((b) => b.x1 <= minRightX + 0.01);
    if (strictlyLeft.length >= 1) {
      const maxLeftX = Math.max(...strictlyLeft.map((b) => b.x1));
      const midpoint = (maxLeftX + minRightX) / 2;
      return Math.min(0.66, Math.max(0.28, midpoint));
    }
    return Math.min(0.66, Math.max(0.28, minRightX - 0.012));
  }

  // 3. Fallback: tìm khoảng trắng dọc (gutter) rộng nhất trong khoảng x = 0.28..0.68 (thích ứng lề lệch)
  const leftCandidates = headerTopBoxes.filter((b) => b.x1 <= 0.62);
  const rightCandidates = headerTopBoxes.filter((b) => b.x0 >= 0.32);
  if (leftCandidates.length > 0 && rightCandidates.length > 0) {
    const intervals = headerTopBoxes
      .filter((b) => b.x1 - b.x0 < 0.62) // bỏ qua tiêu đề toàn trang nếu có lọt lên vùng y <= 0.36
      .map((b) => ({ x0: b.x0, x1: b.x1 }))
      .sort((a, b) => a.x0 - b.x0);
    if (intervals.length >= 2) {
      let bestGap = 0;
      let bestSplit = 0.48;
      let curMaxX = intervals[0].x1;
      for (let i = 1; i < intervals.length; i++) {
        if (intervals[i].x0 > curMaxX) {
          const gapMid = (curMaxX + intervals[i].x0) / 2;
          const gapSize = intervals[i].x0 - curMaxX;
          if (gapMid >= 0.28 && gapMid <= 0.68 && gapSize > bestGap) {
            bestGap = gapSize;
            bestSplit = gapMid;
          }
        }
        curMaxX = Math.max(curMaxX, intervals[i].x1);
      }
      if (bestGap >= 0.020) {
        return bestSplit;
      }
    }
  }

  return 0.48;
}

function unionLineBBoxes(lines: NormalizedLine[]): NormalizedBBox | undefined {
  const valid = lines.filter((l) => l && Number.isFinite(l.x0) && Number.isFinite(l.y0));
  if (valid.length === 0) return undefined;
  return {
    x0: Math.max(0, Math.min(...valid.map((l) => l.x0)) - 0.006),
    y0: Math.max(0, Math.min(...valid.map((l) => l.y0)) - 0.004),
    x1: Math.min(1, Math.max(...valid.map((l) => l.x1)) + 0.006),
    y1: Math.min(1, Math.max(...valid.map((l) => l.y1)) + 0.004),
  };
}

function findLinesBBoxByQuery(boxes: NormalizedBox[], query: string, yMin = 0, yMax = 1): NormalizedBBox | undefined {
  if (!boxes || boxes.length === 0 || !query || !query.trim()) return undefined;
  const scoped = boxes.filter((b) => {
    const yc = (b.y0 + b.y1) / 2;
    return yc >= yMin && yc <= yMax;
  });
  const lines = groupBoxesIntoLines(scoped).filter((l) => !l.isDivider);
  if (lines.length === 0) return undefined;

  const normQuery = removeVietnameseDiacritics(query).toLowerCase().replace(/\s+/g, ' ').trim();
  const queryWords = normQuery.split(/\s+/).filter((w) => w.length >= 2);
  if (normQuery.length < 2) return undefined;

  // 1. Direct single-line match first (tightest bbox), then multi-line window substring match
  for (let i = 0; i < lines.length; i++) {
    const norm1 = removeVietnameseDiacritics(lines[i].text).toLowerCase().replace(/\s+/g, ' ').trim();
    if (norm1.includes(normQuery) || (norm1.length >= 6 && normQuery.includes(norm1) && norm1.length >= normQuery.length * 0.45)) {
      return unionLineBBoxes([lines[i]]);
    }
  }
  for (let len = 2; len <= 5; len++) {
    for (let i = 0; i + len <= lines.length; i++) {
      const slice = lines.slice(i, i + len);
      const combined = slice
        .map((l) => removeVietnameseDiacritics(l.text).toLowerCase().replace(/\s+/g, ' ').trim())
        .join(' ');
      if (combined.includes(normQuery)) {
        return unionLineBBoxes(slice);
      }
    }
  }

  // 2. Best token overlap match across 1..5 consecutive lines
  if (queryWords.length >= 2) {
    let bestScore = 0;
    let bestSlice: NormalizedLine[] = [];
    for (let i = 0; i < lines.length; i++) {
      for (let len = 1; len <= 5 && i + len <= lines.length; len++) {
        const slice = lines.slice(i, i + len);
        const sliceNorm = removeVietnameseDiacritics(slice.map((l) => l.text).join(' '))
          .toLowerCase()
          .replace(/\s+/g, ' ');
        const matchedCount = queryWords.filter((w) => sliceNorm.includes(w)).length;
        const ratio = matchedCount / queryWords.length;
        if (matchedCount >= Math.min(2, queryWords.length) && ratio > bestScore) {
          bestScore = ratio;
          bestSlice = slice;
        }
      }
    }
    if (bestScore >= 0.55 && bestSlice.length > 0) {
      return unionLineBBoxes(bestSlice);
    }
  }

  return undefined;
}

const CITED_DOC_CONTEXT_REGEX =
  /\b(?:can\s+cu|theo\s+(?:quyet\s+dinh|cong\s+van|ke\s+hoach|thong\s+tu|nghi\s+dinh|huong\s+dan)|tai\s+(?:quyet\s+dinh|cong\s+van|ke\s+hoach)|ban\s+hanh\s+kem\s+theo|kem\s+theo|phu\s+luc|quyet\s+dinh\s+so|thong\s+tu\s+so|nghi\s+dinh\s+so|cong\s+van\s+so|ke\s+hoach\s+so)\b/i;

interface TopLeftHeaderAnalysis {
  parentAgency: string;
  parentAgencyBBox?: NormalizedBBox;
  issuingAgency: string;
  agencyBBox?: NormalizedBBox;
  agencyNeedsReview: boolean;
  agencyReviewReason: string;
  docNumber: string;
  docNumberRawText?: string;
  docNumberBBox?: NormalizedBBox;
  docNumberSource: 'so_label' | 'spatial_header' | 'none';
  docNumberNeedsReview: boolean;
  docNumberReviewReason: string;
  topLeftHeaderDocNumbers: string[];
  soLineYCenter?: number;
  rightTopText: string;
  leftTopText: string;
  splitX: number;
  skewSlope: number;
  skewDegrees: number;
  regionABBox?: NormalizedBBox;
  regionBBBox?: NormalizedBBox;
}

function analyzeTopLeftHeader(
  page1Boxes: NormalizedBox[],
  graphicDividerYs: number[] = []
): TopLeftHeaderAnalysis {
  if (page1Boxes.length === 0) {
    return {
      parentAgency: '',
      issuingAgency: '',
      agencyNeedsReview: false,
      agencyReviewReason: '',
      docNumber: '',
      docNumberSource: 'none',
      docNumberNeedsReview: false,
      docNumberReviewReason: '',
      topLeftHeaderDocNumbers: [],
      rightTopText: '',
      leftTopText: '',
      splitX: 0.48,
      skewSlope: 0,
      skewDegrees: 0,
    };
  }

  const topBoxes = page1Boxes.filter((b) => (b.y0 + b.y1) / 2 <= 0.48);
  const skewSlope = estimateHeaderSkewSlope(topBoxes);
  const skewDegrees = Number(((Math.atan(skewSlope) * 180) / Math.PI).toFixed(2));
  const splitX = detectHeaderColumnSplitX(topBoxes, skewSlope);

  // Tách độc lập VÙNG A (trái) và VÙNG B (phải) theo ranh giới động splitX — không trộn dữ liệu hai vùng
  const leftTopBoxes = topBoxes.filter((b) => {
    const xCenter = (b.x0 + b.x1) / 2;
    return xCenter < splitX + 0.008 && b.x0 < splitX - 0.002;
  });
  const rightTopBoxes = topBoxes.filter((b) => {
    const xCenter = (b.x0 + b.x1) / 2;
    return xCenter >= splitX - 0.008 && b.x0 >= Math.max(0.24, splitX - 0.035);
  });

  const leftTopLines = groupBoxesIntoLines(leftTopBoxes, skewSlope);
  const rightTopLines = groupBoxesIntoLines(rightTopBoxes, skewSlope);
  const rightTopText = rightTopLines
    .filter((l) => !l.isDivider)
    .map((l) => l.text)
    .join('\n');
  const leftTopText = leftTopLines
    .filter((l) => !l.isDivider)
    .map((l) => l.text)
    .join('\n');

  const headerStopRegex =
    /^(KE HOACH|QUYET DINH|THONG BAO|BAO CAO|TO TRINH|CHUONG TRINH|HUONG DAN|CONG VAN|QUY CHE|GIAY MOI|THU MOI|NGHI QUYET|CHI THI|CAN CU|KINH GUI|V\/V\b|VE VIEC\b|DIEU 1|I\.\s)/i;

  const regionALinesForBBox: NormalizedLine[] = [];
  for (const l of leftTopLines) {
    if (l.isDivider) continue;
    const n = removeVietnameseDiacritics(l.text);
    if (headerStopRegex.test(n)) break;
    regionALinesForBBox.push(l);
  }
  const regionBLinesForBBox: NormalizedLine[] = [];
  for (const l of rightTopLines) {
    if (l.isDivider) continue;
    const n = removeVietnameseDiacritics(l.text);
    if (headerStopRegex.test(n)) break;
    regionBLinesForBBox.push(l);
  }

  // Tìm dòng "Số:" trong VÙNG A (phía trên bên trái, dưới tên cơ quan ban hành, trên tiêu đề văn bản)
  let firstSoIndex = -1;
  let soLineYCenter: number | undefined;
  let docNumberRawText = '';
  const headerSoNumbers: string[] = [];
  const headerSoLines: NormalizedLine[] = [];

  for (let i = 0; i < leftTopLines.length; i++) {
    const line = leftTopLines[i];
    if (line.isDivider) continue;
    const norm = removeVietnameseDiacritics(line.text);
    if (headerStopRegex.test(norm)) {
      break;
    }
    if (CITED_DOC_CONTEXT_REGEX.test(norm)) {
      continue;
    }
    if (isSoLabelLine(line.text)) {
      if (firstSoIndex === -1) {
        firstSoIndex = i;
        soLineYCenter = line.yCenter;
      }
      let val = extractValueFromSoLine(line.text);
      let rawMatchedText = line.text;
      const matchedSoLines: NormalizedLine[] = [line];

      // Nếu lớp chữ tách rời hoặc đóng dấu số bị lệch nhẹ theo chiều dọc (vd ["Số", "2937", "/QĐ-SGDĐT"]),
      // gom các hộp thuộc Vùng A nằm trong dải dọc de-skew ±0.038 quanh dòng "Số:" và sắp xếp lại theo x0 để ghép đầy đủ.
      if (!val || isIncompleteOrSuspiciousDocNumber(val).suspicious) {
        const lineAdjY = skewSlope
          ? line.yCenter - skewSlope * (line.xCenter - 0.5)
          : line.yCenter;
        const bandBoxes = topBoxes
          .filter((b) => {
            const byc = (b.y0 + b.y1) / 2;
            const bxc = (b.x0 + b.x1) / 2;
            const bAdjY = skewSlope ? byc - skewSlope * (bxc - 0.5) : byc;
            if (Math.abs(bAdjY - lineAdjY) > 0.038) return false;
            if (bxc > splitX + 0.03) return false;
            const bn = removeVietnameseDiacritics(b.text).trim();
            if (!bn || isDividerLineText(b.text)) return false;
            if (
              /^(?:CONG HOA|DOC LAP|HANH PHUC|NGAY\b|THANG\b|NAM\b|AN GIANG|TINH |THANH PHO|SO GIAO DUC|UY BAN|UBND|TRUONG |V\/V|VE VIEC)/i.test(
                bn
              )
            ) {
              return false;
            }
            return true;
          })
          .sort((a, b) => a.x0 - b.x0);

        if (bandBoxes.length >= 2) {
          const bandJoined = bandBoxes.map((b) => b.text.trim()).join(' ').replace(/\s+/g, ' ').trim();
          const reassembled = extractValueFromSoLine(bandJoined);
          if (reassembled && !isIncompleteOrSuspiciousDocNumber(reassembled).suspicious) {
            val = reassembled;
            rawMatchedText = bandJoined;
            matchedSoLines.push({
              ...line,
              x0: Math.min(...bandBoxes.map((b) => b.x0)),
              x1: Math.max(...bandBoxes.map((b) => b.x1)),
              y0: Math.min(...bandBoxes.map((b) => b.y0)),
              y1: Math.max(...bandBoxes.map((b) => b.y1)),
              words: bandBoxes,
              text: bandJoined,
            });
          }
        }
      }

      // Nếu phần số ("2937") và phần ký hiệu ("/QĐ-SGDĐT") bị đóng dấu lệch lên/xuống dòng kề nhau
      if (val && (/^[\/\-]/.test(val) || /^\d{1,5}$/.test(val))) {
        const adjacentIndices = [i - 1, i + 1].filter((idx) => idx >= 0 && idx < leftTopLines.length);
        for (const adjIdx of adjacentIndices) {
          const adj = leftTopLines[adjIdx];
          if (adj.isDivider) continue;
          if (Math.abs(adj.yCenter - line.yCenter) <= 0.04) {
            const adjNorm = normalizeDocNumber(adj.text);
            let merged = '';
            if (/^[\/\-]/.test(val)) {
              const digitsOnly = adjNorm.match(/^(\d{1,5})$/);
              if (digitsOnly) merged = normalizeDocNumber(`${digitsOnly[1]}${val}`);
            } else if (/^\d{1,5}$/.test(val) && /^[\/\-]/.test(adjNorm)) {
              merged = normalizeDocNumber(`${val}${adjNorm}`);
            }
            if (merged && !isIncompleteOrSuspiciousDocNumber(merged).suspicious) {
              val = merged;
              rawMatchedText = `${line.text} ${adj.text}`.trim();
              matchedSoLines.push(adj);
              break;
            }
          }
        }
      }

      // Nếu "Số:" đứng một mình trên dòng và giá trị nằm ngay dòng sát bên dưới
      if (!val && i + 1 < leftTopLines.length) {
        const nextLine = leftTopLines[i + 1];
        if (!nextLine.isDivider && nextLine.yCenter - line.yCenter <= 0.038) {
          val = extractDocNumberFromSoValue(nextLine.text);
          if (val) {
            rawMatchedText = `${line.text} ${nextLine.text}`.trim();
            matchedSoLines.push(nextLine);
          }
        }
      }

      if (val && !headerSoNumbers.some((n) => n.toLowerCase() === val.toLowerCase())) {
        headerSoNumbers.push(val);
        if (headerSoLines.length === 0) {
          headerSoLines.push(...matchedSoLines);
          docNumberRawText = rawMatchedText;
        }
      } else if (headerSoLines.length === 0) {
        headerSoLines.push(line);
        docNumberRawText = line.text;
      }
    }
  }

  let docNumber = headerSoNumbers[0] || '';
  let docNumberSource: 'so_label' | 'spatial_header' | 'none' = docNumber ? 'so_label' : 'none';
  let docNumberNeedsReview = false;
  let docNumberReviewReason = '';

  // Fallback có kiểm soát theo VỊ TRÍ + CẤU TRÚC khi văn bản không theo chuẩn "Số:" ở Vùng A
  // Chỉ quét các dòng trong Vùng A nằm phía dưới tên cơ quan và phía trên tiêu đề (KHÔNG lấy từ Căn cứ / thân văn bản)
  if (!docNumber) {
    const spatialCandidates: Array<{ value: string; line: NormalizedLine }> = [];
    for (let i = 0; i < regionALinesForBBox.length; i++) {
      const line = regionALinesForBBox[i];
      if (line.yCenter > 0.36) break;
      const norm = removeVietnameseDiacritics(line.text);
      if (CITED_DOC_CONTEXT_REGEX.test(norm)) continue;
      if (startsWithAgencyNoun(line.text) && !/\d+\s*[\/\-]/.test(line.text)) continue;
      // Chỉ chấp nhận mẫu số/ký hiệu hành chính rõ ràng (vd "8773/KH-SGDĐT", "05/TB-ĐTN", "12-BC/ĐTN")
      const directCode = extractDocNumberFromSoValue(line.text);
      if (
        directCode &&
        !isIncompleteOrSuspiciousDocNumber(directCode).suspicious &&
        /^\d{1,5}[\/\-][\p{L}]{1,8}(?:[\/\-][\p{L}\p{N}\.]+)*$/u.test(directCode)
      ) {
        spatialCandidates.push({ value: directCode, line });
      }
    }
    if (spatialCandidates.length > 0) {
      docNumber = spatialCandidates[0].value;
      docNumberRawText = spatialCandidates[0].line.text;
      docNumberSource = 'spatial_header';
      soLineYCenter = spatialCandidates[0].line.yCenter;
      headerSoLines.push(spatialCandidates[0].line);
      for (const c of spatialCandidates) {
        if (!headerSoNumbers.some((n) => n.toLowerCase() === c.value.toLowerCase())) {
          headerSoNumbers.push(c.value);
        }
      }
      docNumberNeedsReview = true;
      docNumberReviewReason =
        'Không thấy nhãn "Số:" chuẩn ở Vùng A; đã nhận diện theo cấu trúc & vị trí đầu trang, vui lòng kiểm tra lại.';
    }
  }

  if (firstSoIndex !== -1 && !docNumber) {
    docNumberNeedsReview = true;
    docNumberReviewReason =
      'Đã thấy nhãn "Số" ở Vùng A (góc trên bên trái) nhưng chưa đọc chắc chắn phần số/ký hiệu phía sau.';
  } else if (headerSoNumbers.length > 1) {
    docNumberNeedsReview = true;
    docNumberReviewReason = `Phát hiện nhiều ứng viên Số/ký hiệu ở Vùng A (${headerSoNumbers.join(', ')}), vui lòng xác nhận đúng số gốc.`;
  }

  // Thu thập các dòng tên cơ quan STRICTLY phía trên dòng "Số:" (bỏ đường kẻ, dòng trống, quốc hiệu)
  const searchLimitIndex = firstSoIndex !== -1 ? firstSoIndex : leftTopLines.length;
  const rawAgencyLines: NormalizedLine[] = [];
  const textDividerYs: number[] = [];

  for (let i = 0; i < searchLimitIndex; i++) {
    const line = leftTopLines[i];
    if (line.isDivider) {
      textDividerYs.push(line.yCenter);
      continue;
    }
    if (docNumberSource === 'spatial_header' && headerSoLines.some((hl) => hl === line)) {
      break;
    }
    const cleanText = line.text
      .replace(/CỘNG\s+HÒA\s+XÃ\s+HỘI[\s\S]*/i, '')
      .replace(/Độc\s+lập\s*-\s*Tự\s+do[\s\S]*/i, '')
      .trim();
    if (!cleanText || countMeaningfulChars(cleanText) < 3) continue;
    const normClean = removeVietnameseDiacritics(cleanText);
    if (firstSoIndex === -1 && headerStopRegex.test(normClean)) break;
    if (/^(CONG HOA|DOC LAP|HANH PHUC|NGAY\b)/i.test(normClean)) continue;

    rawAgencyLines.push({
      ...line,
      text: cleanText,
    });
  }

  const allDividerYs = [...graphicDividerYs, ...textDividerYs].sort((a, b) => a - b);
  const hasDividerBetween = (yTop: number, yBottom: number) =>
    allDividerYs.some((dy) => dy > yTop + 0.001 && dy < yBottom - 0.001);

  let parentAgency = '';
  let parentUsedLines: NormalizedLine[] = [];
  let issuingAgency = '';
  let agencyUsedLines: NormalizedLine[] = [];
  let agencyNeedsReview = false;
  let agencyReviewReason = '';

  if (rawAgencyLines.length === 0) {
    issuingAgency = '';
    agencyNeedsReview = true;
    agencyReviewReason = 'Chưa nhận diện được khối tên cơ quan ban hành ở Vùng A (góc trên bên trái trang đầu).';
  } else if (rawAgencyLines.length === 1) {
    issuingAgency = rawAgencyLines[0].text;
    agencyUsedLines = [rawAgencyLines[0]];
  } else if (rawAgencyLines.length === 2) {
    const [line1, line2] = rawAgencyLines;
    const divider12 = hasDividerBetween(line1.yCenter, line2.yCenter);
    const wrapped12 = !divider12 && isWrappedAgencyContinuation(line1.text, line2.text);
    if (wrapped12) {
      issuingAgency = `${line1.text} ${line2.text}`.replace(/\s+/g, ' ').trim();
      agencyUsedLines = [line1, line2];
    } else {
      parentAgency = line1.text;
      parentUsedLines = [line1];
      issuingAgency = line2.text;
      agencyUsedLines = [line2];
    }
  } else if (rawAgencyLines.length === 3) {
    const [line1, line2, line3] = rawAgencyLines;
    const dividerBetween23 = hasDividerBetween(line2.yCenter, line3.yCenter);
    const dividerBetween12 = hasDividerBetween(line1.yCenter, line2.yCenter);

    const aligned23 = Math.abs(line2.xCenter - line3.xCenter) <= 0.065 || Math.abs(line2.x0 - line3.x0) <= 0.04;
    const aligned12 = Math.abs(line1.xCenter - line2.xCenter) <= 0.065 || Math.abs(line1.x0 - line2.x0) <= 0.04;

    const dy12 = Math.max(0.004, line2.yCenter - line1.yCenter);
    const dy23 = Math.max(0.004, line3.yCenter - line2.yCenter);

    const heightSimilar23 =
      Math.abs(line2.avgHeight - line3.avgHeight) / Math.max(line2.avgHeight, line3.avgHeight, 0.001) <= 0.30;
    const heightSimilar12 =
      Math.abs(line1.avgHeight - line2.avgHeight) / Math.max(line1.avgHeight, line2.avgHeight, 0.001) <= 0.30;
    const bothUpper23 = isMostlyUppercaseLine(line2.text) && isMostlyUppercaseLine(line3.text);
    const bothUpper12 = isMostlyUppercaseLine(line1.text) && isMostlyUppercaseLine(line2.text);

    const wrapped23 =
      !dividerBetween23 &&
      aligned23 &&
      heightSimilar23 &&
      bothUpper23 &&
      (isWrappedAgencyContinuation(line2.text, line3.text) ||
        (!dividerBetween12 && !startsWithAgencyNoun(line3.text) && dy23 <= dy12 * 1.25));
    const wrapped12 =
      !dividerBetween12 &&
      aligned12 &&
      heightSimilar12 &&
      bothUpper12 &&
      (isWrappedAgencyContinuation(line1.text, line2.text) ||
        (!startsWithAgencyNoun(line2.text) && dy12 * 1.25 < dy23));

    if (dividerBetween23) {
      parentAgency = line1.text;
      parentUsedLines = [line1];
      issuingAgency = line2.text;
      agencyUsedLines = [line2];
      agencyNeedsReview = true;
      agencyReviewReason =
        'Khối cơ quan ban hành có 3 dòng và có đường kẻ phân tách trước dòng thứ 3, vui lòng kiểm tra lại.';
    } else if (wrapped23 && !wrapped12) {
      parentAgency = line1.text;
      parentUsedLines = [line1];
      issuingAgency = `${line2.text} ${line3.text}`.replace(/\s+/g, ' ').trim();
      agencyUsedLines = [line2, line3];
    } else if (wrapped12 && !wrapped23) {
      parentAgency = `${line1.text} ${line2.text}`.replace(/\s+/g, ' ').trim();
      parentUsedLines = [line1, line2];
      issuingAgency = line3.text;
      agencyUsedLines = [line3];
    } else if (isWrappedAgencyContinuation(line1.text, line2.text) && isWrappedAgencyContinuation(line2.text, line3.text)) {
      issuingAgency = `${line1.text} ${line2.text} ${line3.text}`.replace(/\s+/g, ' ').trim();
      agencyUsedLines = [line1, line2, line3];
    } else {
      parentAgency = line1.text;
      parentUsedLines = [line1];
      issuingAgency = `${line2.text} ${line3.text}`.replace(/\s+/g, ' ').trim();
      agencyUsedLines = [line2, line3];
      agencyNeedsReview = true;
      agencyReviewReason =
        'Khối tên cơ quan ban hành có 3 dòng, vui lòng kiểm tra lại phần cơ quan chủ quản và cơ quan ban hành.';
    }
  } else {
    // >= 4 dòng: gom thành cụm theo khoảng cách hoặc từ khóa cơ quan
    const clusters: NormalizedLine[][] = [[rawAgencyLines[0]]];
    const gaps: number[] = [];
    for (let i = 1; i < rawAgencyLines.length; i++) {
      gaps.push(Math.max(0.002, rawAgencyLines[i].yCenter - rawAgencyLines[i - 1].yCenter));
    }
    const minGap = Math.min(...gaps);
    for (let i = 1; i < rawAgencyLines.length; i++) {
      const prev = rawAgencyLines[i - 1];
      const cur = rawAgencyLines[i];
      const gap = cur.yCenter - prev.yCenter;
      const newCluster =
        hasDividerBetween(prev.yCenter, cur.yCenter) ||
        startsWithAgencyNoun(cur.text) ||
        (gap > minGap * 1.45 && !isWrappedAgencyContinuation(prev.text, cur.text));
      if (newCluster) {
        clusters.push([cur]);
      } else {
        clusters[clusters.length - 1].push(cur);
      }
    }
    if (clusters.length === 2) {
      parentUsedLines = clusters[0];
      agencyUsedLines = clusters[1];
      parentAgency = parentUsedLines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
      issuingAgency = agencyUsedLines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
    } else if (clusters.length === 1) {
      agencyUsedLines = clusters[0];
      issuingAgency = agencyUsedLines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
    } else {
      parentUsedLines = clusters[0];
      agencyUsedLines = clusters.slice(1).flat();
      parentAgency = parentUsedLines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
      issuingAgency = agencyUsedLines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
      agencyNeedsReview = true;
      agencyReviewReason = `Khối tên cơ quan có ${rawAgencyLines.length} dòng phía trên dòng Số, vui lòng kiểm tra lại.`;
    }
  }

  return {
    parentAgency,
    parentAgencyBBox: unionLineBBoxes(parentUsedLines),
    issuingAgency,
    agencyBBox: unionLineBBoxes(agencyUsedLines),
    agencyNeedsReview,
    agencyReviewReason,
    docNumber,
    docNumberRawText: docNumberRawText || undefined,
    docNumberBBox: unionLineBBoxes(headerSoLines),
    docNumberSource,
    docNumberNeedsReview,
    docNumberReviewReason,
    topLeftHeaderDocNumbers: headerSoNumbers,
    soLineYCenter,
    rightTopText,
    leftTopText,
    splitX,
    skewSlope,
    skewDegrees,
    regionABBox: unionLineBBoxes(regionALinesForBBox),
    regionBBBox: unionLineBBoxes(regionBLinesForBBox),
  };
}

function extractIssuingAgencyFallback(page1Text: string): string {
  const lines = page1Text
    .split('\n')
    .slice(0, 12)
    .map((l) => l.trim())
    .filter(Boolean);

  const ignoreRegex = /^(CỘNG HÒA|ĐỘC LẬP|SỐ\s*:|S6\s*:|SO\s*:|NGÀY|V\/V|VỀ VIỆC|KÍNH GỬI)/i;
  const agencyLines: string[] = [];

  for (const line of lines) {
    if (isSoLabelLine(line)) break;
    if (ignoreRegex.test(line)) continue;
    const cleanPart = line
      .replace(/CỘNG\s+HÒA\s+XÃ\s+HỘI[\s\S]*/i, '')
      .replace(/Độc\s+lập\s*-\s*Tự\s+do[\s\S]*/i, '')
      .trim();
    if (cleanPart.length >= 4 && !isDividerLineText(cleanPart)) {
      agencyLines.push(cleanPart);
    }
    if (agencyLines.length >= 2) break;
  }

  if (agencyLines.length === 0) return '';
  if (agencyLines.length >= 2) return agencyLines[1];
  return agencyLines[0];
}

function capitalizeSentenceStart(str: string): string {
  const s = (str || '').trim();
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const CANONICAL_DOC_TYPES: Array<{ normKey: string; label: string; codePatterns: RegExp }> = [
  { normKey: 'KE HOACH', label: 'Kế hoạch', codePatterns: /\/KH(?:[\-\/]|$)/i },
  { normKey: 'QUYET DINH', label: 'Quyết định', codePatterns: /\/Q[ĐD](?:[\-\/]|$)/i },
  { normKey: 'THONG BAO', label: 'Thông báo', codePatterns: /\/TB(?:[\-\/]|$)/i },
  { normKey: 'BAO CAO', label: 'Báo cáo', codePatterns: /\/BC(?:[\-\/]|$)/i },
  { normKey: 'CHUONG TRINH', label: 'Chương trình', codePatterns: /\/CTr(?:[\-\/]|$)/i },
  { normKey: 'HUONG DAN', label: 'Hướng dẫn', codePatterns: /\/HD(?:[\-\/]|$)/i },
  { normKey: 'TO TRINH', label: 'Tờ trình', codePatterns: /\/TTr(?:[\-\/]|$)/i },
  { normKey: 'QUY CHE', label: 'Quy chế', codePatterns: /\/QC(?:[\-\/]|$)/i },
  { normKey: 'GIAY MOI', label: 'Giấy mời', codePatterns: /\/GM(?:[\-\/]|$)/i },
  { normKey: 'THU MOI', label: 'Thư mời', codePatterns: /\/TM(?:[\-\/]|$)/i },
  { normKey: 'NGHI QUYET', label: 'Nghị quyết', codePatterns: /\/NQ(?:[\-\/]|$)/i },
  { normKey: 'CHI THI', label: 'Chỉ thị', codePatterns: /\/CT(?:[\-\/]|$)/i },
  { normKey: 'CONG VAN', label: 'Công văn', codePatterns: /\/CV(?:[\-\/]|$)/i },
];

function resolveCanonicalDocType(rawHeading: string, docNumber?: string): string {
  const normHeading = removeVietnameseDiacritics((rawHeading || '').normalize('NFC'))
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  if (normHeading) {
    for (const item of CANONICAL_DOC_TYPES) {
      if (normHeading === item.normKey || normHeading.startsWith(`${item.normKey} `)) {
        return item.label;
      }
    }
  }
  if (docNumber) {
    const cleanNum = docNumber.normalize('NFC').trim();
    for (const item of CANONICAL_DOC_TYPES) {
      if (item.codePatterns.test(cleanNum)) {
        return item.label;
      }
    }
  }
  return '';
}

function isGenericBareDocName(name: string): boolean {
  const cleaned = removeVietnameseDiacritics((name || '').normalize('NFC'))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  if (!cleaned) return true;
  if (CANONICAL_DOC_TYPES.some((t) => t.normKey === cleaned)) return true;
  // Chỉ chứa loại văn bản + "V/V" hoặc "VE VIEC" mà không có chủ đề
  if (CANONICAL_DOC_TYPES.some((t) => cleaned === `${t.normKey} VE VIEC` || cleaned === `${t.normKey} V V`)) {
    return true;
  }
  return false;
}

function lowercaseInitialUnlessProper(phrase: string): string {
  const trimmed = (phrase || '').trim();
  if (!trimmed) return '';
  const firstWord = trimmed.split(/\s+/)[0] || '';
  // Giữ nguyên chữ viết hoa cho từ viết tắt (ASEAN, THPT, UBND, GDĐT, ĐTN, ISO...)
  const letters = firstWord.match(/\p{L}/gu) || [];
  if (letters.length >= 2 && letters.every((ch) => ch === ch.toUpperCase() && ch !== ch.toLowerCase())) {
    return trimmed;
  }
  // Giữ viết hoa nếu từ đầu là danh từ riêng phổ biến (Đảng, Đoàn, Việt, An, Hồ...)
  if (/^(?:Đảng|Đoàn|Việt|An|Hồ|Nguyễn|Sở|Bộ|UBND|HĐND|THPT|THCS|GDĐT)\b/u.test(trimmed)) {
    return trimmed;
  }
  return trimmed.charAt(0).toLocaleLowerCase('vi-VN') + trimmed.slice(1);
}

/**
 * Tạo Tên văn bản ngắn gọn từ loại văn bản + trích yếu gốc, giữ loại văn bản,
 * chủ đề cụ thể và các mốc thời gian cần thiết (vd 2026–2035, 2026–2030), tránh chỉ trả về
 * "KẾ HOẠCH", "QUYẾT ĐỊNH" hoặc "THÔNG BÁO".
 */
function generateConciseDocName(
  rawHeading: string,
  rawSubject: string,
  docNumber?: string
): string {
  const cleanHeading = (rawHeading || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  let subject = (rawSubject || '').normalize('NFC').replace(/\s+/g, ' ').trim();

  let typeLabel = resolveCanonicalDocType(cleanHeading, docNumber);

  // Nếu rawSubject bắt đầu bằng chính tên loại văn bản (vd "KẾ HOẠCH Thực hiện..."), tách phần đầu ra
  if (subject) {
    for (const item of CANONICAL_DOC_TYPES) {
      const rePrefix = new RegExp(
        `^${item.label.replace(/\s+/g, '\\s+')}\\b\\s*[:\\-–—]?\\s*`,
        'i'
      );
      const normSub = removeVietnameseDiacritics(subject);
      if (normSub.toUpperCase().startsWith(item.normKey)) {
        const wordsCount = item.normKey.split(' ').length;
        const subWords = subject.split(/\s+/);
        if (subWords.length > wordsCount) {
          const rest = subWords.slice(wordsCount).join(' ').replace(/^[:\-–—\s]+/, '').trim();
          if (rest) {
            if (!typeLabel) typeLabel = item.label;
            subject = rest;
            break;
          }
        }
      } else if (rePrefix.test(subject)) {
        const rest = subject.replace(rePrefix, '').trim();
        if (rest) {
          if (!typeLabel) typeLabel = item.label;
          subject = rest;
          break;
        }
      }
    }
  }

  // Bỏ tiền tố "V/v", "Về việc" ở đầu trích yếu để tên văn bản tự nhiên và gọn hơn
  subject = subject
    .replace(/^(?:[-•*]\s*)?(?:V\/v|V[ềe]\s+vi[ệe]c)\s*[:\-–—]?\s*/i, '')
    .trim();

  // Nếu tiêu đề lặp viện dẫn kiểu "Thực hiện Kế hoạch số .../KH-... ngày ... của ... về việc <chủ đề>"
  // thì rút về trực tiếp "<chủ đề>" nếu phần chủ đề phía sau đủ rõ (>= 15 ký tự)
  const citedWrapperMatch = subject.match(
    /^(?:Tri[ểe]n\s+khai\s+)?(?:Th[ựư]c\s+hi[ệe]n\s+)?(?:K[ếe]\s+ho[ạa]ch|C[ôo]ng\s+v[ăa]n|Quy[ếe]t\s+[đd][ịi]nh|Ch[ỉi]\s+th[ịi]|Ngh[ịi]\s+quy[ếe]t|H[ướư][ớo]ng\s+d[ẫa]n)\s+s[ốo]\s+[^\n]{4,140}?\s+(?:v[ềe]\s+vi[ệe]c|v[ềe]\s+tri[ểe]n\s+khai|v[ềe]\s+th[ựư]c\s+hi[ệe]n|v[ềe])\s+(.{15,})$/i
  );
  const hadCitedWrapper = Boolean(citedWrapperMatch && citedWrapperMatch[1]?.trim());
  if (citedWrapperMatch && citedWrapperMatch[1]?.trim()) {
    const inner = citedWrapperMatch[1].trim();
    subject = typeLabel === 'Kế hoạch' && !/^th[ựư]c\s+hi[ệe]n\b/i.test(inner)
      ? `thực hiện ${lowercaseInitialUnlessProper(inner)}`
      : inner;
  }

  const isVerboseAdministrativeSubject =
    hadCitedWrapper ||
    subject.length > 145 ||
    /\bgiai\s+[đd]o[ạa]n\s+\d{4}/i.test(subject) ||
    /^Tri[ểe]n\s+khai\s+th[ựư]c\s+hi[ệe]n\b/i.test(subject) ||
    /\bng[àa]nh\s+Gi[áa]o\s+d[ụu]c\s+v[àa]\s+[Đđ][àa]o\s+t[ạa]o\b/i.test(subject);

  if (isVerboseAdministrativeSubject) {
    // Rút gọn cụm từ hành chính dài nhưng giữ trọn chủ đề và mốc thời gian
    subject = subject
      .replace(/^Tri[ểe]n\s+khai\s+th[ựư]c\s+hi[ệe]n\b/i, 'thực hiện')
      .replace(/\bth[ựư]c\s+hi[ệe]n\s+Chi[ếe]n\s+l[ượư][ợo]c\b/g, 'thực hiện chiến lược')
      .replace(/\bgiai\s+[đd]o[ạa]n\s+(\d{4})\s*[-–—]\s*(\d{4})\b/gi, '$1–$2')
      .replace(/\bgiai\s+[đd]o[ạa]n\s+(\d{4})\s+[đd][ếe]n\s+(?:n[ăa]m\s+)?(\d{4})\b/gi, '$1–$2')
      .replace(/\bt[ừu]\s+n[ăa]m\s+(\d{4})\s+[đd][ếe]n\s+(?:n[ăa]m\s+)?(\d{4})\b/gi, '$1–$2')
      .replace(/\b(20\d{2}|19\d{2})\s*[-–—]\s*(20\d{2}|19\d{2})\b/g, '$1–$2')
      .replace(/\bng[àa]nh\s+Gi[áa]o\s+d[ụu]c\s+v[àa]\s+[Đđ][àa]o\s+t[ạa]o\s+t[ỉi]nh\s+An\s+Giang\b/gi, 'ngành GDĐT An Giang')
      .replace(/\bng[àa]nh\s+Gi[áa]o\s+d[ụu]c\s+v[àa]\s+[Đđ][àa]o\s+t[ạa]o\b/gi, 'ngành GDĐT')
      .replace(/\bS[ởo]\s+Gi[áa]o\s+d[ụu]c\s+v[àa]\s+[Đđ][àa]o\s+t[ạa]o\s+t[ỉi]nh\s+An\s+Giang\b/gi, 'Sở GDĐT An Giang')
      .replace(/\bS[ởo]\s+Gi[áa]o\s+d[ụu]c\s+v[àa]\s+[Đđ][àa]o\s+t[ạa]o\b/gi, 'Sở GDĐT')
      .replace(/\b[ỦU]y\s+ban\s+nh[âa]n\s+d[âa]n\b/gi, 'UBND')
      .replace(/\bTr[ườư][ờo]ng\s+Trung\s+h[ọo]c\s+ph[ổo]\s+th[ôo]ng\b/gi, 'Trường THPT')
      .replace(/\bTr[ườư][ờo]ng\s+Trung\s+h[ọo]c\s+c[ơo]\s+s[ởo]\b/gi, 'Trường THCS')
      .replace(/\bv[àa]\s+(?:[Đđ][ềe]\s+[áa]n|k[ếe]\s+ho[ạa]ch|c[ôo]ng\s+t[áa]c|ho[ạa]t\s+[đd][ộo]ng)\s+(truy[ềe]n\s+th[ôo]ng\b)/gi, 'và $1');
  }

  subject = subject
    .replace(/\s+/g, ' ')
    .replace(/[\s.;:,\-]+$/, '')
    .trim();

  if (!subject) {
    return typeLabel || cleanHeading;
  }

  // Nếu trích yếu gốc viết IN HOA toàn bộ, chuyển nhẹ về chữ thường phần nội dung (giữ chữ viết tắt)
  if (isMostlyUppercaseLine(subject) && subject.length >= 16) {
    subject = subject
      .split(/\s+/)
      .map((w, idx) => {
        if (/^(?:ASEAN|THPT|THCS|UBND|HĐND|GDĐT|SGDĐT|ĐTN|VN|CNTT|STEM|AI|ISO|PCCC|ATTP|ATGT|BHYT|BHXH)$/i.test(w)) {
          return w.toUpperCase();
        }
        if (idx === 0) {
          return w.charAt(0).toLocaleUpperCase('vi-VN') + w.slice(1).toLocaleLowerCase('vi-VN');
        }
        return w.toLocaleLowerCase('vi-VN');
      })
      .join(' ');
  }

  // Khi trích yếu dưới tiêu đề loại văn bản (vd KẾ HOẠCH) đã rõ ràng, tự nhiên và không quá dài (<= 145 ký tự),
  // giữ nguyên tên chủ đề cụ thể (Loại văn bản đã hiển thị riêng ở trường docType) trừ khi cần ghép tiền tố cho bản rút gọn hành chính dài.
  let result = '';
  if (isVerboseAdministrativeSubject && typeLabel && typeLabel !== 'Công văn') {
    const normType = removeVietnameseDiacritics(typeLabel).toLowerCase();
    const normSub = removeVietnameseDiacritics(subject).toLowerCase();
    if (normSub.startsWith(normType)) {
      result = capitalizeSentenceStart(subject);
    } else {
      result = `${typeLabel} ${lowercaseInitialUnlessProper(subject)}`;
    }
  } else {
    result = capitalizeSentenceStart(subject);
  }

  return result.replace(/\s+/g, ' ').trim();
}

function extractSubjectAndTitle(
  page1Boxes: NormalizedBox[],
  page1Text: string,
  page1DividerYs: number[] = [],
  splitX = 0.48,
  docNumber?: string,
  skewSlope = 0
): {
  docType: string;
  docTypeBBox?: NormalizedBBox;
  docName: string;
  title: string;
  hasVv: boolean;
  docNameBBox?: NormalizedBBox;
  titleBBox?: NormalizedBBox;
  titleTopY?: number;
} {
  const boxLines =
    page1Boxes.length > 0
      ? groupBoxesIntoLines(page1Boxes, skewSlope).filter((l) => !l.isDivider)
      : page1Text
          .normalize('NFC')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((text, idx) => ({
            text,
            x0: 0.1,
            x1: 0.9,
            xCenter: 0.5,
            y0: idx * 0.03,
            y1: idx * 0.03 + 0.02,
            yCenter: idx * 0.03 + 0.01,
            avgHeight: 0.015,
            fontNames: [],
            words: [],
            isDivider: false,
          }));

  const textDividerYs =
    page1Boxes.length > 0
      ? groupBoxesIntoLines(page1Boxes, skewSlope)
          .filter((l) => l.isDivider)
          .map((l) => l.yCenter)
      : [];
  const allDividerYs = [...page1DividerYs, ...textDividerYs].sort((a, b) => a - b);
  const hasDividerBetween = (yTop: number, yBottom: number) =>
    allDividerYs.some((dy) => dy > yTop + 0.002 && dy < yBottom - 0.002);

  // Xác định mốc bắt đầu phần nội dung viện dẫn / điều khoản để KHÔNG bao giờ ghép lẫn nội dung bên dưới
  const bodyStartRegex =
    /^(?:Can\s+cu\b|Kinh\s+gui\b|Dieu\s+\d+\b|I\.\s|II\.\s|1\.\s|Phan\s+[IVX0-9]+\b|Noi\s+nhan\b|Xet\s+de\s+nghi\b|Theo\s+de\s+nghi\b)/i;

  // 1. Ưu tiên nhận diện tiêu đề loại văn bản (KẾ HOẠCH, QUYẾT ĐỊNH, THÔNG BÁO, BÁO CÁO...) + toàn bộ dòng trích yếu bên dưới
  const headingKeywords =
    /^(KE HOACH|QUYET DINH|THONG BAO|BAO CAO|CHUONG TRINH|HUONG DAN|TO TRINH|QUY CHE|GIAY MOI|THU MOI|NGHI QUYET|CHI THI)\b(?!\s*:)/i;
  const subStopAfterFirstLineRegex =
    /^(?:Can\s+cu\b|Kinh\s+gui\b|Dieu\s+\d+\b|I\.\s|II\.\s|1\.\s|Phan\s+[IVX0-9]+\b|So\s*[:.;]|Noi\s+nhan\b|Xet\s+de\s+nghi\b|Theo\s+de\s+nghi\b|Ban\s+chap\s+hanh\b|Uy\s+ban\s+nhan\s+dan\b)/i;
  const authorityHeadingRegex =
    /^(?:GIAM DOC|PHO GIAM DOC|HIEU TRUONG|PHO HIEU TRUONG|CHU TICH|PHO CHU TICH|BAN GIAM HIEU|BAN THUONG VU|BAN CHAP HANH|UY BAN NHAN DAN|SO GIAO DUC)\b/i;

  for (let i = 0; i < boxLines.length; i++) {
    const curLine = boxLines[i];
    const normCur = removeVietnameseDiacritics(curLine.text);
    // Dừng nếu đã đi vào thân văn bản (Căn cứ / Kính gửi / Điều 1 / I.)
    if (curLine.yCenter >= 0.22 && bodyStartRegex.test(normCur)) break;
    // Bỏ qua vùng quá cao thuộc khối cơ quan/quốc hiệu
    if (curLine.yCenter < 0.13) continue;
    if (curLine.yCenter > 0.60) break;

    if (headingKeywords.test(normCur)) {
      const subParts: string[] = [];
      const subLines: NormalizedLine[] = [];
      for (let j = i + 1; j < Math.min(i + 11, boxLines.length); j++) {
        const cand = boxLines[j];
        const prev = boxLines[j - 1];
        const gap = cand.yCenter - prev.yCenter;
        const maxAllowedGap = subParts.length === 0 ? 0.085 : 0.044;
        if (gap > maxAllowedGap) break;
        if (subParts.length > 0 && hasDividerBetween(prev.yCenter, cand.yCenter)) break;

        const normSub = removeVietnameseDiacritics(cand.text);
        if (
          subStopAfterFirstLineRegex.test(normSub) ||
          isDividerLineText(cand.text) ||
          (subParts.length > 0 && (SIGNER_ROLE_REGEX.test(normSub) || (isMostlyUppercaseLine(cand.text) && authorityHeadingRegex.test(normSub))))
        ) {
          break;
        }
        if (
          subParts.length > 0 &&
          /\.\s+(?:So|UBND|Truong|Ban|Doan|Chi bo|Nay|De|Nh[aă]m)\b/i.test(normSub)
        ) {
          break;
        }
        subParts.push(cand.text);
        subLines.push(cand);
      }

      const headingWords = curLine.text.trim().split(/\s+/);
      const matchedType = resolveCanonicalDocType(curLine.text, docNumber);
      const docTypeUpper = matchedType
        ? matchedType.toLocaleUpperCase('vi-VN')
        : curLine.text.trim().toLocaleUpperCase('vi-VN');
      const typeWordCount = matchedType ? matchedType.split(/\s+/).length : 2;
      const inlineRest = headingWords.length > typeWordCount ? headingWords.slice(typeWordCount).join(' ').trim() : '';

      const subtitle = [inlineRest, ...subParts].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      const verbatimTitle = [curLine.text, ...subParts].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      const conciseDocName = generateConciseDocName(curLine.text, subtitle || verbatimTitle, docNumber);

      return {
        docType: docTypeUpper,
        docTypeBBox: unionLineBBoxes([curLine]),
        docName: conciseDocName || verbatimTitle,
        title: verbatimTitle,
        hasVv: false,
        docNameBBox: unionLineBBoxes(subLines.length > 0 ? subLines : [curLine]),
        titleBBox: unionLineBBoxes([curLine, ...subLines]),
        titleTopY: curLine.y0,
      };
    }
  }

  // 2. Công văn: ưu tiên nội dung sau "V/v" hoặc "Về việc" ở vùng đầu trang 1
  const leftColumnBoxes =
    page1Boxes.length > 0
      ? page1Boxes.filter((b) => (b.y0 + b.y1) / 2 <= 0.62 && b.x0 < splitX + 0.04)
      : [];
  const leftColumnLines =
    leftColumnBoxes.length > 0
      ? groupBoxesIntoLines(leftColumnBoxes, skewSlope).filter((l) => !l.isDivider)
      : [];
  const vvSearchSets = leftColumnLines.length > 0 ? [leftColumnLines, boxLines] : [boxLines];

  for (const lineSet of vvSearchSets) {
    for (let i = 0; i < lineSet.length; i++) {
      const cur = lineSet[i];
      if (cur.yCenter > 0.62) break;
      const normCur = removeVietnameseDiacritics(cur.text);
      if (cur.yCenter >= 0.25 && bodyStartRegex.test(normCur)) break;

      const vvMatch = cur.text.match(/^(?:[-•*]\s*)?(?:V\/v|V[ềe]\s+vi[ệe]c)\s*[:\-–—]?\s*(.*)$/i);
      if (vvMatch) {
        const parts: string[] = [];
        const usedTitleLines: NormalizedLine[] = [cur];
        const firstPart = (vvMatch[1] || '')
          .replace(/(?:An\s+Giang|Long\s+Xuy[êe]n|[A-ZÀ-Ỹ][^\n,]{2,25}),\s*ng[àa]y\s*\d{1,2}\s*th[áa]ng\s*\d{1,2}\s*n[ăa]m\s*\d{4}.*$/i, '')
          .trim();
        if (firstPart) parts.push(firstPart);

        for (let j = i + 1; j < Math.min(i + 7, lineSet.length); j++) {
          const nextLine = lineSet[j];
          const prevLine = lineSet[j - 1];
          if (nextLine.yCenter - prevLine.yCenter > 0.045) break;
          if (hasDividerBetween(prevLine.yCenter, nextLine.yCenter)) break;
          const normNext = removeVietnameseDiacritics(nextLine.text);
          if (
            /^(Kinh gui|Can cu|Thuc hien|Theo |I\.|1\.|Noi nhan|Doc lap|Dieu \d+|So\s*[:.;])/i.test(normNext) ||
            (/^[A-ZĐÂĂÊÔƠƯ\s]{8,}$/.test(nextLine.text) && nextLine.text.length >= 12)
          ) {
            break;
          }
          const cleanNext = nextLine.text
            .replace(/(?:An\s+Giang|Long\s+Xuy[êe]n|[A-ZÀ-Ỹ][^\n,]{2,25}),\s*ng[àa]y\s*\d{1,2}\s*th[áa]ng\s*\d{1,2}\s*n[ăa]m\s*\d{4}.*$/i, '')
            .trim();
          if (cleanNext) {
            parts.push(cleanNext);
            usedTitleLines.push(nextLine);
          }
        }

        const afterVv = capitalizeSentenceStart(parts.join(' ').replace(/\s+/g, ' ').trim());
        if (afterVv) {
          const prevHeading = i > 0 ? lineSet[i - 1] : null;
          const isHeading = prevHeading
            ? /^(KE HOACH|QUYET DINH|THONG BAO|BAO CAO|TO TRINH|CHUONG TRINH|HUONG DAN|GIAY MOI)$/i.test(
                removeVietnameseDiacritics(prevHeading.text)
              )
            : false;
          const docNameLines = isHeading && prevHeading ? [prevHeading, ...usedTitleLines] : usedTitleLines;
          const verbatimTitle =
            isHeading && prevHeading
              ? `${prevHeading.text} ${afterVv}`.replace(/\s+/g, ' ').trim()
              : afterVv;
          const conciseDocName = generateConciseDocName(
            isHeading && prevHeading ? prevHeading.text : '',
            afterVv,
            docNumber
          );
          const inferredType = resolveCanonicalDocType(
            isHeading && prevHeading ? prevHeading.text : '',
            docNumber
          );
          return {
            docType: (inferredType || 'Công văn').toLocaleUpperCase('vi-VN'),
            docTypeBBox: isHeading && prevHeading ? unionLineBBoxes([prevHeading]) : unionLineBBoxes([cur]),
            docName: conciseDocName || verbatimTitle,
            title: verbatimTitle,
            hasVv: true,
            docNameBBox: unionLineBBoxes(docNameLines),
            titleBBox: unionLineBBoxes(usedTitleLines),
            titleTopY: (isHeading && prevHeading ? prevHeading.y0 : cur.y0),
          };
        }
      }
    }
  }

  const fallbackType = resolveCanonicalDocType('', docNumber);
  return {
    docType: fallbackType ? fallbackType.toLocaleUpperCase('vi-VN') : '',
    docName: '',
    title: '',
    hasVv: false,
  };
}

function isAppendixPage(text: string): boolean {
  if (!text) return false;
  const topLines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 8);

  for (let i = 0; i < topLines.length; i++) {
    const line = removeVietnameseDiacritics(topLines[i]);
    if (
      /^(?:PHU\s*LUC(?:\s*[IVXLCDM0-9]+|\b)|THE\s*LE(?:\b|\s+CUOC\s+THI)|QUY\s*CHE\s*(?:KEM\s*THEO|DINH\s*KEM)|DANH\s*SACH\s*KEM\s*THEO|BANG\s*(?:KEM\s*THEO|PHAN\s*CONG|TONG\s*HOP|DU\s*TOAN|THEO\s*DOI)|BIEU\s*MAU|MAU\s*SO)\b/i.test(
        line
      )
    ) {
      return true;
    }
    if (
      i < 5 &&
      /^\(?\s*(?:Ban\s+hanh\s+)?kem\s+theo\s+(?:Cong\s+van|Quyet\s+dinh|Ke\s+hoach|Thong\s+bao|To\s+trinh|Huong\s+dan|Chuong\s+trinh)\b/i.test(
        line
      )
    ) {
      return true;
    }
  }
  return false;
}

const DELEGATION_PREFIX_REGEX = /^(?:KT\.|TM\.|Q\.|TL\.|TUQ\.)(?:\s|$)/i;

const CONCRETE_ROLE_REGEX =
  /^(?:GIAM DOC|PHO GIAM DOC|CHU TICH|PHO CHU TICH|HIEU TRUONG|PHO HIEU TRUONG|BI THU|PHO BI THU|TRUONG PHONG|PHO TRUONG PHONG|CHANH VAN PHONG|PHO CHANH VAN PHONG|TRUONG BAN|PHO TRUONG BAN|THU TRUONG|CUC TRUONG|PHO CUC TRUONG|VU TRUONG|CHU NHIEM|PHO CHU NHIEM|BO TRUONG|THU TUONG|PHO THU TUONG|QUYEN HIEU TRUONG|QUYEN GIAM DOC|TONG BIEN TAP|PHO TONG BIEN TAP|UY VIEN)/i;

const SIGNER_ROLE_REGEX =
  /^(?:KT\.|TM\.|Q\.|TL\.|TUQ\.|GIAM DOC|PHO GIAM DOC|CHU TICH|PHO CHU TICH|HIEU TRUONG|PHO HIEU TRUONG|BI THU|PHO BI THU|TRUONG PHONG|PHO TRUONG PHONG|CHANH VAN PHONG|PHO CHANH VAN PHONG|TRUONG BAN|PHO TRUONG BAN|THU TRUONG|CUC TRUONG|PHO CUC TRUONG|VU TRUONG|CHU NHIEM|PHO CHU NHIEM|BO TRUONG|THU TUONG|PHO THU TUONG|QUYEN HIEU TRUONG|QUYEN GIAM DOC|TONG BIEN TAP|PHO TONG BIEN TAP|UY VIEN)/i;

const NON_NAME_LINE_REGEX =
  /^(CONG HOA|DOC LAP|HANH PHUC|CHU NGHIA|VIET NAM|NOI NHAN|DA KY|SO GIAO DUC|UY BAN NHAN DAN|THANH PHO|TINH |TRUONG THPT|DOAN TRUONG|PHONG GIAO DUC|BO GIAO DUC|PHU LUC|THE LE|KT\.|TM\.|TL\.|TUQ\.|Q\.|BAN GIAM HIEU|BAN TO CHUC|KE HOACH|QUYET DINH|THONG BAO|BAO CAO|CHUONG TRINH|CONG VAN|DINH KEM|BAN HANH|VAN BAN|LUU|KINH GUI)/i;

const SKIP_SIG_LINE_REGEX =
  /^(Noi nhan|Luu|-\s*Nhu tren|Kinh gui|Ngay ky|Thoi gian ky|Ky boi|\(?Da ky\)?|\(?Ky,?\s*(?:ghi ro ho ten|dong dau|ten).*?\)?)/i;

const DIGITAL_SIG_NOISE_REGEX =
  /(?:smartca|vnpt|viettel[\-\s]?ca|bkav|newca|trustca|\bca2\b|fpt[\-\s]?ca|safe[\-\s]?ca|efy[\-\s]?ca|itext|itextsharp|adobe|acrobat|foxit|signature\s+valid|digitally\s+signed|signed\s+by\s+system|certificate|serial(?:\s*number)?|issuer|timestamp|revocation|valid\s+from|chung\s+thu\s+so|to\s+chuc\s+cap|phan\s+mem\s+ky|chu\s+ky\s+so\s+hop\s+le|\bCN\s*=|\bO\s*=|\bOU\s*=|\bC\s*=\s*VN\b)/i;

function isDigitalSignatureNoise(rawLine: string): boolean {
  const s = (rawLine || '').trim();
  if (!s) return true;
  const norm = removeVietnameseDiacritics(s);
  if (DIGITAL_SIG_NOISE_REGEX.test(norm)) return true;
  // Chuỗi phiên bản phần mềm (vd 5.5.13, v2.1.0) hoặc OID kỹ thuật
  if (/\bv?\d+\.\d+\.\d+(?:\.\d+)?\b/i.test(s)) return true;
  if (/\b1\.\d+\.\d+\.\d+\b/.test(s)) return true;
  return false;
}

function cleanOcrStampNoiseFromName(rawLine: string): string {
  return (rawLine || '')
    .replace(/^[\s\-–—•*·|~`'":;.,()\[\]{}\/\\0-9]+/, '')
    .replace(/[\s\-–—•*·|~`'":;.,()\[\]{}\/\\0-9]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyVietnamesePersonName(cand: string): boolean {
  const s = (cand || '').trim();
  if (!s || s.length < 4 || s.length > 60) return false;
  if (/\d/.test(s)) return false;
  if (isDigitalSignatureNoise(s)) return false;

  const norm = removeVietnameseDiacritics(s);
  if (
    DELEGATION_PREFIX_REGEX.test(norm) ||
    SIGNER_ROLE_REGEX.test(norm) ||
    NON_NAME_LINE_REGEX.test(norm) ||
    SKIP_SIG_LINE_REGEX.test(norm)
  ) {
    return false;
  }

  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;

  // Cho phép cả Title Case ("Huỳnh Văn Hóa") lẫn IN HOA toàn bộ ("HUỲNH VĂN HÓA")
  const allWordsCapitalized = words.every((w) => /^[\p{Lu}][\p{L}]{0,18}$/u.test(w));
  if (!allWordsCapitalized) return false;

  // Nếu dòng IN HOA toàn bộ, loại trừ các cụm hành chính thường đứng gần khối ký
  if (isMostlyUppercaseLine(s)) {
    if (
      /\b(?:CONG HOA|XA HOI|DOC LAP|HANH PHUC|GIAO DUC|DAO TAO|TRUONG|SO |PHONG |BAN |UBND|BO |CHI BO|DOAN|TINH |HUYEN|THANH PHO|QUYET DINH|THONG BAO|KE HOACH|PHU LUC)\b/i.test(
        norm
      )
    ) {
      return false;
    }
  }
  return true;
}

function chooseBestSignerRole(roleLines: string[]): string {
  const cleaned = roleLines.map((r) => r.trim()).filter(Boolean);
  if (cleaned.length === 0) return '';
  // Ưu tiên chức vụ cụ thể (vd "PHÓ GIÁM ĐỐC") thay vì dòng ủy quyền ("KT. GIÁM ĐỐC")
  const concrete = cleaned.filter((r) => {
    const norm = removeVietnameseDiacritics(r);
    return !DELEGATION_PREFIX_REGEX.test(norm) && CONCRETE_ROLE_REGEX.test(norm);
  });
  if (concrete.length > 0) {
    return concrete[concrete.length - 1];
  }
  return cleaned.join(' - ');
}

function extractSignersFromZoneText(
  zoneText: string,
  pageNumber: number
): Array<{ name: string; role: string; page: number }> {
  const found: Array<{ name: string; role: string; page: number }> = [];
  if (!zoneText) return found;

  // 1. Mẫu chức vụ + tên người ký ở vùng chữ ký hiển thị trên trang PDF (ưu tiên hơn text chữ ký số)
  const lines = zoneText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    if (isDigitalSignatureNoise(lines[i])) continue;
    const normLine = removeVietnameseDiacritics(lines[i]);
    if (SIGNER_ROLE_REGEX.test(normLine)) {
      const roleParts = [lines[i]];
      let nameLine = '';
      for (let j = i + 1; j < Math.min(i + 16, lines.length); j++) {
        const rawL = lines[j];
        if (isDigitalSignatureNoise(rawL)) continue;
        const l = cleanOcrStampNoiseFromName(rawL);
        if (!l || isDigitalSignatureNoise(l)) continue;
        const normL = removeVietnameseDiacritics(l);
        if (SKIP_SIG_LINE_REGEX.test(normL)) {
          continue;
        }
        if (SIGNER_ROLE_REGEX.test(normL) && j <= i + 3) {
          roleParts.push(l);
          continue;
        }
        if (isLikelyVietnamesePersonName(l)) {
          nameLine = l;
          break;
        }
      }
      if (nameLine) {
        found.push({
          name: nameLine,
          role: chooseBestSignerRole(roleParts),
          page: pageNumber,
        });
      }
    }
  }

  // 2. Mẫu nhãn tường minh ("Ký bởi: Nguyễn Văn A", "Người ký: ...", "Signed by: ...") - lọc bỏ CA/phần mềm
  const digitalMatches = zoneText.matchAll(
    /(?:K[ýy]\s+b[ởơ]i|Ng[ườờ]i\s+k[ýy]|Signed\s+by)\s*[:\-]\s*([^\n,;]{3,70})/gi
  );
  for (const dm of digitalMatches) {
    const rawSeg = dm[1]
      .replace(/\([^)]*\)/g, '')
      .replace(/(?:Ng[àa]y\s+k[ýy]|Time|Date|Serial).*$/i, '')
      .trim();
    const candName = cleanOcrStampNoiseFromName(rawSeg);
    if (
      candName.length >= 4 &&
      isLikelyVietnamesePersonName(candName) &&
      !found.some((f) => f.name.toLowerCase() === candName.toLowerCase())
    ) {
      found.push({ name: candName, role: '', page: pageNumber });
    }
  }

  return found;
}

interface SignatureZonePage {
  pageNumber: number;
  rightBottomText: string;
  rightHalfText: string;
  bottomText: string;
  fullText: string;
  annotationText: string;
}

function extractSignerInfo(
  signaturePages: SignatureZonePage[],
  rawSigSigners: string[]
): {
  signer: string;
  signerRole: string;
  signerCandidates: string[];
  signaturePage: number;
} {
  const candidates: Array<{ name: string; role: string; page: number }> = [];

  for (const p of signaturePages) {
    // Ưu tiên các vùng chữ ký hiển thị trên trang TRƯỚC; KHÔNG trộn annotation chữ ký số vào trước khi đọc chữ ký hiển thị
    const zones = [p.rightBottomText, p.rightHalfText, p.bottomText, p.fullText].filter(
      (z) => z && z.trim().length > 0
    );

    let pageCandidates: Array<{ name: string; role: string; page: number }> = [];
    for (const zone of zones) {
      const matches = extractSignersFromZoneText(zone, p.pageNumber);
      if (matches.length > 0) {
        pageCandidates = matches;
        break;
      }
    }

    // Chỉ dùng annotationText làm nguồn phụ khi vùng hiển thị trên trang không có tên người ký hợp lệ
    if (pageCandidates.length === 0 && p.annotationText) {
      const cleanAnnotLines = p.annotationText
        .split('\n')
        .filter((l) => !isDigitalSignatureNoise(l))
        .join('\n');
      if (cleanAnnotLines) {
        pageCandidates = extractSignersFromZoneText(cleanAnnotLines, p.pageNumber);
      }
    }

    if (pageCandidates.length > 0) {
      candidates.push(...pageCandidates);
      // Khi đã tìm thấy khối chữ ký ở trang chính gần cuối nhất (trước phụ lục), dừng lùi về các trang trước
      break;
    }
  }

  for (const rs of rawSigSigners) {
    let cleanRs = rs.trim();
    const cnMatch = cleanRs.match(/CN=([^,\/]+)/i);
    if (cnMatch) cleanRs = cnMatch[1].trim();
    cleanRs = cleanOcrStampNoiseFromName(cleanRs);
    if (
      cleanRs &&
      isLikelyVietnamesePersonName(cleanRs) &&
      !candidates.some((c) => c.name.toLowerCase() === cleanRs.toLowerCase())
    ) {
      candidates.push({
        name: cleanRs,
        role: '',
        page: signaturePages[0]?.pageNumber || 1,
      });
    }
  }

  // Khử trùng giữ thứ tự và loại bỏ hoàn toàn các tên nhiễu CA/phần mềm nếu còn sót
  const filteredCandidates = candidates.filter((c) => !isDigitalSignatureNoise(c.name));
  const uniqueNames: string[] = [];
  for (const c of filteredCandidates) {
    if (!uniqueNames.some((n) => n.toLowerCase() === c.name.toLowerCase())) {
      uniqueNames.push(c.name);
    }
  }

  const primary = filteredCandidates[0];
  return {
    signer: primary?.name || '',
    signerRole: primary?.role || '',
    signerCandidates: uniqueNames,
    signaturePage: primary?.page || signaturePages[0]?.pageNumber || 1,
  };
}

export async function extractPdfPageContentsForIndex(buffer: Buffer): Promise<{
  pageTexts: PdfPageContent[];
}> {
  const { pageCount, pages } = await extractPdfTextWithPdfJs(buffer);
  const pageTextByNum = new Map<number, string>();
  const ocrPages: number[] = [];

  for (const p of pages) {
    pageTextByNum.set(p.pageNumber, p.fullText);
    if (isGarbledText(p.fullText) && ocrPages.length < 10) {
      ocrPages.push(p.pageNumber);
    }
  }

  if (ocrPages.length > 0) {
    try {
      const ocrRun = await runVietnameseOcrOnPages(buffer, ocrPages);
      for (const [pNum, ocrRes] of ocrRun.results.entries()) {
        const existing = pageTextByNum.get(pNum) || '';
        if (countMeaningfulChars(ocrRes.text) > countMeaningfulChars(existing) || isGarbledText(existing)) {
          pageTextByNum.set(pNum, ocrRes.text);
        }
      }
    } catch {
      // ignore OCR failure during background indexing
    }
  }

  const pageTexts: PdfPageContent[] = [];
  for (let p = 1; p <= pageCount; p++) {
    pageTexts.push({
      page: p,
      text: (pageTextByNum.get(p) || '').trim(),
    });
  }

  return {
    pageTexts,
  };
}

interface GeminiExtractedMetadata {
  docNumber?: string;
  docType?: string;
  parentAgency?: string;
  issuingAgency?: string;
  docName?: string;
  title?: string;
  topRightDate?: string;
  signatureDate?: string;
  signer?: string;
  signerRole?: string;
  docNumberBox?: number[]; // [ymin, xmin, ymax, xmax] chuẩn 0..1000
  topRightDateBox?: number[]; // [ymin, xmin, ymax, xmax] chuẩn 0..1000
}

function parseGeminiBox1000(box?: number[]): NormalizedBBox | undefined {
  if (!Array.isArray(box) || box.length !== 4) return undefined;
  const [ymin, xmin, ymax, xmax] = box.map((v) => Number(v));
  if (![ymin, xmin, ymax, xmax].every((n) => Number.isFinite(n))) return undefined;
  const y0 = clamp01(ymin / 1000);
  const x0 = clamp01(xmin / 1000);
  const y1 = clamp01(ymax / 1000);
  const x1 = clamp01(xmax / 1000);
  if (x1 <= x0 + 0.005 || y1 <= y0 + 0.005) return undefined;
  return { x0, y0, x1, y1 };
}

async function extractMetadataWithGemini(params: {
  pdfBuffer: Buffer;
  regionAText: string;
  regionBText: string;
  page1Text: string;
  signaturePageText: string;
  signaturePageNumber: number;
  pageCount: number;
}): Promise<GeminiExtractedMetadata | null> {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return null;

  try {
    const { GoogleGenAI, Type } = await import('@google/genai');
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const parts: any[] = [];
    if (params.pdfBuffer.length <= 8 * 1024 * 1024) {
      parts.push({
        inlineData: {
          mimeType: 'application/pdf',
          data: params.pdfBuffer.toString('base64'),
        },
      });
    }

    const promptText = [
      'Bạn là hệ thống trích xuất thông tin văn bản hành chính Việt Nam dựa theo VỊ TRÍ BỐ CỤC THỰC TẾ trên trang đầu (Trang 1).',
      'PHẢI tách bạch hai vùng độc lập ở đầu Trang 1 và KHÔNG trộn dữ liệu giữa hai vùng:',
      '- VÙNG A (Phía trên bên trái): Cơ quan chủ quản (parentAgency), Cơ quan ban hành (issuingAgency), dòng "Số:" và Số/ký hiệu văn bản (docNumber).',
      '- VÙNG B (Phía trên bên phải): Quốc hiệu ("CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM"), Tiêu ngữ ("Độc lập - Tự do - Hạnh phúc"), Địa danh và Ngày/tháng/năm ban hành (topRightDate).',
      '',
      'QUY TẮC BẮT BUỘC:',
      '1. docNumber: CHỈ lấy số/ký hiệu ở dòng "Số:" tại VÙNG A (dưới tên cơ quan ban hành, trên tiêu đề loại văn bản). Chuẩn hóa khoảng trắng quanh "/" và "-" (vd "Số:8773  /KH-SGDĐT" -> "8773/KH-SGDĐT"), giữ nguyên số 0 đầu (vd "05/TB-ĐTN") và giữ đúng chữ tiếng Việt gốc (không đổi SGDĐT thành SGDDT). TUYỆT ĐỐI KHÔNG lấy số văn bản viện dẫn trong phần "Căn cứ", nội dung hay phụ lục. Nếu không có hoặc không chắc chắn, trả về "".',
      '2. parentAgency & issuingAgency: Lấy từ VÙNG A phía trên dòng Số. Nếu có 2 cấp (vd UBND TỈNH AN GIANG / SỞ GIÁO DỤC VÀ ĐÀO TẠO), đưa cấp trên vào parentAgency, cơ quan ban hành vào issuingAgency. Ghép các dòng xuống hàng cùng một tên cơ quan.',
      '3. topRightDate: CHỈ lấy ngày ban hành tại VÙNG B ngay dưới Tiêu ngữ (thường ngang hàng với dòng "Số:"). Hỗ trợ cả chữ in nghiêng, viết bằng chữ tiếng Việt hoặc dạng dd/MM/yyyy; chuẩn hóa thành dd/MM/yyyy. TUYỆT ĐỐI KHÔNG lấy ngày trong "Căn cứ", thân văn bản, phụ lục, ngày chữ ký số, ngày tải tệp hay ngày hiện tại. Nếu Vùng B không có ngày ban hành rõ ràng, PHẢI trả về "".',
      '4. docType: Loại văn bản viết IN HOA rõ ràng (vd: "KẾ HOẠCH", "QUYẾT ĐỊNH", "THÔNG BÁO", "BÁO CÁO", "CÔNG VĂN", "TỜ TRÌNH", "HƯỚNG DẪN").',
      '5. title & docName:',
      '   - title: Nguyên văn tiêu đề + đầy đủ các dòng trích yếu bên dưới trên Trang 1 (không ghép lẫn "Căn cứ...", "Kính gửi...", "I.", "1.", "Điều 1").',
      '   - docName: Tên văn bản cụ thể tạo từ trích yếu gốc (giữ chủ đề rõ ràng và mốc thời gian). Nếu là Kế hoạch/Quyết định/Thông báo có dòng trích yếu trực tiếp gọn rõ (<= 145 ký tự), giữ nguyên nội dung chủ đề rõ ràng. TUYỆT ĐỐI không chỉ trả về "KẾ HOẠCH" hay "QUYẾT ĐỊNH".',
      '6. signatureDate: CHỈ lấy dòng ngày in trong nội dung văn bản gần khối chữ ký cuối văn bản chính (bỏ phụ lục). TUYỆT ĐỐI KHÔNG lấy thời điểm chữ ký số ("Ký bởi", "Ngày ký:", "Thời gian ký:", "Signed on", "Signature Valid") hay sao chép từ topRightDate. Nếu không có dòng ngày in riêng ở cuối văn bản, PHẢI trả về "".',
      '7. signer & signerRole: Họ tên người ký và chức vụ thực tế ở khối chữ ký cuối văn bản chính.',
      '8. docNumberBox & topRightDateBox: Tọa độ bounding box gần đúng trên Trang 1 dạng [ymin, xmin, ymax, xmax] theo thang 0..1000 nếu nhìn thấy rõ (để trống nếu không chắc).',
      'KHÔNG ĐƯỢC SUY ĐOÁN HOẶC BỊA RA SỐ/NGÀY KHÔNG CÓ TRÊN VĂN BẢN.',
      '',
      `Tổng số trang PDF: ${params.pageCount}. Trang chữ ký chính ước tính: ${params.signaturePageNumber}.`,
      params.regionAText ? `=== VÙNG A (Phía trên bên trái Trang 1) ===\n${params.regionAText.slice(0, 1200)}` : '',
      params.regionBText ? `=== VÙNG B (Phía trên bên phải Trang 1) ===\n${params.regionBText.slice(0, 1200)}` : '',
      params.page1Text ? `=== Toàn bộ văn bản Trang 1 ===\n${params.page1Text.slice(0, 3200)}` : '',
      params.signaturePageText && params.signaturePageNumber > 1
        ? `=== Văn bản Trang ${params.signaturePageNumber} (Chữ ký) ===\n${params.signaturePageText.slice(0, 2800)}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    parts.push({ text: promptText });

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: [{ role: 'user', parts }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            docNumber: { type: Type.STRING },
            docType: { type: Type.STRING },
            parentAgency: { type: Type.STRING },
            issuingAgency: { type: Type.STRING },
            docName: { type: Type.STRING },
            title: { type: Type.STRING },
            topRightDate: { type: Type.STRING },
            signatureDate: { type: Type.STRING },
            signer: { type: Type.STRING },
            signerRole: { type: Type.STRING },
            docNumberBox: { type: Type.ARRAY, items: { type: Type.NUMBER } },
            topRightDateBox: { type: Type.ARRAY, items: { type: Type.NUMBER } },
          },
        },
      },
    });

    const rawText = (response.text || '').trim();
    if (!rawText) return null;
    const parsed = JSON.parse(rawText);
    return parsed && typeof parsed === 'object' ? (parsed as GeminiExtractedMetadata) : null;
  } catch (err: any) {
    console.warn('[PDF Gemini] Không dùng được Gemini fallback/assist, tiếp tục với kết quả phân tích bố cục + OCR:', err?.message);
    return null;
  }
}

interface DualRegion300DpiResult {
  regionAText: string;
  regionABoxes: NormalizedBox[];
  regionBText: string;
  regionBBoxes: NormalizedBox[];
  visionDocNumber?: string;
  visionTopRightDate?: string;
}

/**
 * Lớp 2 nâng cao: Render trang 1 ở 300 DPI và cắt độc lập VÙNG A (trên trái) & VÙNG B (trên phải)
 * để OCR tiếng Việt độ nét cao (và tùy chọn Vision AI), giữ nguyên tọa độ chuẩn hóa 0..1 trên trang gốc.
 */
async function runDualRegionHeader300DpiFallback(
  buffer: Buffer,
  options: { needRegionA: boolean; needRegionB: boolean; splitX?: number; titleTopY?: number }
): Promise<DualRegion300DpiResult> {
  const splitX = options.splitX && options.splitX >= 0.30 && options.splitX <= 0.65 ? options.splitX : 0.48;
  const regAW = Math.min(0.60, Math.max(0.50, splitX + 0.08));
  const boundedHeaderH =
    options.titleTopY && options.titleTopY >= 0.14 && options.titleTopY <= 0.36
      ? Math.min(0.32, Math.max(0.18, options.titleTopY - 0.005))
      : 0.28;
  const regAH = boundedHeaderH;
  const regBX0 = Math.max(0.34, Math.min(0.46, splitX - 0.06));
  const regBW = Math.min(1 - regBX0, 1 - regBX0);
  const regBH = boundedHeaderH;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nct-hdr-ocr-'));
  const pdfPath = path.join(tmpDir, 'input.pdf');
  const pagePng = path.join(tmpDir, 'page1-300.png');
  const cropAPng = path.join(tmpDir, 'page1-region-a.png');
  const cropBPng = path.join(tmpDir, 'page1-region-b.png');
  fs.writeFileSync(pdfPath, buffer);

  let regionAText = '';
  let regionABoxes: NormalizedBox[] = [];
  let regionBText = '';
  let regionBBoxes: NormalizedBox[] = [];
  let visionDocNumber = '';
  let visionTopRightDate = '';

  try {
    await renderPdfPageToPng(pdfPath, 1, pagePng, 300);
    if (fs.existsSync(pagePng)) {
      const cropAMeta = options.needRegionA
        ? cropRgbPngRegion(pagePng, cropAPng, 0, 0, regAW, regAH, false)
        : null;
      const cropBMeta = options.needRegionB
        ? cropRgbPngRegion(pagePng, cropBPng, regBX0, 0, 1, regBH, false)
        : null;

      try {
        await withVietnameseOcrWorker(async (worker) => {
          if (options.needRegionA) {
            const imgA = cropAMeta && fs.existsSync(cropAPng) ? cropAPng : pagePng;
            const scaleAX = cropAMeta ? regAW : 1;
            const scaleAY = cropAMeta ? regAH : 1;
            try {
              const runRegionAOcr = async (imgPath: string) => {
                const dims = getPngDimensions(imgPath);
                const ret = await worker.recognize(imgPath, {}, { blocks: true });
                const rawBoxes = extractBoxesFromTesseractData(ret?.data, dims.width, dims.height);
                const mapped = rawBoxes.map((b) => ({
                  ...b,
                  x0: clamp01(b.x0 * scaleAX),
                  x1: clamp01(b.x1 * scaleAX),
                  y0: clamp01(b.y0 * scaleAY),
                  y1: clamp01(b.y1 * scaleAY),
                  height: b.height * scaleAY,
                }));
                const skewA = estimateHeaderSkewSlope(mapped);
                const txt = (mapped.length > 0 ? boxesToText(mapped, skewA) : ret?.data?.text || '').trim();
                return { boxes: mapped, text: txt };
              };

              const pass1 = await runRegionAOcr(imgA);
              regionABoxes = pass1.boxes;
              regionAText = pass1.text;

              const pass1Header = analyzeTopLeftHeader(pass1.boxes, []);
              if (isIncompleteOrSuspiciousDocNumber(pass1Header.docNumber).suspicious) {
                const cropAInkPng = path.join(tmpDir, 'page1-region-a-ink.png');
                const inkMeta = cropRgbPngRegion(pagePng, cropAInkPng, 0, 0, regAW, regAH, true);
                if (inkMeta && fs.existsSync(cropAInkPng)) {
                  const pass2 = await runRegionAOcr(cropAInkPng);
                  const pass2Header = analyzeTopLeftHeader(pass2.boxes, []);
                  if (!isIncompleteOrSuspiciousDocNumber(pass2Header.docNumber).suspicious) {
                    regionABoxes = pass2.boxes;
                    regionAText = pass2.text;
                  } else if (pass2.text) {
                    regionAText = [regionAText, pass2.text].filter(Boolean).join('\n');
                  }
                }
              }
            } catch (ocrErr: any) {
              console.warn('[PDF 300DPI Header OCR] Lỗi OCR Vùng A:', ocrErr?.message);
            }
          }

          if (options.needRegionB) {
            const imgB = cropBMeta && fs.existsSync(cropBPng) ? cropBPng : pagePng;
            const offsetBX = cropBMeta ? regBX0 : 0;
            const scaleBX = cropBMeta ? 1 - regBX0 : 1;
            const scaleBY = cropBMeta ? regBH : 1;
            try {
              const runRegionBOcr = async (imgPath: string) => {
                const dims = getPngDimensions(imgPath);
                const ret = await worker.recognize(imgPath, {}, { blocks: true });
                const rawBoxes = extractBoxesFromTesseractData(ret?.data, dims.width, dims.height);
                const mapped = rawBoxes.map((b) => ({
                  ...b,
                  x0: clamp01(offsetBX + b.x0 * scaleBX),
                  x1: clamp01(offsetBX + b.x1 * scaleBX),
                  y0: clamp01(b.y0 * scaleBY),
                  y1: clamp01(b.y1 * scaleBY),
                  height: b.height * scaleBY,
                }));
                const skewB = estimateHeaderSkewSlope(mapped);
                const txt = (mapped.length > 0 ? boxesToText(mapped, skewB) : ret?.data?.text || '').trim();
                return { boxes: mapped, text: txt };
              };

              const pass1B = await runRegionBOcr(imgB);
              regionBBoxes = pass1B.boxes;
              regionBText = pass1B.text;

              const pass1Date = extractTopRightHeaderDate(pass1B.boxes, pass1B.text, 0.30, {
                skewSlope: estimateHeaderSkewSlope(pass1B.boxes),
              });
              if (!pass1Date.primary) {
                const cropBInkPng = path.join(tmpDir, 'page1-region-b-ink.png');
                const inkBMeta = cropRgbPngRegion(pagePng, cropBInkPng, regBX0, 0, 1, regBH, true);
                if (inkBMeta && fs.existsSync(cropBInkPng)) {
                  const pass2B = await runRegionBOcr(cropBInkPng);
                  const pass2Date = extractTopRightHeaderDate(pass2B.boxes, pass2B.text, 0.30, {
                    skewSlope: estimateHeaderSkewSlope(pass2B.boxes),
                  });
                  if (pass2Date.primary) {
                    regionBBoxes = pass2B.boxes;
                    regionBText = pass2B.text;
                  } else if (pass2B.text) {
                    regionBText = [regionBText, pass2B.text].filter(Boolean).join('\n');
                  }
                }
              }
            } catch (ocrErr: any) {
              console.warn('[PDF 300DPI Header OCR] Lỗi OCR Vùng B:', ocrErr?.message);
            }
          }
        });
      } catch (wErr: any) {
        console.warn('[PDF 300DPI Header OCR] Không khởi tạo được Tesseract worker:', wErr?.message);
      }

      const apiKey = (process.env.GEMINI_API_KEY || '').trim();
      if (apiKey) {
        try {
          const { GoogleGenAI, Type } = await import('@google/genai');
          const ai = new GoogleGenAI({
            apiKey,
            httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
          });

          const visionParts: any[] = [];
          if (options.needRegionA && fs.existsSync(cropAPng)) {
            visionParts.push({
              inlineData: { mimeType: 'image/png', data: fs.readFileSync(cropAPng).toString('base64') },
            });
          }
          if (options.needRegionB && fs.existsSync(cropBPng)) {
            visionParts.push({
              inlineData: { mimeType: 'image/png', data: fs.readFileSync(cropBPng).toString('base64') },
            });
          }
          if (visionParts.length > 0) {
            visionParts.push({
              text: [
                'Đọc chính xác thông tin từ ảnh cắt độ nét cao vùng đầu Trang 1 văn bản hành chính Việt Nam:',
                options.needRegionA
                  ? '- docNumber: Số/ký hiệu tại dòng "Số:" trong ảnh Vùng A (góc trên bên trái). Chuẩn hóa khoảng trắng quanh "/" và "-" (vd "8773/KH-SGDĐT"), giữ số 0 đầu và ký hiệu gốc. Trả "" nếu không rõ.'
                  : '- docNumber: trả về "".',
                options.needRegionB
                  ? '- topRightDate: Ngày ban hành tại dòng địa danh, ngày/tháng/năm dưới Tiêu ngữ trong ảnh Vùng B (góc trên bên phải), chuẩn hóa dd/MM/yyyy. Trả "" nếu không thấy rõ.'
                  : '- topRightDate: trả về "".',
                'KHÔNG ĐƯỢC SUY ĐOÁN.',
              ].join('\n'),
            });
            const resp = await ai.models.generateContent({
              model: 'gemini-4-hydrogen',
              contents: [{ role: 'user', parts: visionParts }],
              config: {
                responseMimeType: 'application/json',
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    docNumber: { type: Type.STRING },
                    topRightDate: { type: Type.STRING },
                  },
                },
              },
            });
            const parsed = JSON.parse((resp.text || '{}').trim());
            if (options.needRegionA && typeof parsed?.docNumber === 'string' && parsed.docNumber.trim()) {
              visionDocNumber = extractDocNumberFromSoValue(
                parsed.docNumber.replace(/^[S5][ốoôơổộ6]\s*[:;\.]?\s*/i, '')
              );
            }
            if (options.needRegionB && typeof parsed?.topRightDate === 'string' && parsed.topRightDate.trim()) {
              visionTopRightDate = validateAdministrativeDate(
                normalizeDateOnlyDdMmYyyy(parsed.topRightDate)
              );
            }
          }
        } catch {
          // ignore optional vision assist errors
        }
      }
    }
  } catch (err: any) {
    console.warn('[PDF 300DPI Header] Không thể render trang 1 ở 300 DPI:', err?.message);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return {
    regionAText,
    regionABoxes,
    regionBText,
    regionBBoxes,
    visionDocNumber: visionDocNumber || undefined,
    visionTopRightDate: visionTopRightDate || undefined,
  };
}

/**
 * Kiểm tra một số/ký hiệu ứng viên có xuất hiện trong câu viện dẫn phần thân ("Căn cứ Quyết định số ...") hay không.
 */
function isDocNumberCitedInBody(candidate: string, page1Text: string): boolean {
  if (!candidate || !page1Text) return false;
  const compactCand = removeVietnameseDiacritics(candidate).toLowerCase().replace(/\s+/g, '');
  if (!compactCand) return false;
  for (const rawLine of page1Text.split('\n')) {
    const normLine = removeVietnameseDiacritics(rawLine);
    if (!CITED_DOC_CONTEXT_REGEX.test(normLine)) continue;
    const compactLine = normLine.toLowerCase().replace(/\s+/g, '');
    if (compactLine.includes(compactCand)) return true;
  }
  return false;
}

/**
 * Kiểm chứng chống bịa dữ liệu: xác nhận chuỗi số/ký hiệu từ AI có căn cứ trong Vùng A
 * (bao gồm trường hợp PDF lai: lớp chữ có "/QĐ-SGDĐT", số "2937" đóng dấu ảnh được AI đọc trực quan).
 */
function isDocNumberGroundedInSource(
  candidate: string,
  regionASourceText: string,
  options?: { regionAIncompleteDocNum?: string; page1Text?: string }
): boolean {
  if (!candidate || !regionASourceText) return false;
  const compactSource = removeVietnameseDiacritics(regionASourceText)
    .toLowerCase()
    .replace(/\s+/g, '');
  const compactCand = removeVietnameseDiacritics(candidate)
    .toLowerCase()
    .replace(/\s+/g, '');
  if (compactSource.includes(compactCand)) return true;

  const parsedCand = parseDocNumberComponents(candidate);
  if (parsedCand.numberPart && parsedCand.symbolPart) {
    const normSym = removeVietnameseDiacritics(parsedCand.symbolPart)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    const alphaSource = compactSource.replace(/[^a-z0-9]/g, '');
    if (
      alphaSource.includes(parsedCand.numberPart) &&
      normSym.length >= 2 &&
      alphaSource.includes(normSym.slice(0, Math.min(4, normSym.length)))
    ) {
      return true;
    }

    // PDF lai: Lớp chữ Vùng A có đúng phần ký hiệu khuyết số (vd "/QĐ-SGDĐT"), phần số ("2937") là ảnh đóng dấu đỏ/xanh
    // được Gemini nhìn thấy trực tiếp trên trang PDF — chấp nhận nếu phần ký hiệu khớp chính xác và KHÔNG phải số viện dẫn trong thân
    const incomplete = parseDocNumberComponents(options?.regionAIncompleteDocNum || '');
    if (!incomplete.numberPart && incomplete.symbolPart) {
      const normIncSym = removeVietnameseDiacritics(incomplete.symbolPart)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
      if (normIncSym && normSym === normIncSym) {
        if (!isDocNumberCitedInBody(candidate, options?.page1Text || '')) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Kiểm chứng chống bịa dữ liệu: xác nhận ngày dd/MM/yyyy từ AI có căn cứ trong Vùng B
 * (dạng số, dạng chữ tiếng Việt, hoặc mẫu "ngày ... tháng ... năm YYYY" bị đóng dấu ảnh cho phần ngày).
 */
function isDateGroundedInRegionB(dateDdMmYyyy: string, regionBText: string): boolean {
  if (!dateDdMmYyyy || !regionBText) return false;
  const parts = dateDdMmYyyy.split('/');
  if (parts.length !== 3) return false;
  const [dd, mm, yyyy] = parts;
  const dInt = String(parseInt(dd, 10));
  const mInt = String(parseInt(mm, 10));
  const lines = regionBText.split('\n').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    if (extractDateFromHeaderOrSigLine(lines[i], { allowStandaloneNumeric: true }) === dateDdMmYyyy) {
      return true;
    }
    if (i + 1 < lines.length) {
      const pair = `${lines[i]} ${lines[i + 1]}`;
      if (extractDateFromHeaderOrSigLine(pair, { allowStandaloneNumeric: true }) === dateDdMmYyyy) {
        return true;
      }
    }
  }
  const norm = removeVietnameseDiacritics(regionBText);
  if (norm.includes(yyyy) && (norm.includes(dInt) || norm.includes(dd)) && (norm.includes(mInt) || norm.includes(mm))) {
    return true;
  }
  // PDF lai: Vùng B có dòng mẫu "ngày ... tháng ... năm YYYY" nhưng phần số ngày/tháng đóng dấu ảnh màu
  if (/\bngay\b/i.test(norm) && /\bthang\b/i.test(norm) && norm.includes(yyyy)) {
    return true;
  }
  return false;
}

function scoreToConfidenceLevel(score: number): ExtractionConfidenceLevel {
  if (score >= 82) return 'high';
  if (score >= 58) return 'medium';
  return 'low';
}

export async function analyzePdfBuffer(
  buffer: Buffer,
  options?: { originalFileName?: string }
): Promise<{
  sha256: string;
  extraction: PdfExtractionResult;
  pageTexts: PdfPageContent[];
}> {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const { pageCount, pages, rawSigDates, rawSigSigners } = await extractPdfTextWithPdfJs(buffer);

  // Ưu tiên trang 1 và các trang cuối (khối chữ ký)
  const targetPagesSet = new Set<number>([1]);
  if (pageCount >= 2) targetPagesSet.add(pageCount);
  if (pageCount >= 3) targetPagesSet.add(pageCount - 1);

  const ocrNeededPages: number[] = [];
  for (const pNum of targetPagesSet) {
    const info = pages.find((p) => p.pageNumber === pNum);
    if (!info || isGarbledText(info.fullText)) {
      ocrNeededPages.push(pNum);
    }
  }

  let usedOcr = false;
  const ocrConfidences: number[] = [];
  const pageTextByNum = new Map<number, string>();
  for (const p of pages) {
    pageTextByNum.set(p.pageNumber, p.fullText);
  }
  const ocrBoxesByNum = new Map<number, NormalizedBox[]>();

  const mergeOcrResults = (ocrResults: Map<number, OcrPageResult>) => {
    for (const [pNum, ocrRes] of ocrResults.entries()) {
      const existing = pageTextByNum.get(pNum) || '';
      if (countMeaningfulChars(ocrRes.text) > countMeaningfulChars(existing) || isGarbledText(existing)) {
        pageTextByNum.set(pNum, ocrRes.text);
        if (ocrRes.boxes.length > 0) {
          ocrBoxesByNum.set(pNum, ocrRes.boxes);
        }
      }
      if (ocrRes.confidence > 0) {
        ocrConfidences.push(ocrRes.confidence);
      }
    }
  };

  let ocrUnavailableReason: string | undefined;
  if (ocrNeededPages.length > 0) {
    usedOcr = true;
    const ocrRun = await runVietnameseOcrOnPages(buffer, ocrNeededPages);
    mergeOcrResults(ocrRun.results);
    if (ocrRun.ocrUnavailableReason) {
      ocrUnavailableReason = ocrRun.ocrUnavailableReason;
    }
  }

  // Nếu PDF scan nhiều trang (> 3) và các trang cuối là Phụ lục / Thể lệ hoặc chưa có chữ ký, lùi thêm về các trang trước phụ lục
  if (pageCount > 3 && usedOcr) {
    const trailingHasNonAppendixSigner = [pageCount, pageCount - 1].some((pNum) => {
      const txt = pageTextByNum.get(pNum) || '';
      if (!txt || isAppendixPage(txt)) return false;
      const lines = txt.split('\n').filter(Boolean);
      const bottomApprox = lines.slice(Math.floor(lines.length * 0.30)).join('\n');
      return extractSignersFromZoneText(bottomApprox || txt, pNum).length > 0;
    });

    if (!trailingHasNonAppendixSigner) {
      const extraPagesToOcr: number[] = [];
      for (let pNum = pageCount - 2; pNum >= 2 && extraPagesToOcr.length < 5; pNum--) {
        const info = pages.find((p) => p.pageNumber === pNum);
        if (!info || isGarbledText(info.fullText)) {
          extraPagesToOcr.push(pNum);
        }
      }
      if (extraPagesToOcr.length > 0) {
        const extraOcrRun = await runVietnameseOcrOnPages(buffer, extraPagesToOcr);
        mergeOcrResults(extraOcrRun.results);
      }
    }
  }

  const ocrConfidence =
    ocrConfidences.length > 0
      ? Math.round(ocrConfidences.reduce((a, b) => a + b, 0) / ocrConfidences.length)
      : undefined;

  const page1 = pages.find((p) => p.pageNumber === 1);
  const page1Text = pageTextByNum.get(1) || '';

  // LỚP 1 & 2: Phân tích bố cục 2 vùng độc lập (VÙNG A trái, VÙNG B phải) bằng tọa độ bounding box + chống nghiêng
  const page1HasPdfBoxes = Boolean(page1 && !isGarbledText(page1.fullText) && page1.boxes.length > 0);
  const page1Boxes = page1HasPdfBoxes ? page1!.boxes : ocrBoxesByNum.get(1) || [];
  const page1DividerYs = page1HasPdfBoxes ? page1!.dividerYs : [];

  const headerAnalysis = analyzeTopLeftHeader(page1Boxes, page1DividerYs);

  let docNumber = headerAnalysis.docNumber;
  let docNumberRawText = headerAnalysis.docNumberRawText || '';
  let docNumberBBoxOverride: NormalizedBBox | undefined = headerAnalysis.docNumberBBox;
  let docNumberSource: 'so_label' | 'spatial_header' | 'ocr_300dpi' | 'gemini_grounded' | 'none' =
    headerAnalysis.docNumberSource;
  let docNumberConflictDetected = false;
  let docNumberConflictDetail = '';
  const docNumberCandidateSet = new Set<string>(headerAnalysis.topLeftHeaderDocNumbers);

  let parentAgency = headerAnalysis.parentAgency;
  let parentAgencyBBoxOverride = headerAnalysis.parentAgencyBBox;
  let issuingAgency = headerAnalysis.issuingAgency || extractIssuingAgencyFallback(page1Text);
  let agencyBBoxOverride = headerAnalysis.agencyBBox;

  const subjectRes = extractSubjectAndTitle(
    page1Boxes,
    page1Text,
    page1DividerYs,
    headerAnalysis.splitX,
    docNumber,
    headerAnalysis.skewSlope
  );
  let docType = subjectRes.docType;
  let docName = subjectRes.docName;
  let title = subjectRes.title;

  // VÙNG B – PHÍA TRÊN BÊN PHẢI: Trích xuất ngày ban hành dựa theo tọa độ Vùng B + neo ngang dòng Số + trên vùng tiêu đề
  const topRightAnalysis = extractTopRightHeaderDate(
    page1Boxes,
    headerAnalysis.rightTopText || page1?.rightTopText || '',
    headerAnalysis.splitX,
    {
      skewSlope: headerAnalysis.skewSlope,
      soLineYCenter: headerAnalysis.soLineYCenter,
      titleTopY: subjectRes.titleTopY,
    }
  );
  let topRightDate = topRightAnalysis.primary;
  const issueDateCandidateSet = new Set<string>(topRightAnalysis.candidates);
  let issueDateSource: 'region_b_layout' | 'ocr_300dpi' | 'gemini_grounded' | 'none' = topRightDate
    ? 'region_b_layout'
    : 'none';
  let issueDateConflictDetected = false;
  let issueDateConflictDetail = '';

  // Kiểm tra bất thường Vùng A hoặc Vùng B -> kích hoạt Lớp 2 OCR cắt vùng 300 DPI độc lập cho cả Vùng A và/hoặc Vùng B
  const initialSuspicious = isIncompleteOrSuspiciousDocNumber(docNumber);
  const needRegionA300 =
    initialSuspicious.suspicious || !page1HasPdfBoxes || headerAnalysis.docNumberNeedsReview;
  const needRegionB300 = !topRightDate || !page1HasPdfBoxes;

  let effectiveRegionAText = headerAnalysis.leftTopText;
  let effectiveRegionBText = headerAnalysis.rightTopText;
  let rawOcrDocNumber = docNumber;

  if (needRegionA300 || needRegionB300) {
    const dualCrop = await runDualRegionHeader300DpiFallback(buffer, {
      needRegionA: needRegionA300,
      needRegionB: needRegionB300,
      splitX: headerAnalysis.splitX,
      titleTopY: subjectRes.titleTopY,
    });

    // Luôn gộp văn bản 300 DPI Vùng A / Vùng B để bước đối chiếu nguồn không bỏ sót phần đóng dấu ảnh
    if (dualCrop.regionAText) {
      effectiveRegionAText = effectiveRegionAText
        ? `${effectiveRegionAText}\n${dualCrop.regionAText}`
        : dualCrop.regionAText;
    }
    if (dualCrop.regionBText) {
      effectiveRegionBText = effectiveRegionBText
        ? `${effectiveRegionBText}\n${dualCrop.regionBText}`
        : dualCrop.regionBText;
    }

    if (needRegionA300 && (dualCrop.regionABoxes.length > 0 || dualCrop.regionAText || dualCrop.visionDocNumber)) {
      const cropHeaderA =
        dualCrop.regionABoxes.length > 0 ? analyzeTopLeftHeader(dualCrop.regionABoxes, []) : null;
      const cropDocCandidates = [
        cropHeaderA?.docNumber || '',
        ...extractDocNumberCandidates(dualCrop.regionAText),
        dualCrop.visionDocNumber || '',
      ]
        .map((s) => normalizeDocNumber(s))
        .filter(Boolean);

      for (const cand of cropDocCandidates) {
        if (!isIncompleteOrSuspiciousDocNumber(cand).suspicious) {
          docNumberCandidateSet.add(cand);
        }
      }

      const completeCropCandidate = cropDocCandidates.find(
        (c) => !isIncompleteOrSuspiciousDocNumber(c).suspicious
      );

      if (completeCropCandidate) {
        usedOcr = true;
        if (!docNumber || initialSuspicious.suspicious) {
          docNumber = completeCropCandidate;
          rawOcrDocNumber = completeCropCandidate;
          docNumberRawText =
            cropHeaderA?.docNumberRawText ||
            dualCrop.regionAText.split('\n').find((l) => isSoLabelLine(l)) ||
            completeCropCandidate;
          docNumberSource = 'ocr_300dpi';
          if (cropHeaderA?.docNumberBBox) {
            docNumberBBoxOverride = cropHeaderA.docNumberBBox;
          }
        } else if (docNumber.toLowerCase() !== completeCropCandidate.toLowerCase()) {
          docNumberConflictDetected = true;
          docNumberConflictDetail = `Số văn bản từ lớp chữ ("${docNumber}") khác với kết quả OCR vùng A 300 DPI ("${completeCropCandidate}"). Vui lòng đối chiếu bản PDF gốc.`;
        }
      }

      if (!parentAgency && cropHeaderA?.parentAgency) {
        parentAgency = cropHeaderA.parentAgency;
        if (cropHeaderA.parentAgencyBBox) parentAgencyBBoxOverride = cropHeaderA.parentAgencyBBox;
      }
      if (!issuingAgency && cropHeaderA?.issuingAgency) {
        issuingAgency = cropHeaderA.issuingAgency;
        if (cropHeaderA.agencyBBox) agencyBBoxOverride = cropHeaderA.agencyBBox;
      }
    }

    if (needRegionB300 && (dualCrop.regionBBoxes.length > 0 || dualCrop.regionBText || dualCrop.visionTopRightDate)) {
      const cropSkewB = estimateHeaderSkewSlope(dualCrop.regionBBoxes);
      const cropDateRes = extractTopRightHeaderDate(
        dualCrop.regionBBoxes,
        dualCrop.regionBText,
        0.30, // Toàn bộ crop đã là Vùng B
        {
          skewSlope: cropSkewB,
          soLineYCenter: headerAnalysis.soLineYCenter,
          titleTopY: subjectRes.titleTopY,
        }
      );

      for (const c of cropDateRes.candidates) {
        issueDateCandidateSet.add(c);
      }
      if (dualCrop.visionTopRightDate) {
        issueDateCandidateSet.add(dualCrop.visionTopRightDate);
      }

      const cropBestDate = cropDateRes.primary;
      if (cropBestDate) {
        usedOcr = true;
        if (!topRightDate) {
          topRightDate = cropBestDate;
          issueDateSource = 'ocr_300dpi';
        } else if (topRightDate.date !== cropBestDate.date) {
          issueDateConflictDetected = true;
          issueDateConflictDetail = `Ngày ban hành Vùng B từ lớp chữ (${topRightDate.date}) khác kết quả OCR 300 DPI (${cropBestDate.date}). Vui lòng kiểm tra lại.`;
        }
      } else if (!topRightDate && dualCrop.visionTopRightDate) {
        usedOcr = true;
        topRightDate = {
          date: dualCrop.visionTopRightDate,
          positionLabel: 'Vùng B – Góc trên bên phải (Trang 1)',
          page: 1,
          estimated: true,
          rawText: dualCrop.visionTopRightDate,
        };
        issueDateSource = 'ocr_300dpi';
      }
    }
  }

  // Nếu ban đầu chưa xác định được docType nhưng sau 300 DPI đã có docNumber -> bổ sung docType từ mã số
  if (!docType && docNumber) {
    const inferred = resolveCanonicalDocType('', docNumber);
    if (inferred) docType = inferred.toLocaleUpperCase('vi-VN');
  }

  // 2. Xác định các trang ứng viên cho khối chữ ký: loại bỏ trang Phụ lục / Thể lệ phía sau, quét lùi từ trang chính cuối về trang 1
  const orderedPageNums: number[] = [];
  for (let p = pageCount; p >= 1; p--) {
    orderedPageNums.push(p);
  }
  const nonAppendixPages = orderedPageNums.filter((pNum) => {
    const txt = pageTextByNum.get(pNum) || '';
    return !isAppendixPage(txt);
  });
  const appendixPages = orderedPageNums.filter((pNum) => !nonAppendixPages.includes(pNum));

  const getBoxesForPage = (pNum: number): NormalizedBox[] => {
    const pInfo = pages.find((p) => p.pageNumber === pNum);
    if (pInfo && !isGarbledText(pInfo.fullText) && pInfo.boxes.length > 0) {
      return pInfo.boxes;
    }
    return ocrBoxesByNum.get(pNum) || [];
  };

  const buildZonePage = (pNum: number): SignatureZonePage => {
    const pInfo = pages.find((x) => x.pageNumber === pNum);
    const full = pageTextByNum.get(pNum) || '';
    const hasReliableSpans = Boolean(pInfo && !isGarbledText(pInfo.fullText));

    if (hasReliableSpans && pInfo) {
      const widerRightBottom = pInfo.boxes.filter((b) => (b.y0 + b.y1) / 2 >= 0.30 && b.x0 >= 0.35);
      return {
        pageNumber: pNum,
        rightBottomText: boxesToText(widerRightBottom) || pInfo.rightBottomText,
        rightHalfText: pInfo.rightHalfText,
        bottomText: pInfo.bottomText,
        fullText: full,
        annotationText: pInfo.annotationText || '',
      };
    }

    const ocrBoxes = ocrBoxesByNum.get(pNum) || [];
    if (ocrBoxes.length > 0) {
      const rightBottomBoxes = ocrBoxes.filter((b) => (b.y0 + b.y1) / 2 >= 0.30 && b.x0 >= 0.35);
      const rightHalfBoxes = ocrBoxes.filter((b) => b.x0 >= 0.35);
      const bottomBoxes = ocrBoxes.filter((b) => (b.y0 + b.y1) / 2 >= 0.30);
      return {
        pageNumber: pNum,
        rightBottomText: boxesToText(rightBottomBoxes),
        rightHalfText: boxesToText(rightHalfBoxes),
        bottomText: boxesToText(bottomBoxes),
        fullText: full,
        annotationText: pInfo?.annotationText || '',
      };
    }

    const ocrLines = full.split('\n').map((l) => l.trim()).filter(Boolean);
    const ocrBottom = ocrLines.slice(Math.floor(ocrLines.length * 0.30)).join('\n');
    return {
      pageNumber: pNum,
      rightBottomText: '',
      rightHalfText: '',
      bottomText: ocrBottom,
      fullText: full,
      annotationText: pInfo?.annotationText || '',
    };
  };

  let sigResult = extractSignerInfo(nonAppendixPages.map(buildZonePage), rawSigSigners);
  if (!sigResult.signer && appendixPages.length > 0) {
    sigResult = extractSignerInfo(appendixPages.map(buildZonePage), rawSigSigners);
  }
  let { signer, signerRole } = sigResult;
  const { signerCandidates, signaturePage } = sigResult;

  // 3. Đối chiếu ngày CHỈ TỪ NỘI DUNG IN TRÊN VĂN BẢN ở 2 vị trí (LOẠI hoàn toàn chữ ký số / tem ký số / metadata PDF)
  const ignoredDigitalSigDates = collectDigitalSignatureDates({
    rawSigDates,
    pages,
    pageTextByNum,
  });

  let signatureDate = extractSignatureZoneDate({
    signaturePage,
    pageBoxes: getBoxesForPage(signaturePage),
    signerPageText: pageTextByNum.get(signaturePage) || '',
  });
  if (!signatureDate && !topRightDate) {
    for (const pNum of nonAppendixPages) {
      if (pNum === signaturePage) continue;
      const altSigDate = extractSignatureZoneDate({
        signaturePage: pNum,
        pageBoxes: getBoxesForPage(pNum),
        signerPageText: pageTextByNum.get(pNum) || '',
      });
      if (altSigDate) {
        signatureDate = altSigDate;
        break;
      }
    }
  }

  // LỚP 3: Gemini AI nhận diện ngữ cảnh 2 vùng (Vùng A & Vùng B) có kiểm chứng chống suy đoán/bịa dữ liệu
  let aiUsed = false;
  let geminiAgreedDocNumber = false;
  let geminiAgreedIssueDate = false;
  let geminiRawDocNumber = '';

  const geminiResult = await extractMetadataWithGemini({
    pdfBuffer: buffer,
    regionAText: effectiveRegionAText,
    regionBText: effectiveRegionBText,
    page1Text,
    signaturePageText: pageTextByNum.get(signaturePage) || '',
    signaturePageNumber: signaturePage,
    pageCount,
  });

  if (geminiResult) {
    aiUsed = true;
    const cleanGeminiDocNum = geminiResult.docNumber
      ? normalizeDocNumber(geminiResult.docNumber)
      : '';
    geminiRawDocNumber = cleanGeminiDocNum;

    // Kiểm chứng căn cứ nguồn cho docNumber từ Gemini (hỗ trợ cả PDF lai: lớp chữ khuyết số + ảnh đóng dấu số)
    const geminiDocNumValid = Boolean(
      cleanGeminiDocNum && !isIncompleteOrSuspiciousDocNumber(cleanGeminiDocNum).suspicious
    );
    const geminiDocNumGrounded =
      !page1HasPdfBoxes ||
      isDocNumberGroundedInSource(
        cleanGeminiDocNum,
        effectiveRegionAText || page1Text.slice(0, 800),
        {
          regionAIncompleteDocNum: docNumber,
          page1Text,
        }
      );

    if (geminiDocNumValid && geminiDocNumGrounded) {
      docNumberCandidateSet.add(cleanGeminiDocNum);
      if (!docNumber || isIncompleteOrSuspiciousDocNumber(docNumber).suspicious) {
        docNumber = cleanGeminiDocNum;
        docNumberSource = 'gemini_grounded';
        const gBox = parseGeminiBox1000(geminiResult.docNumberBox);
        if (!docNumberBBoxOverride && gBox) {
          docNumberBBoxOverride = gBox;
        }
      } else if (docNumber.toLowerCase() === cleanGeminiDocNum.toLowerCase()) {
        geminiAgreedDocNumber = true;
      } else {
        docNumberConflictDetected = true;
        docNumberConflictDetail =
          docNumberConflictDetail ||
          `Số văn bản đọc từ bố cục Vùng A ("${docNumber}") khác với nhận diện AI ("${cleanGeminiDocNum}"). Vui lòng đối chiếu bản PDF gốc.`;
      }
    }

    if (!docType && geminiResult.docType?.trim()) {
      docType = geminiResult.docType.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleUpperCase('vi-VN');
    }
    if (!parentAgency && geminiResult.parentAgency?.trim()) {
      parentAgency = geminiResult.parentAgency.replace(/\s+/g, ' ').trim();
    }
    if (!issuingAgency && geminiResult.issuingAgency?.trim()) {
      issuingAgency = geminiResult.issuingAgency.replace(/\s+/g, ' ').trim();
    }

    const geminiTitle = (geminiResult.title || '').normalize('NFC').replace(/\s+/g, ' ').trim();
    const geminiDocName = (geminiResult.docName || '').normalize('NFC').replace(/\s+/g, ' ').trim();

    if ((!title || isGenericBareDocName(title)) && geminiTitle && !isGenericBareDocName(geminiTitle)) {
      title = geminiTitle;
    }

    if (geminiDocName && !isGenericBareDocName(geminiDocName)) {
      if (!docName || isGenericBareDocName(docName)) {
        docName = geminiDocName;
      } else if (title && geminiDocName.length < title.length && geminiDocName.length <= docName.length + 10) {
        const baseWords = removeVietnameseDiacritics(title)
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length >= 3);
        const aiNorm = removeVietnameseDiacritics(geminiDocName).toLowerCase();
        const overlap = baseWords.filter((w) => aiNorm.includes(w)).length;
        if (baseWords.length === 0 || overlap >= Math.min(3, Math.ceil(baseWords.length * 0.40))) {
          docName = geminiDocName;
        }
      }
    }

    if (!signer && geminiResult.signer?.trim()) {
      const candSigner = cleanOcrStampNoiseFromName(geminiResult.signer.trim());
      if (candSigner && isLikelyVietnamesePersonName(candSigner)) {
        signer = candSigner;
      }
    }
    if (!signerRole && geminiResult.signerRole?.trim()) {
      signerRole = geminiResult.signerRole.replace(/\s+/g, ' ').trim();
    }

    // Kiểm chứng căn cứ nguồn cho topRightDate từ Gemini (tuyệt đối không chấp nhận ngày chữ ký số hoặc ngày bịa không có ở Vùng B)
    if (geminiResult.topRightDate) {
      const validGTop = validateAdministrativeDate(normalizeDateOnlyDdMmYyyy(geminiResult.topRightDate));
      const groundedInB =
        !page1HasPdfBoxes || isDateGroundedInRegionB(validGTop, effectiveRegionBText);
      if (validGTop && !ignoredDigitalSigDates.has(validGTop) && groundedInB) {
        issueDateCandidateSet.add(validGTop);
        if (!topRightDate) {
          const bbox =
            findLinesBBoxByQuery(page1Boxes, validGTop, 0, 0.44) ||
            parseGeminiBox1000(geminiResult.topRightDateBox);
          topRightDate = {
            date: validGTop,
            positionLabel: 'Vùng B – Góc trên bên phải (Trang 1)',
            page: 1,
            ...(bbox ? { bbox } : { estimated: true }),
            rawText: geminiResult.topRightDate,
          };
          issueDateSource = 'gemini_grounded';
        } else if (topRightDate.date === validGTop) {
          geminiAgreedIssueDate = true;
        } else {
          issueDateConflictDetected = true;
          issueDateConflictDetail =
            issueDateConflictDetail ||
            `Ngày ban hành ở Vùng B (${topRightDate.date}) khác với nhận diện AI (${validGTop}). Vui lòng kiểm tra lại.`;
        }
      }
    }

    if (!signatureDate && geminiResult.signatureDate) {
      const validGSig = validateAdministrativeDate(normalizeDateOnlyDdMmYyyy(geminiResult.signatureDate));
      const isKnownDigitalSigDate = Boolean(validGSig && ignoredDigitalSigDates.has(validGSig));
      const sigPageInfoCheck = pages.find((p) => p.pageNumber === signaturePage);
      const sigPageHasReliableText = Boolean(sigPageInfoCheck && !isGarbledText(sigPageInfoCheck.fullText));
      if (validGSig && !isKnownDigitalSigDate) {
        const sigBoxesForLoc = getBoxesForPage(signaturePage);
        const verifiedPrintedLine = sigPageHasReliableText
          ? (pageTextByNum.get(signaturePage) || '')
              .split('\n')
              .some((l) => !isDigitalSignatureDateLine(l) && extractDateFromHeaderOrSigLine(l) === validGSig)
          : true;
        if (verifiedPrintedLine) {
          const bbox = findLinesBBoxByQuery(sigBoxesForLoc, validGSig, 0.25, 1);
          signatureDate = {
            date: validGSig,
            positionLabel: `Khối chữ ký (Trang ${signaturePage})`,
            page: signaturePage,
            ...(bbox ? { bbox } : { estimated: true }),
            rawText: geminiResult.signatureDate,
          };
        }
      }
    }
  }

  // Bảo đảm Tên văn bản luôn cụ thể khi Trích yếu gốc rõ ràng (không bao giờ chỉ để "KẾ HOẠCH", "QUYẾT ĐỊNH", "THÔNG BÁO")
  if (title && (!docName || isGenericBareDocName(docName))) {
    const regenerated = generateConciseDocName('', title, docNumber);
    if (regenerated && !isGenericBareDocName(regenerated)) {
      docName = regenerated;
    }
  }

  // LỚP 4: Xử lý đối chiếu ngày + Tính độ tin cậy ĐA TÍN HIỆU (không dựa vào AI tự chấm điểm)
  const d1 = topRightDate?.date || '';
  const d2 = signatureDate?.date || '';
  let dateComparisonStatus: DateComparisonStatus = 'missing';
  let documentDate = '';
  let issueDate = '';
  let signDate = '';

  if (d1 && d2) {
    if (d1 === d2) {
      dateComparisonStatus = 'matched';
      documentDate = d1;
      issueDate = d1;
      signDate = d2;
    } else {
      dateComparisonStatus = 'mismatch';
      documentDate = '';
      issueDate = '';
      signDate = d2;
    }
  } else if (d1) {
    // QUY TẮC QUAN TRỌNG: Chỉ có ngày ban hành (Vùng B) -> KHÔNG tự động sao chép sang ngày ký (signDate = '')
    dateComparisonStatus = 'single';
    documentDate = d1;
    issueDate = d1;
    signDate = '';
  } else if (d2) {
    dateComparisonStatus = 'single';
    documentDate = d2;
    issueDate = '';
    signDate = d2;
  }

  const ignoredDigitalSignatureDate = ignoredDigitalSigDates.size > 0;

  // --- Bước 4: Chuẩn hóa & Đối chiếu thông minh giữa kết quả PDF (OCR/Text/AI) và Tên tệp gốc ---
  const filenameDocNumberHint = options?.originalFileName
    ? extractFilenameDocNumberHint(options.originalFileName)
    : '';

  const pdfStageDocNumber = normalizeDocNumber(docNumber);
  const reconciliation = reconcileDocNumberWithFilename(pdfStageDocNumber, filenameDocNumberHint);

  let reconciledFromFilename = false;
  if (reconciliation.status === 'reconciled_from_filename' && reconciliation.finalDocNumber) {
    // Kết hợp có căn cứ từ OCR thiếu số (vd "/QĐ-SGDĐT") + Tên tệp tương thích (vd "2937/QĐ") -> "2937/QĐ-SGDĐT"
    docNumber = reconciliation.finalDocNumber;
    reconciledFromFilename = true;
    docNumberCandidateSet.add(reconciliation.finalDocNumber);
  } else if (reconciliation.status === 'conflict') {
    docNumber = reconciliation.finalDocNumber;
    docNumberConflictDetected = true;
    docNumberConflictDetail = docNumberConflictDetail || reconciliation.reason;
    if (filenameDocNumberHint) {
      docNumberCandidateSet.add(filenameDocNumberHint);
    }
  } else if (pdfStageDocNumber) {
    // Không bao giờ để kết quả thiếu ghi đè kết quả đã xác minh đầy đủ
    docNumber = pdfStageDocNumber;
  }

  // Nếu docType chưa có nhưng docNumber đã đầy đủ sau đối chiếu -> bổ sung docType
  if (!docType && docNumber) {
    const inferredType = resolveCanonicalDocType('', docNumber);
    if (inferredType) docType = inferredType.toLocaleUpperCase('vi-VN');
  }

  const docNumberResolution: DocNumberResolutionInfo = {
    status: reconciliation.status,
    rawOcrDocNumber: rawOcrDocNumber || undefined,
    geminiDocNumber: geminiRawDocNumber || undefined,
    filenameHint: filenameDocNumberHint || undefined,
    proposedDocNumber: reconciliation.proposedDocNumber,
    finalDocNumber: docNumber,
    sourceSummary: reconciliation.sourceSummary,
    hasConflict: reconciliation.hasConflict || docNumberConflictDetected || undefined,
  };

  // --- Đánh giá đa tín hiệu cho SỐ / KÝ HIỆU (Vùng A) ---
  const finalDocNumCheck = isIncompleteOrSuspiciousDocNumber(docNumber);
  const docNumCandidates = Array.from(docNumberCandidateSet).filter(
    (c) => !isIncompleteOrSuspiciousDocNumber(c).suspicious || c === docNumber
  );
  const docNumSignals: string[] = [];
  let docNumScore = 0;

  if (docNumber && !finalDocNumCheck.suspicious) {
    docNumScore += 35;
    docNumSignals.push('Đúng định dạng số/ký hiệu hành chính');
    if (reconciledFromFilename) {
      docNumScore += 22;
      docNumSignals.push(
        `Kết hợp tương thích OCR ("${rawOcrDocNumber || pdfStageDocNumber}") + Tên tệp ("${filenameDocNumberHint}")`
      );
    } else if (docNumberSource === 'so_label') {
      docNumScore += 35;
      docNumSignals.push('Đúng vị trí dòng "Số:" tại Vùng A (góc trên trái)');
    } else if (docNumberSource === 'ocr_300dpi') {
      docNumScore += 32;
      docNumSignals.push('Trích xuất trực tiếp từ OCR 300 DPI Vùng A');
    } else if (docNumberSource === 'spatial_header') {
      docNumScore += 14;
      docNumSignals.push('Nhận diện theo cấu trúc & vị trí Vùng A (thiếu nhãn "Số:")');
    } else if (docNumberSource === 'gemini_grounded') {
      docNumScore += 30;
      docNumSignals.push('Nhận diện AI có đối chứng nguồn Vùng A trên PDF');
    }

    if (!reconciledFromFilename) {
      if (page1HasPdfBoxes && (docNumberSource === 'so_label' || docNumberSource === 'ocr_300dpi' || docNumberSource === 'gemini_grounded')) {
        docNumScore += 20;
        docNumSignals.push('Đã xác minh trực tiếp trên bản PDF gốc');
      } else if (ocrConfidence !== undefined && ocrConfidence >= 80) {
        docNumScore += 12;
        docNumSignals.push(`Độ rõ OCR tốt (${ocrConfidence}%)`);
      } else if (usedOcr) {
        docNumScore += 8;
        docNumSignals.push('Bản quét OCR Vùng A');
      }
    }

    if (geminiAgreedDocNumber) {
      docNumScore += 10;
      docNumSignals.push('Khớp chéo giữa bố cục tọa độ và AI');
    }
    if (
      !reconciledFromFilename &&
      filenameDocNumberHint &&
      reconciliation.status === 'verified_pdf'
    ) {
      docNumScore += 8;
      docNumSignals.push(`Khớp với tên tệp gốc (${filenameDocNumberHint})`);
    }
    if (docNumberConflictDetected || (!reconciledFromFilename && docNumCandidates.length > 1)) {
      docNumScore = Math.min(docNumScore, 52);
      docNumSignals.push(`Có ứng viên mâu thuẫn (${docNumCandidates.join(', ')})`);
    }
    if (docNumberSource === 'spatial_header') {
      docNumScore = Math.min(docNumScore, 62);
    }
    if (reconciledFromFilename) {
      docNumScore = Math.min(docNumScore, 68);
    }
  } else {
    docNumScore = docNumber ? 25 : 0;
    docNumSignals.push(finalDocNumCheck.reason || 'Chưa nhận diện được Số/ký hiệu');
  }
  docNumScore = Math.max(0, Math.min(100, docNumScore));
  const docNumConfidence = scoreToConfidenceLevel(docNumScore);

  let docNumberNeedsConfirmation = false;
  let docNumberReviewReason = '';

  if (finalDocNumCheck.suspicious) {
    docNumberNeedsConfirmation = true;
    docNumberReviewReason = finalDocNumCheck.reason;
  } else if (reconciledFromFilename) {
    docNumberNeedsConfirmation = true;
    docNumberReviewReason = reconciliation.reason;
  } else if (docNumberConflictDetected && docNumberConflictDetail) {
    docNumberNeedsConfirmation = true;
    docNumberReviewReason = docNumberConflictDetail;
  } else if (
    headerAnalysis.docNumberNeedsReview &&
    headerAnalysis.docNumberReviewReason &&
    docNumberSource === 'spatial_header'
  ) {
    docNumberNeedsConfirmation = true;
    docNumberReviewReason = headerAnalysis.docNumberReviewReason;
  } else if (docNumCandidates.length > 1) {
    docNumberNeedsConfirmation = true;
    docNumberReviewReason = `Phát hiện nhiều ứng viên Số/ký hiệu tại Vùng A (${docNumCandidates.join(', ')}), vui lòng xác nhận trước khi lưu.`;
  } else if (docNumConfidence === 'low') {
    docNumberNeedsConfirmation = true;
    docNumberReviewReason = 'Độ tin cậy nhận diện Số/ký hiệu thấp, vui lòng đối chiếu với bản PDF gốc.';
  }

  // --- Đánh giá đa tín hiệu cho NGÀY BAN HÀNH (Vùng B) ---
  const issueDateCandidates = Array.from(issueDateCandidateSet);
  const issueDateSignals: string[] = [];
  let issueDateScore = 0;
  let issueDateNeedsConfirmation = false;
  let issueDateReviewReason = '';

  if (topRightDate?.date) {
    issueDateScore += 35;
    issueDateSignals.push('Ngày hợp lệ theo lịch dương (dd/MM/yyyy)');
    if (issueDateSource === 'region_b_layout') {
      issueDateScore += 35;
      issueDateSignals.push('Đúng vị trí Vùng B (dưới Tiêu ngữ, góc trên phải)');
    } else if (issueDateSource === 'ocr_300dpi') {
      issueDateScore += 22;
      issueDateSignals.push('Trích xuất từ OCR 300 DPI Vùng B');
    } else if (issueDateSource === 'gemini_grounded') {
      issueDateScore += 18;
      issueDateSignals.push('Nhận diện AI có đối chứng Vùng B');
    }

    if (page1HasPdfBoxes && !topRightDate.estimated) {
      issueDateScore += 20;
      issueDateSignals.push('Tọa độ dòng địa danh/ngày tháng rõ ràng');
    } else if (ocrConfidence !== undefined && ocrConfidence >= 80) {
      issueDateScore += 12;
      issueDateSignals.push(`Độ rõ OCR tốt (${ocrConfidence}%)`);
    } else if (usedOcr) {
      issueDateScore += 4;
      issueDateSignals.push('Bản quét OCR cần rà soát');
    }

    if (geminiAgreedIssueDate || dateComparisonStatus === 'matched') {
      issueDateScore += 10;
      issueDateSignals.push('Khớp chéo đa nguồn');
    }
    if (dateComparisonStatus === 'mismatch' || issueDateConflictDetected || issueDateCandidates.length > 1) {
      issueDateScore = Math.min(issueDateScore, 48);
      issueDateSignals.push('Có ngày cạnh tranh hoặc không thống nhất');
    }
  } else {
    issueDateScore = 0;
    issueDateSignals.push(
      ignoredDigitalSignatureDate
        ? 'Chỉ có thời điểm chữ ký số (đã bỏ qua), Vùng B không có ngày ban hành'
        : 'Không tìm thấy ngày ban hành tại Vùng B'
    );
  }
  issueDateScore = Math.max(0, Math.min(100, issueDateScore));
  const issueDateConfidence = scoreToConfidenceLevel(issueDateScore);

  if (dateComparisonStatus === 'mismatch') {
    issueDateNeedsConfirmation = true;
    issueDateReviewReason = `Ngày ban hành ở Vùng B (${d1}) khác ngày in ở khối chữ ký (${d2}). Cần xác nhận ngày chính thức.`;
  } else if (issueDateConflictDetected && issueDateConflictDetail) {
    issueDateNeedsConfirmation = true;
    issueDateReviewReason = issueDateConflictDetail;
  } else if (issueDateCandidates.length > 1) {
    issueDateNeedsConfirmation = true;
    issueDateReviewReason = `Phát hiện nhiều ứng viên ngày ở Vùng B (${issueDateCandidates.join(', ')}), vui lòng xác nhận.`;
  } else if (!topRightDate?.date) {
    issueDateNeedsConfirmation = true;
    issueDateReviewReason = ignoredDigitalSignatureDate
      ? 'Chỉ phát hiện thời điểm trên chữ ký số (đã bỏ qua). Vùng B không có ngày ban hành, vui lòng đối chiếu và nhập thủ công nếu có.'
      : 'Chưa phát hiện ngày ban hành tại Vùng B (góc trên bên phải Trang 1). Hệ thống để trống để người dùng kiểm tra thủ công.';
  } else if (issueDateConfidence === 'low') {
    issueDateNeedsConfirmation = true;
    issueDateReviewReason = 'Độ tin cậy nhận diện Ngày ban hành thấp, vui lòng kiểm tra lại với bản PDF gốc.';
  }

  const reviewReasons: string[] = [];
  if (usedOcr) {
    if (ocrUnavailableReason && ocrConfidence === undefined) {
      reviewReasons.push(ocrUnavailableReason);
    } else if (ocrConfidence !== undefined && ocrConfidence < 75) {
      reviewReasons.push(`Chất lượng quét/OCR thấp (${ocrConfidence}%), vui lòng đối chiếu lại với bản PDF gốc.`);
    } else {
      reviewReasons.push('Văn bản dạng bản scan đã nhận diện bằng OCR tiếng Việt, vui lòng rà soát trước khi lưu.');
    }
  }
  if (docNumberReviewReason) {
    reviewReasons.push(docNumberReviewReason);
  }
  if (headerAnalysis.agencyNeedsReview && headerAnalysis.agencyReviewReason) {
    reviewReasons.push(headerAnalysis.agencyReviewReason);
  }
  if (!docName && !title) reviewReasons.push('Chưa nhận diện được Tên văn bản hoặc Trích yếu.');
  if (dateComparisonStatus === 'mismatch') {
    reviewReasons.push(
      `Ngày trên văn bản chưa thống nhất: ${topRightDate?.positionLabel} (${d1}) khác với ${signatureDate?.positionLabel} (${d2}). Cần quản trị viên xác nhận ngày.`
    );
  } else if (issueDateReviewReason) {
    reviewReasons.push(issueDateReviewReason);
  }
  if (!signer) reviewReasons.push('Chưa nhận diện được Họ tên người ký.');
  if (signerCandidates.length > 1) {
    reviewReasons.push(`Phát hiện nhiều tên người ký (${signerCandidates.join(', ')}), vui lòng xác nhận người ký chính.`);
  }

  const relevantPagesSet = new Set<number>([1]);
  if (signaturePage >= 1 && signaturePage <= pageCount) {
    relevantPagesSet.add(signaturePage);
  }
  const relevantPages = Array.from(relevantPagesSet).sort((a, b) => a - b);

  // 6. Ghi nhận vị trí trang, tọa độ bbox chuẩn hóa 0..1 và dữ liệu gốc/chuẩn hóa cho "Kiểm tra vị trí trích xuất"
  const fieldLocations: Partial<Record<ExtractableFieldKey, FieldLocation>> = {};

  if (docNumber) {
    const bbox = docNumberBBoxOverride || findLinesBBoxByQuery(page1Boxes, docNumber, 0, 0.48);
    fieldLocations.docNumber = bbox
      ? {
          page: 1,
          bbox,
          rawText: docNumberRawText || docNumber,
          normalizedValue: docNumber,
          region: 'region_a',
          confidence: docNumConfidence,
        }
      : {
          page: 1,
          estimated: true,
          bbox: headerAnalysis.regionABBox || { x0: 0.04, y0: 0.08, x1: 0.48, y1: 0.30 },
          rawText: docNumberRawText || docNumber,
          normalizedValue: docNumber,
          region: 'region_a',
          confidence: docNumConfidence,
        };
  } else {
    fieldLocations.docNumber = {
      page: 1,
      estimated: true,
      bbox: docNumberBBoxOverride || headerAnalysis.regionABBox || { x0: 0.04, y0: 0.08, x1: 0.48, y1: 0.30 },
      region: 'region_a',
      confidence: 'low',
    };
  }

  if (docType) {
    const bbox = subjectRes.docTypeBBox || findLinesBBoxByQuery(page1Boxes, docType, 0.12, 0.55);
    fieldLocations.docType = bbox
      ? { page: 1, bbox, normalizedValue: docType, region: 'title_zone', confidence: 'high' }
      : { page: 1, estimated: true, normalizedValue: docType, region: 'title_zone', confidence: 'medium' };
  }

  if (parentAgency) {
    const bbox = parentAgencyBBoxOverride || findLinesBBoxByQuery(page1Boxes, parentAgency, 0, 0.35);
    fieldLocations.parentAgency = bbox
      ? { page: 1, bbox, normalizedValue: parentAgency, region: 'region_a', confidence: 'high' }
      : { page: 1, estimated: true, normalizedValue: parentAgency, region: 'region_a', confidence: 'medium' };
  }

  if (issuingAgency) {
    const bbox = agencyBBoxOverride || findLinesBBoxByQuery(page1Boxes, issuingAgency, 0, 0.45);
    fieldLocations.issuingAgency = bbox
      ? {
          page: 1,
          bbox,
          normalizedValue: issuingAgency,
          region: 'region_a',
          confidence: headerAnalysis.agencyNeedsReview ? 'medium' : 'high',
        }
      : { page: 1, estimated: true, normalizedValue: issuingAgency, region: 'region_a', confidence: 'medium' };
  } else {
    fieldLocations.issuingAgency = { page: 1, estimated: true, region: 'region_a', confidence: 'low' };
  }

  if (docName) {
    const bbox = subjectRes.docNameBBox || findLinesBBoxByQuery(page1Boxes, docName, 0.08, 0.88);
    fieldLocations.docName = bbox
      ? { page: 1, bbox, normalizedValue: docName, region: 'title_zone', confidence: 'high' }
      : { page: 1, estimated: true, normalizedValue: docName, region: 'title_zone', confidence: 'medium' };
  }

  if (title) {
    const bbox = subjectRes.titleBBox || findLinesBBoxByQuery(page1Boxes, title, 0.08, 0.88);
    fieldLocations.title = bbox
      ? { page: 1, bbox, normalizedValue: title, region: 'title_zone', confidence: 'high' }
      : { page: 1, estimated: true, normalizedValue: title, region: 'title_zone', confidence: 'medium' };
  }

  if (topRightDate) {
    const loc: FieldLocation = {
      page: topRightDate.page,
      ...(topRightDate.bbox
        ? { bbox: topRightDate.bbox }
        : { estimated: true, bbox: topRightAnalysis.regionBBBox || headerAnalysis.regionBBBox }),
      rawText: topRightDate.rawText || topRightDate.date,
      normalizedValue: topRightDate.date,
      region: 'region_b',
      confidence: issueDateConfidence,
    };
    fieldLocations.topRightDate = loc;
    fieldLocations.issueDate = loc;
  } else {
    fieldLocations.issueDate = {
      page: 1,
      estimated: true,
      bbox: topRightAnalysis.regionBBBox || headerAnalysis.regionBBBox || { x0: 0.48, y0: 0.08, x1: 0.96, y1: 0.30 },
      region: 'region_b',
      confidence: 'low',
    };
  }

  if (signatureDate) {
    const loc: FieldLocation = {
      page: signatureDate.page,
      ...(signatureDate.bbox ? { bbox: signatureDate.bbox } : { estimated: true }),
      rawText: signatureDate.rawText || signatureDate.date,
      normalizedValue: signatureDate.date,
      region: 'signature_zone',
      confidence: 'high',
    };
    fieldLocations.signatureDate = loc;
    fieldLocations.signDate = loc;
  }

  if (documentDate) {
    fieldLocations.documentDate = fieldLocations.topRightDate || fieldLocations.signatureDate;
  }

  const sigBoxes = getBoxesForPage(signaturePage);
  if (signer) {
    const bbox = findLinesBBoxByQuery(sigBoxes, signer, 0.1, 1);
    fieldLocations.signer = bbox
      ? { page: signaturePage, bbox, normalizedValue: signer, region: 'signature_zone', confidence: signerCandidates.length > 1 ? 'medium' : 'high' }
      : { page: signaturePage, estimated: true, normalizedValue: signer, region: 'signature_zone', confidence: 'medium' };
  }

  if (signerRole) {
    const firstRolePart = signerRole.split(' - ')[0] || signerRole;
    const bbox =
      findLinesBBoxByQuery(sigBoxes, signerRole, 0.1, 1) ||
      findLinesBBoxByQuery(sigBoxes, firstRolePart, 0.1, 1);
    fieldLocations.signerRole = bbox
      ? { page: signaturePage, bbox, normalizedValue: signerRole, region: 'signature_zone', confidence: 'high' }
      : { page: signaturePage, estimated: true, normalizedValue: signerRole, region: 'signature_zone', confidence: 'medium' };
  }

  const fieldMeta: NonNullable<PdfExtractionResult['fieldMeta']> = {
    docNumber: {
      value: docNumber,
      rawText: docNumberRawText || undefined,
      confidence: docNumConfidence,
      score: docNumScore,
      signals: docNumSignals,
      region: 'region_a',
      candidates: docNumCandidates.length > 0 ? docNumCandidates : undefined,
      needsConfirmation: docNumberNeedsConfirmation,
      reason: docNumberReviewReason || undefined,
    },
    issueDate: {
      value: issueDate,
      rawText: topRightDate?.rawText || undefined,
      confidence: issueDateConfidence,
      score: issueDateScore,
      signals: issueDateSignals,
      region: 'region_b',
      candidates: issueDateCandidates.length > 0 ? issueDateCandidates : undefined,
      needsConfirmation: issueDateNeedsConfirmation,
      reason: issueDateReviewReason || undefined,
    },
    parentAgency: {
      value: parentAgency,
      confidence: parentAgency ? (headerAnalysis.agencyNeedsReview ? 'medium' : 'high') : 'low',
      score: parentAgency ? (headerAnalysis.agencyNeedsReview ? 68 : 90) : 0,
      signals: parentAgency ? ['Nhận diện tại Vùng A phía trên cơ quan ban hành'] : ['Không có cơ quan chủ quản riêng'],
      region: 'region_a',
      needsConfirmation: Boolean(parentAgency && headerAnalysis.agencyNeedsReview),
    },
    issuingAgency: {
      value: issuingAgency,
      confidence: issuingAgency ? (headerAnalysis.agencyNeedsReview ? 'medium' : 'high') : 'low',
      score: issuingAgency ? (headerAnalysis.agencyNeedsReview ? 65 : 90) : 0,
      signals: issuingAgency ? ['Nhận diện tại Vùng A phía trên dòng "Số:"'] : ['Chưa nhận diện được cơ quan ban hành'],
      region: 'region_a',
      needsConfirmation: Boolean(!issuingAgency || headerAnalysis.agencyNeedsReview),
      reason: headerAnalysis.agencyReviewReason || undefined,
    },
    docType: {
      value: docType,
      confidence: docType ? (subjectRes.docTypeBBox ? 'high' : 'medium') : 'low',
      score: docType ? (subjectRes.docTypeBBox ? 92 : 70) : 0,
      signals: docType
        ? [subjectRes.docTypeBBox ? 'Khớp tiêu đề loại văn bản trên Trang 1' : 'Suy luận từ ký hiệu số văn bản']
        : ['Chưa xác định loại văn bản'],
      region: 'title_zone',
      needsConfirmation: !docType,
    },
    docName: {
      value: docName,
      confidence: docName && !isGenericBareDocName(docName) ? 'high' : 'low',
      score: docName && !isGenericBareDocName(docName) ? 88 : 25,
      signals: docName ? ['Trích xuất từ tiêu đề/trích yếu Trang 1'] : ['Chưa có tên văn bản'],
      region: 'title_zone',
      needsConfirmation: !docName || isGenericBareDocName(docName),
    },
    signer: {
      value: signer,
      confidence: signer ? (signerCandidates.length > 1 ? 'medium' : 'high') : 'low',
      score: signer ? (signerCandidates.length > 1 ? 64 : 86) : 0,
      signals: signer ? [`Trích xuất tại khối chữ ký Trang ${signaturePage}`] : ['Chưa nhận diện người ký'],
      region: 'signature_zone',
      candidates: signerCandidates.length > 0 ? signerCandidates : undefined,
      needsConfirmation: !signer || signerCandidates.length > 1,
    },
  };

  const headerLayout: HeaderLayoutInfo = {
    splitX: Number(headerAnalysis.splitX.toFixed(3)),
    regionABBox: headerAnalysis.regionABBox,
    regionBBBox: topRightAnalysis.regionBBBox || headerAnalysis.regionBBBox,
    skewDegrees: headerAnalysis.skewDegrees,
  };

  const needsReview = reviewReasons.length > 0 || docNumberNeedsConfirmation || issueDateNeedsConfirmation;

  const pageTexts: PdfPageContent[] = [];
  for (let p = 1; p <= pageCount; p++) {
    pageTexts.push({
      page: p,
      text: (pageTextByNum.get(p) || '').trim(),
    });
  }
  const indexedPageCount = pageTexts.filter((p) => countMeaningfulChars(p.text) >= 10).length;

  return {
    sha256,
    pageTexts,
    extraction: {
      docNumber,
      docType: docType || undefined,
      docNumberNeedsConfirmation,
      docNumberReviewReason: docNumberReviewReason || undefined,
      docNumberResolution,
      filenameDocNumberHint: filenameDocNumberHint || undefined,
      issueDateNeedsConfirmation,
      issueDateReviewReason: issueDateReviewReason || undefined,
      docName,
      title,
      documentDate,
      issueDate,
      signDate,
      dateComparisonStatus,
      topRightDate,
      signatureDate,
      signer,
      signerRole,
      parentAgency,
      issuingAgency,
      needsReview,
      reviewReasons,
      relevantPages,
      usedOcr,
      aiUsed,
      ocrConfidence,
      pageCount,
      signerCandidates,
      fieldLocations,
      fieldMeta,
      headerLayout,
      indexedPageCount,
      ignoredDigitalSignatureDate,
    },
  };
}
