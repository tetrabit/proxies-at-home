import { Trash2, Pencil } from 'lucide-react';
import { CardImageSvg } from '../common/CardImageSvg';

export interface CardbackTileProps {
    id: string;
    name: string;
    imageUrl: string;
    source: 'builtin' | 'uploaded';
    isSelected: boolean;
    isDefault: boolean;
    isDeleting: boolean;
    isEditing: boolean;
    editingName: string;
    hasBuiltInBleed?: boolean;
    onSelect: () => void;
    onSetAsDefault: () => void;
    onDelete: () => void;
    onStartEdit: () => void;
    onEditNameChange: (name: string) => void;
    onSaveEdit: () => void;
    onCancelEdit: () => void;
}

/**
 * Reusable cardback tile component with default/delete/edit functionality.
 */
export function CardbackTile({
    id,
    name,
    imageUrl,
    source,
    isSelected,
    isDefault,
    isDeleting,
    isEditing,
    editingName,
    onSelect,
    onSetAsDefault,
    onDelete,
    onStartEdit,
    onEditNameChange,
    onSaveEdit,
    onCancelEdit,
}: CardbackTileProps) {
    const isBlank = id === 'cardback_builtin_blank';
    const isUploaded = source === 'uploaded';

    const borderClasses = isSelected
        ? 'border-green-500'
        : 'border-transparent hover:border-blue-400';

    return (
        <div className="flex flex-col gap-2">
            <div
                className="relative cursor-pointer group w-full aspect-63/88 rounded-[4%] overflow-hidden"
                onClick={onSelect}
            >
                {isBlank ? (
                    <div className={`w-full h-full border-4 rounded-[4%] flex items-center justify-center ${borderClasses} bg-linear-to-br from-white/60 to-white/30 dark:from-gray-700/60 dark:to-gray-800/30 backdrop-blur-sm shadow-inner`}>
                        <span className="text-gray-400 dark:text-gray-500 text-xs font-medium italic">No Back</span>
                    </div>
                ) : (
                    <div className="relative w-full h-full">
                        <CardImageSvg
                            url={imageUrl}
                            id={id}
                            // Don't crop bleed - scale image to fit card area to preserve borders
                            bleed={undefined}
                            rounded={false} // Parent handles rounding via overflow-hidden
                        />
                        {/* Border overlay */}
                        <div className={`absolute inset-0 rounded-[4%] border-4 pointer-events-none transition-colors ${borderClasses}`} />
                    </div>
                )}

                {/* Delete button for uploaded cardbacks */}
                {isUploaded && (
                    <button
                        type="button"
                        className="absolute top-1 left-1 p-1 rounded-full bg-black/50 hover:bg-red-600 transition-colors z-10"
                        onClick={(e) => {
                            e.stopPropagation();
                            onDelete();
                        }}
                        title={isDeleting ? "Click again to confirm delete" : "Delete cardback"}
                    >
                        <Trash2
                            size={16}
                            className={isDeleting
                                ? "text-red-400"
                                : "text-white/60 group-hover:text-white"
                            }
                        />
                    </button>
                )}

                {/* Name bar with edit capability */}
                <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-xs text-center py-1 px-1 flex items-center justify-center gap-1 z-10">
                    {isEditing ? (
                        <input
                            type="text"
                            value={editingName}
                            onChange={(e) => onEditNameChange(e.target.value)}
                            onBlur={onSaveEdit}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.currentTarget.blur();
                                } else if (e.key === 'Escape') {
                                    onCancelEdit();
                                }
                            }}
                            onClick={(e) => e.stopPropagation()}
                            autoFocus
                            className="bg-transparent text-white text-xs text-center w-full border-none outline-none"
                        />
                    ) : (
                        <>
                            <span className="truncate">{name}</span>
                            {isUploaded && (
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onStartEdit();
                                    }}
                                    className="shrink-0 hover:text-blue-300"
                                    title="Edit name"
                                >
                                    <Pencil size={10} />
                                </button>
                            )}
                        </>
                    )}
                </div>
            </div>

            {isDefault ? (
                <div className="w-full rounded-md border border-yellow-300 bg-yellow-50 px-2 py-1 text-center text-xs font-medium text-yellow-700 dark:border-yellow-500/40 dark:bg-yellow-500/10 dark:text-yellow-300">
                    Default cardback
                </div>
            ) : (
                <button
                    type="button"
                    className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
                    onClick={(e) => {
                        e.stopPropagation();
                        onSetAsDefault();
                    }}
                    title="Set as default cardback"
                >
                    Set as default
                </button>
            )}
        </div>
    );
}
