import crypto from 'crypto';
import type { ArchiveDriveCandidate, DriveDeleteFileResult, GoogleDriveConfig } from '../src/types.js';
import {
  buildStandardDriveFileName,
  DEFAULT_MAX_WORD_MB,
  extractGoogleDriveFolderId,
  getSupportedAttachmentExtension,
  getWordFileExtension,
  sanitizeCustomDriveFileName,
} from '../src/utils/fileNaming.js';

export function getMaxWordFileSizeMB(): number {
  const envVal = process.env.MAX_WORD_UPLOAD_MB ? parseFloat(process.env.MAX_WORD_UPLOAD_MB) : DEFAULT_MAX_WORD_MB;
  if (!Number.isFinite(envVal) || envVal < 1) return DEFAULT_MAX_WORD_MB;
  return Math.min(Math.floor(envVal), 50);
}

export function getMaxWordFileSizeBytes(): number {
  return getMaxWordFileSizeMB() * 1024 * 1024;
}

export interface WordFileValidationResult {
  valid: boolean;
  error?: string;
  extension?: '.doc' | '.docx';
  normalizedMimeType?: string;
}

export function validateWordFileBuffer(
  originalName: string,
  mimeType: string,
  buffer: Buffer
): WordFileValidationResult {
  const ext = getWordFileExtension(originalName);
  if (!ext) {
    return {
      valid: false,
      error: 'Định dạng tệp không hợp lệ. Hệ thống chỉ chấp nhận tệp Word (.doc hoặc .docx).',
    };
  }

  if (!buffer || buffer.length === 0) {
    return {
      valid: false,
      error: 'Tệp Word được chọn đang bị rỗng (0 bytes). Vui lòng kiểm tra lại.',
    };
  }

  const maxBytes = getMaxWordFileSizeBytes();
  const maxMB = getMaxWordFileSizeMB();
  if (buffer.length > maxBytes) {
    return {
      valid: false,
      error: `Dung lượng tệp vượt quá giới hạn tối đa ${maxMB} MB của hệ thống.`,
    };
  }

  // Reject disguised non-Word files by magic bytes
  const head4 = buffer.subarray(0, 4);
  const headStr = head4.toString('latin1');
  if (headStr === '%PDF') {
    return { valid: false, error: 'Tệp này là PDF, không phải tệp Word (.doc/.docx).' };
  }
  if (headStr.startsWith('MZ')) {
    return { valid: false, error: 'Không chấp nhận tệp thực thi.' };
  }
  if (head4[0] === 0x89 && headStr.slice(1, 4) === 'PNG') {
    return { valid: false, error: 'Tệp này là ảnh PNG, không phải tệp Word.' };
  }
  if (head4[0] === 0xff && head4[1] === 0xd8 && head4[2] === 0xff) {
    return { valid: false, error: 'Tệp này là ảnh JPEG, không phải tệp Word.' };
  }

  if (ext === '.docx') {
    // .docx is an OpenXML ZIP archive starting with PK (0x50 0x4B)
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      return {
        valid: false,
        error: 'Nội dung tệp .docx không hợp lệ (không đúng cấu trúc chuẩn Microsoft Word OpenXML).',
      };
    }
    return {
      valid: true,
      extension: '.docx',
      normalizedMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
  }

  // .doc: OLE2 (D0 CF 11 E0), RTF ({\rtf), or Word XML/HTML (<)
  const isOle2 =
    buffer.length >= 8 &&
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0;
  const trimmedHead = buffer.subarray(0, 64).toString('utf8').trimStart();
  const isRtfOrXml = trimmedHead.startsWith('{\\rtf') || trimmedHead.startsWith('<');
  if (!isOle2 && !isRtfOrXml) {
    return {
      valid: false,
      error: 'Nội dung tệp .doc không hợp lệ (không đúng định dạng Microsoft Word .doc).',
    };
  }

  return {
    valid: true,
    extension: '.doc',
    normalizedMimeType: 'application/msword',
  };
}

export interface PdfFileValidationResult {
  valid: boolean;
  error?: string;
}

export function validatePdfFileBuffer(
  originalName: string,
  mimeType: string,
  buffer: Buffer
): PdfFileValidationResult {
  if (!buffer || buffer.length === 0) {
    return { valid: false, error: 'Tệp PDF đang bị rỗng (0 bytes).' };
  }
  const maxBytes = getMaxWordFileSizeBytes();
  const maxMB = getMaxWordFileSizeMB();
  if (buffer.length > maxBytes) {
    return {
      valid: false,
      error: `Dung lượng tệp PDF vượt quá giới hạn tối đa ${maxMB} MB của hệ thống.`,
    };
  }

  // Kiểm tra chữ ký %PDF- trong 1024 byte đầu tiên theo chuẩn PDF
  const headText = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('latin1');
  if (!headText.includes('%PDF-')) {
    const ext = (originalName || '').toLowerCase();
    if (headText.trimStart().startsWith('<!DOCTYPE') || headText.trimStart().startsWith('<html') || mimeType.includes('text/html')) {
      return {
        valid: false,
        error: 'Nội dung nhận được là trang web/HTML (có thể yêu cầu đăng nhập hoặc không phải liên kết tải trực tiếp), không phải tệp PDF.',
      };
    }
    return {
      valid: false,
      error: `Nội dung tệp${ext ? ` (${originalName})` : ''} không phải định dạng PDF hợp lệ (thiếu chữ ký %PDF).`,
    };
  }

  return { valid: true };
}

export interface ParsedServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export function parseServiceAccountJson(rawJson: string): {
  parsed?: ParsedServiceAccount;
  error?: string;
} {
  if (!rawJson || !rawJson.trim()) {
    return { error: 'Chưa cung cấp nội dung JSON Tài khoản dịch vụ (Service Account).' };
  }
  try {
    const obj = JSON.parse(rawJson.trim());
    if (!obj.client_email || !obj.private_key) {
      return {
        error: 'Tệp JSON Tài khoản dịch vụ thiếu trường bắt buộc (client_email hoặc private_key).',
      };
    }
    if (!String(obj.private_key).includes('BEGIN PRIVATE KEY')) {
      return {
        error: 'Khóa private_key trong JSON Tài khoản dịch vụ không đúng định dạng PEM.',
      };
    }
    return {
      parsed: {
        client_email: String(obj.client_email).trim(),
        private_key: String(obj.private_key).replace(/\\n/g, '\n'),
        token_uri: obj.token_uri ? String(obj.token_uri).trim() : 'https://oauth2.googleapis.com/token',
      },
    };
  } catch {
    return { error: 'Nội dung Tài khoản dịch vụ không phải JSON hợp lệ.' };
  }
}

export const UNKNOWN_DRIVE_YEAR_FOLDER = 'Chưa xác định năm';

export interface DriveFolderCacheEntry {
  bookFolderId?: string;
  yearFolderId?: string;
  categoryFolderId: string;
  folderPath: string;
  updatedAt: string;
}

export function normalizeDriveArchiveYearLabel(year?: number | string | null): string {
  if (typeof year === 'number' && Number.isFinite(year) && year >= 1900 && year <= 2100) {
    return String(Math.trunc(year));
  }
  if (typeof year === 'string') {
    const trimmed = year.trim();
    if (!trimmed || trimmed === 'unknown' || trimmed.toLowerCase() === 'chưa xác định năm') {
      return UNKNOWN_DRIVE_YEAR_FOLDER;
    }
    if (/^\d{4}$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      if (n >= 1900 && n <= 2100) return String(n);
    }
  }
  return UNKNOWN_DRIVE_YEAR_FOLDER;
}

export const DELETED_DRIVE_FOLDER_NAME = 'VB đã xóa';

export function buildDriveFolderHierarchy(
  bookName: string,
  year: number | string | null | undefined,
  docCategory: 'outgoing' | 'incoming'
): { bookFolder: string; yearFolder: string; categoryFolder: string; displayPath: string } {
  const cleanBook = (bookName || 'Sổ văn bản').trim();
  const yearStr = normalizeDriveArchiveYearLabel(year);
  const cat = docCategory === 'incoming' ? 'Văn bản đến' : 'Văn bản đi';
  return {
    bookFolder: cleanBook,
    yearFolder: yearStr,
    categoryFolder: cat,
    displayPath: `${cleanBook}/${yearStr}/${cat}`,
  };
}

export function buildDeletedDriveFolderHierarchy(
  bookName: string,
  year: number | string | null | undefined
): { bookFolder: string; yearFolder: string; categoryFolder: string; displayPath: string } {
  const cleanBook = (bookName || 'Sổ văn bản').trim();
  const yearStr = normalizeDriveArchiveYearLabel(year);
  return {
    bookFolder: cleanBook,
    yearFolder: yearStr,
    categoryFolder: DELETED_DRIVE_FOLDER_NAME,
    displayPath: `${cleanBook}/${yearStr}/${DELETED_DRIVE_FOLDER_NAME}`,
  };
}

export interface ResolvedGoogleDriveConfig {
  enabled: boolean;
  authMode: 'apps_script' | 'service_account';
  folderUrl: string;
  folderId: string;
  folderName?: string;
  appsScriptUrl: string;
  serviceAccountJson: string;
  serviceAccountEmail: string;
  isConfigured: boolean;
  missingReason?: string;
}

export function resolveEffectiveDriveConfig(
  stored?: GoogleDriveConfig,
  unitCode?: string,
  bookDriveConfig?: Partial<GoogleDriveConfig>,
  isDefaultBook: boolean = true
): ResolvedGoogleDriveConfig {
  const envEnabled =
    isDefaultBook && process.env.GOOGLE_DRIVE_ENABLED !== undefined
      ? process.env.GOOGLE_DRIVE_ENABLED === 'true'
      : undefined;
  const envAuthMode = process.env.GOOGLE_DRIVE_AUTH_MODE as 'apps_script' | 'service_account' | undefined;
  const envFolderId = isDefaultBook
    ? extractGoogleDriveFolderId(process.env.GOOGLE_DRIVE_FOLDER_ID || process.env.GOOGLE_DRIVE_FOLDER_URL || '')
    : '';
  const envAppsScriptUrl = (process.env.GOOGLE_DRIVE_APPS_SCRIPT_URL || '').trim();
  const envSaJson = (process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON || '').trim();

  // Sổ riêng (không phải mặc định) KHÔNG kế thừa enabled hoặc folderId của Đoàn trường để đảm bảo cô lập tuyệt đối thư mục & quyền Drive theo sổ
  const enabled =
    envEnabled !== undefined
      ? envEnabled
      : !isDefaultBook
      ? Boolean(bookDriveConfig?.enabled)
      : bookDriveConfig?.enabled !== undefined
      ? Boolean(bookDriveConfig.enabled)
      : Boolean(stored?.enabled);
  const authMode: 'apps_script' | 'service_account' =
    envAuthMode === 'service_account' || envAuthMode === 'apps_script'
      ? envAuthMode
      : bookDriveConfig?.authMode || stored?.authMode || 'apps_script';

  const bookFolderUrl = (bookDriveConfig?.folderUrl || '').trim();
  const bookFolderId = extractGoogleDriveFolderId(bookDriveConfig?.folderId || bookFolderUrl);
  const unitScope = isDefaultBook && unitCode && stored?.folderByUnit ? stored.folderByUnit[unitCode] : undefined;
  const folderUrl = !isDefaultBook
    ? bookFolderUrl
    : (
        bookFolderUrl ||
        unitScope?.folderUrl ||
        stored?.folderUrl ||
        process.env.GOOGLE_DRIVE_FOLDER_URL ||
        ''
      ).trim();
  const folderId = !isDefaultBook
    ? bookFolderId
    : envFolderId ||
      bookFolderId ||
      extractGoogleDriveFolderId(unitScope?.folderId || unitScope?.folderUrl || '') ||
      extractGoogleDriveFolderId(stored?.folderId || stored?.folderUrl || '');
  const folderName = !isDefaultBook
    ? bookDriveConfig?.folderName
    : (bookFolderId ? bookDriveConfig?.folderName : undefined) || unitScope?.folderName || stored?.folderName;

  const appsScriptUrl =
    envAppsScriptUrl ||
    (bookDriveConfig?.appsScriptUrl || '').trim() ||
    (stored?.appsScriptUrl || '').trim();
  const serviceAccountJson =
    envSaJson ||
    (bookDriveConfig?.serviceAccountJson || '').trim() ||
    (stored?.serviceAccountJson || '').trim();
  const parsedSa = serviceAccountJson ? parseServiceAccountJson(serviceAccountJson) : {};
  const serviceAccountEmail =
    parsedSa.parsed?.client_email ||
    bookDriveConfig?.serviceAccountEmail ||
    stored?.serviceAccountEmail ||
    '';

  let isConfigured = false;
  let missingReason: string | undefined;

  if (!enabled) {
    missingReason = 'Chưa bật lưu trữ tệp văn bản (Word/PDF) lên Google Drive cho sổ này.';
  } else if (!folderId) {
    missingReason = 'Chưa cấu hình URL hoặc ID thư mục Google Drive riêng cho sổ này.';
  } else if (authMode === 'apps_script') {
    if (!appsScriptUrl) {
      missingReason = 'Chưa cấu hình URL Web App Apps Script kết nối Google Drive.';
    } else {
      isConfigured = true;
    }
  } else {
    if (!serviceAccountJson || parsedSa.error) {
      missingReason = parsedSa.error || 'Chưa cấu hình khóa JSON Tài khoản dịch vụ (Service Account).';
    } else {
      isConfigured = true;
    }
  }

  return {
    enabled,
    authMode,
    folderUrl,
    folderId,
    folderName,
    appsScriptUrl,
    serviceAccountJson,
    serviceAccountEmail,
    isConfigured,
    missingReason,
  };
}

function maskUrl(url: string): string {
  if (!url) return '';
  if (url.length <= 42) return 'Đã cấu hình URL bảo mật';
  return `${url.slice(0, 36)}••••${url.slice(-10)}`;
}

export function sanitizeDriveConfigForClient(
  stored: GoogleDriveConfig | undefined,
  isAdmin: boolean,
  unitCode?: string,
  bookDriveConfig?: Partial<GoogleDriveConfig>,
  isDefaultBook: boolean = true
): GoogleDriveConfig {
  const effective = resolveEffectiveDriveConfig(stored, unitCode, bookDriveConfig, isDefaultBook);
  const maxFileSizeMB = getMaxWordFileSizeMB();
  const maxFileSizeBytes = getMaxWordFileSizeBytes();

  if (!isAdmin) {
    return {
      enabled: effective.enabled,
      authMode: effective.authMode,
      folderUrl: '',
      folderId: '',
      folderName: effective.folderName,
      isConfigured: effective.isConfigured,
      maxFileSizeMB,
      maxFileSizeBytes,
      lastCheckMessage: effective.missingReason,
    };
  }

  const lastCheckedAt = isDefaultBook
    ? bookDriveConfig?.lastCheckedAt || stored?.lastCheckedAt
    : bookDriveConfig?.lastCheckedAt;
  const lastCheckStatus = isDefaultBook
    ? bookDriveConfig?.lastCheckStatus || stored?.lastCheckStatus
    : bookDriveConfig?.lastCheckStatus;
  const lastCheckMessage = isDefaultBook
    ? bookDriveConfig?.lastCheckMessage || stored?.lastCheckMessage || effective.missingReason
    : bookDriveConfig?.lastCheckMessage || effective.missingReason;

  return {
    enabled: effective.enabled,
    authMode: effective.authMode,
    folderUrl: effective.folderUrl,
    folderId: effective.folderId,
    folderName: effective.folderName,
    folderByUnit: isDefaultBook ? stored?.folderByUnit : undefined,
    hasAppsScriptUrl: Boolean(effective.appsScriptUrl),
    appsScriptUrlMasked: maskUrl(effective.appsScriptUrl),
    hasApiTokenConfigured: Boolean(getAppsScriptApiToken()),
    hasServiceAccount: Boolean(effective.serviceAccountJson),
    serviceAccountEmail: effective.serviceAccountEmail,
    isConfigured: effective.isConfigured,
    maxFileSizeMB,
    maxFileSizeBytes,
    lastCheckedAt,
    lastCheckStatus,
    lastCheckMessage,
  };
}

// --- Service Account OAuth2 JWT Token Minting ---
async function getServiceAccountAccessToken(sa: ParsedServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/drive',
      aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })
  ).toString('base64url');

  const unsigned = `${header}.${claim}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer.sign(sa.private_key, 'base64url');
  const jwt = `${unsigned}.${signature}`;

  const params = new URLSearchParams();
  params.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  params.set('assertion', jwt);

  const tokenRes = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data: any = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !data.access_token) {
    throw new Error(
      data.error_description || data.error || 'Không thể xác thực Tài khoản dịch vụ Google (JWT).'
    );
  }
  return data.access_token;
}

export type AppsScriptAuthErrorCode =
  | 'MISSING_APPS_SCRIPT_TOKEN'
  | 'APPS_SCRIPT_AUTH_FAILED'
  | 'APPS_SCRIPT_REDIRECT_BLOCKED'
  | 'APPS_SCRIPT_INVALID_URL';

export class AppsScriptAuthError extends Error {
  code: AppsScriptAuthErrorCode;
  constructor(code: AppsScriptAuthErrorCode, message: string) {
    super(message);
    this.name = 'AppsScriptAuthError';
    this.code = code;
  }
}

export function getAppsScriptApiToken(): string {
  return (process.env.NCT_API_TOKEN || '').trim();
}

export function scrubSecretsFromText(input: string): string {
  let out = String(input || '');
  const secrets = [
    process.env.NCT_API_TOKEN,
    process.env.GOOGLE_APPS_SCRIPT_SECRET,
    process.env.KV_REST_API_TOKEN,
    process.env.UPSTASH_REDIS_REST_TOKEN,
    process.env.BLOB_READ_WRITE_TOKEN,
    process.env.PERSISTENT_DB_SECRET,
  ];
  for (const s of secrets) {
    const trimmed = typeof s === 'string' ? s.trim() : '';
    if (trimmed && trimmed.length >= 4 && out.includes(trimmed)) {
      out = out.split(trimmed).join('[REDACTED]');
    }
  }
  return out
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:apiToken|token|serverSecret)=)[^&\s"']+/gi, '$1[REDACTED]');
}

const ALLOWED_APPS_SCRIPT_POST_HOSTS = new Set(['script.google.com']);
const ALLOWED_APPS_SCRIPT_ECHO_HOSTS = new Set([
  'script.google.com',
  'script.googleusercontent.com',
]);

export function parseAndValidateAppsScriptUrl(rawUrl: string, allowEchoHost: boolean): URL {
  const trimmed = (rawUrl || '').trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AppsScriptAuthError(
      'APPS_SCRIPT_INVALID_URL',
      'URL Web App Google Apps Script không hợp lệ.'
    );
  }

  if (parsed.protocol !== 'https:') {
    throw new AppsScriptAuthError(
      'APPS_SCRIPT_INVALID_URL',
      'URL Google Apps Script bắt buộc sử dụng giao thức HTTPS.'
    );
  }

  const host = parsed.hostname.toLowerCase();
  const allowed = allowEchoHost ? ALLOWED_APPS_SCRIPT_ECHO_HOSTS : ALLOWED_APPS_SCRIPT_POST_HOSTS;
  if (!allowed.has(host)) {
    throw new AppsScriptAuthError(
      allowEchoHost ? 'APPS_SCRIPT_REDIRECT_BLOCKED' : 'APPS_SCRIPT_INVALID_URL',
      allowEchoHost
        ? `Chặn chuyển hướng HTTP sang miền không được cho phép (${host}) để bảo vệ apiToken.`
        : `URL Google Apps Script phải thuộc miền script.google.com (miền hiện tại: ${host}).`
    );
  }

  // Không cho phép truyền token trong URL query string
  if (
    parsed.searchParams.has('apiToken') ||
    parsed.searchParams.has('serverSecret') ||
    parsed.searchParams.has('token')
  ) {
    throw new AppsScriptAuthError(
      'APPS_SCRIPT_INVALID_URL',
      'Không được đặt apiToken hoặc token trong URL Google Apps Script.'
    );
  }

  return parsed;
}

export function isAppsScriptTokenMismatchError(data: any): boolean {
  if (!data || typeof data !== 'object') return false;
  const code = String(data.code || '').toUpperCase();
  if (code === 'UNAUTHORIZED' || code === 'INVALID_TOKEN' || code === 'MISSING_TOKEN') {
    return true;
  }
  const err = String(data.error || '').toLowerCase();
  return (
    err.includes('apitoken') ||
    err.includes('nct_api_token') ||
    err.includes('nct_drive_secret') ||
    err.includes('không được phép') ||
    err.includes('sai hoặc thiếu')
  );
}

async function parseAppsScriptJsonResponse(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    if (text.includes('<html') || text.includes('<!DOCTYPE') || text.includes('accounts.google.com')) {
      throw new Error(
        'Apps Script trả về trang HTML thay vì JSON. Hãy kiểm tra khi Triển khai (Deploy) mục "Ai có quyền truy cập" đã chọn "Bất kỳ ai (Anyone)" và sử dụng đúng URL kết thúc bằng /exec.'
      );
    }
    throw new Error(`Phản hồi không hợp lệ từ Apps Script (HTTP ${res.status}).`);
  }
}

/**
 * Gửi yêu cầu POST bảo mật từ máy chủ tới Google Apps Script:
 * - Đọc NCT_API_TOKEN từ biến môi trường phía server và đính kèm qua trường JSON `apiToken`.
 * - Không gửi token qua URL/query, không ghi log giá trị token, không nhận token từ frontend.
 * - Kiểm soát HTTP redirect thủ công (`redirect: 'manual'`): chỉ cho phép chuyển hướng trong
 *   miền Google Apps Script (`script.google.com`, `script.googleusercontent.com`) và KHÔNG chuyển
 *   tiếp body/token khi chuyển hướng GET sang `script.googleusercontent.com/macros/echo`.
 */
export async function postToGoogleAppsScript(params: {
  appsScriptUrl: string;
  payload: Record<string, any>;
  timeoutMs?: number;
  requireToken?: boolean;
}): Promise<any> {
  const { appsScriptUrl, payload, timeoutMs = 25000, requireToken = true } = params;
  const initialUrl = parseAndValidateAppsScriptUrl(appsScriptUrl, false);
  const apiToken = getAppsScriptApiToken();

  if (requireToken && !apiToken) {
    throw new AppsScriptAuthError(
      'MISSING_APPS_SCRIPT_TOKEN',
      'Thiếu cấu hình biến môi trường NCT_API_TOKEN trên máy chủ. Vui lòng khai báo NCT_API_TOKEN (trên Vercel / server) khớp với token trong Google Apps Script rồi thử lại.'
    );
  }

  const sanitizedPayload: Record<string, any> = { ...payload };
  delete sanitizedPayload.apiToken;
  delete sanitizedPayload.serverSecret;
  if (apiToken) {
    sanitizedPayload.apiToken = apiToken;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let currentUrl = initialUrl.toString();
    let currentMethod: 'POST' | 'GET' = 'POST';
    let res: Response | null = null;
    const MAX_REDIRECTS = 3;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      res = await fetch(currentUrl, {
        method: currentMethod,
        redirect: 'manual',
        signal: controller.signal,
        headers:
          currentMethod === 'POST'
            ? { 'Content-Type': 'application/json' }
            : { Accept: 'application/json, text/plain;q=0.9' },
        body: currentMethod === 'POST' ? JSON.stringify(sanitizedPayload) : undefined,
      });

      const isRedirect =
        res.status === 301 ||
        res.status === 302 ||
        res.status === 303 ||
        res.status === 307 ||
        res.status === 308;

      if (!isRedirect) {
        break;
      }

      const locationHeader = res.headers.get('location');
      if (!locationHeader) {
        throw new AppsScriptAuthError(
          'APPS_SCRIPT_REDIRECT_BLOCKED',
          `Google Apps Script trả về mã chuyển hướng ${res.status} nhưng thiếu tiêu đề Location.`
        );
      }

      let resolvedTarget: URL;
      try {
        resolvedTarget = new URL(locationHeader, currentUrl);
      } catch {
        throw new AppsScriptAuthError(
          'APPS_SCRIPT_REDIRECT_BLOCKED',
          'URL chuyển hướng từ Google Apps Script không hợp lệ.'
        );
      }

      if (res.status === 307 || res.status === 308) {
        // Chỉ cho phép giữ nguyên POST (có apiToken) nếu đích vẫn thuộc script.google.com
        try {
          parseAndValidateAppsScriptUrl(resolvedTarget.toString(), false);
        } catch {
          throw new AppsScriptAuthError(
            'APPS_SCRIPT_REDIRECT_BLOCKED',
            `Chặn chuyển hướng HTTP ${res.status} sang miền không được cho phép (${resolvedTarget.hostname}) để bảo vệ apiToken.`
          );
        }
        currentMethod = 'POST';
      } else {
        // 301/302/303 chuẩn của Apps Script: chuyển sang GET tới script.googleusercontent.com KHÔNG kèm apiToken
        parseAndValidateAppsScriptUrl(resolvedTarget.toString(), true);
        currentMethod = 'GET';
      }

      currentUrl = resolvedTarget.toString();
      if (hop === MAX_REDIRECTS) {
        throw new AppsScriptAuthError(
          'APPS_SCRIPT_REDIRECT_BLOCKED',
          'Vượt quá số lần chuyển hướng tối đa khi kết nối Google Apps Script.'
        );
      }
    }

    if (!res) {
      throw new Error('Không nhận được phản hồi từ Google Apps Script.');
    }

    const data = await parseAppsScriptJsonResponse(res);
    if (data && (data.result === 'error' || data.ok === false) && isAppsScriptTokenMismatchError(data)) {
      throw new AppsScriptAuthError(
        'APPS_SCRIPT_AUTH_FAILED',
        'Không được phép: sai hoặc thiếu apiToken khi xác thực với Google Apps Script. Vui lòng kiểm tra biến môi trường NCT_API_TOKEN trên máy chủ/Vercel đã khớp với Script Properties trong Google Apps Script và đã triển khai bản Web App mới nhất.'
      );
    }

    return data;
  } catch (err: any) {
    if (err instanceof AppsScriptAuthError) {
      throw err;
    }
    if (err?.name === 'AbortError') {
      throw new Error(
        `Hết thời gian chờ kết nối Google Apps Script (${Math.round(timeoutMs / 1000)} giây). Vui lòng kiểm tra mạng hoặc thử lại.`
      );
    }
    throw new Error(scrubSecretsFromText(err?.message || 'Lỗi kết nối tới Google Apps Script.'));
  } finally {
    clearTimeout(timer);
  }
}

export async function testGoogleDriveConnection(params: {
  authMode: 'apps_script' | 'service_account';
  folderId: string;
  appsScriptUrl?: string;
  serviceAccountJson?: string;
}): Promise<{
  success: boolean;
  folderId: string;
  folderName?: string;
  message: string;
  code?: string;
}> {
  const { authMode, folderId, appsScriptUrl, serviceAccountJson } = params;
  if (!folderId) {
    return {
      success: false,
      folderId: '',
      message: 'URL hoặc ID thư mục Google Drive không hợp lệ.',
    };
  }

  if (authMode === 'apps_script') {
    if (!appsScriptUrl || !appsScriptUrl.trim()) {
      return {
        success: false,
        folderId,
        message: 'Chưa nhập URL Ứng dụng web Google Apps Script.',
      };
    }

    try {
      const data = await postToGoogleAppsScript({
        appsScriptUrl: appsScriptUrl.trim(),
        payload: {
          action: 'test',
          folderId,
        },
        timeoutMs: 20000,
      });

      if (data.result !== 'success') {
        return {
          success: false,
          folderId,
          message: scrubSecretsFromText(
            data.error || 'Kiểm tra thư mục Google Drive qua Apps Script thất bại.'
          ),
        };
      }

      return {
        success: true,
        folderId,
        folderName: data.folderName || '',
        message: `Kết nối thành công tới thư mục "${data.folderName || folderId}" (tài khoản Google: ${
          data.accountEmail || 'đã xác thực'
        }). Có đầy đủ quyền ghi tệp.`,
      };
    } catch (err: any) {
      return {
        success: false,
        folderId,
        code: err instanceof AppsScriptAuthError ? err.code : undefined,
        message: scrubSecretsFromText(
          err?.message || 'Kiểm tra thư mục Google Drive qua Apps Script thất bại.'
        ),
      };
    }
  }

  // Service Account mode via Google Drive API v3
  const { parsed, error } = parseServiceAccountJson(serviceAccountJson || '');
  if (!parsed || error) {
    return {
      success: false,
      folderId,
      message: error || 'Tài khoản dịch vụ không hợp lệ.',
    };
  }

  const accessToken = await getServiceAccountAccessToken(parsed);

  // 1. Check folder existence and capabilities
  const metaRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      folderId
    )}?supportsAllDrives=true&fields=id,name,mimeType,driveId,trashed,capabilities(canAddChildren,canEdit)`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  const metaData: any = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok) {
    const apiMsg = metaData?.error?.message || metaRes.statusText;
    return {
      success: false,
      folderId,
      message: `Không truy cập được thư mục (${metaRes.status}): ${apiMsg}. Hãy chắc chắn đã chia sẻ thư mục cho email ${parsed.client_email}.`,
    };
  }

  if (metaData.mimeType !== 'application/vnd.google-apps.folder') {
    return {
      success: false,
      folderId,
      message: 'ID đã nhập không phải là thư mục Google Drive.',
    };
  }
  if (metaData.trashed) {
    return {
      success: false,
      folderId,
      message: `Thư mục "${metaData.name}" đang nằm trong Thùng rác.`,
    };
  }
  if (!metaData.capabilities?.canAddChildren) {
    return {
      success: false,
      folderId,
      folderName: metaData.name,
      message: `Tài khoản dịch vụ (${parsed.client_email}) chưa có quyền tải tệp lên thư mục "${metaData.name}". Vui lòng cấp quyền Cộng tác viên / Người chỉnh sửa.`,
    };
  }

  // 2. Verify actual write/quota capability using a tiny probe file and delete it immediately
  const boundary = `nct_probe_${Date.now()}`;
  const probeMeta = JSON.stringify({
    name: `.nct_check_write_${Date.now()}.txt`,
    parents: [folderId],
  });
  const multipartBody =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${probeMeta}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    `NCT Drive write check\r\n` +
    `--${boundary}--`;

  const probeRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    }
  );
  const probeData: any = await probeRes.json().catch(() => ({}));
  if (!probeRes.ok || !probeData.id) {
    const errReason = probeData?.error?.errors?.[0]?.reason || '';
    const errMsg = probeData?.error?.message || probeRes.statusText;
    if (errReason === 'storageQuotaExceeded' || errMsg.includes('storage quota')) {
      return {
        success: false,
        folderId,
        folderName: metaData.name,
        message:
          'Tài khoản dịch vụ (Service Account) không có dung lượng lưu trữ trên "Drive của tôi". Hãy dùng thư mục trong "Bộ nhớ dùng chung (Shared Drive)" của Google Workspace hoặc chuyển sang phương thức Apps Script.',
      };
    }
    return {
      success: false,
      folderId,
      folderName: metaData.name,
      message: `Không thể ghi thử vào thư mục "${metaData.name}": ${errMsg}`,
    };
  }

  // Clean up probe file
  await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(probeData.id)}?supportsAllDrives=true`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  ).catch(() => {});

  return {
    success: true,
    folderId,
    folderName: metaData.name,
    message: `Kết nối thành công tới thư mục "${metaData.name}"${
      metaData.driveId ? ' (Bộ nhớ dùng chung)' : ''
    }. Tài khoản dịch vụ có đầy đủ quyền tải tệp lên.`,
  };
}

export interface DriveUploadResult {
  fileId: string;
  fileName: string;
  webViewLink: string;
  folderId?: string;
  folderPath?: string;
  deduplicated?: boolean;
}

function getGoogleDriveApiBaseUrl(): string {
  const custom = (process.env.GOOGLE_DRIVE_API_BASE || '').trim().replace(/\/+$/, '');
  return custom || 'https://www.googleapis.com';
}

// Khóa đồng bộ hóa theo key trong cùng tiến trình để nhiều người tải lên đồng thời không tạo trùng thư mục
const inFlightFolderCreations = new Map<string, Promise<any>>();
const folderKeyQueues = new Map<string, Promise<void>>();

async function runSerializedByKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = folderKeyQueues.get(key) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  folderKeyQueues.set(
    key,
    previous
      .catch(() => {})
      .then(() => gate)
  );
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (folderKeyQueues.get(key) === gate) {
      folderKeyQueues.delete(key);
    }
  }
}

async function runCoalescedByKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlightFolderCreations.get(key) as Promise<T> | undefined;
  if (existing) {
    return existing;
  }
  const promise = fn().finally(() => {
    if (inFlightFolderCreations.get(key) === promise) {
      inFlightFolderCreations.delete(key);
    }
  });
  inFlightFolderCreations.set(key, promise);
  return promise;
}

const FOLDER_VERIFY_MEM_TTL_MS = 5 * 60 * 1000;
const verifiedFolderMemCache = new Map<string, number>();
const folderNameMemCache = new Map<string, { name: string; expiresAt: number }>();

function clearFolderMemCacheForId(folderId?: string) {
  if (!folderId) return;
  folderNameMemCache.delete(folderId);
  for (const key of Array.from(verifiedFolderMemCache.keys())) {
    if (key.startsWith(`${folderId}::`)) {
      verifiedFolderMemCache.delete(key);
    }
  }
}

async function getServiceAccountFolderMeta(
  accessToken: string,
  folderId: string
): Promise<{ id: string; name: string; mimeType?: string; trashed?: boolean; parents?: string[] } | null> {
  const apiBase = getGoogleDriveApiBaseUrl();
  const res = await fetch(
    `${apiBase}/drive/v3/files/${encodeURIComponent(folderId)}?supportsAllDrives=true&fields=id,name,mimeType,trashed,parents`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  if (!res.ok) return null;
  const data: any = await res.json().catch(() => null);
  if (!data || !data.id) return null;
  return data;
}

async function getServiceAccountFolderName(accessToken: string, folderId: string): Promise<string> {
  const cached = folderNameMemCache.get(folderId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.name;
  }
  const meta = await getServiceAccountFolderMeta(accessToken, folderId);
  const name = typeof meta?.name === 'string' ? meta.name : '';
  if (name) {
    folderNameMemCache.set(folderId, { name, expiresAt: Date.now() + FOLDER_VERIFY_MEM_TTL_MS });
  }
  return name;
}

async function verifyCachedServiceAccountFolder(
  accessToken: string,
  folderId: string | undefined,
  expectedName: string,
  expectedParentId?: string
): Promise<boolean> {
  const cleanId = (folderId || '').trim();
  if (!cleanId) return false;
  const memKey = `${cleanId}::${expectedName.trim().toLowerCase()}::${expectedParentId || ''}`;
  const cachedExp = verifiedFolderMemCache.get(memKey);
  if (cachedExp && cachedExp > Date.now()) {
    return true;
  }
  const meta = await getServiceAccountFolderMeta(accessToken, cleanId);
  if (!meta || meta.trashed) {
    clearFolderMemCacheForId(cleanId);
    return false;
  }
  if (meta.mimeType !== 'application/vnd.google-apps.folder') return false;
  if ((meta.name || '').trim().toLowerCase() !== expectedName.trim().toLowerCase()) return false;
  if (expectedParentId && Array.isArray(meta.parents) && meta.parents.length > 0) {
    if (!meta.parents.includes(expectedParentId)) return false;
  }
  verifiedFolderMemCache.set(memKey, Date.now() + FOLDER_VERIFY_MEM_TTL_MS);
  return true;
}

async function ensureServiceAccountSubfolder(
  accessToken: string,
  parentId: string,
  folderName: string
): Promise<string> {
  const cleanName = folderName.trim();
  const coalesceKey = `sa_sub::${parentId}::${cleanName.toLowerCase()}`;

  return runCoalescedByKey(coalesceKey, () =>
    runSerializedByKey(coalesceKey, async () => {
      const apiBase = getGoogleDriveApiBaseUrl();
      const safeName = cleanName.replace(/'/g, "\\'");
      const q = `'${parentId}' in parents and name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
      const listUrl = `${apiBase}/drive/v3/files?supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name)&q=${encodeURIComponent(
        q
      )}`;

      const listRes = await fetch(listUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!listRes.ok) {
        const listErr: any = await listRes.json().catch(() => ({}));
        throw new Error(
          `Không thể kiểm tra thư mục "${cleanName}" trên Google Drive (${listRes.status}): ${
            listErr?.error?.message || listRes.statusText
          }`
        );
      }
      const listData: any = await listRes.json().catch(() => ({}));
      if (listData?.files?.[0]?.id) {
        const foundId = String(listData.files[0].id);
        verifiedFolderMemCache.set(
          `${foundId}::${cleanName.toLowerCase()}::${parentId}`,
          Date.now() + FOLDER_VERIFY_MEM_TTL_MS
        );
        return foundId;
      }

      const createRes = await fetch(
        `${apiBase}/drive/v3/files?supportsAllDrives=true&fields=id,name`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: cleanName,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentId],
          }),
        }
      );
      const createData: any = await createRes.json().catch(() => ({}));
      if (!createRes.ok || !createData.id) {
        throw new Error(
          `Không thể tạo thư mục "${cleanName}" trên Google Drive: ${
            createData?.error?.message || createRes.statusText
          }`
        );
      }
      const createdId = String(createData.id);
      verifiedFolderMemCache.set(
        `${createdId}::${cleanName.toLowerCase()}::${parentId}`,
        Date.now() + FOLDER_VERIFY_MEM_TTL_MS
      );
      return createdId;
    })
  );
}

async function resolveServiceAccountTargetFolder(
  accessToken: string,
  rootFolderId: string,
  hierarchy: { bookFolder: string; yearFolder: string; categoryFolder: string; displayPath: string },
  cachedEntry?: DriveFolderCacheEntry
): Promise<{
  bookFolderId?: string;
  yearFolderId: string;
  categoryFolderId: string;
}> {
  if (cachedEntry?.categoryFolderId) {
    const catOk = await verifyCachedServiceAccountFolder(
      accessToken,
      cachedEntry.categoryFolderId,
      hierarchy.categoryFolder,
      cachedEntry.yearFolderId
    );
    if (catOk) {
      return {
        bookFolderId: cachedEntry.bookFolderId,
        yearFolderId: cachedEntry.yearFolderId || '',
        categoryFolderId: cachedEntry.categoryFolderId,
      };
    }
  }

  let bookParentId = rootFolderId;
  let bookFolderId: string | undefined;
  if (
    cachedEntry?.bookFolderId &&
    (await verifyCachedServiceAccountFolder(accessToken, cachedEntry.bookFolderId, hierarchy.bookFolder, rootFolderId))
  ) {
    bookParentId = cachedEntry.bookFolderId;
    bookFolderId = cachedEntry.bookFolderId;
  } else {
    const rootName = await getServiceAccountFolderName(accessToken, rootFolderId);
    if (rootName.trim().toLowerCase() !== hierarchy.bookFolder.trim().toLowerCase()) {
      bookParentId = await ensureServiceAccountSubfolder(accessToken, rootFolderId, hierarchy.bookFolder);
      bookFolderId = bookParentId;
    }
  }

  let yearFolderId = '';
  if (
    cachedEntry?.yearFolderId &&
    (await verifyCachedServiceAccountFolder(accessToken, cachedEntry.yearFolderId, hierarchy.yearFolder, bookParentId))
  ) {
    yearFolderId = cachedEntry.yearFolderId;
  } else {
    yearFolderId = await ensureServiceAccountSubfolder(accessToken, bookParentId, hierarchy.yearFolder);
  }

  const categoryFolderId = await ensureServiceAccountSubfolder(
    accessToken,
    yearFolderId,
    hierarchy.categoryFolder
  );

  return {
    bookFolderId,
    yearFolderId,
    categoryFolderId,
  };
}

async function findExistingFileServiceAccount(
  accessToken: string,
  folderId: string,
  docId: string
): Promise<{ id: string; name: string; webViewLink: string } | null> {
  const apiBase = getGoogleDriveApiBaseUrl();
  const safeDocId = docId.replace(/'/g, "\\'");
  const qByDoc = `'${folderId}' in parents and trashed = false and appProperties has { key='nctDocId' and value='${safeDocId}' }`;
  const urlByDoc = `${apiBase}/drive/v3/files?supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name,webViewLink,appProperties,description)&q=${encodeURIComponent(
    qByDoc
  )}`;

  const res = await fetch(urlByDoc, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Google Drive trả về mã ${res.status} khi đối soát tệp theo mã bản ghi.`);
  }
  const data: any = await res.json().catch(() => ({}));
  const matchedAppProp = (Array.isArray(data?.files) ? data.files : []).find(
    (f: any) =>
      f?.id &&
      (!f?.appProperties || f.appProperties.nctDocId === docId)
  );
  if (matchedAppProp) {
    return {
      id: matchedAppProp.id,
      name: matchedAppProp.name,
      webViewLink: matchedAppProp.webViewLink || `https://drive.google.com/file/d/${matchedAppProp.id}/view`,
    };
  }

  // Fallback thứ hai: chỉ đối khớp theo metadata liên kết mã bản ghi trong description ("Mã hệ thống: <docId>"),
  // TUYỆT ĐỐI KHÔNG đối khớp chỉ dựa vào tên tệp giống nhau.
  const qByDesc = `'${folderId}' in parents and trashed = false and fullText contains 'Mã hệ thống: ${safeDocId}'`;
  const urlByDesc = `${apiBase}/drive/v3/files?supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name,webViewLink,description,appProperties)&q=${encodeURIComponent(
    qByDesc
  )}`;
  const descRes = await fetch(urlByDesc, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (descRes.ok) {
    const descData: any = await descRes.json().catch(() => ({}));
    const marker = `Mã hệ thống: ${docId}`;
    const matchedDesc = (Array.isArray(descData?.files) ? descData.files : []).find(
      (f: any) =>
        f?.id &&
        (f?.appProperties?.nctDocId === docId ||
          (typeof f?.description === 'string' && f.description.includes(marker)))
    );
    if (matchedDesc) {
      return {
        id: matchedDesc.id,
        name: matchedDesc.name,
        webViewLink: matchedDesc.webViewLink || `https://drive.google.com/file/d/${matchedDesc.id}/view`,
      };
    }
  }

  return null;
}

async function findExistingSubfolderServiceAccount(
  accessToken: string,
  parentFolderId: string,
  folderName: string
): Promise<string | null> {
  const apiBase = getGoogleDriveApiBaseUrl();
  const safeName = folderName.replace(/'/g, "\\'");
  const q = `'${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and name = '${safeName}' and trashed = false`;
  const res = await fetch(
    `${apiBase}/drive/v3/files?supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name)&q=${encodeURIComponent(q)}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  if (!res.ok) {
    throw new Error(`Không thể kiểm tra thư mục "${folderName}" trên Google Drive (${res.status}).`);
  }
  const data: any = await res.json().catch(() => ({}));
  const first = Array.isArray(data?.files) ? data.files[0] : null;
  return first?.id ? String(first.id) : null;
}

export async function uploadWordToGoogleDrive(params: {
  config: ReturnType<typeof resolveEffectiveDriveConfig>;
  docId: string;
  bookName: string;
  bookCode?: string;
  unit?: string;
  year?: number | string | null;
  docCategory?: 'outgoing' | 'incoming';
  fullDocNumber: string;
  docName: string;
  originalFileName: string;
  mimeType: string;
  buffer: Buffer;
  overrideFileName?: string;
  replaceMode?: boolean;
  isRetry?: boolean;
  previousFileId?: string;
  keepPreviousFile?: boolean;
  cacheKey?: string;
  folderCache?: Record<string, DriveFolderCacheEntry>;
  onFolderCacheUpdate?: (key: string, entry: DriveFolderCacheEntry) => void;
}): Promise<DriveUploadResult> {
  const {
    config,
    docId,
    bookName,
    bookCode,
    unit,
    year,
    docCategory = 'outgoing',
    fullDocNumber,
    docName,
    originalFileName,
    mimeType,
    buffer,
    overrideFileName,
    replaceMode,
    isRetry = false,
    previousFileId,
    keepPreviousFile,
    cacheKey,
    folderCache,
    onFolderCacheUpdate,
  } = params;

  if (!config.isConfigured || !config.folderId) {
    throw new Error(config.missingReason || 'Chưa cấu hình thư mục Google Drive hợp lệ.');
  }

  const cleanBookName = (bookName || '').trim();
  const cleanBookCode = (bookCode || '').trim().toUpperCase();
  const cleanUnit = (unit || cleanBookCode || '').trim();
  if (!cleanBookName) {
    throw new Error('Thiếu thông tin tên sổ/đơn vị (bookName/bookCode), không thể xác định thư mục lưu Google Drive.');
  }

  const hierarchy = buildDriveFolderHierarchy(cleanBookName, year, docCategory);
  const effectiveCacheKey =
    cacheKey || `${config.folderId}::${hierarchy.bookFolder}::${hierarchy.yearFolder}::${hierarchy.categoryFolder}`;

  const requiredExt =
    getSupportedAttachmentExtension(originalFileName) ||
    (mimeType === 'application/pdf' ? '.pdf' : '.docx');

  const finalFileName =
    overrideFileName && overrideFileName.trim()
      ? sanitizeCustomDriveFileName(overrideFileName, requiredExt)
      : buildStandardDriveFileName(fullDocNumber, docName, originalFileName);

  const saveCacheEntry = (resolved: {
    bookFolderId?: string;
    yearFolderId?: string;
    categoryFolderId?: string;
    folderPath?: string;
  }) => {
    const cleanCatId = (resolved.categoryFolderId || '').trim();
    if (!cleanCatId) return;
    const entry: DriveFolderCacheEntry = {
      bookFolderId: resolved.bookFolderId || undefined,
      yearFolderId: resolved.yearFolderId || undefined,
      categoryFolderId: cleanCatId,
      folderPath: resolved.folderPath || hierarchy.displayPath,
      updatedAt: new Date().toISOString(),
    };
    if (folderCache) {
      folderCache[effectiveCacheKey] = entry;
    }
    if (onFolderCacheUpdate) {
      onFolderCacheUpdate(effectiveCacheKey, entry);
    }
  };

  if (config.authMode === 'apps_script') {
    const runAppsScriptFlow = async (): Promise<DriveUploadResult> => {
      const currentCached = folderCache ? folderCache[effectiveCacheKey] : undefined;

      // Chỉ gọi bước kiểm tra trùng trước khi tải lên trong kịch bản thử lại / khôi phục để giảm 1 HTTP roundtrip khi cấp mới
      if (isRetry && !replaceMode && !keepPreviousFile) {
        const checkData = await postToGoogleAppsScript({
          appsScriptUrl: config.appsScriptUrl,
          timeoutMs: 20000,
          payload: {
            action: 'find',
            folderId: config.folderId,
            bookName: hierarchy.bookFolder,
            ...(cleanBookCode ? { bookCode: cleanBookCode } : {}),
            ...(cleanUnit ? { unit: cleanUnit } : {}),
            year: hierarchy.yearFolder,
            categoryFolder: hierarchy.categoryFolder,
            cachedBookFolderId: currentCached?.bookFolderId || '',
            cachedYearFolderId: currentCached?.yearFolderId || '',
            cachedCategoryFolderId: currentCached?.categoryFolderId || '',
            docId,
            expectedFileName: finalFileName,
            checkNameFallback: false,
          },
        });
        if (checkData.result === 'success') {
          const checkFolderId = checkData.targetFolderId || checkData.folderId;
          if (checkFolderId && checkFolderId !== config.folderId) {
            saveCacheEntry({
              bookFolderId: checkData.bookFolderId,
              yearFolderId: checkData.yearFolderId,
              categoryFolderId: checkFolderId,
              folderPath: checkData.folderPath,
            });
          }
          if (checkData.found && checkData.fileId) {
            return {
              fileId: checkData.fileId,
              fileName: checkData.fileName || finalFileName,
              webViewLink: checkData.webViewLink || `https://drive.google.com/file/d/${checkData.fileId}/view`,
              folderId: checkFolderId || currentCached?.categoryFolderId || config.folderId,
              folderPath: checkData.folderPath || hierarchy.displayPath,
              deduplicated: true,
            };
          }
        }
      }

      const freshCached = folderCache ? folderCache[effectiveCacheKey] : currentCached;

      // Upload new file into Tên sổ / Năm / Văn bản đi | Văn bản đến
      const uploadData = await postToGoogleAppsScript({
        appsScriptUrl: config.appsScriptUrl,
        timeoutMs: 45000,
        payload: {
          action: 'upload',
          folderId: config.folderId,
          bookName: hierarchy.bookFolder,
          ...(cleanBookCode ? { bookCode: cleanBookCode } : {}),
          ...(cleanUnit ? { unit: cleanUnit } : {}),
          year: hierarchy.yearFolder,
          categoryFolder: hierarchy.categoryFolder,
          cachedBookFolderId: freshCached?.bookFolderId || '',
          cachedYearFolderId: freshCached?.yearFolderId || '',
          cachedCategoryFolderId: freshCached?.categoryFolderId || '',
          docId,
          fullDocNumber,
          docName,
          fileName: finalFileName,
          mimeType,
          replaceMode: Boolean(replaceMode || keepPreviousFile),
          keepPreviousFile: Boolean(keepPreviousFile),
          previousFileId: keepPreviousFile ? '' : previousFileId || '',
          fileBase64: buffer.toString('base64'),
        },
      });
      if (uploadData.result !== 'success' || !uploadData.fileId) {
        throw new Error(
          scrubSecretsFromText(uploadData.error || 'Lưu tệp lên Google Drive qua Apps Script thất bại.')
        );
      }

      const resolvedFolderId = uploadData.targetFolderId || uploadData.folderId || freshCached?.categoryFolderId || config.folderId;
      const resolvedFolderPath = uploadData.folderPath || hierarchy.displayPath;
      if (resolvedFolderId && (uploadData.targetFolderId || uploadData.folderId)) {
        saveCacheEntry({
          bookFolderId: uploadData.bookFolderId,
          yearFolderId: uploadData.yearFolderId,
          categoryFolderId: resolvedFolderId,
          folderPath: resolvedFolderPath,
        });
      }

      return {
        fileId: uploadData.fileId,
        fileName: uploadData.fileName || finalFileName,
        webViewLink: uploadData.webViewLink || `https://drive.google.com/file/d/${uploadData.fileId}/view`,
        folderId: resolvedFolderId,
        folderPath: resolvedFolderPath,
        deduplicated: Boolean(uploadData.deduplicated),
      };
    };

    // Nếu thư mục đích chưa có trong cache, tuần tự hóa lần tạo/tìm thư mục đầu tiên để tránh tạo trùng thư mục khi nhiều người tải cùng lúc
    if (!folderCache?.[effectiveCacheKey]?.categoryFolderId) {
      return runSerializedByKey(`apps_script_init::${effectiveCacheKey}`, runAppsScriptFlow);
    }
    return runAppsScriptFlow();
  }

  // Service Account mode (Google Drive API v3)
  const { parsed, error } = parseServiceAccountJson(config.serviceAccountJson);
  if (!parsed || error) {
    throw new Error(error || 'Cấu hình Tài khoản dịch vụ không hợp lệ.');
  }

  const accessToken = await getServiceAccountAccessToken(parsed);
  const apiBase = getGoogleDriveApiBaseUrl();

  // Resolve/create folder layout: Tên sổ / Năm / Văn bản đi | Văn bản đến (có cache ID + TTL 5 phút trong RAM + khóa đồng bộ)
  const cachedEntry = folderCache ? folderCache[effectiveCacheKey] : undefined;
  let resolvedFolders = await resolveServiceAccountTargetFolder(
    accessToken,
    config.folderId,
    hierarchy,
    cachedEntry
  );
  let targetFolderId = resolvedFolders.categoryFolderId;
  saveCacheEntry({
    bookFolderId: resolvedFolders.bookFolderId,
    yearFolderId: resolvedFolders.yearFolderId,
    categoryFolderId: targetFolderId,
    folderPath: hierarchy.displayPath,
  });

  // Step 1: Đối soát tệp trùng trên Drive theo mã bản ghi (KHÔNG đối khớp chỉ theo tên tệp)
  if (isRetry && !replaceMode && !keepPreviousFile) {
    const existing = await findExistingFileServiceAccount(accessToken, targetFolderId, docId).catch(() => null);
    if (existing) {
      if (existing.name !== finalFileName) {
        await fetch(
          `${apiBase}/drive/v3/files/${encodeURIComponent(existing.id)}?supportsAllDrives=true`,
          {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: finalFileName }),
          }
        ).catch(() => {});
      }
      return {
        fileId: existing.id,
        fileName: finalFileName,
        webViewLink: existing.webViewLink,
        folderId: targetFolderId,
        folderPath: hierarchy.displayPath,
        deduplicated: true,
      };
    }
  } else if (replaceMode && previousFileId && !keepPreviousFile) {
    // Move previous file to trash when replacing via Service Account (best-effort)
    await fetch(
      `${apiBase}/drive/v3/files/${encodeURIComponent(previousFileId)}?supportsAllDrives=true`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ trashed: true }),
      }
    ).catch(() => {});
  }

  // Step 2: Multipart upload preserving exact binary Word/PDF content and folder-inherited permissions
  const performMultipartUpload = async (folderIdToUse: string) => {
    const boundary = `nct_upload_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const metadata = JSON.stringify({
      name: finalFileName,
      parents: [folderIdToUse],
      description: `Sổ: ${hierarchy.bookFolder} | Số văn bản: ${fullDocNumber} | Tên văn bản: ${docName} | Mã hệ thống: ${docId}`,
      appProperties: {
        nctDocId: docId,
        nctDocNumber: fullDocNumber,
        nctBookName: hierarchy.bookFolder,
      },
    });

    const prefix = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${metadata}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`,
      'utf-8'
    );
    const suffix = Buffer.from(`\r\n--${boundary}--`, 'utf-8');
    const multipartPayload = Buffer.concat([prefix, buffer, suffix]);

    const uploadRes = await fetch(
      `${apiBase}/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'Content-Length': String(multipartPayload.length),
        },
        body: multipartPayload,
      }
    );
    const uploadData: any = await uploadRes.json().catch(() => ({}));
    return { uploadRes, uploadData };
  };

  let { uploadRes, uploadData } = await performMultipartUpload(targetFolderId);

  // Nếu thư mục cache vừa bị xóa/di chuyển (404), vô hiệu hóa cache và phân giải lại 1 lần
  if (uploadRes.status === 404) {
    clearFolderMemCacheForId(targetFolderId);
    if (resolvedFolders.yearFolderId) clearFolderMemCacheForId(resolvedFolders.yearFolderId);
    if (resolvedFolders.bookFolderId) clearFolderMemCacheForId(resolvedFolders.bookFolderId);
    if (folderCache) delete folderCache[effectiveCacheKey];

    resolvedFolders = await resolveServiceAccountTargetFolder(
      accessToken,
      config.folderId,
      hierarchy,
      undefined
    );
    targetFolderId = resolvedFolders.categoryFolderId;
    saveCacheEntry({
      bookFolderId: resolvedFolders.bookFolderId,
      yearFolderId: resolvedFolders.yearFolderId,
      categoryFolderId: targetFolderId,
      folderPath: hierarchy.displayPath,
    });
    const retryRes = await performMultipartUpload(targetFolderId);
    uploadRes = retryRes.uploadRes;
    uploadData = retryRes.uploadData;
  }

  if (!uploadRes.ok || !uploadData.id) {
    const errReason = uploadData?.error?.errors?.[0]?.reason || '';
    const errMsg = uploadData?.error?.message || uploadRes.statusText;
    if (errReason === 'storageQuotaExceeded' || errMsg.includes('storage quota')) {
      throw new Error(
        'Tài khoản dịch vụ không có dung lượng trên Drive cá nhân. Hãy dùng Bộ nhớ dùng chung (Shared Drive) hoặc chế độ Apps Script.'
      );
    }
    throw new Error(`Tải tệp lên Google Drive thất bại (${uploadRes.status}): ${errMsg}`);
  }

  return {
    fileId: uploadData.id,
    fileName: uploadData.name || finalFileName,
    webViewLink: uploadData.webViewLink || `https://drive.google.com/file/d/${uploadData.id}/view`,
    folderId: targetFolderId,
    folderPath: hierarchy.displayPath,
    deduplicated: false,
  };
}

export const uploadFileToGoogleDrive = uploadWordToGoogleDrive;

export interface DriveFileCheckResult {
  status: 'ok' | 'not_found' | 'access_denied' | 'unverified';
  message?: string;
}

/**
 * Kiểm tra trạng thái tồn tại và quyền truy cập của 1 tệp theo driveFileId trên Google Drive.
 */
export async function checkGoogleDriveFileStatus(
  config: ResolvedGoogleDriveConfig,
  fileId: string
): Promise<DriveFileCheckResult> {
  const cleanId = (fileId || '').trim();
  if (!cleanId) {
    return { status: 'not_found', message: 'Thiếu mã tệp Google Drive.' };
  }
  if (!config.isConfigured) {
    return { status: 'unverified', message: config.missingReason || 'Chưa cấu hình Google Drive.' };
  }

  try {
    if (config.authMode === 'service_account') {
      const { parsed, error } = parseServiceAccountJson(config.serviceAccountJson);
      if (!parsed || error) {
        return { status: 'unverified', message: error || 'Khóa Service Account không hợp lệ.' };
      }
      const accessToken = await getServiceAccountAccessToken(parsed);
      const apiBase = getGoogleDriveApiBaseUrl();
      const res = await fetch(
        `${apiBase}/drive/v3/files/${encodeURIComponent(cleanId)}?supportsAllDrives=true&fields=id,name,trashed,capabilities(canDownload)`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      if (res.status === 404) {
        return { status: 'not_found', message: 'Tệp không còn tồn tại trên Google Drive (404).' };
      }
      if (res.status === 401 || res.status === 403) {
        return {
          status: 'access_denied',
          message: 'Tài khoản tích hợp thiếu quyền truy cập tệp này trên Google Drive.',
        };
      }
      if (!res.ok) {
        return { status: 'unverified', message: `Google Drive trả về mã ${res.status}.` };
      }
      const data: any = await res.json().catch(() => ({}));
      if (data?.trashed) {
        return { status: 'not_found', message: 'Tệp đã bị chuyển vào thùng rác trên Google Drive.' };
      }
      return { status: 'ok' };
    }

    if (!config.appsScriptUrl) {
      return { status: 'unverified', message: 'Thiếu URL Apps Script.' };
    }

    const data = await postToGoogleAppsScript({
      appsScriptUrl: config.appsScriptUrl,
      timeoutMs: 15000,
      payload: {
        action: 'check_file',
        folderId: config.folderId,
        fileId: cleanId,
      },
    });
    if (data.result === 'success') {
      if (data.status === 'not_found' || data.exists === false || data.trashed === true) {
        return { status: 'not_found', message: data.message || 'Tệp không tìm thấy trên Google Drive.' };
      }
      if (data.status === 'access_denied') {
        return {
          status: 'access_denied',
          message: data.message || 'Tài khoản Apps Script không có quyền truy cập tệp này.',
        };
      }
      return { status: 'ok' };
    }
    const errText = String(data.error || '').toLowerCase();
    if (errText.includes('thao tác không hợp lệ') || errText.includes('check_file')) {
      return {
        status: 'unverified',
        message: 'Apps Script hiện tại chưa cập nhật hàm kiểm tra check_file.',
      };
    }
    if (errText.includes('permission') || errText.includes('access denied') || errText.includes('quyền')) {
      return { status: 'access_denied', message: data.error };
    }
    if (errText.includes('no item with the given id') || errText.includes('not found') || errText.includes('không tìm thấy')) {
      return { status: 'not_found', message: 'Tệp không tìm thấy trên Google Drive.' };
    }
    return { status: 'unverified', message: data.error || 'Chưa xác minh được liên kết Drive.' };
  } catch (err: any) {
    return {
      status: 'unverified',
      message: err?.message || 'Lỗi kết nối khi kiểm tra tệp trên Google Drive.',
    };
  }
}

export function extractGoogleDriveFileId(input: string): string {
  const raw = (input || '').trim();
  if (!raw) return '';
  if (/\/folders\//i.test(raw)) return '';

  const fileDMatch = raw.match(/\/(?:file|document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]{12,})/);
  if (fileDMatch) return fileDMatch[1];

  const idParamMatch = raw.match(/[?&]id=([a-zA-Z0-9_-]{12,})/);
  if (idParamMatch) return idParamMatch[1];

  // Raw Drive ID without path separators, spaces, or file extensions
  if (/^[a-zA-Z0-9_-]{18,}$/.test(raw) && !raw.includes('http') && !raw.includes('.')) {
    return raw;
  }

  return '';
}

export interface DriveFileMetadataLookupResult {
  status: 'ok' | 'not_found' | 'access_denied' | 'unverified';
  file?: ArchiveDriveCandidate;
  message?: string;
  errorCode?: AppsScriptAuthErrorCode;
}

export async function getDriveFileMetadata(
  config: ResolvedGoogleDriveConfig,
  fileId: string
): Promise<DriveFileMetadataLookupResult> {
  const cleanId = (fileId || '').trim();
  if (!cleanId) {
    return { status: 'not_found', message: 'Thiếu mã tệp Google Drive.' };
  }
  if (!config.enabled || (config.authMode === 'service_account' && !config.serviceAccountJson) || (config.authMode === 'apps_script' && !config.appsScriptUrl)) {
    return { status: 'unverified', message: config.missingReason || 'Chưa cấu hình kết nối Google Drive.' };
  }

  try {
    if (config.authMode === 'service_account') {
      const { parsed, error } = parseServiceAccountJson(config.serviceAccountJson);
      if (!parsed || error) {
        return { status: 'unverified', message: error || 'Khóa Service Account không hợp lệ.' };
      }
      const accessToken = await getServiceAccountAccessToken(parsed);
      const apiBase = getGoogleDriveApiBaseUrl();
      const res = await fetch(
        `${apiBase}/drive/v3/files/${encodeURIComponent(cleanId)}?supportsAllDrives=true&fields=id,name,mimeType,webViewLink,trashed,parents`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      if (res.status === 404) {
        return { status: 'not_found', message: 'Không tìm thấy tệp trên Google Drive (404).' };
      }
      if (res.status === 401 || res.status === 403) {
        return { status: 'access_denied', message: 'Thiếu quyền truy cập tệp này trên Google Drive.' };
      }
      if (!res.ok) {
        return { status: 'unverified', message: `Google Drive trả về mã ${res.status}.` };
      }
      const data: any = await res.json().catch(() => ({}));
      if (data?.trashed) {
        return { status: 'not_found', message: 'Tệp đã bị chuyển vào thùng rác trên Google Drive.' };
      }
      return {
        status: 'ok',
        file: {
          fileId: String(data.id || cleanId),
          fileName: String(data.name || cleanId),
          webViewLink: String(data.webViewLink || `https://drive.google.com/file/d/${cleanId}/view`),
          mimeType: data.mimeType ? String(data.mimeType) : undefined,
        },
      };
    }

    // Apps Script mode: try get_file first, fallback to check_file
    const data = await postToGoogleAppsScript({
      appsScriptUrl: config.appsScriptUrl,
      timeoutMs: 15000,
      payload: {
        action: 'get_file',
        folderId: config.folderId || cleanId,
        fileId: cleanId,
      },
    });
    if (data.result === 'success' && data.status === 'ok' && data.file) {
      return {
        status: 'ok',
        file: {
          fileId: String(data.file.fileId || cleanId),
          fileName: String(data.file.fileName || cleanId),
          webViewLink: String(data.file.webViewLink || `https://drive.google.com/file/d/${cleanId}/view`),
          mimeType: data.file.mimeType ? String(data.file.mimeType) : undefined,
        },
      };
    }
    if (data.result === 'success' && (data.status === 'access_denied' || data.status === 'not_found')) {
      return {
        status: data.status,
        message: data.error || data.message || (data.status === 'access_denied' ? 'Không có quyền truy cập tệp Drive.' : 'Không tìm thấy tệp trên Google Drive.'),
      };
    }

    // Backward compatible fallback to check_file on older Apps Script deployments
    const errText = String(data.error || '').toLowerCase();
    if (errText.includes('thao tác không hợp lệ') || errText.includes('get_file')) {
      const checkData = await postToGoogleAppsScript({
        appsScriptUrl: config.appsScriptUrl,
        timeoutMs: 15000,
        payload: {
          action: 'check_file',
          folderId: config.folderId || cleanId,
          fileId: cleanId,
        },
      });
      if (checkData.result === 'success' && checkData.exists) {
        return {
          status: 'ok',
          file: {
            fileId: cleanId,
            fileName: String(checkData.fileName || cleanId),
            webViewLink: String(checkData.webViewLink || `https://drive.google.com/file/d/${cleanId}/view`),
          },
        };
      }
      if (checkData.status === 'access_denied') {
        return { status: 'access_denied', message: checkData.message || 'Thiếu quyền truy cập tệp Drive.' };
      }
      return { status: 'not_found', message: checkData.message || 'Không tìm thấy tệp trên Google Drive.' };
    }

    if (errText.includes('permission') || errText.includes('access') || errText.includes('quyền')) {
      return { status: 'access_denied', message: data.error };
    }
    if (errText.includes('not found') || errText.includes('no item') || errText.includes('không tìm thấy')) {
      return { status: 'not_found', message: 'Không tìm thấy tệp trên Google Drive.' };
    }
    return { status: 'unverified', message: data.error || 'Chưa xác minh được tệp trên Google Drive.' };
  } catch (err: any) {
    return {
      status: 'unverified',
      errorCode: err instanceof AppsScriptAuthError ? err.code : undefined,
      message: scrubSecretsFromText(err?.message || 'Lỗi kết nối Google Drive khi lấy thông tin tệp.'),
    };
  }
}

export async function listDriveFilesInFolder(
  config: ResolvedGoogleDriveConfig,
  folderIdOverride?: string,
  maxDepth: number = 4
): Promise<{ files: ArchiveDriveCandidate[]; error?: string }> {
  const rootFolderId = (folderIdOverride || config.folderId || '').trim();
  if (!rootFolderId) {
    return { files: [], error: 'Chưa chỉ định thư mục Google Drive để quét tệp.' };
  }
  if (!config.enabled) {
    return { files: [], error: config.missingReason || 'Chưa bật tích hợp Google Drive.' };
  }

  try {
    if (config.authMode === 'service_account') {
      const { parsed, error } = parseServiceAccountJson(config.serviceAccountJson);
      if (!parsed || error) {
        return { files: [], error: error || 'Cấu hình Tài khoản dịch vụ không hợp lệ.' };
      }
      const accessToken = await getServiceAccountAccessToken(parsed);
      const collected: ArchiveDriveCandidate[] = [];
      const queue: Array<{ id: string; path: string; depth: number }> = [
        { id: rootFolderId, path: config.folderName || '', depth: 1 },
      ];
      const visitedFolders = new Set<string>();

      while (queue.length > 0 && collected.length < 3000) {
        const current = queue.shift()!;
        if (visitedFolders.has(current.id)) continue;
        visitedFolders.add(current.id);

        let pageToken = '';
        const apiBase = getGoogleDriveApiBaseUrl();
        do {
          const q = `'${current.id.replace(/'/g, "\\'")}' in parents and trashed = false`;
          const url = new URL(`${apiBase}/drive/v3/files`);
          url.searchParams.set('q', q);
          url.searchParams.set('pageSize', '1000');
          url.searchParams.set('supportsAllDrives', 'true');
          url.searchParams.set('includeItemsFromAllDrives', 'true');
          url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,webViewLink)');
          if (pageToken) url.searchParams.set('pageToken', pageToken);

          const res = await fetch(url.toString(), {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (!res.ok) {
            if (current.depth === 1) {
              const errJson: any = await res.json().catch(() => ({}));
              return {
                files: collected,
                error: `Không thể quét thư mục Drive (${res.status}): ${errJson?.error?.message || res.statusText}`,
              };
            }
            break;
          }
          const data: any = await res.json().catch(() => ({}));
          const items: any[] = Array.isArray(data.files) ? data.files : [];
          for (const item of items) {
            if (item.mimeType === 'application/vnd.google-apps.folder') {
              if (current.depth < maxDepth) {
                const subPath = current.path ? `${current.path}/${item.name}` : String(item.name || '');
                queue.push({ id: String(item.id), path: subPath, depth: current.depth + 1 });
              }
            } else {
              collected.push({
                fileId: String(item.id),
                fileName: String(item.name || ''),
                webViewLink: String(item.webViewLink || `https://drive.google.com/file/d/${item.id}/view`),
                mimeType: item.mimeType ? String(item.mimeType) : undefined,
                folderPath: current.path || undefined,
              });
            }
          }
          pageToken = data.nextPageToken ? String(data.nextPageToken) : '';
        } while (pageToken && collected.length < 3000);
      }

      return { files: collected };
    }

    if (!config.appsScriptUrl) {
      return { files: [], error: 'Chưa cấu hình URL Google Apps Script.' };
    }

    const data = await postToGoogleAppsScript({
      appsScriptUrl: config.appsScriptUrl,
      timeoutMs: 30000,
      payload: {
        action: 'list_files',
        folderId: rootFolderId,
        maxDepth,
      },
    });
    if (data.result !== 'success' || !Array.isArray(data.files)) {
      return {
        files: [],
        error:
          data.error ||
          'Apps Script chưa hỗ trợ liệt kê tệp trong thư mục (cần cập nhật mẫu Apps Script mới hoặc dán trực tiếp liên kết Drive vào từng dòng).',
      };
    }
    return {
      files: data.files.map((f: any) => ({
        fileId: String(f.fileId || f.id || ''),
        fileName: String(f.fileName || f.name || ''),
        webViewLink: String(f.webViewLink || `https://drive.google.com/file/d/${f.fileId || f.id}/view`),
        mimeType: f.mimeType ? String(f.mimeType) : undefined,
        folderPath: f.folderPath ? String(f.folderPath) : undefined,
      })),
    };
  } catch (err: any) {
    return {
      files: [],
      error: err?.message || 'Lỗi khi quét danh sách tệp trong thư mục Google Drive.',
    };
  }
}

export async function downloadDriveFileBuffer(
  config: ResolvedGoogleDriveConfig,
  fileId: string
): Promise<{ ok: boolean; buffer?: Buffer; mimeType?: string; error?: string }> {
  const cleanId = (fileId || '').trim();
  if (!cleanId) return { ok: false, error: 'Thiếu mã tệp Google Drive.' };
  if (!config.enabled || config.authMode !== 'service_account' || !config.serviceAccountJson) {
    return { ok: false, error: 'Tải trực tiếp nội dung tệp chỉ hỗ trợ ở chế độ Service Account.' };
  }
  try {
    const { parsed, error } = parseServiceAccountJson(config.serviceAccountJson);
    if (!parsed || error) return { ok: false, error: error || 'Cấu hình Service Account không hợp lệ.' };
    const accessToken = await getServiceAccountAccessToken(parsed);
    const apiBase = getGoogleDriveApiBaseUrl();
    const res = await fetch(
      `${apiBase}/drive/v3/files/${encodeURIComponent(cleanId)}?alt=media&supportsAllDrives=true`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    if (!res.ok) {
      return { ok: false, error: `Không thể tải tệp từ Drive (${res.status}).` };
    }
    const arr = await res.arrayBuffer();
    return {
      ok: true,
      buffer: Buffer.from(arr),
      mimeType: res.headers.get('content-type') || 'application/pdf',
    };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Lỗi tải tệp từ Google Drive.' };
  }
}

export interface DriveDocumentVerifyResult {
  outcome: 'verified_saved' | 'not_found' | 'needs_reconcile';
  matchedBy?: 'file_id' | 'record_metadata';
  fileId?: string;
  fileName?: string;
  webViewLink?: string;
  folderId?: string;
  folderPath?: string;
  message: string;
  errorCode?: AppsScriptAuthErrorCode;
}

/**
 * Xác minh hoặc tìm lại tệp thực tế của một hồ sơ văn bản trên Google Drive.
 * Quy tắc an toàn bắt buộc:
 * 1. Nếu có `driveFileId`, gọi Google Drive API kiểm tra trực tiếp tệp tồn tại, chưa xóa và có quyền truy cập.
 * 2. Nếu thiếu `driveFileId` (hoặc fileId cũ không còn), CHỈ tìm trong đúng thư mục Drive đã cấu hình cho sổ đó
 *    theo mã bản ghi (`appProperties.nctDocId` hoặc metadata `Mã hệ thống: <docId>`).
 * 3. TUYỆT ĐỐI KHÔNG xác nhận lưu thành công chỉ dựa vào tên tệp giống nhau.
 * 4. Nếu không thể xác minh (mất kết nối, lỗi quyền, chưa cấu hình), trả về `needs_reconcile` — không mặc định tệp đã mất.
 */
export async function verifyOrLocateDocumentOnGoogleDrive(params: {
  config: ReturnType<typeof resolveEffectiveDriveConfig>;
  docId: string;
  driveFileId?: string;
  bookName: string;
  bookCode?: string;
  unit?: string;
  year?: number | string | null;
  docCategory?: 'outgoing' | 'incoming';
  folderCache?: Record<string, DriveFolderCacheEntry>;
  cacheKey?: string;
}): Promise<DriveDocumentVerifyResult> {
  const {
    config,
    docId,
    driveFileId,
    bookName,
    bookCode,
    unit,
    year,
    docCategory = 'outgoing',
    folderCache,
    cacheKey,
  } = params;

  if (!config.isConfigured || !config.folderId) {
    return {
      outcome: 'needs_reconcile',
      message: config.missingReason || 'Chưa cấu hình kết nối Google Drive hợp lệ cho sổ này.',
    };
  }

  const cleanBookName = (bookName || '').trim();
  const cleanBookCode = (bookCode || '').trim().toUpperCase();
  const cleanUnit = (unit || cleanBookCode || '').trim();
  if (!cleanBookName) {
    return {
      outcome: 'needs_reconcile',
      message: 'Thiếu thông tin tên sổ/đơn vị (bookName/bookCode), không thể đối soát Google Drive.',
    };
  }

  const hierarchy = buildDriveFolderHierarchy(cleanBookName, year, docCategory);
  const effectiveCacheKey =
    cacheKey || `${config.folderId}::${hierarchy.bookFolder}::${hierarchy.yearFolder}::${hierarchy.categoryFolder}`;

  // Bước 1: Nếu đã có driveFileId -> xác minh trực tiếp qua Drive API
  const cleanFileId = (driveFileId || '').trim();
  if (cleanFileId) {
    const meta = await getDriveFileMetadata(config, cleanFileId);
    if (meta.status === 'ok' && meta.file?.fileId) {
      return {
        outcome: 'verified_saved',
        matchedBy: 'file_id',
        fileId: meta.file.fileId,
        fileName: meta.file.fileName,
        webViewLink: meta.file.webViewLink,
        folderPath: hierarchy.displayPath,
        message: 'Đã xác minh tệp tồn tại và truy cập hợp lệ trên Google Drive.',
      };
    }
    if (meta.status === 'access_denied' || meta.status === 'unverified') {
      return {
        outcome: 'needs_reconcile',
        errorCode: meta.errorCode,
        message: meta.message || 'Không thể xác minh trạng thái tệp trên Google Drive (cần đối soát).',
      };
    }
    // Nếu 404 / trashed: tiếp tục kiểm tra trong thư mục đã cấu hình theo mã bản ghi xem có bản tải lên khác không
  }

  // Bước 2: Tìm trong đúng thư mục Google Drive đã cấu hình của sổ theo mã bản ghi (KHÔNG dùng tên tệp)
  try {
    if (config.authMode === 'service_account') {
      const { parsed, error } = parseServiceAccountJson(config.serviceAccountJson);
      if (!parsed || error) {
        return {
          outcome: 'needs_reconcile',
          message: error || 'Khóa Service Account không hợp lệ.',
        };
      }
      const accessToken = await getServiceAccountAccessToken(parsed);
      const cached = folderCache ? folderCache[effectiveCacheKey] : undefined;

      // Xác định danh sách thư mục ứng viên hợp lệ bên trong đúng thư mục đã cấu hình cho sổ (không tự tạo thư mục rỗng)
      const candidateFolders: Array<{ id: string; path: string }> = [];
      const seenFolderIds = new Set<string>();
      const pushCandidate = (id?: string | null, p?: string) => {
        const clean = (id || '').trim();
        if (!clean || seenFolderIds.has(clean)) return;
        seenFolderIds.add(clean);
        candidateFolders.push({ id: clean, path: p || hierarchy.displayPath });
      };

      if (cached?.categoryFolderId) {
        const validCached = await verifyCachedServiceAccountFolder(
          accessToken,
          cached.categoryFolderId,
          hierarchy.categoryFolder,
          cached.yearFolderId
        ).catch(() => false);
        if (validCached) {
          pushCandidate(cached.categoryFolderId, cached.folderPath || hierarchy.displayPath);
        }
      }

      if (candidateFolders.length === 0) {
        // Kiểm tra cấu trúc <root>/<book>/<year>/<category> hoặc <root>/<year>/<category> nếu root đã là thư mục sổ
        const rootName = await getServiceAccountFolderName(accessToken, config.folderId).catch(() => '');
        const bookParentId =
          rootName &&
          rootName.trim().normalize('NFC').toLowerCase() ===
            hierarchy.bookFolder.trim().normalize('NFC').toLowerCase()
            ? config.folderId
            : await findExistingSubfolderServiceAccount(accessToken, config.folderId, hierarchy.bookFolder);

        if (bookParentId) {
          const yearFolderId = await findExistingSubfolderServiceAccount(
            accessToken,
            bookParentId,
            hierarchy.yearFolder
          );
          if (yearFolderId) {
            const categoryFolderId = await findExistingSubfolderServiceAccount(
              accessToken,
              yearFolderId,
              hierarchy.categoryFolder
            );
            if (categoryFolderId) {
              pushCandidate(categoryFolderId, hierarchy.displayPath);
            }
          }
        }
        // Cũng kiểm tra trực tiếp thư mục gốc cấu hình của sổ phòng trường hợp hồ sơ cũ lưu thẳng ở gốc sổ
        pushCandidate(config.folderId, hierarchy.bookFolder);
      }

      for (const folder of candidateFolders) {
        const found = await findExistingFileServiceAccount(accessToken, folder.id, docId);
        if (found && found.id) {
          return {
            outcome: 'verified_saved',
            matchedBy: 'record_metadata',
            fileId: found.id,
            fileName: found.name,
            webViewLink: found.webViewLink,
            folderId: folder.id,
            folderPath: folder.path,
            message: 'Đã tìm thấy tệp gắn mã bản ghi trong thư mục Google Drive đã cấu hình.',
          };
        }
      }

      return {
        outcome: 'not_found',
        message: 'Không tìm thấy tệp gắn mã bản ghi này trong thư mục Google Drive đã cấu hình.',
      };
    }

    // Apps Script mode: chỉ tìm theo mã bản ghi (checkNameFallback: false)
    if (!config.appsScriptUrl) {
      return {
        outcome: 'needs_reconcile',
        message: 'Thiếu URL Apps Script để đối soát Google Drive.',
      };
    }

    const currentCached = folderCache ? folderCache[effectiveCacheKey] : undefined;
    const findData = await postToGoogleAppsScript({
      appsScriptUrl: config.appsScriptUrl,
      timeoutMs: 20000,
      payload: {
        action: 'find',
        folderId: config.folderId,
        bookName: hierarchy.bookFolder,
        ...(cleanBookCode ? { bookCode: cleanBookCode } : {}),
        ...(cleanUnit ? { unit: cleanUnit } : {}),
        year: hierarchy.yearFolder,
        categoryFolder: hierarchy.categoryFolder,
        cachedBookFolderId: currentCached?.bookFolderId || '',
        cachedYearFolderId: currentCached?.yearFolderId || '',
        cachedCategoryFolderId: currentCached?.categoryFolderId || '',
        docId,
        checkNameFallback: false,
      },
    });
    if (findData.result === 'success') {
      if (findData.found && findData.fileId) {
        return {
          outcome: 'verified_saved',
          matchedBy: 'record_metadata',
          fileId: String(findData.fileId),
          fileName: String(findData.fileName || ''),
          webViewLink: String(
            findData.webViewLink || `https://drive.google.com/file/d/${findData.fileId}/view`
          ),
          folderId: String(findData.targetFolderId || findData.folderId || config.folderId),
          folderPath: String(findData.folderPath || hierarchy.displayPath),
          message: 'Đã tìm thấy tệp gắn mã bản ghi trên Google Drive qua Apps Script.',
        };
      }
      return {
        outcome: 'not_found',
        message: 'Chưa tìm thấy tệp gắn mã bản ghi trong thư mục Google Drive đã cấu hình.',
      };
    }

    return {
      outcome: 'needs_reconcile',
      message: scrubSecretsFromText(
        findData.error || 'Apps Script không thể xác minh tệp trên Google Drive (cần đối soát).'
      ),
    };
  } catch (err: any) {
    return {
      outcome: 'needs_reconcile',
      errorCode: err instanceof AppsScriptAuthError ? err.code : undefined,
      message: scrubSecretsFromText(
        err?.message || 'Lỗi kết nối Google Drive khi đối soát tệp (cần đối soát).'
      ),
    };
  }
}

export interface DriveMoveToDeletedResult {
  ok: boolean;
  partial?: boolean;
  attempted: boolean;
  targetFolderId?: string;
  folderPath?: string;
  movedIds: string[];
  alreadyInDeletedIds: string[];
  alreadyMissingIds: string[];
  failedFiles: Array<{ fileId: string; fileName?: string; error: string }>;
  fileResults: DriveDeleteFileResult[];
  error?: string;
}

export interface DriveRestoreFromDeletedResult {
  ok: boolean;
  partial?: boolean;
  attempted: boolean;
  targetFolderId?: string;
  folderPath?: string;
  restoredIds: string[];
  alreadyInTargetIds: string[];
  alreadyMissingIds: string[];
  failedFiles: Array<{ fileId: string; fileName?: string; error: string }>;
  fileResults: DriveDeleteFileResult[];
  error?: string;
}

function normalizeFileResultsFromAppsScript(raw: any): DriveDeleteFileResult[] {
  if (!Array.isArray(raw)) return [];
  const out: DriveDeleteFileResult[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || !item.fileId) continue;
    const st = String(item.status || '');
    const status: DriveDeleteFileResult['status'] =
      st === 'moved' ||
      st === 'already_in_deleted' ||
      st === 'already_in_target' ||
      st === 'already_missing' ||
      st === 'failed'
        ? st
        : 'failed';
    out.push({
      fileId: String(item.fileId),
      fileName: item.fileName ? String(item.fileName) : undefined,
      status,
      previousFolderId: item.previousFolderId ? String(item.previousFolderId) : undefined,
      previousFolderPath: item.previousFolderPath ? String(item.previousFolderPath) : undefined,
      targetFolderId: item.targetFolderId ? String(item.targetFolderId) : undefined,
      error: item.error ? String(item.error) : undefined,
      updatedAt: new Date().toISOString(),
    });
  }
  return out;
}

function normalizeFailedFilesFromAppsScript(
  raw: any
): Array<{ fileId: string; fileName?: string; error: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f: any) => f && f.fileId)
    .map((f: any) => ({
      fileId: String(f.fileId),
      fileName: f.fileName ? String(f.fileName) : undefined,
      error: String(f.error || 'Lỗi không xác định khi thao tác tệp trên Google Drive.'),
    }));
}

/**
 * Chuyển đồng bộ toàn bộ tệp của một văn bản (tệp chính, phụ lục và các phiên bản cũ)
 * sang thư mục "<Tên sổ>/<Năm>/VB đã xóa" trên Google Drive.
 * Ghi nhận kết quả chi tiết từng tệp; nếu chuyển được một phần hoặc gặp lỗi,
 * trả về ok=false cùng trạng thái từng tệp để hệ thống giữ nguyên bản ghi và cho phép thử lại phần còn thiếu mà không chuyển trùng.
 */
export async function moveFilesToDeletedFolderOnGoogleDrive(params: {
  config: ResolvedGoogleDriveConfig;
  fileIds: string[];
  docId: string;
  bookName: string;
  bookCode?: string;
  unit?: string;
  year?: number | string | null;
  folderCache?: Record<string, DriveFolderCacheEntry>;
  onFolderCacheUpdate?: (key: string, entry: DriveFolderCacheEntry) => void;
}): Promise<DriveMoveToDeletedResult> {
  const {
    config,
    fileIds,
    docId,
    bookName,
    bookCode,
    unit,
    year,
    folderCache,
    onFolderCacheUpdate,
  } = params;

  const uniqueFileIds = Array.from(
    new Set(
      (fileIds || [])
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .filter(Boolean)
    )
  );

  if (uniqueFileIds.length === 0) {
    return {
      ok: true,
      partial: false,
      attempted: false,
      movedIds: [],
      alreadyInDeletedIds: [],
      alreadyMissingIds: [],
      failedFiles: [],
      fileResults: [],
    };
  }

  const cleanBookName = (bookName || '').trim();
  const cleanBookCode = (bookCode || '').trim().toUpperCase();
  const cleanUnit = (unit || cleanBookCode || '').trim();
  if (!cleanBookName) {
    const errMsg = 'Thiếu thông tin tên sổ/đơn vị (bookName/bookCode), không thể xác định thư mục VB đã xóa trên Google Drive.';
    return {
      ok: false,
      partial: false,
      attempted: true,
      movedIds: [],
      alreadyInDeletedIds: [],
      alreadyMissingIds: [],
      failedFiles: uniqueFileIds.map((fileId) => ({ fileId, error: errMsg })),
      fileResults: uniqueFileIds.map((fileId) => ({
        fileId,
        status: 'failed',
        error: errMsg,
        updatedAt: new Date().toISOString(),
      })),
      error: errMsg,
    };
  }

  if (!config.isConfigured || !config.folderId) {
    const errMsg =
      config.missingReason ||
      'Sổ này chưa cấu hình Google Drive hợp lệ nên không thể chuyển tệp sang thư mục "VB đã xóa". Đã giữ nguyên văn bản để tránh lệch dữ liệu.';
    return {
      ok: false,
      partial: false,
      attempted: true,
      movedIds: [],
      alreadyInDeletedIds: [],
      alreadyMissingIds: [],
      failedFiles: uniqueFileIds.map((fileId) => ({ fileId, error: errMsg })),
      fileResults: uniqueFileIds.map((fileId) => ({
        fileId,
        status: 'failed',
        error: errMsg,
        updatedAt: new Date().toISOString(),
      })),
      error: errMsg,
    };
  }

  const hierarchy = buildDeletedDriveFolderHierarchy(cleanBookName, year);
  const effectiveCacheKey = `${config.folderId}::${hierarchy.bookFolder}::${hierarchy.yearFolder}::${hierarchy.categoryFolder}`;

  const saveCacheEntry = (resolved: {
    bookFolderId?: string;
    yearFolderId?: string;
    categoryFolderId?: string;
    folderPath?: string;
  }) => {
    const cleanCatId = (resolved.categoryFolderId || '').trim();
    if (!cleanCatId) return;
    const entry: DriveFolderCacheEntry = {
      bookFolderId: resolved.bookFolderId || undefined,
      yearFolderId: resolved.yearFolderId || undefined,
      categoryFolderId: cleanCatId,
      folderPath: resolved.folderPath || hierarchy.displayPath,
      updatedAt: new Date().toISOString(),
    };
    if (folderCache) {
      folderCache[effectiveCacheKey] = entry;
    }
    if (onFolderCacheUpdate) {
      onFolderCacheUpdate(effectiveCacheKey, entry);
    }
  };

  if (config.authMode === 'apps_script') {
    if (!config.appsScriptUrl) {
      const errMsg =
        'Thiếu URL Google Apps Script kết nối Google Drive. Không thể chuyển tệp sang thư mục "VB đã xóa".';
      return {
        ok: false,
        partial: false,
        attempted: true,
        movedIds: [],
        alreadyInDeletedIds: [],
        alreadyMissingIds: [],
        failedFiles: uniqueFileIds.map((fileId) => ({ fileId, error: errMsg })),
        fileResults: uniqueFileIds.map((fileId) => ({
          fileId,
          status: 'failed',
          error: errMsg,
          updatedAt: new Date().toISOString(),
        })),
        error: errMsg,
      };
    }

    try {
      const currentCached = folderCache ? folderCache[effectiveCacheKey] : undefined;
      const data = await postToGoogleAppsScript({
        appsScriptUrl: config.appsScriptUrl,
        timeoutMs: 30000,
        payload: {
          action: 'move_to_deleted',
          folderId: config.folderId,
          bookName: hierarchy.bookFolder,
          ...(cleanBookCode ? { bookCode: cleanBookCode } : {}),
          ...(cleanUnit ? { unit: cleanUnit } : {}),
          year: hierarchy.yearFolder,
          categoryFolder: hierarchy.categoryFolder,
          cachedBookFolderId: currentCached?.bookFolderId || '',
          cachedYearFolderId: currentCached?.yearFolderId || '',
          cachedCategoryFolderId: currentCached?.categoryFolderId || '',
          docId,
          fileIds: uniqueFileIds,
        },
      });
      const targetFolderId = String(
        data.targetFolderId || data.folderId || currentCached?.categoryFolderId || config.folderId
      );
      const folderPath = String(data.folderPath || hierarchy.displayPath);
      if (data.targetFolderId || data.folderId) {
        saveCacheEntry({
          bookFolderId: data.bookFolderId,
          yearFolderId: data.yearFolderId,
          categoryFolderId: targetFolderId,
          folderPath,
        });
      }

      const movedIds: string[] = Array.isArray(data.movedIds) ? data.movedIds.map(String) : [];
      const alreadyInDeletedIds: string[] = Array.isArray(data.alreadyInDeletedIds)
        ? data.alreadyInDeletedIds.map(String)
        : [];
      const alreadyMissingIds: string[] = Array.isArray(data.alreadyMissingIds)
        ? data.alreadyMissingIds.map(String)
        : [];
      const failedFiles = normalizeFailedFilesFromAppsScript(data.failedFiles);
      const fileResults = normalizeFileResultsFromAppsScript(data.fileResults);

      if (data.result !== 'success') {
        const rawErr = String(data.error || '');
        if (/thao tác không hợp lệ|invalid action|move_to_deleted/i.test(rawErr)) {
          const upgradeErr =
            'Google Apps Script đang triển khai chưa hỗ trợ action "move_to_deleted". Vui lòng vào Cài đặt → Google Drive sao chép mã Apps Script mới và triển khai phiên bản mới (Deploy → Manage deployments → New version) rồi thử lại.';
          return {
            ok: false,
            partial: false,
            attempted: true,
            movedIds: [],
            alreadyInDeletedIds: [],
            alreadyMissingIds: [],
            failedFiles: uniqueFileIds.map((fileId) => ({ fileId, error: upgradeErr })),
            fileResults: uniqueFileIds.map((fileId) => ({
              fileId,
              status: 'failed',
              error: upgradeErr,
              updatedAt: new Date().toISOString(),
            })),
            error: upgradeErr,
          };
        }

        const isPartial =
          data.result === 'partial' ||
          data.status === 'partial' ||
          (failedFiles.length > 0 && (movedIds.length > 0 || alreadyInDeletedIds.length > 0));
        const errSummary =
          rawErr ||
          (failedFiles[0]?.error) ||
          'Không thể chuyển toàn bộ tệp sang thư mục "VB đã xóa" trên Google Drive qua Apps Script.';

        return {
          ok: false,
          partial: isPartial,
          attempted: true,
          targetFolderId,
          folderPath,
          movedIds,
          alreadyInDeletedIds,
          alreadyMissingIds,
          failedFiles:
            failedFiles.length > 0
              ? failedFiles
              : uniqueFileIds
                  .filter(
                    (id) =>
                      !movedIds.includes(id) &&
                      !alreadyInDeletedIds.includes(id) &&
                      !alreadyMissingIds.includes(id)
                  )
                  .map((fileId) => ({ fileId, error: errSummary })),
          fileResults,
          error: isPartial
            ? `Đã chuyển một phần (${movedIds.length + alreadyInDeletedIds.length}/${uniqueFileIds.length} tệp) sang "${folderPath}", còn ${failedFiles.length} tệp lỗi: ${errSummary}`
            : errSummary,
        };
      }

      const finalMovedIds =
        movedIds.length > 0 || alreadyInDeletedIds.length > 0 || alreadyMissingIds.length > 0
          ? movedIds
          : uniqueFileIds;

      return {
        ok: true,
        partial: false,
        attempted: true,
        targetFolderId,
        folderPath,
        movedIds: finalMovedIds,
        alreadyInDeletedIds,
        alreadyMissingIds,
        failedFiles: [],
        fileResults:
          fileResults.length > 0
            ? fileResults
            : [
                ...finalMovedIds.map((fileId) => ({
                  fileId,
                  status: 'moved' as const,
                  targetFolderId,
                  updatedAt: new Date().toISOString(),
                })),
                ...alreadyInDeletedIds.map((fileId) => ({
                  fileId,
                  status: 'already_in_deleted' as const,
                  targetFolderId,
                  updatedAt: new Date().toISOString(),
                })),
                ...alreadyMissingIds.map((fileId) => ({
                  fileId,
                  status: 'already_missing' as const,
                  targetFolderId,
                  updatedAt: new Date().toISOString(),
                })),
              ],
      };
    } catch (err: any) {
      const msg =
        err?.name === 'AbortError'
          ? 'Quá thời gian chờ phản hồi từ Google Drive (Apps Script) khi chuyển tệp sang thư mục "VB đã xóa".'
          : err?.message || 'Lỗi kết nối Google Drive (Apps Script) khi chuyển tệp sang thư mục "VB đã xóa".';
      return {
        ok: false,
        partial: false,
        attempted: true,
        movedIds: [],
        alreadyInDeletedIds: [],
        alreadyMissingIds: [],
        failedFiles: uniqueFileIds.map((fileId) => ({ fileId, error: msg })),
        fileResults: uniqueFileIds.map((fileId) => ({
          fileId,
          status: 'failed',
          error: msg,
          updatedAt: new Date().toISOString(),
        })),
        error: msg,
      };
    }
  }

  // Service Account mode (Google Drive API v3)
  const { parsed, error } = parseServiceAccountJson(config.serviceAccountJson);
  if (!parsed || error) {
    const errMsg = error || 'Cấu hình Tài khoản dịch vụ Google Drive không hợp lệ.';
    return {
      ok: false,
      partial: false,
      attempted: true,
      movedIds: [],
      alreadyInDeletedIds: [],
      alreadyMissingIds: [],
      failedFiles: uniqueFileIds.map((fileId) => ({ fileId, error: errMsg })),
      fileResults: uniqueFileIds.map((fileId) => ({
        fileId,
        status: 'failed',
        error: errMsg,
        updatedAt: new Date().toISOString(),
      })),
      error: errMsg,
    };
  }

  let accessToken: string;
  try {
    accessToken = await getServiceAccountAccessToken(parsed);
  } catch (err: any) {
    const errMsg = err?.message || 'Không thể xác thực Tài khoản dịch vụ Google Drive.';
    return {
      ok: false,
      partial: false,
      attempted: true,
      movedIds: [],
      alreadyInDeletedIds: [],
      alreadyMissingIds: [],
      failedFiles: uniqueFileIds.map((fileId) => ({ fileId, error: errMsg })),
      fileResults: uniqueFileIds.map((fileId) => ({
        fileId,
        status: 'failed',
        error: errMsg,
        updatedAt: new Date().toISOString(),
      })),
      error: errMsg,
    };
  }

  const apiBase = getGoogleDriveApiBaseUrl();
  let targetFolderId: string;
  try {
    const cachedEntry = folderCache ? folderCache[effectiveCacheKey] : undefined;
    const resolvedFolders = await resolveServiceAccountTargetFolder(
      accessToken,
      config.folderId,
      hierarchy,
      cachedEntry
    );
    targetFolderId = resolvedFolders.categoryFolderId;
    saveCacheEntry({
      bookFolderId: resolvedFolders.bookFolderId,
      yearFolderId: resolvedFolders.yearFolderId,
      categoryFolderId: targetFolderId,
      folderPath: hierarchy.displayPath,
    });
  } catch (err: any) {
    const errMsg =
      err?.message ||
      `Không thể khởi tạo thư mục "${hierarchy.displayPath}" trên Google Drive.`;
    return {
      ok: false,
      partial: false,
      attempted: true,
      movedIds: [],
      alreadyInDeletedIds: [],
      alreadyMissingIds: [],
      failedFiles: uniqueFileIds.map((fileId) => ({ fileId, error: errMsg })),
      fileResults: uniqueFileIds.map((fileId) => ({
        fileId,
        status: 'failed',
        error: errMsg,
        updatedAt: new Date().toISOString(),
      })),
      error: errMsg,
    };
  }

  const movedIds: string[] = [];
  const alreadyInDeletedIds: string[] = [];
  const alreadyMissingIds: string[] = [];
  const failedFiles: Array<{ fileId: string; fileName?: string; error: string }> = [];
  const fileResults: DriveDeleteFileResult[] = [];

  for (const fileId of uniqueFileIds) {
    try {
      const metaRes = await fetch(
        `${apiBase}/drive/v3/files/${encodeURIComponent(
          fileId
        )}?supportsAllDrives=true&fields=id,name,trashed,parents,description,appProperties`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (metaRes.status === 404) {
        alreadyMissingIds.push(fileId);
        fileResults.push({
          fileId,
          status: 'already_missing',
          targetFolderId,
          updatedAt: new Date().toISOString(),
        });
        continue;
      }

      const metaData: any = await metaRes.json().catch(() => ({}));
      if (!metaRes.ok) {
        const apiMsg = metaData?.error?.message || metaRes.statusText;
        const errMsg = `Không thể truy cập tệp Google Drive (${metaRes.status}): ${apiMsg}`;
        failedFiles.push({ fileId, error: errMsg });
        fileResults.push({
          fileId,
          status: 'failed',
          targetFolderId,
          error: errMsg,
          updatedAt: new Date().toISOString(),
        });
        continue;
      }

      const fileName = metaData?.name ? String(metaData.name) : undefined;
      if (metaData?.trashed) {
        alreadyMissingIds.push(fileId);
        fileResults.push({
          fileId,
          fileName,
          status: 'already_missing',
          targetFolderId,
          updatedAt: new Date().toISOString(),
        });
        continue;
      }

      // Kiểm tra liên kết mã bản ghi nếu tệp có gắn metadata nctDocId
      const taggedDocId = metaData?.appProperties?.nctDocId
        ? String(metaData.appProperties.nctDocId).trim()
        : '';
      if (docId && taggedDocId && taggedDocId !== docId) {
        const errMsg = `Tệp "${fileName || fileId}" không khớp mã bản ghi cần xóa (${docId}).`;
        failedFiles.push({ fileId, fileName, error: errMsg });
        fileResults.push({
          fileId,
          fileName,
          status: 'failed',
          targetFolderId,
          error: errMsg,
          updatedAt: new Date().toISOString(),
        });
        continue;
      }

      const currentParents: string[] = Array.isArray(metaData?.parents)
        ? metaData.parents.map(String).filter(Boolean)
        : [];
      const removeParents = currentParents.filter((p) => p !== targetFolderId);
      const previousFolderId = removeParents[0];

      if (currentParents.includes(targetFolderId) && removeParents.length === 0) {
        alreadyInDeletedIds.push(fileId);
        fileResults.push({
          fileId,
          fileName,
          status: 'already_in_deleted',
          targetFolderId,
          updatedAt: new Date().toISOString(),
        });
        continue;
      }

      const queryParts = ['supportsAllDrives=true', 'fields=id,parents'];
      if (!currentParents.includes(targetFolderId)) {
        queryParts.push(`addParents=${encodeURIComponent(targetFolderId)}`);
      }
      if (removeParents.length > 0) {
        queryParts.push(`removeParents=${encodeURIComponent(removeParents.join(','))}`);
      }

      const patchRes = await fetch(
        `${apiBase}/drive/v3/files/${encodeURIComponent(fileId)}?${queryParts.join('&')}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        }
      );

      const patchData: any = await patchRes.json().catch(() => ({}));
      if (!patchRes.ok) {
        const apiMsg = patchData?.error?.message || patchRes.statusText;
        const errMsg = `Không thể chuyển tệp "${fileName || fileId}" sang thư mục "${hierarchy.displayPath}" (${patchRes.status}): ${apiMsg}`;
        failedFiles.push({ fileId, fileName, error: errMsg });
        fileResults.push({
          fileId,
          fileName,
          status: 'failed',
          previousFolderId,
          targetFolderId,
          error: errMsg,
          updatedAt: new Date().toISOString(),
        });
        continue;
      }

      movedIds.push(fileId);
      fileResults.push({
        fileId,
        fileName,
        status: 'moved',
        previousFolderId,
        targetFolderId,
        updatedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      const errMsg = `Lỗi kết nối Google Drive khi chuyển tệp (${fileId}): ${
        err?.message || 'Không xác định'
      }`;
      failedFiles.push({ fileId, error: errMsg });
      fileResults.push({
        fileId,
        status: 'failed',
        targetFolderId,
        error: errMsg,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  if (failedFiles.length > 0) {
    const succeededCount = movedIds.length + alreadyInDeletedIds.length;
    const isPartial = succeededCount > 0;
    return {
      ok: false,
      partial: isPartial,
      attempted: true,
      targetFolderId,
      folderPath: hierarchy.displayPath,
      movedIds,
      alreadyInDeletedIds,
      alreadyMissingIds,
      failedFiles,
      fileResults,
      error: isPartial
        ? `Đã chuyển một phần (${succeededCount}/${uniqueFileIds.length} tệp) sang "${hierarchy.displayPath}", còn ${failedFiles.length} tệp lỗi: ${failedFiles[0].error}. Bấm xóa lại để tiếp tục chuyển các tệp còn thiếu.`
        : failedFiles[0].error,
    };
  }

  return {
    ok: true,
    partial: false,
    attempted: true,
    targetFolderId,
    folderPath: hierarchy.displayPath,
    movedIds,
    alreadyInDeletedIds,
    alreadyMissingIds,
    failedFiles: [],
    fileResults,
  };
}

/**
 * Khôi phục toàn bộ tệp của một văn bản từ thư mục "VB đã xóa" về lại thư mục gốc ban đầu
 * (theo originalFolderMap hoặc cây thư mục "<Tên sổ>/<Năm>/<Văn bản đi | Văn bản đến>").
 * Hỗ trợ cả Google Apps Script (action: restore_from_deleted) và Tài khoản dịch vụ Drive API v3.
 */
export async function restoreFilesFromDeletedFolderOnGoogleDrive(params: {
  config: ResolvedGoogleDriveConfig;
  fileIds: string[];
  docId: string;
  bookName: string;
  bookCode?: string;
  unit?: string;
  year?: number | string | null;
  docCategory?: 'outgoing' | 'incoming';
  originalFolderMap?: Record<string, { folderId?: string; folderPath?: string }>;
  folderCache?: Record<string, DriveFolderCacheEntry>;
  onFolderCacheUpdate?: (key: string, entry: DriveFolderCacheEntry) => void;
}): Promise<DriveRestoreFromDeletedResult> {
  const {
    config,
    fileIds,
    docId,
    bookName,
    bookCode,
    unit,
    year,
    docCategory = 'outgoing',
    originalFolderMap = {},
    folderCache,
    onFolderCacheUpdate,
  } = params;

  const uniqueFileIds = Array.from(
    new Set(
      (fileIds || [])
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .filter(Boolean)
    )
  );

  if (uniqueFileIds.length === 0) {
    return {
      ok: true,
      partial: false,
      attempted: false,
      restoredIds: [],
      alreadyInTargetIds: [],
      alreadyMissingIds: [],
      failedFiles: [],
      fileResults: [],
    };
  }

  const cleanBookName = (bookName || '').trim();
  const cleanBookCode = (bookCode || '').trim().toUpperCase();
  const cleanUnit = (unit || cleanBookCode || '').trim();
  if (!cleanBookName) {
    const errMsg = 'Thiếu thông tin tên sổ/đơn vị (bookName/bookCode), không thể khôi phục tệp về thư mục gốc trên Google Drive.';
    return {
      ok: false,
      partial: false,
      attempted: true,
      restoredIds: [],
      alreadyInTargetIds: [],
      alreadyMissingIds: [],
      failedFiles: uniqueFileIds.map((fileId) => ({ fileId, error: errMsg })),
      fileResults: uniqueFileIds.map((fileId) => ({
        fileId,
        status: 'failed',
        error: errMsg,
        updatedAt: new Date().toISOString(),
      })),
      error: errMsg,
    };
  }

  if (!config.isConfigured || !config.folderId) {
    const errMsg =
      config.missingReason ||
      'Sổ này chưa cấu hình Google Drive hợp lệ nên không thể khôi phục tệp về thư mục ban đầu.';
    return {
      ok: false,
      partial: false,
      attempted: true,
      restoredIds: [],
      alreadyInTargetIds: [],
      alreadyMissingIds: [],
      failedFiles: uniqueFileIds.map((fileId) => ({ fileId, error: errMsg })),
      fileResults: uniqueFileIds.map((fileId) => ({
        fileId,
        status: 'failed',
        error: errMsg,
        updatedAt: new Date().toISOString(),
      })),
      error: errMsg,
    };
  }

  const hierarchy = buildDriveFolderHierarchy(cleanBookName, year, docCategory);
  const effectiveCacheKey = `${config.folderId}::${hierarchy.bookFolder}::${hierarchy.yearFolder}::${hierarchy.categoryFolder}`;

  const saveCacheEntry = (resolved: {
    bookFolderId?: string;
    yearFolderId?: string;
    categoryFolderId?: string;
    folderPath?: string;
  }) => {
    const cleanCatId = (resolved.categoryFolderId || '').trim();
    if (!cleanCatId) return;
    const entry: DriveFolderCacheEntry = {
      bookFolderId: resolved.bookFolderId || undefined,
      yearFolderId: resolved.yearFolderId || undefined,
      categoryFolderId: cleanCatId,
      folderPath: resolved.folderPath || hierarchy.displayPath,
      updatedAt: new Date().toISOString(),
    };
    if (folderCache) {
      folderCache[effectiveCacheKey] = entry;
    }
    if (onFolderCacheUpdate) {
      onFolderCacheUpdate(effectiveCacheKey, entry);
    }
  };

  if (config.authMode === 'apps_script') {
    if (!config.appsScriptUrl) {
      const errMsg =
        'Thiếu URL Google Apps Script kết nối Google Drive. Không thể khôi phục tệp về thư mục gốc.';
      return {
        ok: false,
        partial: false,
        attempted: true,
        restoredIds: [],
        alreadyInTargetIds: [],
        alreadyMissingIds: [],
        failedFiles: uniqueFileIds.map((fileId) => ({ fileId, error: errMsg })),
        fileResults: uniqueFileIds.map((fileId) => ({
          fileId,
          status: 'failed',
          error: errMsg,
          updatedAt: new Date().toISOString(),
        })),
        error: errMsg,
      };
    }

    try {
      const currentCached = folderCache ? folderCache[effectiveCacheKey] : undefined;
      const data = await postToGoogleAppsScript({
        appsScriptUrl: config.appsScriptUrl,
        timeoutMs: 30000,
        payload: {
          action: 'restore_from_deleted',
          folderId: config.folderId,
          bookName: hierarchy.bookFolder,
          ...(cleanBookCode ? { bookCode: cleanBookCode } : {}),
          ...(cleanUnit ? { unit: cleanUnit } : {}),
          year: hierarchy.yearFolder,
          categoryFolder: hierarchy.categoryFolder,
          cachedBookFolderId: currentCached?.bookFolderId || '',
          cachedYearFolderId: currentCached?.yearFolderId || '',
          cachedCategoryFolderId: currentCached?.categoryFolderId || '',
          docId,
          fileIds: uniqueFileIds,
          originalFolderMap,
        },
      });
      const targetFolderId = String(
        data.targetFolderId || data.folderId || currentCached?.categoryFolderId || config.folderId
      );
      const folderPath = String(data.folderPath || hierarchy.displayPath);
      if (data.targetFolderId || data.folderId) {
        saveCacheEntry({
          bookFolderId: data.bookFolderId,
          yearFolderId: data.yearFolderId,
          categoryFolderId: targetFolderId,
          folderPath,
        });
      }

      const restoredIds: string[] = Array.isArray(data.restoredIds) ? data.restoredIds.map(String) : [];
      const alreadyInTargetIds: string[] = Array.isArray(data.alreadyInTargetIds)
        ? data.alreadyInTargetIds.map(String)
        : [];
      const alreadyMissingIds: string[] = Array.isArray(data.alreadyMissingIds)
        ? data.alreadyMissingIds.map(String)
        : [];
      const failedFiles = normalizeFailedFilesFromAppsScript(data.failedFiles);
      const fileResults = normalizeFileResultsFromAppsScript(data.fileResults);

      if (data.result !== 'success') {
        const rawErr = String(data.error || '');
        if (/thao tác không hợp lệ|invalid action|restore_from_deleted/i.test(rawErr)) {
          const upgradeErr =
            'Google Apps Script đang triển khai chưa hỗ trợ action "restore_from_deleted". Vui lòng vào Cài đặt → Google Drive sao chép mã Apps Script mới và triển khai phiên bản mới rồi thử khôi phục lại.';
          return {
            ok: false,
            partial: false,
            attempted: true,
            restoredIds: [],
            alreadyInTargetIds: [],
            alreadyMissingIds: [],
            failedFiles: uniqueFileIds.map((fileId) => ({ fileId, error: upgradeErr })),
            fileResults: uniqueFileIds.map((fileId) => ({
              fileId,
              status: 'failed',
              error: upgradeErr,
              updatedAt: new Date().toISOString(),
            })),
            error: upgradeErr,
          };
        }

        const isPartial =
          data.result === 'partial' ||
          data.status === 'partial' ||
          (failedFiles.length > 0 && (restoredIds.length > 0 || alreadyInTargetIds.length > 0));
        const errSummary =
          rawErr ||
          failedFiles[0]?.error ||
          'Không thể khôi phục tệp về thư mục ban đầu trên Google Drive qua Apps Script.';

        return {
          ok: false,
          partial: isPartial,
          attempted: true,
          targetFolderId,
          folderPath,
          restoredIds,
          alreadyInTargetIds,
          alreadyMissingIds,
          failedFiles:
            failedFiles.length > 0
              ? failedFiles
              : uniqueFileIds
                  .filter(
                    (id) =>
                      !restoredIds.includes(id) &&
                      !alreadyInTargetIds.includes(id) &&
                      !alreadyMissingIds.includes(id)
                  )
                  .map((fileId) => ({ fileId, error: errSummary })),
          fileResults,
          error: errSummary,
        };
      }

      const finalRestoredIds =
        restoredIds.length > 0 || alreadyInTargetIds.length > 0 || alreadyMissingIds.length > 0
          ? restoredIds
          : uniqueFileIds;

      return {
        ok: true,
        partial: false,
        attempted: true,
        targetFolderId,
        folderPath,
        restoredIds: finalRestoredIds,
        alreadyInTargetIds,
        alreadyMissingIds,
        failedFiles: [],
        fileResults:
          fileResults.length > 0
            ? fileResults
            : [
                ...finalRestoredIds.map((fileId) => ({
                  fileId,
                  status: 'moved' as const,
                  targetFolderId,
                  updatedAt: new Date().toISOString(),
                })),
                ...alreadyInTargetIds.map((fileId) => ({
                  fileId,
                  status: 'already_in_target' as const,
                  targetFolderId,
                  updatedAt: new Date().toISOString(),
                })),
                ...alreadyMissingIds.map((fileId) => ({
                  fileId,
                  status: 'already_missing' as const,
                  targetFolderId,
                  updatedAt: new Date().toISOString(),
                })),
              ],
      };
    } catch (err: any) {
      const msg =
        err?.name === 'AbortError'
          ? 'Quá thời gian chờ phản hồi từ Google Drive (Apps Script) khi khôi phục tệp.'
          : err?.message || 'Lỗi kết nối Google Drive (Apps Script) khi khôi phục tệp.';
      return {
        ok: false,
        partial: false,
        attempted: true,
        restoredIds: [],
        alreadyInTargetIds: [],
        alreadyMissingIds: [],
        failedFiles: uniqueFileIds.map((fileId) => ({ fileId, error: msg })),
        fileResults: uniqueFileIds.map((fileId) => ({
          fileId,
          status: 'failed',
          error: msg,
          updatedAt: new Date().toISOString(),
        })),
        error: msg,
      };
    }
  }

  // Service Account mode (Google Drive API v3)
  const { parsed, error } = parseServiceAccountJson(config.serviceAccountJson);
  if (!parsed || error) {
    const errMsg = error || 'Cấu hình Tài khoản dịch vụ Google Drive không hợp lệ.';
    return {
      ok: false,
      partial: false,
      attempted: true,
      restoredIds: [],
      alreadyInTargetIds: [],
      alreadyMissingIds: [],
      failedFiles: uniqueFileIds.map((fileId) => ({ fileId, error: errMsg })),
      fileResults: uniqueFileIds.map((fileId) => ({
        fileId,
        status: 'failed',
        error: errMsg,
        updatedAt: new Date().toISOString(),
      })),
      error: errMsg,
    };
  }

  let accessToken: string;
  try {
    accessToken = await getServiceAccountAccessToken(parsed);
  } catch (err: any) {
    const errMsg = err?.message || 'Không thể xác thực Tài khoản dịch vụ Google Drive.';
    return {
      ok: false,
      partial: false,
      attempted: true,
      restoredIds: [],
      alreadyInTargetIds: [],
      alreadyMissingIds: [],
      failedFiles: uniqueFileIds.map((fileId) => ({ fileId, error: errMsg })),
      fileResults: uniqueFileIds.map((fileId) => ({
        fileId,
        status: 'failed',
        error: errMsg,
        updatedAt: new Date().toISOString(),
      })),
      error: errMsg,
    };
  }

  const apiBase = getGoogleDriveApiBaseUrl();
  let fallbackTargetFolderId: string;
  try {
    const cachedEntry = folderCache ? folderCache[effectiveCacheKey] : undefined;
    const resolvedFolders = await resolveServiceAccountTargetFolder(
      accessToken,
      config.folderId,
      hierarchy,
      cachedEntry
    );
    fallbackTargetFolderId = resolvedFolders.categoryFolderId;
    saveCacheEntry({
      bookFolderId: resolvedFolders.bookFolderId,
      yearFolderId: resolvedFolders.yearFolderId,
      categoryFolderId: fallbackTargetFolderId,
      folderPath: hierarchy.displayPath,
    });
  } catch (err: any) {
    const errMsg =
      err?.message ||
      `Không thể khởi tạo thư mục gốc "${hierarchy.displayPath}" trên Google Drive.`;
    return {
      ok: false,
      partial: false,
      attempted: true,
      restoredIds: [],
      alreadyInTargetIds: [],
      alreadyMissingIds: [],
      failedFiles: uniqueFileIds.map((fileId) => ({ fileId, error: errMsg })),
      fileResults: uniqueFileIds.map((fileId) => ({
        fileId,
        status: 'failed',
        error: errMsg,
        updatedAt: new Date().toISOString(),
      })),
      error: errMsg,
    };
  }

  const restoredIds: string[] = [];
  const alreadyInTargetIds: string[] = [];
  const alreadyMissingIds: string[] = [];
  const failedFiles: Array<{ fileId: string; fileName?: string; error: string }> = [];
  const fileResults: DriveDeleteFileResult[] = [];

  for (const fileId of uniqueFileIds) {
    const preferredOriginalId = originalFolderMap[fileId]?.folderId?.trim();
    let destFolderId = fallbackTargetFolderId;

    if (preferredOriginalId && preferredOriginalId !== fallbackTargetFolderId) {
      try {
        const folderCheck = await fetch(
          `${apiBase}/drive/v3/files/${encodeURIComponent(
            preferredOriginalId
          )}?supportsAllDrives=true&fields=id,trashed,mimeType`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (folderCheck.ok) {
          const folderData: any = await folderCheck.json().catch(() => ({}));
          if (
            folderData?.id &&
            !folderData?.trashed &&
            folderData?.mimeType === 'application/vnd.google-apps.folder'
          ) {
            destFolderId = String(folderData.id);
          }
        }
      } catch {
        // fallback to rebuilt hierarchy folder
      }
    }

    try {
      const metaRes = await fetch(
        `${apiBase}/drive/v3/files/${encodeURIComponent(
          fileId
        )}?supportsAllDrives=true&fields=id,name,trashed,parents,appProperties`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (metaRes.status === 404) {
        alreadyMissingIds.push(fileId);
        fileResults.push({
          fileId,
          status: 'already_missing',
          targetFolderId: destFolderId,
          updatedAt: new Date().toISOString(),
        });
        continue;
      }

      const metaData: any = await metaRes.json().catch(() => ({}));
      if (!metaRes.ok) {
        const apiMsg = metaData?.error?.message || metaRes.statusText;
        const errMsg = `Không thể truy cập tệp Google Drive (${metaRes.status}): ${apiMsg}`;
        failedFiles.push({ fileId, error: errMsg });
        fileResults.push({
          fileId,
          status: 'failed',
          targetFolderId: destFolderId,
          error: errMsg,
          updatedAt: new Date().toISOString(),
        });
        continue;
      }

      const fileName = metaData?.name ? String(metaData.name) : undefined;
      if (metaData?.trashed) {
        alreadyMissingIds.push(fileId);
        fileResults.push({
          fileId,
          fileName,
          status: 'already_missing',
          targetFolderId: destFolderId,
          updatedAt: new Date().toISOString(),
        });
        continue;
      }

      const currentParents: string[] = Array.isArray(metaData?.parents)
        ? metaData.parents.map(String).filter(Boolean)
        : [];
      const removeParents = currentParents.filter((p) => p !== destFolderId);

      if (currentParents.includes(destFolderId) && removeParents.length === 0) {
        alreadyInTargetIds.push(fileId);
        fileResults.push({
          fileId,
          fileName,
          status: 'already_in_target',
          targetFolderId: destFolderId,
          updatedAt: new Date().toISOString(),
        });
        continue;
      }

      const queryParts = ['supportsAllDrives=true', 'fields=id,parents'];
      if (!currentParents.includes(destFolderId)) {
        queryParts.push(`addParents=${encodeURIComponent(destFolderId)}`);
      }
      if (removeParents.length > 0) {
        queryParts.push(`removeParents=${encodeURIComponent(removeParents.join(','))}`);
      }

      const patchRes = await fetch(
        `${apiBase}/drive/v3/files/${encodeURIComponent(fileId)}?${queryParts.join('&')}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        }
      );

      const patchData: any = await patchRes.json().catch(() => ({}));
      if (!patchRes.ok) {
        const apiMsg = patchData?.error?.message || patchRes.statusText;
        const errMsg = `Không thể khôi phục tệp "${fileName || fileId}" về thư mục "${hierarchy.displayPath}" (${patchRes.status}): ${apiMsg}`;
        failedFiles.push({ fileId, fileName, error: errMsg });
        fileResults.push({
          fileId,
          fileName,
          status: 'failed',
          previousFolderId: removeParents[0],
          targetFolderId: destFolderId,
          error: errMsg,
          updatedAt: new Date().toISOString(),
        });
        continue;
      }

      restoredIds.push(fileId);
      fileResults.push({
        fileId,
        fileName,
        status: 'moved',
        previousFolderId: removeParents[0],
        targetFolderId: destFolderId,
        updatedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      const errMsg = `Lỗi kết nối Google Drive khi khôi phục tệp (${fileId}): ${
        err?.message || 'Không xác định'
      }`;
      failedFiles.push({ fileId, error: errMsg });
      fileResults.push({
        fileId,
        status: 'failed',
        targetFolderId: destFolderId,
        error: errMsg,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  if (failedFiles.length > 0) {
    const succeededCount = restoredIds.length + alreadyInTargetIds.length;
    const isPartial = succeededCount > 0;
    return {
      ok: false,
      partial: isPartial,
      attempted: true,
      targetFolderId: fallbackTargetFolderId,
      folderPath: hierarchy.displayPath,
      restoredIds,
      alreadyInTargetIds,
      alreadyMissingIds,
      failedFiles,
      fileResults,
      error: isPartial
        ? `Đã khôi phục một phần (${succeededCount}/${uniqueFileIds.length} tệp) về "${hierarchy.displayPath}", còn ${failedFiles.length} tệp lỗi: ${failedFiles[0].error}.`
        : failedFiles[0].error,
    };
  }

  return {
    ok: true,
    partial: false,
    attempted: true,
    targetFolderId: fallbackTargetFolderId,
    folderPath: hierarchy.displayPath,
    restoredIds,
    alreadyInTargetIds,
    alreadyMissingIds,
    failedFiles: [],
    fileResults,
  };
}
