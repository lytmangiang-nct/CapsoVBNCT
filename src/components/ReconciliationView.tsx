import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  BookOpen,
  Calendar,
  CheckCircle2,
  Clock,
  CloudCog,
  ExternalLink,
  FileWarning,
  Filter,
  History,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import type {
  DriveReconciliationHistoryEntry,
  DriveReconciliationItemResult,
  ReconciliationIssueType,
  ReconciliationItem,
  ReconciliationReport,
  RegistryBook,
  User,
} from '../types';
import { hasBookPermission, isSystemAdmin } from '../utils/permissions';

interface ReconciliationViewProps {
  currentUser: User;
  books: RegistryBook[];
  activeBookId: string;
  serverYear: number;
  onOpenDocument: (docId: string) => void;
  onRefreshApp: () => void;
}

const ISSUE_TYPE_LABELS: Record<ReconciliationIssueType, string> = {
  drive_failed: 'Lỗi lưu tệp Drive',
  drive_link_issue: 'Thiếu / Lỗi liên kết Drive',
  sheets_unsynced: 'Chưa đồng bộ Google Trang tính',
  duplicate_number: 'Trùng số thứ tự',
};

const DRIVE_STATUS_LABELS: Record<string, string> = {
  saved: 'Đã lưu Drive',
  uploading: 'Đang lưu',
  failed: 'Lưu thất bại',
  needs_reconcile: 'Cần đối soát Drive',
  none: 'Không đính kèm',
};

function formatDateTimeVn(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export const ReconciliationView: React.FC<ReconciliationViewProps> = ({
  currentUser,
  books,
  activeBookId,
  serverYear,
  onOpenDocument,
  onRefreshApp,
}) => {
  const isAdmin = isSystemAdmin(currentUser);
  const manageableBooks = useMemo(
    () =>
      books.filter(
        (b) => isAdmin || hasBookPermission(currentUser, b.id, 'manage_book')
      ),
    [books, isAdmin, currentUser]
  );

  const [selectedBookId, setSelectedBookId] = useState<string>(() =>
    manageableBooks.some((b) => b.id === activeBookId)
      ? activeBookId
      : manageableBooks[0]?.id || 'all'
  );
  const [selectedYear, setSelectedYear] = useState<string>(String(serverYear));
  const [issueFilter, setIssueFilter] = useState<'all' | ReconciliationIssueType>('all');
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [verifyingDrive, setVerifyingDrive] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBanner, setActionBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  useAutoDismiss(actionBanner, () => setActionBanner(null));
  const [retryingItemId, setRetryingItemId] = useState<string | null>(null);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [bulkSyncing, setBulkSyncing] = useState<boolean>(false);
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null);
  const [bulkDeletingItems, setBulkDeletingItems] = useState<boolean>(false);

  // Admin Tool: Đối soát trạng thái Google Drive
  const [runningDriveReconcile, setRunningDriveReconcile] = useState<boolean>(false);
  const [includeSavedVerify, setIncludeSavedVerify] = useState<boolean>(false);
  const [driveReconcileResult, setDriveReconcileResult] = useState<DriveReconciliationHistoryEntry | null>(null);
  const [driveReconcileHistory, setDriveReconcileHistory] = useState<DriveReconciliationHistoryEntry[]>([]);
  const [showDriveHistory, setShowDriveHistory] = useState<boolean>(false);
  const [deletingHistoryId, setDeletingHistoryId] = useState<string | null>(null);
  const [clearingHistory, setClearingHistory] = useState<boolean>(false);
  const [confirmModal, setConfirmModal] = useState<
    | { kind: 'clear_history'; count: number }
    | { kind: 'delete_items'; items: ReconciliationItem[]; label: string }
    | null
  >(null);

  const fetchDriveHistory = useCallback(async () => {
    try {
      const res = await api.getAdminDriveReconcileHistory(selectedBookId);
      setDriveReconcileHistory(res.history || []);
    } catch {
      // ignore non-fatal history load errors
    }
  }, [selectedBookId]);

  const fetchReport = useCallback(
    async (verifyDrive = false) => {
      if (verifyDrive) {
        setVerifyingDrive(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const res = await api.getReconciliationReport({
          bookId: selectedBookId,
          year: selectedYear,
          verifyDrive,
        });
        setReport(res);
        setSelectedItemIds([]);
      } catch (err: any) {
        setError(err?.message || 'Không thể tải báo cáo đối soát dữ liệu.');
      } finally {
        setLoading(false);
        setVerifyingDrive(false);
      }
    },
    [selectedBookId, selectedYear]
  );

  useEffect(() => {
    fetchReport(false);
    fetchDriveHistory();
  }, [fetchReport, fetchDriveHistory]);

  const handleRunAdminDriveReconcile = async () => {
    if (runningDriveReconcile) return;
    setRunningDriveReconcile(true);
    setActionBanner(null);
    setError(null);
    try {
      const res = await api.runAdminDriveReconcile({
        bookId: selectedBookId,
        year: selectedYear,
        includeSavedVerify,
      });
      const run = res.run;
      setDriveReconcileResult(run);
      setActionBanner({
        type: 'success',
        text: `Đối soát Google Drive hoàn tất (${run.totalScanned} hồ sơ): ${run.verifiedSavedCount} đã xác minh "Đã lưu Drive", ${run.failedCount} thất bại/chưa có tệp, ${run.needsReconcileCount} cần đối soát lại.`,
      });
      await Promise.all([fetchReport(false), fetchDriveHistory()]);
      onRefreshApp();
    } catch (err: any) {
      setActionBanner({
        type: 'error',
        text: err?.message || 'Không thể thực hiện đối soát trạng thái Google Drive.',
      });
    } finally {
      setRunningDriveReconcile(false);
    }
  };

  const yearOptions = useMemo(() => {
    const yrs = new Set<number>([serverYear, serverYear - 1, serverYear - 2]);
    return Array.from(yrs).sort((a, b) => b - a);
  }, [serverYear]);

  const filteredItems = useMemo(() => {
    if (!report) return [];
    if (issueFilter === 'all') return report.items;
    return report.items.filter((i) => i.issueType === issueFilter);
  }, [report, issueFilter]);

  const selectedItems = useMemo(
    () => filteredItems.filter((i) => selectedItemIds.includes(i.id)),
    [filteredItems, selectedItemIds]
  );

  const selectedSheetsDocIds = useMemo(() => {
    const ids = selectedItems
      .filter((i) => i.issueType === 'sheets_unsynced' && i.canRetry)
      .map((i) => i.docId);
    return Array.from(new Set(ids));
  }, [selectedItems]);

  const retryableSheetsDocIds = useMemo(() => {
    const ids = filteredItems
      .filter((i) => i.issueType === 'sheets_unsynced' && i.canRetry)
      .map((i) => i.docId);
    return Array.from(new Set(ids));
  }, [filteredItems]);

  const handleToggleSelectItem = (itemId: string) => {
    setSelectedItemIds((prev) =>
      prev.includes(itemId) ? prev.filter((id) => id !== itemId) : [...prev, itemId]
    );
  };

  const handleSelectAllFiltered = (checked: boolean) => {
    if (checked) {
      setSelectedItemIds(filteredItems.map((i) => i.id));
    } else {
      setSelectedItemIds([]);
    }
  };

  const handleDeleteHistoryItem = async (entry: DriveReconciliationHistoryEntry) => {
    if (deletingHistoryId || clearingHistory) return;
    setDeletingHistoryId(entry.id);
    setActionBanner(null);
    try {
      await api.deleteAdminDriveReconcileHistoryItem(entry.id);
      setDriveReconcileHistory((prev) => prev.filter((h) => h.id !== entry.id));
      if (driveReconcileResult?.id === entry.id) {
        setDriveReconcileResult(null);
      }
      setActionBanner({
        type: 'success',
        text: 'Đã xóa bản ghi lịch sử đối soát Google Drive.',
      });
    } catch (err: any) {
      setActionBanner({
        type: 'error',
        text: err?.message || 'Không thể xóa bản ghi lịch sử đối soát này.',
      });
    } finally {
      setDeletingHistoryId(null);
    }
  };

  const handleConfirmClearHistory = async () => {
    if (clearingHistory) return;
    setClearingHistory(true);
    setActionBanner(null);
    try {
      const res = await api.clearAdminDriveReconcileHistory(selectedBookId);
      setDriveReconcileResult(null);
      setConfirmModal(null);
      await fetchDriveHistory();
      setActionBanner({
        type: 'success',
        text: `Đã xóa ${res.deletedCount} bản ghi lịch sử đối soát Google Drive.`,
      });
    } catch (err: any) {
      setActionBanner({
        type: 'error',
        text: err?.message || 'Không thể xóa lịch sử đối soát Google Drive.',
      });
    } finally {
      setClearingHistory(false);
    }
  };

  const handleDeleteSingleItem = async (item: ReconciliationItem) => {
    if (deletingItemId || bulkDeletingItems) return;
    setDeletingItemId(item.id);
    setActionBanner(null);
    try {
      await api.dismissReconciliationItems([{ docId: item.docId, issueType: item.issueType }]);
      setSelectedItemIds((prev) => prev.filter((id) => id !== item.id));
      setActionBanner({
        type: 'success',
        text: `Đã xóa mục tồn đọng (${item.fullDocNumber}) khỏi danh sách đối soát.`,
      });
      await fetchReport(Boolean(report?.driveChecked));
    } catch (err: any) {
      setActionBanner({
        type: 'error',
        text: err?.message || `Không thể xóa mục ${item.fullDocNumber} khỏi danh sách đối soát.`,
      });
    } finally {
      setDeletingItemId(null);
    }
  };

  const handleConfirmDeleteItems = async (itemsToDelete: ReconciliationItem[]) => {
    if (itemsToDelete.length === 0 || bulkDeletingItems) return;
    setBulkDeletingItems(true);
    setActionBanner(null);
    try {
      const payload = itemsToDelete.map((it) => ({
        docId: it.docId,
        issueType: it.issueType,
      }));
      const res = await api.dismissReconciliationItems(payload);
      setConfirmModal(null);
      setSelectedItemIds([]);
      setActionBanner({
        type: 'success',
        text: `Đã xóa ${res.dismissedCount} mục tồn đọng khỏi danh sách đối soát.`,
      });
      await fetchReport(Boolean(report?.driveChecked));
    } catch (err: any) {
      setActionBanner({
        type: 'error',
        text: err?.message || 'Không thể xóa các mục tồn đọng khỏi danh sách đối soát.',
      });
    } finally {
      setBulkDeletingItems(false);
    }
  };

  const handleRetrySingle = async (item: ReconciliationItem) => {
    if (retryingItemId || !item.canRetry) return;
    setRetryingItemId(item.id);
    setActionBanner(null);
    try {
      await api.retryReconciliationItem({
        docId: item.docId,
        retryKind: item.retryKind,
      });
      setActionBanner({
        type: 'success',
        text: `Đã đồng bộ lại hồ sơ ${item.fullDocNumber} thành công.`,
      });
      await fetchReport(Boolean(report?.driveChecked));
      onRefreshApp();
    } catch (err: any) {
      setActionBanner({
        type: 'error',
        text: err?.message || `Thử lại thất bại cho hồ sơ ${item.fullDocNumber}.`,
      });
    } finally {
      setRetryingItemId(null);
    }
  };

  const handleBulkSync = async (targetIds?: string[]) => {
    const ids = targetIds && targetIds.length > 0 ? targetIds : selectedSheetsDocIds;
    if (ids.length === 0 || bulkSyncing) return;
    setBulkSyncing(true);
    setActionBanner(null);
    try {
      const res = await api.bulkSyncReconciliation(ids);
      setActionBanner({
        type: res.failed > 0 ? 'error' : 'success',
        text: `Đã đồng bộ hàng loạt ${res.succeeded}/${res.total} hồ sơ lên Google Trang tính${
          res.failed > 0 ? ` (${res.failed} hồ sơ lỗi)` : ''
        }.`,
      });
      await fetchReport(Boolean(report?.driveChecked));
      onRefreshApp();
    } catch (err: any) {
      setActionBanner({
        type: 'error',
        text: err?.message || 'Lỗi khi đồng bộ hàng loạt lên Google Trang tính.',
      });
    } finally {
      setBulkSyncing(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto py-5 sm:py-8 px-3 sm:px-6 lg:px-8 space-y-5">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-sky-700 shrink-0" />
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900">
              Đối soát dữ liệu Sổ · Drive · Trang tính
            </h1>
          </div>
          <p className="text-xs sm:text-sm text-slate-600 mt-1">
            Kiểm tra trạng thái lưu tệp Google Drive, hàng chờ đồng bộ Google Trang tính và phát hiện trùng số thứ tự.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={loading || verifyingDrive || runningDriveReconcile}
            onClick={() => fetchReport(false)}
            className="inline-flex items-center justify-center gap-1.5 min-h-[40px] px-3.5 py-2 text-xs font-semibold bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 rounded-lg disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Quét nhanh</span>
          </button>

          <button
            type="button"
            disabled={loading || verifyingDrive || runningDriveReconcile}
            onClick={() => fetchReport(true)}
            className="inline-flex items-center justify-center gap-1.5 min-h-[40px] px-4 py-2 text-xs font-semibold bg-sky-700 hover:bg-sky-800 text-white rounded-lg shadow-xs disabled:opacity-50"
          >
            <ShieldCheck className={`w-3.5 h-3.5 ${verifyingDrive ? 'animate-pulse' : ''}`} />
            <span>{verifyingDrive ? 'Đang kiểm tra Drive...' : 'Kiểm tra sâu liên kết Drive'}</span>
          </button>
        </div>
      </div>

      {/* Dedicated Admin Tool: Đối soát trạng thái Google Drive */}
      <div className="bg-white border border-emerald-200 rounded-xl p-4 sm:p-5 shadow-xs space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <CloudCog className="w-5 h-5 text-emerald-700 shrink-0" />
              <h2 className="text-sm sm:text-base font-bold text-slate-900">
                Đối soát trạng thái Google Drive
              </h2>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Quét các văn bản đang ở trạng thái <strong>Đang lưu</strong>, <strong>Lưu thất bại</strong>,{' '}
              <strong>Cần đối soát Drive</strong> hoặc thiếu liên kết Drive trong phạm vi sổ đang chọn; xác minh trực tiếp theo{' '}
              <code>fileId</code> và mã hồ sơ nội bộ trong đúng thư mục sổ (không khớp chỉ bằng tên tệp, không tạo tệp trùng, không sửa số hay tên văn bản).
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg cursor-pointer">
              <input
                type="checkbox"
                checked={includeSavedVerify}
                onChange={(e) => setIncludeSavedVerify(e.target.checked)}
                className="rounded border-slate-300 text-emerald-700"
              />
              <span>Kiểm tra cả hồ sơ Đã lưu Drive</span>
            </label>

            <button
              type="button"
              data-testid="btn-admin-drive-reconcile"
              disabled={runningDriveReconcile}
              onClick={handleRunAdminDriveReconcile}
              className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 text-xs font-bold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white rounded-lg shadow-xs transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${runningDriveReconcile ? 'animate-spin' : ''}`} />
              <span>
                {runningDriveReconcile
                  ? 'Đang đối soát Google Drive...'
                  : 'Đối soát trạng thái Google Drive'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setShowDriveHistory((prev) => !prev)}
              className="inline-flex items-center gap-1.5 min-h-[40px] px-3 py-2 text-xs font-semibold bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 rounded-lg"
            >
              <History className="w-3.5 h-3.5 text-slate-500" />
              <span>Lịch sử ({driveReconcileHistory.length})</span>
            </button>
          </div>
        </div>

        {/* Summary of latest Drive Reconciliation run */}
        {driveReconcileResult && (
          <div className="pt-3 border-t border-slate-100 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
              <span className="font-semibold text-slate-800">
                Kết quả đợt đối soát gần nhất ({driveReconcileResult.totalScanned} hồ sơ đã kiểm tra)
              </span>
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 font-mono text-[11px] text-slate-500">
                  <Clock className="w-3.5 h-3.5" />
                  {driveReconcileResult.completedAtVietnam || formatDateTimeVn(driveReconcileResult.completedAt)}
                </span>
                <button
                  type="button"
                  onClick={() => setDriveReconcileResult(null)}
                  aria-label="Đóng kết quả đối soát"
                  title="Đóng"
                  className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                <span className="text-[11px] font-semibold text-emerald-800 block">
                  Đã xác minh &amp; lưu Drive
                </span>
                <span className="text-xl font-bold font-mono text-emerald-900 tabular-nums mt-0.5 block">
                  {driveReconcileResult.verifiedSavedCount}
                </span>
              </div>

              <div className="bg-rose-50 border border-rose-200 rounded-lg p-3">
                <span className="text-[11px] font-semibold text-rose-800 block">
                  Thất bại / Chưa có tệp
                </span>
                <span className="text-xl font-bold font-mono text-rose-900 tabular-nums mt-0.5 block">
                  {driveReconcileResult.failedCount}
                </span>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                <span className="text-[11px] font-semibold text-amber-800 block">
                  Cần đối soát Drive
                </span>
                <span className="text-xl font-bold font-mono text-amber-900 tabular-nums mt-0.5 block">
                  {driveReconcileResult.needsReconcileCount}
                </span>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                <span className="text-[11px] font-semibold text-slate-600 block">
                  Không đổi
                </span>
                <span className="text-xl font-bold font-mono text-slate-800 tabular-nums mt-0.5 block">
                  {driveReconcileResult.unchangedCount}
                </span>
              </div>
            </div>

            {driveReconcileResult.items.length > 0 && (
              <div className="max-h-72 overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded-lg bg-slate-50/40">
                {driveReconcileResult.items.map((item) => (
                  <div
                    key={item.docId}
                    className="p-2.5 sm:px-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs bg-white"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono font-bold text-slate-900">{item.fullDocNumber}</span>
                        <span className="text-[11px] text-slate-500">({item.bookName})</span>
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200">
                          {DRIVE_STATUS_LABELS[item.previousStatus] || item.previousStatus} →{' '}
                          <strong>{DRIVE_STATUS_LABELS[item.newStatus] || item.newStatus}</strong>
                        </span>
                        {item.matchedBy && (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200">
                            {item.matchedBy === 'file_id' ? 'Khớp fileId' : 'Khớp mã hồ sơ'}
                          </span>
                        )}
                        {item.needsReviewPreserved && (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">
                            Giữ cảnh báo Cần kiểm tra
                          </span>
                        )}
                      </div>
                      <p className="text-slate-700 truncate">{item.docName}</p>
                      <p className="text-[11px] text-slate-500">{item.message}</p>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {item.driveFileUrl && (
                        <a
                          href={item.driveFileUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 rounded-md"
                        >
                          <ExternalLink className="w-3 h-3" />
                          <span>Drive</span>
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => onOpenDocument(item.docId)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 rounded-md"
                      >
                        <span>Mở hồ sơ</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Persistent History of Drive Reconciliations */}
        {showDriveHistory && (
          <div className="pt-3 border-t border-slate-100 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wide flex items-center gap-1.5">
                <History className="w-3.5 h-3.5 text-slate-500" />
                <span>Lịch sử các lần đối soát Google Drive</span>
              </h3>
              {driveReconcileHistory.length > 0 && (
                <button
                  type="button"
                  disabled={clearingHistory || Boolean(deletingHistoryId)}
                  onClick={() =>
                    setConfirmModal({
                      kind: 'clear_history',
                      count: driveReconcileHistory.length,
                    })
                  }
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Xóa tất cả lịch sử</span>
                </button>
              )}
            </div>
            {driveReconcileHistory.length === 0 ? (
              <p className="text-xs text-slate-500 italic">Chưa có lịch sử đối soát Google Drive nào.</p>
            ) : (
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-[11px] text-slate-600">
                      <th className="py-2 px-3">Thời điểm</th>
                      <th className="py-2 px-3">Người thực hiện</th>
                      <th className="py-2 px-3">Phạm vi</th>
                      <th className="py-2 px-3 text-center">Đã quét</th>
                      <th className="py-2 px-3 text-center">Đã lưu Drive</th>
                      <th className="py-2 px-3 text-center">Thất bại</th>
                      <th className="py-2 px-3 text-center">Cần đối soát</th>
                      <th className="py-2 px-3 text-right">Thao tác</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {driveReconcileHistory.map((entry) => (
                      <tr key={entry.id} className="hover:bg-slate-50/70">
                        <td className="py-2 px-3 font-mono text-[11px] whitespace-nowrap text-slate-700">
                          {entry.completedAtVietnam || formatDateTimeVn(entry.completedAt)}
                        </td>
                        <td className="py-2 px-3 font-medium text-slate-800">{entry.actorName}</td>
                        <td className="py-2 px-3 text-slate-600">
                          {entry.bookName}
                          {entry.year && entry.year !== 'all' ? ` · Năm ${entry.year}` : ''}
                        </td>
                        <td className="py-2 px-3 text-center font-mono tabular-nums">{entry.totalScanned}</td>
                        <td className="py-2 px-3 text-center font-mono tabular-nums font-bold text-emerald-700">
                          {entry.verifiedSavedCount}
                        </td>
                        <td className="py-2 px-3 text-center font-mono tabular-nums font-semibold text-rose-700">
                          {entry.failedCount}
                        </td>
                        <td className="py-2 px-3 text-center font-mono tabular-nums font-semibold text-amber-800">
                          {entry.needsReconcileCount}
                        </td>
                        <td className="py-2 px-3 text-right whitespace-nowrap">
                          <button
                            type="button"
                            disabled={deletingHistoryId === entry.id || clearingHistory}
                            onClick={() => handleDeleteHistoryItem(entry)}
                            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-50 border border-rose-200 rounded-md disabled:opacity-50"
                          >
                            {deletingHistoryId === entry.id ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Trash2 className="w-3 h-3" />
                            )}
                            <span>Xóa</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* KPI Strip */}
      {report && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
            <span className="text-xs font-medium text-slate-500 block">Hồ sơ đã quét</span>
            <span className="text-2xl font-bold font-mono text-slate-900 mt-1 block tabular-nums">
              {report.summary.totalDocumentsScanned}
            </span>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
            <span className="text-xs font-medium text-rose-700 block">Lỗi / Thiếu tệp Drive</span>
            <span className="text-2xl font-bold font-mono text-rose-800 mt-1 block tabular-nums">
              {report.summary.driveFailedCount + report.summary.driveLinkIssueCount}
            </span>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
            <span className="text-xs font-medium text-amber-700 block">Chưa đồng bộ Trang tính</span>
            <span className="text-2xl font-bold font-mono text-amber-800 mt-1 block tabular-nums">
              {report.summary.sheetsUnsyncedCount}
            </span>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
            <span className="text-xs font-medium text-purple-700 block">Nghi trùng số thứ tự</span>
            <span className="text-2xl font-bold font-mono text-purple-800 mt-1 block tabular-nums">
              {report.summary.duplicateNumberCount}
            </span>
          </div>
        </div>
      )}

      {/* Filter & Bulk Action Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-3.5 sm:p-4 shadow-xs flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-1.5">
            <BookOpen className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            <select
              aria-label="Chọn sổ đối soát"
              value={selectedBookId}
              onChange={(e) => setSelectedBookId(e.target.value)}
              className="min-h-[40px] px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-medium text-slate-800"
            >
              {manageableBooks.length > 1 && (
                <option value="all">Tất cả sổ quản trị ({manageableBooks.length})</option>
              )}
              {manageableBooks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.unitCode})
                </option>
              ))}
            </select>
          </div>

          <div className="inline-flex items-center gap-1.5">
            <Calendar className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            <select
              aria-label="Năm đối soát"
              value={selectedYear}
              onChange={(e) => setSelectedYear(e.target.value)}
              className="min-h-[40px] px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-medium text-slate-800"
            >
              <option value="all">Tất cả các năm</option>
              {yearOptions.map((yr) => (
                <option key={yr} value={String(yr)}>
                  Năm {yr}
                </option>
              ))}
            </select>
          </div>

          <div className="inline-flex items-center gap-1.5">
            <Filter className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            <select
              aria-label="Loại sai lệch"
              value={issueFilter}
              onChange={(e) => setIssueFilter(e.target.value as 'all' | ReconciliationIssueType)}
              className="min-h-[40px] px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-medium text-slate-800"
            >
              <option value="all">Tất cả vấn đề</option>
              <option value="drive_failed">Lỗi tải Drive</option>
              <option value="drive_link_issue">Thiếu / Lỗi liên kết Drive</option>
              <option value="sheets_unsynced">Chưa đồng bộ Google Trang tính</option>
              <option value="duplicate_number">Trùng số thứ tự</option>
            </select>
          </div>
        </div>

        {filteredItems.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg cursor-pointer">
              <input
                type="checkbox"
                checked={
                  filteredItems.length > 0 &&
                  filteredItems.every((i) => selectedItemIds.includes(i.id))
                }
                onChange={(e) => handleSelectAllFiltered(e.target.checked)}
                className="rounded border-slate-300 text-sky-700"
              />
              <span>Chọn tất cả ({filteredItems.length})</span>
            </label>

            {retryableSheetsDocIds.length > 0 && (
              <button
                type="button"
                disabled={bulkSyncing || selectedSheetsDocIds.length === 0}
                onClick={() => handleBulkSync()}
                className="inline-flex items-center gap-1.5 min-h-[38px] px-3.5 py-1.5 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white rounded-lg"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${bulkSyncing ? 'animate-spin' : ''}`} />
                <span>
                  {bulkSyncing
                    ? 'Đang đồng bộ...'
                    : `Đồng bộ lại Trang tính (${selectedSheetsDocIds.length})`}
                </span>
              </button>
            )}

            {selectedItems.length > 0 ? (
              <button
                type="button"
                disabled={bulkDeletingItems}
                onClick={() =>
                  setConfirmModal({
                    kind: 'delete_items',
                    items: selectedItems,
                    label: `${selectedItems.length} mục đã chọn`,
                  })
                }
                className="inline-flex items-center gap-1.5 min-h-[38px] px-3.5 py-1.5 text-xs font-semibold bg-rose-700 hover:bg-rose-800 disabled:opacity-50 text-white rounded-lg"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Xóa đã chọn ({selectedItems.length})</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={bulkDeletingItems}
                onClick={() =>
                  setConfirmModal({
                    kind: 'delete_items',
                    items: filteredItems,
                    label: `tất cả ${filteredItems.length} mục đang lọc`,
                  })
                }
                className="inline-flex items-center gap-1.5 min-h-[38px] px-3 py-1.5 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 disabled:opacity-50 rounded-lg"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Xóa tất cả ({filteredItems.length})</span>
              </button>
            )}
          </div>
        )}
      </div>

      {actionBanner && (
        <div
          className={`p-3.5 rounded-xl border text-xs flex items-center gap-2 ${
            actionBanner.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-rose-50 border-rose-200 text-rose-900'
          }`}
        >
          {actionBanner.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
          )}
          <span>{actionBanner.text}</span>
        </div>
      )}

      {error && (
        <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Safety note for duplicate numbers */}
      <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
        <span>
          Lưu ý an toàn: Các mục <strong>Trùng số thứ tự</strong> chỉ được cảnh báo để Quản trị viên mở hồ sơ kiểm tra thủ công — hệ thống không bao giờ tự ý xóa hồ sơ hay ghi đè số đã cấp.
        </span>
      </div>

      {/* Results List */}
      {loading ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-xs text-slate-500">
          Đang quét và đối soát dữ liệu...
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-2">
          <CheckCircle2 className="w-8 h-8 text-emerald-500 mx-auto" />
          <p className="text-sm font-semibold text-slate-800">
            Không phát hiện sai lệch nào theo điều kiện đang lọc
          </p>
          <p className="text-xs text-slate-500">
            {report?.driveChecked
              ? 'Đã kiểm tra trực tiếp liên kết Google Drive.'
              : 'Bạn có thể bấm "Kiểm tra sâu liên kết Drive" để xác minh file còn tồn tại trên Google Drive.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredItems.map((item) => {
            const badgeStyle =
              item.severity === 'error'
                ? 'bg-rose-50 text-rose-900 border-rose-200'
                : 'bg-amber-50 text-amber-900 border-amber-200';

            return (
              <div
                key={item.id}
                className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3"
              >
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <input
                    type="checkbox"
                    aria-label={`Chọn mục ${item.fullDocNumber}`}
                    checked={selectedItemIds.includes(item.id)}
                    onChange={() => handleToggleSelectItem(item.id)}
                    className="mt-1 rounded border-slate-300 text-sky-700 shrink-0"
                  />

                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`text-[11px] font-bold px-2 py-0.5 rounded border ${badgeStyle}`}>
                        {ISSUE_TYPE_LABELS[item.issueType]}
                      </span>
                      <span className="font-mono font-bold text-sm text-slate-900">
                        {item.fullDocNumber}
                      </span>
                      <span className="text-[11px] font-medium text-slate-600 bg-slate-100 px-2 py-0.5 rounded border border-slate-200">
                        {item.bookName} · Năm {item.year}
                      </span>
                      {item.driveStateLabel && item.issueType !== 'sheets_unsynced' && (
                        <span className="text-[11px] text-slate-500">
                          ({item.driveStateLabel})
                        </span>
                      )}
                    </div>

                    <p className="text-xs font-semibold text-slate-800 break-words">
                      {item.docName}
                    </p>
                    <p className="text-xs text-slate-600 break-words flex items-start gap-1.5">
                      <FileWarning className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                      <span>{item.detailMessage}</span>
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {item.canRetry && (
                    <button
                      type="button"
                      disabled={retryingItemId === item.id || deletingItemId === item.id}
                      onClick={() => handleRetrySingle(item)}
                      className="inline-flex items-center gap-1.5 min-h-[38px] px-3 py-1.5 text-xs font-semibold bg-sky-700 hover:bg-sky-800 disabled:opacity-50 text-white rounded-lg"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${retryingItemId === item.id ? 'animate-spin' : ''}`} />
                      <span>
                        {item.retryKind === 'word_drive' ? 'Tạo & lưu lại Word' : 'Thử đồng bộ lại'}
                      </span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => onOpenDocument(item.docId)}
                    className="inline-flex items-center gap-1.5 min-h-[38px] px-3 py-1.5 text-xs font-semibold bg-white hover:bg-slate-50 border border-slate-300 text-slate-800 rounded-lg"
                  >
                    <span>Mở hồ sơ</span>
                    <ExternalLink className="w-3.5 h-3.5 text-slate-500" />
                  </button>

                  <button
                    type="button"
                    disabled={deletingItemId === item.id || bulkDeletingItems}
                    onClick={() => handleDeleteSingleItem(item)}
                    title="Xóa khỏi danh sách đối soát"
                    className="inline-flex items-center gap-1.5 min-h-[38px] px-3 py-1.5 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 disabled:opacity-50 rounded-lg"
                  >
                    {deletingItemId === item.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="w-3.5 h-3.5" />
                    )}
                    <span>Xóa</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Compact Confirmation Modal for Bulk Delete / Clear History */}
      {confirmModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-3">
          <div className="bg-white rounded-xl max-w-md w-full p-5 shadow-xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-sm font-bold text-rose-700 flex items-center gap-2">
                <Trash2 className="w-4 h-4 text-rose-600 shrink-0" />
                <span>
                  {confirmModal.kind === 'clear_history'
                    ? 'Xóa lịch sử đối soát'
                    : 'Xóa mục tồn đọng khỏi đối soát'}
                </span>
              </h3>
              <button
                type="button"
                disabled={clearingHistory || bulkDeletingItems}
                onClick={() => setConfirmModal(null)}
                className="text-slate-400 hover:text-slate-700 p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-700">
              {confirmModal.kind === 'clear_history'
                ? `Xác nhận xóa toàn bộ ${confirmModal.count} bản ghi lịch sử đối soát Google Drive trong phạm vi đang chọn?`
                : `Xác nhận xóa ${confirmModal.label} khỏi danh sách Đối soát? (Không xóa hồ sơ gốc trong sổ văn bản)`}
            </p>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                disabled={clearingHistory || bulkDeletingItems}
                onClick={() => setConfirmModal(null)}
                className="min-h-[38px] px-3.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                disabled={clearingHistory || bulkDeletingItems}
                onClick={() => {
                  if (confirmModal.kind === 'clear_history') {
                    void handleConfirmClearHistory();
                  } else {
                    void handleConfirmDeleteItems(confirmModal.items);
                  }
                }}
                className="min-h-[38px] px-4 py-1.5 text-xs font-semibold bg-rose-700 hover:bg-rose-800 disabled:opacity-50 text-white rounded-lg inline-flex items-center gap-1.5"
              >
                {(clearingHistory || bulkDeletingItems) && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                )}
                <span>Xác nhận xóa</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
