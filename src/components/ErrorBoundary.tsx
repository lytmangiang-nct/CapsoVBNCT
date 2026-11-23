import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error?.message || 'Đã xảy ra lỗi không mong muốn khi hiển thị giao diện.',
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  private handleReload = () => {
    this.setState({ hasError: false, message: '' });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white border border-rose-200 rounded-2xl p-6 shadow-sm text-center space-y-4">
            <div className="w-12 h-12 rounded-full bg-rose-50 border border-rose-200 flex items-center justify-center mx-auto">
              <AlertTriangle className="w-6 h-6 text-rose-600" />
            </div>
            <div className="space-y-1.5">
              <h1 className="text-base font-bold text-slate-900">
                Đã xảy ra lỗi hiển thị
              </h1>
              <p className="text-xs text-slate-600 leading-relaxed">
                Hệ thống gặp sự cố tạm thời trong phiên trình duyệt này. Dữ liệu văn bản trên máy chủ vẫn được bảo toàn an toàn.
              </p>
              {this.state.message && (
                <p className="text-[11px] font-mono text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-2.5 py-1.5 break-words">
                  {this.state.message}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={this.handleReload}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[42px] bg-sky-700 hover:bg-sky-800 text-white text-xs font-semibold rounded-lg shadow-xs transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              <span>Tải lại giao diện</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
