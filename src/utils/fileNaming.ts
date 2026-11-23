/**
 * Utility for formatting document filenames for computer & Google Drive storage.
 * Converts '/' to '.', keeps Vietnamese diacritics, uppercases the entire stem before extension,
 * and formats as "<SỐ KÝ HIỆU> - <TÊN VĂN BẢN>".
 *
 * Examples:
 * - 03-TB/ĐTN + Thông báo KQ cuộc thi video Tri ân thầy cô (.docx)
 *   => 03-TB.ĐTN - THÔNG BÁO KQ CUỘC THI VIDEO TRI ÂN THẦY CÔ.docx
 * - 1234/SGDĐT-GDTrH + Hướng dẫn tổ chức hoạt động giáo dục (.pdf)
 *   => 1234.SGDĐT-GDTrH - HƯỚNG DẪN TỔ CHỨC HOẠT ĐỘNG GIÁO DỤC.pdf
 */

export function removeVietnameseDiacritics(str: string): string {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

/**
 * Cleans string for safe filesystem filename
 */
export function sanitizeFileName(name: string): string {
  if (!name) return '';
  return name
    .replace(/[\/]/g, '.')
    .replace(/[\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generates suggested document filename without extension:
 * "<SỐ KÝ HIỆU (đổi / thành .)> - <TÊN VĂN BẢN (in hoa toàn bộ, giữ dấu tiếng Việt)>"
 */
export function generateSuggestedFileName(fullDocNumber: string, docName: string): string {
  const safeDocNumber = (fullDocNumber || '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\//g, '.')
    .replace(/[\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .trim()
    .toLocaleUpperCase('vi-VN');

  const safeDocName = (docName || '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\//g, '.')
    .replace(/[\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .trim()
    .toLocaleUpperCase('vi-VN');

  if (safeDocNumber && safeDocName) {
    return `${safeDocNumber} - ${safeDocName}`;
  } else if (safeDocNumber) {
    return safeDocNumber;
  } else if (safeDocName) {
    return safeDocName;
  }
  return '';
}

export const DEFAULT_MAX_WORD_MB = 10;

export function getWordFileExtension(fileName: string): '.doc' | '.docx' | null {
  if (!fileName) return null;
  const lower = fileName.trim().toLowerCase();
  if (lower.endsWith('.docx')) return '.docx';
  if (lower.endsWith('.doc')) return '.doc';
  return null;
}

export function getSupportedAttachmentExtension(fileNameOrExt: string): '.doc' | '.docx' | '.pdf' | null {
  if (!fileNameOrExt) return null;
  const lower = fileNameOrExt.trim().toLowerCase();
  if (lower === '.pdf' || lower.endsWith('.pdf')) return '.pdf';
  if (lower === '.docx' || lower.endsWith('.docx')) return '.docx';
  if (lower === '.doc' || lower.endsWith('.doc')) return '.doc';
  return null;
}

/**
 * Unified filename builder used for ALL uploads (internal Word attachments, PDF from URL, PDF from file).
 * Reuses the exact "<SỐ KÝ HIỆU> - <TÊN VĂN BẢN>.<ext>" template, converts '/' -> '.',
 * uppercases the full stem while preserving Vietnamese diacritics, and keeps the lowercase extension (.doc, .docx, .pdf).
 */
export function buildStandardDriveFileName(
  fullDocNumber: string,
  docName: string,
  originalNameOrExt: string
): string {
  const ext = getSupportedAttachmentExtension(originalNameOrExt) || '.docx';
  let baseName = generateSuggestedFileName(fullDocNumber, docName)
    .replace(/[. ]+$/g, '')
    .trim()
    .toLocaleUpperCase('vi-VN');

  if (!baseName) {
    baseName = 'VAN_BAN';
  }
  if (baseName.length > 180) {
    baseName = baseName.slice(0, 180).replace(/[-. ]+$/g, '').trim();
  }
  return `${baseName}${ext}`;
}

function isRealCalendarDate(dNum: number, mNum: number, yNum: number): boolean {
  if (
    !Number.isFinite(dNum) ||
    !Number.isFinite(mNum) ||
    !Number.isFinite(yNum) ||
    dNum < 1 ||
    dNum > 31 ||
    mNum < 1 ||
    mNum > 12 ||
    yNum < 1900 ||
    yNum > 2100
  ) {
    return false;
  }
  const probe = new Date(Date.UTC(yNum, mNum - 1, dNum));
  return (
    probe.getUTCFullYear() === yNum &&
    probe.getUTCMonth() === mNum - 1 &&
    probe.getUTCDate() === dNum
  );
}

export function isValidCalendarDateDdMmYyyy(raw: string | undefined | null): boolean {
  const m = (raw || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return false;
  return isRealCalendarDate(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
}

/**
 * Normalizes any date or date-time string into date-only "dd/MM/yyyy" (no HH:mm or HH:mm:ss).
 * Validates actual calendar dates (e.g. rejects 31/02/2026) and returns '' if empty or invalid when parsed.
 */
export function normalizeDateOnlyDdMmYyyy(raw: string | undefined | null): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';

  const formatValid = (dNum: number, mNum: number, yNum: number): string => {
    if (!isRealCalendarDate(dNum, mNum, yNum)) {
      return '';
    }
    return `${String(dNum).padStart(2, '0')}/${String(mNum).padStart(2, '0')}/${yNum}`;
  };

  // 1. "ngày 14 tháng 11 năm 2026" or "ngày10 tháng 11 năm 2026" (handles missing/extra spaces)
  const vnText = trimmed.match(/ng[àa]y\s*(\d{1,2})\s*th[áa]ng\s*(\d{1,2})\s*n[ăa]m\s*(\d{4})/i);
  if (vnText) {
    return formatValid(parseInt(vnText[1], 10), parseInt(vnText[2], 10), parseInt(vnText[3], 10));
  }

  // 2. ISO yyyy-MM-dd or yyyy/MM/dd (with optional T... or HH:mm:ss)
  const isoMatch = trimmed.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[T\s,]+.*)?$/);
  if (isoMatch) {
    return formatValid(parseInt(isoMatch[3], 10), parseInt(isoMatch[2], 10), parseInt(isoMatch[1], 10));
  }

  // 3. dd/MM/yyyy, dd-MM-yyyy, dd.MM.yyyy (with optional HH:mm or HH:mm:ss)
  const dmyMatch = trimmed.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})(?:[T\s,]+\d{1,2}:\d{2}(?::\d{2})?.*)?$/);
  if (dmyMatch) {
    const rawYear = dmyMatch[3];
    const yNum = rawYear.length === 2 ? parseInt(`20${rawYear}`, 10) : parseInt(rawYear, 10);
    return formatValid(parseInt(dmyMatch[1], 10), parseInt(dmyMatch[2], 10), yNum);
  }

  return '';
}

/**
 * Backward-compatible alias for Word attachment callers
 */
export function buildWordDriveFileName(
  fullDocNumber: string,
  docName: string,
  originalFileName: string
): string {
  return buildStandardDriveFileName(fullDocNumber, docName, originalFileName);
}

export function appendConflictSuffix(fileName: string, index = 2): string {
  const ext = getSupportedAttachmentExtension(fileName) || '';
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  return `${base} (${index})${ext}`;
}

export function sanitizeCustomDriveFileName(
  inputName: string,
  requiredExt: '.doc' | '.docx' | '.pdf'
): string {
  let cleaned = (inputName || '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\//g, '.')
    .replace(/[\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.toLowerCase().endsWith(requiredExt)) {
    cleaned = cleaned.slice(0, -requiredExt.length).trim();
  } else {
    const anyExt = getSupportedAttachmentExtension(cleaned);
    if (anyExt) {
      cleaned = cleaned.slice(0, -anyExt.length).trim();
    }
  }
  cleaned = cleaned.replace(/[. ]+$/g, '').trim().toLocaleUpperCase('vi-VN');
  if (!cleaned) cleaned = 'VAN_BAN';
  if (cleaned.length > 180) cleaned = cleaned.slice(0, 180).replace(/[-. ]+$/g, '').trim();
  return `${cleaned}${requiredExt}`;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Extracts Google Drive Folder ID from a URL or raw ID string.
 * Supports:
 * - https://drive.google.com/drive/folders/FOLDER_ID
 * - https://drive.google.com/drive/u/0/folders/FOLDER_ID?usp=sharing
 * - https://drive.google.com/open?id=FOLDER_ID
 * - Raw folder ID string
 */
export function extractGoogleDriveFolderId(input: string): string {
  const raw = (input || '').trim();
  if (!raw) return '';

  const folderMatch = raw.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  if (folderMatch) return folderMatch[1];

  const idParamMatch = raw.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (idParamMatch) return idParamMatch[1];

  if (/^[a-zA-Z0-9_-]{10,}$/.test(raw) && !raw.includes('http')) {
    return raw;
  }

  return '';
}

export function normalizeCompareText(input: string | undefined | null): string {
  if (!input) return '';
  return removeVietnameseDiacritics(input)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeDocNumberForCompare(input: string | undefined | null): string {
  if (!input) return '';
  return removeVietnameseDiacritics(input)
    .toLowerCase()
    .replace(/\s*([\/\-])\s*/g, '$1')
    .replace(/\s+/g, '')
    .trim();
}

export function getDocumentFilterYear(doc: {
  docCategory?: 'outgoing' | 'incoming';
  issueDate?: string;
  year?: number;
}): number | 'unknown' {
  if (doc.docCategory === 'incoming') {
    const cleanIssue = normalizeDateOnlyDdMmYyyy(doc.issueDate || '');
    if (!cleanIssue) return 'unknown';
    const parts = cleanIssue.split('/');
    if (parts.length === 3 && /^\d{4}$/.test(parts[2])) {
      const y = parseInt(parts[2], 10);
      if (Number.isFinite(y) && y >= 1900 && y <= 2100) {
        return y;
      }
    }
    return 'unknown';
  }
  return typeof doc.year === 'number' && Number.isFinite(doc.year) ? doc.year : 'unknown';
}

/**
 * Hàm chuẩn hóa Số/ký hiệu văn bản thống nhất cho toàn hệ thống (backend OCR/Gemini/filename & frontend).
 * - Chỉ loại bỏ nhãn "Số:" / "Số" / "Số/Ký hiệu:" ở đầu, tuyệt đối KHÔNG xóa chữ số thực tế hoặc số 0 ở đầu.
 * - Chuẩn hóa khoảng trắng quanh "/" và "-".
 * - Giữ nguyên ký hiệu và dấu tiếng Việt (chuẩn hóa Ð U+00D0 -> Đ U+0110).
 * - Giữ nguyên trạng thái thiếu số (vd "/QĐ-SGDĐT"), tuyệt đối không tự bịa phần số.
 */
export function normalizeDocNumber(rawInput: string | undefined | null): string {
  if (!rawInput) return '';
  let cleaned = String(rawInput)
    .normalize('NFC')
    .replace(/\u00D0/g, 'Đ')
    .replace(/\u00F0/g, 'đ')
    .replace(/^[\s_\-—–=~*•·.]+/, '')
    .trim();
  if (!cleaned) return '';

  // Chỉ bóc nhãn "Số:", "Số", "Số/Ký hiệu:", "S6:", "56:" ở đầu — không bao giờ xóa chữ số thực sự
  cleaned = cleaned.replace(
    /^(?:(?:S[ốoôơổộ6]|5[ốoôơổộ6])(?:\s*\/\s*K[ýy]\s*hi[ệe]u)?)\s*[:;\.]?\s*/iu,
    ''
  );

  cleaned = cleaned
    .replace(/^[\s:;.,\-–—]+/, '')
    .replace(/[ \t]*\/[ \t]*/g, '/')
    .replace(/[ \t]*[-–—][ \t]*/g, '-')
    .trim();
  if (!cleaned) return '';

  // Ghép chữ số bị tách kerning ngay trước dấu "/" hoặc "-" (vd "29 37/QĐ-SGDĐT" -> "2937/QĐ-SGDĐT")
  cleaned = cleaned.replace(/^([0-9OoIl]{1,3})\s+([0-9OoIl]{1,3})(?=[\/\-])/, '$1$2');

  // Sửa lỗi OCR nhẹ CHỈ ở phần chữ số đứng trước dấu "/" hoặc "-" (vd "O5/TB-ĐTN" -> "05/TB-ĐTN")
  cleaned = cleaned.replace(/^([0-9OoIl]{1,5})([\/\-])/, (_, numPart: string, sep: string) => {
    const fixedNum = numPart.replace(/[Oo]/g, '0').replace(/[Il]/g, '1');
    return `${fixedNum}${sep}`;
  });

  // Ghép ký hiệu cơ quan viết hoa bị OCR tách khoảng trắng sau dấu "-" (vd "8773/KH-SGD ĐT" -> "8773/KH-SGDĐT")
  cleaned = cleaned.replace(
    /^([0-9]{1,5}[\/\-][\p{Lu}\p{N}_\-\.\/]+-[\p{Lu}Đ]{1,6})\s+([\p{Lu}Đ]{1,5})(?=\s|$|[.,;])/u,
    (full, left: string, tail: string) => {
      const tailNorm = removeVietnameseDiacritics(tail).toUpperCase();
      if (/^(?:NGAY|THANG|NAM|AN|CONG|DOC|KE|QUYET|THONG|BAO|KINH|CAN|VV)$/.test(tailNorm)) {
        return full;
      }
      return `${left}${tail}`;
    }
  );

  // 1. Khớp đầy đủ dạng chuẩn: số đầu (giữ số 0) + "/" hoặc "-" + ký hiệu (giữ dấu tiếng Việt)
  const primaryMatch = cleaned.match(/^([0-9]{1,5}[\/\-][\p{L}\p{N}_\-\.\/]+)/u);
  let candidate = primaryMatch ? primaryMatch[1] : '';

  if (!candidate) {
    // 2. Trường hợp thiếu phần số đứng trước dấu "/" (vd "/QĐ-SGDĐT") -> giữ nguyên trạng thái thiếu số để đối chiếu
    const suffixOnlyMatch = cleaned.match(/^(\/[\p{L}][\p{L}\p{N}_\-\.\/]*)/u);
    if (suffixOnlyMatch) {
      candidate = suffixOnlyMatch[1];
    } else {
      // 3. Trường hợp chỉ có chữ số thuần (vd "2937") để hỗ trợ ghép ngữ cảnh
      const digitsOnlyMatch = cleaned.match(/^([0-9]{1,5})(?=\s|$)/);
      candidate = digitsOnlyMatch ? digitsOnlyMatch[1] : (cleaned.split(/\s+/)[0] || '');
    }
  }

  candidate = candidate.replace(/[.,;:\)]+$/g, '').trim();
  if (!candidate) return '';

  // Tuyệt đối không nhận ngày tháng (10/11/2026, 18-11-26) làm số văn bản
  if (/^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}$/.test(candidate)) return '';
  if (/^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}$/.test(candidate)) return '';
  return candidate;
}

export interface ParsedDocNumberComponents {
  normalized: string;
  numberPart: string; // giữ nguyên số 0 đầu (vd "2937", "01", "003") hoặc "" nếu thiếu
  sep: '/' | '-';
  symbolPart: string; // phần ký hiệu sau dấu phân tách đầu tiên (vd "QĐ-SGDĐT", "KH/ĐTN")
  docTypePart: string; // mã loại văn bản đầu tiên trong symbolPart (vd "QĐ", "KH", "TB")
  agencyPart: string; // phần cơ quan phía sau (vd "SGDĐT", "ĐTN", "THPTNCT")
  isComplete: boolean;
}

export function parseDocNumberComponents(raw: string | undefined | null): ParsedDocNumberComponents {
  const normalized = normalizeDocNumber(raw);
  if (!normalized) {
    return {
      normalized: '',
      numberPart: '',
      sep: '/',
      symbolPart: '',
      docTypePart: '',
      agencyPart: '',
      isComplete: false,
    };
  }

  // Đầy đủ: "2937/QĐ-SGDĐT" hoặc "01-KH/ĐTN"
  const fullMatch = normalized.match(/^(\d{1,5})([\/\-])([\p{L}\p{N}_\-\.\/]+)$/u);
  if (fullMatch) {
    const [, numberPart, sepRaw, symbolPart] = fullMatch;
    const sep: '/' | '-' = sepRaw === '-' ? '-' : '/';
    const symTokens = symbolPart.split(/[\/\-]/).filter(Boolean);
    const docTypePart = symTokens[0] || '';
    const agencyPart = symTokens.slice(1).join('-');
    const isComplete = Boolean(numberPart && symbolPart && /[\p{L}]/u.test(symbolPart));
    return {
      normalized,
      numberPart,
      sep,
      symbolPart,
      docTypePart,
      agencyPart,
      isComplete,
    };
  }

  // Thiếu phần số ở đầu: "/QĐ-SGDĐT"
  const suffixMatch = normalized.match(/^([\/\-])([\p{L}][\p{L}\p{N}_\-\.\/]*)$/u);
  if (suffixMatch) {
    const [, sepRaw, symbolPart] = suffixMatch;
    const sep: '/' | '-' = sepRaw === '-' ? '-' : '/';
    const symTokens = symbolPart.split(/[\/\-]/).filter(Boolean);
    return {
      normalized,
      numberPart: '',
      sep,
      symbolPart,
      docTypePart: symTokens[0] || '',
      agencyPart: symTokens.slice(1).join('-'),
      isComplete: false,
    };
  }

  // Chỉ có chữ số thuần: "2937"
  if (/^\d{1,5}$/.test(normalized)) {
    return {
      normalized,
      numberPart: normalized,
      sep: '/',
      symbolPart: '',
      docTypePart: '',
      agencyPart: '',
      isComplete: false,
    };
  }

  return {
    normalized,
    numberPart: '',
    sep: '/',
    symbolPart: normalized,
    docTypePart: normalized.split(/[\/\-]/)[0] || '',
    agencyPart: normalized.split(/[\/\-]/).slice(1).join('-'),
    isComplete: false,
  };
}

export interface DocNumberReconciliationResult {
  status: 'verified_pdf' | 'reconciled_from_filename' | 'conflict' | 'incomplete';
  finalDocNumber: string;
  proposedDocNumber?: string;
  needsConfirmation: boolean;
  hasConflict: boolean;
  reason: string;
  sourceSummary: string;
}

/**
 * Đối chiếu và kết hợp thông minh giữa kết quả đọc trên PDF (OCR/Text/AI) và gợi ý từ tên tệp gốc.
 * Quy tắc:
 * - Tách số & ký hiệu độc lập; kiểm tra tương thích không dấu trước khi ghép.
 * - Giữ nguyên phần ký hiệu có dấu tiếng Việt từ PDF (vd OCR "/QĐ-SGDĐT" + tên tệp "2937/QĐ" -> "2937/QĐ-SGDĐT").
 * - Không tự ghép nếu có mâu thuẫn loại văn bản hoặc cơ quan; trả trạng thái conflict để người dùng chọn.
 * - Không tự tạo phần số nếu không có bằng chứng.
 */
export function reconcileDocNumberWithFilename(
  pdfRaw: string | undefined | null,
  filenameHintRaw: string | undefined | null
): DocNumberReconciliationResult {
  const pdf = parseDocNumberComponents(pdfRaw);
  const hint = parseDocNumberComponents(filenameHintRaw);

  const normToken = (s: string) =>
    removeVietnameseDiacritics(s || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');

  const docTypesCompatible = (a: string, b: string): boolean => {
    const na = normToken(a);
    const nb = normToken(b);
    if (!na || !nb) return true;
    return na === nb || na.startsWith(nb) || nb.startsWith(na);
  };

  const agenciesCompatible = (a: string, b: string): boolean => {
    const na = normToken(a);
    const nb = normToken(b);
    if (!na || !nb) return true;
    return na === nb || na.includes(nb) || nb.includes(na);
  };

  // Trường hợp 1: PDF đã có đầy đủ số + ký hiệu
  if (pdf.isComplete) {
    if (hint.numberPart) {
      const pdfNumInt = parseInt(pdf.numberPart, 10);
      const hintNumInt = parseInt(hint.numberPart, 10);
      if (Number.isFinite(pdfNumInt) && Number.isFinite(hintNumInt) && pdfNumInt !== hintNumInt) {
        return {
          status: 'conflict',
          finalDocNumber: pdf.normalized,
          needsConfirmation: true,
          hasConflict: true,
          reason: `Số văn bản trích từ PDF ("${pdf.normalized}") khác với gợi ý từ tên tệp ("${hint.normalized}"). Vui lòng đối chiếu bản PDF gốc và chọn đúng số.`,
          sourceSummary: `Mâu thuẫn giữa PDF (${pdf.normalized}) và tên tệp (${hint.normalized})`,
        };
      }
    }
    return {
      status: 'verified_pdf',
      finalDocNumber: pdf.normalized,
      needsConfirmation: false,
      hasConflict: false,
      reason: '',
      sourceSummary: hint.numberPart
        ? `Xác minh trực tiếp trên PDF (${pdf.normalized}), khớp tên tệp (${hint.normalized})`
        : `Xác minh trực tiếp trên PDF (${pdf.normalized})`,
    };
  }

  // Trường hợp 2: PDF đọc được phần ký hiệu (vd "/QĐ-SGDĐT") nhưng mất phần số đầu, và tên tệp có phần số tương thích (vd "2937/QĐ")
  if (!pdf.numberPart && pdf.symbolPart && hint.numberPart) {
    const typeOk = docTypesCompatible(pdf.docTypePart, hint.docTypePart);
    const agencyOk = agenciesCompatible(pdf.agencyPart, hint.agencyPart);

    if (typeOk && agencyOk) {
      const merged = normalizeDocNumber(`${hint.numberPart}${pdf.sep}${pdf.symbolPart}`);
      return {
        status: 'reconciled_from_filename',
        finalDocNumber: merged,
        proposedDocNumber: merged,
        needsConfirmation: true,
        hasConflict: false,
        reason: `OCR trên PDF đọc được "${pdf.normalized}" (thiếu phần số đầu), kết hợp tương thích với tên tệp "${hint.normalized}" thành "${merged}". Vui lòng đối chiếu bản PDF gốc và xác nhận.`,
        sourceSummary: `Đề xuất từ OCR (${pdf.normalized}) + Tên tệp (${hint.normalized}) → ${merged}`,
      };
    }

    return {
      status: 'conflict',
      finalDocNumber: pdf.normalized,
      needsConfirmation: true,
      hasConflict: true,
      reason: `Ký hiệu trên PDF ("${pdf.normalized}") không khớp với gợi ý từ tên tệp ("${hint.normalized}"). Vui lòng kiểm tra bản PDF gốc và nhập đầy đủ.`,
      sourceSummary: `Mâu thuẫn giữa OCR (${pdf.normalized}) và tên tệp (${hint.normalized})`,
    };
  }

  // Trường hợp 3: PDF chỉ đọc được phần số thuần (vd "2937") và tên tệp có đầy đủ cùng số + ký hiệu (vd "2937/QĐ-SGDĐT")
  if (pdf.numberPart && !pdf.symbolPart && hint.isComplete) {
    if (parseInt(pdf.numberPart, 10) === parseInt(hint.numberPart, 10)) {
      const merged = normalizeDocNumber(`${pdf.numberPart}${hint.sep}${hint.symbolPart}`);
      return {
        status: 'reconciled_from_filename',
        finalDocNumber: merged,
        proposedDocNumber: merged,
        needsConfirmation: true,
        hasConflict: false,
        reason: `PDF đọc được phần số "${pdf.numberPart}", kết hợp với ký hiệu tương thích từ tên tệp "${hint.normalized}" thành "${merged}". Vui lòng xác nhận.`,
        sourceSummary: `Đề xuất từ PDF (${pdf.numberPart}) + Tên tệp (${hint.normalized}) → ${merged}`,
      };
    }
    return {
      status: 'conflict',
      finalDocNumber: pdf.normalized,
      needsConfirmation: true,
      hasConflict: true,
      reason: `Phần số trên PDF ("${pdf.numberPart}") khác với gợi ý tên tệp ("${hint.normalized}"). Vui lòng kiểm tra lại.`,
      sourceSummary: `Mâu thuẫn giữa PDF (${pdf.numberPart}) và tên tệp (${hint.normalized})`,
    };
  }

  // Trường hợp 4: Không đủ dữ liệu để kết hợp có căn cứ -> giữ nguyên trạng thái thiếu, không tự bịa số
  return {
    status: 'incomplete',
    finalDocNumber: pdf.normalized,
    needsConfirmation: true,
    hasConflict: false,
    reason: pdf.normalized
      ? `Số/ký hiệu đọc được ("${pdf.normalized}") chưa đầy đủ. Vui lòng đối chiếu góc trên bên trái trang 1 bản PDF gốc và nhập đủ.`
      : 'Chưa nhận diện được Số/ký hiệu văn bản ở góc trên bên trái trang 1.',
    sourceSummary: pdf.normalized
      ? `Chưa đủ căn cứ để bổ sung cho "${pdf.normalized}"`
      : 'Chưa nhận diện được số văn bản',
  };
}



