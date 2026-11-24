import type { BookPermission, RegistryBook } from '../../types';
import { ALL_BOOK_PERMISSIONS, DEFAULT_BOOK_ID } from '../../utils/permissions';

export type SettingsSubTab =
  | 'books'
  | 'general'
  | 'numbering'
  | 'signers'
  | 'docTypes'
  | 'wordTemplates'
  | 'database'
  | 'googledrive'
  | 'googlesheets'
  | 'users';

export type SettingsGroupKey =
  | 'books_management'
  | 'numbering_catalog'
  | 'storage_sync'
  | 'accounts_permissions';

export interface SettingsNavItemDef {
  id: SettingsSubTab;
  label: string;
  adminOnly?: boolean;
}

export interface SettingsNavGroupDef {
  key: SettingsGroupKey;
  title: string;
  adminOnly?: boolean;
  items: SettingsNavItemDef[];
}

export const SETTINGS_NAV_GROUPS: SettingsNavGroupDef[] = [
  {
    key: 'books_management',
    title: 'Quản lý sổ',
    items: [
      { id: 'books', label: 'Danh sách sổ' },
      { id: 'general', label: 'Thông tin sổ và mẫu số' },
    ],
  },
  {
    key: 'numbering_catalog',
    title: 'Cấp số & Danh mục',
    items: [
      { id: 'numbering', label: 'Quy tắc dãy số và số bắt đầu' },
      { id: 'signers', label: 'Người ký' },
      { id: 'docTypes', label: 'Loại văn bản' },
      { id: 'wordTemplates', label: 'Mẫu Word (.docx)' },
    ],
  },
  {
    key: 'storage_sync',
    title: 'Lưu trữ & Đồng bộ',
    items: [
      { id: 'database', label: 'Upstash Redis & Lưu trữ chính', adminOnly: true },
      { id: 'googledrive', label: 'Google Drive' },
      { id: 'googlesheets', label: 'Google Trang tính', adminOnly: true },
    ],
  },
  {
    key: 'accounts_permissions',
    title: 'Tài khoản & Phân quyền',
    adminOnly: true,
    items: [{ id: 'users', label: 'Tài khoản, vai trò và quyền theo từng sổ', adminOnly: true }],
  },
];

export interface BookIdentityStyle {
  key: 'blue' | 'purple' | 'teal' | 'neutral';
  iconBg: string;
  iconText: string;
  badgeBg: string;
  badgeText: string;
  badgeBorder: string;
  dotColor: string;
}

export function getBookIdentityStyle(book: Pick<RegistryBook, 'id' | 'code'>): BookIdentityStyle {
  const code = (book.code || '').trim().toUpperCase();
  if (book.id === DEFAULT_BOOK_ID || code === 'DOAN_TRUONG') {
    return {
      key: 'blue',
      iconBg: 'bg-sky-100',
      iconText: 'text-sky-700',
      badgeBg: 'bg-sky-50',
      badgeText: 'text-sky-800',
      badgeBorder: 'border-sky-200',
      dotColor: 'bg-sky-600',
    };
  }
  if (code === 'CHI_BO') {
    return {
      key: 'purple',
      iconBg: 'bg-purple-100',
      iconText: 'text-purple-700',
      badgeBg: 'bg-purple-50',
      badgeText: 'text-purple-800',
      badgeBorder: 'border-purple-200',
      dotColor: 'bg-purple-600',
    };
  }
  if (code === 'NHA_TRUONG') {
    return {
      key: 'teal',
      iconBg: 'bg-teal-100',
      iconText: 'text-teal-700',
      badgeBg: 'bg-teal-50',
      badgeText: 'text-teal-800',
      badgeBorder: 'border-teal-200',
      dotColor: 'bg-teal-600',
    };
  }
  return {
    key: 'neutral',
    iconBg: 'bg-slate-100',
    iconText: 'text-slate-600',
    badgeBg: 'bg-slate-100',
    badgeText: 'text-slate-700',
    badgeBorder: 'border-slate-200',
    dotColor: 'bg-slate-500',
  };
}

export interface BookDriveStatusBadge {
  kind: 'connected' | 'unconfigured' | 'error' | 'locked';
  label: string;
  className: string;
  dotColor: string;
}

export function getBookDriveStatusBadge(book: RegistryBook): BookDriveStatusBadge {
  if (!book.isActive) {
    return {
      kind: 'locked',
      label: 'Tạm khóa',
      className: 'bg-slate-100 text-slate-700 border-slate-300',
      dotColor: 'bg-slate-500',
    };
  }
  if (book.googleDriveConfig?.lastCheckStatus === 'error') {
    return {
      kind: 'error',
      label: 'Lỗi kết nối',
      className: 'bg-rose-50 text-rose-800 border-rose-200',
      dotColor: 'bg-rose-600',
    };
  }
  if (book.googleDriveConfig?.isConfigured) {
    return {
      kind: 'connected',
      label: 'Drive đã kết nối',
      className: 'bg-emerald-50 text-emerald-800 border-emerald-200',
      dotColor: 'bg-emerald-600',
    };
  }
  return {
    kind: 'unconfigured',
    label: 'Chưa cấu hình Drive',
    className: 'bg-amber-50 text-amber-800 border-amber-200',
    dotColor: 'bg-amber-500',
  };
}

export const PERMISSION_PRESETS: Array<{ label: string; perms: BookPermission[] }> = [
  { label: 'Chỉ xem', perms: ['view'] },
  { label: 'Chỉ xin số', perms: ['view', 'request_number'] },
  { label: 'Lấy số & Xem sổ', perms: ['view', 'issue_number'] },
  {
    label: 'Cán bộ cấp số',
    perms: ['view', 'request_number', 'issue_number', 'import_incoming', 'edit', 'replace_file', 'export'],
  },
  { label: 'Toàn quyền sổ', perms: [...ALL_BOOK_PERMISSIONS] },
  { label: 'Bỏ hết', perms: [] },
];

export const GOOGLE_APPS_SCRIPT_TEMPLATE = `function parseDdMmYyyyToDate(val) {
  if (val instanceof Date) return val;
  var str = (val === null || val === undefined ? "" : String(val)).trim();
  if (!str) return "";
  var m = str.match(/^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})$/);
  if (!m) return str;
  var day = parseInt(m[1], 10);
  var month = parseInt(m[2], 10);
  var year = parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return str;
  var dt = new Date(year, month - 1, day);
  if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) {
    return str;
  }
  return dt;
}

function resolveCategoryLabel(data) {
  if (data && data.categoryLabel && String(data.categoryLabel).trim()) {
    return String(data.categoryLabel).trim();
  }
  var raw = (data && data.docCategory ? String(data.docCategory) : "").trim().toLowerCase();
  if (raw === "incoming" || raw === "văn bản đến") return "Văn bản đến";
  if (raw === "outgoing" || raw === "văn bản đi") return "Văn bản đi";
  return raw ? String(data.docCategory).trim() : "Văn bản đi";
}

function getOrCreateSheetWithHeaders(ss, name, headers, headerBg) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setBackground(headerBg || "#005BAA");
    headerRange.setFontColor("#FFFFFF");
    headerRange.setFontWeight("bold");
    return sheet;
  }

  // Tự động chuẩn hóa sheet cũ: gộp bỏ cột thừa "Số thứ tự" khi đã có cột "STT"
  var lastCol = sheet.getLastColumn();
  if (lastCol > 0) {
    var existingHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    var sttIdx = existingHeaders.indexOf("STT");
    var dupSeqIdx = existingHeaders.indexOf("Số thứ tự");
    if (sttIdx !== -1 && dupSeqIdx !== -1) {
      sheet.deleteColumn(dupSeqIdx + 1);
    }
  }
  return sheet;
}

function findRowBySystemId(sheet, docId, fallbackIdx) {
  var rows = sheet.getDataRange().getValues();
  if (!rows || rows.length <= 1) return -1;
  var headerRow = rows[0] || [];
  var idColIdx = headerRow.indexOf("Mã hệ thống");
  if (idColIdx === -1) idColIdx = fallbackIdx;
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][idColIdx]) === String(docId)) {
      return i + 1;
    }
  }
  return -1;
}

function removeStaleTestRows(sheet) {
  var rows = sheet.getDataRange().getValues();
  if (!rows || rows.length <= 1) return;
  var headerRow = rows[0] || [];
  var idColIdx = headerRow.indexOf("Mã hệ thống");
  if (idColIdx === -1) idColIdx = 18;
  var numColIdx = headerRow.indexOf("Số/Ký hiệu");
  if (numColIdx === -1) numColIdx = 6;
  for (var i = rows.length - 1; i >= 1; i--) {
    var sysId = String(rows[i][idColIdx] || "").trim();
    var docNo = String(rows[i][numColIdx] || "").trim();
    if (sysId.indexOf("test-sample-") === 0 || docNo.indexOf("00-TEST/") === 0) {
      sheet.deleteRow(i + 1);
    }
  }
}

function renumberSttColumn(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  var count = lastRow - 1;
  var sttValues = [];
  for (var i = 0; i < count; i++) {
    sttValues.push([i + 1]);
  }
  var sttRange = sheet.getRange(2, 1, count, 1);
  sttRange.setValues(sttValues);
  sttRange.setNumberFormat("0");
}

function normalizeExistingSheetRows(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  var count = lastRow - 1;
  var headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var issueCol = headerRow.indexOf("Ngày ban hành") + 1;
  var signCol = headerRow.indexOf("Ngày ký") + 1;
  var catCol = headerRow.indexOf("Nhóm VB") + 1;

  if (issueCol > 0) {
    var issueRange = sheet.getRange(2, issueCol, count, 1);
    var issueVals = issueRange.getValues();
    var issueChanged = false;
    for (var i = 0; i < issueVals.length; i++) {
      var parsed = parseDdMmYyyyToDate(issueVals[i][0]);
      if (parsed instanceof Date && !(issueVals[i][0] instanceof Date)) {
        issueVals[i][0] = parsed;
        issueChanged = true;
      }
    }
    if (issueChanged) issueRange.setValues(issueVals);
    issueRange.setNumberFormat("dd/MM/yyyy");
  }

  if (signCol > 0) {
    var signRange = sheet.getRange(2, signCol, count, 1);
    var signVals = signRange.getValues();
    var signChanged = false;
    for (var j = 0; j < signVals.length; j++) {
      var parsedSign = parseDdMmYyyyToDate(signVals[j][0]);
      if (parsedSign instanceof Date && !(signVals[j][0] instanceof Date)) {
        signVals[j][0] = parsedSign;
        signChanged = true;
      }
    }
    if (signChanged) signRange.setValues(signVals);
    signRange.setNumberFormat("dd/MM/yyyy");
  }

  if (catCol > 0) {
    var catRange = sheet.getRange(2, catCol, count, 1);
    var catVals = catRange.getValues();
    var catChanged = false;
    for (var k = 0; k < catVals.length; k++) {
      var rawCat = String(catVals[k][0] || "").trim().toLowerCase();
      if (rawCat === "incoming") {
        catVals[k][0] = "Văn bản đến";
        catChanged = true;
      } else if (rawCat === "outgoing") {
        catVals[k][0] = "Văn bản đi";
        catChanged = true;
      }
    }
    if (catChanged) catRange.setValues(catVals);
  }
}

function formatDateCellsInRow(sheet, rowIndex) {
  if (rowIndex <= 1) return;
  sheet.getRange(rowIndex, 3, 1, 2).setNumberFormat("dd/MM/yyyy");
}

function verifyOptionalSheetsApiToken(data) {
  var expected = "";
  try {
    var props = PropertiesService.getScriptProperties();
    expected = (props.getProperty("NCT_API_TOKEN") || props.getProperty("API_TOKEN") || "").trim();
  } catch (eProp) {}
  if (!expected) return true;
  var provided = (data && data.apiToken ? String(data.apiToken) : "").trim();
  if (!provided || provided.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    if (!verifyOptionalSheetsApiToken(data)) {
      return ContentService.createTextOutput(JSON.stringify({
        result: "error",
        code: "UNAUTHORIZED",
        error: "Không được phép: sai hoặc thiếu apiToken"
      })).setMimeType(ContentService.MimeType.JSON);
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetName = (data.bookCode || "").toString().trim();
    if (!sheetName) {
      return ContentService.createTextOutput(JSON.stringify({
        result: "error",
        code: "MISSING_BOOK_CODE",
        error: "Thiếu mã sổ (bookCode). Không tự động mặc định sang sổ khác."
      })).setMimeType(ContentService.MimeType.JSON);
    }
    var deletedSheetName = (data.deletedSheetName || "VB đã xóa").toString().trim();

    // Thống nhất DUY NHẤT 1 cột STT (1, 2, 3...) - đã bỏ cột "Số thứ tự" trùng lặp
    var MAIN_HEADERS = [
      "STT", "Năm", "Ngày ban hành", "Ngày ký", "Nhóm VB", "Loại văn bản",
      "Số/Ký hiệu", "Tên văn bản", "Trích yếu/Nội dung",
      "Người ký", "Chức vụ", "Người thao tác", "Trạng thái hồ sơ",
      "Trạng thái tệp Drive", "Tên tệp Drive", "ID tệp Drive", "Liên kết Drive",
      "Ghi chú", "Mã hệ thống", "Mã sổ", "Sổ", "Thời điểm cập nhật"
    ];

    var DELETED_HEADERS = [
      "STT", "Năm", "Ngày ban hành", "Ngày ký", "Nhóm VB", "Loại văn bản",
      "Số/Ký hiệu", "Tên văn bản", "Trích yếu/Nội dung",
      "Người ký", "Chức vụ", "Người thao tác", "Trạng thái hồ sơ",
      "Trạng thái tệp Drive", "Tên tệp Drive", "ID tệp Drive", "Liên kết Drive",
      "Ghi chú", "Mã hệ thống", "Mã sổ", "Sổ",
      "Người xóa", "Thời điểm xóa", "Lý do xóa", "Thời điểm đồng bộ"
    ];

    var docNameVal = data.docName || data.title || "";
    var titleVal = data.title || "";
    var bookNameVal = data.bookName || sheetName;
    var categoryLabelVal = resolveCategoryLabel(data);
    var driveStatusVal = data.driveStatusLabel || data.driveStatus || "Không đính kèm";
    var issueDateVal = parseDdMmYyyyToDate(data.issueDate || "");
    var signDateVal = parseDdMmYyyyToDate(data.signDate || "");
    var nowStr = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
    var action = (data.action || "update").toString().trim();

    // Bước 1 xóa: Tạo/lấy sheet "VB đã xóa" và ghi dòng theo Mã hệ thống (không trùng lặp), giữ liên kết Drive
    if (action === "delete_append_to_deleted" || action === "delete") {
      var delSheet = getOrCreateSheetWithHeaders(ss, deletedSheetName, DELETED_HEADERS, "#991B1B");
      var existingDelRow = findRowBySystemId(delSheet, data.id, 18);
      var delStt = existingDelRow > 0 ? existingDelRow - 1 : Math.max(1, delSheet.getLastRow());
      var delRowValues = [
        delStt, data.year, issueDateVal, signDateVal,
        categoryLabelVal, data.typeName || "",
        data.fullDocNumber || "", docNameVal, titleVal,
        data.signer || "", data.signerRole || "", data.issuedBy || "",
        "Đã xóa", driveStatusVal,
        data.driveFileName || "", data.driveFileId || "", data.driveFileUrl || "",
        data.notes || "", data.id, sheetName, bookNameVal,
        data.deletedBy || "", data.deletedAtVietnam || nowStr, data.deleteReason || "", nowStr
      ];
      if (existingDelRow > 0) {
        delSheet.getRange(existingDelRow, 1, 1, delRowValues.length).setValues([delRowValues]);
        formatDateCellsInRow(delSheet, existingDelRow);
      } else {
        delSheet.appendRow(delRowValues);
        formatDateCellsInRow(delSheet, delSheet.getLastRow());
      }
      renumberSttColumn(delSheet);
      var confirmedDelRow = findRowBySystemId(delSheet, data.id, 18);
      if (confirmedDelRow <= 0) {
        throw new Error("Không xác nhận được dòng đã ghi trong sheet " + deletedSheetName);
      }
      if (action === "delete_append_to_deleted") {
        return ContentService.createTextOutput(JSON.stringify({
          result: "success", action: action, confirmed: true, deletedSheet: deletedSheetName
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    // Bước 2 xóa: Chỉ xóa dòng khỏi sheet chính sau khi đã xác nhận có trong sheet "VB đã xóa"
    if (action === "delete_remove_main" || action === "delete") {
      var verifyDelSheet = ss.getSheetByName(deletedSheetName);
      var verifiedRow = verifyDelSheet ? findRowBySystemId(verifyDelSheet, data.id, 18) : -1;
      if (verifiedRow <= 0) {
        return ContentService.createTextOutput(JSON.stringify({
          result: "error", error: "Chưa tìm thấy hồ sơ trong " + deletedSheetName + ", không xóa khỏi sheet chính."
        })).setMimeType(ContentService.MimeType.JSON);
      }
      var mainSheetForDelete = ss.getSheetByName(sheetName);
      if (mainSheetForDelete) {
        var rowToRemove = findRowBySystemId(mainSheetForDelete, data.id, 18);
        if (rowToRemove > 0) {
          mainSheetForDelete.deleteRow(rowToRemove);
          renumberSttColumn(mainSheetForDelete);
        }
      }
      return ContentService.createTextOutput(JSON.stringify({
        result: "success", action: action, removedFromMain: true, tab: sheetName
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // Khôi phục văn bản: xóa khỏi sheet "VB đã xóa" rồi ghi lại vào sheet chính theo đúng Mã hệ thống
    if (action === "restore") {
      var delSheetForRestore = ss.getSheetByName(deletedSheetName);
      if (delSheetForRestore) {
        var delRowIdx = findRowBySystemId(delSheetForRestore, data.id, 18);
        if (delRowIdx > 0) {
          delSheetForRestore.deleteRow(delRowIdx);
          renumberSttColumn(delSheetForRestore);
        }
      }
    }

    var sheet = getOrCreateSheetWithHeaders(ss, sheetName, MAIN_HEADERS, "#005BAA");

    // Kiểm tra kết nối: tự động chuẩn hóa cột, dọn dòng 00-TEST cũ, đánh lại STT 1..N (không thêm dòng rác)
    if (action === "test") {
      removeStaleTestRows(sheet);
      normalizeExistingSheetRows(sheet);
      renumberSttColumn(sheet);
      return ContentService.createTextOutput(JSON.stringify({
        result: "success", action: "test", tab: sheetName, normalized: true
      })).setMimeType(ContentService.MimeType.JSON);
    }

    var foundRowIndex = findRowBySystemId(sheet, data.id, 18);
    var nextStt = foundRowIndex > 0 ? foundRowIndex - 1 : Math.max(1, sheet.getLastRow());
    var rowValues = [
      nextStt, data.year, issueDateVal, signDateVal,
      categoryLabelVal, data.typeName || "",
      data.fullDocNumber || "", docNameVal, titleVal, data.signer || "", data.signerRole || "",
      data.issuedBy || "", data.status || "", driveStatusVal,
      data.driveFileName || "", data.driveFileId || "", data.driveFileUrl || "",
      data.notes || "", data.id, sheetName, bookNameVal, nowStr
    ];

    if (foundRowIndex > 0) {
      sheet.getRange(foundRowIndex, 1, 1, rowValues.length).setValues([rowValues]);
      formatDateCellsInRow(sheet, foundRowIndex);
    } else {
      sheet.appendRow(rowValues);
      formatDateCellsInRow(sheet, sheet.getLastRow());
    }
    renumberSttColumn(sheet);

    return ContentService.createTextOutput(JSON.stringify({result: "success", tab: sheetName}))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({result: "error", error: err.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}`;

export const GOOGLE_DRIVE_APPS_SCRIPT_TEMPLATE = `function verifyCachedFolder(parent, cachedId, expectedName) {
  var id = (cachedId || "").toString().trim();
  var trimmed = (expectedName || "").toString().trim();
  if (!id || !trimmed) return null;
  try {
    var folder = DriveApp.getFolderById(id);
    if (!folder || folder.isTrashed()) return null;
    if (folder.getName().toString().trim().toLowerCase() !== trimmed.toLowerCase()) return null;
    var parents = folder.getParents();
    var parentId = parent.getId();
    while (parents.hasNext()) {
      if (parents.next().getId() === parentId) {
        return folder;
      }
    }
  } catch (err) {}
  return null;
}

function getOrCreateSubFolder(parent, name, cachedId) {
  var trimmed = (name || "").toString().trim();
  if (!trimmed) return parent;
  var cached = verifyCachedFolder(parent, cachedId, trimmed);
  if (cached) return cached;

  var folders = parent.getFoldersByName(trimmed);
  while (folders.hasNext()) {
    var candidate = folders.next();
    if (!candidate.isTrashed()) {
      return candidate;
    }
  }
  return parent.createFolder(trimmed);
}

function resolveHierarchyFolder(rootFolder, data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var rootName = (rootFolder.getName() || "").toString().trim();
    var bookName = (data.bookName || "").toString().trim();
    var bookFolder = rootFolder;
    var bookFolderId = "";

    if (bookName && rootName.toLowerCase() !== bookName.toLowerCase()) {
      bookFolder = getOrCreateSubFolder(rootFolder, bookName, data.cachedBookFolderId);
      bookFolderId = bookFolder.getId();
    }

    var yearLabel = (data.year !== undefined && data.year !== null ? String(data.year) : "").trim() || "Chưa xác định năm";
    var yearFolder = getOrCreateSubFolder(bookFolder, yearLabel, data.cachedYearFolderId);
    var catLabel = (data.categoryFolder || "").toString().trim();
    var target = catLabel ? getOrCreateSubFolder(yearFolder, catLabel, data.cachedCategoryFolderId) : yearFolder;

    var displayBook = bookName || rootName || "Sổ văn bản";
    var folderPath = displayBook + "/" + yearLabel + (catLabel ? "/" + catLabel : "");

    return {
      folder: target,
      bookFolderId: bookFolderId,
      yearFolderId: yearFolder.getId(),
      categoryFolderId: target.getId(),
      folderPath: folderPath
    };
  } finally {
    try { lock.releaseLock(); } catch (eLock) {}
  }
}

function isFolderWithinRoot(folder, rootFolderId, maxDepth) {
  if (!folder || !rootFolderId) return false;
  var limit = maxDepth || 8;
  var queue = [{ f: folder, depth: 0 }];
  var visited = {};
  while (queue.length > 0) {
    var current = queue.shift();
    if (!current || !current.f) continue;
    var cid = current.f.getId();
    if (cid === rootFolderId) return true;
    if (visited[cid] || current.depth >= limit) continue;
    visited[cid] = true;
    try {
      var parents = current.f.getParents();
      while (parents.hasNext()) {
        queue.push({ f: parents.next(), depth: current.depth + 1 });
      }
    } catch (eWalk) {}
  }
  return false;
}

function isFileWithinRoot(fileObj, rootFolderId) {
  if (!fileObj || !rootFolderId) return false;
  try {
    var parents = fileObj.getParents();
    while (parents.hasNext()) {
      var p = parents.next();
      if (isFolderWithinRoot(p, rootFolderId, 8)) {
        return true;
      }
    }
  } catch (eParent) {}
  return false;
}

function fileMatchesRecordIfTagged(fileObj, docId) {
  var cleanDocId = (docId || "").toString().trim();
  if (!cleanDocId || !fileObj) return true;
  var desc = (fileObj.getDescription() || "").toString();
  if (!desc) return true;
  var tagMatch = desc.match(/\\[NCT_DOC_ID:([^\\]]+)\\]/);
  if (tagMatch && tagMatch[1]) {
    return tagMatch[1].trim() === cleanDocId;
  }
  var sysMatch = desc.match(/Mã hệ thống:\\s*([^\\s|]+)/);
  if (sysMatch && sysMatch[1]) {
    return sysMatch[1].trim() === cleanDocId;
  }
  return true;
}

function verifyApiToken(data) {
  var expected = "";
  var legacySecret = "";
  try {
    var props = PropertiesService.getScriptProperties();
    expected = (props.getProperty("NCT_API_TOKEN") || props.getProperty("API_TOKEN") || "").trim();
    legacySecret = (props.getProperty("NCT_DRIVE_SECRET") || "").trim();
  } catch (eProp) {}

  var secretToCheck = expected || legacySecret;
  if (!secretToCheck) {
    return {
      ok: false,
      error: "Chưa cấu hình Script Property NCT_API_TOKEN trong Google Apps Script."
    };
  }

  var provided = (data && data.apiToken ? String(data.apiToken) : "").trim();
  if (!provided && !expected && legacySecret) {
    provided = (data && data.serverSecret ? String(data.serverSecret) : "").trim();
  }
  if (!provided || provided.length !== secretToCheck.length) {
    return {
      ok: false,
      error: "Không được phép: sai hoặc thiếu apiToken"
    };
  }
  var diff = 0;
  for (var i = 0; i < secretToCheck.length; i++) {
    diff |= secretToCheck.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  if (diff !== 0) {
    return {
      ok: false,
      error: "Không được phép: sai hoặc thiếu apiToken"
    };
  }
  return { ok: true };
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var authCheck = verifyApiToken(data);
    if (!authCheck.ok) {
      return jsonOut({
        result: "error",
        code: "UNAUTHORIZED",
        error: authCheck.error || "Không được phép: sai hoặc thiếu apiToken"
      });
    }

    var folderId = (data.folderId || "").trim();
    if (!folderId) {
      return jsonOut({ result: "error", error: "Thiếu folderId thư mục Google Drive." });
    }

    var rootFolder = DriveApp.getFolderById(folderId);
    var folderName = rootFolder.getName();

    // 1. Kiểm tra kết nối & quyền ghi thực tế vào thư mục
    if (data.action === "test") {
      var probe = rootFolder.createFile(".nct_check_write_" + Date.now() + ".txt", "OK");
      probe.setTrashed(true);
      var accountEmail = "";
      try { accountEmail = Session.getEffectiveUser().getEmail(); } catch (err) {}
      return jsonOut({
        result: "success",
        folderId: folderId,
        folderName: folderName,
        accountEmail: accountEmail
      });
    }

    // 1b. Kiểm tra nhanh sự tồn tại của tệp theo fileId (dùng cho Đối soát dữ liệu)
    if (data.action === "check_file") {
      var targetFileId = (data.fileId || "").trim();
      if (!targetFileId) {
        return jsonOut({ result: "success", exists: false, status: "not_found" });
      }
      try {
        var checkFile = DriveApp.getFileById(targetFileId);
        if (checkFile.isTrashed()) {
          return jsonOut({ result: "success", exists: false, trashed: true, status: "not_found" });
        }
        return jsonOut({
          result: "success",
          exists: true,
          status: "ok",
          fileName: checkFile.getName(),
          webViewLink: checkFile.getUrl()
        });
      } catch (eCheck) {
        var msgCheck = eCheck.toString().toLowerCase();
        if (msgCheck.indexOf("access") !== -1 || msgCheck.indexOf("permission") !== -1) {
          return jsonOut({ result: "success", exists: false, status: "access_denied", message: eCheck.toString() });
        }
        return jsonOut({ result: "success", exists: false, status: "not_found", message: eCheck.toString() });
      }
    }

    // 1c. Lấy thông tin 1 tệp theo fileId (dùng cho Nhập kho văn bản cũ)
    if (data.action === "get_file") {
      var gId = (data.fileId || "").trim();
      if (!gId) {
        return jsonOut({ result: "success", status: "not_found", error: "Thiếu fileId." });
      }
      try {
        var gf = DriveApp.getFileById(gId);
        if (gf.isTrashed()) {
          return jsonOut({ result: "success", status: "not_found", error: "Tệp đã nằm trong thùng rác." });
        }
        return jsonOut({
          result: "success",
          status: "ok",
          file: {
            fileId: gf.getId(),
            fileName: gf.getName(),
            webViewLink: gf.getUrl(),
            mimeType: gf.getMimeType()
          }
        });
      } catch (eGet) {
        var msgGet = eGet.toString().toLowerCase();
        if (msgGet.indexOf("access") !== -1 || msgGet.indexOf("permission") !== -1) {
          return jsonOut({ result: "success", status: "access_denied", error: eGet.toString() });
        }
        return jsonOut({ result: "success", status: "not_found", error: eGet.toString() });
      }
    }

    // 1d. Liệt kê tệp trong thư mục và thư mục con (dùng cho Nhập kho văn bản cũ)
    if (data.action === "list_files") {
      var maxDepth = Math.min(Math.max(Number(data.maxDepth || 4), 1), 6);
      var collected = [];
      function walkFolder(dir, relPath, depth) {
        var filesIt = dir.getFiles();
        while (filesIt.hasNext() && collected.length < 3000) {
          var item = filesIt.next();
          if (item.isTrashed()) continue;
          collected.push({
            fileId: item.getId(),
            fileName: item.getName(),
            webViewLink: item.getUrl(),
            mimeType: item.getMimeType(),
            folderPath: relPath || folderName
          });
        }
        if (depth < maxDepth) {
          var subIt = dir.getFolders();
          while (subIt.hasNext() && collected.length < 3000) {
            var subDir = subIt.next();
            var nextPath = relPath ? relPath + "/" + subDir.getName() : subDir.getName();
            walkFolder(subDir, nextPath, depth + 1);
          }
        }
      }
      walkFolder(rootFolder, folderName, 1);
      return jsonOut({
        result: "success",
        folderId: folderId,
        folderName: folderName,
        files: collected
      });
    }

    var resolved = resolveHierarchyFolder(rootFolder, data);
    var targetFolder = resolved.folder;
    var docId = (data.docId || "").trim();
    var marker = docId ? "[NCT_DOC_ID:" + docId + "]" : "";

    function findInFolder(dir) {
      if (!marker) return null;
      var files = dir.getFiles();
      while (files.hasNext()) {
        var f = files.next();
        if (!f.isTrashed() && (f.getDescription() || "").indexOf(marker) !== -1) {
          return f;
        }
      }
      return null;
    }

    function findExisting() {
      return findInFolder(targetFolder) || (targetFolder.getId() !== rootFolder.getId() ? findInFolder(rootFolder) : null);
    }

    // 2. Đối soát trước khi tải lên
    if (data.action === "find") {
      var existing = findExisting();
      if (existing) {
        if (data.expectedFileName && existing.getName() !== data.expectedFileName) {
          existing.setName(data.expectedFileName);
        }
        return jsonOut({
          result: "success",
          found: true,
          fileId: existing.getId(),
          fileName: existing.getName(),
          webViewLink: existing.getUrl(),
          folderId: resolved.categoryFolderId,
          targetFolderId: resolved.categoryFolderId,
          bookFolderId: resolved.bookFolderId,
          yearFolderId: resolved.yearFolderId,
          folderPath: resolved.folderPath
        });
      }
      return jsonOut({
        result: "success",
        found: false,
        folderId: resolved.categoryFolderId,
        targetFolderId: resolved.categoryFolderId,
        bookFolderId: resolved.bookFolderId,
        yearFolderId: resolved.yearFolderId,
        folderPath: resolved.folderPath
      });
    }

    // 3. Tải tệp vào đúng cây thư mục Tên sổ / Năm / Văn bản đi | Văn bản đến
    if (data.action === "upload") {
      var dup = data.keepPreviousFile ? null : findExisting();
      if (dup && !data.replaceMode) {
        if (data.fileName && dup.getName() !== data.fileName) {
          dup.setName(data.fileName);
        }
        return jsonOut({
          result: "success",
          deduplicated: true,
          fileId: dup.getId(),
          fileName: dup.getName(),
          webViewLink: dup.getUrl(),
          folderId: resolved.categoryFolderId,
          targetFolderId: resolved.categoryFolderId,
          bookFolderId: resolved.bookFolderId,
          yearFolderId: resolved.yearFolderId,
          folderPath: resolved.folderPath
        });
      }

      if (data.replaceMode && !data.keepPreviousFile) {
        if (data.previousFileId) {
          try { DriveApp.getFileById(data.previousFileId).setTrashed(true); } catch (ePrev) {}
        }
        if (dup) {
          try { dup.setTrashed(true); } catch (eDup) {}
        }
      }

      var bytes = Utilities.base64Decode(data.fileBase64);
      var mimeType = data.mimeType || "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      var blob = Utilities.newBlob(bytes, mimeType, data.fileName);
      var created = targetFolder.createFile(blob);
      created.setDescription(
        "Số văn bản: " + (data.fullDocNumber || "") +
        " | Tên văn bản: " + (data.docName || "") +
        (marker ? " | " + marker : "")
      );

      return jsonOut({
        result: "success",
        fileId: created.getId(),
        fileName: created.getName(),
        webViewLink: created.getUrl(),
        folderId: resolved.categoryFolderId,
        targetFolderId: resolved.categoryFolderId,
        bookFolderId: resolved.bookFolderId,
        yearFolderId: resolved.yearFolderId,
        folderPath: resolved.folderPath
      });
    }

    // 4. Chuyển toàn bộ tệp (chính, phụ lục, phiên bản cũ) sang thư mục "<Tên sổ>/<Năm>/VB đã xóa"
    // Giữ nguyên nội dung và tên tệp, không đưa vào Thùng rác, không tạo bản sao trùng lặp,
    // chỉ cho phép chuyển tệp thuộc phạm vi thư mục gốc đã cấu hình và trả về kết quả chi tiết từng tệp.
    if (data.action === "move_to_deleted") {
      var inputIds = Array.isArray(data.fileIds) ? data.fileIds : (data.fileId ? [data.fileId] : []);
      var seenIds = {};
      var targetId = resolved.categoryFolderId;
      var movedIds = [];
      var alreadyInDeletedIds = [];
      var alreadyMissingIds = [];
      var failedFiles = [];
      var fileResults = [];

      for (var i = 0; i < inputIds.length; i++) {
        var fid = (inputIds[i] || "").toString().trim();
        if (!fid || seenIds[fid]) continue;
        seenIds[fid] = true;

        var fObj = null;
        try {
          fObj = DriveApp.getFileById(fid);
        } catch (getErr) {
          var getMsg = getErr.toString().toLowerCase();
          if (getMsg.indexOf("access") !== -1 || getMsg.indexOf("permission") !== -1) {
            var permErr = "Không có quyền truy cập tệp (" + fid + "): " + getErr.toString();
            failedFiles.push({ fileId: fid, error: permErr });
            fileResults.push({ fileId: fid, status: "failed", targetFolderId: targetId, error: permErr });
            continue;
          }
          alreadyMissingIds.push(fid);
          fileResults.push({ fileId: fid, status: "already_missing", targetFolderId: targetId });
          continue;
        }

        if (!fObj || fObj.isTrashed()) {
          alreadyMissingIds.push(fid);
          fileResults.push({ fileId: fid, status: "already_missing", targetFolderId: targetId });
          continue;
        }

        var fName = fObj.getName();
        if (!isFileWithinRoot(fObj, folderId)) {
          var scopeErr = "Tệp '" + fName + "' nằm ngoài phạm vi thư mục Google Drive đã cấu hình.";
          failedFiles.push({ fileId: fid, fileName: fName, error: scopeErr });
          fileResults.push({ fileId: fid, fileName: fName, status: "failed", targetFolderId: targetId, error: scopeErr });
          continue;
        }

        if (!fileMatchesRecordIfTagged(fObj, docId)) {
          var ownerErr = "Tệp '" + fName + "' không khớp mã bản ghi (" + docId + ").";
          failedFiles.push({ fileId: fid, fileName: fName, error: ownerErr });
          fileResults.push({ fileId: fid, fileName: fName, status: "failed", targetFolderId: targetId, error: ownerErr });
          continue;
        }

        var parentsIt = fObj.getParents();
        var prevFolder = null;
        var alreadyThere = false;
        while (parentsIt.hasNext()) {
          var pFolder = parentsIt.next();
          if (pFolder.getId() === targetId) {
            alreadyThere = true;
          } else if (!prevFolder) {
            prevFolder = pFolder;
          }
        }

        if (alreadyThere && !prevFolder) {
          alreadyInDeletedIds.push(fid);
          fileResults.push({
            fileId: fid,
            fileName: fName,
            status: "already_in_deleted",
            targetFolderId: targetId
          });
          continue;
        }

        try {
          fObj.moveTo(targetFolder);
          movedIds.push(fid);
          fileResults.push({
            fileId: fid,
            fileName: fName,
            status: "moved",
            previousFolderId: prevFolder ? prevFolder.getId() : "",
            targetFolderId: targetId
          });
        } catch (mvErr) {
          var moveErrMsg = "Không thể chuyển tệp '" + fName + "' sang VB đã xóa: " + mvErr.toString();
          failedFiles.push({ fileId: fid, fileName: fName, error: moveErrMsg });
          fileResults.push({
            fileId: fid,
            fileName: fName,
            status: "failed",
            previousFolderId: prevFolder ? prevFolder.getId() : "",
            targetFolderId: targetId,
            error: moveErrMsg
          });
        }
      }

      var hasFailures = failedFiles.length > 0;
      var hasSuccesses = movedIds.length > 0 || alreadyInDeletedIds.length > 0;
      var moveStatus = hasFailures ? (hasSuccesses ? "partial" : "error") : "success";

      return jsonOut({
        result: hasFailures ? (hasSuccesses ? "partial" : "error") : "success",
        status: moveStatus,
        folderId: resolved.categoryFolderId,
        targetFolderId: resolved.categoryFolderId,
        bookFolderId: resolved.bookFolderId,
        yearFolderId: resolved.yearFolderId,
        folderPath: resolved.folderPath,
        movedIds: movedIds,
        alreadyInDeletedIds: alreadyInDeletedIds,
        alreadyMissingIds: alreadyMissingIds,
        failedFiles: failedFiles,
        fileResults: fileResults,
        error: hasFailures ? failedFiles[0].error : ""
      });
    }

    // 5. Khôi phục tệp từ thư mục "VB đã xóa" về đúng thư mục ban đầu (không tạo bản sao, không đổi tên)
    if (data.action === "restore_from_deleted") {
      var restoreIds = Array.isArray(data.fileIds) ? data.fileIds : (data.fileId ? [data.fileId] : []);
      var originalMap = (data.originalFolderMap && typeof data.originalFolderMap === "object") ? data.originalFolderMap : {};
      var seenRestore = {};
      var fallbackTarget = targetFolder;
      var fallbackTargetId = resolved.categoryFolderId;
      var restoredIds = [];
      var alreadyInTargetIds = [];
      var missingRestoreIds = [];
      var restoreFailed = [];
      var restoreResults = [];

      for (var k = 0; k < restoreIds.length; k++) {
        var rfid = (restoreIds[k] || "").toString().trim();
        if (!rfid || seenRestore[rfid]) continue;
        seenRestore[rfid] = true;

        var rfObj = null;
        try {
          rfObj = DriveApp.getFileById(rfid);
        } catch (rGetErr) {
          var rMsg = rGetErr.toString().toLowerCase();
          if (rMsg.indexOf("access") !== -1 || rMsg.indexOf("permission") !== -1) {
            var rPermErr = "Không có quyền khôi phục tệp (" + rfid + "): " + rGetErr.toString();
            restoreFailed.push({ fileId: rfid, error: rPermErr });
            restoreResults.push({ fileId: rfid, status: "failed", targetFolderId: fallbackTargetId, error: rPermErr });
            continue;
          }
          missingRestoreIds.push(rfid);
          restoreResults.push({ fileId: rfid, status: "already_missing", targetFolderId: fallbackTargetId });
          continue;
        }

        if (!rfObj || rfObj.isTrashed()) {
          missingRestoreIds.push(rfid);
          restoreResults.push({ fileId: rfid, status: "already_missing", targetFolderId: fallbackTargetId });
          continue;
        }

        var rfName = rfObj.getName();
        if (!isFileWithinRoot(rfObj, folderId)) {
          var rScopeErr = "Tệp '" + rfName + "' nằm ngoài phạm vi thư mục Google Drive đã cấu hình.";
          restoreFailed.push({ fileId: rfid, fileName: rfName, error: rScopeErr });
          restoreResults.push({ fileId: rfid, fileName: rfName, status: "failed", targetFolderId: fallbackTargetId, error: rScopeErr });
          continue;
        }

        if (!fileMatchesRecordIfTagged(rfObj, docId)) {
          var rOwnerErr = "Tệp '" + rfName + "' không khớp mã bản ghi (" + docId + ").";
          restoreFailed.push({ fileId: rfid, fileName: rfName, error: rOwnerErr });
          restoreResults.push({ fileId: rfid, fileName: rfName, status: "failed", targetFolderId: fallbackTargetId, error: rOwnerErr });
          continue;
        }

        var destFolder = fallbackTarget;
        var origInfo = originalMap[rfid];
        if (origInfo && origInfo.folderId) {
          try {
            var origCand = DriveApp.getFolderById(String(origInfo.folderId).trim());
            if (origCand && !origCand.isTrashed() && isFolderWithinRoot(origCand, folderId, 8)) {
              destFolder = origCand;
            }
          } catch (eOrig) {}
        }
        var destId = destFolder.getId();

        var rParentsIt = rfObj.getParents();
        var rPrevFolder = null;
        var alreadyBack = false;
        while (rParentsIt.hasNext()) {
          var rp = rParentsIt.next();
          if (rp.getId() === destId) {
            alreadyBack = true;
          } else if (!rPrevFolder) {
            rPrevFolder = rp;
          }
        }

        if (alreadyBack && !rPrevFolder) {
          alreadyInTargetIds.push(rfid);
          restoreResults.push({
            fileId: rfid,
            fileName: rfName,
            status: "already_in_target",
            targetFolderId: destId
          });
          continue;
        }

        try {
          rfObj.moveTo(destFolder);
          restoredIds.push(rfid);
          restoreResults.push({
            fileId: rfid,
            fileName: rfName,
            status: "moved",
            previousFolderId: rPrevFolder ? rPrevFolder.getId() : "",
            targetFolderId: destId
          });
        } catch (rMvErr) {
          var rMoveErr = "Không thể khôi phục tệp '" + rfName + "' về thư mục gốc: " + rMvErr.toString();
          restoreFailed.push({ fileId: rfid, fileName: rfName, error: rMoveErr });
          restoreResults.push({
            fileId: rfid,
            fileName: rfName,
            status: "failed",
            previousFolderId: rPrevFolder ? rPrevFolder.getId() : "",
            targetFolderId: destId,
            error: rMoveErr
          });
        }
      }

      var rHasFail = restoreFailed.length > 0;
      var rHasOk = restoredIds.length > 0 || alreadyInTargetIds.length > 0;
      return jsonOut({
        result: rHasFail ? (rHasOk ? "partial" : "error") : "success",
        status: rHasFail ? (rHasOk ? "partial" : "error") : "success",
        folderId: fallbackTargetId,
        targetFolderId: fallbackTargetId,
        bookFolderId: resolved.bookFolderId,
        yearFolderId: resolved.yearFolderId,
        folderPath: resolved.folderPath,
        restoredIds: restoredIds,
        alreadyInTargetIds: alreadyInTargetIds,
        alreadyMissingIds: missingRestoreIds,
        failedFiles: restoreFailed,
        fileResults: restoreResults,
        error: rHasFail ? restoreFailed[0].error : ""
      });
    }

    return jsonOut({ result: "error", error: "Thao tác không hợp lệ: " + data.action });
  } catch (err) {
    return jsonOut({ result: "error", error: err.toString() });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}`;
