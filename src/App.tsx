import React, { useState, useEffect, useCallback, useMemo, Suspense, lazy } from 'react';
import { Navbar, type AppTab, type RegistrySection } from './components/Navbar';
import type { SettingsSubTab } from './components/settings/settingsConstants';
import { LoginModal } from './components/LoginModal';
import { api, buildApiUrl, clearAuth, getStoredToken, getStoredUser, updateStoredUser } from './api';
import { NOTIFICATION_AUTO_DISMISS_MS } from './hooks/useAutoDismiss';

const IssueNumberView = lazy(() =>
  import('./components/IssueNumberView').then((m) => ({ default: m.IssueNumberView }))
);
const ImportPdfView = lazy(() =>
  import('./components/ImportPdfView').then((m) => ({ default: m.ImportPdfView }))
);
const DocumentRegistryView = lazy(() =>
  import('./components/DocumentRegistryView').then((m) => ({ default: m.DocumentRegistryView }))
);
const TasksView = lazy(() =>
  import('./components/TasksView').then((m) => ({ default: m.TasksView }))
);
const ReconciliationView = lazy(() =>
  import('./components/ReconciliationView').then((m) => ({ default: m.ReconciliationView }))
);
const ArchiveImportView = lazy(() =>
  import('./components/ArchiveImportView').then((m) => ({ default: m.ArchiveImportView }))
);
const YearEndClosingView = lazy(() =>
  import('./components/YearEndClosingView').then((m) => ({ default: m.YearEndClosingView }))
);
const StatisticsView = lazy(() =>
  import('./components/StatisticsView').then((m) => ({ default: m.StatisticsView }))
);
const SettingsView = lazy(() =>
  import('./components/SettingsView').then((m) => ({ default: m.SettingsView }))
);
import type {
  BookPermission,
  DocumentRecord,
  DocumentTypeConfig,
  IssuedUploadTask,
  NumberRequest,
  PersistenceStatus,
  RegistryBook,
  SignerConfig,
  SystemSettings,
  User,
} from './types';
import {
  DEFAULT_BOOK_ID,
  getAccessibleBooks,
  getDocBookId,
  hasAnyBookPermission,
  hasBookPermission,
  isSystemAdmin,
} from './utils/permissions';
import { getDocumentFilterYear } from './utils/fileNaming';
import { AlertTriangle, Bell, BookOpen, RefreshCw } from 'lucide-react';

function getClientVietnamTimeFallback() {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = formatter.format(new Date()).split('-');
    return {
      year: parseInt(parts[0], 10),
      formattedDate: `${parts[2]}/${parts[1]}/${parts[0]}`,
    };
  } catch {
    const now = new Date();
    return {
      year: now.getFullYear(),
      formattedDate: now.toLocaleDateString('vi-VN'),
    };
  }
}

const BOOTSTRAP_CACHE_KEY = 'nct_bootstrap_cache_v1';
const BOOTSTRAP_CACHE_TTL_MS = 30 * 60 * 1000;

interface CachedBootstrapPayload {
  cachedAt: number;
  userId: string;
  user: User;
  settings: SystemSettings;
  documentTypes: DocumentTypeConfig[];
  signers: SignerConfig[];
  books: RegistryBook[];
  documents: DocumentRecord[];
  deletedDocuments: DocumentRecord[];
  numberRequests: NumberRequest[];
  serverTimeVietnam?: { year: number; month: number; day: number; formattedDate: string };
  persistenceStatus?: PersistenceStatus;
  legacyReconciliationWarnings?: string[];
  sseSupported?: boolean;
}

function readBootstrapCache(expectedUserId: string): CachedBootstrapPayload | null {
  try {
    const raw = window.sessionStorage.getItem(BOOTSTRAP_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedBootstrapPayload;
    if (!parsed || parsed.userId !== expectedUserId) return null;
    if (typeof parsed.cachedAt !== 'number' || Date.now() - parsed.cachedAt > BOOTSTRAP_CACHE_TTL_MS) {
      return null;
    }
    if (!Array.isArray(parsed.books) || !Array.isArray(parsed.documents)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeBootstrapCache(payload: Omit<CachedBootstrapPayload, 'cachedAt'>) {
  try {
    const serialized = JSON.stringify({ ...payload, cachedAt: Date.now() });
    // Chỉ lưu đệm khi nhỏ hơn 1.8 MB để không làm chậm trình duyệt hoặc đầy sessionStorage
    if (serialized.length < 1_800_000) {
      window.sessionStorage.setItem(BOOTSTRAP_CACHE_KEY, serialized);
    }
  } catch {
    // ignore storage quota errors
  }
}

function clearBootstrapCache() {
  try {
    window.sessionStorage.removeItem(BOOTSTRAP_CACHE_KEY);
  } catch {
    // ignore
  }
}

export default function App() {
  const initialStoredUser = useMemo(() => getStoredUser(), []);
  const initialCachedBoot = useMemo(
    () => (initialStoredUser?.id ? readBootstrapCache(initialStoredUser.id) : null),
    [initialStoredUser?.id]
  );

  const [currentUser, setCurrentUser] = useState<User | null>(initialCachedBoot?.user || null);
  const [authChecking, setAuthChecking] = useState<boolean>(!initialCachedBoot);
  const [sseSupported, setSseSupported] = useState<boolean | null>(
    typeof initialCachedBoot?.sseSupported === 'boolean' ? initialCachedBoot.sseSupported : null
  );
  const skipNextAutoLoadForUserRef = React.useRef<string | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>('issue');
  const [registrySection, setRegistrySection] = useState<RegistrySection>('active');
  const [registryScopeAll, setRegistryScopeAll] = useState<boolean>(false);
  const [registryPresetCategory, setRegistryPresetCategory] = useState<'all' | 'outgoing' | 'incoming' | null>(null);
  const [pendingOpenDocId, setPendingOpenDocId] = useState<string | null>(null);

  const initialVnTime = useMemo(() => getClientVietnamTimeFallback(), []);
  const [serverYear, setServerYear] = useState<number>(initialVnTime.year);
  const serverYearRef = React.useRef<number>(serverYear);
  serverYearRef.current = serverYear;
  const [serverFormattedDate, setServerFormattedDate] = useState<string>(initialVnTime.formattedDate);

  // Core Data (khởi tạo tức thì từ bộ nhớ đệm phiên nếu có, sau đó tự đồng bộ nền mới nhất)
  const [settings, setSettings] = useState<SystemSettings>(
    initialCachedBoot?.settings || {
      unitName: 'Đoàn Trường THPT Nguyễn Chí Thanh',
      unitCode: 'ĐTN',
      numberMode: 'separate',
      numberFormat: '{so}-{loai}/{don_vi}',
      customStartSequences: {},
    }
  );
  const [books, setBooks] = useState<RegistryBook[]>(initialCachedBoot?.books || []);
  const [activeBookId, setActiveBookId] = useState<string>(DEFAULT_BOOK_ID);
  const [numberRequests, setNumberRequests] = useState<NumberRequest[]>(
    initialCachedBoot?.numberRequests || []
  );
  const [documentTypes, setDocumentTypes] = useState<DocumentTypeConfig[]>(
    initialCachedBoot?.documentTypes || []
  );
  const [signers, setSigners] = useState<SignerConfig[]>(initialCachedBoot?.signers || []);
  const [documents, setDocuments] = useState<DocumentRecord[]>(initialCachedBoot?.documents || []);
  const [deletedDocuments, setDeletedDocuments] = useState<DocumentRecord[]>(
    initialCachedBoot?.deletedDocuments || []
  );
  const [loadingData, setLoadingData] = useState<boolean>(false);
  const [settingsLoaded, setSettingsLoaded] = useState<boolean>(Boolean(initialCachedBoot));
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(
    initialCachedBoot ? new Date(initialCachedBoot.cachedAt) : null
  );
  const [syncError, setSyncError] = useState<string | null>(null);
  const [persistenceStatus, setPersistenceStatus] = useState<PersistenceStatus | null>(
    initialCachedBoot?.persistenceStatus || null
  );
  const [legacyReconciliationWarnings, setLegacyReconciliationWarnings] = useState<string[]>(
    initialCachedBoot?.legacyReconciliationWarnings || []
  );
  const [requestedSettingsTab, setRequestedSettingsTab] = useState<SettingsSubTab | null>(null);
  const syncInFlightRef = React.useRef<boolean>(false);
  const lastSyncMsRef = React.useRef<number>(0);

  // Compact Post-Issue Upload Tasks (persisted in sessionStorage across reloads/tab switches)
  const [recentIssueTasks, setRecentIssueTasks] = useState<IssuedUploadTask[]>([]);
  const recentIssueTasksRef = React.useRef<IssuedUploadTask[]>(recentIssueTasks);
  recentIssueTasksRef.current = recentIssueTasks;
  const inFlightUploadFilesRef = React.useRef<Map<string, File>>(new Map());
  const activeClientUploadsRef = React.useRef<Set<string>>(new Set());

  // Live Toast Notification (clears previous timer to prevent premature dismissal)
  const [liveToast, setLiveToast] = useState<{ message: string; type?: 'info' | 'success' } | null>(null);
  const toastTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string, type: 'info' | 'success' = 'info') => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    setLiveToast({ message, type });
    toastTimerRef.current = setTimeout(() => {
      setLiveToast(null);
      toastTimerRef.current = null;
    }, 4000);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const applyServerTime = useCallback((timeVn?: { year?: number; formattedDate?: string }) => {
    if (!timeVn) return;
    if (typeof timeVn.year === 'number' && Number.isFinite(timeVn.year)) {
      setServerYear((prev) => (prev !== timeVn.year ? timeVn.year! : prev));
    }
    if (typeof timeVn.formattedDate === 'string' && timeVn.formattedDate) {
      setServerFormattedDate((prev) => (prev !== timeVn.formattedDate ? timeVn.formattedDate! : prev));
    }
  }, []);

  // 1. Single-Roundtrip Initial Auth + Bootstrap (cắt giảm 50% độ trễ khởi động, giữ dự phòng cho Admin khi Redis chưa cấu hình)
  useEffect(() => {
    let cancelled = false;
    const initApp = async () => {
      syncInFlightRef.current = true;
      setLoadingData(true);
      try {
        const boot = await api.getBootstrap();
        if (cancelled) return;

        if (!boot.user.isActive) {
          clearAuth();
          clearBootstrapCache();
          setCurrentUser(null);
          setSettingsLoaded(false);
          return;
        }

        skipNextAutoLoadForUserRef.current = boot.user.id;
        updateStoredUser(boot.user);
        setCurrentUser(boot.user);
        setSettings(boot.settings);
        setDocumentTypes(boot.documentTypes);
        setSigners(boot.signers);
        setDocuments(boot.documents);
        setDeletedDocuments(boot.deletedDocuments || []);
        setBooks(boot.books);
        setNumberRequests(boot.numberRequests || []);
        if (boot.persistenceStatus) {
          setPersistenceStatus(boot.persistenceStatus);
        }
        setLegacyReconciliationWarnings(boot.legacyReconciliationWarnings || []);
        if (typeof boot.sseSupported === 'boolean') {
          setSseSupported(boot.sseSupported);
        }
        applyServerTime(boot.serverTimeVietnam);
        setSettingsLoaded(true);
        setSyncError(null);
        lastSyncMsRef.current = Date.now();
        setLastSyncAt(new Date());
        writeBootstrapCache({
          userId: boot.user.id,
          user: boot.user,
          settings: boot.settings,
          documentTypes: boot.documentTypes,
          signers: boot.signers,
          books: boot.books,
          documents: boot.documents,
          deletedDocuments: boot.deletedDocuments || [],
          numberRequests: boot.numberRequests || [],
          serverTimeVietnam: boot.serverTimeVietnam,
          persistenceStatus: boot.persistenceStatus,
          legacyReconciliationWarnings: boot.legacyReconciliationWarnings || [],
          sseSupported: boot.sseSupported,
        });
      } catch (err: any) {
        if (cancelled) return;
        if (err?.status === 401) {
          clearAuth();
          clearBootstrapCache();
          setCurrentUser(null);
          setSettingsLoaded(false);
        } else {
          // Trường hợp Redis chưa cấu hình (503) hoặc tạm lỗi: vẫn xác thực Admin qua /api/auth/me để vào Cài đặt xử lý
          if (err?.persistenceStatus) {
            setPersistenceStatus(err.persistenceStatus);
          }
          if (err?.message) {
            setSyncError(err.message);
          }
          try {
            const me = await api.getCurrentUser();
            if (cancelled) return;
            skipNextAutoLoadForUserRef.current = me.user.id;
            setCurrentUser(me.user);
          } catch {
            if (cancelled) return;
            clearAuth();
            clearBootstrapCache();
            setCurrentUser(null);
          }
        }
      } finally {
        if (!cancelled) {
          syncInFlightRef.current = false;
          setLoadingData(false);
          setAuthChecking(false);
        }
      }
    };

    void initApp();

    const handleExpired = () => {
      clearBootstrapCache();
      setCurrentUser(null);
      setSettingsLoaded(false);
      setSseSupported(null);
      setPersistenceStatus(null);
      setLegacyReconciliationWarnings([]);
      setBooks([]);
      setDocuments([]);
      setDeletedDocuments([]);
      setNumberRequests([]);
      setRecentIssueTasks([]);
      inFlightUploadFilesRef.current.clear();
      activeClientUploadsRef.current.clear();
    };
    window.addEventListener('auth_expired', handleExpired);
    return () => {
      cancelled = true;
      window.removeEventListener('auth_expired', handleExpired);
    };
  }, [applyServerTime]);

  const isCompletedIssueTask = (t: IssuedUploadTask): boolean =>
    t.driveStatus === 'none' ||
    (t.driveStatus === 'saved' && Boolean(t.driveFileId) && Boolean(t.driveFileUrl));

  // Load & persist recentIssueTasks per user in sessionStorage
  useEffect(() => {
    if (!currentUser?.id) {
      setRecentIssueTasks([]);
      return;
    }
    try {
      const raw = window.sessionStorage.getItem(`nct_recent_issue_tasks_${currentUser.id}`);
      if (!raw) {
        setRecentIssueTasks([]);
        return;
      }
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const now = Date.now();
        // Completed notifications auto-expire after 30s; active/failed tasks kept up to 6h for retry
        const valid = parsed
          .filter((t: any) => {
            if (
              !t ||
              typeof t.docId !== 'string' ||
              typeof t.fullDocNumber !== 'string' ||
              typeof t.issuedAtMs !== 'number'
            ) {
              return false;
            }
            if (isCompletedIssueTask(t)) {
              const completedAt =
                typeof t.driveCompletedAtMs === 'number' ? t.driveCompletedAtMs : t.issuedAtMs;
              return now - completedAt < NOTIFICATION_AUTO_DISMISS_MS;
            }
            return now - t.issuedAtMs < 6 * 60 * 60 * 1000;
          })
          .slice(0, 5);
        setRecentIssueTasks(valid);
      }
    } catch {
      setRecentIssueTasks([]);
    }
  }, [currentUser?.id]);

  useEffect(() => {
    if (!currentUser?.id) return;
    try {
      const key = `nct_recent_issue_tasks_${currentUser.id}`;
      if (recentIssueTasks.length === 0) {
        window.sessionStorage.removeItem(key);
      } else {
        window.sessionStorage.setItem(key, JSON.stringify(recentIssueTasks.slice(0, 5)));
      }
    } catch {
      // ignore sessionStorage quota errors
    }
  }, [recentIssueTasks, currentUser?.id]);

  // Tự động ẩn thông báo đã cấp số / lưu Drive thành công sau 30 giây
  useEffect(() => {
    if (recentIssueTasks.length === 0) return;
    const now = Date.now();
    let earliestExpireAt = Infinity;
    for (const t of recentIssueTasks) {
      if (!isCompletedIssueTask(t)) continue;
      const completedAt = t.driveCompletedAtMs || t.issuedAtMs;
      const expireAt = completedAt + NOTIFICATION_AUTO_DISMISS_MS;
      if (expireAt < earliestExpireAt) {
        earliestExpireAt = expireAt;
      }
    }
    if (!Number.isFinite(earliestExpireAt)) return;
    const delay = Math.max(0, earliestExpireAt - now);
    const timer = window.setTimeout(() => {
      const cutoff = Date.now();
      setRecentIssueTasks((prev) =>
        prev.filter((t) => {
          if (!isCompletedIssueTask(t)) return true;
          const completedAt = t.driveCompletedAtMs || t.issuedAtMs;
          return cutoff - completedAt < NOTIFICATION_AUTO_DISMISS_MS;
        })
      );
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [recentIssueTasks]);

  const mergeMonotoneDocument = useCallback(
    (existing: DocumentRecord | undefined, incoming: DocumentRecord): DocumentRecord => {
      if (!existing) return incoming;
      const existingSaved = Boolean(
        existing.driveStatus === 'saved' && existing.driveFileId && existing.driveFileUrl
      );
      const incomingSaved = Boolean(
        incoming.driveStatus === 'saved' && incoming.driveFileId && incoming.driveFileUrl
      );
      // Do not allow an older/stale 'uploading' payload to visually downgrade an already verified 'saved' record
      if (existingSaved && incoming.driveStatus === 'uploading' && !incomingSaved) {
        const existingIso = existing.driveLastVerifiedAt || existing.driveUploadedAt || existing.createdAt;
        const incomingIso = incoming.driveUploadStartedAt || incoming.createdAt;
        const existingTs = existingIso ? Date.parse(existingIso) : 0;
        const incomingTs = incomingIso ? Date.parse(incomingIso) : 0;
        if (existingTs >= incomingTs) {
          return existing;
        }
      }
      return incoming;
    },
    []
  );

  const syncIssueTasksWithDocs = useCallback((updatedDocs: DocumentRecord[]) => {
    if (!updatedDocs || updatedDocs.length === 0) return;
    const byId = new Map<string, DocumentRecord>();
    for (const d of updatedDocs) {
      if (d?.id) byId.set(d.id, d);
    }
    setRecentIssueTasks((prev) => {
      if (prev.length === 0) return prev;
      let changed = false;
      const next = prev.map((task) => {
        const doc = byId.get(task.docId);
        if (!doc) return task;
        const verifiedSaved = Boolean(doc.driveStatus === 'saved' && doc.driveFileId && doc.driveFileUrl);
        const nextStatus: IssuedUploadTask['driveStatus'] = verifiedSaved
          ? 'saved'
          : doc.driveStatus === 'needs_reconcile'
          ? 'needs_reconcile'
          : doc.driveStatus === 'failed'
          ? 'failed'
          : doc.driveStatus === 'uploading'
          ? 'uploading'
          : task.hasFileOrTemplate
          ? task.driveStatus
          : 'none';
        const nextFileName = doc.driveFileName || task.driveFileName;
        const nextFileId = doc.driveFileId || task.driveFileId;
        const nextFileUrl = doc.driveFileUrl || task.driveFileUrl;
        const nextError =
          nextStatus === 'saved'
            ? undefined
            : doc.driveError || doc.driveReconcileNote || task.driveError;
        if (
          nextStatus !== task.driveStatus ||
          nextFileName !== task.driveFileName ||
          nextFileId !== task.driveFileId ||
          nextFileUrl !== task.driveFileUrl ||
          nextError !== task.driveError
        ) {
          changed = true;
          if (verifiedSaved) {
            inFlightUploadFilesRef.current.delete(task.docId);
          }
          return {
            ...task,
            driveStatus: nextStatus,
            driveFileName: nextFileName,
            driveFileId: nextFileId,
            driveFileUrl: nextFileUrl,
            driveError: nextError,
            driveCompletedAtMs: verifiedSaved ? task.driveCompletedAtMs || Date.now() : task.driveCompletedAtMs,
          };
        }
        return task;
      });
      return changed ? next : prev;
    });
  }, []);

  const refreshBooks = useCallback(async () => {
    if (!currentUser) return;
    try {
      const res = await api.getBooks();
      setBooks(res.books);
      applyServerTime(res.serverTimeVietnam);
    } catch (err) {
      console.error('Lỗi tải danh sách sổ:', err);
    }
  }, [currentUser, applyServerTime]);

  const refreshRequests = useCallback(async () => {
    if (!currentUser) return;
    try {
      const res = await api.getNumberRequests();
      setNumberRequests(res.requests);
    } catch {
      // ignore if user has no access
    }
  }, [currentUser]);

  // 2. Load Core Application Data (Single-roundtrip /api/bootstrap with 20s auto-cooldown)
  const loadAppData = useCallback(
    async (opts?: { force?: boolean }) => {
      if (!currentUser || syncInFlightRef.current) return;
      if (!opts?.force && Date.now() - lastSyncMsRef.current < 20000) return;
      syncInFlightRef.current = true;
      setLoadingData(true);
      try {
        const boot = await api.getBootstrap();

        if (!boot.user.isActive) {
          clearAuth();
          setCurrentUser(null);
          setSettingsLoaded(false);
          return;
        }

        updateStoredUser(boot.user);
        setCurrentUser((prev) => {
          if (!prev) return boot.user;
          if (
            JSON.stringify(prev.bookPermissions || {}) !== JSON.stringify(boot.user.bookPermissions || {}) ||
            prev.role !== boot.user.role ||
            prev.isActive !== boot.user.isActive ||
            prev.fullName !== boot.user.fullName ||
            (prev.displayName || '') !== (boot.user.displayName || '')
          ) {
            return boot.user;
          }
          return prev;
        });

        setSettings(boot.settings);
        setDocumentTypes(boot.documentTypes);
        setSigners(boot.signers);
        setDocuments((prev) => {
          if (prev.length === 0) return boot.documents;
          const prevMap = new Map(prev.map((d) => [d.id, d]));
          return boot.documents.map((incoming) =>
            mergeMonotoneDocument(prevMap.get(incoming.id), incoming)
          );
        });
        syncIssueTasksWithDocs(boot.documents);
        setDeletedDocuments(boot.deletedDocuments || []);
        setBooks(boot.books);
        setNumberRequests(boot.numberRequests || []);
        if (boot.persistenceStatus) {
          setPersistenceStatus(boot.persistenceStatus);
        }
        setLegacyReconciliationWarnings(boot.legacyReconciliationWarnings || []);
        if (typeof boot.sseSupported === 'boolean') {
          setSseSupported(boot.sseSupported);
        }
        applyServerTime(boot.serverTimeVietnam);

        setSettingsLoaded(true);
        setSyncError(null);
        lastSyncMsRef.current = Date.now();
        setLastSyncAt(new Date());
        writeBootstrapCache({
          userId: boot.user.id,
          user: boot.user,
          settings: boot.settings,
          documentTypes: boot.documentTypes,
          signers: boot.signers,
          books: boot.books,
          documents: boot.documents,
          deletedDocuments: boot.deletedDocuments || [],
          numberRequests: boot.numberRequests || [],
          serverTimeVietnam: boot.serverTimeVietnam,
          persistenceStatus: boot.persistenceStatus,
          legacyReconciliationWarnings: boot.legacyReconciliationWarnings || [],
          sseSupported: boot.sseSupported,
        });
      } catch (err: any) {
        console.error('Lỗi khi tải dữ liệu ứng dụng:', err);
        if (err?.persistenceStatus) {
          setPersistenceStatus(err.persistenceStatus);
        }
        if (err?.status !== 401) {
          setSyncError(err?.message || 'Không thể đồng bộ dữ liệu mới nhất từ máy chủ.');
        }
      } finally {
        syncInFlightRef.current = false;
        setLoadingData(false);
      }
    },
    [currentUser?.id, applyServerTime, mergeMonotoneDocument, syncIssueTasksWithDocs]
  );

  const forceRefreshAppData = useCallback(() => {
    void loadAppData({ force: true });
  }, [loadAppData]);

  useEffect(() => {
    if (!currentUser?.id) return;
    if (skipNextAutoLoadForUserRef.current === currentUser.id) {
      skipNextAutoLoadForUserRef.current = null;
      return;
    }
    void loadAppData({ force: true });
  }, [currentUser?.id, loadAppData]);

  // Tự động nạp dữ liệu mới nhất khi mở Sổ theo dõi / Thống kê / Cài đặt (có cooldown 20s; SSE cập nhật tức thời)
  useEffect(() => {
    if (!currentUser?.id || !settingsLoaded) return;
    if (activeTab === 'settings' || activeTab === 'registry' || activeTab === 'statistics') {
      void loadAppData();
    }
  }, [activeTab, currentUser?.id, settingsLoaded, loadAppData]);

  // 3. Server-Sent Events (SSE) chỉ bật khi máy chủ hỗ trợ kết nối dài (tắt tự động trên Vercel Serverless để tránh treo 60s)
  useEffect(() => {
    if (!currentUser) return;

    let eventSource: EventSource | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let isClosed = false;
    let sseDisabledByServer = sseSupported === false;
    let retryDelayMs = 3000;

    const connectSSE = () => {
      if (isClosed || sseDisabledByServer || sseSupported !== true) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      if (eventSource) {
        try {
          eventSource.close();
        } catch {
          // ignore
        }
      }

      const token = getStoredToken();
      const baseEventsUrl = buildApiUrl('/api/events');
      const eventsUrl = token
        ? `${baseEventsUrl}${baseEventsUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
        : baseEventsUrl;
      eventSource = new EventSource(eventsUrl, { withCredentials: true });

      eventSource.addEventListener('serverless_mode', () => {
        sseDisabledByServer = true;
        setSseSupported(false);
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
      });

      eventSource.addEventListener('connected', () => {
        retryDelayMs = 3000;
      });
      eventSource.onopen = () => {
        retryDelayMs = 3000;
      };

      eventSource.addEventListener('document_issued', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          const newDoc: DocumentRecord = data.document;
          setDocuments((prev) => {
            if (prev.some((d) => d.id === newDoc.id)) return prev;
            return [newDoc, ...prev];
          });
          showToast(`Văn bản mới vừa được ghi: ${newDoc.fullDocNumber}`, 'success');
        } catch (err) {
          console.error(err);
        }
      });

      eventSource.addEventListener('document_updated', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          const updatedDoc: DocumentRecord = data.document;
          if (updatedDoc.status === 'deleted') {
            setDocuments((prev) => prev.filter((d) => d.id !== updatedDoc.id));
            setDeletedDocuments((prev) => {
              if (updatedDoc.deletedListArchived) {
                return prev.filter((d) => d.id !== updatedDoc.id);
              }
              const exists = prev.some((d) => d.id === updatedDoc.id);
              return exists
                ? prev.map((d) => (d.id === updatedDoc.id ? updatedDoc : d))
                : [updatedDoc, ...prev];
            });
          } else {
            setDeletedDocuments((prev) => prev.filter((d) => d.id !== updatedDoc.id));
            setDocuments((prev) => {
              if (!prev.some((d) => d.id === updatedDoc.id)) return [updatedDoc, ...prev];
              return prev.map((d) =>
                d.id === updatedDoc.id ? mergeMonotoneDocument(d, updatedDoc) : d
              );
            });
            syncIssueTasksWithDocs([updatedDoc]);
          }
        } catch (err) {
          console.error(err);
        }
      });

      eventSource.addEventListener('document_cancelled', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          const cancelledDoc: DocumentRecord = data.document;
          setDocuments((prev) =>
            prev.map((d) => (d.id === cancelledDoc.id ? cancelledDoc : d))
          );
          showToast(`Văn bản ${cancelledDoc.fullDocNumber} đã được hủy`, 'info');
        } catch (err) {
          console.error(err);
        }
      });

      eventSource.addEventListener('document_deleted', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          if (data.id) {
            setDocuments((prev) => prev.filter((d) => d.id !== data.id));
          }
          if (data.document) {
            const deletedDoc: DocumentRecord = data.document;
            setDeletedDocuments((prev) => {
              const exists = prev.some((d) => d.id === deletedDoc.id);
              return exists
                ? prev.map((d) => (d.id === deletedDoc.id ? deletedDoc : d))
                : [deletedDoc, ...prev];
            });
            showToast(`Văn bản ${deletedDoc.fullDocNumber} đã chuyển sang VB đã xóa`, 'info');
          }
        } catch (err) {
          console.error(err);
        }
      });

      eventSource.addEventListener('document_restored', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          if (data.id) {
            setDeletedDocuments((prev) => prev.filter((d) => d.id !== data.id));
          }
          if (data.document) {
            const restoredDoc: DocumentRecord = data.document;
            setDocuments((prev) => {
              const exists = prev.some((d) => d.id === restoredDoc.id);
              return exists
                ? prev.map((d) => (d.id === restoredDoc.id ? restoredDoc : d))
                : [restoredDoc, ...prev];
            });
            showToast(`Văn bản ${restoredDoc.fullDocNumber} đã được khôi phục về sổ hiệu lực`, 'success');
          }
        } catch (err) {
          console.error(err);
        }
      });

      eventSource.addEventListener('books_updated', () => {
        refreshBooks();
      });

      eventSource.addEventListener('user_permissions_updated', async (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data || '{}');
          const matchesMe =
            (!data.userId && !data.targetUserId) ||
            data.userId === currentUser.id ||
            data.targetUserId === currentUser.id;
          if (matchesMe) {
            const permsUnchanged =
              data.user &&
              JSON.stringify(currentUser.bookPermissions || {}) ===
                JSON.stringify(data.user.bookPermissions || {}) &&
              currentUser.isActive === data.user.isActive &&
              currentUser.role === data.user.role;
            if (data.user && permsUnchanged && (currentUser.displayName || '') !== (data.user.displayName || '')) {
              updateStoredUser(data.user);
              setCurrentUser(data.user);
              showToast('Tên hiển thị tài khoản của bạn vừa được cập nhật.', 'info');
            } else {
              await loadAppData({ force: true });
              showToast('Quyền truy cập sổ văn bản của bạn vừa được cập nhật.', 'info');
            }
          }
        } catch {
          // ignore
        }
      });

      eventSource.addEventListener('number_requests_updated', () => {
        refreshRequests();
      });

      eventSource.addEventListener('documents_deleted_archived', () => {
        void loadAppData({ force: true });
      });

      eventSource.addEventListener('document_history_cleaned', () => {
        void loadAppData({ force: true });
      });

      eventSource.addEventListener('settings_updated', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          if (data.settings) {
            if (isSystemAdmin(currentUser) || hasAnyBookPermission(currentUser, 'manage_book')) {
              api.getSettings().then((res) => {
                setSettings(res.settings);
                applyServerTime(res.serverTimeVietnam);
              }).catch(() => {});
            } else {
              setSettings(data.settings);
            }
          }
          if (data.documentTypes) setDocumentTypes(data.documentTypes);
          if (data.signers) setSigners(data.signers);
        } catch (err) {
          console.error(err);
        }
      });

      eventSource.onerror = () => {
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        if (isClosed || sseDisabledByServer) return;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        const delay = retryDelayMs;
        retryDelayMs = Math.min(retryDelayMs * 2, 30000);
        reconnectTimeout = setTimeout(connectSSE, delay);
      };
    };

    if (sseSupported === true) {
      connectSSE();
    }

    // Kiểm tra lại định kỳ (45s trên Vercel Serverless, 60s khi có SSE) + khi quay lại tab hoặc có mạng trở lại
    const syncLiveState = () => {
      if (document.visibilityState !== 'visible') return;
      void loadAppData();
    };

    const pollIntervalMs = sseSupported === false ? 45000 : 60000;
    const pollInterval = setInterval(syncLiveState, pollIntervalMs);
    const midnightCheckInterval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const clientVn = getClientVietnamTimeFallback();
      if (clientVn.year !== serverYearRef.current) {
        void loadAppData({ force: true });
      }
    }, 10000);

    const handleVisibilityOrFocus = () => {
      syncLiveState();
    };
    const handleOnline = () => {
      retryDelayMs = 3000;
      if (!eventSource && !isClosed && !sseDisabledByServer && sseSupported === true) {
        connectSSE();
      }
      void loadAppData({ force: true });
    };
    window.addEventListener('focus', handleVisibilityOrFocus);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibilityOrFocus);

    return () => {
      isClosed = true;
      if (eventSource) eventSource.close();
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      clearInterval(pollInterval);
      clearInterval(midnightCheckInterval);
      window.removeEventListener('focus', handleVisibilityOrFocus);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
    };
  }, [currentUser?.id, sseSupported, loadAppData, refreshBooks, refreshRequests, applyServerTime, showToast, mergeMonotoneDocument, syncIssueTasksWithDocs]);

  const accessibleBooks = useMemo(
    () => getAccessibleBooks(currentUser, books),
    [currentUser, books]
  );

  // Ensure activeBookId points to an accessible book
  useEffect(() => {
    if (accessibleBooks.length === 0 || !currentUser) return;
    if (!accessibleBooks.some((b) => b.id === activeBookId)) {
      setActiveBookId(accessibleBooks[0].id);
    }
  }, [accessibleBooks, activeBookId, currentUser]);

  const activeBook: RegistryBook = useMemo(() => {
    const found =
      accessibleBooks.find((b) => b.id === activeBookId) ||
      books.find((b) => b.id === activeBookId) ||
      accessibleBooks[0] ||
      books[0];
    if (found) return found;
    return {
      id: DEFAULT_BOOK_ID,
      code: 'DOAN_TRUONG',
      name: 'Đoàn trường',
      unitName: settings.unitName,
      unitCode: settings.unitCode,
      isShared: true,
      numberMode: settings.numberMode,
      numberFormat: settings.numberFormat,
      customStartSequences: settings.customStartSequences || {},
      signers,
      googleDriveConfig: settings.googleDriveConfig,
      isActive: true,
      createdAt: '',
    };
  }, [accessibleBooks, books, activeBookId, settings, signers]);

  // Enforce permission-based tab fallback strictly for activeBook & currentUser
  useEffect(() => {
    if (!currentUser || loadingData) return;
    const isAdmin = isSystemAdmin(currentUser);
    const hasPerm = (perm: BookPermission) => {
      if (isAdmin) return true;
      if (activeBook?.id && books.some((b) => b.id === activeBook.id)) {
        return hasBookPermission(currentUser, activeBook.id, perm);
      }
      return hasAnyBookPermission(currentUser, perm, books);
    };

    const allowedTabs: AppTab[] = [];
    if (hasPerm('issue_number') || hasPerm('request_number')) {
      allowedTabs.push('issue');
    }
    if (hasPerm('import_incoming')) {
      allowedTabs.push('import_pdf');
    }
    if (hasPerm('view') || hasPerm('delete')) {
      allowedTabs.push('registry');
    }
    if (hasPerm('view')) {
      allowedTabs.push('statistics');
    }
    allowedTabs.push('tasks');
    if (isAdmin || hasAnyBookPermission(currentUser, 'manage_book', books)) {
      allowedTabs.push('reconciliation');
    }
    if (isAdmin || hasAnyBookPermission(currentUser, 'import_archive', books)) {
      allowedTabs.push('archive_import');
    }
    if (isAdmin || hasAnyBookPermission(currentUser, 'close_book', books)) {
      allowedTabs.push('year_end_closing');
    }
    if (hasPerm('manage_book') || isAdmin) {
      allowedTabs.push('settings');
    }

    if (allowedTabs.length > 0 && !allowedTabs.includes(activeTab)) {
      if (allowedTabs.includes('registry')) {
        setRegistrySection(hasPerm('view') ? 'active' : 'deleted');
      }
      setActiveTab(allowedTabs[0]);
    } else if (
      activeTab === 'registry' &&
      !hasPerm('view') &&
      hasPerm('delete') &&
      registrySection !== 'deleted'
    ) {
      setRegistrySection('deleted');
    }
  }, [currentUser, books, activeBook?.id, activeTab, registrySection, loadingData]);

  // Handlers
  const handleLogout = async () => {
    await api.logout();
    clearBootstrapCache();
    setCurrentUser(null);
    setSettingsLoaded(false);
    setSseSupported(null);
    setLastSyncAt(null);
    setSyncError(null);
    setPersistenceStatus(null);
    setLegacyReconciliationWarnings([]);
    setBooks([]);
    setDocuments([]);
    setDeletedDocuments([]);
    setNumberRequests([]);
    setRecentIssueTasks([]);
    inFlightUploadFilesRef.current.clear();
    activeClientUploadsRef.current.clear();
    setActiveBookId(DEFAULT_BOOK_ID);
  };

  const handleDocumentIssued = useCallback((newDoc: DocumentRecord) => {
    setDocuments((prev) => {
      if (prev.some((d) => d.id === newDoc.id)) return prev;
      return [newDoc, ...prev];
    });
    setLastSyncAt(new Date());
  }, []);

  const handleDocumentUpdated = useCallback(
    (updatedDoc: DocumentRecord) => {
      if (updatedDoc.status === 'deleted') {
        setDocuments((prev) => prev.filter((d) => d.id !== updatedDoc.id));
        setDeletedDocuments((prev) => {
          if (updatedDoc.deletedListArchived) {
            return prev.filter((d) => d.id !== updatedDoc.id);
          }
          const exists = prev.some((d) => d.id === updatedDoc.id);
          return exists
            ? prev.map((d) => (d.id === updatedDoc.id ? updatedDoc : d))
            : [updatedDoc, ...prev];
        });
      } else {
        setDeletedDocuments((prev) => prev.filter((d) => d.id !== updatedDoc.id));
        setDocuments((prev) => {
          if (!prev.some((d) => d.id === updatedDoc.id)) return [updatedDoc, ...prev];
          return prev.map((d) => (d.id === updatedDoc.id ? mergeMonotoneDocument(d, updatedDoc) : d));
        });
        syncIssueTasksWithDocs([updatedDoc]);
      }
      setLastSyncAt(new Date());
    },
    [syncIssueTasksWithDocs, mergeMonotoneDocument]
  );

  const verifyDocAfterUncertainUpload = useCallback(
    async (docId: string): Promise<DocumentRecord | null> => {
      try {
        const fresh = await api.getDocument(docId);
        if (fresh?.document) {
          const d = fresh.document;
          const isSaved = Boolean(d.driveStatus === 'saved' && d.driveFileId && d.driveFileUrl);
          if (isSaved) {
            inFlightUploadFilesRef.current.delete(docId);
            handleDocumentUpdated(d);
            return d;
          }
        }
      } catch {
        // fallback to explicit Drive verification endpoint
      }
      try {
        const verified = await api.verifyDocumentDriveStatus(docId);
        if (verified?.document) {
          const d = verified.document;
          if (d.driveStatus === 'saved' && d.driveFileId && d.driveFileUrl) {
            inFlightUploadFilesRef.current.delete(docId);
          }
          handleDocumentUpdated(d);
          return d;
        }
      } catch {
        // unable to verify with server right now
      }
      return null;
    },
    [handleDocumentUpdated]
  );

  // Poll server for uploading tasks not currently driven by an active client request (e.g., after reload or tab switch)
  const uploadingTaskIdsKey = useMemo(
    () =>
      recentIssueTasks
        .filter((t) => t.driveStatus === 'uploading')
        .map((t) => t.docId)
        .join(','),
    [recentIssueTasks]
  );

  useEffect(() => {
    if (!currentUser?.id || !uploadingTaskIdsKey) return;
    let cancelled = false;

    const pollOnce = async () => {
      const ids = uploadingTaskIdsKey.split(',').filter(Boolean);
      for (const docId of ids) {
        if (cancelled) return;
        if (activeClientUploadsRef.current.has(docId)) continue;
        try {
          const res = await api.getDocument(docId);
          if (cancelled || !res?.document) continue;
          const doc = res.document;
          const verifiedSaved = Boolean(doc.driveStatus === 'saved' && doc.driveFileId && doc.driveFileUrl);
          if (verifiedSaved || doc.driveStatus === 'failed' || doc.driveStatus === 'needs_reconcile') {
            handleDocumentUpdated(doc);
          } else if (doc.driveStatus === 'uploading') {
            const startedAtMs = doc.driveUploadStartedAt
              ? Date.parse(doc.driveUploadStartedAt)
              : recentIssueTasksRef.current.find((t) => t.docId === docId)?.issuedAtMs || Date.now();
            if (Date.now() - startedAtMs > 25000) {
              // Trigger real server-side Google Drive verification instead of leaving stuck in 'uploading'
              try {
                const verified = await api.verifyDocumentDriveStatus(docId);
                if (!cancelled && verified?.document) {
                  handleDocumentUpdated(verified.document);
                }
              } catch {
                // will retry on next poll or server sweep
              }
            }
          }
        } catch {
          // ignore transient poll errors
        }
      }
    };

    void pollOnce();
    const timer = window.setInterval(pollOnce, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [currentUser?.id, uploadingTaskIdsKey, handleDocumentUpdated]);

  const startIssueUploadTask = useCallback(
    (issuedDoc: DocumentRecord, file: File | null, issueMs?: number) => {
      const hasFileOrTemplate = Boolean(file || issuedDoc.templateId);
      const verifiedSaved = Boolean(
        issuedDoc.driveStatus === 'saved' && issuedDoc.driveFileId && issuedDoc.driveFileUrl
      );
      const initialStatus: IssuedUploadTask['driveStatus'] = file
        ? 'uploading'
        : verifiedSaved
        ? 'saved'
        : issuedDoc.driveStatus === 'needs_reconcile'
        ? 'needs_reconcile'
        : issuedDoc.driveStatus === 'failed'
        ? 'failed'
        : issuedDoc.templateId
        ? 'uploading'
        : 'none';

      const newTask: IssuedUploadTask = {
        docId: issuedDoc.id,
        bookId: getDocBookId(issuedDoc),
        bookName: issuedDoc.bookName || '',
        typeCode: issuedDoc.typeCode,
        fullDocNumber: issuedDoc.fullDocNumber,
        docName: issuedDoc.docName || issuedDoc.title,
        driveFileName: issuedDoc.driveFileName,
        driveOriginalFileName: file?.name || issuedDoc.driveOriginalFileName,
        hasFileOrTemplate,
        templateId: issuedDoc.templateId,
        driveStatus: initialStatus,
        driveFileId: verifiedSaved ? issuedDoc.driveFileId : undefined,
        driveFileUrl: verifiedSaved ? issuedDoc.driveFileUrl : undefined,
        driveError:
          initialStatus === 'failed' || initialStatus === 'needs_reconcile'
            ? issuedDoc.driveError || issuedDoc.driveReconcileNote
            : undefined,
        issuedAtMs: Date.now(),
        issueMs,
        driveCompletedAtMs: verifiedSaved || initialStatus === 'none' ? Date.now() : undefined,
      };

      setRecentIssueTasks((prev) => {
        const filtered = prev.filter((t) => t.docId !== issuedDoc.id);
        return [newTask, ...filtered].slice(0, 5);
      });

      if (file) {
        inFlightUploadFilesRef.current.set(issuedDoc.id, file);
        activeClientUploadsRef.current.add(issuedDoc.id);
        void api
          .uploadWordToDocument(issuedDoc.id, file, issuedDoc.driveFileName, 'initial')
          .then((res) => {
            const doc = res.document;
            const isVerifiedSaved = Boolean(doc.driveStatus === 'saved' && doc.driveFileId && doc.driveFileUrl);
            if (isVerifiedSaved) {
              inFlightUploadFilesRef.current.delete(issuedDoc.id);
            }
            handleDocumentUpdated(doc);
            if (!isVerifiedSaved) {
              const fallbackStatus: IssuedUploadTask['driveStatus'] =
                doc.driveStatus === 'needs_reconcile' ? 'needs_reconcile' : 'failed';
              setRecentIssueTasks((prev) =>
                prev.map((t) =>
                  t.docId === issuedDoc.id
                    ? {
                        ...t,
                        driveStatus: fallbackStatus,
                        driveError:
                          doc.driveError ||
                          doc.driveReconcileNote ||
                          'Chưa xác nhận được tệp trên Google Drive.',
                      }
                    : t
                )
              );
            }
          })
          .catch(async (uploadErr: any) => {
            // If network dropped before receiving response OR server reported Drive upload succeeded but DB write failed:
            // verify real server/Drive state first so we never show false failure or overwrite a saved file.
            if (!uploadErr?.document || uploadErr?.driveUploadedUnpersisted) {
              const reconciled = await verifyDocAfterUncertainUpload(issuedDoc.id);
              if (reconciled) {
                const isSaved = Boolean(
                  reconciled.driveStatus === 'saved' && reconciled.driveFileId && reconciled.driveFileUrl
                );
                if (isSaved) return;
                setRecentIssueTasks((prev) =>
                  prev.map((t) =>
                    t.docId === issuedDoc.id
                      ? {
                          ...t,
                          driveStatus:
                            reconciled.driveStatus === 'needs_reconcile'
                              ? 'needs_reconcile'
                              : 'failed',
                          driveError:
                            reconciled.driveError ||
                            reconciled.driveReconcileNote ||
                            uploadErr?.message ||
                            'Cần đối soát trạng thái lưu trên Google Drive.',
                        }
                      : t
                  )
                );
                return;
              }
            }

            const targetStatus: IssuedUploadTask['driveStatus'] =
              uploadErr?.document?.driveStatus === 'needs_reconcile' || uploadErr?.driveUploadedUnpersisted
                ? 'needs_reconcile'
                : 'failed';
            const failedDoc: DocumentRecord = uploadErr?.document || {
              ...issuedDoc,
              driveStatus: targetStatus,
              driveOriginalFileName: file.name,
              driveFileSize: file.size,
              driveError: uploadErr?.message || 'Lỗi kết nối Google Drive',
            };
            handleDocumentUpdated(failedDoc);
            setRecentIssueTasks((prev) =>
              prev.map((t) =>
                t.docId === issuedDoc.id
                  ? {
                      ...t,
                      driveStatus: targetStatus,
                      driveError: uploadErr?.message || failedDoc.driveError || 'Lưu tệp thất bại',
                    }
                  : t
              )
            );
          })
          .finally(() => {
            activeClientUploadsRef.current.delete(issuedDoc.id);
          });
      } else if (issuedDoc.templateId && initialStatus === 'uploading') {
        activeClientUploadsRef.current.add(issuedDoc.id);
        void api
          .retryWordDrive(issuedDoc.id, issuedDoc.templateId)
          .then((res) => {
            const doc = res.document;
            handleDocumentUpdated(doc);
            const isVerifiedSaved = Boolean(doc.driveStatus === 'saved' && doc.driveFileId && doc.driveFileUrl);
            if (!isVerifiedSaved) {
              const fallbackStatus: IssuedUploadTask['driveStatus'] =
                doc.driveStatus === 'needs_reconcile' ? 'needs_reconcile' : 'failed';
              setRecentIssueTasks((prev) =>
                prev.map((t) =>
                  t.docId === issuedDoc.id
                    ? {
                        ...t,
                        driveStatus: fallbackStatus,
                        driveError:
                          res.error ||
                          doc.driveError ||
                          doc.driveReconcileNote ||
                          'Chưa lưu được tệp Word từ mẫu lên Google Drive.',
                      }
                    : t
                )
              );
            }
          })
          .catch(async (err: any) => {
            if (!err?.document || err?.driveUploadedUnpersisted) {
              const reconciled = await verifyDocAfterUncertainUpload(issuedDoc.id);
              if (reconciled && reconciled.driveStatus === 'saved' && reconciled.driveFileId && reconciled.driveFileUrl) {
                return;
              }
            }
            if (err?.document) {
              handleDocumentUpdated(err.document);
            }
            const targetStatus: IssuedUploadTask['driveStatus'] =
              err?.document?.driveStatus === 'needs_reconcile' || err?.driveUploadedUnpersisted
                ? 'needs_reconcile'
                : 'failed';
            setRecentIssueTasks((prev) =>
              prev.map((t) =>
                t.docId === issuedDoc.id
                  ? {
                      ...t,
                      driveStatus: targetStatus,
                      driveError: err?.message || 'Lưu tệp từ mẫu thất bại',
                    }
                  : t
              )
            );
          })
          .finally(() => {
            activeClientUploadsRef.current.delete(issuedDoc.id);
          });
      }
    },
    [handleDocumentUpdated, verifyDocAfterUncertainUpload]
  );

  const retryIssueUploadTask = useCallback(
    async (docId: string, overrideFile?: File) => {
      if (activeClientUploadsRef.current.has(docId)) return;
      const task = recentIssueTasks.find((t) => t.docId === docId);

      // If currently needs_reconcile and no new file chosen, run Drive verification first (no duplicate upload)
      if (task?.driveStatus === 'needs_reconcile' && !overrideFile) {
        activeClientUploadsRef.current.add(docId);
        setRecentIssueTasks((prev) =>
          prev.map((t) => (t.docId === docId ? { ...t, driveStatus: 'uploading', driveError: undefined } : t))
        );
        try {
          const verified = await api.verifyDocumentDriveStatus(docId);
          handleDocumentUpdated(verified.document);
          if (verified.document.driveStatus === 'saved' && verified.document.driveFileId && verified.document.driveFileUrl) {
            showToast(`Đã xác minh tệp ${verified.document.fullDocNumber} đã lưu trên Google Drive.`, 'success');
            return;
          }
          if (verified.document.driveStatus === 'needs_reconcile') {
            setRecentIssueTasks((prev) =>
              prev.map((t) =>
                t.docId === docId
                  ? { ...t, driveStatus: 'needs_reconcile', driveError: verified.message }
                  : t
              )
            );
            return;
          }
        } catch (err: any) {
          setRecentIssueTasks((prev) =>
            prev.map((t) =>
              t.docId === docId
                ? {
                    ...t,
                    driveStatus: 'needs_reconcile',
                    driveError: err?.message || 'Không thể đối soát trạng thái Google Drive lúc này.',
                  }
                : t
            )
          );
          return;
        } finally {
          activeClientUploadsRef.current.delete(docId);
        }
      }

      if (overrideFile) {
        inFlightUploadFilesRef.current.set(docId, overrideFile);
      }
      const cachedFile = overrideFile || inFlightUploadFilesRef.current.get(docId);

      if (task?.templateId && !cachedFile) {
        activeClientUploadsRef.current.add(docId);
        setRecentIssueTasks((prev) =>
          prev.map((t) => (t.docId === docId ? { ...t, driveStatus: 'uploading', driveError: undefined } : t))
        );
        try {
          const res = await api.retryWordDrive(docId, task.templateId);
          handleDocumentUpdated(res.document);
          const isVerifiedSaved = Boolean(
            res.document.driveStatus === 'saved' && res.document.driveFileId && res.document.driveFileUrl
          );
          if (!isVerifiedSaved) {
            const fallbackStatus: IssuedUploadTask['driveStatus'] =
              res.document.driveStatus === 'needs_reconcile' ? 'needs_reconcile' : 'failed';
            setRecentIssueTasks((prev) =>
              prev.map((t) =>
                t.docId === docId
                  ? { ...t, driveStatus: fallbackStatus, driveError: res.error || res.document.driveError || 'Lưu tệp thất bại' }
                  : t
              )
            );
          }
        } catch (err: any) {
          if (!err?.document || err?.driveUploadedUnpersisted) {
            const reconciled = await verifyDocAfterUncertainUpload(docId);
            if (reconciled && reconciled.driveStatus === 'saved' && reconciled.driveFileId && reconciled.driveFileUrl) {
              return;
            }
          }
          if (err?.document) handleDocumentUpdated(err.document);
          const targetStatus: IssuedUploadTask['driveStatus'] =
            err?.document?.driveStatus === 'needs_reconcile' || err?.driveUploadedUnpersisted
              ? 'needs_reconcile'
              : 'failed';
          setRecentIssueTasks((prev) =>
            prev.map((t) =>
              t.docId === docId
                ? { ...t, driveStatus: targetStatus, driveError: err?.message || 'Lưu tệp thất bại' }
                : t
            )
          );
        } finally {
          activeClientUploadsRef.current.delete(docId);
        }
        return;
      }

      if (!cachedFile) {
        // Before asking user to re-pick file, verify Drive once in case the file already landed there
        const reconciled = await verifyDocAfterUncertainUpload(docId);
        if (reconciled && reconciled.driveStatus === 'saved' && reconciled.driveFileId && reconciled.driveFileUrl) {
          showToast(`Đã xác minh tệp ${reconciled.fullDocNumber} đã lưu trên Google Drive.`, 'success');
          return;
        }
        setRecentIssueTasks((prev) =>
          prev.map((t) =>
            t.docId === docId
              ? { ...t, driveStatus: 'failed', driveError: 'Vui lòng chọn lại tệp Word để thử lưu lại cho hồ sơ này.' }
              : t
          )
        );
        return;
      }

      activeClientUploadsRef.current.add(docId);
      setRecentIssueTasks((prev) =>
        prev.map((t) => (t.docId === docId ? { ...t, driveStatus: 'uploading', driveError: undefined } : t))
      );
      try {
        const res = await api.uploadWordToDocument(docId, cachedFile, task?.driveFileName, 'retry');
        const doc = res.document;
        const isVerifiedSaved = Boolean(doc.driveStatus === 'saved' && doc.driveFileId && doc.driveFileUrl);
        if (isVerifiedSaved) {
          inFlightUploadFilesRef.current.delete(docId);
        }
        handleDocumentUpdated(doc);
        if (!isVerifiedSaved) {
          const fallbackStatus: IssuedUploadTask['driveStatus'] =
            doc.driveStatus === 'needs_reconcile' ? 'needs_reconcile' : 'failed';
          setRecentIssueTasks((prev) =>
            prev.map((t) =>
              t.docId === docId
                ? { ...t, driveStatus: fallbackStatus, driveError: doc.driveError || 'Lưu tệp thất bại' }
                : t
            )
          );
        }
      } catch (err: any) {
        if (!err?.document || err?.driveUploadedUnpersisted) {
          const reconciled = await verifyDocAfterUncertainUpload(docId);
          if (reconciled && reconciled.driveStatus === 'saved' && reconciled.driveFileId && reconciled.driveFileUrl) {
            return;
          }
        }
        if (err?.document) handleDocumentUpdated(err.document);
        const targetStatus: IssuedUploadTask['driveStatus'] =
          err?.document?.driveStatus === 'needs_reconcile' || err?.driveUploadedUnpersisted
            ? 'needs_reconcile'
            : 'failed';
        setRecentIssueTasks((prev) =>
          prev.map((t) =>
            t.docId === docId
              ? { ...t, driveStatus: targetStatus, driveError: err?.message || 'Lưu tệp thất bại' }
              : t
          )
        );
      } finally {
        activeClientUploadsRef.current.delete(docId);
      }
    },
    [recentIssueTasks, handleDocumentUpdated, verifyDocAfterUncertainUpload, showToast]
  );

  const dismissIssueTask = useCallback((docId: string) => {
    inFlightUploadFilesRef.current.delete(docId);
    setRecentIssueTasks((prev) => prev.filter((t) => t.docId !== docId));
  }, []);

  const handleOpenExistingDocument = (docId: string) => {
    setPendingOpenDocId(docId);
    setRegistrySection('active');
    setActiveTab('registry');
  };

  const handleNavigateToIncomingRegistry = () => {
    setRegistryScopeAll(false);
    setRegistryPresetCategory('incoming');
    setRegistrySection('active');
    setActiveTab('registry');
  };

  // Quick stats summary for server Vietnam year on active book (memoized before early returns)
  const currentYear = serverYear;
  const effectiveRegistryBookId =
    activeTab === 'registry' && registryScopeAll && accessibleBooks.length > 1
      ? 'all'
      : activeBook.id;
  const currentYearDocs = useMemo(
    () =>
      documents.filter((d) => {
        if (getDocumentFilterYear(d) !== currentYear) return false;
        if (effectiveRegistryBookId === 'all') return true;
        return getDocBookId(d) === activeBook.id;
      }),
    [documents, currentYear, effectiveRegistryBookId, activeBook.id]
  );
  const totalCount = currentYearDocs.length;
  const activeBookDeletedDocs = useMemo(
    () =>
      deletedDocuments.filter((d) =>
        effectiveRegistryBookId === 'all' ? true : getDocBookId(d) === activeBook.id
      ),
    [deletedDocuments, effectiveRegistryBookId, activeBook.id]
  );
  const pendingExcelSyncCount = useMemo(
    () =>
      activeBookDeletedDocs.filter(
        (d) => d.excelDeleteSyncStatus === 'failed' || d.excelDeleteSyncStatus === 'pending'
      ).length,
    [activeBookDeletedDocs]
  );

  if (authChecking) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-10 h-10 border-3 border-sky-700 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-xs text-slate-500 font-medium">Đang kiểm tra bảo mật...</p>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return <LoginModal onLoginSuccess={(user) => setCurrentUser(user)} />;
  }

  const noBookPermission = settingsLoaded && accessibleBooks.length === 0;

  return (
    <div className="min-h-[100dvh] bg-slate-50 text-slate-900 flex flex-col font-sans overflow-x-clip">
      {/* Top Navigation Bar */}
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        registrySection={registrySection}
        onSelectRegistrySection={setRegistrySection}
        deletedCount={activeBookDeletedDocs.length}
        pendingExcelSyncCount={pendingExcelSyncCount}
        currentUser={currentUser}
        books={books}
        activeBook={activeBook}
        onLogout={handleLogout}
      />

      {/* Thanh thông tin sổ: Bộ chọn sổ, năm, tổng số văn bản và nút Làm mới dạng biểu tượng */}
      <section
        aria-label="Thông tin sổ văn bản"
        className="bg-sky-900 text-white border-b border-sky-950 py-2.5 px-3 sm:px-6 lg:px-8"
      >
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-2.5 sm:gap-4">
          <div className="flex flex-wrap items-center gap-x-3 sm:gap-x-4 gap-y-2 min-w-0 flex-1">
            {/* Bộ chọn sổ duy nhất */}
            {accessibleBooks.length > 0 && (
              <div className="flex items-center gap-2 bg-sky-800/90 border border-sky-600/80 rounded-lg px-2.5 h-9 shrink-0 max-w-full min-w-0">
                <BookOpen className="w-4 h-4 text-sky-200 shrink-0" />
                <span className="text-xs text-sky-200 font-medium whitespace-nowrap">Sổ:</span>
                {accessibleBooks.length > 1 ? (
                  <select
                    aria-label="Sổ đang chọn"
                    value={effectiveRegistryBookId}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === 'all') {
                        setRegistryScopeAll(true);
                      } else {
                        setRegistryScopeAll(false);
                        setActiveBookId(val);
                      }
                    }}
                    className="min-w-0 max-w-[210px] sm:max-w-[270px] bg-transparent text-white text-xs sm:text-sm font-bold focus:outline-hidden cursor-pointer truncate [&>option]:text-slate-900"
                  >
                    {activeTab === 'registry' && (
                      <option value="all">Tất cả sổ có quyền ({accessibleBooks.length})</option>
                    )}
                    {accessibleBooks.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} ({b.unitCode})
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-xs sm:text-sm font-bold text-white truncate max-w-[220px]">
                    {activeBook.name} ({activeBook.unitCode})
                  </span>
                )}
              </div>
            )}

            {/* Năm & Tổng số văn bản */}
            <div className="flex items-center gap-2 sm:gap-3 text-xs sm:text-sm text-sky-100 whitespace-nowrap tabular-nums">
              <span className="font-bold uppercase tracking-wider text-sky-200">
                Năm {currentYear}
              </span>
              <span className="text-sky-400" aria-hidden="true">·</span>
              <span>
                Tổng: <strong className="font-mono text-white font-bold">{totalCount}</strong> văn bản
              </span>
            </div>
          </div>

          {/* Nút Làm mới duy nhất */}
          <button
            type="button"
            onClick={forceRefreshAppData}
            disabled={loadingData}
            aria-label="Làm mới"
            title={
              lastSyncAt
                ? `Làm mới dữ liệu (Cập nhật lúc ${lastSyncAt.toLocaleTimeString('vi-VN', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })})`
                : 'Làm mới dữ liệu'
            }
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-sky-800/90 hover:bg-sky-700 border border-sky-600/80 text-white text-xs font-semibold transition-colors shrink-0 disabled:opacity-60 whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${loadingData ? 'animate-spin' : ''}`} />
            <span>Làm mới</span>
          </button>
        </div>
      </section>

      {/* Sync Failure / Storage Attention Banner */}
      {syncError && (
        <div className="bg-rose-50 border-b border-rose-200 px-3 sm:px-6 lg:px-8 py-2.5">
          <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2 text-xs text-rose-900">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
              <span className="break-words min-w-0">
                <strong>
                  {persistenceStatus && !persistenceStatus.durable
                    ? `Lưu trữ chính: ${persistenceStatus.connectionLabel}`
                    : 'Chưa cập nhật được dữ liệu'}
                </strong>{' '}
                — {syncError}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {isSystemAdmin(currentUser) && persistenceStatus && !persistenceStatus.durable && (
                <button
                  type="button"
                  onClick={() => {
                    setRequestedSettingsTab('database');
                    setActiveTab('settings');
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] bg-amber-600 hover:bg-amber-700 text-white font-semibold rounded-md transition-colors"
                >
                  <span>Mở Lưu trữ &amp; Đồng bộ (Redis)</span>
                </button>
              )}
              <button
                type="button"
                onClick={forceRefreshAppData}
                disabled={loadingData}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] bg-rose-700 hover:bg-rose-800 text-white font-semibold rounded-md transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingData ? 'animate-spin' : ''}`} />
                <span>Thử lại</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Live Toast Notification */}
      {liveToast && (
        <div className="fixed bottom-3 left-3 right-3 sm:left-auto sm:bottom-6 sm:right-6 sm:max-w-sm z-50 bg-slate-900 text-white px-4 py-3 rounded-xl shadow-xl flex items-center gap-3 animate-slideUp border border-slate-700 text-xs">
          <Bell className="w-4 h-4 text-amber-400 shrink-0" />
          <span className="break-words min-w-0">{liveToast.message}</span>
        </div>
      )}

      {/* Main View Area */}
      <main className="flex-1">
        {noBookPermission ? (
          <div className="max-w-2xl mx-auto my-12 px-4">
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-center space-y-3">
              <AlertTriangle className="w-8 h-8 text-amber-600 mx-auto" />
              <h2 className="text-base font-bold text-amber-950">
                Tài khoản chưa được phân quyền trên sổ văn bản nào
              </h2>
              <p className="text-xs text-amber-900">
                Quyền truy cập của bạn có thể vừa được điều chỉnh bởi Quản trị viên. Vui lòng liên hệ Quản trị viên hoặc bấm Làm mới dữ liệu để kiểm tra lại.
              </p>
              <button
                type="button"
                onClick={forceRefreshAppData}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-amber-700 hover:bg-amber-800 text-white text-xs font-semibold rounded-lg"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingData ? 'animate-spin' : ''}`} />
                <span>Làm mới dữ liệu</span>
              </button>
            </div>
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="max-w-7xl mx-auto py-16 px-4 flex flex-col items-center justify-center gap-3 text-slate-500">
                <div className="w-8 h-8 border-2 border-sky-700 border-t-transparent rounded-full animate-spin" />
                <p className="text-xs font-medium">Đang tải giao diện...</p>
              </div>
            }
          >
            {activeTab === 'issue' && (
              <IssueNumberView
                currentUser={currentUser}
                activeBook={activeBook}
                accessibleBooks={accessibleBooks.length > 0 ? accessibleBooks : [activeBook]}
                onSelectBook={setActiveBookId}
                booksLoaded={settingsLoaded}
                appSyncError={syncError}
                onRetryAppLoad={forceRefreshAppData}
                settings={settings}
                documentTypes={documentTypes}
                signers={signers}
                documents={documents}
                numberRequests={numberRequests}
                serverYear={serverYear}
                serverFormattedDate={serverFormattedDate}
                onServerTimeUpdate={(year, formattedDate) => applyServerTime({ year, formattedDate })}
                onRefreshRequests={refreshRequests}
                onDocumentIssued={handleDocumentIssued}
                onDocumentUpdated={handleDocumentUpdated}
                recentIssueTasks={recentIssueTasks}
                onStartIssueUploadTask={startIssueUploadTask}
                onRetryIssueUploadTask={retryIssueUploadTask}
                onDismissIssueTask={dismissIssueTask}
                hasCachedUploadFile={(docId) => inFlightUploadFilesRef.current.has(docId)}
                onNavigateToRegistry={() => {
                  setRegistrySection('active');
                  setActiveTab('registry');
                }}
                onOpenExistingDocument={handleOpenExistingDocument}
                onDocumentTypeAdded={(newType, updatedBook) => {
                  setDocumentTypes((prev) => {
                    if (prev.some((t) => t.code === newType.code)) {
                      return prev.map((t) => (t.code === newType.code ? newType : t));
                    }
                    return [...prev, newType];
                  });
                  if (updatedBook) {
                    setBooks((prev) =>
                      prev.map((b) => (b.id === updatedBook.id ? updatedBook : b))
                    );
                  }
                  showToast(
                    updatedBook && documentTypes.some((t) => t.code === newType.code)
                      ? `Đã bật loại văn bản ${newType.name} (${newType.code}) cho ${updatedBook.name}`
                      : `Đã thêm loại văn bản mới: ${newType.name} (${newType.code})`,
                    'success'
                  );
                }}
              />
            )}

            {activeTab === 'import_pdf' && (
              <ImportPdfView
                currentUser={currentUser}
                activeBook={activeBook}
                accessibleBooks={accessibleBooks.length > 0 ? accessibleBooks : [activeBook]}
                onSelectBook={setActiveBookId}
                settings={settings}
                serverYear={serverYear}
                onDocumentImported={handleDocumentIssued}
                onDocumentUpdated={handleDocumentUpdated}
                onOpenExistingDocument={handleOpenExistingDocument}
                onNavigateToIncomingRegistry={handleNavigateToIncomingRegistry}
              />
            )}

            {activeTab === 'registry' && (
              <DocumentRegistryView
                documents={documents}
                deletedDocuments={deletedDocuments}
                documentTypes={documentTypes}
                books={books.length > 0 ? books : [activeBook]}
                activeBookId={effectiveRegistryBookId}
                onSelectBookId={(val) => {
                  if (val === 'all') {
                    setRegistryScopeAll(true);
                  } else {
                    setRegistryScopeAll(false);
                    setActiveBookId(val);
                  }
                }}
                settings={settings}
                serverYear={serverYear}
                currentUser={currentUser}
                section={registrySection}
                onSectionChange={setRegistrySection}
                onRefresh={forceRefreshAppData}
                onDocumentUpdated={handleDocumentUpdated}
                initialOpenDocId={pendingOpenDocId}
                onClearInitialOpenDocId={() => setPendingOpenDocId(null)}
                presetCategory={registryPresetCategory}
                onClearPresetCategory={() => setRegistryPresetCategory(null)}
              />
            )}

            {activeTab === 'tasks' && (
              <TasksView
                currentUser={currentUser}
                accessibleBooks={accessibleBooks.length > 0 ? accessibleBooks : [activeBook]}
                activeBookId={activeBook.id}
                onOpenDocument={handleOpenExistingDocument}
              />
            )}

            {activeTab === 'reconciliation' && (
              <ReconciliationView
                currentUser={currentUser}
                books={books.length > 0 ? books : [activeBook]}
                activeBookId={activeBook.id}
                serverYear={serverYear}
                onOpenDocument={handleOpenExistingDocument}
                onRefreshApp={forceRefreshAppData}
              />
            )}

            {activeTab === 'archive_import' && (
              <ArchiveImportView
                currentUser={currentUser}
                books={books.length > 0 ? books : [activeBook]}
                activeBookId={activeBook.id}
                onOpenExistingDocument={handleOpenExistingDocument}
                onDocumentsImported={(createdDocs, updatedBook) => {
                  if (createdDocs.length > 0) {
                    setDocuments((prev) => {
                      const seen = new Set(prev.map((d) => d.id));
                      const fresh = createdDocs.filter((d) => !seen.has(d.id));
                      return [...fresh, ...prev];
                    });
                    setLastSyncAt(new Date());
                    showToast(`Đã nhập ${createdDocs.length} văn bản cũ vào sổ.`, 'success');
                  }
                  if (updatedBook) {
                    setBooks((prev) =>
                      prev.map((b) => (b.id === updatedBook.id ? updatedBook : b))
                    );
                  }
                }}
              />
            )}

            {activeTab === 'year_end_closing' && (
              <YearEndClosingView
                currentUser={currentUser}
                books={books.length > 0 ? books : [activeBook]}
                activeBookId={activeBook.id}
                serverYear={serverYear}
                onOpenDocument={handleOpenExistingDocument}
              />
            )}

            {activeTab === 'statistics' && (
              <StatisticsView
                currentYear={currentYear}
                books={books.length > 0 ? books : [activeBook]}
                activeBookId={activeBook.id}
                onSelectBookId={setActiveBookId}
                currentUser={currentUser}
              />
            )}

            {activeTab === 'settings' && (
              <SettingsView
                currentUser={currentUser}
                books={books.length > 0 ? books : [activeBook]}
                activeBookId={activeBook.id}
                onSelectBookId={setActiveBookId}
                settings={settings}
                documentTypes={documentTypes}
                signers={signers}
                serverYear={serverYear}
                configLoaded={settingsLoaded}
                syncError={syncError}
                persistenceStatus={persistenceStatus}
                legacyReconciliationWarnings={legacyReconciliationWarnings}
                requestedSubTab={requestedSettingsTab}
                onClearRequestedSubTab={() => setRequestedSettingsTab(null)}
                onPersistenceStatusChange={(status) => setPersistenceStatus(status)}
                onSettingsUpdated={(newSettings) => setSettings(newSettings)}
                onBooksUpdated={refreshBooks}
                onRefreshData={forceRefreshAppData}
                onCurrentUserUpdated={(updatedUser) => {
                  updateStoredUser(updatedUser);
                  setCurrentUser(updatedUser);
                }}
              />
            )}
          </Suspense>
        )}
      </main>

      {/* Minimalist Human Footer */}
      <footer className="border-t border-slate-200 bg-white py-4 px-4 text-center text-xs text-slate-500">
        <span>© {currentYear} Đoàn TNCS Hồ Chí Minh - Đoàn Trường THPT Nguyễn Chí Thanh. Bản quyền thuộc về tổ chức Đoàn.</span>
      </footer>
    </div>
  );
}
