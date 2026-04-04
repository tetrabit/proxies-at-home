import { X, Check, Copy, AlertTriangle } from "lucide-react";
import { useToastStore } from "@/store/toast";

export function ToastContainer() {
    const toasts = useToastStore((state) => state.toasts);
    const removeToast = useToastStore((state) => state.removeToast);

    if (toasts.length === 0) return null;

    return (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 z-200000 pointer-events-auto">
            {toasts.map((toast) => {
                const isSuccess = toast.type === "success";
                const isCopy = toast.type === "copy";
                const isError = toast.type === "error";
                const isGreen = isSuccess || isCopy;
                const hasProgress = toast.progress !== undefined && toast.progress >= 0;

                // Determine background color
                let bgClass = "bg-blue-600";
                if (isGreen) bgClass = "bg-green-600";
                if (isError) bgClass = "bg-red-600";

                // Determine animation
                const animClass = isGreen ? "animate-fade-in-out" : "animate-fade-in";

                return (
                    <div
                        key={toast.id}
                        className={`${bgClass} ${animClass} text-white px-4 py-2 rounded-lg shadow-xl shadow-black/30 ring-1 ring-black/10 text-sm flex flex-col gap-1.5 max-w-md min-w-64`}
                    >
                        <div className="flex items-start gap-3">
                            {isSuccess ? (
                                <Check className="h-4 w-4 shrink-0 mt-0.5" />
                            ) : isCopy ? (
                                <Copy className="h-4 w-4 shrink-0 mt-0.5" />
                            ) : isError ? (
                                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                            ) : (
                                <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full shrink-0 mt-0.5" />
                            )}
                            <span className={`flex-1 ${isError ? 'max-h-40 overflow-y-auto wrap-break-word' : ''}`}>
                                {toast.message}
                            </span>
                            {toast.dismissible && (
                                <button
                                    onClick={() => removeToast(toast.id)}
                                    className={`ml-1 p-0.5 ${isError ? 'hover:bg-red-500' : 'hover:bg-blue-500'} rounded transition-colors shrink-0`}
                                    aria-label="Dismiss"
                                >
                                    <X className="h-4 w-4" />
                                </button>
                            )}
                        </div>
                        {hasProgress && (
                            <div className="w-full bg-white/20 rounded-full h-1.5 overflow-hidden">
                                <div
                                    className="bg-white h-full rounded-full transition-all duration-300 ease-out"
                                    style={{ width: `${Math.min(100, Math.max(0, toast.progress! * 100))}%` }}
                                />
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

